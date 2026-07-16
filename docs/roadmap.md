# Roadmap

The roadmap switches to vertical product delivery after the completed foundation. A slice may
touch Web, DB, Agent, runtime, and UI together when that is required to produce visible value.

## Milestone 0 — Foundation

Status: complete.

Contains:

- architecture and security boundaries;
- executable contracts;
- Project Options foundation;
- lifecycle and security primitives;
- database schema and migrations;
- clean-clone CI contract.

## Milestone 1 — Usable Primary Workspace

### Definition of done

A user can open DevSpace in the browser, register or import a trusted repository, create its
primary managed workspace, start a real isolated development container, use a browser terminal,
run at least one configured task, and open a working preview URL.

This milestone is implemented as vertical slices:

### 1. Project onboarding path

Crosses the Web UI/API, SQLite, Agent Unix-socket health and inspection, and repository
registration.

Visible result: a project can be added and appears in DevSpace with real persisted status.

### 2. Managed primary workspace

Crosses Web orchestration, the Agent, the managed repository store, the primary Git worktree, and
persisted workspace/runtime state.

Visible result: a real repository has a managed primary workspace.

### 3. Real workspace runtime

Crosses Project Options runtime-plan compilation, Agent policy validation, dedicated rootless
Docker, start/stop lifecycle, and persisted desired/observed state.

Visible result: the user can start and stop the real isolated development environment.

### 4. Terminal and task path

Crosses the WebSocket/browser terminal, Agent PTY, workspace container, and process/task tracking.

Visible result: the user can interact with the running workspace and execute useful project
commands.

### 5. Preview path

Crosses a configured preview target, the Agent, the Caddy gateway, a wildcard domain, and Web
status.

Visible result: the user can open the running project through its DevSpace preview URL.

### 6. Dogfood and hardening

Use DevSpace to work on at least one real project and fix only concrete blockers exposed by real
use. The Milestone 1 definition of done remains the complete usable path above.

These are not mandatory isolated subsystem phases. Each slice ends in observable user value.

## Milestone 2 — Better Daily Development

Likely goals include better Project Options editing and detection, supporting services, logs and
process UX, rebuild/restart flows, stronger recovery and reconciliation, and better Git status.

## Milestone 3 — Parallel Workspaces

Add optional isolated workspaces, branches and worktrees, independent stacks and previews, and
archive/remove lifecycle.

## Milestone 4 — AI Development Sessions

Add approved AI CLI profiles, start/resume/interrupt/stop controls, terminal-backed AI sessions,
workspace-scoped credentials, and session metadata and UX.

## Milestone 5 — Git Review and Publishing

Add diff/status UI, staging, checks, commits, push, and optional draft pull request creation.
Never auto-merge.

## Milestone 6 — Reliability and Polish

Add deeper reconciliation, stale cleanup, resource reporting, backup/restore validation,
notifications, and UX polish.
