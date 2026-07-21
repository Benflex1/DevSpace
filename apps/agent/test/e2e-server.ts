import { createAgentServer } from "../src/server.js";
import { GatewayHostProbe, PreviewGatewayAdapter, PrivateCaddyAdminTransport, PrivateGatewayProbeTransport, type GatewayPolicy } from "@devspace/gateway-caddy";
import { readPreviewBaseRegistry } from "../src/preview-runtime.js";

const socketPath = process.env.DEVSPACE_AGENT_SOCKET_PATH;
if (socketPath === undefined) throw new Error("DEVSPACE_AGENT_SOCKET_PATH is required for the E2E Agent.");
const managedRoot = process.env.DEVSPACE_MANAGED_ROOT;
if (managedRoot === undefined) throw new Error("DEVSPACE_MANAGED_ROOT is required for the E2E Agent.");
const caddyAdminSocket = process.env.DEVSPACE_CADDY_ADMIN_SOCKET;
const previewProbeSocket = process.env.DEVSPACE_PREVIEW_PROBE_SOCKET;
const rawBases = process.env.DEVSPACE_PREVIEW_BASES;
const gatewayPolicy: GatewayPolicy | null = rawBases === undefined ? null : { approvedPreviewBases: JSON.parse(rawBases) as GatewayPolicy["approvedPreviewBases"] };
const server = createAgentServer({
  socketPath,
  managedRoots: { projects: `${managedRoot}/projects`, workspaces: `${managedRoot}/workspaces`, state: `${managedRoot}/state` },
  operationJournalPath: `${managedRoot}/state/operations`,
  previewBaseRegistry: readPreviewBaseRegistry(),
  ...(caddyAdminSocket !== undefined && gatewayPolicy !== null ? {
    previewGatewayFactory: (resolveLease: (leaseId: string) => Promise<{ readonly leaseId: string; readonly hostIp: "127.0.0.1"; readonly hostPort: number } | null>) =>
      new PreviewGatewayAdapter({
        transport: new PrivateCaddyAdminTransport({ socketPath: caddyAdminSocket }),
        policy: gatewayPolicy,
        probe: previewProbeSocket === undefined ? new GatewayHostProbe(resolveLease)
          : new PrivateGatewayProbeTransport({ socketPath: previewProbeSocket })
      })
  } : {})
});
await server.start();
const shutdown = async () => { await server.stop(); process.exitCode = 0; };
process.once("SIGINT", () => { shutdown().catch(() => { process.exitCode = 1; }); });
process.once("SIGTERM", () => { shutdown().catch(() => { process.exitCode = 1; }); });
