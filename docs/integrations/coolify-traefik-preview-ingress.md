# Coolify Raw Compose preview ingress

This document is the provider-specific deployment adapter for the current home-server
Coolify/Traefik integration. The provider-neutral gateway contract remains
[`deploy/preview-gateway/compose.yaml`](../../deploy/preview-gateway/compose.yaml) and
[`preview-gateway-deployment.md`](../preview-gateway-deployment.md).

## Validated deployment mode

The gateway must use **Raw Compose Deployment**. Normal Coolify Compose mode transforms the
external-volume service mounts and has produced project-scoped Docker-managed storage instead of
the administrator-created bind volumes. That mode is not valid for this gateway.

Raw Compose preserves the exact external objects:

- `devspace-gateway-runtime`
- `devspace-gateway-ingress`

Coolify's Persistent Storage page may still display stale definitions from a deployment before
Raw Compose was enabled. Do not use that page as runtime truth and do not recreate storage from
it. The generated Compose model and `docker inspect` output are authoritative.

Configure the Coolify resource with this single Compose Location:

```text
/deploy/preview-gateway/compose.coolify.yaml
```

The leading slash is the Coolify repository-location form. The entrypoint uses Compose `include`
to render the generic contract together with `compose.coolify-network.yaml`; the adapter does not
duplicate the three service definitions. Repository CI runs `docker compose config` through this
exact entrypoint and validates the rendered model.

Set this non-secret deployment variable explicitly:

```text
DEVSPACE_COOLIFY_PROXY_NETWORK=<administrator-selected-external-network>
```

There is no default. `${DEVSPACE_COOLIFY_PROXY_NETWORK:?...}` interpolation rejects both an unset
and an empty value so a deployment cannot silently start with an isolated connector.

## Observed production evidence

Raw Compose successfully runs all three gateway services with the selected UID/GID, preserves
both external bind volumes, creates all four private sockets, and returns Caddy's fallback HTTP
404. The Agent reports healthy rootless runtime and operation journal availability.

The remaining failure was network topology: Raw Compose attached the connector only to its
generated private `<resource>_default` network, while Coolify's Traefik proxy used the separate
stable `<resource>` network. The generated environment did not contain
`COOLIFY_RESOURCE_UUID`. A temporary connector-only attachment to the stable network with alias
`devspace-preview-ingress` returned the expected Caddy 404 and was removed after the proof.

The observed proxy was Traefik `3.6.13` from `traefik:v3.6`; generated Compose labels reported
version `5.3.1`. The connector exposed `8080/tcp` and had no published host port. These are
deployment observations, not generic defaults or names embedded in the adapter.

## Resulting network boundary

The rendered topology is:

```text
Coolify Traefik
→ administrator-selected external proxy network
→ devspace-preview-ingress:8080
→ preview-ingress-connector
→ /run/devspace/gateway/ingress/preview-http.sock
→ Caddy
```

Only `preview-ingress-connector` joins the selected external network, with the stable alias
`devspace-preview-ingress`. The connector exposes `8080/tcp` internally by default, publishes no
host port, mounts only `devspace-gateway-ingress` read-only, and receives no Docker socket.

`caddy` and `preview-gateway-host` remain `network_mode: host`. They must not join the Coolify
proxy network, publish ports, or mount the host/Coolify Docker socket. The connector must not
receive the full `devspace-gateway-runtime` volume.

Do not use `docker network connect` as durable setup. A manual attachment is useful only as
temporary diagnosis and disappears on container replacement. The repository adapter owns the
durable attachment.

## Select and verify the proxy network

List every Docker network currently attached to Coolify's Traefik proxy:

```bash
docker inspect coolify-proxy \
  --format '{{range $network, $_ := .NetworkSettings.Networks}}{{println $network}}{{end}}' \
  | sort
```

Inspect candidate networks before selecting one:

```bash
docker network inspect <candidate-network> \
  --format 'name={{.Name}} driver={{.Driver}} scope={{.Scope}} containers={{json .Containers}}'
```

Select the administrator-managed network intended to connect this Coolify resource to
`coolify-proxy`, then set its exact name as `DEVSPACE_COOLIFY_PROXY_NETWORK`. Do not derive it
from `COOLIFY_RESOURCE_UUID`: that variable is absent from the observed Raw Compose environment,
and the adapter intentionally does not depend on it.

After deployment, identify the real connector container from the generated Compose deployment
and inspect its effective networks and aliases:

```bash
docker inspect <preview-ingress-connector-container> \
  --format '{{json .NetworkSettings.Networks}}' \
  | jq
```

The output must contain the selected external network and the alias
`devspace-preview-ingress`. Confirm network membership from the other direction:

```bash
docker network inspect "$DEVSPACE_COOLIFY_PROXY_NETWORK" \
  --format '{{json .Containers}}' \
  | jq
```

Verify the remaining topology and mounts from Docker itself:

```bash
docker inspect \
  --format '{{.Name}} network_mode={{.HostConfig.NetworkMode}} ports={{json .HostConfig.PortBindings}} mounts={{range .Mounts}}{{.Name}}:{{.Destination}}:rw={{.RW}} {{end}}' \
  <caddy-container> \
  <preview-gateway-host-container> \
  <preview-ingress-connector-container>
```

Expected results:

- Caddy and the gateway host use `network_mode=host`.
- All `PortBindings` values are empty.
- Caddy and the gateway host mount `devspace-gateway-runtime` read-write.
- The connector mounts only `devspace-gateway-ingress` at
  `/run/devspace/gateway/ingress`, read-only.
- No mount source or destination is a host/Coolify Docker socket.

## Storage and service configuration

Provision and inspect the two administrator-owned external bind volumes exactly as described in
[`preview-gateway-deployment.md`](../preview-gateway-deployment.md). For the current home server,
their bind devices are `/srv/devspace/gateway` and `/srv/devspace/gateway/ingress`, and the
selected service identity is UID/GID `1000:1000`. Those are administrator deployment values, not
hardcoded adapter defaults.

Keep Coolify storage configuration empty for this Raw Compose resource. Ignore stale
pre-Raw-Compose entries in the Persistent Storage page; verify the generated Compose and real
container mounts instead.

Do not:

- add a Coolify-generated service domain to any gateway service;
- publish connector port `8080`;
- attach Caddy or `preview-gateway-host` to the proxy network;
- mount `/var/run/docker.sock`, the Coolify Docker socket, or another host Docker socket;
- replace the exact external volumes with Coolify-managed project volumes;
- use a manual `docker network connect` as the permanent configuration.

## Deployment and reachability checks

1. Enable Raw Compose Deployment on the gateway resource.
2. Set Compose Location to `/deploy/preview-gateway/compose.coolify.yaml`.
3. Set `DEVSPACE_COOLIFY_PROXY_NETWORK` to the exact selected external network name.
4. Keep the resource's Persistent Storage and service-domain configuration empty.
5. Confirm the exact external bind volumes already exist and their Docker `Options` point to the
   intended directories.
6. Deploy the Raw Compose resource.
7. Inspect the generated Compose model and all three real containers.
8. Verify `caddy-admin.sock`, `preview-probe.sock`, `lease-resolver.sock`, and
   `ingress/preview-http.sock`.
9. From a temporary diagnostic container on the selected proxy network, request the stable alias
   without publishing a port:

   ```bash
   docker run --rm \
     --network "$DEVSPACE_COOLIFY_PROXY_NETWORK" \
     curlimages/curl:8.17.0 \
     --silent --output /dev/null --write-out '%{http_code}\n' \
     --header 'Host: network-proof-preview.invalid' \
     http://devspace-preview-ingress:8080/
   ```

   Before an exact Agent-managed preview route exists, the expected status is Caddy's fallback
   `404`.

This task establishes durable network reachability only. Do **not** add the permanent Traefik
`HostRegexp` router as part of this deployment change. The authenticated reserved-namespace
router, Host preservation, WebSocket validation, and external preview verification are the next
production stage after this change is merged and deployed.
