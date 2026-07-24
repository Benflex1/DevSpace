# DevSpace Roadmap

> Updated July 2026.
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

# Current overall status

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

**Status: 🟡 Final stretch — roughly 90–95% complete**

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

The full core path now works locally. Remaining work is mostly final lifecycle/UI polish, hardening, and production deployment.

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

**Status: ✅ Core complete / 🟡 UX follow-up remains**

- ✅ Browser terminal works
- ✅ Agent PTY connection works
- ✅ Terminal runs inside the workspace container
- ✅ Project commands can be executed
- ✅ Task/process tracking foundation exists
- ✅ Lost terminal sessions are detected after Agent restart
- ✅ Lost-terminal recovery dialog exists

Current limitation:

- 🧊 True terminal reattachment is not possible with the current Docker exec/PTTY model

Planned follow-up:

- ⏳ Persistent terminal/session ownership layer
- ⏳ Attach/detach semantics
- ⏳ Better long-lived terminal recovery for shells, Vite, Codex, and other processes

Completed Workbench polish in PR #22:

- ✅ Lost terminal rows automatically disappear from the sidebar after a short grace period
- ✅ Lost-terminal recovery action is **Restart workspace**
- ✅ Lost-terminal dialog button hierarchy makes Dismiss smaller/secondary and Restart workspace prominent
- ✅ Workbench metadata order is branch, repository, runtime state, and runtime control

## Slice 5 — Preview path

**Status: 🟢 Core implementation complete / 🟡 final polish and deployment pending**

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

Remaining before Slice 5 is fully closed:

- 🟡 Re-run final local lifecycle checklist
- ⏳ Deploy the preview gateway stack on the home server
- ⏳ Mount the shared gateway runtime directory into code-server/DevSpace
- ⏳ Configure the production preview environment
- ⏳ Configure one permanent reserved-namespace rule in the selected outer ingress
- ⏳ Verify real production preview traffic and HMR through the selected ingress

Final local checklist:

- 🟢 Vite running → Preview `Ready`
- 🟢 Stop Vite → Preview `Waiting`
- 🟢 Restart Vite → Preview `Ready`
- 🟢 Stop runtime becomes available after restart/remount recovery
- 🟢 Runtime Stop uses the normal ownership-checked path
- 🟢 Agent restart detects lost terminals
- 🟡 Lost-terminal UI polish still being finalized
- ⏳ Final production server validation

## Slice 6 — M1 hardening and diagnostics

**Status: 🟡 In progress**

### Diagnostics and logging

- ✅ Structured Web and Agent JSON logs (bounded preview lifecycle foundation)
- ✅ Request/operation/resource correlation IDs on the instrumented preview path
- ✅ Lifecycle stage and timing information for preview reconciliation and Agent operations
- ⏳ Stable failure categories with safe underlying cause details
- ✅ Better internal health breakdown instead of only `Agent degraded`
- ✅ Explicit reconciliation decision logging
- ✅ Safe secret/path redaction policy
- ⏳ Incident/error IDs that connect UI errors to service logs

### Authentication hardening

- ⏳ Add provider-neutral production authentication (OIDC or another standards-based mode); this
  is separate future work and does not block completion of the M1 preview slice.

Later operational UX:

- ⏳ Persistent rotated service logs
- ⏳ Search/filter diagnostics UI
- ⏳ Per-operation timelines
- ⏳ Health subsystem details
- ⏳ Log export and retention controls
- ⏳ Dedicated Diagnostics view

### Lifecycle hardening

- ⏳ Creation-record recovery across reboot/remount/device renumbering
- ⏳ Better stale-state cleanup
- ⏳ More explicit degraded-subsystem reporting
- ⏳ Additional restart/reconciliation regression coverage
- ⏳ Local development launcher should use a short Unix socket path automatically
- ⏳ Eliminate the current manual `/run/user/.../devspace` socket workaround

### Static-analysis hardening

- 🟢 Add a separate, accountless Semgrep Community Edition workflow for pull requests, pushes to
  `main`, and manual runs using the curated `p/default` ruleset.
- 🟢 Retain complete JSON findings and publish a deterministic, source-snippet-free job summary;
  findings are monitoring-only while scanner and report failures remain blocking.
- ⏳ Tune the curated ruleset through AI-assisted contextual review before making high-confidence
  security or correctness findings blocking.
- ⏳ Evaluate additional free options later, including self-hosted SonarQube Community, CodeScene
  through eligible GitHub Student benefits, and any GitHub Student Pack security tooling that is
  genuinely free for this private repository. These options have not been adopted.

### Toolchain maintenance

- ⏳ Evaluate and adopt TypeScript 7 for faster typechecking where compatible
- ⏳ Keep a compatibility TypeScript toolchain only where ecosystem tools still require the legacy compiler API
- ⏳ Benchmark DevSpace typecheck/CI before and after migration
- ⏳ Verify compatibility with Next.js, `typescript-eslint`, `tsx`, Vitest, and the monorepo tsconfig hierarchy

---

# Immediate next steps

1. ⏳ Run the final local Slice 5 lifecycle checklist
2. ⏳ Deploy the preview gateway stack to the home server
3. ⏳ Configure production reserved-namespace preview routing
4. ⏳ Validate production previews/HMR
5. ⏳ Complete focused M1 Slice 6 hardening
6. ⏳ Evaluate/adopt TypeScript 7 without breaking tooling compatibility
7. ✅ Close Milestone 1

---

# Post-M1 product roadmap

## Near-term product gaps after M1

### Create a project from scratch

**Status: ❌ Not started**

- ❌ Create a brand-new DevSpace project without requiring an existing GitHub repository
- ❌ Initialize repository/workspace safely
- ❌ Optionally publish/connect it to GitHub later

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

# Milestone 2 — Real Development Workbench

**Status: ❌ Not started as a milestone**

Goal: make DevSpace the main place where normal development work happens without turning it into a VS Code clone with permanent multi-pane chrome.

## Files and editor

- ❌ File tree
- ❌ File viewing/editing
- ❌ Create/rename/delete files
- ❌ Search/navigation
- ❌ Editor tabs

## Git experience

- ❌ Better status view
- ❌ Diff UI
- ❌ Staging
- ❌ Commit workflow
- ❌ Push workflow
- ❌ Branch awareness

## AI sessions

- ❌ AI session tabs
- ❌ Approved AI CLI profiles
- ❌ Start/resume/interrupt/stop controls
- ❌ Workspace-scoped credentials
- ❌ Persistent AI session metadata
- ❌ Better integration with project context

## Tasks and processes

- 🟡 Basic task/process foundation exists from M1
- ❌ Better task output UX
- ❌ Process lifecycle controls
- ❌ Persistent task history
- ❌ Better long-running process handling

## Project Options

- 🟡 Project setup already exposes the preview configuration needed for M1
- ❌ Full Project Options editor
- ❌ Better validation UX
- ❌ Runtime/service configuration UX
- ❌ Preview configuration management after project creation

## Workbench lifecycle and visual design

- 🟡 Functional tabbed Workbench exists
- ❌ Full visual redesign/polish
- ❌ Better tab lifecycle
- ❌ First-class Terminal / Editor / Preview / AI / Git / Task tabs
- ❌ Retained Preview tabs that show `Stopped` or `Failed` after activation
- ❌ Persistent terminal tabs
- ❌ Better responsive behavior

## Additional vertical slices

- ❌ Create project from scratch
- ❌ Persistent terminals

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

- 🧊 Hostile-code multi-tenant sandboxing
- 🧊 Automatic merge
- 🧊 Automatic production deployment
- 🧊 Production access to the host Docker socket
- 🧊 Per-preview Cloudflare DNS/API changes
- 🧊 Permanent VS Code-style multi-pane UI
- 🧊 Separate backup server requirement

DevSpace remains a trusted-owner, self-hosted development control plane with strong boundaries between projects, the host, and production infrastructure.
