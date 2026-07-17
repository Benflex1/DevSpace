# Current State

## Current milestone

Milestone 1 — in progress.

## Implemented product path

- Browser project onboarding in the Next.js Web application.
- Web-owned SQLite runtime access, committed migrations, project persistence, and audit events.
- Private Agent HTTP/1.1 transport over a Unix socket, including health and remote Git source inspection.
- Contract-validated Web-to-Agent requests and responses.
- Cloudflare Access JWT validation in production, with an explicit local development auth mode.
- Persisted projects are shown as `Registered — workspace setup pending` and remain in the
  `registering` state until primary-workspace setup completes.
- Onboarding currently accepts HTTPS Git repository URLs without query parameters; SSH identities
  and repository credential storage are not implemented.
- A registered repository-backed project can activate an immutable Project Options v1 revision
  from the browser and be finalized with a persisted primary workspace.
- The Agent durably accepts setup mutations before asynchronous execution, resumes nonterminal
  journal entries after restart, fences confirmed detached Git executions with durable Linux
  process identities across abrupt restart, and exposes truthful boot-scoped F10 snapshots/events.
  A crash after durable launch commitment but before process identity confirmation fails closed
  for administrator reconciliation instead of relaunching ambiguously.
- Agent-private, runtime-validated ownership records bind managed stores and worktrees to their
  derived paths, device/inode identities, project/workspace identities, source/Git identity, and
  configuration revision. Configured roots must be administrator-provisioned real directories;
  they are accepted without following symlinks and identity-pinned before internal child creation.
  Recovery records are semantically bound to exact operation-derived paths. Existing unowned paths
  are rejected rather than adopted, and Git worktree administration is removed only with an exact
  durable administration identity.
- The Agent creates the managed bare Git store, fetches the remote with hooks and submodules
  disabled, creates the primary Git worktree at the fetched branch head, and revalidates both
  resources before mutation or authoritative inspection.
- Ready workspaces are persisted and displayed as stopped with an absent runtime stack; this slice
  intentionally creates no development container.
- Permanent Playwright coverage drives the browser, Web orchestration, SQLite, Agent journal,
  loopback HTTPS Git fetch, real store/worktree creation, and Web+Agent restart without public
  internet access.

## Still absent

- Docker/runtime stacks;
- tasks, processes, terminals, previews, and AI sessions.

The managed primary workspace slice ends with the workspace stopped and ready for a later runtime
slice; no container, task, terminal, preview, or AI-session behavior is implied yet.
