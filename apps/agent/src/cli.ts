import { createAgentServer } from "./server.js";
import { readPreviewBaseRegistry } from "./preview-runtime.js";
import { GatewayHostProbe, PreviewGatewayAdapter, PrivateCaddyAdminTransport, PrivateGatewayProbeTransport, type GatewayPolicy } from "@devspace/gateway-caddy";

function readGatewayPolicy(environment: NodeJS.ProcessEnv): GatewayPolicy | null {
  const raw = environment.DEVSPACE_PREVIEW_BASES?.trim();
  if (raw === undefined || raw === "") return null;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("DEVSPACE_PREVIEW_BASES must be a JSON array.");
  const approvedPreviewBases = parsed.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null
      || typeof (candidate as { id?: unknown }).id !== "string"
      || typeof (candidate as { domain?: unknown }).domain !== "string") {
      throw new Error("DEVSPACE_PREVIEW_BASES must contain string id and domain fields.");
    }
    return { id: (candidate as { id: string }).id, domain: (candidate as { domain: string }).domain };
  });
  return { approvedPreviewBases };
}

const configuredSocketPath = process.env.DEVSPACE_AGENT_SOCKET_PATH;
const localRoot = process.env.DEVSPACE_MANAGED_ROOT;
const caddyAdminSocket = process.env.DEVSPACE_CADDY_ADMIN_SOCKET;
const previewProbeSocket = process.env.DEVSPACE_PREVIEW_PROBE_SOCKET;
const previewLeaseResolverSocket = process.env.DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET;
const gatewayPolicy = readGatewayPolicy(process.env);
if (previewProbeSocket !== undefined && previewProbeSocket.trim() === "") {
  throw new Error("DEVSPACE_PREVIEW_PROBE_SOCKET must be a non-empty private Unix-socket path.");
}
if (previewProbeSocket !== undefined && (caddyAdminSocket === undefined || gatewayPolicy === null)) {
  throw new Error("DEVSPACE_PREVIEW_PROBE_SOCKET requires DEVSPACE_CADDY_ADMIN_SOCKET and DEVSPACE_PREVIEW_BASES.");
}
if (previewLeaseResolverSocket !== undefined && previewLeaseResolverSocket.trim() === "") {
  throw new Error("DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET must be a non-empty private Unix-socket path.");
}
const server = createAgentServer({
  ...(configuredSocketPath === undefined ? {} : { socketPath: configuredSocketPath }),
  ...(localRoot === undefined ? {} : {
    managedRoots: {
      projects: `${localRoot}/projects`, workspaces: `${localRoot}/workspaces`, state: `${localRoot}/state`
    },
    operationJournalPath: `${localRoot}/state/operations`
  }),
  previewBaseRegistry: readPreviewBaseRegistry(),
  ...(previewLeaseResolverSocket === undefined ? {} : { previewLeaseResolverSocketPath: previewLeaseResolverSocket }),
  ...(caddyAdminSocket !== undefined && gatewayPolicy !== null ? {
    previewGatewayFactory: (resolveLease: (leaseId: string) => Promise<{ readonly leaseId: string; readonly hostIp: "127.0.0.1"; readonly hostPort: number } | null>) =>
      new PreviewGatewayAdapter({
        transport: new PrivateCaddyAdminTransport({ socketPath: caddyAdminSocket }),
        policy: gatewayPolicy,
        probe: previewProbeSocket === undefined
          ? new GatewayHostProbe(resolveLease)
          : new PrivateGatewayProbeTransport({ socketPath: previewProbeSocket })
      })
  } : {})
});
await server.start();
console.log(`DevSpace Agent listening on ${server.socketPath}`);

const shutdown = async () => {
  await server.stop();
  process.exitCode = 0;
};
process.once("SIGINT", () => { shutdown().catch(() => { process.exitCode = 1; }); });
process.once("SIGTERM", () => { shutdown().catch(() => { process.exitCode = 1; }); });
