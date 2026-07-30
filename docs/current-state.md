# Current State

## Current milestone

Milestone 1 — complete.

The TypeScript 7 acceleration slice is complete. All DevSpace CLI typecheck and build paths now
resolve `tsc` to native TypeScript 7.0.2; the named `typescript` dependency is a deliberately
narrow alias to `@typescript/typescript6` for `tooling/check-workspace-graph.mjs` and
`typescript-eslint`, exposing `tsc6` 6.0.3. The removed `baseUrl` was replaced with semantically
equivalent explicit relative path aliases, and WebSocket terminal frames now copy into owned
`ArrayBuffer` payloads for TypeScript 7's stricter DOM typing. On the development server, warm
`pnpm typecheck` fell from 56.78/46.38/46.33 seconds (TypeScript 5.9.3) to
18.19/18.56/18.41 seconds (TypeScript 7.0.2); default native parallelism was retained rather than
pinning checker/builder counts. No product or runtime authority boundary changed.

AI Session Foundation Slice 0 established the accepted post-M1 architecture and executable
contracts. Checkpoint 1 of AI Session Beta Slice B is complete after dedicated authority onboarding,
private Probe A and Probe B, and the real browser validation recorded below. One Agent-owned persistent Codex 0.145.0
authority is derived from the configured state root: production defaults to
`/srv/devspace/state/codex-auth/codex/auth.json`. It contains only the validated pinned ChatGPT
authority, never the user's normal Codex home or a general-purpose Codex home. A global atomic
`.lease` directory serializes all beta Codex providers; a stale lease is unavailable until an
operator verifies that no provider remains and removes that exact lease directory. The
`reauth-required` marker preserves the last-known-good authority while making inspection
unavailable.

After lease acquisition, the Agent validates the complete authority through a no-follow descriptor,
uploads the pinned executable and complete `auth.json` into an exact-container ephemeral
`CODEX_HOME`, and starts app-server with the existing fixed `never` / `danger-full-access` and
external-sandbox network policy. Every executable, credential-upload, readback, and staging-cleanup
exec requires bounded stream closure plus `Running === false` and `ExitCode === 0`; provider exit
requires an independent bounded inspection proof. On finalization it performs two stable bounded
Docker reads through an Agent-built, integrity-bound no-follow helper. Each read proves regular-file
type, mode `0600`, exact helper execution UID, `nlink === 1`, device, inode, and bounded size before
and after reading through one descriptor; private length framing carries the proof and bytes without
delimiters. Synchronization requires two complete equal proofs before complete validation and atomic
same-directory fsync-and-rename writeback. Lease release tracks the owned release path explicitly and
is retryable after a partial rename/removal, with both paths proven absent before success. Failed turns
and Unauthorized failures automatically enter this path.
Unproven cleanup keeps the lease and suppresses `session.stopped`; a later bounded Stop retries the
remaining safe stages. Container root can read the staged credential during the provider lifetime;
the repository is trusted owner-controlled code, and hostile descendant containment is not claimed
in this beta. Credentials never enter Project Options, SQLite, canonical events, public errors,
diagnostics, logs, Docker labels, arguments, or browser data.

The native Codex stdio JSONL boundary is strict and bounded: Docker multiplex headers and
payloads, retained partial frames, retained JSONL lines, complete native messages, and queued
notifications have explicit private limits derived from the existing AI content bounds. Stdout is
decoded with a fatal streaming UTF-8 decoder; stderr remains private. Malformed framing, invalid
UTF-8, invalid JSON or message shapes, NULs, truncation, and bound exhaustion are contained as one
private protocol failure with safe `AI_PROVIDER_PROTOCOL_FAILURE` classification. Provider-native
notifications are serialized in receive order, and native terminal processing is claimed once;
identical same-turn duplicates are ignored while conflicting or late terminal/output/activity
notifications fail closed without projection. Native thread and turn IDs remain Agent-private.

Final-review Round B makes canonical `turn.accepted` the sole turn-admission authority. Agent
validates managed execution context and baseline before reserving and appending acceptance, while
Stop serializes across the admission owner and partial accepted/started outbox faults resolve
according to what became durable. Web no longer inserts a turn before the Agent call; canonical
events and the post-receipt exact SQLite ensure converge stream-first or POST-first without a
Web-only accepted row. The Web Agent event reader now uses a fixed byte-bounded NDJSON frame buffer,
fatal UTF-8 decoding, strict frame validation, and rejects malformed or partial EOF framing.

The Workbench AI tab still supports the implemented fake-provider workflow, while approvals and
structured questions remain explicitly in progress for Checkpoint 2. The fake-provider suite was not
used as live-validation evidence. The real browser run used an isolated branch-local Web/Agent pair
with `DEVSPACE_AI_PROVIDER_MODE=codex`, the dedicated rootless DevSpace Docker socket, and the
dedicated persistent authority; the private GitHub source was represented by an exact-HEAD local
HTTPS mirror because the Agent's credentialless Git boundary cannot inspect the private remote.

Stopped-session recovery is now implemented on the final-review branch and awaits independent
verification. The browser retains the exact stopped session and bounded history, removes prompt,
Interrupt, and Stop controls, and offers one fenced `Start Codex again` action for that session ID.
Web re-inspects the exact profile and unchanged configuration/runtime identity, compare-and-sets the
same SQLite row to `creating`, and rolls back only an unchanged claim if Agent acceptance fails.
Agent reuses the same durable outbox and event sequence but creates a new provider process with the
next safe process generation, derived either from the finalized in-memory record or the exact
terminal retained outbox. SQLite advances its stored generation only on canonical
`session.started`. Each successful generation repeats credential staging, provider-exit proof,
staging removal, synchronization, and lease release. This is not provider-native resume, does not
recover `lost` sessions across runtime identity changes, and received no new real-provider or browser
validation in this correction round.

### AI Session Beta Slice B — Checkpoint 1 evidence (2026-07-29)

- ✅ Probe A and Probe B had already passed, including provider exit, staged credential
  synchronization, staging removal, lease release, and post-stop authority availability.
- ✅ Real browser validation passed with project `019fadd5-be82-753b-a0f5-661b71e56cd6`, workspace
  `019fadd6-17b9-728e-bf3c-8ebf501e8265`, revision `019fadd6-17b7-7056-aba0-46cad86961ae`,
  runtime generation `g1`, container
  `c462a5bb2354063074420f5ff5af243d11baf5626577641dc16c7d272f3479ee`, and a clean initial
  managed worktree at the expected branch head.
- ✅ The browser showed Codex available, created exactly one session, streamed the exact file-
  changing turn, presented the exact untracked changed-file payload, refreshed and replayed without
  duplicate event identities, completed the exact read-only turn with an empty changed-files result,
  and interrupted the third read-only turn truthfully.
- ✅ Browser Stop produced one user-request stopping/stopped pair. Provider exit, synchronization,
  exact staging removal, lease release, finalization, and authority availability were verified;
  normal workspace Stop then exited the dedicated container with code `0`.
- ✅ Credential material was absent from browser artifacts, SQLite, canonical events, public errors,
  Docker command/label/env surfaces, Git changes, and the draft PR text. Baseline Codex process
  names and baseline running containers remained unaffected.
- ✅ Checkpoint 1 is complete. Checkpoint 2 remains approvals and structured questions.

### Agent outbox and acknowledgement correction (2026-07-29)

The Agent-private canonical-event outbox now uses a strict owner-only
`devspace.ai-outbox-state/v1` manifest beside the session JSONL. Exact project/workspace/session
acknowledgements persist the greatest `(throughSequence, throughEventId)` atomically; append,
acknowledgement, compaction, replay-boundary checks, and live handoff share one recoverable
per-session chain. Retention keeps the newest 512 acknowledged events and every unacknowledged
event within the 2,048-event bound, with a fixed terminal-lifecycle reserve and `AI_EVENT_GAP`
before replay can begin past a compacted prefix.

This corrects only the Agent outbox and acknowledgement portion of P1-3. The separate Web
session-binding and SQLite aggregate-history correction is now implemented on this branch: exact
caller-supplied session identity is required for session-scoped operations, and bounded Web/SQLite
history uses explicit replay/truncation metadata. Browser stream continuation reconnects from the
last applied sequence after bounded clean responses, and browser-visible output/history truncation
is explicit. The 8 MiB Web AI response limit covers the complete HTTP envelope, not only the selected
session. Snapshot loads are generation-bound and abort obsolete work without allowing stale success,
error, or cleanup callbacks to mutate the selected session. Stream duplicate identity is exact: only
the known event ID at the current sequence can be ignored; conflicts and gaps fail closed. This does
not claim the entire final review is complete; Checkpoint 2 and the other deferred concerns below
remain out of scope.

### Codex authority onboarding and recovery

The deployment owner must authenticate the dedicated authority with the pinned executable using the
literal command supplied in the implementation handoff. The command must run as the Agent OS user,
with `OPENAI_API_KEY`, organization, and project environment variables removed. It must not read or
print `auth.json`; it fixes directory/file modes and removes `reauth-required` only after successful
`codex login status`. If a stale `.lease` exists, first verify that no provider process remains,
then remove only that exact `.lease` directory before login. This is operational device-code login,
not browser/F11/app-server login orchestration.

Milestone 1 is closed after PR #38. The verified M1 path covers browser onboarding and Web-owned
SQLite persistence, private contract-validated Web-to-Agent transport, managed repository and
primary-workspace creation, immutable Project Options v1, deterministic runtime-plan compilation,
rootless Docker lifecycle, browser terminal and lost-session handling, structured foreground tasks,
workspace-target previews, the private Preview Gateway, the current Coolify Traefik/Cloudflare
Access production path, real HTTP and WebSocket/HMR validation, bounded restart/reconciliation
recovery, and correlated safe diagnostics. CI and Semgrep passed on the final PR #38 head before
merge, and the complete test suite passed with 1,825 tests before merge.

The focused M1 Slice 6 diagnostics checkpoint is implemented: Web and Agent share allowlisted
machine-readable JSON logging, a closed safe failure classification, and incident IDs that connect
unexpected Workbench errors to the corresponding structured service logs. Validated Agent incident
IDs are preserved end-to-end; Web creates a UUIDv7 only at the user-facing boundary for qualifying
transport, protocol, dependency, or internal failures without an existing incident. Expected
validation and lifecycle conflicts remain specific and do not receive references. Logs are emitted
to service stderr/stdout only; persistent retention, a diagnostics UI, log search, and external
tracing remain future work. A separate Semgrep Community Edition static-analysis workflow now scans pull requests,
pushes to `main`, and manual runs in monitoring mode, retaining the complete JSON report as the
`semgrep-results` artifact for AI-assisted review without uploading source or findings to Semgrep.
The Semgrep foundation and first contextual triage remain complete. Local preview lifecycle
validation is complete, including Vite readiness, stop/restart, runtime stop/start, fail-closed
route removal, stable hostname restoration, Agent restart reconciliation, and HMR. Terminal
lost-session retirement and warning UX are complete for M1. The production Preview Gateway path is
now deployed and manually validated. The bounded Slice 6 scope is complete; the capabilities below
are post-M1 work and do not block this milestone closure.

Normal Coolify Compose mode is invalid for the Preview Gateway because it rewrites the external
volume service mounts. Raw Compose Deployment preserves the two administrator-created external
bind volumes and now runs Caddy, `preview-gateway-host`, and `preview-ingress-connector`
successfully with all four private sockets and the expected fallback HTTP 404. Production
inspection then showed that the connector's generated private default network and Coolify
Traefik's stable resource network were disjoint. A temporary connector-only attachment with alias
`devspace-preview-ingress` proved the complete network-to-Caddy fallback path and was removed.
The initial repository adapter used Compose `include` and passed CI only because all sibling files
were present in the checkout. Coolify materialized the selected file alone as `docker-compose.yaml`;
Docker Compose then failed while looking for the missing sibling `compose.yaml`. The failed
deployment did not stop or replace the healthy generic gateway.

The corrected repository adapter is a committed, self-contained artifact generated deterministically
from the generic contract plus the connector-only external network. It is deployed through Coolify
Raw Compose with Base Directory `/deploy/preview-gateway`, Compose Location `/compose.coolify.yaml`,
Raw Compose Deployment enabled, and an explicit `DEVSPACE_COOLIFY_PROXY_NETWORK`. The connector is
durably attached to the selected Coolify Traefik network with alias `devspace-preview-ingress`.
The two exact administrator-created external bind volumes are preserved; Caddy and
`preview-gateway-host` remain on host networking; and all four private gateway sockets exist with
the intended ownership and mode. The durable proxy-network → connector → Unix socket → Caddy
fallback path returns 404.

Coolify Traefik remains the outer ingress. Its permanent router matches only the reserved
one-label namespace ending in `-preview.benflex.dev`. Cloudflare Tunnel routes `*.benflex.dev` to
`https://localhost:443` with origin server name `benflex.dev` and TLS verification enabled.
Cloudflare Access protects the preview namespace with an owner-only allow policy: unauthenticated
requests receive an Access 302, while authenticated requests reach the preview gateway. A real
workspace preview has been validated through the complete production path, including HTTP,
WebSocket/HMR, Waiting → Ready, application stop/restart, runtime stop/start, stable hostname
restoration, route removal, and Agent restart reconciliation.

Embedded previews work with Access SameSite cookie attribute `None` and `allow_iframe: true`. The
Cloudflare login page cannot be displayed inside the iframe; an absent or expired Access session
must be authenticated in a top-level tab first. Firefox may also require Enhanced Tracking
Protection to be disabled specifically for the DevSpace Web site so the Access authorization cookie
is available to the cross-origin iframe.

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
- The generic gateway Compose contract remains provider-neutral and uses stable logical service
  mount IDs backed by exact administrator-precreated external volume names. The Coolify-specific
  artifact is generated from that source of truth, contains the full service and volume model,
  requires `DEVSPACE_COOLIFY_PROXY_NETWORK`, and adds only the connector attachment with alias
  `devspace-preview-ingress` plus its top-level external network. Drift and arbitrary-directory
  single-file materialization are repository-validated; the corrected adapter is deployed and the
  production network path has been manually validated through the Coolify Traefik outer ingress.
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
- The gateway Compose contract uses fixed external names for the current generic single-gateway
  deployment. `DEVSPACE_GATEWAY_HOST_DIR` remains an administrator-provisioning value, and the
  current home-server target maps those external volumes to `/srv/devspace/gateway` and its
  `ingress` child with UID/GID `1000`. Those host paths, identities, and the Coolify, Traefik,
  Cloudflare, and `benflex.dev` choices are not universal DevSpace core requirements.

## Still absent

AI Session Foundation Slice 1A has a committed, explicitly opt-in supervisor capability harness,
but its corrected hands-on verdict is **blocked**. The proof demonstrates authenticated reconnect
after the original exec attachment is gone and stable `/proc` process-start identity. It also
demonstrates that process-group signalling works for a cooperative fixture but is not a race-safe
production Stop authority: the dedicated rootless environment exposes no writable delegated
cgroup or equivalent atomic descendant-tree boundary. The owner-only beta provider lifecycle is
implemented through the exact managed workspace container and dedicated authority above, but it
does not claim hostile-descendant containment. Checkpoint 2 approvals, structured questions, and
broader multi-provider support remain absent. The opt-in executable now conditions this blocked
supervisor result on the reviewed cgroup probe tuple; a stronger or malformed future environment
yields an explicit review-required or probe-failed result instead of replaying the static blocker
matrix.

Supporting services, Dockerfile/preset builds, setup steps, named-volume mounting, secret/host or
generated task-environment binding resolution, task output streaming, full Project Options revision
editing, and rebuild remain intentionally unimplemented. Preview service-target
execution, automatic long-running dev-task startup, multiple parallel workspaces, preview
sharing/public controls, and the general logging overhaul remain deferred. Preview sharing and
public controls are not implied by the canonical hostname; the current path is an authenticated
owner workflow only.
Individual task termination and exact descendant ownership, task Stop, forceful terminal Close,
long-running task supervision, runtime timeout enforcement, `replace` concurrency, and configured
interactive tasks are deferred execution-supervision work for M2. M1's `foreground one-shot`
description does not imply runtime timeout enforcement.

## M1 Slice 6 closure and post-M1 work

- Stable failure classification now distinguishes `user-error`, `state-conflict`,
  `dependency-unavailable`, `transport-failure`, `protocol-failure`, and `internal-failure`.
  The Web Agent client may retain endpoint-schema-validated Agent messages as server-private text,
  but browser and persisted error text comes only from an exhaustive Web-owned failure-code map;
  arbitrary Agent messages and details are never projected or logged.
- Unexpected Workbench runtime, task, terminal, preview, and applicable setup failures now pass
  through one server-side normalization boundary. Agent UUIDv7 incidents are preserved exactly;
  otherwise Web mints one UUIDv7 at that boundary, emits one correlated terminal Web error record,
  and returns the same restrained, copyable `Reference ID` to the existing error treatment.
- Expected input, configuration, authorization, lifecycle-conflict, Waiting, Ready, Inactive, and
  Unavailable presentations retain their existing semantics and do not gain incident references.
  This checkpoint adds no database migration, persistent logging, public diagnostics endpoint,
  diagnostics dashboard, or broader health-detail projection.
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
  genuinely free for this private repository. None of these tools is adopted; evaluation remains
  post-M1 maintenance.

The following are explicitly deferred post-M1, not M1 blockers:

- Authentication: provider-neutral OIDC or another standards-based production mode. The current
  owner-only Cloudflare Access JWT mode remains the validated production authentication for this
  installation; generic production authentication is not implemented.
- Operational diagnostics UX: persistent rotated service logs, search/filter diagnostics UI,
  per-operation timelines, public health subsystem details, log export and retention controls, and
  a dedicated Diagnostics view.
- Broader lifecycle hardening: creation-record recovery beyond the implemented exact-operation,
  ownership, restart, and narrow device-remount recovery; additional stale-state cleanup; broader
  degraded-subsystem reporting; additional restart/reconciliation regression coverage; automatic
  short Unix-socket selection for local development; and removal of the manual local
  `/run/user/.../devspace` socket workaround.
- Static-analysis and toolchain maintenance: further Semgrep ruleset tuning before selected
  findings become blocking, evaluation of additional optional free analysis tools, pnpm
  dependency-policy compatibility work, and TypeScript 7 evaluation, migration, compatibility
  checks, and benchmarking.

DevSpace is not feature-complete or generally production-ready for arbitrary multi-user
deployments. Multiple workspaces, AI sessions, rebuild, long-running task supervision, task Stop,
forceful terminal Close, service-target previews, and public preview sharing remain absent or
deferred. Coolify, Traefik, Cloudflare, `benflex.dev`, UID/GID `1000`, and `/srv/devspace` are
deployment-specific choices; Coolify Traefik remains the outer ingress and Caddy is not the public
entrypoint.
