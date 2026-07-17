import { chmod, link, lstat, unlink } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import {
  AGENT_API_VERSION,
  AGENT_SOCKET_PATH,
  agentApiV1EndpointByOperation,
  extractDevSpaceProtocolHeaders,
  type SourceInspectionData
} from "@devspace/contracts";
import { v7 as uuidv7 } from "uuid";
import { GitInspectionPolicyError, GitInspectionUnavailableError, createProductionGitInspector, type GitInspector } from "./git-inspector.js";

const MAX_BODY_BYTES = 16 * 1024;
const SOCKET_PROBE_TIMEOUT_MS = 300;
const healthEndpoint = agentApiV1EndpointByOperation["agent.health.get"];
const inspectEndpoint = agentApiV1EndpointByOperation["project.source.inspect"];

export interface AgentServerOptions {
  readonly socketPath?: string;
  /** Internal test seam for exercising private bind-path ownership. */
  readonly privateSocketPath?: string;
  /** Internal test seam for forcing publication-stage failures. */
  readonly publishSocket?: (privatePath: string, publicPath: string) => Promise<void>;
  readonly gitInspector?: GitInspector;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export interface AgentServer {
  readonly socketPath: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function meta(requestId: string, now: () => Date) {
  return { protocolVersion: AGENT_API_VERSION, requestId, respondedAt: now().toISOString() };
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

function requestError(response: ServerResponse, requestId: string, now: () => Date, input: {
  location: "headers" | "path" | "query" | "body";
  field: string | null;
  reason: "missing" | "malformed" | "unknown" | "inconsistent";
}): void {
  sendJson(response, 400, {
    meta: meta(requestId, now),
    error: { code: "REQUEST_INVALID", message: "The Agent request is invalid.", retryable: false, details: input }
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("body-too-large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export interface SocketIdentity { readonly dev: bigint; readonly ino: bigint }

function socketIdentity(stats: Awaited<ReturnType<typeof lstat>>): SocketIdentity {
  return { dev: BigInt(stats.dev), ino: BigInt(stats.ino) };
}

function sameSocket(left: SocketIdentity, right: SocketIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Internal ownership-checked cleanup used by the bind/publication lifecycle and its tests. */
export async function unlinkOwnedSocket(socketPath: string, ownership: SocketIdentity): Promise<void> {
  try {
    const current = await lstat(socketPath);
    if (current.isSocket() && sameSocket(ownership, socketIdentity(current))) await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function probeSocket(socketPath: string, now: () => Date, createId: () => string): Promise<"active" | "stale" | "absent" | "uncertain"> {
  return await new Promise((resolve) => {
    let connected = false;
    let settled = false;
    const finish = (result: "active" | "stale" | "absent" | "uncertain") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      call.destroy();
      resolve(result);
    };
    const call = http.request({
      socketPath,
      method: "GET",
      path: healthEndpoint.path,
      headers: {
        "X-DevSpace-Protocol-Version": String(AGENT_API_VERSION),
        "X-DevSpace-Request-Id": createId(),
        "X-DevSpace-Sent-At": now().toISOString()
      }
    }, (response) => {
      response.resume();
      finish("active");
    });
    call.once("socket", (socket) => socket.once("connect", () => { connected = true; }));
    call.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") finish("absent");
      else if (!connected && error.code === "ECONNREFUSED") finish("stale");
      else finish("uncertain");
    });
    const timer = setTimeout(() => finish("uncertain"), SOCKET_PROBE_TIMEOUT_MS);
    timer.unref();
    call.end();
  });
}

async function prepareSocketPath(socketPath: string, now: () => Date, createId: () => string): Promise<void> {
  let existing;
  try {
    existing = await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!existing.isSocket()) throw new Error(`Refusing to replace non-socket Agent path: ${socketPath}`);
  const identity = socketIdentity(existing);
  const probe = await probeSocket(socketPath, now, createId);
  if (probe === "active") throw new Error(`An active listener already owns the Agent socket: ${socketPath}`);
  if (probe === "uncertain") throw new Error(`Unable to prove that the existing Agent socket is stale: ${socketPath}`);
  if (probe === "absent") return;
  let current;
  try { current = await lstat(socketPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!current.isSocket() || !sameSocket(identity, socketIdentity(current))) {
    throw new Error(`The Agent socket changed while stale ownership was being checked: ${socketPath}`);
  }
  await unlink(socketPath);
}

export function createAgentServer(options: AgentServerOptions = {}): AgentServer {
  const socketPath = options.socketPath ?? AGENT_SOCKET_PATH;
  const publishSocket = options.publishSocket ?? (async (privatePath, publicPath) => { await link(privatePath, publicPath); });
  const inspector = options.gitInspector ?? createProductionGitInspector();
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? uuidv7;
  let started = false;
  let ownedSocket: SocketIdentity | undefined;

  // Node's request listener is intentionally promise-backed; all handler paths produce a response.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const server = http.createServer(async (request, response) => {
    const fallbackRequestId = createId();
    const projection = extractDevSpaceProtocolHeaders(request.rawHeaders.reduce<[string, string][]>((all, value, index, raw) => {
      if (index % 2 === 0) all.push([value, raw[index + 1] ?? ""]);
      return all;
    }, []));
    if (!projection.ok) return requestError(response, fallbackRequestId, now, {
      location: "headers", field: projection.error.header,
      reason: projection.error.code === "UNKNOWN_DEVSPACE_HEADER" ? "unknown" : "inconsistent"
    });
    const parsedHeaders = healthEndpoint.headersSchema.safeParse(projection.headers);
    const requestId = typeof projection.headers["X-DevSpace-Request-Id"] === "string"
      ? projection.headers["X-DevSpace-Request-Id"]
      : fallbackRequestId;
    if (!parsedHeaders.success) {
      const protocol = projection.headers["X-DevSpace-Protocol-Version"];
      if (protocol !== "1") {
        const received = protocol !== undefined && /^\d+$/u.test(protocol) ? Number(protocol) : null;
        return sendJson(response, received !== null && received !== 1 ? 426 : 400, {
          meta: meta(requestId, now),
          error: {
            code: "PROTOCOL_VERSION_UNSUPPORTED",
            message: "The Agent protocol version is unsupported.",
            retryable: false,
            details: { supportedProtocolVersion: 1, receivedProtocolVersion: Number.isSafeInteger(received) ? received : null }
          }
        });
      }
      return requestError(response, requestId, now, { location: "headers", field: null, reason: "malformed" });
    }

    const url = new URL(request.url ?? "/", "http://agent.local");
    if (url.search !== "") return requestError(response, requestId, now, {
      location: "query", field: null, reason: "unknown"
    });

    if (request.method === "GET" && url.pathname === healthEndpoint.path) {
      if ((request.headers["content-length"] ?? "0") !== "0" || request.headers["transfer-encoding"] !== undefined) {
        return requestError(response, requestId, now, { location: "body", field: null, reason: "inconsistent" });
      }
      return sendJson(response, 200, healthEndpoint.successBodySchema.parse({
        meta: meta(requestId, now), data: { status: "ok" }
      }));
    }

    if (request.method === "POST" && url.pathname === inspectEndpoint.path) {
      let body: ReturnType<typeof inspectEndpoint.requestBodySchema.parse>;
      try {
        body = inspectEndpoint.requestBodySchema.parse(await readJsonBody(request));
      } catch {
        return requestError(response, requestId, now, { location: "body", field: null, reason: "malformed" });
      }
      if (body.data.source.kind !== "remote") {
        return sendJson(response, 422, inspectEndpoint.errorSchema.parse({
          meta: meta(requestId, now),
          error: { code: "RUNTIME_POLICY_VIOLATION", message: "The source type is not approved for this route.",
            retryable: false, details: { policy: "source-not-approved" } }
        }));
      }
      const sourceUrl = new URL(body.data.source.url);
      if (sourceUrl.protocol !== "https:" || sourceUrl.search !== "") {
        return sendJson(response, 422, inspectEndpoint.errorSchema.parse({
          meta: meta(requestId, now),
          error: { code: "RUNTIME_POLICY_VIOLATION", message: "Only HTTPS repository URLs without query parameters are supported.",
            retryable: false, details: { policy: "source-not-approved" } }
        }));
      }
      try {
        const data: SourceInspectionData = await inspector.inspect(body.data.source.url);
        return sendJson(response, 200, inspectEndpoint.successBodySchema.parse({ meta: meta(requestId, now), data }));
      } catch (error) {
        if (error instanceof GitInspectionPolicyError) {
          return sendJson(response, 422, inspectEndpoint.errorSchema.parse({
            meta: meta(requestId, now),
            error: { code: "RUNTIME_POLICY_VIOLATION", message: error.message, retryable: false,
              details: { policy: "source-not-approved" } }
          }));
        }
        if (error instanceof GitInspectionUnavailableError) {
          return sendJson(response, 503, inspectEndpoint.errorSchema.parse({
            meta: meta(requestId, now),
            error: { code: "SOURCE_UNAVAILABLE", message: error.message, retryable: true, details: {} }
          }));
        }
        return sendJson(response, 500, inspectEndpoint.errorSchema.parse({
          meta: meta(requestId, now),
          error: { code: "AGENT_INTERNAL_ERROR", message: "The Agent encountered an unexpected error.",
            retryable: true, details: { incidentId: createId() } }
        }));
      }
    }

    if (url.pathname.startsWith("/v1/")) {
      sendJson(response, 404, {
        meta: meta(requestId, now),
        error: { code: "REQUEST_INVALID", message: "The Agent route does not exist.", retryable: false,
          details: { location: "path", field: null, reason: "unknown" } }
      });
      return;
    }
    sendJson(response, 426, {
      meta: meta(requestId, now),
      error: { code: "PROTOCOL_VERSION_UNSUPPORTED", message: "The Agent protocol version is unsupported.",
        retryable: false, details: { supportedProtocolVersion: 1, receivedProtocolVersion: null } }
    });
  });

  return {
    socketPath,
    async start() {
      if (started) return;
      await prepareSocketPath(socketPath, now, createId);
      const bindingPath = options.privateSocketPath ?? path.join(path.dirname(socketPath), `.devspace-agent-${createId()}.sock`);
      let bindingIdentity: SocketIdentity | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(bindingPath, () => { server.off("error", reject); resolve(); });
        });
        await chmod(bindingPath, 0o660);
        bindingIdentity = socketIdentity(await lstat(bindingPath));
        // A hard link publishes the socket atomically without letting Node own cleanup of the
        // public pathname. This makes shutdown cleanup exclusively identity-checked below.
        await publishSocket(bindingPath, socketPath);
        const created = await lstat(socketPath);
        if (!created.isSocket() || !sameSocket(bindingIdentity, socketIdentity(created))) {
          throw new Error(`The Agent socket changed while it was being published: ${socketPath}`);
        }
        ownedSocket = socketIdentity(created);
        await unlinkOwnedSocket(bindingPath, bindingIdentity);
        started = true;
      } catch (error) {
        if (bindingIdentity !== undefined) {
          // Remove the bound pathname before Node closes its UDS handle. This ensures the
          // runtime's own close cleanup sees an absent pathname, while our deletion remains
          // authorized by the exact identity captured after bind.
          await unlinkOwnedSocket(bindingPath, bindingIdentity);
          await new Promise<void>((resolve, reject) => server.close((closeError) => closeError === undefined ? resolve() : reject(closeError)));
        }
        throw error;
      }
    },
    async stop() {
      if (!started) return;
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      try {
        const current = await lstat(socketPath);
        if (ownedSocket !== undefined && current.isSocket() && sameSocket(ownedSocket, socketIdentity(current))) await unlink(socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      started = false;
      ownedSocket = undefined;
    }
  };
}
