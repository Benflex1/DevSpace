import { sourceInspectionDataSchema } from "@devspace/contracts";
import { createAgentServer } from "../src/server.js";

const socketPath = process.env.DEVSPACE_AGENT_SOCKET_PATH;
if (socketPath === undefined) throw new Error("DEVSPACE_AGENT_SOCKET_PATH is required for the E2E Agent.");
const server = createAgentServer({
  socketPath,
  gitInspector: {
    inspect: () => Promise.resolve(sourceInspectionDataSchema.parse({
      sourceKind: "remote",
      isGitRepository: true,
      defaultBranch: "main",
      headCommit: "0123456789abcdef0123456789abcdef01234567"
    }))
  }
});
await server.start();
const shutdown = async () => { await server.stop(); process.exitCode = 0; };
process.once("SIGINT", () => { shutdown().catch(() => { process.exitCode = 1; }); });
process.once("SIGTERM", () => { shutdown().catch(() => { process.exitCode = 1; }); });
