import { createAgentServer } from "../src/server.js";

const socketPath = process.env.DEVSPACE_AGENT_SOCKET_PATH;
if (socketPath === undefined) throw new Error("DEVSPACE_AGENT_SOCKET_PATH is required for the E2E Agent.");
const managedRoot = process.env.DEVSPACE_MANAGED_ROOT;
if (managedRoot === undefined) throw new Error("DEVSPACE_MANAGED_ROOT is required for the E2E Agent.");
const server = createAgentServer({
  socketPath,
  managedRoots: { projects: `${managedRoot}/projects`, workspaces: `${managedRoot}/workspaces`, state: `${managedRoot}/state` },
  operationJournalPath: `${managedRoot}/state/operations`
});
await server.start();
const shutdown = async () => { await server.stop(); process.exitCode = 0; };
process.once("SIGINT", () => { shutdown().catch(() => { process.exitCode = 1; }); });
process.once("SIGTERM", () => { shutdown().catch(() => { process.exitCode = 1; }); });
