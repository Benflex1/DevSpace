# Codex CLI Sidecar Architecture

## Status

Approved architectural design for replacing DevSpace's structured Codex app-server experience with a native Codex CLI/TUI path. Implementation is intentionally blocked on the security feasibility gate in this document.

This design records explicit current product decisions. It does not yet delete or silently supersede ADR 015, `docs/specs/ai-sessions-v1.md`, or the current structured implementation. Those remain the shipped authority until the replacement proves the required security and lifecycle behavior and DevSpace deliberately updates its durable AI-session authorities.

The implementation plan must preserve the current structured path as fallback evidence until the native CLI path has passed real dogfood and the switch-over criteria below.

## Goal

Make the actual Codex CLI the primary DevSpace AI experience rather than wrapping Codex in a parallel DevSpace conversation protocol.

The browser should display a real interactive Codex TUI backed by an Agent-owned PTY. DevSpace owns workspace/runtime/container/PTY authority and lightweight session navigation. Codex owns prompts, responses, approvals, questions, conversation history, native session IDs, authentication state, configuration, and native resume semantics.

The desired user model is intentionally close to opening several terminals and running `codex` in each one, with DevSpace adding secure workspace binding, browser attachment, persistence of session associations, and native resume.

## Product principles

### Native CLI is the product surface

`+ New Codex` launches bare `codex` in an interactive PTY. DevSpace does not provide a custom prompt box, inject an initial prompt, type hidden commands into the TUI, synthesize approvals or questions, or mirror turns into a second chat UI.

Future custom skills or provider-native extensions may be supported when Codex itself consumes them. DevSpace does not emulate the user by injecting prompt text.

### DevSpace provides truthful isolation, not behavioral babysitting

Multiple Codex agents may run concurrently in the same workspace. They intentionally share the same worktree in the first version. If two agents edit the same files or otherwise interfere with each other, that is the expected consequence of the user's choice.

DevSpace must not add a one-agent-per-workspace lock, global provider lease, or warning gate merely to prevent user-selected concurrent work.

Automatic worktree-per-agent isolation is a future convenience, not a prerequisite for concurrency.

DevSpace may prevent duplicate execution of the exact same native Codex session when it can prove that session is already running. That is lifecycle integrity rather than behavioral policy.

## Architecture

The primary path is:

```text
authenticated browser
        |
        v
Web application
        |
        v
Workspace Agent
        |
        v
workspace-scoped Codex sidecar
  |- exact project runtime image
  |- exact /workspace worktree
  |- exact Git administration required by that worktree
  |- shared private native CODEX_HOME for this DevSpace user/account
  `- multiple independent Docker exec PTYs
       |- codex
       |- codex
       `- codex resume <native-session-id>
```

The Web application remains the browser-facing authority and sole SQLite writer. It never invokes Git, shell commands, Docker, or Codex directly.

The Agent remains the only component that manages the dedicated rootless Docker runtime, exact managed workspace/container identity, PTYs, provider sidecars, provider process lifecycle, and private host paths.

The selected AI Workbench session renders the actual terminal stream through the existing xterm/terminal transport rather than a DevSpace-created conversation surface.

## Sidecar model

### One sidecar per workspace runtime

Each workspace may have one DevSpace-managed Codex sidecar container for the active runtime generation. The sidecar uses the exact same project/runtime image as the normal development container.

A workspace sidecar may host any number of concurrent Codex Docker exec PTYs. Starting another Codex session creates another exec/PTY, not another workspace sidecar.

A sidecar is an execution/security boundary, not the native conversation boundary. Native Codex sessions remain independent even when they share the same sidecar and native home.

### Exact runtime image

The Codex sidecar uses the exact project runtime image selected for the workspace. DevSpace may inject or mount the trusted Codex executable and DevSpace-controlled launch support without modifying the project image.

DevSpace must not silently fall back to a generic AI runner image when the project image cannot execute the admitted Codex artifact or cannot provide the required sandbox. Such a runtime is reported as incompatible for managed Codex CLI use.

This preserves toolchain parity between the project runtime and Codex: package managers, compilers, runtimes, shell tools, and project dependencies should match the environment in which the application itself runs.

### Mounts

The Codex sidecar receives only the resources required for the exact workspace and native Codex runtime:

```text
/workspace
  exact managed workspace worktree, read/write

exact Git administration
  only the project bare repository/worktree administration required for this
  /workspace Git worktree to behave as the real repository

/codex-home
  shared private native Codex home for the selected DevSpace user/provider account
```

The sidecar must not receive the Docker socket, Agent socket, general managed root, unrelated project/workspace state, host `~/.codex`, arbitrary host mounts, host PID mode, privileged mode, or host networking merely for Codex operation.

Git inside the sidecar is a required capability. Normal operations including `git status`, `git diff`, `git log`, branch inspection, staging, commits, and other project-scoped Git workflows must operate against the real managed repository rather than a degraded filesystem-only view.

## Native CODEX_HOME

### Scope and ownership

DevSpace uses one persistent native Codex home per DevSpace user/provider-account binding, shared across that account's Codex sidecars and sessions.

Conceptually:

```text
<agent-private-state>/codex-homes/<account-binding>/
  |- native Codex auth state
  |- config
  |- sessions/
  `- other native Codex-owned state
```

The exact host path is Agent-private implementation detail and must never enter browser payloads, URLs, Web SQLite content, or ordinary diagnostics.

An Agent-private directory is preferred over an opaque Docker named volume because the Agent must passively inspect bounded native session metadata for correlation and recovery, and operators need straightforward backup/recovery semantics. The normal project container never receives this directory.

### Native home is the sole credential authority

For the new CLI path, the persistent native `CODEX_HOME` is the sole source of truth for Codex authentication, refresh state, configuration, and native session history.

Normal operation must not use the current provider-lifetime pattern of:

```text
Agent credential authority
-> global lease
-> copy auth into ephemeral CODEX_HOME
-> run provider
-> validate/copy refreshed auth back
-> release lease
```

Instead:

```text
real Codex CLI <-> persistent private CODEX_HOME
```

Initial authentication and reauthentication use the native Codex flow against that persistent home. Codex updates its own native files directly.

The existing `<stateRoot>/codex-auth/codex/` authority, lease, staging, writeback, and reauthentication-marker machinery may be retained temporarily only for migration or recovery while the new path is being proven. The steady-state architecture must not maintain two synchronized credential authorities.

### Concurrency

The same native home is intentionally shared by multiple Codex processes, including concurrent sessions in one workspace and sessions in different workspaces for the same account.

DevSpace must not add a global native-home lock unless a specific upstream Codex correctness requirement is proven. Concurrency acceptance must instead demonstrate that admitted Codex versions safely support simultaneous session creation and ordinary native home/config/auth activity.

## Security boundary

### Parent Codex process versus Codex-launched tools

The parent Codex process is allowed to access `/codex-home`; it requires the native home for credentials, configuration, and session persistence.

Commands, scripts, package tasks, tools, and other subprocesses launched by Codex must not be able to read `/codex-home` or other DevSpace-private state.

This secret boundary is mandatory even though registered repositories are owner-controlled code. A project command executed at Codex's request must not inherit direct access to provider credentials merely because it runs in the sidecar.

File modes, same-UID assumptions, or obscurity are not sufficient. The boundary must be enforced by the admitted Codex filesystem sandbox.

### Tool filesystem policy

The intended effective policy for Codex-launched tools is:

```text
read/execute:
  runtime filesystem required to execute normal tools
  /workspace
  exact project Git administration

write:
  /workspace
  exact project Git administration as required by normal Git behavior
  ordinary sandbox-approved temporary/runtime locations

no access:
  /codex-home
  Agent private state
  unrelated managed project/workspace state
  Docker or Agent control sockets
```

The implementation may use the current Codex Linux bubblewrap/filesystem-permission path or another provider-native sandbox path only if it can prove the same effective boundary for every admitted permission mode.

### No secret-breaking permission mode

DevSpace must not offer or invoke a Codex permission/sandbox mode that lets Codex-launched tools read `/codex-home`.

In particular, the managed path must never rely on `--dangerously-bypass-approvals-and-sandbox` or an equivalent unrestricted child-process mode while the private native home is mounted in the sidecar.

Native Codex approval and permission UX may remain available only when the selected mode preserves the private-home boundary.

This is a hard system-security boundary, not a behavioral guardrail. Users may intentionally run destructive commands against their workspace; those commands still must not gain DevSpace/provider credentials.

## Hard feasibility gate

No substantial migration to this architecture proceeds until a focused security/runtime spike proves the sidecar model with the admitted Codex version and an exact project runtime image.

The gate must prove all of the following:

1. The exact project image can run the trusted Codex artifact in a real interactive TUI.
2. The sidecar can mount the exact worktree and exact Git administration narrowly enough for normal project Git to work.
3. The normal project container cannot read the private native Codex home.
4. The parent Codex process can use the private native home normally.
5. A shell command launched through the real Codex TUI cannot read `/codex-home/auth.json` or equivalent credential material.
6. Alternate access attempts, including direct reads, directory traversal/listing, Python/Node reads, package scripts, subprocesses, and relevant symlink tricks, cannot expose the home.
7. Normal workspace commands, Git, package managers, builds/tests, and file edits still work under the enforced sandbox.
8. Every DevSpace-supported native Codex permission choice preserves the secret boundary.
9. Multiple Codex processes can use the same native home concurrently without DevSpace serializing them.

If the tool subprocess/private-home boundary cannot be proven, implementation stops and the architecture is reconsidered. The solution must not weaken the credential boundary merely to keep the sidecar approach.

## Native session model

### Sources of truth

DevSpace and Codex own different facts:

```text
Codex CLI
  conversation content
  approvals/questions
  provider history
  native session ID
  native resume semantics
  auth/config/session files

DevSpace
  project/workspace binding
  sidecar/runtime binding
  logical browser navigation identity
  PTY/exec attachment
  coarse lifecycle
  passive native-session association

Git/filesystem
  project change truth
```

DevSpace must not create a second conversation authority for prompts, assistant messages, turns, approvals, questions, tool activity, provider events, or provider event sequencing.

### Lightweight persisted association

Web persists only enough metadata to navigate, attach, recover, and resume a native CLI session. The implementation may choose table/column names that fit the existing schema, but the conceptual record is:

```text
DevSpace logical session ID
project ID
workspace ID
provider = codex-cli
provider session ID, nullable until passively discovered
current terminal/attachment ID, nullable
Codex-home binding ID
runtime plan/revision/generation binding
lifecycle state
created/updated timestamps
optional non-authoritative display metadata
optional bounded provider rollout provenance for diagnostics
```

The database must not persist conversation messages or reconstruct native JSONL into a DevSpace chat model for this path.

Absolute host paths, credential values, native auth contents, Docker control identities, and unbounded native provider data remain Agent-private.

### Lifecycle and binding are distinct

A session may be live even before DevSpace has proven its native provider session ID. Therefore provider binding completeness must not be encoded by killing or failing the live CLI.

For example:

```text
lifecycle = live
provider_session_id = null
```

means the native TUI is functioning but native resume is not yet safely available.

The public lifecycle should remain small and semantically precise, for example:

```text
starting
live
resumable
resuming
resume_failed
lost
```

`lost` is reserved for a state in which DevSpace cannot safely attach or resume because the required execution/provider relationship cannot be established. It is not a generic error bucket.

## New session flow

A new browser session follows this path:

```text
user selects + New Codex
-> Web creates lightweight logical session association
-> Agent validates exact project/workspace/runtime authority
-> Agent ensures the workspace Codex sidecar exists for that runtime generation
-> Agent creates a new Docker exec with an interactive TTY in /workspace
-> command is exactly bare `codex`
-> browser attaches to the real TUI
-> Agent passively discovers the native Codex session identity
-> Web persists the proven native-session association
```

There is no invented provider session ID before Codex creates one.

The live CLI remains usable if passive discovery is delayed or fails. DevSpace must not terminate an otherwise functional TUI merely because its optional metadata layer is temporarily unbound.

## Passive-only native session correlation

DevSpace never sends hidden input to the Codex TUI for lifecycle or session discovery. It does not issue `/status`, synthetic prompts, control keystrokes, or provider commands merely to learn the native session ID.

The Agent derives the association from provider-owned state and execution provenance. With multiple concurrent launches, `newest rollout file wins` is explicitly forbidden.

A correlation proof should use the strongest bounded passive evidence available, such as:

- exact sidecar and exec/process identity;
- launch interval;
- selected native Codex home;
- rollout file/process file-descriptor provenance where available;
- native `session_meta` ID;
- native recorded working directory matching the exact `/workspace`;
- runtime/home provenance;
- absence of a conflicting active DevSpace binding.

The implementation plan must inspect the admitted Codex version and choose a deterministic proof algorithm rather than relying on timestamps alone.

If DevSpace cannot prove which native session belongs to a PTY, that logical session remains live but unbound. It must not guess.

## Concurrent agents

There is no one-live-session-per-workspace invariant.

A workspace may contain:

```text
session A -> PTY A -> native Codex session X
session B -> PTY B -> native Codex session Y
session C -> PTY C -> native Codex session Z
session D -> stopped/resumable native session W
```

All active sessions may intentionally mutate the same `/workspace` worktree.

DevSpace does not automatically create Git worktrees or otherwise isolate them in this version. Automatic per-agent worktrees are future optional functionality.

## Browser and Web restart behavior

A browser refresh does not restart or resume Codex. The browser reconnects to the same logical session and, if its current Agent-owned PTY is still live, reattaches to that same PTY and receives the existing bounded terminal replay.

A Web restart behaves the same way. Web reloads the persisted logical association and reconnects through the Agent to the still-live PTY when available.

The Web process is therefore disposable relative to the Agent-owned provider execution.

## Native process exit and resume

When Codex exits normally and a provider session ID is known:

```text
live -> resumable
```

Selecting a resumable session presents a minimal explicit Resume action. Resume creates a new PTY/exec for the same logical DevSpace session and launches:

```text
codex resume <native-session-id>
```

The native Codex session ID remains the stable conversation identity. Terminal/exec attachments are replaceable execution details.

A failed native resume becomes `resume_failed`. DevSpace preserves the original native session ID and must not silently start bare `codex` as a replacement. Starting a new Codex conversation is a separate explicit action.

DevSpace must also avoid resuming an exact native session when it can prove that session already has a live execution.

## Workspace/runtime stop

Stopping a workspace/runtime is a resumable boundary rather than conversation deletion.

DevSpace stops associated Codex sidecar executions as part of runtime teardown while retaining the shared native home and persisted provider session IDs. Affected logical sessions become resumable when the native identity is known.

Restarting the workspace must not automatically relaunch every previously active Codex session. Historical sessions remain resumable until the user explicitly selects Resume.

## Agent restart

### Alpha behavior

The existing terminal implementation cannot safely reattach an arbitrary live Docker exec TTY after Agent process loss. The alpha architecture therefore uses conservative reconciliation:

```text
Agent restart
-> inspect surviving sidecar/provider process state
-> never launch a duplicate while the old native session may still be live
-> if old execution is dead, mark resumable
-> if old execution is alive but its PTY cannot be safely recovered,
   reconcile/terminate it and prove it is gone
-> offer native `codex resume <id>` through a new PTY
```

The exact orphan-reconciliation algorithm belongs in the implementation plan and must fail closed when liveness is ambiguous.

### Required post-alpha capability

True live PTY survival across Agent restart is an explicit required capability, not an optional idea.

The architecture must permit a future sidecar-local or otherwise Agent-independent PTY supervisor/multiplexer with a stable attachment identity so that:

```text
Codex process and PTY survive
-> Agent restarts
-> Agent reconnects to the existing PTY
-> Codex itself is not restarted or resumed
```

The initial persistence model must therefore not define a logical DevSpace session as one Agent process lifetime or one immutable terminal ID.

## Workbench UX

The useful part of the current AI Workbench is retained as thin navigation only.

Conceptually:

```text
AI Workbench
|- session sidebar
|   |- live Codex session
|   |- resumable Codex session
|   |- another live Codex session
|   `- + New Codex
`- selected session
    `- actual xterm-rendered Codex TUI
```

The sidebar may show bounded coarse lifecycle and optional non-authoritative native metadata such as a provider-derived title or timestamp when available.

It does not render DevSpace conversation messages, approval cards, question cards, tool rows, or reconstructed provider events.

A stopped session may show a minimal Resume action outside the dead terminal presentation. That action invokes native resume; it does not recreate a custom chat workflow.

## Error behavior

Errors must describe the actual failed boundary.

If the project image cannot run the admitted Codex artifact, report a runtime/Codex compatibility failure rather than a misleading generic executable-missing state.

If the required sandbox cannot preserve private-home isolation, managed Codex CLI is unavailable for that runtime and the feasibility gate fails.

If the TUI is live but native-session correlation is unproven, keep the CLI usable and represent the session as live/unbound. Native resume remains unavailable until binding is proven.

If resume fails, preserve the original provider session identity and report `resume_failed`; never silently create a new conversation.

If a native session may already be running, reconcile/prove execution state before resume rather than creating a duplicate.

Private provider errors, credential material, native auth contents, and host paths must not leak into Web/browser-visible diagnostics or ordinary logs.

## Existing implementation to reuse

The replacement should heavily reuse infrastructure whose authority remains correct:

- exact project/workspace/runtime identity and runtime-plan/generation concepts;
- rootless Docker ownership and validation;
- exact worktree binding;
- Docker exec TTY creation;
- PTY input/resize/detach semantics;
- bounded terminal replay and browser attachment;
- Web terminal authorization and relay;
- xterm-based Workbench terminal surface;
- persisted project/workspace navigation concepts;
- Agent-private state and redaction patterns;
- Git/Changes as the browser-facing project-change truth;
- executable/artifact identity checks where they remain useful for admitted Codex artifacts.

The normal browser terminal path is the closer architectural precedent than the structured app-server session path.

## Existing implementation to retire after proof

The following current structured-Codex machinery is not part of the target steady state and should be removed only after the native CLI path is proven and switched to default:

- app-server as the primary Codex runtime;
- DevSpace-owned prompt/turn/assistant-message lifecycle;
- custom approval and structured-question lifecycle;
- provider event translation and canonical AI event sequencing;
- duplicate public conversation/history persistence;
- custom JSON-RPC request correlation for normal Codex interaction;
- app-server capability/schema negotiation that exists solely for the structured surface;
- per-session credential lease/stage/writeback in normal operation;
- structured chat UI as the primary Workbench AI surface.

Existing structured-session data is not destructively deleted during the initial migration. Historical cleanup or read-only retention is a later deliberate migration decision.

Generic runtime-truthfulness, terminal, Git, security, and UX improvements may be selectively retained when they still apply to the native path.

## Migration and rollout

### Phase 0: preserve evidence

Keep the current structured Codex path available while the replacement is being proven. Keep the unmerged `fix/workbench-runtime-ai-truthfulness` branch as evidence/fallback rather than merging it wholesale into the new architecture.

### Phase 1: security/runtime feasibility gate

Build only enough feature-flagged infrastructure to prove:

- exact project image sidecar;
- exact worktree and project Git administration mounts;
- private shared native home;
- real bare Codex TUI through the existing terminal path;
- mandatory sandbox protection of `/codex-home` from Codex-launched tools;
- concurrent native-home use.

Failure stops the migration.

### Phase 2: native session lifecycle

Add lightweight logical session persistence, passive native-session correlation, multiple simultaneous PTYs, browser/Web reattachment, stopped-session presentation, and native `codex resume <id>`.

### Phase 3: recovery

Add runtime-stop semantics, sidecar recreation, Agent-restart reconciliation, and duplicate-session prevention.

### Phase 4: real dogfood

Complete a meaningful DevSpace project change entirely through the new browser CLI experience. Exercise concurrent agents, stop/resume, browser refresh, Web restart, and ordinary Git/Changes behavior.

### Phase 5: make CLI path primary

After acceptance passes, make the native CLI-backed Workbench the default Codex experience.

### Phase 6: retire duplicate architecture

Remove the superseded structured app-server/session/credential machinery deliberately rather than maintaining two primary architectures indefinitely. Update durable authorities such as ADR 015, `docs/specs/ai-sessions-v1.md`, `docs/README.md`, architecture/security documentation, and current state as required by the final migration.

No automatic merge or deployment is part of any phase.

## Explicitly out of initial scope

The first production-capable CLI replacement does not include:

- automatic per-agent Git worktrees;
- prompt injection or custom prompt boxes;
- DevSpace-rendered conversation history;
- custom approval/question UI;
- automatic agent orchestration;
- automatic restart of all historical sessions when a workspace starts;
- true live PTY reattachment after Agent restart;
- a generic abstraction intended to support every possible AI CLI from day one.

The Codex boundary should be clean enough that another native CLI provider can be added later, but the first implementation should prove the architecture with `provider = codex-cli` rather than prematurely generalizing it.

True live PTY survival/re-attachment across Agent restart is deferred from the first slice but remains a required post-alpha capability.

## Acceptance criteria

The native CLI path may replace the current structured experience only after the following are demonstrated against a real admitted Codex version and real managed workspace runtime:

| Area | Acceptance |
| --- | --- |
| Native UX | Browser displays the actual interactive Codex TUI. |
| Launch purity | New session launches bare `codex`; DevSpace sends no hidden prompt or discovery input. |
| Runtime parity | Sidecar uses the exact project runtime image. |
| Workspace | Codex sees the exact managed `/workspace`. |
| Git | Normal project-scoped Git operations work against the real managed repository. |
| Normal-runtime isolation | The normal project container cannot read the private native Codex home. |
| Tool isolation | Codex-launched commands cannot read `/codex-home`. |
| Permission safety | Every supported native permission/sandbox selection preserves private-home isolation. |
| Authentication | Native Codex login/refresh persists directly in the shared native home. |
| Same-workspace concurrency | Multiple Codex PTYs can run simultaneously in one workspace without DevSpace serialization. |
| Cross-workspace concurrency | Multiple workspace sidecars can safely use the same account-scoped native home. |
| Passive binding | Concurrent launches are correlated to native session IDs without hidden TUI input or newest-file guessing. |
| Ambiguous binding | Unprovable correlation fails closed for resume metadata without killing a functional CLI. |
| Browser refresh | Browser reattaches to the same live PTY. |
| Web restart | Web can reconnect to the same Agent-owned live PTY. |
| Process exit | A stopped bound session becomes resumable. |
| Native resume | Resume executes `codex resume <native-session-id>` for the same logical session. |
| Resume failure | Failure never silently creates a new native session. |
| Runtime stop | Native home and provider session IDs survive; sessions become resumable. |
| Agent restart | Reconciliation does not create duplicate provider execution. |
| Secret handling | Credentials do not enter Web SQLite, browser payloads, ordinary logs, or safe diagnostics. |
| Dogfood | A meaningful real project change can be completed entirely through the new path. |

## Testing strategy

The implementation plan should favor focused tests around each authority boundary before full repository gates.

Required categories include:

- sidecar mount allowlist and runtime-image identity;
- exact Git administration binding;
- native-home ownership and Web/browser non-exposure;
- Codex sandbox denial of direct, scripted, package-task, subprocess, and symlink-based home reads;
- supported native permission modes;
- concurrent sessions using one native home;
- concurrent passive session correlation;
- live-but-unbound behavior;
- terminal attachment/replay across browser and Web restart;
- native exit/resume and resume failure;
- runtime stop/recreate/resume;
- Agent restart orphan reconciliation and duplicate prevention;
- redaction of private paths/auth/provider data;
- browser dogfood through the real xterm surface.

After focused acceptance, run the repository's normal clean-clone verification contract before the final implementation merge.

## Durable-authority migration

This document intentionally comes before the replacement ADR/spec edits because the feasibility gate may invalidate the sidecar design.

Once the native CLI path has passed the hard security gate and is ready to become the product authority, the implementation sequence must include a deliberate durable-document migration. At minimum it must resolve the relationship among:

- ADR 009 terminal/PTY AI CLI authority;
- ADR 015 structured first-class AI sessions;
- `docs/specs/ai-sessions-v1.md`;
- `docs/architecture.md`;
- `docs/security/threat-model.md`;
- `docs/README.md` authority map;
- `docs/current-state.md`.

The likely end state is a new accepted ADR that supersedes the structured Codex choice for the primary Workbench experience while retaining generic terminal/PTY authority, followed by retirement or historical marking of the structured v1 specification. Exact durable-document edits belong in the implementation plan after the feasibility gate rather than being guessed before proof.

## Final architectural rule

The replacement succeeds only if DevSpace can remain a thin, truthful host for the native CLI:

```text
user input
-> actual terminal bytes
-> actual Codex CLI

DevSpace observes and owns:
  workspace/runtime authority
  sidecar/process/PTY lifecycle
  lightweight navigation association
  passive native-session provenance

DevSpace does not synthesize:
  prompts
  turns
  approvals
  questions
  conversation history
  hidden provider commands
```

Prove the native path first. Do not polish or delete the old structured path until the replacement survives real dogfood. Once proven, remove the duplicated architecture aggressively rather than carrying both as co-equal systems.
