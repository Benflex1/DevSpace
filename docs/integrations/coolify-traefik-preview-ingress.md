# Coolify / Traefik shared preview ingress

This document describes the current validated home-server integration. It is not a requirement
for DevSpace core: other administrators may select another outer ingress that can enforce the
same reserved-namespace, Host-preservation, WebSocket, and authentication invariants.

## Current home-server topology

For the current deployment target, the selected path is:

```text
Cloudflare Tunnel
→ Coolify Traefik
→ preview-ingress-connector
→ private ingress Unix socket
→ dedicated Caddy
→ Agent-managed loopback lease
→ workspace container
```

The connector is selected because Coolify Traefik owns the exact administrator-reserved
`*-preview.benflex.dev` namespace rule. Ordinary hosts such as `code.benflex.dev` and
`app.benflex.dev` remain outside DevSpace preview routing.

Coolify is an outer-ingress integration only. DevSpace does not call Coolify or Traefik APIs,
create one resource per preview, or require a particular Coolify proxy-network name.

## Reserved namespace rule

Configure the matching DevSpace preview base:

```bash
DEVSPACE_PREVIEW_BASES='[{"id":"main","domain":"benflex.dev","labelSuffix":"-preview"}]'
```

The permanent namespace router must forward only one-label hosts matching
`<generated-stem>-preview.benflex.dev`, preserve the original `Host`, support HTTP/1.1/WebSocket
upgrades, and apply the required authenticated access policy. Ordinary hosts such as
`code.benflex.dev` and deeper hosts such as `foo-preview.bar.benflex.dev` must remain with the
normal application routers.

For a current Traefik v3 installation, the rule can conceptually resemble:

```text
HostRegexp(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-preview\\.benflex\\.dev$`)
```

Derive the escaped domain and suffix from the actual `DEVSPACE_PREVIEW_BASES` entry. This example
is illustrative, not generic core configuration: suffixes containing multiple hyphens and base
domains with multiple labels must be rendered from the administrator configuration. Keep the
service target pointed at the connector's internal Compose-network port; do not publish that port
on the host.

Do not assign a Coolify-generated service domain to the Caddy, `preview-gateway-host`, or
`preview-ingress-connector` services. The connector should not publish a host port, and no
host/Coolify Docker socket may be mounted. Do not manually attach arbitrary proxy networks unless
verified deployment evidence shows that the selected integration requires one. The permanent
namespace router is administrator-managed integration configuration, not per-preview DevSpace
state.

Before applying a rule, verify the installed Traefik version from the running deployment, for
example by inspecting the image tag and running the container's `traefik version` command where
available. Adapt the versioned `HostRegexp` syntax, router field names, entrypoint names, and
provider configuration to that installed version rather than copying this example as universal
product configuration.

## Deployment checks

1. Inspect persisted preview rows before changing `DEVSPACE_PREVIEW_BASES`.
2. Provision the configured `DEVSPACE_GATEWAY_HOST_DIR` and its private `ingress` subdirectory
   with the selected gateway UID/GID and mode `0700`.
3. Deploy `deploy/preview-gateway/compose.yaml` and run `pnpm preview-gateway:check`.
4. Confirm the three gateway services have no Coolify-generated domains, no host-port publication,
   and no host/Coolify Docker socket mount.
5. Add one permanent reserved-namespace router to the existing Traefik deployment.
6. Confirm an ordinary application hostname does not reach DevSpace, while a generated reserved
   hostname reaches the terminal 404 until an exact route is materialized.
7. Confirm the incoming `Host` and WebSocket upgrade reach the Preview Gateway unchanged.

Changing a domain or suffix changes canonical hostname identities. Retire/rematerialize affected
preview state in a controlled Web-owned process, remove stale Caddy routes first, then activate
the new namespace. DevSpace intentionally does not perform an unsafe automatic hostname
migration.

The current production Web authentication mode remains Cloudflare Access. This does not make the
preview ingress provider-dependent; a future provider-neutral OIDC or standards-based production
authentication mode is tracked separately on the roadmap.
