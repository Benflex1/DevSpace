# Current State

## Current milestone

Milestone 1 — in progress.

The first focused M1 Slice 6 diagnostics foundation is implemented: Web and Agent share
allowlisted machine-readable JSON logging with request/operation/resource correlation, bounded
preview reconciliation lifecycle timing, and an internal Agent health breakdown. Logs are emitted
to service stderr/stdout only; persistent retention, a diagnostics UI, and external tracing remain
future work. A separate Semgrep Community Edition static-analysis workflow now scans pull requests,
pushes to `main`, and manual runs in monitoring mode, retaining the complete JSON report as the
`semgrep-results` artifact for AI-assisted review without uploading source or findings to Semgrep.
The Semgrep foundation and first contextual triage remain complete. Local preview lifecycle
validation is complete, including Vite readiness, stop/restart, runtime stop/start, fail-closed
route removal, stable hostname restoration, Agent restart reconciliation, and HMR. Terminal
lost-session retirement and warning UX are complete for M1. Production preview deployment remains
the principal M1 blocker.

After PR #33 was merged, production deployment was attempted. Coolify rejected the variable
interpolation in service-level volume sources during its pre-Compose security validation, before
container replacement. The existing production deployment was not intentionally modified by this
repository task. The repository-side named-bind compatibility correction is now the active blocker.

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
  derived paths, live device/inode identities, project/workspace identities, source/Git identity,
  and configuration revision. Finalized ownership can narrowly rebind a device-only remount
  change only after the complete path, inode, and Git ownership proof succeeds; live mutation
  checks remain strict. Configured roots must be administrator-provisioned real directories;
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
- M1 Slice 5 Preview Path is implemented for workspace-target previews. Web materializes the exact
  canonical hostname from the immutable Project Options revision, approved preview-base registry,
  and project/workspace slugs, persists it in SQLite, and sends only that persisted identity to the
  Agent. Workspace creation records the Web-owned project/workspace slugs in Agent-private
  ownership; activation requires an exact Agent-owned slug match as well as the project, workspace,
  revision, preview, and generation identities.
- Preview runtime exposure is loopback-only: Agent-derived Docker bindings use `127.0.0.1`, with no
  public Docker publication, `PublishAllPorts`, host networking, Docker socket, or arbitrary host
  mount. A retained stopped container keeps its exact lease reservation; route removal is separate
  from lease release, and a lease becomes reusable only after exact ownership is released.
- The dedicated private Caddy adapter owns the exact route set. Caddy receives no Docker socket or
  public admin endpoint, accepts only Agent-owned approved hostnames and exact
  project/workspace/preview/revision/generation/lease identity, and forwards HTTP/WebSocket traffic
  only to the resolved loopback lease. Foreign, stale, missing-runtime, and stale-generation routes
  are not adopted and are removed during reconciliation.
- The preview gateway deployment runs the pinned Caddy image with the checked-in native JSON
  configuration, exposes only its private Admin and HTTP data-plane Unix sockets, and replaces the complete managed
  route array with Caddy Admin PATCH while retaining the terminal fallback. A Docker-backed real
  Caddy smoke command covers startup, socket availability, GET, PATCH replacement, and fallback
  restoration in CI.
- Health probing is namespace-safe. When Agent and gateway share a host namespace, the gateway-host
  probe uses the host-local implementation. When Agent is containerized, `DEVSPACE_PREVIEW_PROBE_SOCKET`
  is required alongside the private Caddy socket and approved-base registry; the Agent sends only an
  opaque lease ID and bounded health policy over that private Unix socket and never falls back to
  Agent-local loopback when the socket is configured but unavailable. Probe timeouts and retries are
  bounded.
- Checkpoint 1 of the private deployment bridge adds the optional Agent-owned
  `DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET` and the `@devspace/preview-gateway-host` runtime. The
  resolver accepts only a closed lease-ID request and returns only the exact loopback lease shape;
  the host runtime composes that transport with `GatewayHostProbeServer` over temporary/private Unix
  sockets without Docker access or a public listener.
- Checkpoint 2 completes the repository-side deployment path. The dedicated Caddy JSON configuration
  listens on `127.0.0.1:18080` plus the private HTTP data-plane socket, exposes Admin only through
  the private Unix socket, and keeps a gateway-owned terminal HTTP 404 fallback after exact
  Agent-managed routes. The generic Compose stack runs pinned Caddy, the host probe, and an isolated
  byte-transparent connector with no Docker socket or public Docker ports. Coolify/Traefik setup is
  optional and documented in `docs/integrations/coolify-traefik-preview-ingress.md`.
- The repository-side Coolify compatibility correction is complete in this proposed change: service
  mounts use stable named volume IDs, while top-level local-driver devices retain the configurable
  administrator-owned host paths. Production deployment remains pending.
- Preview lifecycle truth is represented by the materialized hostname plus independent route state:
  `Waiting` means the configured preview is known but not route-ready (including before the app
  listens), `Ready` means an accepted health response and exact route are present, `Inactive` means
  the preview is intentionally stopped, and `Unavailable` means runtime, gateway, ownership, or
  unsupported-policy failure. The Workbench provides a first-class Preview section, deduplicated
  `preview:<previewId>` tabs, readiness-gated iframe, canonical-host Open Externally, bounded Reload,
  and visibility-aware refresh while a preview changes. It does not rewrite application CSP or
  `X-Frame-Options` headers.
- Preview operations retain Web/Agent operation, revision, generation, and route identity fencing.
  Agent restart reconciles only provable exact routes; gateway restart removes the managed route set
  and Web/Agent reconciliation reconstructs a route only after exact runtime ownership and health
  are proven. Runtime loss and failed route cleanup remain conservatively represented until removal
  succeeds, so Web cannot claim a reachable route is gone. The permanent Playwright E2E proves the
  browser → deterministic hostname → gateway → exact simulated container path for HTTP and
  WebSocket/HMR, rejects unrelated container ownership, exercises Agent/gateway restart, and proves
  stop removes route eligibility while retaining the loopback lease.
- Shared preview ingress is implemented with an administrator-owned `labelSuffix` registry entry,
  exact one-label namespace ownership, Caddy's loopback listener plus private
  `ingress/preview-http.sock`, and a byte-transparent isolated connector. Coolify/Traefik and other
  outer-ingress APIs remain optional deployment concerns documented outside core runtime.
- The gateway Compose host runtime root is configurable through the deployment-level
  `DEVSPACE_GATEWAY_HOST_DIR` variable. The current validated home-server target uses
  `/srv/devspace/gateway`, UID/GID `1000`, Coolify, Traefik, Cloudflare, and `benflex.dev`.
  These deployment-specific values are not universal DevSpace core requirements.

## Still absent

Supporting services, Dockerfile/preset builds, setup steps, named-volume mounting, secret/host or
generated task-environment binding resolution, task output streaming, full Project Options revision
editing, rebuild, and AI sessions remain intentionally unimplemented. Preview service-target
execution, automatic long-running dev-task startup, multiple parallel workspaces, preview
sharing/public controls, and the general logging overhaul remain deferred. Preview sharing and
public controls are not implied by the canonical hostname; the current path is an authenticated
owner workflow only.
Individual task termination and exact descendant ownership, task Stop, forceful terminal Close,
long-running task supervision, runtime timeout enforcement, `replace` concurrency, and configured
interactive tasks are deferred execution-supervision work for M2. M1's `foreground one-shot`
description does not imply runtime timeout enforcement.

## M1 Slice 6 hardening status

- Semgrep CE monitoring foundation is implemented in `.github/workflows/semgrep.yml` with the
  pinned official `semgrep/semgrep:1.171.0` image, curated `p/default` ruleset, JSON artifact,
  deterministic job summary, and repository-owned summary tests.
- The first local scan found two Semgrep CE parser errors in existing test-only type expressions;
  narrow type-only import rewrites preserve behavior and now allow all 316 tracked files to parse.
  The rerun has zero scanner errors. Existing findings remain documented for later contextual
  review; the three new workflow action references and the three existing CI action references are
  now pinned to full SHAs.
- Findings are evidence for contextual AI and human review, not automatic truth. The current
  workflow does not fail for findings, but it does fail for scanner, report, and summary-generation
  failures. Blocking high-confidence security or correctness findings can be considered after the
  ruleset is tuned and the initial finding history is reviewed.
- Additional free hardening options remain unevaluated: self-hosted SonarQube Community, CodeScene
  through eligible GitHub Student benefits, and any GitHub Student Pack security tooling that is
  genuinely free for this private repository. None of these tools is adopted.
