# DevSpace

DevSpace is a self-hosted, single-user, AI-first development control plane. Each project is
intended to have a managed primary workspace in an isolated development environment.

Milestone 1 is in progress. The first product slice now provides browser onboarding backed by real
SQLite persistence and real Agent inspection over a Unix socket. Registered projects remain in a
workspace-setup-pending state until the managed primary workspace slice.

Development now proceeds through vertical slices toward a usable primary workspace: browser
onboarding, a managed worktree, an isolated runtime, terminal/tasks, and previews. See
[`docs/roadmap.md`](docs/roadmap.md) for the current delivery direction.

The accepted boundaries remain: the browser talks only to the web application; the web application
owns SQLite writes; the agent owns filesystem, Git, PTY, and dedicated rootless-Docker operations;
project containers receive only declared workspace inputs; and DevSpace never auto-merges or deploys
production changes.

Run the usable local slice with `pnpm dev`, then open `http://localhost:3000`. Run its deterministic
browser test with `pnpm test:e2e`. Production authentication and runtime settings are listed in
`.env.example`.

## Preview ingress contract

DevSpace uses an administrator-owned preview base domain and reserved label suffix, for example
`benflex.dev` and `-preview`. A rendered Project Options stem becomes
`<stem>-preview.benflex.dev`; ordinary hosts such as `code.benflex.dev` remain outside DevSpace
ownership.

The administrator provides DNS/TLS coverage, one permanent outer-ingress rule for that namespace,
original `Host` preservation, WebSocket-capable forwarding, appropriate access control, and the
dedicated Preview Gateway. The generic deployment and ingress contract is documented in
[`docs/preview-gateway-deployment.md`](docs/preview-gateway-deployment.md). The outer ingress may
be Traefik, Caddy, Nginx, Cloudflare Tunnel, or another compatible reverse proxy. Optional
Coolify/Traefik integration guidance is in
[`docs/integrations/coolify-traefik-preview-ingress.md`](docs/integrations/coolify-traefik-preview-ingress.md).

Current production Web authentication still uses Cloudflare Access; provider-neutral production
authentication such as OIDC remains a roadmap item.
