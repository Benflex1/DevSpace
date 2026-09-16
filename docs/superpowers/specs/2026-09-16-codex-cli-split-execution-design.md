# Native Codex CLI Split Control and Execution Plane

## Status and decision

This is the approved architectural direction to replace the blocked single-sidecar
Codex CLI experiment. It is a design specification, not an implementation plan and
not an implementation authorization.

The target experience is a real native Codex CLI/TUI with native authentication,
approvals, sessions, history, and native `codex resume NATIVE_SESSION_ID`. Codex's control process keeps
the persistent native `CODEX_HOME`; Codex's model-directed project work runs through
a separate remote executor that has the exact DevSpace workspace and project image
but no path to that home.

The current structured app-server AI-session path remains the shipped and default
authority. No Workbench/session migration, structured-path deletion, credential
authority migration, or public-contract change is authorized by this document.

The design status is conditional on the hard feasibility gate in this document. In
particular, Codex `0.153.4` local exec-server transport authentication, zero-project-
mount native TUI startup/resume, and fail-closed enforcement of every local-execution
negative path are not established by source inspection alone.

## Problem and supersession of the previous design

The previous design placed all of these in one workspace-scoped container:

```text
native Codex TUI
persistent native CODEX_HOME
exact project workspace and Git state
model-directed project execution
```

It required Codex's Linux filesystem sandbox to deny `/codex-home` to child tools.
The admitted Codex `0.153.4` feasibility branch proved that boundary is currently
blocked/unknown:

- recursive `/codex-home/**` denial expands to individual Bubblewrap masks and fails
  deterministically with `bwrap: Exceeded maximum number of arguments 9000`;
- the home contained approximately 5,500 regular files, including approximately
  5,412 under `.tmp/plugins`;
- legacy Landlock cannot represent the required deny-read policy while satisfying
  the managed permission requirements;
- no private-home escape was proven, and no security invariant was weakened.

This document supersedes the prior design only where necessary:

1. The single container is no longer the credential and project-execution boundary.
2. A Codex child-process deny rule for `/codex-home` is no longer the primary secret
   boundary. Physical absence of the home from the project executor is primary.
3. The previous feasibility implementation's same-container managed requirements
   file and recursive home denial are not reused or retried.
4. A project executor is a separate execution plane and must be remote-only from the
   native control TUI.

The following prior decisions remain in force unless this document says otherwise:

- native Codex TUI is the user-facing AI surface;
- DevSpace does not synthesize prompts, turns, approvals, questions, or transcript
  history;
- project/runtime/workspace authority remains Agent-owned;
- the project image, exact worktree, and exact required Git administration remain
  authoritative;
- multiple native sessions may intentionally share one workspace;
- DevSpace may prevent duplicate execution of the exact same native session, but does
  not impose one-agent-per-workspace behavior;
- native session correlation is passive and must not inject hidden TUI input;
- the existing structured app-server path remains fallback/default evidence until a
  complete later gate and migration decision.

The previous feasibility plan is historical evidence of the blocked topology. Its
implementation tasks do not become tasks for this architecture. A later implementation
plan must be written only after this design is approved and the new gate is accepted.

## Goals

This architecture must provide:

- a real native Codex `0.153.4` TUI unless a separately justified admitted version is
  selected;
- persistent native `CODEX_HOME` owned by the trusted Agent;
- native authentication, approvals, sessions, history, and resume semantics;
- native model-directed shell and file work against the exact `/workspace` executor;
- exact project image/toolchain parity in the execution plane;
- exact worktree and narrowly required Git administration state;
- no physical project-workspace mount in the control sidecar if the feasibility gate
  proves native startup and resume work without one;
- fail-closed behavior when the remote executor is missing, stale, disconnected, or
  misconfigured;
- no credential, home mount, Agent socket, Docker socket, host namespace, or unrelated
  managed state in the project executor;
- concurrent native sessions against one workspace without a behavioral lock.

## Explicit non-goals

This document does not implement or authorize:

- browser-native TUI embedding or Workbench session migration;
- a new Web/Agent protocol for Codex conversation contents;
- a duplicate conversation/history database;
- automatic worktree-per-agent isolation;
- a generic arbitrary-CLI execution framework;
- unauthenticated production exec-server transport;
- `danger-full-access`, sandbox bypass, or UID-only home protection;
- a program-launched executor inside the credential-bearing control sidecar;
- automatic deployment, merge, or production mutation;
- deletion or weakening of the existing structured app-server system.

## Architecture and trust boundaries

The target topology is:

```text
authenticated browser
        |
        v
DevSpace Web
  sole SQLite writer; no shell, Git, Docker, Caddy, or Codex authority
        |
        v
DevSpace Agent
  trusted filesystem/Git/rootless-Docker/PTY authority
  knows Agent-private native-home paths but never exposes their contents
        |
        +----------------------------+
        |                            |
        v                            v
Codex control sidecar          project executor
  native codex TUI              exact project/runtime image
  native CODEX_HOME             exact /workspace worktree
  native auth/session state     exact required Git administration
  native approvals              project toolchain and Codex exec-server
  no project mount              no CODEX_HOME or Codex credentials
  no Docker/Agent socket        no Docker/Agent socket
  no host namespaces            no unrelated managed state
        |                            ^
        +-- authenticated, private -+
            exec-server transport
```

The Agent is trusted to create, validate, persist, and mount the native home into a
control sidecar. The security invariant is not that the Agent is unaware of the home;
the invariant is that Web and project-controlled execution cannot obtain it.

### Web

Web remains the browser-facing authority and sole SQLite writer. It may receive only
opaque project/workspace/session/attachment identities, bounded lifecycle observations,
and redacted failure codes. It must never receive:

- the native-home host path or mount source;
- native auth, refresh, cookie, token, or session-file contents;
- executor endpoint credentials or transport keys;
- raw Codex protocol messages, complete commands, host paths, Docker IDs, or process
  identities;
- terminal/provider output persisted as structured AI history for this path.

The browser never supplies executable commands, host paths, environment values, mount
sources, or executor endpoints.

### Agent

The Agent owns:

- the exact project/workspace/runtime identity and generation;
- the project worktree and narrowly required Git administration paths;
- rootless Docker lifecycle and network creation;
- the persistent Agent-private native Codex home;
- control-sidecar and project-executor creation, inspection, and teardown;
- trusted Codex artifact identity and injection;
- private executor transport credentials, when the admitted Codex version supports
  them;
- PTY attachment and passive native-session provenance.

Agent-private records may identify a home binding and runtime generation, but must not
place credential contents in logs, events, labels, SQLite, browser payloads, or ordinary
diagnostics. The Agent must not expose the home through any project file API, project
mount, executor endpoint, or browser-authorized operation.

### Control sidecar

The control sidecar is trusted control-plane compute. It contains the real native Codex
TUI and may read/write `/codex-home` because native auth, configuration, and history
require it. It is not a project execution environment.

It must not receive:

- the project worktree or Git administration mount;
- a Docker socket or Agent socket;
- host PID, host network, privileged mode, arbitrary host mounts, or host namespaces;
- unrelated managed-root/state directories;
- a project toolchain mount merely to make native commands convenient.

The control image may be a trusted minimal Codex/control image with the verified Codex
artifact injected. It need not be the project image. The project image requirement
belongs to the project executor.

### Project executor

The project executor is the only environment in which model-directed project processes
may run. It is a separate container or separately isolated executor instance created
from the exact project/runtime image selected for the workspace.

It receives only:

- the exact `/workspace` worktree, read/write;
- the exact Git administration state required for that worktree, at the exact path
  expected by Git;
- the project image's declared/runtime-required toolchain;
- a trusted verified Codex exec-server artifact if the exact image lacks the required
  artifact/helper;
- the minimum private transport wiring needed to serve the control sidecar.

It receives no persistent/native `CODEX_HOME`, no `CODEX_HOME` value pointing to the
control home, no Codex credentials, Agent/Docker sockets, host namespaces, unrelated
managed state, or production directories. If the exec-server requires executor-local
configuration or scratch state, it remains ephemeral inside that container, contains no
credentials, and is not a DevSpace-managed home.

The exact project image must not be replaced by a generic runner image. If artifact
compatibility cannot be achieved by injecting a trusted, verified Codex exec-server
closure into the exact image, the runtime is incompatible and the gate fails.

## Control-sidecar lifecycle

The Agent manages one control sidecar per workspace/runtime generation and native-home
binding, with multiple independent native Codex Docker-exec PTYs inside it. A later
implementation may choose one control sidecar per session, but it must preserve the same
home and transport invariants; it must not use a shared untracked control daemon.

Creation is ordered:

1. Resolve the exact project/workspace/runtime generation through existing managed
   workspace authority.
2. Ensure the project executor is the exact compatible image and has a ready,
   authenticated transport endpoint.
3. Resolve and verify the trusted Codex artifact and its required exec-server closure.
4. Resolve the Agent-private native-home binding and verify ownership, type, path
   containment, and restrictive metadata without reading credential contents into logs.
5. Create the control sidecar with only `/codex-home` and trusted Codex/control assets.
6. Set the control process's remote-only environment configuration before launching
   any native Codex TUI.
7. Prove the sidecar identity, mounts, network, and process configuration after Docker
   creation.

The sidecar must not start a TUI until remote-only configuration is complete. It must
not start a local TUI and attempt to attach an executor later.

Stopping the control sidecar stops its native TUI execs but preserves the Agent-private
native home. It does not delete native history or auth. A new control sidecar may later
run `codex resume NATIVE_SESSION_ID` after a new compatible executor is ready.

## Native CODEX_HOME ownership and scope

The Agent owns a persistent native home under Agent-private state, conceptually:

```text
AGENT_PRIVATE_STATE/codex-homes/ACCOUNT_BINDING/
  config.toml
  auth and refresh state
  sessions and native history
  other Codex-owned state
```

The exact host path is private. The Agent may know it and mount it into the control
sidecar. Web, browser, project executor, project APIs, labels, and logs do not receive
the path or contents.

The initial design may share one home across control sidecars for the same trusted
DevSpace account binding. Each control sidecar receives its workspace-specific
`CODEX_EXEC_SERVER_URL` in its own environment. To avoid a shared-home configuration
race, the initial managed policy must reject a `CODEX_HOME/environments.toml` file that
could override the per-sidecar endpoint, unless it is proven to contain exactly the
current one remote endpoint with `include_local = false`. The recommended configuration
for a shared home is no `environments.toml` and a per-sidecar `CODEX_EXEC_SERVER_URL`.

The Agent must not copy credentials from the existing structured authority into this
home as part of normal operation. Native login and refresh remain native Codex actions
against the persistent home. Any bootstrap/recovery path must use the existing trusted
Agent authority rules and must not expose bytes to Web or the executor.

Concurrent native session use of the home is intentional. DevSpace must not add a global
home lock. If admitted Codex versions cannot safely create/use concurrent native
sessions against the home, this architecture fails its gate rather than serializing
sessions as a workaround.

## Project-executor lifecycle and exact-image policy

The project executor is bound to the existing exact workspace runtime generation. The
Agent must prove, before control-sidecar launch:

- project ID and workspace ID match the requested resource;
- the runtime is live, owned, and generation-current;
- the executor image is the exact inspected project/runtime image identity;
- `/workspace` is the exact managed worktree;
- Git's required administration path is the exact path belonging to that worktree;
- no credential/home/socket/unrelated-state mount is present;
- the executor architecture/ABI can execute the verified Codex artifact;
- the executor can run the Codex exec-server and its required sandbox helper.

If the exact image lacks `codex exec-server`, DevSpace may inject a trusted, verified
Codex artifact closure, including required runtime/sandbox helpers, into a read-only
trusted path. The Agent must verify artifact identity and closure before injection.
The image itself remains the project's exact image. A generic AI runner is never an
acceptable compatibility fallback.

The exec-server is started by the Agent or an Agent-owned executor lifecycle mechanism
inside the project executor. It is not started through a `program` environment entry in
the control sidecar. The executor process receives no native Codex credentials. Its
only persistent project state is the exact workspace/Git state already authorized for
the workspace; any exec-server scratch/home state is ephemeral and non-sensitive.

The executor's process sandbox remains required for project safety and workspace policy.
The split design removes `/codex-home` from the executor, so it does not depend on a
large recursive deny mask for the native home. It does not authorize disabling Codex
sandboxing or selecting danger/full-access mode.

## Remote environment configuration

Codex `0.153.4` has a native environment abstraction used by the TUI and core runtime.
The relevant path is:

```text
CODEX_HOME / CODEX_EXEC_SERVER_URL / environments.toml
        -> EnvironmentManager
        -> default remote environment
        -> TurnEnvironmentSelection(environment_id, cwd, workspace_roots, config)
        -> remote Environment / ExecBackend / ExecutorFileSystem
```

The initial DevSpace binding is one default remote environment per control sidecar.
The preferred `0.153.4` configuration is:

```text
CODEX_EXEC_SERVER_URL is set to the Agent-provisioned private authenticated project-executor endpoint.
local environment absent
default environment = remote
```

The alternative native configuration is an Agent-managed `environments.toml` with one
remote environment, `default` set to it, and `include_local = false`. A `program` entry
is forbidden because it would cause the control process to spawn the configured command
inside the credential-bearing sidecar. DevSpace starts the executor separately and
provides a `url` transport only.

The Agent must inspect the effective configuration before TUI launch and reject:

- no endpoint;
- an empty or `none` endpoint;
- a local default environment;
- a local environment included alongside the remote environment;
- an unknown/stale endpoint;
- a `program`-based executor;
- a project-controlled configuration that can re-enable local execution or unrestricted
  permission modes.

The project executor must provide the remote environment's shell/platform information,
filesystem operations, and process backend. The remote environment's permission profile
must be workspace-scoped and sandbox-enforced in the executor. Its configuration must be
trusted or otherwise enforced outside project-writable state; a project file that can
turn the environment local or unrestricted is not an acceptable policy source.

## Exec-server transport, network, and authentication

The final architecture requires a private, authenticated control-to-executor transport
when the admitted Codex version supports one. The transport is a control-plane boundary,
not a browser-facing API. DevSpace must bind it to the exact workspace, executor
generation, and control-sidecar identity, with bounded connection/readiness timeouts and
no public listener.

The exact `rust-v0.153.4` source must be treated separately from current upstream:

- the `0.153.4` local listener parses `ws://IP:PORT` and stdio transports and rejects
  requests carrying an `Origin` header;
- its local listener source does not establish bearer, mutual, or token authentication;
- `0.153.4` documentation describes authentication for remote registration using
  ChatGPT/API-key/Agent-identity flows, which is not proof that a direct local
  `environments.toml` WebSocket is authenticated;
- current upstream has materially newer transport/authentication and daemon-selection
  behavior, but those properties must not be assumed for the admitted old artifact.

For the `0.153.4` feasibility spike only, a dedicated per-workspace rootless Docker
network with no published ports may be used to test routing and physical mount
separation if protocol authentication is unavailable. That lab network must contain only
the control sidecar and its project executor; it must not silently be treated as the
production security model. A network-only spike result records:

```text
routing and container separation proven
transport authentication not proven
migration gate remains blocked
```

Before Workbench/session migration, production acceptance requires one of:

1. native protocol authentication supported and verified by the admitted Codex artifact;
2. a separately reviewed narrow transport boundary that authenticates and forwards only
   the opaque exec-server protocol without reconstructing Codex conversation semantics;
3. a separately justified newer Codex artifact whose authenticated transport is part of
   its verified compatibility identity.

No option authorizes exposing an unauthenticated executor endpoint to a shared network,
host network, browser, Agent socket, or public ingress.

## Native TUI with no project mount

The control sidecar must not receive a bind or volume containing the real project
worktree or Git state. It may have an image-local empty `/workspace` directory only as
process-CWD scaffolding; that directory must contain no project bytes and must not be a
mount of managed state.

The preferred native launch is an ordinary bare `codex` from the control sidecar's
logical `/workspace` CWD, with no prompt argument, hidden slash command, synthetic
input, or discovery keystroke. If `0.153.4` requires the control process to start in a
different local directory, the only acceptable alternative is a native launch-time
logical `--cd /workspace` proven by the gate; it must not mount the real workspace.

This is a hard empirical condition. Source inspection shows that remote-default TUI
startup avoids local CWD canonicalization in relevant paths and that remote turn
selections carry `PathUri` values, but source inspection does not prove that every TUI,
config, resume, picker, and status path tolerates an absent real `/workspace`.

If native `codex` cannot start, create a native session, read AGENTS.md, show approvals,
or resume a native session with logical `/workspace` while the real project mount is
absent, the design is NO-GO under this specification. DevSpace must not quietly mount
the project worktree into the credential-bearing control sidecar to make it work.

## Routing contract

### Shell, Unified Exec, and child processes

All model-directed shell commands must select the remote-only `TurnEnvironment`. With
Unified Exec enabled, Codex sends the command, logical cwd, permission/sandbox context,
environment policy, and PTY/stdio parameters through the selected remote `ExecBackend`.
The executor performs the actual process start and applies its process sandbox.

The following must execute in the project executor, not the control sidecar:

- shell commands and interactive shell PTYs;
- Git commands invoked by the normal Codex shell tool;
- Python, Node, package-manager, compiler, test, and nested child processes;
- shell scripts and package scripts launched by those commands.

The executor must not receive `/codex-home`, native auth, or any shared mount through
which a child can reach them. Executor loss must return an execution failure; Codex may
reconnect the same remote environment only through the authenticated remote path. There
is no local retry.

Unified Exec is a mandatory managed capability. If the effective configuration disables
it, DevSpace rejects the control-sidecar launch. It must not allow Codex's legacy local
execution path to become a fallback.

### `apply_patch` and filesystem operations

`apply_patch` must resolve the same remote environment and use its
`ExecutorFileSystem`. File verification, reads, writes, metadata, and patch application
therefore operate in the project executor. A local control-sidecar filesystem write is
not an acceptable fallback.

### AGENTS.md and filesystem helpers

AGENTS.md discovery must use the selected executor filesystem and logical `/workspace`
cwd. Project instructions, project-root markers, file metadata, directory traversal,
and ordinary filesystem helpers must not require the control sidecar to mount the real
workspace.

The control sidecar may read native global Codex configuration and Agent-managed control
state from `/codex-home`. It must not use local control-sidecar project config as a
substitute for executor-side project configuration when doing so would reintroduce local
filesystem access or allow unrestricted execution.

### Git state

The executor has the exact worktree and only the Git administration paths required by
that worktree. Git's expected `.git` metadata and administration path must resolve inside
the executor without exposing a broad managed repository root. Normal project Git
operations through Codex are remote shell processes. DevSpace's existing browser-facing
Git/Changes authority remains separate and is not replaced by Codex's terminal output.

### Native approvals

Approvals remain owned and rendered by the native Codex TUI. The selected remote
environment changes where an approved command or file operation executes; it does not
move approval presentation into Web or require custom DevSpace approval cards.

The managed profile must permit only sandbox-preserving permission choices. Any native
choice that sends a local environment, `SandboxType::None` for normal project execution,
danger/full-access permission, or an equivalent child-process bypass is rejected or made
unavailable before the TUI becomes usable. If `0.153.4` cannot enforce those choices
through a trusted effective configuration, the gate fails.

## Native sessions, history, and resume

Codex remains authoritative for:

- native authentication and refresh state;
- native session/thread identifiers;
- native JSONL/history/session metadata;
- native approvals and questions;
- native resume behavior.

DevSpace later owns only a lightweight opaque association between its project/workspace
navigation identity and a passively proven native session ID. It does not persist a
second prompt/turn/transcript/event authority for this path.

An operator starts a new native session with the normal TUI. The Agent creates a new
interactive PTY exec in the control sidecar; the command is ordinary native `codex`.
The Agent does not inject a prompt or a provider command to discover the native ID.

Resume creates a new control-sidecar PTY and launches the native command:

```text
codex resume NATIVE_SESSION_ID
```

The resumed process inherits the same persistent `CODEX_HOME`, workspace-specific
remote-only executor configuration, and logical `/workspace` cwd. If native metadata
contains a previous host-local path, the launch must explicitly and safely map it to
`/workspace`; failure to prove that mapping is a resume failure, never permission to
run locally or start a new bare conversation.

`codex resume NATIVE_SESSION_ID` must not be attempted when an Agent-private execution record proves
the exact native session is already live. If liveness or identity is ambiguous, resume
is refused until the ambiguity is reconciled. This is a duplicate-session integrity
rule, not a one-agent-per-workspace guard.

## Multiple concurrent sessions

Multiple native TUI PTYs may run at the same time in one control sidecar, use the same
persistent native home, and target the same project executor/worktree:

```text
native session A -> control PTY A -> remote executor
native session B -> control PTY B -> remote executor
native session C -> control PTY C -> remote executor
```

They intentionally share project filesystem/Git state. DevSpace does not serialize or
prevent user-selected concurrent edits. The executor must support multiple independent
exec-server process sessions, and Codex native home concurrency must be proven.

The only prohibited duplication is launching the same native session ID twice while the
first execution is live. A missing or uncertain correlation proof leaves the DevSpace
association unbound or resume-unavailable; it does not kill a functioning native TUI
merely to make metadata complete.

## Agent and runtime restart implications

### Project executor loss

If the executor or its transport dies:

- the control TUI observes a remote execution failure;
- all affected model-directed project operations fail;
- no local environment is available for fallback;
- no control-sidecar project mount is added;
- after the exact workspace runtime is recreated, the user may explicitly resume the
  native session through a new executor generation.

The Agent must not report a remote operation as successful without the executor's bounded
completion proof.

### Control-sidecar stop/restart

Stopping/recreating the control sidecar preserves the native home. Native processes and
PTYs do not become magically attachable merely because the home survives. If the Agent
can prove a surviving TUI and recover its PTY attachment, it may reattach. If attachment
or process identity is ambiguous, it must not start a duplicate; it must reconcile or
terminate the orphan under a proven ownership record and offer native resume.

### Agent restart

The Agent may rediscover the Agent-private home path and exact sidecar/executor
ownership records after restart. The first lifecycle implementation may conservatively:

1. inspect surviving control and executor containers;
2. prove workspace, generation, native-home binding, endpoint, and process identity;
3. reattach only when the existing PTY/process proof is complete;
4. otherwise preserve the home, safely reconcile the ambiguous execution, and expose a
   resumable native session when its native ID is proven.

Agent restart must never launch a second TUI because the first one is merely hard to
observe. True PTY survival across Agent restart is a later capability; the persistence
model must not make a native session ID equal to one Agent process lifetime.

## Local-execution deny and fail-closed policy

The following are architectural enforcement requirements, not operator guidance:

| Path | Required DevSpace behavior |
| --- | --- |
| Local environment | Omit it with `include_local = false`/remote URL and reject any effective local default. |
| `/shell` | Remote-only manager makes it unavailable; a local environment may not be retained as fallback. |
| Unified Exec disabled | Reject the effective configuration before launch; never activate legacy local execution. |
| Missing/stale executor endpoint | Do not launch the TUI, or fail the remote turn; never run locally. |
| Executor disconnect | Surface a bounded remote failure and preserve no local retry path. |
| Command hooks | Reject/disable effective command-hook configuration before TUI launch. If project/user config can re-enable it, the managed profile is unavailable. |
| Legacy notify hooks | Reject/disable them before launch; no locally spawned notification child is permitted for a managed native session. |
| Local MCP stdio | Reject local stdio server configuration. Only executor-backed MCP may be considered, and its physical container boundary must be proven. |
| Local HTTP/helper execution | Reject local HTTP header/helper execution and any helper that spawns in control. Remote/executor-backed configuration must be explicit. |
| Plugin install/update/maintenance | Disable/reject model-accessible plugin maintenance in the managed TUI. Trusted administrative maintenance is outside the model-directed project execution path. |
| `program` executor entry | Reject all program-based environment entries; the Agent starts the executor separately and uses a URL. |
| Shared app-server daemon | Use an isolated control-sidecar/app-server instance. On `0.153.4`, prove no implicit shared daemon can ignore the executor selection. |
| Danger/full-access or sandbox bypass | Reject the managed profile; do not mount the native home into a process that can grant project children unrestricted access to it. |

The effective-config enforcement mechanism must be demonstrated against both native
global configuration and project configuration layers. “Users should not configure
this” is not enforcement. If `0.153.4` cannot make a forbidden path unavailable or
fail closed, the path is a gate failure.

Some native TUI conveniences may still use control-local helpers, such as clipboard,
external-editor integration, or review branch pickers. They are not model-directed
project execution, and the control sidecar has no real project mount, so they may be
disabled or degraded. They must not be used as a covert project-execution path. If a
product requirement expands the invariant to include every operator-selected local
helper, the native control sidecar cannot satisfy that requirement while retaining
native `CODEX_HOME`.

## Security boundary and mount matrix

| Resource/process | Control sidecar | Project executor | Project child process | Web/SQLite |
| --- | ---: | ---: | ---: | ---: |
| Persistent native `CODEX_HOME` | read/write | no mount | no mount | never |
| Native auth/refresh state | yes, through Codex | no | no | never |
| Real `/workspace` worktree | no real mount | read/write | read/write | no direct access |
| Required Git administration | no | exact narrow paths | exact narrow paths | no direct access |
| Codex exec-server | client/embedded core | server | not applicable | no |
| Docker/Agent socket | no | no | no | no |
| Host namespaces/production dirs | no | no | no | no |
| Project toolchain | minimal control needs only | exact image/toolchain | inherited from executor | no |
| Native session/history files | yes | no | no | no duplicate |

The project executor may know the remote endpoint it serves and may execute arbitrary
project code under its own workspace policy. That does not grant access to the control
sidecar's home. The control sidecar has no inbound Agent/project control socket and no
project bind mount. The network must not provide a route to host services or unrelated
workspace state.

## Logging, events, and secret boundaries

The native TUI terminal stream may be displayed to the authenticated owner through the
existing bounded terminal attachment path. It is not copied into structured DevSpace
conversation history by this design.

Agent/Web logs, events, SQLite, labels, metrics, and safe diagnostics may contain only
bounded opaque identities, lifecycle state, runtime generation, artifact identity,
transport health category, and redacted stable failure codes. They must not contain:

- native-home host paths or contents;
- auth/refresh/token/cookie values;
- executor transport tokens/keys or endpoint credentials;
- raw Codex protocol payloads or raw private errors;
- complete commands/arguments, private host paths, Docker/PID identities, or project
  output that contains provider secrets.

Executor and control logs must be configured so startup banners, environment dumps,
command-line arguments, and error formatting cannot print credential values. Health
checks must report only ready/not-ready and bounded reason categories.

## Source evidence and version boundary

The external Codex source was inspected at the exact admitted tag `rust-v0.153.4`
(commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`) and compared with newer upstream
source at commit `7c709f0ffd5c7eea752737bad397a1585c2176a1`.

The following `0.153.4` source proves the basic remote-environment path:

- [`TurnEnvironmentSelection` and `TurnEnvironmentSelections`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/protocol/src/protocol.rs#L154-L169)
  carry environment ID, logical cwd, workspace roots, and configuration state.
- [`EnvironmentManager::prepare_from_codex_home`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec-server/src/environment.rs#L174-L200)
  loads native-home environment configuration, while [`DefaultEnvironmentProvider`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec-server/src/environment_provider.rs#L50-L112)
  maps a non-empty `CODEX_EXEC_SERVER_URL` to a remote default and omits local.
- [`environments.toml` parsing](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec-server/src/environment_toml.rs#L25-L207)
  supports `default`, `include_local`, WebSocket `url`, and stdio `program`; this
  design permits only the URL form.
- Native TUI startup calls the environment manager and passes it into the embedded
  app-server ([`startup_orchestration.rs`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/startup_orchestration.rs#L196-L216),
  [`tui/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/lib.rs#L256-L305)).
- [`default_thread_environment_selections`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/environment_selection.rs#L114-L129)
  maps the manager's default environment to logical cwd and workspace roots.
- [`TurnEnvironment::sandbox_context`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/session/turn_context.rs#L112-L150)
  carries the selected environment's permissions and workspace context into tools.
- Normal shell routing selects the environment in [`exec_command.rs`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L175-L231)
  and the remote branch of [`open_session_with_prepared_exec_env`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/unified_exec/process_manager.rs#L1230-L1266)
  calls the selected executor backend rather than local process spawning.
- [`apply_patch`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/tools/handlers/apply_patch.rs#L401-L420)
  and its runtime use the selected environment filesystem; [`agents_md.rs`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/agents_md.rs#L53-L112)
  reads project instructions through that filesystem.
- [`RemoteProcess`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec-server/src/remote_process.rs#L21-L66)
  and [`RemoteFileSystem`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec-server/src/remote_file_system.rs#L47-L153)
  are the executor-side process/filesystem path.
- Local escape paths are visible in [`user_shell.rs`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/tasks/user_shell.rs#L146-L235),
  local versus executor MCP launchers ([`stdio_server_launcher.rs`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/rmcp-client/src/stdio_server_launcher.rs#L177-L205)
  and [executor launcher](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/rmcp-client/src/stdio_server_launcher.rs#L507-L607)),
  and local command-hook spawning ([`command_runner.rs`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/hooks/src/engine/command_runner.rs#L205-L242)).
- The `0.153.4` local listener and its only visible request filter are in
  [`server/transport.rs`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec-server/src/server/transport.rs#L63-L216); its
  [`exec-server README`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec-server/README.md#L17-L55)
  documents local WebSocket/stdio and authenticated remote registration separately.

The newer source adds an executor-selection guard so a configured executor URL does not
reuse an implicit shared daemon ([`app_server_target_for_launch`](https://github.com/openai/codex/blob/7c709f0ffd5c7eea752737bad397a1585c2176a1/codex-rs/tui/src/lib.rs#L929-L956))
and has newer authenticated transport options. DevSpace must either reproduce the
no-shared-daemon condition on `0.153.4` or admit a newer artifact under a separate
compatibility decision. Newer source is evidence of direction, not evidence of old-tag
behavior.

## Hard feasibility gate

No Workbench/session migration or structured-path retirement may begin until one
operator-run gate proves every required condition below against the exact admitted
Codex artifact and an exact DevSpace project image. The result must be recorded as
PASS, FAIL, or PASS-WITH-TRANSPORT-BLOCK; the last state is not migration approval.

Any required project operation observed in the control sidecar, any project-executor
path to native `CODEX_HOME`, any local fallback, or any unproven zero-mount requirement
is NO-GO until the design changes.

### A. Control plane

Prove:

- native Codex `0.153.4`, unless a separately justified artifact is explicitly admitted;
- persistent Agent-private native home with native auth/session files;
- no real project-workspace or Git-state mount in the control sidecar;
- no Docker socket, Agent socket, host namespace, host PID, or arbitrary host mount;
- bare native `codex` starts in an interactive TUI;
- the default environment is remote-only, with no local environment available;
- native approvals appear and complete through the TUI;
- a native session is created and persisted in the native home;
- the TUI remains usable without DevSpace prompt or session-protocol injection.

### B. Execution plane

Prove:

- the executor uses the exact project's runtime image identity;
- the exact managed worktree is `/workspace`;
- the exact narrowly required Git administration state is present and no broad managed
  root is mounted;
- the trusted Codex exec-server and required sandbox helper run in that image or through
  verified read-only artifact injection;
- the executor has no native home, Codex credentials, Agent socket, Docker socket,
  production directory, unrelated managed state, host namespace, or shared credential
  volume;
- the executor's effective project sandbox is enforced and fails closed.

### C. Routing

From the real native TUI, prove that all of these execute/read/write remotely:

- `pwd` reports the executor's logical `/workspace`;
- `git status`, `git diff`, and `git log` use the exact Git state;
- Node, Python, package scripts, nested child processes, and one harmless toolchain
  command run in the executor;
- project AGENTS.md is read from the executor;
- normal project file reads and writes use the executor filesystem;
- `apply_patch` changes the executor worktree;
- process observation and executor logs show project commands spawning only in the
  project executor and never in the control sidecar.

### D. Security and transport

Prove:

- a sentinel file in native `CODEX_HOME` cannot be read by a model-directed executor
  command through direct path, traversal, symlink, alternate path, environment, or
  `/proc` tricks;
- the project executor cannot access the control filesystem or discover a mounted home;
- no endpoint is published publicly or reachable through host networking;
- exact `0.153.4` transport authentication is recorded if available, including what is
  authenticated, where the secret is held, and how the endpoint is scoped;
- if authentication is unavailable, the isolated-network result is explicitly marked
  feasibility-only and does not pass the migration gate;
- executor/control transport loss fails the remote operation and never starts a local
  replacement;
- native-home sentinel evidence is pass/fail only and never prints its contents.

The `/proc` checks must run with separate PID namespaces and no host namespace exposure;
they test that the executor cannot inspect the control filesystem/process namespace, not
that a prohibited shared namespace has been introduced.

### E. Native lifecycle

Prove:

- stop the native TUI normally without deleting the native home;
- identify the native session ID passively from provider-owned state/provenance;
- invoke native `codex resume NATIVE_SESSION_ID` through a new control-sidecar PTY;
- prove the resumed session uses the same persistent home, remote-only environment, and
  logical `/workspace`;
- prove no project process appeared in the control sidecar during initial launch or resume;
- prove a missing/stale executor prevents resume rather than starting locally.

### F. Negative-path enforcement

Prove by configuration and runtime checks, not operator promises, that the managed path
rejects or disables:

- `/shell` and any local environment;
- command hooks and legacy notify hooks;
- local MCP stdio and local HTTP/helper execution;
- unsafe model-accessible plugin installation/update/maintenance;
- program-based executor launch;
- Unified Exec disabled;
- missing, stale, or `none` executor configuration;
- shared app-server daemon reuse that can ignore executor selection;
- danger/full-access and sandbox bypass;
- any remote-to-local fallback after executor failure.

If a forbidden path cannot be made unavailable or fail closed in the effective
`0.153.4` configuration, the managed native profile is unavailable and the gate fails.

## Minimal feasibility experiment

The first experiment should be the smallest two-container proof, not a browser or
Workbench integration.

1. Start a dedicated rootless Docker network containing only one control sidecar and one
   project executor. Publish no ports.
2. In the control sidecar, mount a persistent Agent-private native home at
   `/codex-home`, inject only the trusted Codex control artifact, mount no project
   worktree, and provide no Docker/Agent socket.
3. In the executor, use the exact project image, exact `/workspace` worktree, exact Git
   administration, verified exec-server artifact, no native home/credentials, and no
   Docker/Agent socket.
4. Configure the control sidecar with `CODEX_EXEC_SERVER_URL` or an exact remote-only
   `environments.toml` configuration. Reject local and program entries before launch.
5. Put a random canary only in the native home. Prove with Agent-controlled checks that
   the control parent can see the canary, while the executor cannot. Never print it.
6. Attach a real native TUI and have the operator perform the routing/security checks
   without injected prompts or slash commands.
7. Inspect process ancestry, executor RPC/process logs, mounts, namespaces, environment
   values, and network reachability after every check.
8. Stop the TUI, record its native session ID, recreate or reconnect the control sidecar
   as appropriate, and run `codex resume NATIVE_SESSION_ID` with the same remote `/workspace` mapping.
9. Run the negative-path checks and deliberately remove/stale the endpoint. Confirm every
   failure is surfaced without a local process spawn.
10. Preserve only bounded redacted evidence: version/artifact identity, image identity,
    runtime generation, mount/namespace/auth result, routing result, lifecycle result,
    and pass/fail codes. Do not persist transcript, auth, home, or credential contents.

The no-auth network-only mode may answer whether the source-level remote route is
operational, but it cannot answer whether the final production transport boundary is
acceptable. The gate output must keep those conclusions separate.

## Migration relationship to the structured app-server system

The existing structured path remains the production/default authority until this split
architecture passes its complete gate and a later lifecycle/migration design is
approved. This document does not change:

- ADR 015;
- `docs/specs/ai-sessions-v1.md`;
- current Web-owned AI-session tables, event/outbox contracts, or structured approval
  handling;
- current Agent credential staging/lease/writeback behavior;
- current structured Codex app-server lifecycle;
- existing browser Workbench AI UI.

The eventual migration, if separately approved, must be additive and reversible until
the native path has passed real dogfood. It must preserve the structured path as an
explicit fallback during the transition, avoid silently interpreting structured history
as native history, and make authority changes in a separate durable-document decision.

Only after native execution, zero-mount TUI behavior, authenticated transport, native
resume, concurrent sessions, failure behavior, and lifecycle integration are all proven
may a later plan address:

- lightweight native-session associations in Web/SQLite;
- browser attachment to native TUI PTYs;
- Workbench sidebar/navigation;
- runtime stop/recreate and Agent-restart reconciliation;
- deliberate durable-authority updates and retirement of duplicate structured behavior.

## Explicitly not yet implemented

This specification creates no runtime behavior. It does not yet implement:

- control-sidecar or project-executor creation/lifecycle code;
- authenticated exec-server transport or its credentials;
- exact-image Codex artifact injection for the executor;
- remote-only native Codex configuration enforcement;
- local hook/MCP/plugin rejection;
- no-project-mount native TUI startup/resume;
- native session-ID correlation or duplicate-session prevention;
- Web/SQLite native-session association or browser PTY attachment;
- Agent-restart reconciliation or durable PTY survival;
- migration or deletion of the structured app-server path.

These are feasibility or later implementation concerns, not unfilled sections of this
document. No Workbench/session implementation plan may be created until the user reviews
and approves this specification and the hard feasibility decision is recorded.

## Architectural conclusion

The split model is the only currently acceptable direction for pursuing native Codex
TUI/session behavior after the failed single-sidecar gate:

```text
native Codex control process sees CODEX_HOME
project executor never receives CODEX_HOME
all permitted project execution goes through the remote executor
executor failure cannot become control-sidecar execution
```

The Codex source supports the core remote environment, remote process, remote filesystem,
remote patch, and remote AGENTS.md paths in `0.153.4`. It does not by itself prove the
zero-mount native TUI lifecycle, complete local-path denial, or authenticated direct
transport. Those remain hard feasibility conditions. Until they pass, the final verdict
for production migration is **NO-GO**, while the architecture itself remains **GO WITH
CONDITIONS** for the narrowly scoped feasibility experiment.
