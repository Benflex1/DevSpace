# Coolify / Traefik shared preview ingress

Coolify is an optional outer-ingress integration. DevSpace does not call the Coolify or Traefik
APIs, create one resource per preview, or require a particular Coolify proxy-network name.

The intended topology is:

```text
existing wildcard DNS/TLS/access layer
→ Coolify Traefik
  ├── ordinary application hostnames (code.benflex.dev, app.benflex.dev, ...)
  └── one reserved DevSpace preview namespace rule
      → preview-ingress-connector
      → /run/devspace/gateway/ingress/preview-http.sock
      → exact DevSpace Caddy Host route
      → Agent-managed 127.0.0.1 lease
```

Configure DevSpace with a reserved suffix:

```bash
DEVSPACE_PREVIEW_BASES='[{"id":"main","domain":"benflex.dev","labelSuffix":"-preview"}]'
```

The rule must forward only one-label hosts matching `<generated-stem>-preview.benflex.dev`, preserve
the original `Host`, support HTTP/1.1/WebSocket upgrades, and use the required authentication or
access policy. Ordinary hosts such as `code.benflex.dev` and deeper hosts such as
`foo-preview.bar.benflex.dev` must remain with the normal application routers.

For a current Traefik v3 installation, the rule can conceptually resemble:

```text
HostRegexp(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-preview\\.benflex\\.dev$`)
```

Derive the escaped domain and suffix from the actual `DEVSPACE_PREVIEW_BASES` entry. This example is
illustrative, not generic core configuration: suffixes containing multiple hyphens and base domains
with multiple labels must be rendered from the administrator configuration. Keep the rule's service
target pointed at the connector's internal Compose-network port; do not publish that port on the
host and do not grant Traefik the parent `/run/devspace/gateway` directory.

Before applying a rule, verify the installed Traefik version from the running deployment, for
example by inspecting the image tag and running the container's `traefik version` command where
available. Adapt the versioned `HostRegexp` syntax, router field names, entrypoint names, and
provider configuration to that installed version rather than copying this example as universal
product configuration.

## Deployment checks

1. Inspect persisted preview rows before changing `DEVSPACE_PREVIEW_BASES`.
2. Provision `/srv/devspace/gateway/ingress` with the configured gateway UID/GID and private socket
   permissions; mount only this directory into the connector.
3. Deploy `deploy/preview-gateway/compose.yaml` and run `pnpm preview-gateway:check`.
4. Add one permanent reserved-namespace router to the existing Traefik deployment.
5. Confirm an ordinary application hostname does not reach DevSpace, while a generated reserved
   hostname reaches the terminal 404 until an exact route is materialized.
6. Confirm the incoming `Host` and WebSocket upgrade reach the Preview Gateway unchanged.

Changing a domain or suffix changes canonical hostname identities. Retire/rematerialize affected
preview state in a controlled Web-owned process, remove stale Caddy routes first, then activate the
new namespace. DevSpace intentionally does not perform an unsafe automatic hostname migration.

The current production Web authentication mode remains Cloudflare Access. This does not make the
preview ingress provider-dependent; a future provider-neutral OIDC or standards-based production
authentication mode is tracked separately on the roadmap.
