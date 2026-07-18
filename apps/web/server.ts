import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";
import { v7 as uuidv7 } from "uuid";
import WebSocket, { WebSocketServer } from "ws";
import { AGENT_API_VERSION, TERMINAL_MAX_MESSAGE_BYTES, TERMINAL_SUBPROTOCOL } from "@devspace/contracts";
import { authenticateHeaders } from "./src/server/auth.js";
import { readWebRuntimeConfig } from "./src/server/config.js";
import { getProjectDatabase } from "./src/server/database.js";

const MAX_RELAY_BUFFER_BYTES = 256 * 1024;
const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.DEVSPACE_WEB_HOST?.trim() || "0.0.0.0";
const port = Number(process.env.PORT ?? "3000");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port.");
const config = readWebRuntimeConfig();
const applicationDirectory = path.dirname(fileURLToPath(import.meta.url));
const app = next({ dev, hostname, port, dir: applicationDirectory, webpack: true });
await app.prepare();
const handle = app.getRequestHandler();
const handleNextUpgrade = app.getUpgradeHandler();
const terminalServer = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: TERMINAL_MAX_MESSAGE_BYTES,
  perMessageDeflate: false, handleProtocols: (protocols) => protocols.size === 1 && protocols.has(TERMINAL_SUBPROTOCOL)
    ? TERMINAL_SUBPROTOCOL : false });

const server = createServer((request, response) => {
  handle(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500).end();
    else response.destroy();
  });
});

function reject(socket: Duplex, status: 400 | 403 | 404 | 409): void {
  const reason = status === 403 ? "Forbidden" : status === 404 ? "Not Found" : status === 409 ? "Conflict" : "Bad Request";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function requestHeaders(request: import("node:http").IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
  }
  return headers;
}

server.on("upgrade", (request, socket, head) => {
  const uuid = "([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
  const match = new RegExp(`^/api/projects/${uuid}/workspaces/${uuid}/terminals/${uuid}/stream$`, "u")
    .exec(new URL(request.url ?? "/", config.appOrigin).pathname);
  if (match === null) {
    handleNextUpgrade(request, socket, head).catch(() => socket.destroy());
    return;
  }
  void (async () => {
    if (request.method !== "GET" || request.headers.origin !== config.appOrigin
      || request.headers["sec-websocket-protocol"] !== TERMINAL_SUBPROTOCOL) {
      reject(socket, 400); return;
    }
    try { await authenticateHeaders(requestHeaders(request), config.auth); }
    catch { reject(socket, 403); return; }
    const [, projectId, workspaceId, terminalId] = match;
    if (!getProjectDatabase(config.databasePath).authorizeTerminal(projectId!, workspaceId!, terminalId!)) {
      reject(socket, 404); return;
    }
    const agent = new WebSocket(`ws+unix://${config.agentSocketPath}:/v1/terminals/${terminalId}/stream`, TERMINAL_SUBPROTOCOL, {
      perMessageDeflate: false, maxPayload: TERMINAL_MAX_MESSAGE_BYTES,
      headers: {
        "X-DevSpace-Protocol-Version": String(AGENT_API_VERSION),
        "X-DevSpace-Request-Id": uuidv7(),
        "X-DevSpace-Sent-At": new Date().toISOString()
      }
    });
    let browser: WebSocket | null = null;
    let settled = false;
    const fail = (status: 400 | 403 | 404 | 409) => {
      if (settled) return; settled = true; agent.terminate(); reject(socket, status);
    };
    agent.once("unexpected-response", (_request, response) => fail(response.statusCode === 409 ? 409 : response.statusCode === 404 ? 404 : 403));
    agent.once("error", () => { if (browser === null) fail(409); else browser.close(1011, "Terminal relay unavailable."); });
    agent.once("open", () => {
      if (settled) return;
      try {
        terminalServer.handleUpgrade(request, socket, head, (websocket) => {
          settled = true; browser = websocket;
          websocket.on("message", (data, isBinary) => {
            if (!isBinary || agent.readyState !== WebSocket.OPEN || agent.bufferedAmount > MAX_RELAY_BUFFER_BYTES) {
              websocket.close(1009, "Terminal relay limit reached."); return;
            }
            agent.send(data, { binary: true });
          });
          agent.on("message", (data, isBinary) => {
            if (!isBinary || websocket.readyState !== WebSocket.OPEN || websocket.bufferedAmount > MAX_RELAY_BUFFER_BYTES) {
              websocket.close(1009, "Terminal relay limit reached."); agent.close(); return;
            }
            websocket.send(data, { binary: true });
          });
          websocket.once("close", () => agent.close());
          websocket.once("error", () => agent.close());
          agent.once("close", (code) => { if (websocket.readyState < WebSocket.CLOSING) websocket.close(code === 1000 ? 1000 : 1011); });
        });
      } catch { agent.terminate(); socket.destroy(); }
    });
  })().catch(() => reject(socket, 400));
});

server.listen(port, hostname, () => console.log(`DevSpace Web listening on http://${hostname}:${port}`));

const shutdown = () => {
  const forcedExit = setTimeout(() => process.exit(0), 1_000);
  forcedExit.unref();
  server.close(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
