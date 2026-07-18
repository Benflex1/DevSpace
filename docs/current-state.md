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
- Runtime-plan v1 deterministically compiles the executable simple image configuration, uses a
  domain-separated JCS hash, is persisted beside the immutable Project Options revision, and is
  independently recompiled and verified by the Agent through a separate journaled registration.
- Ready primary workspaces show the real dedicated rootless Docker availability and can be started
  and stopped from the browser. Web persists desired state and an operation before each Agent
  mutation, reconciles accepted/running/terminal Agent journal observations after timeout or Web
  restart, and then stores authoritative workspace, runtime-stack, and development-service
  observations in SQLite. Start retry requires the exact failed Agent operation plus a live
  recoverable inspection, and the same derived actionability gates both browser controls and the
  server mutation path.
- The Agent talks directly to a configured rootless Docker Engine Unix socket, creates one isolated
  workspace network and one development container, applies administrator-bounded CPU, memory, and
  PID limits, and publishes no host ports or Docker socket. Before the first Docker side effect, an
  operation-bound Agent-private creation record is durably reserved; exact network and container
  IDs advance through explicit phases before authoritative ownership is committed. Retries and
  Agent restart recover only exact IDs or operation-labeled partial resources and never adopt by
  name alone. Agent-private ownership binds exact Docker IDs, opaque derived names, labels,
  revision, plan hash, generation, effective resource policy, and worktree mount.
- Ordinary stop retains the container, network, worktree, and generation. Agent restart reinspects
  exact retained Docker IDs, attached networks, limits, namespaces, capabilities, security options,
  mounts, devices, and port settings. Missing, replaced, colliding, drifted, or mismatched resources
  fail closed. Start succeeds only after bounded repeated exact inspection proves the container has
  remained continuously running for the configured stabilization window.
- Permanent Playwright coverage drives the browser, Web orchestration, SQLite, Agent journal,
  loopback HTTPS Git fetch, real store/worktree creation, the production Docker Engine API adapter
  against a stateful Unix-socket fixture, start/stop, and Web+Agent restart without public internet.

## Still absent

- tasks, processes, terminals, previews, and AI sessions.

Supporting services, Dockerfile/preset builds, setup steps, named-volume mounting, secrets,
rebuild, tasks, terminals, previews, and AI sessions remain intentionally unimplemented.
