# Preview Gateway Deployment

This is the provider-neutral repository deployment contract for the M1 workspace preview path.
The Compose stack contains three services:

```text
dedicated Caddy (host network, 127.0.0.1:18080)
preview-gateway-host (host network, owns probe socket and consumes Agent lease-resolver socket)
preview-ingress-connector (isolated Compose network, internal TCP port only)
```

DevSpace core does not require Coolify, Traefik, Cloudflare, `benflex.dev`, UID `1000`, or
`/srv/devspace`. Those values describe the currently validated home-server deployment target.
Another administrator may select different host directories, UID/GID values, domains,
authentication layers, and outer-ingress providers. The fixed internal socket and container paths
below are part of this deployment contract; provider-specific setup belongs in integration
documentation.

The stack does not mount a Docker socket, publish a host port, discover containers, or let the
Node process start Caddy. Caddy and the host service share the complete gateway runtime root;
the connector receives only the ingress subdirectory read-only.

## Shared-ingress contract

The internal gateway contract is:

```text
outer ingress
→ exact reserved preview namespace
→ selected preview gateway entry path
→ Caddy exact Host route
→ Agent-owned lease
```

The administrator reserves a namespace in `DEVSPACE_PREVIEW_BASES`. For the current home-server
example:

```bash
DEVSPACE_PREVIEW_BASES='[{"id":"main","domain":"benflex.dev","labelSuffix":"-preview"}]'
```

The generated hostname is `<rendered-pattern-stem>-preview.benflex.dev` for that example. DNS,
TLS, authentication/access policy, and the outer-ingress rule are administrator-owned. The
selected outer ingress must route only the administrator-reserved preview namespace, preserve the
original `Host` header, support WebSocket upgrades, and must not capture unrelated application
hostnames. Not every Cloudflare, reverse-proxy, or tunnel product can express that rule; verify
the selected provider's exact-match and upgrade behavior before choosing it.

DevSpace does not call Coolify, Traefik, Cloudflare, or DNS APIs, and Traefik is not mandatory for
all DevSpace installations.

### Available gateway entry paths

1. The isolated `preview-ingress-connector` listens on the internal Compose-network port
   `DEVSPACE_PREVIEW_INGRESS_PORT` (default `8080`) and forwards TCP bytes to
   `/run/devspace/gateway/ingress/preview-http.sock`. It publishes no host port and mounts only
   the ingress directory read-only.
2. The host-local Caddy listener at `127.0.0.1:18080` is retained for diagnostics and deployments
   where an administrator-controlled outer ingress can safely and exactly select the reserved
   namespace.

Both paths preserve the same Caddy Host-route and Agent-lease contract. The isolated connector is
the selected entry path for the current home-server Coolify/Traefik integration; that choice is
not a provider-neutral core requirement.

## Provision the host runtime directory

`DEVSPACE_GATEWAY_HOST_DIR` is a deployment-level host path used by Compose. It is not an Agent
runtime variable. The default and current home-server example is `/srv/devspace/gateway`; another
administrator can set the variable to a different administrator-provisioned directory.
Keep the selected directory outside project worktrees and the production directory.

Both directories must exist before Compose deployment. `create_host_path: false` intentionally
prevents Docker from silently creating either directory. The intended mode is `0700`; setgid is
not required.

Use the selected deployment values to provision the root and its private ingress subdirectory:

```bash
DEVSPACE_GATEWAY_HOST_DIR="${DEVSPACE_GATEWAY_HOST_DIR:-/srv/devspace/gateway}"
DEVSPACE_GATEWAY_UID="${DEVSPACE_GATEWAY_UID:-1000}"
DEVSPACE_GATEWAY_GID="${DEVSPACE_GATEWAY_GID:-1000}"

sudo install -d \
  -o "$DEVSPACE_GATEWAY_UID" \
  -g "$DEVSPACE_GATEWAY_GID" \
  -m 0700 \
  "$DEVSPACE_GATEWAY_HOST_DIR"

sudo install -d \
  -o "$DEVSPACE_GATEWAY_UID" \
  -g "$DEVSPACE_GATEWAY_GID" \
  -m 0700 \
  "$DEVSPACE_GATEWAY_HOST_DIR/ingress"
```

Verify the exact ownership and modes:

```bash
stat -c '%a %u:%g %n' \
  "$DEVSPACE_GATEWAY_HOST_DIR" \
  "$DEVSPACE_GATEWAY_HOST_DIR/ingress"
```

For the current home-server example, expected output is:

```text
700 1000:1000 /srv/devspace/gateway
700 1000:1000 /srv/devspace/gateway/ingress
```

The parent directory is shared by Caddy, `preview-gateway-host`, and the Agent. Caddy writes
`ingress/preview-http.sock`; the connector receives only `ingress` read-only. The code-server
container and Agent require read-write access to the parent directory so the Agent can create
`lease-resolver.sock`. Do not use permissive fallback modes such as `0777`.

The Compose file uses the portable root variable for both parent mounts and appends `/ingress`
for the connector mount:

```yaml
source: ${DEVSPACE_GATEWAY_HOST_DIR:-/srv/devspace/gateway}
source: ${DEVSPACE_GATEWAY_HOST_DIR:-/srv/devspace/gateway}/ingress
```

The container path remains fixed at `/run/devspace/gateway` and the connector target remains
`/run/devspace/gateway/ingress`.

Validate the rendered Compose model before deployment. Standard Compose supports interpolation
followed by the literal `/ingress` suffix:

```bash
DEVSPACE_GATEWAY_HOST_DIR=/tmp/devspace-gateway-test \
DEVSPACE_GATEWAY_UID="$(id -u)" \
DEVSPACE_GATEWAY_GID="$(id -g)" \
docker compose \
  -f deploy/preview-gateway/compose.yaml \
  config
```

The rendered Caddy and `preview-gateway-host` sources must be
`/tmp/devspace-gateway-test`, and the connector source must be
`/tmp/devspace-gateway-test/ingress`.

The repository-only contract check does not need Docker or a Caddy binary:

```bash
pnpm preview-gateway:check
```

Repository CI additionally renders this Compose model with a synthetic non-default host root.
That check verifies both the default-expression interpolation syntax and the literal `/ingress`
suffix without starting containers. Administrators should still run `docker compose config` with
their real deployment values before deployment.

## Deploy the stack

The artifacts are in `deploy/preview-gateway/`. Deploy the Compose file through the selected
administrator-controlled container system. Do not expose gateway services through automatically
assigned public service domains; use the selected administrator-owned outer-ingress contract.
Provider-specific instructions belong in integration documentation.

The Caddy service uses a small deployment image with `caddy.json` baked in. Its listeners are
`127.0.0.1:18080` and `/run/devspace/gateway/ingress/preview-http.sock`; the initial route set
is a gateway-owned terminal HTTP 404 fallback. Agent route reconciliation writes exact preview
routes before that fallback and always writes the fallback back as the last route.

The Caddy smoke test uses the pinned real-Caddy image and can be run separately when Docker is
available. It publishes no ports:

```bash
pnpm preview-gateway:caddy-smoke
```

## Add mounts and environment to code-server

Mount the same host directory into code-server using the portable deployment value:

```text
${DEVSPACE_GATEWAY_HOST_DIR}:/run/devspace/gateway
```

For the current home-server deployment, this is:

```text
/srv/devspace/gateway:/run/devspace/gateway
```

This first mount is gateway runtime/socket sharing. Separately mount the dedicated rootless
DevSpace Docker Engine socket:

```text
/run/user/1000/docker.sock:/run/devspace-docker/docker.sock
```

The second mount is the dedicated rootless DevSpace Docker Engine, not the host/Coolify Docker
socket. The host/Coolify Docker socket must never be mounted. Another administrator may use a
different rootless socket host path; `DEVSPACE_DOCKER_SOCKET_PATH` refers to the container-side
path `/run/devspace-docker/docker.sock`.

Set these non-secret runtime environment names and paths, retaining the existing
`DEVSPACE_APP_ORIGIN` configuration:

```bash
DEVSPACE_PREVIEW_BASES='[{"id":"main","domain":"benflex.dev","labelSuffix":"-preview"}]'

DEVSPACE_CADDY_ADMIN_SOCKET=/run/devspace/gateway/caddy-admin.sock
DEVSPACE_PREVIEW_PROBE_SOCKET=/run/devspace/gateway/preview-probe.sock
DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET=/run/devspace/gateway/lease-resolver.sock
DEVSPACE_DOCKER_SOCKET_PATH=/run/devspace-docker/docker.sock
```

`DEVSPACE_GATEWAY_RUNTIME_DIR` is not a required variable. The deployment-level
`DEVSPACE_GATEWAY_HOST_DIR` controls the host-side Compose bind source; the fixed container-side
runtime path and the socket variables above are the sharing contract.

Startup is intentionally fail-closed and retryable:

```text
preview gateway stack running
→ shared runtime directory mounted into code-server
→ DevSpace Agent starts and creates lease-resolver.sock
→ host probe resolves leases through that socket
→ Agent probes through private probe socket
→ healthy target causes exact Caddy route installation
```

If either service or socket is temporarily unavailable, the Agent reports the preview as not
ready and normal startup/reconciliation can recover it. No loopback or public fallback bypasses
the private socket boundaries.

## Manual validation runbook

After this change is merged:

1. Provision the configured shared runtime root and private `ingress` directory with the selected
   UID/GID and mode `0700`.
2. Deploy `deploy/preview-gateway/compose.yaml` with the selected container deployment system.
3. Mount the same host directory into code-server at
   `${DEVSPACE_GATEWAY_HOST_DIR}:/run/devspace/gateway`.
4. Restart code-server if the new bind mount is not applied to the running container.
5. Start DevSpace with all preview socket variables above and the existing `DEVSPACE_APP_ORIGIN`.
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

10. After the selected outer-ingress rule is configured, verify that the generated reserved
    namespace hostname reaches the Vite application. The suffix rule is an integration invariant,
    not a portable wildcard hostname syntax.

### Diagnostics

Run socket and listener checks on the host or in code-server as appropriate. These commands print
paths, status, and bounded state only; they do not print credentials or environment values.

The production path expects four private Unix sockets:

```text
caddy-admin.sock       — Caddy
preview-probe.sock     — preview-gateway-host
lease-resolver.sock    — Agent
ingress/preview-http.sock — Caddy
```

Caddy owns `caddy-admin.sock` and `ingress/preview-http.sock`; `preview-gateway-host` owns
`preview-probe.sock`; the Agent owns `lease-resolver.sock`. Expected socket mode is generally
`0660`, with access controlled by the selected deployment identity/group. Verify the directory
and socket identity against the selected UID/GID rather than assuming UID `1000` is universal.

```bash
DEVSPACE_GATEWAY_HOST_DIR="${DEVSPACE_GATEWAY_HOST_DIR:-/srv/devspace/gateway}"
for socket in caddy-admin.sock preview-probe.sock lease-resolver.sock ingress/preview-http.sock; do
  path="$DEVSPACE_GATEWAY_HOST_DIR/$socket"
  if test -S "$path"; then
    stat -c '%F %a %u:%g %n' "$path"
  else
    printf 'missing %s\n' "$path"
  fi
done
```

Check the host-local Caddy listener and unmatched-host fail-closed response:

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
