import { createAgentServer } from "./server.js";

const configuredSocketPath = process.env.DEVSPACE_AGENT_SOCKET_PATH;
const server = createAgentServer(configuredSocketPath === undefined ? {} : { socketPath: configuredSocketPath });
await server.start();
console.log(`DevSpace Agent listening on ${server.socketPath}`);

const shutdown = async () => {
  await server.stop();
  process.exitCode = 0;
};
process.once("SIGINT", () => { shutdown().catch(() => { process.exitCode = 1; }); });
process.once("SIGTERM", () => { shutdown().catch(() => { process.exitCode = 1; }); });
