import { chmod, lstat, unlink } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import {
  previewLeaseResolverRequestSchema,
  previewLeaseResolverResponseSchema,
  acquirePrivateSocketLifecycleLock,
  type PrivateSocketLifecycleLock,
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
  /** Internal test seam for forcing a failure after the listener has bound. */
  readonly afterBind?: () => Promise<void>;
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

function sendInvalidRequest(response: ServerResponse): void {
  sendJson(response, 400, { error: "invalid_request" });
}

function sendUnavailable(response: ServerResponse): void {
  sendJson(response, 404, { error: "preview_lease_unavailable" });
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
        if (!response.headersSent) sendInvalidRequest(response);
      });
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== RESOLVER_PATH) {
      sendUnavailable(response);
      return;
    }
    let parsedRequest;
    try {
      parsedRequest = previewLeaseResolverRequestSchema.parse(await readBoundedBody(request));
    } catch {
      sendInvalidRequest(response);
      return;
    }
    let resolved: PreviewGatewayLease | null;
    try { resolved = await this.options.resolveLease(parsedRequest.leaseId); }
    catch { sendUnavailable(response); return; }
    if (resolved === null) {
      sendUnavailable(response);
      return;
    }
    const lease = previewLeaseResolverResponseSchema.safeParse(resolved);
    if (!lease.success || lease.data.leaseId !== parsedRequest.leaseId) {
      sendUnavailable(response);
      return;
    }
    const encoded = JSON.stringify({ leaseId: lease.data.leaseId, hostIp: lease.data.hostIp, hostPort: lease.data.hostPort });
    if (Buffer.byteLength(encoded) > MAX_RESPONSE_BODY_BYTES) {
      sendUnavailable(response);
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
    const lifecycle = await acquirePrivateSocketLifecycleLock(this.options.socketPath, "preview lease resolver");
    try {
      await prepareSocketPath(this.options.socketPath);
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.options.socketPath, resolve);
      });
      this.ownedSocket = socketIdentity(await lstat(this.options.socketPath));
      await this.options.afterBind?.();
      await chmod(this.options.socketPath, 0o660);
      const current = await lstat(this.options.socketPath);
      if (!current.isSocket() || !sameSocket(this.ownedSocket, socketIdentity(current))) {
        throw new Error("The preview lease resolver socket changed during startup.");
      }
      this.lifecycle = lifecycle;
      this.started = true;
    } catch (error) {
      await closeServer(this.server).catch(() => undefined);
      if (this.ownedSocket !== undefined) {
        await unlinkOwnedSocket(this.options.socketPath, this.ownedSocket).catch(() => undefined);
      }
      await lifecycle.release().catch(() => undefined);
      this.ownedSocket = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await closeServer(this.server);
    if (this.ownedSocket !== undefined) await unlinkOwnedSocket(this.options.socketPath, this.ownedSocket);
    if (this.lifecycle !== undefined) await this.lifecycle.release();
    this.started = false;
    this.ownedSocket = undefined;
    this.lifecycle = undefined;
  }

  private lifecycle: PrivateSocketLifecycleLock | undefined;
}

async function unlinkOwnedSocket(socketPath: string, ownership: SocketIdentity): Promise<void> {
  try {
    const current = await lstat(socketPath);
    if (current.isSocket() && sameSocket(ownership, socketIdentity(current))) await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export { RESOLVER_PATH as PREVIEW_LEASE_RESOLVER_PATH };
