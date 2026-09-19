# Generic native AI-harness architecture

- Status: Design (not yet accepted as an ADR)
- Date: 2026-09-19
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
5. Only the selected harness's private state is visible to that process.
6. Native start via structured argv, never a shell string.
7. Native resume when a real native session ID can be obtained; otherwise resume is
   unavailable.
8. Browser attach and reconnect while the Agent still holds the Docker-exec stream.
9. After Agent restart, the live process is lost; Resume is offered only if a real native
   ID was recorded.
10. No unrelated harness credentials in the process environment, slot, or project root.

The first slice is useful when an owner can start Codex in the Workbench, use the real TUI,
disconnect and reconnect, quit, and resume the same native Codex session, and can also
start a custom command the same way without Codex credentials leaking into it.

### LATER / OPTIONAL INTEGRATIONS

Not in the first slice:

- Built-in Claude Code, Gemini CLI, and OpenCode presets (designed below, implemented later).
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

## 4. Evidence used

### 4.1 Current DevSpace on main

Inspected at `72b52aae73afd169cc7a32271b53021a78c808ef`:

- Workspace development containers already bind only the worktree at `/workspace` and run
  as the image user (`apps/agent/src/docker-runtime.ts`).
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
- Project Options `aiProfile.fixedArgs` / `credentialSecretIds` remain dormant and must
  stay non-executable.

### 4.2 Orca at `caa465d1da886b2697c85c18bf36f79f2d3b9e68`

Adopt as ideas, not as architecture:

| Adopt | Do not copy |
| --- | --- |
| Built-in agents are launch/resume presets over one PTY mechanism | Orca's 30+ TUI catalog as DevSpace first-class types |
| Real native CLI in a PTY; do not fake the conversation UI | Typing resume commands into a user shell |
| Resume uses the provider's native ID (`codex resume <id>`, `claude --resume <id>`) | Shell-string concatenation and quoting matrices |
| Discover native IDs from the provider's own session store | Full "AI vault" transcript search/index as baseline |
| Per-agent private home via `CODEX_HOME` / config-dir env | Scanning the operator's real `~/.codex` on the host |
| Sanitize native IDs (bounded, no controls, no leading `-`) | Prompt injection, OSC hooks, native-chat overlay |
| Custom command is a first-class launch | WSL/SSH/Windows host-routing complexity |
| One live agent pane per workspace is the safe default | Plugin overlay that mirrors unrelated agent homes |

Orca's resume path is a quoted shell line queued into an existing pane. DevSpace already
has structured exec argv and must use that instead. Orca's session scanners are large
provider-specific parsers; DevSpace should keep tiny built-in discovery adapters and skip
resume when discovery is not reliable.

### 4.3 Feasibility branches (research only)

The Codex split-execution and Code Mode worktrees remain evidence that hiding credentials
from the process that must use them requires a provider-specific remote-execution protocol.
That is the opposite of generic harness support. Those branches are not merged and are not
the migration path.

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
  + Agent-private native metadata (native session ID, slot ownership)
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
- the workspace network.

It does not run on the Agent host. It does not run in a control sidecar. It does not
receive the Agent Unix socket, the rootless Docker socket, other workspaces, or host
filesystem paths except the single Agent-owned harness slot described in §6.

### 5.3 Generic harness model

A harness is a named, versioned definition. Built-ins are Agent-owned presets. Custom
definitions are owner-managed desired state in SQLite; Agent validates and executes them.

```text
HarnessDefinition
  id: ConfigurationKey            # e.g. "codex", "claude", "custom-my-agent"
  displayName: bounded string
  origin: "builtin" | "custom"
  launch: Argv                    # executable + args, no shell
  resume: ArgvTemplate | null     # same, with at most one "{sessionId}" token
  privateState: PrivateStatePolicy
  environment: EnvBinding[]       # first slice: literals only
  sessionDiscovery: DiscoveryAdapter | null
  executableSource: "image-path" | "agent-artifact"   # Codex uses agent-artifact
```

This is smaller than the brainstorm field list. Capabilities are derived, not declared:

- `start` if launch argv is valid and the executable can be resolved;
- `resume` if `resume` is non-null **and** a real native session ID is currently known;
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

`executable` is a single path component (`codex`, `claude`, `my-agent`) or, later, a
policy-checked container path. Host paths, NUL, shell metacharacters, and empty
executables are rejected.

Resume templates are argv, not strings:

```text
Codex builtin:
  launch: { executable: "codex", args: [] }
  resume: { executable: "codex", args: ["resume", "{sessionId}"] }

Custom example:
  launch: { executable: "my-agent", args: [] }
  resume: { executable: "my-agent", args: ["--resume", "{sessionId}"] }
```

`{sessionId}` is a whole-token placeholder only. It is not interpolated inside another
token. Substitution inserts the native ID as exactly one argv element after validation
(§8). No `sh -c`, no string join, no Orca-style `cd … && CODEX_HOME=… cmd`.

Working directory is always `/workspace`. A custom harness does not choose a host cwd.

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

| Preset | Launch | Resume | Private-state env | Discovery (later if not first slice) |
| --- | --- | --- | --- | --- |
| Codex | `codex` | `codex resume {sessionId}` | `CODEX_HOME` = slot | `$CODEX_HOME/sessions/**/*.jsonl` and/or `session_index.jsonl` |
| Claude Code | `claude` | `claude --resume {sessionId}` | `HOME` or `CLAUDE_CONFIG_DIR` = slot | `$HOME/.claude/projects/**/*.jsonl` |
| Gemini CLI | `gemini` | `gemini --resume {sessionId}` | `HOME` = slot (sessions under `~/.gemini/tmp`) | later; skip if unreliable |
| OpenCode | `opencode` | `opencode --session {sessionId}` | `OPENCODE_CONFIG_DIR` = slot | later; OpenCode uses SQLite, do not parse it in slice 1 |

First slice implements **Codex only** plus custom. The table exists so later presets do
not fork the runtime.

Codex executable source is the existing Agent-managed artifact, staged into the workspace
container the same way app-server staging already does, then exec'd as the TUI rather than
`app-server`. Custom executables come from the image `PATH`. Missing executable is an
availability observation, not a crash.

### 5.5 Custom harnesses

A custom harness is the generic mechanism with no preset adapter.

Minimum:

- `launch.executable` + `launch.args`
- optional `resume` argv template
- `privateState: { kind: "none" }` by default
- no environment secrets
- `sessionDiscovery: null`

If resume is omitted or no native ID is known, the Workbench offers Start and does not
offer Resume. DevSpace does not invent an ID to make the custom harness look resumable.

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
browser sends is `harnessId`. Multiple named profiles of the same harness (for example two
Codex argument sets) are a later convenience, implemented as additional definition rows,
not a second abstraction.

## 6. Credential and private-state model

### 6.1 Principle

```text
project / Git / container worktree:     /workspace
Agent-private harness homes:            <agent-state-root>/harness-homes/<harnessId>/
per-workspace active slot (bind mount): <agent-state-root>/harness-slots/<workspaceId>/
                                        → container /opt/devspace/harness-home
```

Never place provider auth files, session stores, or API keys in the project root.

### 6.2 Why a slot instead of mounting every home

Docker exec cannot add mounts. Mounts exist for the container lifetime. If the Agent
bind-mounted the entire `harness-homes/` tree, a Codex process could read Claude
credentials. That violates the isolation requirement.

Therefore each workspace container receives **one** Agent-owned slot directory. Only the
currently selected harness's files are materialized into that slot before launch. Other
harness homes stay on the Agent host and are not visible in the container.

This is the generic replacement for ADR 015's ephemeral `CODEX_HOME` staging. The
difference: the slot holds the **complete** provider home (auth + native sessions), not
only `auth.json`, because the native TUI needs its own history.

### 6.3 Layout and modes

```text
<agent-state-root>/
  harness-homes/
    codex/                 # 0700, Agent-owned
      auth.json            # 0600 when present
      sessions/            # provider-native
      ...
    claude/
    <custom-id>/           # only if privateState.kind = "dedicated-home"
  harness-slots/
    <workspaceId>/         # 0700; bind-mounted; never a project path
  harness-meta/
    <workspaceId>.json     # slot owner: harnessId, generation, dirty/clean
  harness-sessions/
    <aiSessionId>.json     # Agent-private: nativeSessionId, harnessId, processId
```

Reuse existing private-state helpers: owner-owned `0700` directories, regular `0600`
files, `O_NOFOLLOW`, stable identity, atomic rename writeback.

### 6.4 Exposure rules

When launching harness H:

1. Acquire the workspace harness slot.
2. If the slot is owned by a different harness, write back and clear it first.
3. Materialize only `harness-homes/H/` into the slot.
4. Exec with only H's private-state env pointing at `/opt/devspace/harness-home`.
5. Do not set `CODEX_HOME` for Claude, `CLAUDE_CONFIG_DIR` for Codex, or any other
   harness's env.
6. Custom with `privateState.kind = "none"` gets no slot env and no home files.

It is acceptable that the native process can read its **own** credentials. Do not invent
a split-control architecture to hide a token from the CLI that must use it. Owner-only
beta already accepts that other processes in the same trusted container (a user shell)
could read the slot while it is populated. Empty the slot after a clean harness stop so
a later shell does not keep leftover auth.

### 6.5 Login / bootstrap

On the generic path, login is the native CLI's own flow inside the PTY:

- Codex: `codex` device login / existing TUI auth, written into `CODEX_HOME`.
- Claude: `claude` login, written into the Claude home.
- Custom: whatever that CLI does, if anything.

The current isolated Codex credential bootstrap (`pnpm --filter @devspace/agent run
codex:bootstrap`) remains the bootstrap for the **structured app-server** path. The
generic path does not require it. A later slice may reuse that isolated bootstrap to
pre-seed `harness-homes/codex/` without a workspace, but it is not a first-slice
dependency.

Ambient host `~/.codex` and `~/.claude` are never read or mounted.

### 6.6 Writeback

On harness process exit, workspace stop, or Agent recovery of a dirty slot:

1. Validate slot files with the existing no-follow / mode / owner checks, bounded size.
2. Atomically replace `harness-homes/<harnessId>/` with the slot contents.
3. Clear the slot and its ownership record.

A crashed Agent may find a dirty slot. Recovery writes it back to the recorded owner
harness, then leaves the slot empty. Never write harness A slot bytes into harness B's
home.

## 7. Concurrency

One live native harness PTY per workspace.

Reasons:

- `/workspace` is one Git worktree; two coding agents writing it concurrently is not a
  product we will support in alpha.
- The slot can expose only one harness home at a time.
- M1 already serializes much workspace execution through one development container.

A second Start while one harness is live is rejected. Stop/exit, then start the other.
Private homes remain independent, so Codex and Claude can alternate on the same workspace
without sharing credentials.

User-operated `/bin/sh` terminals may continue in parallel. They are not harnesses. A
later policy may warn that a shell can see a populated slot; first slice documents this
and empties the slot on harness stop.

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

**Agent-private:**

- native provider session ID, when discovered
- slot ownership
- complete launch argv actually used
- credential/home bytes

**Provider-native, not copied into DevSpace history:**

- conversation transcripts
- TUI scrollback beyond the existing 64 KiB PTY replay
- approvals, tool calls, models, token counts

`ai_sessions.external_session_id` exists but is unused and must remain unused for native
IDs. Native IDs do not enter SQLite, browser payloads, URLs, or logs.

### 8.2 How a native ID is obtained

Priority:

1. Built-in discovery adapter after a process generation that used that harness home.
   Codex first-slice adapter: read only `$CODEX_HOME/sessions` (the slot/home), parse
   provider metadata/filenames already used by Codex, pick the newest session that belongs
   to this workspace cwd `/workspace`. If none, resume stays unavailable.
2. Later built-in adapters for Claude/Gemini/OpenCode.
3. Optional later custom file-basename adapter.
4. Never: stdout regex scraping as the default. Never: Web-generated UUIDs. Never: using
   the DevSpace session ID as a fake provider ID.

If discovery fails, Start still works. Resume is absent from the safe capability
projection.

### 8.3 Resume execution

Browser: `{ action: "resume", workspaceId, sessionId }` on the DevSpace session.

Agent:

1. Load the private native ID for that session.
2. Validate: non-empty, ≤ 512 bytes, no ASCII controls, no leading `-`, no NUL, exact
   token (Orca's sanitizer, minus shell quoting).
3. Substitute `{sessionId}` in the resume argv template.
4. Materialize that harness home into the slot.
5. Docker exec the resume argv in a new PTY generation.

This is provider-native resume, not ADR 015's "restart a stopped structured session with
the same DevSpace history." DevSpace history on the generic path is the PTY attachment
plus native provider files, not canonical turn events.

### 8.4 Custom resume without discovery

A custom definition may include a resume template for later. First slice still stores it,
but `resume` stays false until a native ID exists. There is no UI to paste a native ID in
the first slice (that would put private-plane data on the browser). Owners who need custom
resume in alpha can wait for a discovery adapter or run the CLI's own resume inside a
normal terminal.

## 9. PTY, attach, reconnect, restart

### 9.1 Reuse

Reuse as-is:

- `ExecutionManager` Docker exec + attach stream + 64 KiB replay
- F09 `devspace.terminal.v1` frames (input, resize, detach, ready, output, exit)
- Web terminal websocket proxy and xterm in the Workbench
- Lost-terminal detection after Agent restart
- Workspace stop reclaiming every exec

Extend:

- `createExec` command is the resolved harness argv, not `/bin/sh`
- execution kind `"harness"` (or terminal kind plus Agent-private harness metadata)
- environment includes only the selected private-state env
- slot populate/writeback around the process generation

Do not insert a second PTY stack. Do not send harness bytes through F11 JSONL.

### 9.2 Browser attach / reconnect

While Agent holds the exec stream:

- first attach receives `ready` then live output plus replay;
- detach does not kill the harness;
- Web restart reattaches the same terminal stream;
- exactly one attachment at a time, same as today.

### 9.3 Agent restart

Docker exec PTYs die with the Agent attach stream. First slice tells the truth:

- session becomes `lost`;
- slot writeback runs from whatever files remain on the host slot;
- if a native ID is known, Resume is available;
- DevSpace does not claim the TUI process survived.

A later optional multiplexer (dtach/abduco/tmux) inside the container could keep the TUI
alive across Agent restart. It is not required to prove the generic architecture and is
not in the first slice.

### 9.4 Web restart

No process impact. SQLite and the Agent stream are the sources of truth. The browser
reloads and reattaches.

### 9.5 Stop

Preferred: the user exits the native TUI. The exec ends. Agent observes exit, writeback,
session `stopped`.

DevSpace Stop in the first slice:

- if the process has already exited, settle `stopped`;
- if M1 still cannot prove in-container PID ownership, do not pretend to have a safe
  individual kill; offer workspace stop as the forceful path, same as terminals today.

A later supervisor/wrapper may add safe harness stop. Do not block the generic PTY slice
on ADR 015's JSONL supervisor; that supervisor is the wrong process model.

## 10. Workbench

First slice AI tab for native sessions:

- harness picker: Codex builtin, plus custom definitions;
- Start / Resume (Resume disabled when unknown native ID) / disconnect;
- xterm attached to the harness PTY, reusing `TerminalTab` machinery;
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
   runtime.
3. **Where are credentials/state stored?** Agent-private
   `<stateRoot>/harness-homes/<harnessId>/`, never `/workspace`.
4. **How are only the correct credentials exposed?** One per-workspace slot bind-mount;
   materialize only the selected home; inject only that harness's env vars.
5. **Login/auth bootstrap?** Native CLI login in the PTY writes into the private home.
   Existing Codex bootstrap stays for the structured path.
6. **Native session discovery?** Tiny built-in adapters over the selected home. Codex in
   slice 1. No fake IDs. No host-home scans.
7. **Resume?** Structured resume argv with a validated native ID as one token. Unavailable
   without an ID.
8. **What DevSpace persists vs provider-native?** DevSpace: session control plane and
   PTY lifecycle. Provider: conversation and auth. Native IDs stay Agent-private.
9. **Custom harness without discovery?** Launch works. Resume is not offered.
10. **Browser attach/reconnect?** Existing terminal websocket, one attachment, replay
    buffer, detach without kill.
11. **After Agent/Web restart?** Web restart reattaches. Agent restart loses the exec;
    Resume uses the native ID if known.
12. **Multiple harness profiles?** Separate definition rows; browser sends `harnessId`.
    Slice 1: Codex + one custom.
13. **Two harnesses on one workspace?** Alternating yes; concurrent live PTYs no. One
    live native harness per workspace. No mixing with a live structured Codex session.
14. **Start/resume without shell injection?** Structured `{executable, args[]}` only.
    `{sessionId}` is a whole argv token.
15. **Env/secrets?** Literals + Agent-injected private-state env. No secret-ids in slice
    1. No host env passthrough.
16. **Codex-specific machinery to retire eventually?** See §13.
17. **Generic components to reuse?** See §12.
18. **Smallest useful alpha?** Section 3 MUST HAVE list.

## 12. Reuse

| Component | Role |
| --- | --- |
| Managed workspace container + `/workspace` bind | Exact project runtime |
| `DockerEngineClient.createExec` / `startExecAttached` / `resizeExec` | PTY transport |
| `ExecutionManager` attach, replay, lost-on-Agent-restart | Session process |
| F09 `devspace.terminal.v1` | Browser bytes |
| Web terminal proxy + xterm `TerminalTab` | UI |
| `private-state.ts` helpers | Homes, slots, metadata |
| Codex artifact staging | Builtin Codex executable |
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

- Codex artifact identity/staging (as the Codex preset's executable source)
- isolated bootstrap as an optional way to seed `harness-homes/codex/`
- Agent-private file conventions
- PTY/terminal stack

Do not preserve ADR 015 machinery merely because it exists. Preserve it until the native
path is proven, then retire it on purpose.

## 14. Staged migration

Do not perform this migration in the design task.

**Stage 0 — now (design only).** This spec and plan. Structured Codex remains default.

**Stage 1 — first generic slice.** Native Codex PTY + custom harness, parallel to
structured Codex. Feature is explicit in the Workbench (native vs legacy). No deletion.

**Stage 2 — additional presets.** Claude Code, then Gemini CLI, then OpenCode if the
image contains the CLI and discovery is reliable. Same runtime.

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
- No host filesystem except the single harness slot bind-mount.
- No other workspace's worktree or slot.
- No unrelated harness home in the slot or environment.
- No provider auth in `/workspace` or Git.
- Private host files stay `0700`/`0600`, Agent-owned.
- Project Git Fetch/Push remains the existing Agent/Web GitHub App path; the harness may
  use Git inside `/workspace` as a user shell already can.
- Browser never supplies argv strings, host paths, or native IDs.

Trusted owner-controlled repositories remain the threat-model assumption. Hostile
same-UID isolation inside the container is deferred, as today.

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

These are recorded, not silently decided:

1. **Codex artifact vs image `codex`.** Slice 1 uses the Agent-managed Codex artifact so
   a stock image still works. If a workspace image also ships `codex`, the artifact wins
   for the builtin preset to keep identity bounded. Revisit if artifact/TUI version skew
   becomes a product issue.
2. **Safe individual Stop.** Slice 1 does not add a new supervisor. Whether M2 process
   supervision should cover harness PTYs is an independent later decision.
3. **Slot visibility from user shells.** Documented and accepted for owner-only beta;
   emptying on stop is the mitigation. A later hide-mount is optional.
4. **Custom discovery.** File-basename adapter is designed as later, not slice 1.
5. **OpenCode SQLite session store.** Do not take a SQLite dependency in slice 1. The
   OpenCode preset waits until a small adapter is justified.
6. **Default Workbench switch.** Stage 3 timing is a product call after slice 1 dogfood.

None of these block writing or implementing the first generic slice.

## 18. Key decisions

1. **Generic native PTY is the product architecture.** Structured Codex app-server becomes
   a compatibility path, then is retired. Rationale: the product must host arbitrary CLIs;
   JSONL-per-provider cannot.
2. **One runtime, presets as data.** Codex/Claude/Gemini/OpenCode/custom share argv + slot
   + PTY. Rationale: YAGNI; avoids a provider plugin framework.
3. **Process in the workspace container, not a sidecar.** Rationale: exact project
   environment; split-execution is Codex-specific and failed as a generic strategy.
4. **One slot bind-mount per workspace.** Rationale: Docker cannot mount per-exec; this is
   the simplest way to expose only one harness home.
5. **Structured argv, never shell strings.** Rationale: injection; DevSpace already has
   this shape for tasks.
6. **Native IDs stay Agent-private and are never invented.** Rationale: preserve provider
   semantics; custom harnesses may simply not resume.
7. **One live native harness per workspace.** Rationale: one worktree, one slot.
8. **Agent restart loses the PTY; native resume recovers the provider session.**
   Rationale: honest about Docker exec; avoids a multiplexer in the first slice.
9. **Approvals stay in the native TUI on this path.** Rationale: do not rebuild
   provider UX; do not require a universal event schema.
10. **Do not merge or continue the Code Mode / split-execution branches.** Rationale:
    they optimize a Codex-specific boundary the generic product does not need.
