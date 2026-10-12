# DevSpace Roadmap

> Updated September 12, 2026.
>
> DevSpace is a self-hosted, browser-based, project-first AI development workspace where every project runs in its own isolated environment and brings code, terminals, tasks, previews, Git, and AI agents together in one persistent workbench.

## Status legend

- ✅ Complete
- 🟢 Working / validated
- 🟡 In progress
- ⏳ Planned
- 🧊 Deferred
- ❌ Not started

---

# Current delivery policy — high-quality beta acceleration

DevSpace is now optimizing for the fastest responsible path to a coherent, semi-finished beta of
the entire product.

The quality bar remains high, but completeness is judged by real owner-controlled workflows rather
than exhaustive production hardening.

## MVP/beta blocking policy

- **P0 — blocks the current slice:** the normal workflow does not work, likely data loss, credential
  exposure, cross-project/workspace authority failure, or an ordinary failure that leaves the product
  unusable.
- **P1 — fix when encountered or directly adjacent:** common workflow defects, confusing UX,
  recurring restart problems, and recoverable inconsistent state.
- **P2 — document and defer:** rare races, hostile-process behavior, unusual corruption, perfect
  recovery, generic deployment coverage, and future multi-user hardening.

Only P0 issues should normally block a beta slice. P1/P2 work may be included when small and directly
adjacent, but must not turn a vertical slice into an open-ended hardening project.

## AI Workbench reference policy

[`stablyai/orca`](https://github.com/stablyai/orca) is the primary product/UX reference for Workbench structure, agent-centric
workflow, files/editor/terminal/browser integration, activity presentation, approvals/questions,
changed-file/review flow, and visual behavior.

[`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) is a secondary technical/conceptual reference for isolated mechanics Orca does
not cover well. The inspected Checkpoint 2 revision and policy are recorded in
`docs/references/product-references.md`; no T3 source code was copied or substantially adapted.
If a future change does copy or substantially adapt T3 Code source, preserve the required MIT
notice and record the exact source files/revision there.

Strong reference targets include AI-session navigation, streaming turns, approvals, structured
questions, activity rendering, changed-file summaries, interruption/reconnect states, keyboard
interactions, and loading/empty/error states.

DevSpace must retain its own authority boundaries: Web remains the sole SQLite writer; Agent owns
Git, filesystem, Docker, PTYs, tasks, previews, and provider processes; providers run in the exact
Agent-managed workspace; and no host/Coolify Docker socket is exposed.

---

# Current overall status

## Current beta target

**Status: 🟡 Active**

The next product target is a coherent semi-finished beta, not another foundation-only milestone.

Milestones 0 and 1, TypeScript 7 acceleration, and PR #43 / AI Session Beta Checkpoint 1 are
complete and merged. PR #44 merged Private GitHub Checkpoint 1 at
`a74c183e5dc9cf3ed1bf9c9ac4513cb7cdcf126e`; its validated head was
`ea5fbbeeb17be0ec393097be1e5dd6374b9bb356`, and the accepted snapshots were proven
tree-equivalent. Real CP1 local/dev GitHub App acceptance is complete. CP2 real-provider acceptance
completed successfully with PR #45, and CP3A/CP3B are complete. The current objective is the
finished owner-controlled MVP, with Workbench 1B Changes + Commit merged by PR #49 at
`47bf2d8c70dcab7b2ff278eb241e927db02a6dd0` and AI Session Beta Checkpoint 2 implemented on its
feature branch. Production deployment remains explicitly pending. The remaining
path prioritizes:

1. real Codex/browser acceptance of the implemented approval and structured-question flow;
2. project creation from scratch;
3. essential task, Project Options, and Workbench UX;
4. focused stabilization and visual polish based on real use.

AI-session contracts and capability research are complete. Production-safe termination of arbitrary
hostile descendant processes remains deliberately unclaimed; the owner-only beta may use cooperative
process assumptions, best-effort interruption, degraded-session reporting, and workspace restart as
the fallback.

## Milestone 0 — Foundation

**Status: ✅ Complete**

Completed:

- ✅ Architecture and package boundaries
- ✅ Threat model and security boundaries
- ✅ Browser → Web → Agent Unix-socket trust boundary
- ✅ Web as sole SQLite writer
- ✅ Dedicated rootless Docker runtime boundary
- ✅ No host/Coolify Docker socket exposure to DevSpace workspaces
- ✅ Project Options v1 validation and runtime-plan foundation
- ✅ Database schema and migrations
- ✅ Agent operation journal and lifecycle primitives
- ✅ Managed repository/workspace ownership model
- ✅ Contract validation and clean-clone CI
- ✅ Node 24 / pnpm monorepo foundation

---

# Milestone 1 — Usable Primary Workspace

**Status: ✅ Complete**

## Definition of done

A user can:

1. open DevSpace in the browser;
2. register/import a trusted repository;
3. create its primary managed workspace;
4. start a real isolated development container;
5. use a browser terminal;
6. run configured project commands/tasks;
7. open the running project through a working preview URL;
8. stop/restart the workspace through the normal ownership-checked lifecycle;
9. recover cleanly enough from normal Agent/Web restarts for daily use.

The full core path works locally and the production preview path is validated. Milestone 1 is
closed after PR #38. Deferred authentication, operational UX, lifecycle hardening, static-analysis
tuning, and toolchain maintenance are post-M1 work.

## Slice 1 — Project onboarding

**Status: ✅ Complete**

- ✅ Trusted repositories can be registered/imported
- ✅ Projects persist in SQLite
- ✅ Web/API onboarding flow works
- ✅ Agent health/inspection integration works
- ✅ Project appears in DevSpace with persisted state

## Slice 2 — Managed primary workspace

**Status: ✅ Complete**

- ✅ Managed bare repository store
- ✅ Primary Git worktree
- ✅ Agent-private ownership records
- ✅ Persisted workspace state
- ✅ Exact project/workspace ownership validation
- ✅ Restart-safe managed workspace recovery foundations

## Slice 3 — Real workspace runtime

**Status: ✅ Complete**

- ✅ Project Options compile into a runtime plan
- ✅ Agent validates runtime policy
- ✅ Dedicated rootless Docker daemon is used
- ✅ Workspace runtime can start and stop
- ✅ Desired/observed runtime state persists
- ✅ Exact Agent-private runtime ownership is checked before mutation
- ✅ Docker ownership/labels remain independently fail-closed

Important lifecycle fixes completed:

- ✅ Docker 29 response compatibility fix
- ✅ Rootless runtime error classification fix
- ✅ Runtime Stop authorization no longer depends unnecessarily on the general Agent snapshot
- ✅ Finalized filesystem ownership can recover safely when `st_dev` changes across reboot/remount while paths/inodes and independent ownership proofs remain valid
- ✅ Strict live `{device, inode}` checks remain unchanged for TOCTOU-sensitive mutations

Deferred hardening:

- 🧊 Incomplete creation-record recovery across device renumbering remains fail-closed and should be handled later

## Slice 4 — Terminal and task path

**Status: ✅ Complete for M1**

- ✅ Browser terminal works
- ✅ Agent PTY connection works
- ✅ Terminal runs inside the workspace container
- ✅ Project commands can be executed
- ✅ Task/process tracking foundation exists
- ✅ Lost terminal sessions are detected after Agent restart
- ✅ Lost-terminal recovery dialog exists

Current limitation:

- 🧊 True terminal reattachment is not possible with the current Docker exec/PTTY model

Deferred beyond M1:

- 🧊 Persistent terminal/session ownership layer
- 🧊 Attach/detach semantics
- 🧊 Better long-lived terminal recovery for shells, Vite, Codex, and other processes

Completed terminal lifecycle and Workbench polish:

- ✅ Lost terminal rows automatically disappear from the sidebar after a short grace period
- ✅ Lost-terminal recovery action is **Restart workspace**
- ✅ Lost-terminal dialog button hierarchy keeps Dismiss secondary and Restart workspace prominent
- ✅ Two-step warning/confirmation dismissal flow
- ✅ Lost terminals retire on accepted workspace stop/restart and do not reappear after refresh,
  restart, or later Agent snapshots
- ✅ Workbench metadata order is branch, repository, runtime state, and runtime control

## Slice 5 — Preview path

**Status: 🟢 Production deployment and validation complete**

Working locally:

- ✅ Configured preview targets
- ✅ Preview activation
- ✅ Readiness detection
- ✅ `Waiting`, `Ready`, and `Unavailable` states
- ✅ Stable preview hostname
- ✅ Dedicated Caddy preview gateway
- ✅ Rootless-Docker loopback lease routing
- ✅ HTTP preview traffic
- ✅ WebSocket/HMR support
- ✅ Preview route removed when runtime stops
- ✅ Same hostname restored when runtime restarts
- ✅ Preview survives normal Web/Agent restart reconciliation
- ✅ Active preview liveness polling
- ✅ `ECONNREFUSED` correctly maps to `Waiting`
- ✅ Stale `Ready` state is cleared when authoritative inspection fails
- ✅ Preview setup fields are integrated into project setup

Preview topology:

```text
Browser
→ administrator-selected DNS/TLS/access layer
→ administrator-selected outer ingress
→ reserved preview namespace rule
→ preview-ingress-connector
→ dedicated Caddy preview gateway
→ Agent-managed loopback lease
→ exact workspace container port
```

Security and deployment support completed:

- ✅ No Docker socket in Caddy
- ✅ No arbitrary upstream routing
- ✅ Exact running workspace/runtime required
- ✅ Declared ports only
- ✅ Agent owns route validation and reconciliation
- ✅ Web remains sole database writer
- ✅ Dedicated preview-gateway Compose stack
- ✅ Caddy static configuration
- ✅ Preview gateway host service
- ✅ Private lease resolver
- ✅ Private gateway probe
- ✅ Deployment documentation
- ✅ Real Caddy CI smoke test
- ✅ Shared-ingress connector with reserved preview hostname namespace

Repository-side readiness:

- ✅ Shared-ingress connector and reserved `labelSuffix` hostname namespace
- ✅ Portable gateway Compose contract validated with administrator-precreated external volumes
- ✅ Checked-in Caddy configuration, deployment validation, and real-Caddy smoke coverage
- ✅ Local lifecycle coverage: Vite `Waiting → Ready`, Vite stop/restart, runtime stop/start,
  fail-closed route removal, stable hostname restoration, Agent restart reconciliation, and HMR
- ✅ Raw Compose Deployment preserves the exact external gateway bind volumes and runs all three
  services plus all four private sockets
- ✅ Corrected self-contained Coolify Raw Compose adapter generated deterministically from the
  generic contract, durably attached to the selected external proxy network, and validated at the
  arbitrary-directory selected-file boundary

Production deployment and validation completed:

- ✅ Provision the selected gateway host runtime root and its private `ingress` subdirectory
- ✅ Create and inspect the two exact external local-driver bind volumes
- ✅ Merge and deliberately deploy the corrected self-contained Coolify Raw Compose adapter
- ✅ Mount the shared gateway runtime directory into code-server/DevSpace
- ✅ Configure the production preview environment through Coolify Raw Compose with the explicit
  proxy-network setting and exact Base Directory/Compose Location
- ✅ Configure one permanent reserved-namespace rule in the selected outer ingress
- ✅ Verify real production preview traffic and HMR through the selected ingress

Current deployment target and production checklist:

- ✅ Provision the configured gateway host root and ingress subdirectory with the selected UID/GID and mode `0700`
- ✅ Deploy the gateway stack in Coolify Raw Compose and verify four Unix sockets plus `127.0.0.1:18080`
- ✅ Preserve the healthy generic gateway after the failed include-based adapter deployment
- ✅ Deploy the corrected self-contained connector-only external proxy-network adapter and verify
  its durable network attachment and alias
- ✅ Add the shared gateway and dedicated rootless-Docker mounts to code-server without exposing a host/Coolify Docker socket
- ✅ Configure the authenticated reserved `*-preview.benflex.dev` namespace router for the current deployment
- ✅ Validate external Vite/HMR, stop/restart, fail-closed route removal, stable hostname restoration, and Agent health

The `*-preview.benflex.dev`, Coolify, and Traefik values describe the current home-server
deployment target, not a universal DevSpace core requirement. Generic deployments may use another
Docker-capable host, directory, UID/GID, domain, authentication layer, or outer ingress.

## Slice 6 — M1 hardening and diagnostics

**Status: ✅ Complete for the bounded M1 scope**

### Diagnostics and logging

- ✅ Structured Web and Agent JSON logs (bounded preview lifecycle foundation)
- ✅ Request/operation/resource correlation IDs on the instrumented preview path
- ✅ Lifecycle stage and timing information for preview reconciliation and Agent operations
- ✅ Stable failure categories with safe underlying cause details
- ✅ Better internal health breakdown instead of only `Agent degraded`
- ✅ Explicit reconciliation decision logging
- ✅ Safe secret/path redaction policy
- ✅ Incident/error IDs that connect UI errors to service logs

### Authentication hardening (post-M1)

- 🧊 Add provider-neutral production authentication (OIDC or another standards-based mode). The
  current owner-only Cloudflare Access JWT mode remains the validated production authentication
  for this installation; generic production authentication is not implemented.

### Operational diagnostics UX (post-M1)

- 🧊 Persistent rotated service logs
- 🧊 Search/filter diagnostics UI
- 🧊 Per-operation timelines
- 🧊 Public health subsystem details
- 🧊 Log export and retention controls
- 🧊 Dedicated Diagnostics view

### Lifecycle hardening (post-M1)

- 🧊 Creation-record recovery beyond the implemented exact-operation, ownership, restart, and
  narrow device-remount recovery
- 🧊 Better stale-state cleanup
- 🧊 More explicit degraded-subsystem reporting
- 🧊 Additional restart/reconciliation regression coverage
- 🧊 Local development launcher should use a short Unix socket path automatically
- 🧊 Eliminate the current manual `/run/user/.../devspace` socket workaround

### Static-analysis hardening (post-M1 maintenance)

- ✅ Semgrep CE foundation and first contextual triage
- ✅ Complete JSON artifact and deterministic source-snippet-free job summary
- ✅ Scanner/report failures blocking while findings remain monitoring-only
- ✅ All current GitHub Actions references pinned to immutable full SHAs
- 🧊 pnpm dependency-policy compatibility work deferred for a separate task
- 🧊 Tune the curated ruleset through further contextual review before making selected findings
  blocking.
- 🧊 Evaluate additional free options later, including self-hosted SonarQube Community, CodeScene
  through eligible GitHub Student benefits, and any GitHub Student Pack security tooling that is
  genuinely free for this private repository. These options have not been adopted.

### Toolchain acceleration — TypeScript 7

**Status: ✅ Complete — July 28, 2026**

TypeScript 7 is now stable and is a high-leverage delivery accelerator. The TypeScript 7 migration
is complete and has shortened DevSpace's normal typecheck feedback loop before the next product
slice.

Measured on the current development server with `/usr/bin/time` after a clean locked install:

| `pnpm typecheck` | TypeScript 5.9.3 | TypeScript 7.0.2 |
| --- | ---: | ---: |
| warm 1 | 56.78 s / 552,656 KB | 18.19 s / 455,908 KB |
| warm 2 | 46.38 s / 453,724 KB | 18.56 s / 453,412 KB |
| warm 3 | 46.33 s / 455,496 KB | 18.41 s / 457,904 KB |

TypeScript 7 is the native `tsc` CLI for all repository typecheck and build commands. The standard
`typescript` dependency remains a narrow `@typescript/typescript6` alias because the workspace
graph checker and `typescript-eslint` require the legacy programmatic API; its `tsc6` command is
also checked in CI. The sole required configuration change removed the obsolete `baseUrl` and made
the existing path aliases explicitly relative. Default TypeScript 7 parallelism was retained: a
conservative `--checkers 2` experiment produced no material benefit, and no fixed checker or builder
counts were selected.

Completed migration scope:

- ✅ Benchmark `pnpm typecheck` before and after the migration
- ✅ Adopt TypeScript 7 for command-line typechecking and project builds where compatible
- ✅ Keep TypeScript 6 side-by-side only for tooling that still needs the legacy compiler API
- ✅ Verify compatibility with Next.js, `typescript-eslint`, `tsx`, Vitest, Playwright, declaration
  output, and the monorepo tsconfig/project-reference hierarchy
- ✅ Fix TypeScript 6/7 configuration changes that are directly required by DevSpace
- ✅ Compare a conservative `--checkers 2` experiment and retain the faster default parallelism
- ✅ Document the compatibility arrangement and rollback path

Stop rule:

- This is an acceleration slice, not a toolchain rewrite.
- If a required tool cannot coexist cleanly with TypeScript 7 after a bounded investigation, retain
  the compatible path for that tool and continue product work.
- Do not wait for every ecosystem integration to become native before using TypeScript 7 for the
  paths that already work.

---

# Immediate next steps

1. ✅ **AI Session Beta Slice B — Checkpoint 1 complete**
   - ✅ create and persist one workspace-scoped Codex session;
   - ✅ send prompts and stream assistant text/activity;
   - ✅ cooperatively interrupt and send another turn;
   - ✅ show bounded changed-files summaries and retain history after refresh;
   - ✅ stop the live session and verify post-fix ephemeral staging cleanup;
   - ✅ Checkpoint 2 browser slice adds approvals, structured questions, durable interaction replay,
     profile-pinned session navigation, and Workbench changed-file opening;
   - ✅ Codex compatibility now uses the protocol/capability surface rather than an executable
     release whitelist: `0.145.0` is the minimum regression baseline, newer compatible versions
     have no upper bound, and discovery/probing is isolated and bound to the exact execution
     artifact closure;
   - ✅ Writable managed sessions require compatible command/file approvals; structured input and
     interrupt degrade truthfully when optional protocol capabilities are absent;
   - ✅ record an Orca-first / T3-secondary conceptual UX policy; Checkpoint 2 used T3 patterns
     conceptually only and copied no host/process/persistence assumptions;
   - ✅ failed-turn/Unauthorized finalization now requires provider exit, staging cleanup, and lease
     release proof before `session.stopped`;
   - ✅ owner device-code onboarding and bounded real-provider browser validation passed; Checkpoint 1
     is complete

2. 🟡 **Private GitHub repository access — Checkpoint 3A connection lifecycle**
   - ✅ Checkpoint 1 merged by PR #44 at `a74c183e5dc9cf3ed1bf9c9ac4513cb7cdcf126e`; validated
     head `ea5fbbeeb17be0ec393097be1e5dd6374b9bb356`; accepted snapshots are tree-equivalent;
   - ✅ CP2 browser slice implements live refresh, immutable repository selection, private
     inspect/clone/fetch, managed store/worktree setup, normal runtime start, later Fetch repository,
     exact token brokering, and restart-safe origin transitions;
   - ✅ CP2 real-provider acceptance completed successfully in PR #45; accepted PR head
     `a9dabaece59ea9927ebb5a62767849cda96245ff`, squash merge
     `3ffd07fad4995ac73bb2dccc1514bf5cb5fe5193`, shared root tree
     `9647bd27929a7300aaa627416f8111f447b68899`;
   - ✅ CP3A lifecycle generations, explicit disconnect, bounded cleanup, same-ID reconnect,
     reinstall recovery, and safe authority-loss classification;
   - ✅ CP3B write permission, explicit push intents, confirmation, effects, and reconciliation;
   - no OAuth, PAT, or fine-grained-token fallback is planned for this authority model.

3. ⏳ **Create a project from scratch**
   - create a local managed Git repository and primary workspace without a remote;
   - support an initial commit and normal terminal/preview/AI workflows;
   - optionally create/publish/connect a private GitHub repository using the credential path from
     step 2;
   - defer template marketplaces and broad scaffolding catalogs.

4. 🟡 **Workbench beta completion**
   - ✅ basic file tree/editing;
   - ✅ Workbench 1B practical Git status/diff/stage/commit with existing explicit push;
   - better task/process output and controls;
   - essential Project Options editing;
   - cohesive Orca-first Workbench navigation and visual polish.

5. ⏳ **Focused beta stabilization**
   - fix P0 defects and high-frequency P1 defects found through real use;
   - document P2 limitations;
   - avoid another broad proof/hardening phase before the beta is usable end-to-end.

---

# Post-M1 product roadmap

## Near-term product gaps after M1

### Private GitHub repository access

**Status: ✅ Checkpoint 3A/3B private GitHub access and Workbench 1B are complete; AI Session Checkpoint 2 is the current slice**

- ✅ Authenticate the administrator-configured owner account/installation through a GitHub App
- ✅ List authorized repositories outside project onboarding and refresh live installation authority
- ✅ Clone and fetch private repositories without embedding credentials in remote URLs
- ✅ Inspect, register, set up, start, and later fetch a private repository through the normal path
- ✅ Keep immutable `{connectionId, repositoryId}` ownership through Web, Agent, journal, and store state
- ✅ Broker one-operation credentials through an owner-private askpass socket and native helper
- ✅ Keep credentials and short-lived tokens Agent-private
- ✅ Redact credentials from logs, errors, process arguments, and persisted public state
- ✅ Fence new private operations with a durable lifecycle generation
- ✅ Disconnect one retained connection with exact Agent-private cleanup and no local-work deletion
- ✅ Reconnect or replace the GitHub installation while retaining the same DevSpace connection ID
- ✅ Classify installation removal, suspension, permission loss, repository access loss, and transient upstream failures
- ✅ Push through an explicit user action

Sequencing decision:

- CP1 is merged and locally/dev accepted; CP2 real-provider acceptance is complete and CP3A is the
  active branch. Production deployment is not claimed.
- It is required before inviting external beta users because most real development repositories are
  private.
- Do not delay the first AI vertical slice for a generic multi-provider source-control abstraction.
- Start with GitHub only and one owner identity/installation.

### Create a project from scratch

**Status: ❌ Not started — beta gate after private-repository access**

- ❌ Create a brand-new DevSpace project without requiring an existing GitHub repository
- ❌ Initialize a managed local Git repository, primary workspace, and initial commit safely
- ❌ Support the normal terminal, task, preview, AI, files, and Git workflows before a remote exists
- ❌ Optionally create/publish/connect a private GitHub repository later
- ❌ Preserve a simple blank-project path before adding framework templates

Sequencing decision:

- Implement after private GitHub access so publishing can reuse one credential and repository-creation
  path.
- Complete it before broad Workbench polish because onboarding must support both existing and new
  projects for the beta to feel coherent.

### Persistent Git identity

**Status: 🧊 Deferred P1 UX**

- 🧊 Add User Settings for a default Git author name and email used explicitly for DevSpace-created
  commits; keep the current temporary identity behavior until this item is implemented.

### Persistent terminals

**Status: ❌ Not started**

Goal:

```text
Browser
→ Agent
→ attach/detach
→ persistent terminal session
→ shell / task / Vite / Codex / AI tools
```

This replaces the current Docker-exec PTY limitation where an Agent restart loses the browser attachment.

---

# Milestone 2 — High-quality Semi-finished Beta

**Status: 🟡 Active — owner-controlled MVP delivery**

Goal: make DevSpace a coherent daily-use development product as quickly as possible without turning it
into a VS Code clone or requiring production-grade handling of every theoretical edge case.

## Definition of done

A beta user can:

1. import a public or authorized private GitHub repository, or create a project from scratch;
2. create/start the primary managed workspace;
3. use terminal, configured tasks, and previews through the browser;
4. create a Codex-first AI session, stream turns/activity, answer approvals/structured questions,
   interrupt it, and inspect a changed-files summary;
5. browse and edit files;
6. inspect Git status/diffs and explicitly stage, commit, and push;
7. edit the Project Options required for normal runtime/task/preview behavior;
8. recover from ordinary failures through clear retry, session restart, or workspace restart actions;
9. navigate a cohesive, polished, responsive Workbench informed first by Orca and supplemented by
   the strongest applicable T3 Code patterns.

Not required for this milestone:

- hostile-repository containment;
- perfect descendant termination;
- checkpoint rollback;
- multi-workspace orchestration;
- generic source-control/provider support;
- production deployment automation;
- exhaustive diagnostics and recovery tooling.

## Delivery order

Completed: TypeScript 7 acceleration.

Remaining delivery order:

1. Private GitHub repository access Checkpoints 1–3
2. AI Session Beta Checkpoint 2 approvals and structured questions
3. Create project from scratch
4. Files and Git essentials
5. Tasks, Project Options, Workbench integration, and beta polish
6. Focused real-use stabilization

## Files and editor

- ✅ File tree
- ✅ File viewing/editing
- ❌ Create/rename/delete files
- ❌ Search/navigation
- ✅ Editor tabs

## Git experience

- ✅ Better status view — Workbench 1B Changes + Commit merged by PR #49
- ✅ Diff UI — Workbench 1B Changes + Commit merged by PR #49
- ✅ Staging — Workbench 1B Changes + Commit merged by PR #49
- ✅ Commit workflow — Workbench 1B Changes + Commit merged by PR #49
- ✅ Push workflow
- ✅ Branch awareness — Workbench 1B Changes + Commit merged by PR #49

## AI sessions

Foundation completed:

- ✅ Provider-neutral AI-session contracts
- ✅ Session/process/turn/interaction lifecycle contracts
- ✅ Authenticated supervisor recovery capability research
- ✅ Explicitly documented production termination blocker and owner-only beta fallback

AI Session Beta Slice B — Checkpoint 1:

- ✅ Codex-first AI session tab
- ✅ Agent-owned persistent Codex authority, exclusive beta lease, exact-container staging path, and
  isolated version/capability discovery for the recognized execution artifact
- ✅ Create, prompt, stream, interrupt, stop, and new-turn controls
- ✅ Persistent public session/turn metadata and refresh recovery
- ✅ Streaming assistant text and useful activity events
- ✅ Approvals and structured questions — Checkpoint 2 implementation on
  `feat/ai-workbench-checkpoint-2`
- ✅ Durable interaction projection, terminal retirement, canonical response reconciliation, and
  profile-pinned session navigation
- ✅ AI changed-file links open the existing Workbench Edit/Changes representation
- ✅ Bounded changed-files summary after terminal turns
- ✅ Clear degraded-session and restart-workspace fallback
- ✅ Exact stopped-session restart with one durable history/event chain and monotonically increasing
  Agent-owned provider-process generations
- 🟡 One global Codex provider at a time remains the beta limitation
- ✅ Checkpoint 1 passed: private Probe A, private Probe B, and the real browser first-write/read-
  only/interrupt/replay/Stop flow all used the Agent-owned Codex provider; provider exit, staging,
  synchronization, lease, authority, and container cleanup were verified
- 🟡 Checkpoint 2 real installed-Codex/browser dogfood remains to be completed on the implementation
  branch; deterministic 0.145-baseline and captured newer-protocol fixtures are green

Deferred until later:

- 🧊 Inline full diff review inside the first AI slice
- 🧊 Checkpoint/rollback
- 🧊 Multiple providers
- 🧊 Hostile descendant containment and atomic arbitrary process-tree termination

## Tasks and processes

- 🟡 Basic task/process foundation exists from M1
- ❌ Better task output UX
- ❌ Process lifecycle controls
- ❌ Persistent task history
- ❌ Better long-running process handling

## Project Options

- 🟡 Project setup already exposes the preview configuration needed for M1
- ✅ Workbench editor for development image, configured tasks, and workspace previews with immutable drafts, explicit Apply, and field validation
- ❌ Runtime/service configuration UX
- ✅ Preview configuration management after project creation

## Workbench lifecycle and visual design

- ✅ Functional tabbed Workbench exists
- ❌ Full visual redesign/polish
- ❌ Better tab lifecycle
- ❌ First-class Terminal / Editor / Preview / AI / Git / Task tabs
- ❌ Retained Preview tabs that show `Stopped` or `Failed` after activation
- ❌ Persistent terminal tabs
- ❌ Better responsive behavior

## Additional vertical slices

- 🟡 Private GitHub repository access Checkpoint 3A lifecycle implementation on its feature branch;
  CP2 real-provider acceptance is complete and CP3B push is deferred
- ❌ Create project from scratch
- ❌ Persistent terminals

Persistent terminals remain valuable, but they do not precede the AI/private-repository/create-project
beta gates because the existing terminal path is already usable. Implement them when ordinary
Agent-restart loss becomes one of the highest-frequency remaining beta problems.

---

# Milestone 3 — AI-first Development Workflows

**Status: ❌ Not started**

- ❌ Project-aware AI sessions
- ❌ Persistent agent session state
- ❌ Multi-step implementation/review workflows
- ❌ Task/check integration
- ❌ Git-aware AI review flows
- ❌ Better orchestration between user, workspace, tools, and AI agents
- ❌ Safe explicit publishing actions
- ❌ No automatic merge or production deployment

---

# Milestone 4 — Multiple Isolated Workspaces

**Status: ❌ Not started**

- ❌ Isolated workspaces
- ❌ Branch/worktree creation
- ❌ Independent runtime stacks
- ❌ Independent previews
- ❌ Archive/remove lifecycle
- ❌ Workspace switching
- ❌ Resource controls for multiple simultaneous environments

The primary workspace remains the default simple path.

---

# Milestone 5 — Product Hardening and Operations

**Status: ❌ Not started**

- ❌ Deeper reconciliation
- ❌ Automated stale-resource cleanup
- ❌ Resource reporting
- ❌ Backup/restore validation
- ❌ Notification system
- ❌ Persistent diagnostics/logging UX
- ❌ Recovery tooling
- ❌ Security hardening from real deployment evidence
- ❌ Performance profiling and optimization
- ❌ Broader UX accessibility/responsiveness polish

---

# Future mobile companion app

**Status: 🧊 Planned for later, likely after the Web control plane and Workbench mature**

The mobile app should connect to the same DevSpace server and the same project/workspace state rather than creating a separate project universe.

Likely focus:

- ❌ Project/workspace status
- ❌ Start/stop/restart actions
- ❌ AI interaction
- ❌ Git/review workflows
- ❌ Task/process monitoring
- ❌ Notifications
- ❌ Lightweight file editing

Full desktop Workbench parity is not required for the first mobile version.

---

# Explicitly deferred / not current scope

These items must not block the semi-finished beta unless real use promotes one to P0:

- 🧊 Exhaustive handling of rare lifecycle races and internal-record corruption
- 🧊 Perfect recovery from simultaneous service/runtime failures
- 🧊 Production-safe termination of arbitrary hostile descendant process trees
- 🧊 Generic source-control and AI-provider platforms before the GitHub/Codex paths work
- 🧊 Hostile-code multi-tenant sandboxing
- 🧊 Automatic merge
- 🧊 Automatic production deployment
- 🧊 Production access to the host Docker socket
- 🧊 Per-preview Cloudflare DNS/API changes
- 🧊 Permanent VS Code-style multi-pane UI
- 🧊 Separate backup server requirement

DevSpace remains a trusted-owner, self-hosted development control plane with strong boundaries between projects, the host, and production infrastructure.
