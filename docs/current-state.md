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
- The dashboard is a lightweight project overview with Agent status, summary cards, and Add
  Project. Registering projects retain the setup flow; ready projects at `/projects/[projectId]`
  now render the full-height Project Workbench with a compact context bar, project sidebar,
  application tab strip, shared central surface, and status bar. The Workbench performs exact
  server-owned project lookup and returns normal not-found behavior for unknown IDs.
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
- A running primary workspace exposes a same-origin interactive browser terminal backed by an Agent-owned
  Docker exec PTY at `/workspace`. Web authenticates the HTTP upgrade, validates the configured
  application origin, authorizes the exact project/workspace/terminal tuple, and relays only the
  accepted bounded binary protocol to the private Agent Unix socket. The supported terminal path is
  `create → attach → input/output → resize → detach → reconnect`, with one-attachment ownership,
  bounded replay, and truthful `lost` state after an unrecoverable Agent restart. Detach is
  non-destructive; forceful terminal Close is intentionally unavailable and fails closed. A workspace
  may own multiple independent live terminal sessions, each with its own server identity, Agent exec,
  and one-attachment limit. Workbench terminal panels remain mounted while their tabs are open and
  inactive panels are hidden so switching tabs preserves xterm state and the browser attachment.
- Initial primary-workspace setup can materialize simple structured tasks in the immutable Project
  Options revision without JSON or YAML editing. Ready workspaces list that exact revision's tasks,
  start supported tasks by key inside the exact development container, reconcile process/task state
  and exit code, and map configured success exit codes to passed/failed. Direct executable/argument
  execution, confined working directories, literal environment overlay, and `reject`/`allow`
  concurrency are supported. The supported task path is selecting a configured structured
  foreground one-shot task, running its exact Docker exec, and observing lifecycle, exit code, and
  configured success/failure mapping. M1 accepts exactly `interactive: false`, `longRunning: false`,
  `timeoutSeconds: null`, and `concurrencyPolicy: "reject" | "allow"`. A task completes when its
  exact Docker exec completes; M1 does not claim ownership of intentionally daemonized descendants.
- Project Options v1 still structurally represents `interactive: true`, `longRunning: true`, non-null
  `timeoutSeconds`, and `concurrencyPolicy: "replace"`. M1 rejects those valid configuration
  concepts before Docker side effects with the typed runtime-policy violation. Task Stop and forceful
  terminal Close fail closed with contract-valid state conflicts; stopping the whole workspace
  runtime may still reclaim all container processes through the exact container lifecycle.
- Project task state refresh is targeted: the browser refreshes after task actions and polls only
  while observed task runs are `queued`, `starting`, or `running`; idle project pages and terminal
  sessions do not create a permanent task-endpoint polling loop. Terminal sizing remains driven by
  xterm.js FitAddon, stable visible layout measurements, ResizeObserver, viewport changes, and
  deduplicated PTY resize frames.
- Agent-private task-start evidence advances through durable `reserved`, `exec-created`, private
  `start-intent`/failure evidence, and `started` phases, bound to the exact accepted operation and
  request before Docker sees its first side effect. Exact replay classifies the retained exec using
  Docker's nullable exit evidence, never starts a retained exec twice, and preserves a later task
  exit separately from successful start. Terminal attachment finalization is idempotent and retains
  exclusivity through persistence, close, and cleanup races; an unrecoverable persistence failure
  becomes terminal `lost` without an immortal in-memory attachment owner.
- Permanent Playwright coverage drives the browser, Web orchestration, SQLite, Agent journal,
  loopback HTTPS Git fetch, real store/worktree creation, the production Docker Engine API adapter
  against a stateful Unix-socket fixture, start/stop, and Web+Agent restart without public internet.
- Preview hostname authority is Web-owned: Web materializes the exact hostname from the immutable
  Project Options revision, approved preview-base registry, and project/workspace slugs, persists it
  in SQLite, and sends that persisted value to the Agent. The Agent does not derive a competing
  identity from IDs; it validates the Web value against the exact revision, preview identity, slug
  composition, approved registry, and hostname policy before private-state or route use.
- Checkpoints 2 and 3 of the preview path are implemented in the Agent and gateway: exact immutable
  workspace-target validation, Agent-private loopback lease allocation, retained stopped-container
  lease ownership, strict `127.0.0.1` Docker bindings, exact revision/runtime-generation checks,
  bounded gateway-host health attempts, private Caddy route replacement, stale/foreign route removal,
  HTTP streaming, and WebSocket/HMR upgrade forwarding. The active gateway package has no Docker
  socket, no public admin endpoint, accepts only Agent-owned approved hostnames, and probes only
  opaque Agent-owned leases.
- Checkpoint 4 is implemented in Web: preview mutations are authorized and persisted by SQLite,
  Agent observations retain exact operation/revision fencing, and the Project Workbench has a
  first-class Previews section with deduplicated `preview:<previewId>` tabs, Waiting/Ready/
  Unavailable/Inactive presentation, readiness-gated iframe, exact-host external navigation,
  bounded reload/reconciliation, and visibility-aware refresh only while a preview changes.

## Still absent

Supporting services, Dockerfile/preset builds, setup steps, named-volume mounting, secret/host or
generated task-environment binding resolution, task output streaming, full Project Options revision
editing, rebuild, and AI sessions remain intentionally unimplemented. Permanent preview E2E,
restart/reconciliation hardening, independent review, and PR preparation remain deferred to
Checkpoint 5; no Checkpoint 5 work has begun.
Individual task termination and exact descendant ownership, task Stop, forceful terminal Close,
long-running task supervision, runtime timeout enforcement, `replace` concurrency, and configured
interactive tasks are deferred execution-supervision work for M2. M1's `foreground one-shot`
description does not imply runtime timeout enforcement.
