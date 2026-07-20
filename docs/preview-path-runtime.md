# Preview Path Runtime Configuration

Preview administration and health probing are private host-side interfaces.
They are not browser endpoints and must not be published through Caddy, a
Cloudflare tunnel, or a workspace container.

The Agent uses these administrator-owned settings:

- `DEVSPACE_PREVIEW_BASES`: the closed JSON registry shared by Web and Agent,
  for example `[ {"id":"local","domain":"localhost"} ]`.
- `DEVSPACE_CADDY_ADMIN_SOCKET`: the private Unix socket for the dedicated
  Caddy Admin API.
- `DEVSPACE_PREVIEW_PROBE_SOCKET`: private Unix socket for the gateway-host
  probe service when the Agent does not share the gateway host namespace.
- `DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET`: private Unix socket for the
  Agent-owned opaque preview lease resolver. It is used only by the host-side
  probe runtime and is not an Agent API or browser endpoint.

On a production host or direct Linux/WSL development, the Agent, dedicated
rootless Docker daemon, Caddy, and `GatewayHostProbe` may share one host
namespace; the Agent can use the host-local probe implementation when the probe
socket is omitted. When the Agent runs inside the code-server container while
Docker and Caddy run on the host, mount both private sockets into that container
at the exact paths configured above and set `DEVSPACE_PREVIEW_PROBE_SOCKET`.
Once that variable is set, the Agent always uses that Unix-socket transport; it
does not fall back to a loopback probe if the socket is unavailable. The
variable requires `DEVSPACE_CADDY_ADMIN_SOCKET` and `DEVSPACE_PREVIEW_BASES`.
The probe service must be authorized only for the Agent identity (for example
through the Unix socket group and filesystem mode). A representative container
mount configuration is:

```text
--mount type=bind,src=/run/devspace/gateway/caddy-admin.sock,dst=/run/devspace/gateway/caddy-admin.sock
--mount type=bind,src=/run/devspace/gateway/preview-probe.sock,dst=/run/devspace/gateway/preview-probe.sock
--mount type=bind,src=/run/devspace/gateway/preview-lease-resolver.sock,dst=/run/devspace/gateway/preview-lease-resolver.sock
```

The optional `@devspace/preview-gateway-host` runtime owns the host-side
`DEVSPACE_PREVIEW_PROBE_SOCKET`. It uses the resolver transport over
`DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET`, then starts `GatewayHostProbeServer`;
it does not connect to Docker, expose a public listener, or inspect Agent state.
The resolver protocol is the closed `POST /v1/preview/lease/resolve` request
`{ "leaseId": "<opaque lease id>" }` and the exact three-field loopback lease
response. Unknown, malformed, mismatched, or non-loopback values fail closed.

The probe request contains only the Agent-owned opaque lease ID and bounded
health parameters. The host-side service resolves that ID against the exact
gateway/lease registry and performs the HTTP request against its own
`127.0.0.1:<lease-port>`. The Agent never sends or accepts a browser-controlled
host, IP, port, URL, or upstream. If the private probe socket is unavailable,
the preview is reported as infrastructure `Unavailable`; the Agent must not
fall back to its own container loopback.

The deployable host-namespace stack, code-server mount, static Cloudflare
origin, and manual validation runbook are documented in
[`preview-gateway-deployment.md`](./preview-gateway-deployment.md). The stack
uses the fixed Caddy listener `127.0.0.1:18080` and the Caddy Admin socket
`/run/devspace/gateway/caddy-admin.sock`.

## Runtime and route lifecycle

Web is authoritative for the materialized hostname, while Agent-private workspace ownership retains
the canonical project/workspace slugs used to validate it. Activation requires the exact workspace,
immutable revision, preview configuration, runtime generation, loopback lease, and slug-derived
hostname. The browser supplies only resource IDs and actions.

Docker preview bindings are always `127.0.0.1` and are never published publicly. A stopped retained
container keeps its lease reservation even after its Caddy route is removed. Lease release occurs
only after exact container ownership is conclusively removed or replaced.

`Waiting` is the materialized preview without a ready route, including a valid runtime whose app is
not listening yet. `Ready` requires an accepted health response and the exact Caddy route.
`Inactive` is an intentional stop. `Unavailable` covers missing or drifted runtime ownership,
gateway/probe failure, unsupported service-target execution, or another terminal failure.

At Agent startup, route reconciliation probes and restores only exact healthy desired previews, then
replaces the managed Caddy route set. Gateway restart therefore cannot cause hostname-only route
adoption. Web reconciliation observes the Agent snapshot and operation journal with the same
revision/generation fencing. The permanent browser E2E covers HTTP, WebSocket/HMR, exact simulated
container ownership, Agent and gateway restart, stop, route removal, and retained lease behavior.
