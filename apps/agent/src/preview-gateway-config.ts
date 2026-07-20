import {
  GatewayHostProbe,
  PreviewGatewayAdapter,
  PrivateCaddyAdminTransport,
  PrivateGatewayProbeTransport,
  type GatewayPolicy,
  type OpaqueLeaseResolver,
  type PreviewGatewayAdapterContract
} from "@devspace/gateway-caddy";

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

export interface PreviewGatewayConfiguration {
  readonly caddyAdminSocket: string | undefined;
  readonly previewProbeSocket: string | undefined;
  readonly previewLeaseResolverSocket: string | undefined;
  readonly gatewayPolicy: GatewayPolicy | null;
  readonly previewGatewayFactory: ((resolveLease: OpaqueLeaseResolver) => PreviewGatewayAdapterContract) | undefined;
}

export function readPreviewGatewayConfiguration(environment: NodeJS.ProcessEnv = process.env): PreviewGatewayConfiguration {
  const caddyAdminSocket = environment.DEVSPACE_CADDY_ADMIN_SOCKET;
  const previewProbeSocket = environment.DEVSPACE_PREVIEW_PROBE_SOCKET;
  const previewLeaseResolverSocket = environment.DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET;
  const gatewayPolicy = readGatewayPolicy(environment);
  if (previewProbeSocket !== undefined && previewProbeSocket.trim() === "") {
    throw new Error("DEVSPACE_PREVIEW_PROBE_SOCKET must be a non-empty private Unix-socket path.");
  }
  if (previewProbeSocket !== undefined && (caddyAdminSocket === undefined || gatewayPolicy === null)) {
    throw new Error("DEVSPACE_PREVIEW_PROBE_SOCKET requires DEVSPACE_CADDY_ADMIN_SOCKET and DEVSPACE_PREVIEW_BASES.");
  }
  if (previewLeaseResolverSocket !== undefined && previewLeaseResolverSocket.trim() === "") {
    throw new Error("DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET must be a non-empty private Unix-socket path.");
  }
  if (previewLeaseResolverSocket !== undefined && previewProbeSocket === undefined) {
    throw new Error("DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET requires DEVSPACE_PREVIEW_PROBE_SOCKET.");
  }
  const previewGatewayFactory = caddyAdminSocket !== undefined && gatewayPolicy !== null
    ? (resolveLease: OpaqueLeaseResolver): PreviewGatewayAdapterContract => new PreviewGatewayAdapter({
      transport: new PrivateCaddyAdminTransport({ socketPath: caddyAdminSocket }),
      policy: gatewayPolicy,
      probe: previewProbeSocket === undefined
        ? new GatewayHostProbe(resolveLease)
        : new PrivateGatewayProbeTransport({ socketPath: previewProbeSocket })
    })
    : undefined;
  return { caddyAdminSocket, previewProbeSocket, previewLeaseResolverSocket, gatewayPolicy, previewGatewayFactory };
}
