import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { v7 as uuidv7 } from "uuid";
import WebSocket, { WebSocketServer } from "ws";
import { AGENT_API_VERSION, TERMINAL_MAX_MESSAGE_BYTES, TERMINAL_SUBPROTOCOL, encodeTerminalAgentFrame } from "@devspace/contracts";
import type { AuthConfig } from "./config.js";
import { authenticateHeaders } from "./auth.js";

const MAX_RELAY_BUFFER_BYTES = 256 * 1024;
const HEARTBEAT_INTERVAL_MS = 15_000;
const terminalPathPattern = new RegExp(
  "^/api/projects/([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"
  + "/workspaces/([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"
  + "/terminals/([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/stream$",
  "u"
);

export interface TerminalRelayOptions {
  readonly appOrigin: string;
  readonly agentSocketPath: string;
  readonly auth: AuthConfig;
  readonly authorizeTerminal: (projectId: string, workspaceId: string, terminalId: string) => boolean;
  readonly onUnmatchedUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

function reject(socket: Duplex, status: 400 | 403 | 404 | 409): void {
  const reason = status === 403 ? "Forbidden" : status === 404 ? "Not Found" : status === 409 ? "Conflict" : "Bad Request";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
  }
  return headers;
}

export function installTerminalWebSocketRelay(server: Server, options: TerminalRelayOptions): () => void {
  const terminalServer = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: TERMINAL_MAX_MESSAGE_BYTES,
    perMessageDeflate: false, handleProtocols: (protocols) => protocols.size === 1 && protocols.has(TERMINAL_SUBPROTOCOL)
      ? TERMINAL_SUBPROTOCOL : false });

  const heartbeat = (socket: WebSocket, peer: WebSocket): void => {
    let alive = true;
    const interval = setInterval(() => {
      if (!alive) {
        socket.terminate();
        if (peer.readyState < WebSocket.CLOSING) peer.terminate();
        return;
      }
      alive = false;
      try { socket.ping(); }
      catch {
        socket.terminate();
        if (peer.readyState < WebSocket.CLOSING) peer.terminate();
      }
    }, HEARTBEAT_INTERVAL_MS);
    interval.unref();
    socket.on("pong", () => { alive = true; });
    socket.once("close", () => clearInterval(interval));
    socket.once("error", () => clearInterval(interval));
  };

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let match: RegExpExecArray | null;
    try { match = terminalPathPattern.exec(new URL(request.url ?? "/", options.appOrigin).pathname); }
    catch { reject(socket, 400); return; }
    if (match === null) {
      options.onUnmatchedUpgrade(request, socket, head);
      return;
    }
    void (async () => {
      if (request.method !== "GET" || request.headers.origin !== options.appOrigin
        || request.headers["sec-websocket-protocol"] !== TERMINAL_SUBPROTOCOL) {
        reject(socket, 400); return;
      }
      try { await authenticateHeaders(requestHeaders(request), options.auth); }
      catch { reject(socket, 403); return; }
      const [, projectId, workspaceId, terminalId] = match;
      if (!options.authorizeTerminal(projectId!, workspaceId!, terminalId!)) {
        reject(socket, 404); return;
      }
      const agent = new WebSocket(`ws+unix://${options.agentSocketPath}:/v1/terminals/${terminalId}/stream`, TERMINAL_SUBPROTOCOL, {
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
      agent.once("unexpected-response", (_request, response) => {
        if (response.statusCode !== 409 || settled) {
          fail(response.statusCode === 404 ? 404 : response.statusCode === 409 ? 409 : 403);
          return;
        }
        settled = true;
        response.resume();
        try {
          terminalServer.handleUpgrade(request, socket, head, (websocket) => {
            browser = websocket;
            websocket.send(encodeTerminalAgentFrame({ type: "attachment-conflict" }), { binary: true });
            websocket.close(1008, "Terminal already has an active attachment.");
          });
        } catch { socket.destroy(); }
      });
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
            heartbeat(websocket, agent);
            heartbeat(agent, websocket);
          });
        } catch { agent.terminate(); socket.destroy(); }
      });
    })().catch(() => reject(socket, 400));
  };

  server.on("upgrade", handleUpgrade);
  return () => {
    server.off("upgrade", handleUpgrade);
    terminalServer.close();
  };
}
