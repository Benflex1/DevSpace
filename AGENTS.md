# DevSpace Agent Instructions

## Development rules

- Respect accepted durable architecture and security boundaries.
- Consult the directly relevant specification when one exists. Do not require a new
  specification or ADR for ordinary reversible implementation work; update durable contracts
  only when behavior or architecture genuinely changes.
- Prefer vertical product slices after Milestone 0. A product slice should end in observable
  user value whenever product work is involved.
- Make reasonable reversible local decisions during implementation.
- Stop only for a genuine architectural, security, or destructive-operation blocker.
- The active task lives in the current prompt, not in a committed task-tracking document.
- Update `docs/current-state.md` at significant checkpoints, milestone boundaries, or when the
  next developer would otherwise receive materially incorrect information.
- For documentation conflicts, use the single authority order in `docs/README.md`.

## Beta delivery rule

- Prioritize complete browser-usable vertical slices for the owner-only beta; normally only P0
  blocks a slice: likely data loss, credential exposure, crossed project/workspace authority, a
  broken main workflow, or ordinary use becoming unrecoverable.
- Document and defer rare races, hostile-process behavior, generic deployment concerns, perfect
  recovery, and future multi-user hardening. Do not broaden work merely to make it theoretically
  complete.
- Before designing equivalent AI-session UI or workflows, inspect `pingdotgg/t3code`; MIT-licensed
  code may be copied or adapted with required attribution. Retain DevSpace's Web/Agent, workspace,
  persistence, Docker, filesystem, and process-authority boundaries.

## Architecture boundaries

- The browser talks only to the web application.
- The web application is the sole SQLite writer and never invokes Git, shell commands, Docker,
  or Caddy.
- The workspace agent is the only component allowed to manage the dedicated rootless Docker
  runtime. The host/Coolify Docker socket is prohibited.
- Project containers receive only their worktree and declared named volumes. Privileged
  containers, host networking, host PID mode, arbitrary host mounts, and production-directory
  access are prohibited.
- Every project has a primary workspace; additional workspaces are optional. Every workspace
  has an independent Git worktree and container stack.
- Project Options are UI-managed, stored as immutable database revisions, and never require YAML
  editing.
- Browser actions reference task, preview, service, or AI-profile IDs. They never provide
  executable commands or host paths.
- AI integrations begin as PTY-based CLIs inside the workspace container.
- Preview routing is delegated to Caddy through a narrow adapter.
- Never auto-merge or deploy production changes.

## Security model

Registered repositories are trusted owner-controlled code, not hostile code. Enforce the host
boundary, project/workspace separation, request validation, secret redaction, canonical paths and
hostnames, and least-privilege runtime design.

## Code organization

- `apps/web`: UI, browser API, authentication, orchestration, and database ownership.
- `apps/agent`: filesystem, Git, rootless Docker, PTY, process, and gateway operations.
- `packages/contracts`: versioned web/agent request, response, and event schemas.
- `packages/domain`: state machines and domain invariants.
- `packages/database`: schema and migrations; no runtime operations.
- `packages/project-options`: Project Options schemas and runtime-plan compilation.
- `packages/security`: canonical path, hostname, redaction, and policy helpers.
- `packages/gateway-caddy`: narrow Caddy adapter.

Avoid generic `shared` or `utils` packages. Put logic with the domain that owns it.

## Review policy

- Codex self-review and tests are always required.
- Independent review is selective. Require it primarily for authentication/authorization,
  container/host isolation, destructive or complex migrations, security boundaries, major
  architecture changes, and unusually risky cross-system behavior.
- Normal features and straightforward schema/code work do not automatically require an
  implement-review-correction-re-review cycle.

## Model policy

- Commits, renames, and tiny changes: Luna Medium/High.
- Normal scoped implementation: Luna XHigh.
- Unclear repository exploration: Terra Medium.
- Architecture, security, migrations, and complex boundaries: Sol Medium.
- A failed focused Terra/Sol attempt: Sol High/Max.
- Sol Ultra: never.

## Chat rotation

- Use the same Codex chat for one implementation and its immediate fixes.
- Use a fresh chat for a genuinely new subsystem, stale context, or independent review.
- Do not rotate merely because a fixed prompt count was reached.

## Git and checks

- Use branch names matching the eventual scope, such as `feat/...`, `fix/...`, or `refactor/...`.
- Make intentional commits. Never merge automatically, deploy production automatically, or use
  destructive Git operations without explicit user intent.
- A clean clone must keep this verification contract passing:

  ```bash
  pnpm install --frozen-lockfile
  pnpm workspace:check
  pnpm lint
  pnpm test
  pnpm typecheck
  pnpm build
  pnpm contracts:check
  pnpm schema:check
  pnpm db:migrate:test
  pnpm db:check
  ```
