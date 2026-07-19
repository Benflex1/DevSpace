# Preview Path Runtime Configuration

Preview administration and health probing are private host-side interfaces.
They are not browser endpoints and must not be published through Caddy, a
Cloudflare tunnel, or a workspace container.

The Agent uses these administrator-owned settings:

- `DEVSPACE_PREVIEW_BASES`: the closed JSON registry shared by Web and Agent,
  for example `[ {"id":"local","domain":"localhost"} ]`.
- `DEVSPACE_CADDY_ADMIN_SOCKET`: the private Unix socket for the dedicated
  Caddy Admin API.
- `DEVSPACE_PREVIEW_PROBE_SOCKET`: optional private Unix socket for the
  gateway-host probe service.

On a production host or direct Linux/WSL development, the Agent, dedicated
rootless Docker daemon, Caddy, and `GatewayHostProbe` may share one host
namespace; the Agent can use the host-local probe implementation when the probe
socket is omitted. When the Agent runs inside the code-server container while
Docker and Caddy run on the host, mount both private sockets into that container
at the exact paths configured above and set `DEVSPACE_PREVIEW_PROBE_SOCKET`.
The probe service must be authorized only for the Agent identity (for example
through the Unix socket group and filesystem mode). A representative container
mount configuration is:

```text
--mount type=bind,src=/run/devspace/gateway/caddy-admin.sock,dst=/run/devspace/gateway/caddy-admin.sock
--mount type=bind,src=/run/devspace/gateway/preview-probe.sock,dst=/run/devspace/gateway/preview-probe.sock
```

The probe request contains only the Agent-owned opaque lease ID and bounded
health parameters. The host-side service resolves that ID against the exact
gateway/lease registry and performs the HTTP request against its own
`127.0.0.1:<lease-port>`. The Agent never sends or accepts a browser-controlled
host, IP, port, URL, or upstream. If the private probe socket is unavailable,
the preview is reported as infrastructure `Unavailable`; the Agent must not
fall back to its own container loopback.
