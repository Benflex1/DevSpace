import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";
import { readWebRuntimeConfig } from "./src/server/config.js";
import { getProjectDatabase } from "./src/server/database.js";
import { installTerminalWebSocketRelay } from "./src/server/terminal-relay.js";
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

const server = createServer((request, response) => {
  handle(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500).end();
    else response.destroy();
  });
});

const removeTerminalUpgradeHandler = installTerminalWebSocketRelay(server, {
  appOrigin: config.appOrigin,
  agentSocketPath: config.agentSocketPath,
  auth: config.auth,
  authorizeTerminal: (projectId, workspaceId, terminalId) =>
    getProjectDatabase(config.databasePath).authorizeTerminal(projectId, workspaceId, terminalId),
  onUnmatchedUpgrade: (request, socket, head) => { handleNextUpgrade(request, socket, head).catch(() => socket.destroy()); }
});

server.listen(port, hostname, () => console.log(`DevSpace Web listening on http://${hostname}:${port}`));

const shutdown = () => {
  const forcedExit = setTimeout(() => process.exit(0), 1_000);
  forcedExit.unref();
  removeTerminalUpgradeHandler();
  server.close(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
