# Preview Gateway Deployment

This is the repository-side deployment for the real code-server-hosted M1
workspace preview path. It is one Coolify-supervised Compose stack with two
sibling services:

```text
dedicated Caddy (host network, 127.0.0.1:18080)
preview-gateway-host (host network, private probe socket)
```

Both services use the administrator-selected UID/GID and share one
administrator-provisioned runtime directory. The stack does not mount a Docker
socket, publish Docker ports, discover containers, or let the Node process
start Caddy.

## Deploy the stack

The artifacts are in `deploy/preview-gateway/`. Provision the documented host
directory before deploying through Coolify:

```text
DEVSPACE_GATEWAY_UID=1000
DEVSPACE_GATEWAY_GID=1000
```

Provision the directory with ownership and permissions that allow the selected
UID/GID to create and access private Unix sockets. Keep it outside project
worktrees and the production directory. The Compose stack mounts it at the
fixed container path `/run/devspace/gateway`.

The Caddy service loads the read-only `caddy.json` and owns the private Admin
socket. Its only HTTP listener is `127.0.0.1:18080`; the initial route set is a
gateway-owned terminal HTTP 404 fallback. Agent route reconciliation writes
exact preview routes before that fallback and always writes the fallback back
as the last route.

The repository validation does not need Docker or a Caddy binary:

```bash
pnpm preview-gateway:check
```

The pinned real-Caddy Admin API path can be smoke-tested separately when
Docker is available. The command uses the effective gateway UID/GID model,
the checked-in native JSON configuration, and a temporary Unix-socket runtime
directory; it publishes no ports:

```bash
pnpm preview-gateway:caddy-smoke
```

## Add the mount to code-server

Add the same host directory to the existing code-server deployment, using the
exact container path:

```text
/srv/devspace/gateway:/run/devspace/gateway
```

Add these variables to the DevSpace startup environment and retain the
existing `DEVSPACE_APP_ORIGIN` configuration:

```bash
DEVSPACE_PREVIEW_BASES='[{"id":"main","domain":"benflex.dev"}]'

DEVSPACE_CADDY_ADMIN_SOCKET=/run/devspace/gateway/caddy-admin.sock
DEVSPACE_PREVIEW_PROBE_SOCKET=/run/devspace/gateway/preview-probe.sock
DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET=/run/devspace/gateway/lease-resolver.sock

DEVSPACE_DOCKER_SOCKET_PATH=/run/devspace-docker/docker.sock
```

The code-server container still needs its existing mount for
`/run/devspace-docker/docker.sock`; that is the dedicated rootless DevSpace
runtime socket, not the host/Coolify Docker socket. The gateway stack itself
does not receive either Docker socket.

Startup is intentionally fail-closed and retryable:

```text
preview gateway stack running
→ shared runtime directory mounted into code-server
→ DevSpace Agent starts and creates lease resolver socket
→ host probe resolves leases through that socket
→ Agent probes through private probe socket
→ healthy target causes exact Caddy route installation
```

If either service or socket is temporarily unavailable, the Agent reports the
preview as not ready and normal startup/reconciliation can recover it. No
loopback or public fallback bypasses the private socket boundaries.

## Static Cloudflare configuration

Configure the existing host-networked `cloudflared` service once with this
fixed origin:

```text
*.benflex.dev
→ Cloudflare Tunnel
→ http://127.0.0.1:18080
```

Static external setup consists of:

- wildcard Cloudflare DNS and tunnel hostname;
- wildcard tunnel ingress/public hostname;
- Cloudflare Access policy covering the preview subdomains;
- tunnel origin fixed to `http://127.0.0.1:18080`.

DevSpace supplies only dynamic state:

- exact generated `*.benflex.dev` hostname;
- health state;
- exact Caddy host route;
- leased loopback upstream.

There is no Cloudflare API or Coolify API integration in this path.

## Manual validation runbook

After this change is merged:

1. Provision an administrator-owned shared runtime directory and select the
   matching gateway UID/GID.
2. Deploy `deploy/preview-gateway/compose.yaml` through Coolify.
3. Mount the same directory into code-server at
   `/srv/devspace/gateway:/run/devspace/gateway`.
4. Restart code-server if the new bind mount is not applied to the running
   container.
5. Start DevSpace with all preview socket variables above and the existing
   `DEVSPACE_APP_ORIGIN`.
6. Start or retain the existing project runtime.
7. Inside the workspace run:

   ```bash
   pnpm exec vite --host=0.0.0.0
   ```

8. Request Preview reconciliation.
9. Expect the preview state to move from:

   ```text
   Unavailable/Waiting
   → Ready
   ```

10. After Cloudflare wildcard routing is configured, verify that the generated
    `*.benflex.dev` hostname reaches the Vite application.

### Diagnostics

Run socket and listener checks on the host or in code-server as appropriate.
These commands print paths, status, and bounded state only; they do not print
credentials or environment values.

Check only the three expected private sockets:

```bash
for socket in caddy-admin.sock preview-probe.sock lease-resolver.sock; do
  path="/srv/devspace/gateway/$socket"
  if test -S "$path"; then stat -c '%F %a %U:%G %n' "$path"; else printf 'missing %s\n' "$path"; fi
done
```

Check the Caddy loopback listener and unmatched-host fail-closed response:

```bash
ss -ltn | awk '$4 == "127.0.0.1:18080" { print }'
curl --silent --show-error --max-time 2 -H 'Host: unmatched.invalid' \
  http://127.0.0.1:18080/ -o /dev/null -w 'fallback_http_status=%{http_code}\n'
```

Inspect preview leases without dumping complete state files:

```bash
find "${DEVSPACE_MANAGED_ROOT}/state/preview-leases" -maxdepth 1 -type f -name '*.json' \
  -exec jq -c '{leaseId,state,hostIp,hostPort}' {} +
```

Inspect Agent preview state over its existing private socket:

```bash
curl --silent --unix-socket "$DEVSPACE_AGENT_SOCKET_PATH" \
  -H 'X-DevSpace-Protocol-Version: 1' \
  -H 'X-DevSpace-Request-Id: 01900000-0000-7000-8000-000000000001' \
  -H "X-DevSpace-Sent-At: $(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
  http://localhost/v1/snapshot \
  | jq '.data.resources[] | select(.type == "preview") | .observation | {previewId,hostname,desiredState,observedState,routePresent,lastStatusCode,lastError}'
```
