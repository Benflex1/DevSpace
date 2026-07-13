# DevSpace Agent Instructions

## Current milestone

Milestone 0 only: architecture, contracts, schemas, documentation, test fixtures, and repository scaffolding.

Do not implement project discovery, Docker control, terminals, task execution, previews, Git mutation, or AI sessions until the relevant contracts and ADRs are accepted.

## Architecture invariants

- The browser talks only to the web application.
- The web application is the sole SQLite writer.
- The web application never invokes Git, shell commands, Docker, or Caddy.
- The workspace agent is the only component allowed to manage the dedicated rootless Docker runtime.
- The host/Coolify Docker socket is prohibited.
- Project containers receive only their worktree and declared named volumes.
- Privileged containers, host networking, host PID mode, arbitrary host mounts, and production-directory access are prohibited.
- Every project has a primary workspace; additional workspaces are optional.
- Every workspace has an independent Git worktree and container stack.
- Project Options are UI-managed, stored as immutable database revisions, and never require YAML editing.
- Browser actions reference task, preview, service, or AI-profile IDs. They never provide executable commands or host paths.
- AI integrations begin as PTY-based CLIs inside the workspace container.
- Preview routing is delegated to Caddy through a narrow adapter.
- Never auto-merge or deploy production changes.

## Security model

Registered repositories are trusted owner-controlled code, not hostile code. Nevertheless, enforce the host boundary, project/workspace separation, request validation, secret redaction, and least-privilege runtime design.

## Code organization

- `apps/web`: UI, browser API, authentication, orchestration, database ownership.
- `apps/agent`: filesystem, Git, rootless Docker, PTY, process, and gateway operations.
- `packages/contracts`: versioned web/agent request, response, and event schemas.
- `packages/domain`: state machines and domain invariants.
- `packages/database`: schema and migrations; no runtime operations.
- `packages/project-options`: Project Options schemas and runtime-plan compilation.
- `packages/security`: canonical path, hostname, redaction, and policy helpers.
- `packages/gateway-caddy`: narrow Caddy adapter.

Avoid generic `shared` or `utils` packages. Put logic with the domain that owns it.

## Required checks

A future implementation must keep these commands passing from a clean clone:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm typecheck
pnpm build
pnpm contracts:check
pnpm schema:check
pnpm db:migrate:test
```

## Branches and changes

Use branch names that match the eventual scope, such as `feat/...`, `fix/...`, or `refactor/...`. Do not use a documentation-only branch prefix if implementation will be added later.

Keep changes small and independently testable. Update `docs/current-state.md` after every meaningful slice.
