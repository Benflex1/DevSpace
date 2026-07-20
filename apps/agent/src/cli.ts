import { createAgentServer } from "./server.js";
import { readPreviewBaseRegistry } from "./preview-runtime.js";
import { readPreviewGatewayConfiguration } from "./preview-gateway-config.js";

const configuredSocketPath = process.env.DEVSPACE_AGENT_SOCKET_PATH;
const localRoot = process.env.DEVSPACE_MANAGED_ROOT;
const previewGatewayConfiguration = readPreviewGatewayConfiguration(process.env);
const server = createAgentServer({
  ...(configuredSocketPath === undefined ? {} : { socketPath: configuredSocketPath }),
  ...(localRoot === undefined ? {} : {
    managedRoots: {
      projects: `${localRoot}/projects`, workspaces: `${localRoot}/workspaces`, state: `${localRoot}/state`
    },
    operationJournalPath: `${localRoot}/state/operations`
  }),
  previewBaseRegistry: readPreviewBaseRegistry(),
  ...(previewGatewayConfiguration.previewLeaseResolverSocket === undefined ? {} : {
    previewLeaseResolverSocketPath: previewGatewayConfiguration.previewLeaseResolverSocket
  }),
  ...(previewGatewayConfiguration.previewGatewayFactory === undefined ? {} : {
    previewGatewayFactory: previewGatewayConfiguration.previewGatewayFactory
  })
});
await server.start();
console.log(`DevSpace Agent listening on ${server.socketPath}`);

const shutdown = async () => {
  await server.stop();
  process.exitCode = 0;
};
process.once("SIGINT", () => { shutdown().catch(() => { process.exitCode = 1; }); });
process.once("SIGTERM", () => { shutdown().catch(() => { process.exitCode = 1; }); });
