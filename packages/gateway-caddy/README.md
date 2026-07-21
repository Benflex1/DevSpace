# `@devspace/gateway-caddy`

Private Agent-owned Caddy adapter for exact preview routes. It accepts only an approved hostname and an Agent-owned loopback lease, replaces the dedicated preview route set atomically, and exposes an opaque lease probe. Caddy's admin transport is Unix-socket-only; it receives no Docker socket, browser input, or arbitrary upstream.

Approved hostnames are owned by the administrator-reserved `labelSuffix` namespace. Ownership is
exactly one DNS label above the configured base; the base domain itself, ordinary application
subdomains, and deeper subdomains are rejected. Dynamic route documents remain exact Caddy Host
matchers and the unconditional terminal 404 remains last.

The generated Caddy reverse proxy uses the standard `reverse_proxy` handler with
immediate flushing, which preserves ordinary HTTP streaming and WebSocket/HMR
upgrades without rewriting application CSP or frame headers.

The stable Agent-facing API is the concrete `PreviewGatewayAdapter` class:

```ts
type PreviewGatewayRoute = {
  projectId: string;
  workspaceId: string;
  previewId: string;
  revisionId: string;
  generation: number;
  hostname: string;
  approvedBaseId: string;
  leaseId: string;
  hostIp: "127.0.0.1";
  hostPort: number;
  webSocketForwarding: boolean;
};

class PreviewGatewayAdapter {
  probe(input: {
    leaseId: string;
    path: string;
    acceptedStatuses: readonly number[];
    deadlineMs: number;
    signal: AbortSignal;
    webSocketForwarding: boolean;
  }): Promise<PreviewGatewayProbeResult>;
  ensureRoute(input: PreviewGatewayRoute): Promise<void>;
  replaceRoute(input: PreviewGatewayRoute): Promise<void>;
  removeRoute(input: PreviewGatewayRoute | PreviewGatewayRouteIdentity): Promise<void>;
  inspectRoute(input: PreviewGatewayRoute | PreviewGatewayRouteIdentity): Promise<GatewayRouteInspection>;
  reconcileRoutes(inputs: readonly PreviewGatewayRoute[]): Promise<void>;
}
```

`PreviewGatewayAdapter` is constructed with a private typed Caddy transport,
the administrator-approved preview-base registry, and a typed host-side probe.
It never accepts a browser field, raw upstream, Docker ID, or raw Caddy route
document. It generates an exact host matcher and the only permitted upstream:
`127.0.0.1:<hostPort>`. The route ID fences project, workspace, preview,
revision, approved-base, lease, generation, and WebSocket policy. Reconciliation
replaces the dedicated route set, removing foreign or stale routes rather than
adopting them by hostname.

The Agent-facing adapter never opens the lease loopback itself. The injected
probe accepts only an opaque `leaseId`; `GatewayHostProbe` is the host-local
implementation that resolves the lease and performs the loopback request.
`PrivateGatewayProbeTransport` is the code-server-container implementation:
it sends only the opaque lease ID, path, accepted statuses, WebSocket flag, and
bounded deadline over a deployment-provided private Unix socket. The host-side
`GatewayHostProbeServer` resolves the lease and performs the request in the
gateway/rootless-Docker host namespace. Invalid, missing, or non-loopback leases
fail closed with a bounded infrastructure result. The Caddy admin transport and
probe transport are separate private interfaces; neither is public and neither
exposes the Docker socket.

`PrivatePreviewLeaseResolverTransport` is the host-side resolver client. It
sends only `{ leaseId }` to the Agent-owned private resolver socket and accepts
only the exact `{ leaseId, hostIp: "127.0.0.1", hostPort }` response. Socket,
timeout, status, schema, lease-identity, and loopback failures all resolve to a
fail-closed unavailable lease.
