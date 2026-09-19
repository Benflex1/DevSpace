# Generic native AI-harness architecture

- Status: Design (not yet accepted as an ADR)
- Date: 2026-09-19
- Corrected: 2026-09-19 (pre-implementation)
- Base: `origin/main` at `72b52aae73afd169cc7a32271b53021a78c808ef`
- Branch: `feat/generic-native-ai-harness-design`
- Supersedes as product target: ADR 015 structured Codex app-server path
- Preserves during migration: ADR 015, `docs/specs/ai-sessions-v1.md`, and the shipped Workbench Codex session
- Restores as product path: ADR 009 (real native CLI in a container PTY)
- Orca reference: `stablyai/orca` at `caa465d1da886b2697c85c18bf36f79f2d3b9e68`
- Feasibility evidence only (not merged, not continued):
  - `feat/codex-cli-app-server-code-mode-implementation` at `caaaf0d24cfe7e171b17d5ee58fb0afdf23a21e2`

This document is the architecture specification for DevSpace's generic native AI-harness
system. It does not implement product code. It does not authorize deleting the shipped
structured Codex path in the first slice.

## 1. Intent

DevSpace must run arbitrary terminal-based AI coding harnesses as real native CLI/TUI
processes inside the exact managed workspace runtime.

Success looks like:

```text
Browser
  → DevSpace Web
    → private Web/Agent Unix socket
      → DevSpace Agent
        → exact authorized workspace development container
          → Docker exec PTY
            → real native harness CLI (Codex, Claude Code, Gemini CLI, OpenCode, or custom)
```

DevSpace does not fake the provider conversation UI. The user sees and operates the
provider's own TUI. Built-in providers are presets over one generic mechanism. Users can
define a custom harness with at least a launch command and an optional resume command.

Native provider session/history semantics are preserved. DevSpace never invents fake native
session IDs or fake provider history.

The generic path must not depend on Codex app-server, CodeModeOnly, exec-server, Code Mode
gRPC, split control/execution, or other Codex-specific internals. Those remain research
evidence from the feasibility branches and are not the product architecture.

## 2. Why this replaces the structured Codex path as the product target

ADR 015 made first-class AI sessions a structured JSONL app-server resource because generic
PTY bytes cannot express typed turns, durable assistant history, or DevSpace-mediated
approvals. That is true, and the shipped Checkpoint 2 Workbench depends on it.

The product requirement has now changed: DevSpace is an environment that hosts native coding
harnesses, not a synthetic chat client for one provider protocol. The structured Codex path
cannot host Claude Code, Gemini CLI, OpenCode, or an arbitrary custom TUI without inventing
a second conversation protocol for each of them.

Therefore:

- The **target product architecture** is generic native PTY harnesses (this document).
- The **shipped current architecture** remains ADR 015 until a later migration slice turns
  it off.
- The two may coexist. The first generic slice does not delete app-server, F11 canonical
  events, the outbox, or the current AI tab.

ADR 009 is the durable product decision again: run the real CLI in the workspace container
through a PTY. ADR 015 remains the contract for the structured Codex compatibility path
until that path is retired.

## 3. Scope

### MUST HAVE FOR FIRST GENERIC SLICE

Prove one vertical native-harness workflow:

1. One built-in harness preset: Codex, launched as the real `codex` TUI.
2. One owner-defined custom harness: structured executable + argv, optional resume argv
   template.
3. Real PTY using the existing terminal attach/resize/detach protocol.
4. Agent-owned private per-harness state outside `/workspace` and outside the project Git
   tree.
5. Only the currently selected harness home is materialized into the workspace container.
   Unrelated harness homes are never mounted. Credentials never enter `/workspace` or Git.
   Same-container process isolation is **not** provided: a user shell can read a populated
   slot.
6. Native start via structured argv, never a shell string.
7. Native resume in two forms: provider-handled (`args` with zero `{sessionId}` tokens) and
   DevSpace-supplied ID (exactly one whole-token `{sessionId}`). No invented IDs.
8. Browser attach and reconnect while the Agent still holds the Docker-exec stream.
9. After Agent restart: recover dirty slot, exclusive-lease-aware writeback, run discovery
   on the persistent home, store a real native ID if found, leave the session `lost`, and
   offer Resume when the template allows it.
10. Exclusive Agent-owned lease on a persistent harness home while it is materialized/live.
    First slice rejects "already active in another workspace" rather than sharing homes.
11. Workspace runtime inspection of the harness slot mount; missing/mismatch on a harness
    that needs the slot uses the existing stop/start generation recreate, never in-place
    Docker mount mutation.
12. Bounded copy-in/copy-out filesystem contract for Codex homes. No claim of universal
    provider-home support.
13. Codex executable from the workspace image `PATH` when present; Agent-managed artifact
    only as fallback. Record and show the selected source.

The first slice is useful when an owner can start Codex in the Workbench, use the real TUI,
disconnect and reconnect, quit, and resume the same native Codex session, and can also
start a custom command the same way without Codex credentials being copied into that
custom process or into Git.

### LATER / OPTIONAL INTEGRATIONS

Not in the first slice:

- Built-in Claude Code, Gemini CLI, and OpenCode presets (named only so later presets do
  not fork the runtime; no persistence/discovery design for them now).
- Shared concurrent use of one harness home across workspaces.
- DevSpace-mediated approvals, structured questions, or canonical turn cards on the generic
  path.
- AI changed-file event links (the existing Changes tab remains the Git surface).
- Persistent in-container PTY multiplexer so a harness survives Agent restart without
  native resume.
- Safe individual process kill beyond M1's current terminal limitation.
- Project-local harness definitions stored in the repository.
- Secret-id environment bindings for custom harnesses.
- Scanning the operator's host `~/.codex` / `~/.claude`.
- Universal structured-event abstraction, tool proxying, or synthetic chat protocols.
- Retiring the structured Codex app-server path.
- Codex split-execution / Code Mode.
- Same-container hide-mount / hostile-process isolation of the slot.

## 4. Evidence used

### 4.1 Current DevSpace on main

Inspected at `72b52aae73afd169cc7a32271b53021a78c808ef`:

- Workspace development containers already bind only the worktree at `/workspace` and run
  as the image user (`apps/agent/src/docker-runtime.ts`).
- `WorkspaceRuntime.validateContainer` currently requires **exactly one** bind mount
  (`/workspace`). Adding a harness slot is a new runtime identity; existing containers
  will not have it and cannot have mounts mutated in place.
- Interactive terminals already use Docker exec with `Tty: true`, binary
  `devspace.terminal.v1` frames, attach/detach/reconnect, and 64 KiB replay
  (`apps/agent/src/execution-manager.ts`, F09 terminal stream).
- Terminal create currently hard-codes `command: ["/bin/sh"]`. The exec helper already
  accepts a structured `command: readonly string[]`.
- After Agent restart, live terminal PTYs become `lost` because the Docker-exec attach
  stream cannot be recovered. That limitation is accepted for the first generic slice;
  native resume is the recovery path.
- Tasks already use `{ executable, args[], workingDirectory, environment }` and reject
  unresolved secret/host bindings at runtime.
- Structured AI sessions are a separate JSONL app-server path: F11, outbox, profile
  revision hashing, ephemeral `CODEX_HOME` staging of `auth.json`, and Workbench turn
  cards (`docs/specs/ai-sessions-v1.md`, `apps/agent/src/ai-session-runtime.ts`).
- `ai_sessions.terminal_session_id` already exists and is unused as a live PTY backing
  for first-class sessions. Native harness sessions will use it.
- Agent-private state conventions already exist: `0700` directories, `0600` files,
  no-follow reads, atomic writeback (`apps/agent/src/private-state.ts`, GitHub App layout,
  Codex authority layout).
- Codex credential authority already uses a **local exclusive `.lease` directory** with
  metadata, fail-closed acquire, and retryable release. Harness-home leases reuse that
  local pattern, not a distributed lock.
- Workspace stop then start already creates a new runtime generation and a new container
  from current `createContainer` policy. That is the bounded recreate path for a missing
  slot mount.
- Project Options `aiProfile.fixedArgs` / `credentialSecretIds` remain dormant and must
  stay non-executable.

### 4.2 Orca at `caa465d1da886b2697c85c18bf36f79f2d3b9e68`

Adopt as ideas, not as architecture:

| Adopt | Do not copy |
| --- | --- |
| Built-in agents are launch/resume presets over one PTY mechanism | Orca's 30+ TUI catalog as DevSpace first-class types |
| Real native CLI in a PTY; do not fake the conversation UI | Typing resume commands into a user shell |
| Resume may pass a native ID (`codex resume <id>`) or let the CLI resume itself | Shell-string concatenation and quoting matrices |
| Discover native IDs from the provider's own session store | Full "AI vault" transcript search/index as baseline |
| Per-agent private home via `CODEX_HOME` / config-dir env | Scanning the operator's real `~/.codex` on the host |
| Sanitize native IDs (bounded, no controls, no leading `-`) | Prompt injection, OSC hooks, native-chat overlay |
| Custom command is a first-class launch | WSL/SSH/Windows host-routing complexity |
| One live agent pane per workspace is the safe default | Plugin overlay that mirrors unrelated agent homes |

Orca's resume path is a quoted shell line queued into an existing pane. DevSpace already
has structured exec argv and must use that instead. Orca's session scanners are large
provider-specific parsers; DevSpace should keep tiny built-in discovery adapters and skip
ID-substitution resume when discovery is not reliable. Provider-handled resume (no
placeholder) does not need discovery.

### 4.3 Feasibility branches (research only)

The Codex split-execution and Code Mode worktrees remain evidence that hiding credentials
from the process that must use them requires a provider-specific remote-execution protocol.
That is the opposite of generic harness support. Those branches are not merged and are not
the migration path. They also version-pinned Codex unnecessarily; the generic path must
not repeat that.

## 5. Architecture

### 5.1 Authority path

Unchanged:

- Browser talks only to Web.
- Web is the sole SQLite writer and never invokes Git, shell, Docker, or Caddy.
- Agent owns filesystem, Git, rootless Docker, PTY, process, and private harness state.
- The harness runs only in the exact authorized workspace development container.
- Browser actions carry DevSpace IDs (`projectId`, `workspaceId`, `harnessId`,
  `sessionId`), never host paths, never raw shell strings, never native session IDs.

New resource: a **native harness session**. It is a first-class DevSpace session whose
live execution is a PTY-backed process, not a JSONL app-server.

```text
native harness session
  = Web SQLite row (public control plane)
  + Agent-private native metadata (native session ID, slot ownership, home lease, executable source)
  + existing terminal_sessions / process row
  + Docker exec PTY of the resolved argv
```

The structured Codex app-server session remains a different runtime kind on the same
Workbench until it is retired.

### 5.2 Where the process runs

The native harness process runs **inside the exact managed workspace development
container**, as a Docker exec with TTY enabled, working directory `/workspace`.

It therefore receives the exact project/workspace environment the container already has:

- the worktree bind-mounted at `/workspace`;
- declared named volumes;
- the compiled runtime-plan environment;
- the container user;
- the workspace network;
- when present, the Agent-owned harness slot at `/opt/devspace/harness-home` (§6, §9.6).

It does not run on the Agent host. It does not run in a control sidecar. It does not
receive the Agent Unix socket, the rootless Docker socket, other workspaces, or host
filesystem paths except that single slot.

### 5.3 Generic harness model

A harness is a named, versioned definition. Built-ins are Agent-owned presets. Custom
definitions are owner-managed desired state in SQLite; Agent validates and executes them.

```text
HarnessDefinition
  id: ConfigurationKey            # e.g. "codex", "custom-my-agent"
  displayName: bounded string
  origin: "builtin" | "custom"
  launch: Argv                    # executable + args, no shell
  resume: ArgvTemplate | null     # zero or one whole-token "{sessionId}"
  privateState: PrivateStatePolicy
  environment: EnvBinding[]       # first slice: literals only
  sessionDiscovery: DiscoveryAdapter | null
```

`executableSource` is **not** a definition field. It is a per-launch observation recorded
in Agent-private session metadata after resolution (§5.7).

Capabilities are derived, not declared:

- `start` if launch argv is valid and the executable can be resolved;
- `resume` if `resume` is non-null **and** either the template has zero `{sessionId}`
  placeholders **or** a real native session ID is currently known;
- `pty` is always true on this path;
- `approvals` / `structuredInput` / `streamEvents` are false on the generic path.

Do not add a generic capability object that invites fake structured features.

#### Argv

```text
Argv = {
  executable: FileNameOrImagePath,  # no host paths; first slice: basename only
  args: string[]                    # each element is one argv token
}
```

`executable` is a single path component (`codex`, `my-agent`). Host paths, NUL, shell
metacharacters, and empty executables are rejected.

Resume templates are argv, not strings. Classification of `resume`:

| Placeholders | Meaning | Resume offered when |
| --- | --- | --- |
| `resume` is `null` | Not resumable | never |
| zero `{sessionId}` tokens | Provider handles selection (`my-agent --resume`) | definition is valid |
| exactly one whole-token `{sessionId}` | DevSpace supplies a discovered native ID | a real native ID is stored |
| `{sessionId}` inside another token | Invalid | reject the definition |
| more than one `{sessionId}` | Invalid | reject the definition |

```text
Codex builtin:
  launch: { executable: "codex", args: [] }
  resume: { executable: "codex", args: ["resume", "{sessionId}"] }

Custom, provider-handled:
  launch: { executable: "my-agent", args: [] }
  resume: { executable: "my-agent", args: ["--resume"] }

Custom, DevSpace-supplied ID:
  launch: { executable: "my-agent", args: [] }
  resume: { executable: "my-agent", args: ["--resume", "{sessionId}"] }
```

`{sessionId}` is a whole-token placeholder only. Substitution inserts the native ID as
exactly one argv element after validation (§8). No `sh -c`, no string join, no
Orca-style `cd … && CODEX_HOME=… cmd`.

Working directory is always `/workspace`. A custom harness does not choose a host cwd.

Launch still works with only `executable` + `args`. Resume is optional.

#### Environment bindings

First slice allows only:

- Agent-injected private-state variables from `privateState` (§6);
- `TERM=xterm-256color`;
- optional literal env on the definition (`kind: "literal"`), bounded, named
  `^[A-Z_][A-Z0-9_]*$`.

Rejected in the first slice: `kind: "secret"`, `kind: "host"`, `kind: "generated"`,
`kind: "service"`. Custom harnesses receive no credentials by default. A later slice may
add explicit secret-id bindings using the same discriminated union Project Options already
has, resolved only by Agent.

### 5.4 Built-in presets

Presets are data plus a tiny discovery adapter. They are not separate runtimes.

First slice implements **Codex only** plus custom. Claude/Gemini/OpenCode are listed only
as future preset IDs. This document does **not** specify their home layouts, discovery, or
filesystem exceptions.

| Preset | Slice 1 | Launch | Resume | Private-state env | Discovery |
| --- | --- | --- | --- | --- | --- |
| Codex | yes | `codex` | `codex resume {sessionId}` | `CODEX_HOME` = slot | `$CODEX_HOME/sessions` and/or `session_index.jsonl` |
| Claude Code | later | `claude` | later | later | later |
| Gemini CLI | later | `gemini` | later | later | later |
| OpenCode | later | `opencode` | later | later | later |

Codex executable resolution is §5.7. Missing executable is an availability observation,
not a crash.

### 5.5 Custom harnesses

A custom harness is the generic mechanism with no preset adapter.

Minimum:

- `launch.executable` + `launch.args`
- optional `resume` argv template classified by §5.3
- `privateState: { kind: "none" }` by default
- no environment secrets
- `sessionDiscovery: null`

Start never requires a native ID. Provider-handled resume (`--resume` with zero
placeholders) is offered without discovery. ID-substitution resume is offered only when a
real native ID exists. DevSpace does not invent an ID.

There is no UI to paste a native ID in the first slice (that would put private-plane data
on the browser).

Optional later custom discovery, not first slice:

```text
{ kind: "newest-file-basename", relativeDirectory: "sessions", extension: ".jsonl" }
```

That adapter may only read the selected harness slot/home, never `/workspace` and never
another harness home.

### 5.6 Profiles

A profile is a stored selection of one harness definition plus optional extra launch args
that are themselves a structured argv suffix.

First slice: one built-in Codex profile and one custom definition. The public ID the
browser sends is `harnessId`. The exclusive home lease is per persistent home, which in
slice 1 is per `harnessId`. Multiple named profiles of the same harness are a later
convenience.

### 5.7 Codex executable source

The generic architecture must not pin a Codex version the way the abandoned split-execution
experiment did.

**First-slice policy:**

1. Custom harnesses always resolve `executable` from the workspace image `PATH`.
2. Builtin Codex prefers the workspace image `codex` when a bounded in-container lookup
   finds it.
3. If image `codex` is absent and an Agent-managed Codex artifact is configured, stage
   that artifact into the container and use it as a **zero-setup fallback**.
4. If neither is available, the profile is `unavailable`.
5. Whichever source is selected is recorded in Agent-private session metadata and shown
   in the safe projection as an opaque source kind plus, when known, a reported version
   string. The browser never receives host paths or SHA digests of the artifact.
6. Do not silently prefer the Agent artifact when the image already has `codex`.
7. Native TUI has **no app-server protocol version floor**. Do not require Codex
   `0.145.0` on this path. If `codex resume` or the on-disk session layout is missing,
   ID-substitution resume is unavailable; Start still works.

Safe projection example:

```text
executableSource: { kind: "image-path", command: "codex", reportedVersion: "0.153.4" }
executableSource: { kind: "agent-artifact", reportedVersion: "0.145.0" }
```

`kind` is closed: `"image-path" | "agent-artifact"`. Artifact identity remains Agent-private.

## 6. Credential and private-state model

### 6.1 Principle

```text
project / Git / container worktree:     /workspace
Agent-private harness homes:            <agent-state-root>/harness-homes/<harnessId>/
per-workspace active slot (bind mount): <agent-state-root>/harness-slots/<workspaceId>/
                                        → container /opt/devspace/harness-home
exclusive home lease:                   <agent-state-root>/harness-homes/<harnessId>/.lease/
```

Never place provider auth files, session stores, or API keys in the project root.

### 6.2 Why a slot instead of mounting every home

Docker exec cannot add mounts. Mounts exist for the container lifetime. If the Agent
bind-mounted the entire `harness-homes/` tree, a Codex process could read Claude
credentials.

Therefore each workspace container receives **one** Agent-owned slot directory. Only the
currently selected harness's files are materialized into that slot before launch. Other
harness homes stay on the Agent host and are not visible in the container.

This is the generic replacement for ADR 015's ephemeral `CODEX_HOME` staging. The slot
holds a **bounded copy** of the provider home (auth + native sessions that pass §6.8),
not only `auth.json`.

The slot is a container bind-mount. **Every process in that workspace container can read
it while it is populated**, including a user `/bin/sh` terminal. First slice does not
claim harness-process-only access.

### 6.3 Layout and modes

```text
<agent-state-root>/
  harness-homes/
    <harnessId>/           # 0700, Agent-owned persistent home
      .lease/              # exclusive lease while materialized/live
        metadata.json      # 0600
      auth.json            # 0600 when present (Codex)
      sessions/            # provider-native, bounded
    <custom-id>/           # only if privateState.kind = "dedicated-home"
  harness-slots/
    <workspaceId>/         # 0700; bind-mounted; never a project path
  harness-meta/
    <workspaceId>.json     # slot owner: harnessId, generation, dirty/clean, leaseId
  harness-sessions/
    <aiSessionId>.json     # nativeSessionId, harnessId, processId, executableSource
```

Reuse existing private-state helpers: owner-owned `0700` directories, regular `0600`
files, `O_NOFOLLOW`, stable identity, atomic rename writeback.

### 6.4 First-slice isolation guarantee

State this and nothing stronger:

- Provider credentials and session stores never enter `/workspace` or Git.
- Only the currently selected harness/profile home is copied into the workspace slot.
- Unrelated harness homes are never mounted and are not present in the harness exec env.
- After a successful stop/writeback, the slot is emptied so a later shell does not keep
  leftover files.
- `CODEX_HOME` (and any other private-state env) is injected only on the harness Docker
  exec, not on `/bin/sh` terminals or tasks.
- Same-container processes **can** read a populated slot. That is not a first-slice
  isolation boundary.
- Owner-controlled / trusted workspace remains the threat-model assumption. Hostile
  same-UID isolation inside the container is deferred.

It is acceptable that the native harness can read its **own** credentials. Do not invent
a split-control architecture to hide a token from the CLI that must use it.

### 6.5 Login / bootstrap

On the generic path, login is the native CLI's own flow inside the PTY:

- Codex: `codex` device login / existing TUI auth, written into `CODEX_HOME`.
- Custom: whatever that CLI does, if anything.

The current isolated Codex credential bootstrap (`pnpm --filter @devspace/agent run
codex:bootstrap`) remains the bootstrap for the **structured app-server** path. The
generic path does not require it. A later slice may reuse that isolated bootstrap to
pre-seed `harness-homes/codex/` without a workspace, but it is not a first-slice
dependency.

Ambient host `~/.codex` and `~/.claude` are never read or mounted.

### 6.6 Exclusive harness-home lease

First slice has **one persistent home per `harnessId`** for the Agent, not one home per
workspace. Concurrent materialize/writeback from two workspaces would last-writer-wins
corrupt auth and native sessions. Therefore a home has an Agent-owned exclusive lease
while it is materialized or live.

This is a local filesystem lease on the Agent host, modeled on
`apps/agent/src/codex-credential-authority.ts` (`.lease` directory, `O_EXCL` create,
fail-closed). It is not a distributed lock, not etcd, not Docker labels as authority.

**Ownership.** The lease binds `{ harnessId, workspaceId, aiSessionId, processGeneration,
leaseId, acquiredAt, agentPid }`. The holder is that workspace's current native harness
generation.

**Acquisition.** Before copying home → slot:

1. If `privateState.kind = "none"`, no lease (no home).
2. Attempt exclusive `.lease` create under `harness-homes/<harnessId>/`.
3. On success, write metadata, then materialize.
4. If the lease already exists and names **this** workspace's current dirty/live
   generation, treat as re-acquire (Agent restart of the same holder).
5. If the lease names **another** workspace: reject with a stable conflict such as
   `HARNESS_HOME_IN_USE`. First-slice message: the Codex home/profile is already active
   in another workspace. Do not share, do not queue, do not steal.

**Release.** After successful writeback and slot clear, remove `.lease` using the same
retryable release pattern as Codex credential leases (prove the directory is gone).
Writeback/clear and lease release are ordered but independently crashable. Release is
idempotent. Do not release while the slot is still dirty.

**Crash / Agent-restart recovery.**

1. Enumerate dirty slots (`harness-meta` dirty/clean).
2. For each dirty slot, the recorded `harnessId` is the only allowed writeback target.
3. If a lease exists for that home:
   - same workspace holder → keep/re-acquire, write back, then continue;
   - other workspace holder with a still-dirty slot or live process → do not write this
     slot onto that home; fail closed and surface the conflict;
   - other workspace holder with **no** live process and **no** dirty slot (stale after
     a crash that already wrote back) → Agent may delete the stale lease and then
     write back **this** slot only if metadata says this slot owns those bytes. First
     slice should not need this case if writeback always precedes release.
4. After a successful writeback, run that built-in harness's discovery adapter against
   the **persistent home** (not the emptied slot).
5. Store a real native session ID if found. Invent nothing if not.
6. Clear the slot, then release the lease if no live process remains.
7. The DevSpace session stays `lost`.

**Stale lease handling.**

- A lease is stale only when Agent recovery can prove there is no live harness process
  for the holder workspace **and** that holder's slot is not dirty (the crash window
  after writeback/clear and before release).
- Proven stale leases are deleted by Agent recovery, after which another workspace may
  acquire.
- Do not expire leases by wall clock while a process may be live.
- Do not break a lease from a browser action other than stop/exit of the holder.
- Missing metadata with a `.lease` directory present is fail-closed until an operator
  follows a documented recovery; first slice does not auto-delete unexplained leases
  except the proven stale case above.

### 6.7 Writeback

On harness process exit, workspace stop, or Agent recovery of a dirty slot, and only
while holding the matching lease:

1. Validate the slot tree against §6.8.
2. Atomically replace `harness-homes/<harnessId>/` payload (excluding `.lease`) with the
   slot contents.
3. Clear the slot and mark metadata clean.
4. Release the lease.

Never write harness A slot bytes into harness B's home. If validation fails, keep the
previous persistent home, keep the dirty slot, keep the lease, and fail closed.

### 6.8 Private-home filesystem contract (slice 1)

Do not claim universal safe support for arbitrary provider homes. Slice 1 copies a
**bounded regular-file tree**. Codex is the only builtin that must pass this contract.

**Allowed:**

- directories
- regular files

**Rejected (fail closed, no skip, no follow):**

- symbolic links, including in-tree links
- device nodes, sockets, FIFOs, and other special files
- names with NUL, path separators, or `.` / `..` components
- any path that, after join, is not strictly inside the home/slot root

**Bounds:**

| Limit | Value |
| --- | ---: |
| max directory depth | 16 |
| max file count (regular files + dirs) | 4,096 |
| max individual file size | 32 MiB |
| max total tree size | 256 MiB |

**Copy semantics:**

- Materialize (home → slot) happens **before** the harness exec, with the lease held and
  no live process on that home.
- Writeback (slot → home) happens **after** the process is observed exited/lost, with
  the same lease held.
- Walk with `lstat` / `O_NOFOLLOW`. Never `stat` through a symlink.
- Host-side directories `0700`, files `0600` after copy. Do not preserve setuid/setgid.
- SQLite/WAL/lock files are copied as ordinary regular files if they pass the bounds.
  Slice 1 does not special-case databases. Copy only when the provider process is not
  running, so WAL recovery is the provider's problem on next start.

**Atomic writeback:**

1. Copy/validate into a sibling incoming directory under the same parent
   (`harness-homes/<harnessId>.incoming/`).
2. fsync files and directories.
3. Rename incoming over a `.<harnessId>.previous` rotation, then rename current home
   aside and incoming into place (same-directory rename). Keep `.lease` on the live
   home path; do not rotate the lease directory away.
4. After the new home is the live path, remove `.previous`.
5. Any failure before the live path points at the new tree leaves the previous home
   authoritative.

**Unsupported contents:** materialize or writeback fails with a stable bounded error
(`HARNESS_HOME_UNSUPPORTED` or equivalent). The harness does not start (materialize
failure) or does not settle clean (writeback failure). No silent truncation.

Later presets (Claude, Gemini, OpenCode) may need a different state strategy (for
example OpenCode SQLite). That is out of scope; do not extend this contract for them
now.

## 7. Concurrency

One live native harness PTY per workspace.

Additionally, one live materialization per persistent harness home (the exclusive lease).
Two workspaces cannot run Codex at the same time in slice 1.

Reasons:

- `/workspace` is one Git worktree; two coding agents writing it concurrently is not a
  product we will support in alpha.
- The slot can expose only one harness home at a time.
- The persistent home would corrupt under last-writer-wins writeback.
- M1 already serializes much workspace execution through one development container.

A second Start while one harness is live **in that workspace** is rejected. A Codex Start
while another workspace holds the Codex home lease is rejected with `HARNESS_HOME_IN_USE`.
Stop/exit, writeback, release, then the other workspace may start.

User-operated `/bin/sh` terminals may continue in parallel. They are not harnesses. They
**can** read a populated slot (§6.4). Empty the slot on harness stop.

Structured Codex app-server sessions: first slice forbids a live structured session and a
live native harness on the same workspace at the same time. The owner picks one runtime
kind. This avoids two Codex processes sharing or fighting one authority.

## 8. Native session ID and resume

### 8.1 What DevSpace persists vs what stays provider-native

**DevSpace / Web SQLite (public):**

- DevSpace session ID
- workspace / project / configuration identity
- `harnessId` and origin (`builtin` / `custom`)
- lifecycle: creating, live, disconnected, stopped, lost
- title, timestamps
- backing `terminalSessionId` / `processId`
- safe `executableSource.kind` and optional reported version

**Agent-private:**

- native provider session ID, when discovered
- slot ownership and home lease identity
- complete launch argv actually used
- artifact path/digest when the fallback source was used
- credential/home bytes

**Provider-native, not copied into DevSpace history:**

- conversation transcripts
- TUI scrollback beyond the existing 64 KiB PTY replay
- approvals, tool calls, models, token counts

`ai_sessions.external_session_id` exists but is unused and must remain unused for native
IDs. Native IDs do not enter SQLite, browser payloads, URLs, or logs.

### 8.2 How a native ID is obtained

Needed only for ID-substitution resume templates.

Priority:

1. Built-in discovery adapter after a process generation that used that harness home,
   including Agent-restart recovery **after** dirty-slot writeback (§9.3).
   Codex first-slice adapter: read only the persistent `$CODEX_HOME/sessions` (and
   `session_index.jsonl` if present), parse provider metadata/filenames already used by
   Codex, pick the newest session that belongs to this workspace cwd `/workspace`. If
   none, ID-substitution resume stays unavailable.
2. Later built-in adapters for other presets (out of scope).
3. Optional later custom file-basename adapter.
4. Never: stdout regex scraping as the default. Never: Web-generated UUIDs. Never: using
   the DevSpace session ID as a fake provider ID.

If discovery fails, Start still works. Provider-handled resume still works. ID-substitution
resume is absent from the safe capability projection.

### 8.3 Resume execution

Browser: `{ action: "resume", workspaceId, sessionId }` on the DevSpace session.

Agent:

1. Load the definition's resume argv and classify placeholders.
2. If `resume` is null, fail `AI_CAPABILITY_UNSUPPORTED`.
3. If zero placeholders: acquire lease if needed, materialize if needed, exec the resume
   argv unchanged. No native ID required.
4. If one `{sessionId}`: load the private native ID. If missing, fail closed and do not
   exec. Validate the ID (non-empty, ≤ 512 bytes, no ASCII controls, no leading `-`, no
   NUL). Substitute as exactly one argv token. Then lease, materialize, exec.
5. Docker exec the resume argv in a new PTY generation.

This is provider-native resume, not ADR 015's "restart a stopped structured session with
the same DevSpace history." DevSpace history on the generic path is the PTY attachment
plus native provider files, not canonical turn events.

### 8.4 Custom resume

Both forms are first-slice:

- `["--resume"]` → Resume is offered; the CLI selects/continues however it does.
- `["--resume", "{sessionId}"]` → Resume is offered only with a discovered ID; otherwise
  fail closed and do not exec.

Start with only executable + argv remains valid in both cases.

## 9. PTY, attach, reconnect, restart, and runtime identity

### 9.1 Reuse

Reuse as-is:

- `ExecutionManager` Docker exec + attach stream + 64 KiB replay
- F09 `devspace.terminal.v1` frames (input, resize, detach, ready, output, exit)
- Web terminal websocket proxy and xterm in the Workbench
- Lost-terminal detection after Agent restart
- Workspace stop reclaiming every exec
- Workspace stop/start as the bounded container recreate path

Extend:

- `createExec` command is the resolved harness argv, not `/bin/sh`
- execution kind `"harness"` (or terminal kind plus Agent-private harness metadata)
- environment includes only the selected private-state env
- slot populate/writeback and home lease around the process generation
- container inspection includes the harness slot mount

Do not insert a second PTY stack. Do not send harness bytes through F11 JSONL. Do not
`docker update` / bind-mount onto an already-created container.

### 9.2 Browser attach / reconnect

While Agent holds the exec stream:

- first attach receives `ready` then live output plus replay;
- detach does not kill the harness;
- Web restart reattaches the same terminal stream;
- exactly one attachment at a time, same as today.

### 9.3 Agent restart

Docker exec PTYs die with the Agent attach stream. First slice tells the truth:

```text
recover dirty slot
  → identify recorded harness owner
  → re-acquire or prove the exclusive home lease
  → validate slot against §6.8
  → atomically write back to that persistent home
  → run the built-in discovery adapter against the recovered persistent home
  → store a real native session ID if found (never invent)
  → clear the slot and release the lease
  → session remains lost
  → Resume becomes available if the template is provider-handled
    or if an ID was stored for an ID-substitution template
```

DevSpace does not claim the TUI process survived.

A later optional multiplexer (dtach/abduco/tmux) inside the container could keep the TUI
alive across Agent restart. It is not required and is not in the first slice.

### 9.4 Web restart

No process impact. SQLite and the Agent stream are the sources of truth. The browser
reloads and reattaches.

### 9.5 Stop

Preferred: the user exits the native TUI. The exec ends. Agent observes exit, writeback,
lease release, session `stopped`.

DevSpace Stop in the first slice:

- if the process has already exited, settle `stopped`;
- if M1 still cannot prove in-container PID ownership, do not pretend to have a safe
  individual kill; offer workspace stop as the forceful path, same as terminals today.

A later supervisor/wrapper may add safe harness stop. Do not block the generic PTY slice
on ADR 015's JSONL supervisor; that supervisor is the wrong process model.

### 9.6 Workspace container slot-mount identity

New workspace containers created after this slice include the slot bind-mount at create
time:

```text
Source: <stateRoot>/harness-slots/<workspaceId>
Target: /opt/devspace/harness-home
Type: bind, RW, rprivate
```

Existing development containers created before this slice have only `/workspace`. Docker
cannot add that mount later.

**Inspection.** Runtime inspection records a closed observation:

```text
harnessSlotMount:
  | { state: "present-and-exact", source: host-slot-path }
  | { state: "missing" }
  | { state: "mismatch" }   # wrong source, target, mode, or extra unexpected mounts
```

Infer from the live container, do not rewrite old ownership records:

- exactly one bind, `/workspace` at the owned worktree → `missing` (pre-slice container).
  Ordinary terminal/task inspect stays valid; this is not a workspace identity conflict.
- `/workspace` plus exact slot bind → `present-and-exact`. New containers created by this
  slice must match this shape or they are a conflict.
- any other mount set, wrong slot source, or docker.sock → `mismatch`.

`present-and-exact` requires the slot source to be the Agent-owned path for that
workspace ID, destination `/opt/devspace/harness-home`, bind, RW, rprivate, and still
exactly one `/workspace` worktree bind. No docker.sock. Ordinary workspace identity
checks otherwise unchanged.

**When the mount is required.** Builtin Codex and any `privateState.kind = "dedicated-home"`
harness require `present-and-exact` before materialize/exec. Custom `privateState.kind =
"none"` may start on an old container without the slot (there is no home to expose).
Newly created containers still get the slot so a later dedicated-home harness does not
need a second recreate.

**Reconcile.** If a required harness would start and the observation is `missing` or
`mismatch`:

1. Do not exec the harness.
2. Do not mutate mounts on the existing container.
3. Perform the existing bounded workspace stop then start, which allocates a new runtime
   generation and a new container from current `createContainer` policy (including the
   slot). This is the same path owners already use to rebuild a workspace runtime; live
   terminals on that workspace become lost, as today.
4. Re-inspect. If the slot is still not `present-and-exact`, fail closed.
5. Only then acquire the home lease and start the harness.

Do not recreate a running workspace merely because the code now knows about slots. Recreate
happens when a native harness **that needs the slot** is actually started.

## 10. Workbench

First slice AI tab for native sessions:

- harness picker: Codex builtin, plus custom definitions;
- Start / Resume / disconnect;
- Resume enabled when `capabilities.resume` is true (provider-handled templates, or
  ID-substitution with a stored native ID);
- xterm attached to the harness PTY, reusing `TerminalTab` machinery;
- truthful executable-source kind/version when present;
- no turn composer, no approval cards, no fake transcript.

The current structured Codex tab remains available as the legacy runtime kind until
migration. The Workbench must not mix one session's structured cards with another
session's PTY without an explicit runtime-kind switch.

Approvals and questions on the generic path happen inside the native TUI. That is the
point of hosting the real CLI.

Changed files: use the existing Changes tab. Do not parse TUI output for paths in the
first slice.

## 11. Answers to the design questions

1. **Where does the native harness process run?** In the exact workspace development
   container, Docker exec, TTY on, cwd `/workspace`.
2. **How does it get the exact project/workspace environment?** It is the same container
   that already has the worktree, volumes, runtime-plan env, and network. No second
   runtime. The slot mount is additional and required only for dedicated-home harnesses.
3. **Where are credentials/state stored?** Agent-private
   `<stateRoot>/harness-homes/<harnessId>/`, never `/workspace`.
4. **How are only the correct credentials exposed?** One per-workspace slot; materialize
   only the selected home under an exclusive home lease; inject only that harness's env
   on the harness exec. Same-container shells can still read a populated slot.
5. **Login/auth bootstrap?** Native CLI login in the PTY writes into the private home.
   Existing Codex bootstrap stays for the structured path.
6. **Native session discovery?** Tiny built-in adapters over the selected persistent home,
   including after Agent-restart writeback. Codex in slice 1. No fake IDs. No host-home
   scans.
7. **Resume?** Structured resume argv. Zero placeholders: offered without an ID. One
   `{sessionId}`: offered only with a real native ID. Invalid templates rejected.
8. **What DevSpace persists vs provider-native?** DevSpace: session control plane, PTY
   lifecycle, safe executable-source kind. Provider: conversation and auth. Native IDs
   stay Agent-private.
9. **Custom harness without discovery?** Launch works. Provider-handled resume works.
   ID-substitution resume is not offered.
10. **Browser attach/reconnect?** Existing terminal websocket, one attachment, replay
    buffer, detach without kill.
11. **After Agent/Web restart?** Web restart reattaches. Agent restart loses the exec,
    writebacks the slot under the lease, discovers a native ID if possible, then Resume
    follows §8.3.
12. **Multiple harness profiles?** Separate definition rows; browser sends `harnessId`.
    Slice 1: Codex + one custom. Lease is per persistent home/`harnessId`.
13. **Two harnesses on one workspace?** Alternating yes; concurrent live PTYs no. Two
    workspaces cannot share one Codex home; second Start is `HARNESS_HOME_IN_USE`. No
    mixing with a live structured Codex session on the same workspace.
14. **Start/resume without shell injection?** Structured `{executable, args[]}` only.
    `{sessionId}` is a whole argv token or is absent.
15. **Env/secrets?** Literals + Agent-injected private-state env. No secret-ids in slice
    1. No host env passthrough.
16. **Codex-specific machinery to retire eventually?** See §13.
17. **Generic components to reuse?** See §12.
18. **Smallest useful alpha?** Section 3 MUST HAVE list.

## 12. Reuse

| Component | Role |
| --- | --- |
| Managed workspace container + `/workspace` bind | Exact project runtime |
| Workspace stop/start (new generation) | Recreate containers that lack the slot |
| `DockerEngineClient.createExec` / `startExecAttached` / `resizeExec` | PTY transport |
| `ExecutionManager` attach, replay, lost-on-Agent-restart | Session process |
| F09 `devspace.terminal.v1` | Browser bytes |
| Web terminal proxy + xterm `TerminalTab` | UI |
| `private-state.ts` helpers | Homes, slots, metadata |
| Codex `.lease` exclusive-directory pattern | Harness-home lease |
| Codex artifact staging | Fallback executable source only |
| Existing terminal/session SQLite tables | Public lifecycle |
| `ai_sessions.terminal_session_id` | Bind native session to PTY |
| Project Options command argv shape | Definition schema precedent |
| ADR 009, threat model host boundary | Security baseline |

## 13. Eventually unnecessary Codex-specific machinery

Once the generic native path is the default and the structured path is turned off:

- `apps/agent/src/codex-app-server/**` JSONL adapter, discovery-as-session-authority,
  fake provider
- F11 canonical turn/event/outbox pipeline as the user-visible conversation
- in-container JSONL supervisor / control socket
- Workbench turn cards, approval cards, structured-input cards
- `profileRevision` hashing of app-server protocol fingerprints as launch authority
- ephemeral `CODEX_HOME` that stages only `auth.json` and discards native sessions
- Codex Code Mode, exec-server, app-server remote control (never productized)

Keep after retirement if still useful:

- Codex artifact identity/staging as the **fallback** executable source
- isolated bootstrap as an optional way to seed `harness-homes/codex/`
- Agent-private file conventions and exclusive `.lease` pattern
- PTY/terminal stack

Do not preserve ADR 015 machinery merely because it exists. Preserve it until the native
path is proven, then retire it on purpose.

## 14. Staged migration

Do not perform this migration in the design task.

**Stage 0 — now (design only).** This spec and plan. Structured Codex remains default.

**Stage 1 — first generic slice.** Native Codex PTY + custom harness, parallel to
structured Codex. Feature is explicit in the Workbench (native vs legacy). No deletion.

**Stage 2 — additional presets.** Claude Code, then Gemini CLI, then OpenCode if the
image contains the CLI and a bounded state strategy exists. Same runtime. Separate
plans; not this one.

**Stage 3 — default switch.** New sessions default to native PTY. Structured path is
opt-in legacy. Historical structured sessions remain readable.

**Stage 4 — retire structured path.** Stop launching app-server. Remove F11 conversation
pipeline from the default Workbench. Keep SQLite history readable or archive. Draft ADR
016 that records native harnesses as the accepted architecture and marks ADR 015
historical.

No automated cutover of old structured transcripts into fake native sessions.

## 15. Security boundaries (preserved)

- No Agent socket in the workspace container.
- No rootless Docker socket in the workspace container.
- No host filesystem except the single harness slot bind-mount (when the container was
  created with it).
- No other workspace's worktree or slot.
- No unrelated harness home in the slot or harness exec environment.
- No provider auth in `/workspace` or Git.
- Private host files stay `0700`/`0600`, Agent-owned.
- Persistent homes are exclusively leased while materialized/live.
- Project Git Fetch/Push remains the existing Agent/Web GitHub App path; the harness may
  use Git inside `/workspace` as a user shell already can.
- Browser never supplies argv strings, host paths, or native IDs.

Trusted owner-controlled repositories remain the threat-model assumption. Hostile
same-UID isolation inside the container is deferred, as today. A populated slot is
readable by other processes in that container.

## 16. Durable documentation impact (later implementation, not this task)

When Stage 1 is implemented, the implementing change should:

- draft ADR 016 (generic native harnesses) as the product target;
- keep ADR 015 accepted for the still-shipped structured path until Stage 4;
- extend `docs/specs/` with a harness-session contract rather than overloading
  `ai-sessions-v1.md` silently;
- update `docs/architecture.md` process/terminal/AI sections;
- leave Project Options `aiProfile` dormant until a later slice points it at `harnessId`.

This design task does not edit those durable authorities.

## 17. Unresolved questions

These are recorded, not silently decided, and none block slice 1:

1. **Safe individual Stop.** Slice 1 does not add a new supervisor. Whether M2 process
   supervision should cover harness PTYs is an independent later decision.
2. **Per-workspace homes vs one global home per harnessId.** Slice 1 keeps one home per
   harnessId plus exclusive lease. Per-workspace homes would remove the cross-workspace
   reject but would also split auth; that is a later product call.
3. **Custom file-basename discovery.** Later, not slice 1.
4. **OpenCode / Claude / Gemini persistence.** Out of scope until those presets are
   designed against a possibly different state strategy.
5. **Default Workbench switch.** Stage 3 timing is a product call after slice 1 dogfood.
6. **Hide-mount for populated slots.** Optional later; not required to ship slice 1.

Decided in this correction pass (no longer open):

- Custom resume without a DevSpace-discovered ID is supported when the template has zero
  `{sessionId}` placeholders.
- Persistent homes are exclusively leased; concurrent multi-workspace writeback is
  rejected.
- Agent-restart recovery must run discovery after writeback.
- Credential claims match the container boundary (slot visible to same-container
  processes).
- Old containers without the slot cannot launch a dedicated-home harness; recreate uses
  existing stop/start.
- Builtin Codex prefers image `PATH`, artifact is fallback, source is recorded.
- Slice 1 filesystem contract is the bounded regular-file tree in §6.8.

## 18. Key decisions

1. **Generic native PTY is the product architecture.** Structured Codex app-server becomes
   a compatibility path, then is retired. Rationale: the product must host arbitrary CLIs;
   JSONL-per-provider cannot.
2. **One runtime, presets as data.** Codex/custom share argv + slot + PTY. Later presets
   do not fork the runtime. Rationale: YAGNI.
3. **Process in the workspace container, not a sidecar.** Rationale: exact project
   environment; split-execution is Codex-specific and failed as a generic strategy.
4. **One slot bind-mount per workspace, exclusive lease per persistent home.** Rationale:
   Docker cannot mount per-exec; last-writer-wins writeback is unacceptable.
5. **Structured argv, never shell strings.** Rationale: injection; DevSpace already has
   this shape for tasks.
6. **Native IDs stay Agent-private and are never invented.** Provider-handled resume does
   not need one. ID-substitution resume fails closed without one.
7. **One live native harness per workspace, and one live home lease per harnessId.**
   Rationale: one worktree, one slot, one durable home.
8. **Agent restart loses the PTY; writeback + discovery recover a provider ID when
   possible; native resume recovers the provider session.** Rationale: honest about
   Docker exec; avoids a multiplexer in the first slice.
9. **Approvals stay in the native TUI on this path.** Rationale: do not rebuild
   provider UX; do not require a universal event schema.
10. **Image `codex` wins when present; Agent artifact is fallback.** Rationale: do not
    version-pin the generic path.
11. **Slice 1 copies a bounded regular-file tree only.** Rationale: implementable; no
    false claim of universal home support.
12. **Do not merge or continue the Code Mode / split-execution branches.** Rationale:
    they optimize a Codex-specific boundary the generic product does not need.
