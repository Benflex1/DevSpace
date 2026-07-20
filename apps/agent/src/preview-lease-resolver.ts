import { chmod, lstat, unlink } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import {
  previewLeaseResolverRequestSchema,
  previewLeaseResolverResponseSchema,
  type OpaqueLeaseResolver,
  type PreviewGatewayLease
} from "@devspace/gateway-caddy";

const RESOLVER_PATH = "/v1/preview/lease/resolve";
const MAX_REQUEST_BODY_BYTES = 4_096;
const MAX_RESPONSE_BODY_BYTES = 1_024;
const STALE_SOCKET_PROBE_TIMEOUT_MS = 300;

export interface PreviewLeaseResolverServerOptions {
  readonly socketPath: string;
  readonly resolveLease: OpaqueLeaseResolver;
}

type SocketIdentity = { readonly dev: bigint; readonly ino: bigint };
type SocketProbeResult = "active" | "stale" | "absent" | "uncertain";

function socketIdentity(stats: Awaited<ReturnType<typeof lstat>>): SocketIdentity {
  return { dev: BigInt(stats.dev), ino: BigInt(stats.ino) };
}

function sameSocket(left: SocketIdentity, right: SocketIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store"
  });
  response.end(encoded);
}

function sendError(response: ServerResponse, status: number): void {
  sendJson(response, status, { error: status === 404 ? "preview_lease_unavailable" : "invalid_request" });
}

async function readBoundedBody(request: IncomingMessage): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_REQUEST_BODY_BYTES)) {
    throw new Error("preview-lease-request-too-large");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) throw new Error("preview-lease-request-too-large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function probeSocket(socketPath: string): Promise<SocketProbeResult> {
  return await new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection(socketPath);
    const finish = (result: SocketProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish("active"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") finish("absent");
      else if (error.code === "ECONNREFUSED") finish("stale");
      else finish("uncertain");
    });
    socket.setTimeout(STALE_SOCKET_PROBE_TIMEOUT_MS, () => finish("uncertain"));
  });
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  let existing;
  try { existing = await lstat(socketPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!existing.isSocket()) throw new Error("Refusing to replace a non-socket preview lease resolver path.");
  const identity = socketIdentity(existing);
  const state = await probeSocket(socketPath);
  if (state === "active") throw new Error("An active preview lease resolver already owns the socket path.");
  if (state === "uncertain") throw new Error("Unable to prove that the existing preview lease resolver socket is stale.");
  if (state === "absent") return;
  let current;
  try { current = await lstat(socketPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!current.isSocket() || !sameSocket(identity, socketIdentity(current))) {
    throw new Error("The preview lease resolver socket changed during stale ownership checking.");
  }
  await unlink(socketPath);
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

export class PreviewLeaseResolverServer {
  private readonly server: http.Server;
  private started = false;
  private ownedSocket: SocketIdentity | undefined;

  constructor(private readonly options: PreviewLeaseResolverServerOptions) {
    if (options.socketPath.trim() === "") throw new Error("A private preview lease resolver Unix socket is required.");
    this.server = http.createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) sendError(response, 400);
      });
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== RESOLVER_PATH) {
      sendError(response, 404);
      return;
    }
    let parsedRequest;
    try {
      parsedRequest = previewLeaseResolverRequestSchema.parse(await readBoundedBody(request));
    } catch {
      sendError(response, 400);
      return;
    }
    let resolved: PreviewGatewayLease | null;
    try { resolved = await this.options.resolveLease(parsedRequest.leaseId); }
    catch {
      sendError(response, 503);
      return;
    }
    if (resolved === null) {
      sendError(response, 404);
      return;
    }
    const lease = previewLeaseResolverResponseSchema.safeParse(resolved);
    if (!lease.success || lease.data.leaseId !== parsedRequest.leaseId) {
      sendError(response, 503);
      return;
    }
    const encoded = JSON.stringify({ leaseId: lease.data.leaseId, hostIp: lease.data.hostIp, hostPort: lease.data.hostPort });
    if (Buffer.byteLength(encoded) > MAX_RESPONSE_BODY_BYTES) {
      sendError(response, 503);
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(encoded),
      "cache-control": "no-store"
    });
    response.end(encoded);
  }

  async start(): Promise<void> {
    if (this.started) return;
    await prepareSocketPath(this.options.socketPath);
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.options.socketPath, resolve);
      });
      await chmod(this.options.socketPath, 0o660);
      this.ownedSocket = socketIdentity(await lstat(this.options.socketPath));
      this.started = true;
    } catch (error) {
      await closeServer(this.server).catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await closeServer(this.server);
    try {
      const current = await lstat(this.options.socketPath);
      if (this.ownedSocket !== undefined && current.isSocket() && sameSocket(this.ownedSocket, socketIdentity(current))) {
        await unlink(this.options.socketPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.started = false;
    this.ownedSocket = undefined;
  }
}

export { RESOLVER_PATH as PREVIEW_LEASE_RESOLVER_PATH };
