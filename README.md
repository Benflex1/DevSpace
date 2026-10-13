# DevSpace

**[Install DevSpace on Ubuntu 24.04](docs/installation-ubuntu-24.04.md)** — supported host
prerequisites, rootless Docker, Cloudflare Access, persistent systemd services, and first-run steps.

DevSpace is a self-hosted, single-user, AI-first development control plane. Each project is
intended to have a managed primary workspace in an isolated development environment.

Milestone 1 is complete after PR #38. The validated owner-only product path covers browser
onboarding, managed primary workspaces, isolated rootless-Docker runtime lifecycle, terminals,
structured foreground tasks, workspace-target previews, the private Preview Gateway, and bounded
restart/reconciliation recovery. DevSpace as a whole is not feature-complete or generally
production-ready for arbitrary multi-user deployments.

Post-M1 development proceeds through vertical slices toward the remaining product roadmap. See
[`docs/roadmap.md`](docs/roadmap.md) for the current delivery direction.

The accepted boundaries remain: the browser talks only to the web application; the web application
owns SQLite writes; the agent owns filesystem, Git, PTY, and dedicated rootless-Docker operations;
project containers receive only declared workspace inputs; and DevSpace never auto-merges or deploys
production changes.

Run the usable local slice with `pnpm dev`, then open `http://localhost:3000`. Run its deterministic
browser test with `pnpm test:e2e`. Production authentication and runtime settings are listed in
`.env.example`.

## TypeScript toolchain

DevSpace uses the pinned native TypeScript 7.0.2 package alias for every repository `tsc` typecheck
and project-reference build. The `typescript` dependency deliberately aliases
`@typescript/typescript6` (currently exposing `tsc6` 6.0.3) for the legacy compiler API used by the
workspace-graph checker and `typescript-eslint`. Run `pnpm toolchain:check` to verify the split.

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

## License

DevSpace is licensed under the [GNU Affero General Public License, version 3](LICENSE)
(`AGPL-3.0-only`).
