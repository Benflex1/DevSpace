# Web application

The Next.js App Router application owns browser APIs, Cloudflare Access authentication, CSRF
validation, SQLite runtime access, project persistence, audit events, and Agent orchestration.
It never runs Git or accesses Agent-managed workspace paths.

From the repository root, `pnpm dev` starts Web and Agent together with explicit local-development
authentication and state under `.devspace-local/`. `pnpm dev:web` starts Web alone against the same
local paths. Production uses `pnpm build` followed by `pnpm start:web` and must provide the settings
documented in `.env.example`, including `DEVSPACE_AUTH_MODE=cloudflare-access` and real Access
issuer/audience values.

The browser workflow is covered by `pnpm test:e2e`.

Onboarding currently accepts HTTPS Git repository URLs without query parameters. SSH identity and
credential management are intentionally outside this slice.
