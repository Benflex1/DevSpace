# Native Codex App-Server Remote Code Mode Feasibility

## Status and decision boundary

This document specifies the next conditional feasibility experiment after the
approved split control/execution design. It is an architecture specification,
not an implementation plan, product migration decision, or authorization to
change the shipped AI-session system.

The experiment admits Codex `0.153.4` first. A different Codex artifact requires
a separate compatibility decision. All source claims about Codex behavior in
this document refer to the exact upstream tag `rust-v0.153.4`, peeled commit
`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`, unless a newer comparison commit is
identified explicitly.

This specification is layered on:

- [`2026-09-16-codex-cli-split-execution-design.md`](2026-09-16-codex-cli-split-execution-design.md),
  which remains the authority for the physical control/execution boundary;
- [`2026-09-16-codex-cli-split-execution-feasibility.md`](../plans/2026-09-16-codex-cli-split-execution-feasibility.md),
  which records the prior feasibility harness and its result model.

The current structured app-server Workbench path remains shipped and default.
This document does not change ADR 015, `docs/specs/ai-sessions-v1.md`, Web,
SQLite, Workbench, browser terminal behavior, or the structured app-server
authority.

## Context and proven incompatibility

The preceding split experiment proved the following independently:

- native Codex `0.153.4` TUI startup and Docker PTY attach/resize;
- persistent Agent-private native `CODEX_HOME` in a control sidecar;
- an exact project-image executor with the managed worktree and Git state;
- remote project execution through `CODEX_EXEC_SERVER_URL`;
- physical absence of native home and credentials from the executor;
- execution/control-egress network separation and no executor Internet route;
- remote-only filesystem, process, and project-toolchain routing at the
  non-Code-Mode boundary.

The real model gate then selected `gpt-6-astra`. The model metadata selects
`ToolMode::CodeModeOnly`. The managed profile had:

```toml
[features]
unified_exec = true
code_mode = false
code_mode_host = false
```

Codex correctly failed closed with `code-mode host is disabled`; no project
command ran. This was not a PTY, code-server, rootless-Docker, or private-home
escape failure.

The exact `0.153.4` selector test
`codex-rs/core/tests/suite/model_runtime_selectors.rs` proves that a
`CodeModeOnly` model keeps Code Mode entrypoint tools, removes direct
`shell`/`shell_command`/`exec_command`, and emits the fail-closed warning when
the Code Mode host is unavailable. Enabling only direct shell tools cannot
preserve the required model behavior.

The next experiment therefore changes only the Code Mode composition:

```text
native Codex TUI
  -> native Codex app-server in control sidecar
  -> remote gRPC Code Mode host in project executor
  -> normal Codex core nested-tool dispatch
  -> remote selected environment
  -> executor exec-server
```

The native TUI, native app-server, native home, approvals, sessions, and resume
remain provider-owned. DevSpace owns container, network, process, endpoint, and
bounded lifecycle evidence only.

## Goals

The feasibility experiment must prove, against exact Codex `0.153.4` and the
exact project image, that:

1. An ordinary native `codex` TUI in the control sidecar uses an Agent-owned
   native app-server on the per-workspace default control socket.
2. The app-server uses a remote `codex-code-mode-host` in the project
   executor, not a process-owned local host in the control sidecar.
3. A real authenticated `gpt-6-astra` turn selects `CodeModeOnly`, executes a
   bounded project operation through the remote Code Mode callback and remote
   exec-server, and produces no project process in the control sidecar.
4. The control sidecar retains native `CODEX_HOME` while the executor has no
   physical path, mount, namespace, credential, or route to that home.
5. Native approvals, native session/history state, and the exact unqualified
   command `codex resume NATIVE_SESSION_ID` work across the tested lifecycle.
6. Every mandatory local path fails closed when the remote Code Mode host,
   remote executor, or managed effective configuration is absent or stale.
7. Transport authentication is measured separately for the exec-server and
   Code Mode gRPC links.

## Non-goals

This experiment does not:

- embed a terminal in the browser or rewrite the DevSpace terminal frontend;
- add Web routes, SQLite tables, native-session associations, or Workbench UI;
- replace, delete, migrate, or weaken the structured app-server path;
- create automatic worktrees or a generic arbitrary-CLI service;
- reconstruct the Codex conversation protocol as a product API;
- synthesize prompts, turns, approvals, questions, history, or resume commands;
- copy credentials into the executor or create synthetic authentication files;
- attach the executor to control-egress for project Internet access;
- use a local Code Mode host in the credential-bearing control sidecar;
- treat private-network-only transport as production authentication;
- authorize deployment, merge, public alpha, or Workbench migration.

## Terms and security invariant

“Control” means the trusted container holding native Codex control state. “Executor”
means the exact project-image container holding the project worktree and the two
remote execution services. “Logical `/workspace`” is the path supplied in Codex
remote environment selections. “Physical `/workspace`” is the managed worktree
mount. They are intentionally different: the control sidecar may use an empty
image-local directory as logical-CWD scaffolding, but never receives project
bytes or Git state.

The non-negotiable invariant is:

> Model-directed project execution occurs only in the project executor. The
> project executor has no physical path, mount, namespace, socket, credential,
> shared state, or network route through which it can reach the native home or
> turn the control sidecar into its execution environment.

The Code Mode JavaScript runtime is model-directed computation. In this design
it is hosted in the executor so its process namespace and physical filesystem
also lack native home. Its nested tool calls return to the native Codex core and
are subject to the selected remote environment and managed permission policy.

Any executor loss, host loss, stale endpoint, missing provider, configuration
conflict, or ambiguous ownership fails closed. No error path selects a local
environment in the control sidecar.

## Component architecture

```text
authenticated owner
        |
        v
DevSpace Web
  existing structured authority; no native-home contents
        |
        v
DevSpace Agent
  trusted filesystem/Git/rootless-Docker/PTY authority
  owns lifecycle records, networks, endpoint identity, and private home path
        |
        +--> CONTROL SIDECAR
        |      native codex TUI PTYs
        |      native codex app-server
        |      persistent Agent-private CODEX_HOME
        |      native auth, sessions, history, approvals
        |      no physical project/Git mount
        |      execution network + control-egress network
        |      no Docker/Agent socket; no host namespaces
        |
        +--> PROJECT EXECUTOR
               exact project/runtime image
               exact /workspace worktree and narrow Git administration
               project toolchain
               codex exec-server
               codex-code-mode-host (gRPC)
               execution network only
               no CODEX_HOME or Codex credentials
               no Docker/Agent socket; no host namespaces

execution network (private/internal, no published ports)
  control <---- exec-server WebSocket ----> executor
  control <---- Code Mode gRPC -----------> executor

control-egress network (dedicated, non-internal, no published ports)
  control ----> OpenAI/ChatGPT authentication and model services
  executor is not attached
```

### Native TUI process

The TUI is a native `codex` process in a Docker PTY in the control sidecar. It
owns terminal input/output, native approval rendering, native session pickers,
native history presentation, and native resume selection. DevSpace supplies
only PTY bytes, input/resize forwarding, process lifecycle, and bounded
observations. DevSpace does not type a prompt, slash command, approval, session
ID, or checklist into the TUI.

The TUI is not configured with a remote Code Mode host directly. In `0.153.4`
the native TUI's supported remote target is an app-server endpoint. The TUI
must discover the Agent-owned app-server through the native default Unix socket
when invoked as bare `codex` or `codex resume NATIVE_SESSION_ID`. The normal
acceptance path has zero CLI configuration or launch overrides. An explicit
`--remote` invocation may be used only as a separately labeled diagnostic
comparison; it does not satisfy the unqualified-resume acceptance target.

### Native app-server process

The Agent starts one native `codex app-server` process per control-side runtime
generation before starting a TUI PTY. The app-server:

- reads and writes the persistent native `CODEX_HOME`;
- owns native authentication, session/history persistence, and approval
  lifecycle;
- loads the managed remote environment and its logical `/workspace` selection;
- receives `--code-mode-host http://codex-code-mode-host:CODE_MODE_PORT`;
- creates the native `GrpcCodeModeSessionProvider` for that endpoint;
- serves the native control socket at `--listen unix://`;
- does not mount or inspect the real project worktree;
- never launches a local `codex-code-mode-host`.

The app-server is a native Codex control process, not a DevSpace conversation
proxy. DevSpace does not parse or replay its JSON-RPC conversation stream.
Starting this process is lifecycle orchestration, not a Code Mode `program`
executor entry and not project execution.

The app-server must be started with Code Mode host support enabled in the
effective configuration and with the remote host URL supplied to the native
app-server option. A missing or stale remote provider is a startup failure. The
app-server must not silently use its default local provider. Hook, notify,
Unified Exec, local-environment, and sandbox restrictions must come from the
trusted managed/persistent configuration consumed during app-server and TUI
bootstrap; they must not be smuggled into the normal TUI argv.

### Project executor

The executor is a dedicated container created from the exact inspected image of
the running DevSpace development runtime. It receives:

- the exact managed worktree at physical `/workspace`;
- only the exact Git administration state required by that worktree;
- the exact project image toolchain;
- the verified read-only Codex closure, including `exec-server` and
  `codex-code-mode-host` when the image does not already contain them;
- two private service listeners bound only to the execution network.

The executor receives no native home, `CODEX_HOME` value pointing to the
control home, auth/refresh/token/cookie data, control session files, Docker or
Agent socket, unrelated managed state, production directory, host namespace,
or control-egress attachment. Its project processes have only the executor's
process namespace and network boundary.

`codex exec-server` serves the selected remote environment. The
`codex-code-mode-host` listens on a separate private gRPC port. Their endpoint
names and ports are distinct even though they share the executor container.
Neither listener is published to the host, browser, public ingress, or an
unrelated DevSpace service.

### Agent responsibility boundary

The trusted Agent may know and own the host path for the native home. It may:

- allocate a per-workspace private native home;
- validate ownership, mode, type, containment, and identity;
- mount the home only into the control sidecar;
- launch and inspect the native app-server and TUI PTYs;
- create and inspect both private networks;
- create, inspect, recreate, and clean the executor and its two services;
- persist opaque runtime/generation/endpoint identities.

It must not put home or credential contents in Web responses, SQLite, labels,
logs, events, terminal evidence, or project-accessible APIs. It must not use the
existing structured credential lease/staging/writeback as the native-home
authority.

## Process and startup lifecycle

The Agent performs these steps in order for a workspace/runtime generation:

1. Resolve the existing managed project/workspace ownership, exact runtime
   generation, exact worktree, Git administration, image identity, and artifact
   compatibility.
2. Allocate or validate the per-workspace Agent-private native home. The home
   persists across control-sidecar and app-server restarts. No credentials are
   copied from the structured path.
3. Create the private execution network and dedicated control-egress network.
   Inspect membership, route properties, publication, capabilities, and
   forwarding state before workloads start.
4. Create the exact-image executor with exact mounts, no native home, no
   credentials, and one execution-network attachment.
5. Start and verify the executor-side `codex exec-server` and
   `codex-code-mode-host`. Verify each listener on its own endpoint and retain
   only bounded process/readiness metadata.
6. Create the control sidecar with the native home, verified control artifact,
   managed policy assets, an image-local empty `/workspace` if required, both
   networks, and no project/Git/socket/host mounts.
7. Start the native app-server in the control sidecar with:

   ```text
   codex app-server
     --listen unix://
     --code-mode-host http://codex-code-mode-host:CODE_MODE_PORT
   ```

   The exact executable, arguments, and managed configuration are validated
   before the process is considered owned. The default Unix socket is derived
   from the mounted `CODEX_HOME`.

8. Verify the app-server socket, app-server process identity, remote Code Mode
   provider, `CODEX_EXEC_SERVER_URL`, logical `/workspace`, no-local policy,
   and all negative-path restrictions.
9. Start a native TUI PTY with exactly bare `codex`. The TUI must connect to
   the already-running app-server through the native default socket. If it
   creates an embedded app-server with a local Code Mode provider, the gate
   fails; the Agent must not repair that by adding a prompt relay or local
   host.
10. After the native operator gate, stop resources in ownership-checked order.
    Preserve native home, auth, session/history state, and project worktree/Git
    state. Remove only resources owned by this workspace/generation.

The control sidecar has no real project mount at any step. The app-server and
TUI can use `/workspace` as a logical remote cwd even when the control image has
only an empty image-local directory there. This is a hard empirical condition,
not a source-inspection assumption.

## Native app-server socket and unqualified resume

### Default socket

Codex `0.153.4` derives the native control socket as:

```text
<CODEX_HOME>/app-server-control/app-server-control.sock
```

`codex app-server --listen unix://` resolves the empty Unix URL to that path.
The parent directory is private; the socket is created with restrictive
permissions. The socket is not exposed on either Docker network.

For this experiment, the native home is per workspace rather than shared across
workspaces. The prior split specification permitted a shared home as an
initial option, but the default socket is an authority boundary: a shared home
could cause one workspace's bare TUI to discover another workspace's daemon.
Per-workspace home allocation preserves persistent native provider state and
native login semantics while making daemon ownership and endpoint selection
provable. It does not create a second conversation authority.

The Agent stores an opaque home identity and app-server ownership identity, not
the host path in Web-visible state. A live socket is accepted only when its
server process, home identity, workspace ID, generation, Code Mode endpoint,
exec endpoint, and container labels all match the current record. A socket
that responds but belongs to another generation, workspace, or process is a
hard ownership conflict; the TUI is not attached to it.

### Stale sockets and restart

On app-server start, the Agent follows the native socket semantics:

- a live, correctly owned socket is reused;
- a stale socket is removed only after its path type, ownership, and stale
  connection state are proven;
- a non-socket or live socket with unknown ownership is never removed or used;
- a missing socket starts the app-server with the default `unix://` listener;
- an app-server that exits before readiness prevents TUI launch.

The Agent does not pass a custom remote endpoint to hide a failed default
socket. A custom endpoint may be used only in a diagnostic comparison and can
never satisfy unqualified resume.

### Bare `codex` and `codex resume`

The intended user-visible commands, run inside the control-side terminal, are:

```text
codex
codex resume NATIVE_SESSION_ID
```

Before either command, the Agent has already ensured the correctly owned native
app-server is listening at the default socket in the same persistent home.
The TUI's native implicit-daemon probe must select that socket. The command
argv is exactly `[codex]` for a new session or
`[codex, resume, NATIVE_SESSION_ID]` for resume. It must contain no `-c` or
`--config`, `--enable` or `--disable`, profile selection, `--remote`,
`--strict-config`, or any other launch option that prevents implicit local
daemon reuse. A diagnostic invocation containing `-c notify=[]` is explicitly
non-acceptance evidence and is not equivalent to the zero-override path.

The preflight must record the actual process argv and default-socket selection:
`[codex]` for a new session and `[codex, resume, NATIVE_SESSION_ID]` for a
resume. It must reject any extra CLI token and must prove that the native
default-socket daemon, not an embedded app-server, handled the launch.

If a mandatory restriction can be enforced only by adding a TUI CLI override,
the unqualified-resume requirement is `BLOCKED/INCOMPLETE`; the launch is not
silently relaxed.

For a new session, native Codex creates the session/thread and persists its
history in the native home. The Agent observes only provider-owned identity
metadata and bounded process provenance. It does not ask the TUI to print the
ID.

After normal TUI exit, the operator obtains the native ID through the native
provider's normal session/history surface or a passive provider-state
observation. The Agent then creates a new TUI PTY and passes that opaque ID as
the only resume argument. If the native ID is absent, ambiguous, or already
proven live, resume is refused rather than duplicated.

The resume gate passes only when the unqualified command reconnects to the same
native session authority and the resumed turn uses the same managed remote
environment, Code Mode provider, executor generation, and logical
`/workspace`. An explicit `codex resume --remote ...` success while unqualified
resume selects an embedded/local app-server is not a pass; it is recorded as a
native CLI compatibility limitation.

### Process-loss cases

| Event | Required behavior |
| --- | --- |
| TUI PTY dies, app-server lives | Native app-server and home survive; a new bare `codex resume <id>` reconnects through the default socket. |
| TUI and app-server die | Agent restarts the native app-server with the same home, endpoint identities, and generation, then the exact unqualified resume is attempted. |
| Control sidecar is recreated | Home is reused only after identity validation; no project mount is added; the native app-server is recreated before the TUI. |
| Executor dies, same generation is valid | Both executor services are recreated from the same exact image/worktree/Git identity and the native app-server reconnects to the same workspace-scoped endpoint identity. Operations fail while absent; no local retry occurs. |
| Executor/workspace generation changes | Existing bindings are stale. Native resume is blocked until a new exact binding is explicitly established; no old session silently points at a different worktree or image. |
| Socket is stale or ownership is ambiguous | TUI and resume fail closed. The Agent reconciles only resources it can prove it owns. |
| App-server is live but Code Mode host is absent/stale | The TUI is not launched, or the native turn fails before Code Mode execution; the local provider is never selected. |

An app-server restart recreates process-scoped gRPC Code Mode sessions. Native
session/history state remains provider-owned and persistent. An in-flight Code
Mode cell that was held only in the old app-server process is not claimed as
completed after restart. The resumed native session must establish a new remote
Code Mode session before accepting a project operation.

## Network topology and endpoints

### Execution network

The per-workspace execution network is internal/private, has no published
ports, and contains exactly the control sidecar and project executor. It is
the only path for:

- control to the executor `exec-server` WebSocket endpoint;
- control to the executor `codex-code-mode-host` gRPC endpoint.

The exec-server endpoint and Code Mode endpoint use different private aliases
and ports, for example:

```text
ws://codex-executor:EXEC_PORT
http://codex-code-mode-host:CODE_MODE_PORT   # HTTP/2 gRPC endpoint
```

The exact port numbers are allocated and recorded as bounded runtime metadata;
they are not published. `http://` is the native `0.153.4` app-server client
form for the gRPC host URL; it does not mean the endpoint is public HTTP.

### Control-egress network

The dedicated non-internal control-egress network contains only the control
sidecar and has no published ports. It is the control sidecar's path to native
OpenAI/ChatGPT authentication and model services. The executor is never
attached to it, even if project tools might later want Internet access. Project
egress is a separate design question and is not granted by this experiment.

The control sidecar has no `NET_ADMIN` or equivalent routing capability, no
IP-forwarding capability, no forwarding/NAT process, and no proxy/relay
listener. The execution attachment is not a transit path to control-egress.
The executor cannot address the control-egress interface, its gateway, the
control's egress address as a relay, host services, or unrelated managed
services. The live gate tests those claims from the executor; “no published
ports” alone is insufficient.

Neither network is the Docker default bridge, host networking, or a shared
network containing unrelated containers. The Agent rejects a topology that
cannot empirically prove the member set, route table, forwarding state,
capabilities, listener set, and absence of indirect executor egress.

### Transport authentication

Network placement and protocol authentication are separate claims. Exact
`0.153.4` evidence currently proves no protocol authentication for either
direct local transport:

- the exec-server WebSocket listener has no proven bearer, token, or mutual
  authentication;
- the Code Mode gRPC server exposes the service and health route without an
  authentication interceptor; the client rejects URL credentials and injects
  only trace context.

The experiment records authentication status independently for the two links.
An unauthenticated link is usable only to characterize the native composition
inside the dedicated private network. It cannot be described as production
ready.

## Code Mode routing contract

### Native selection and provider composition

The exact intended path is:

```text
gpt-6-astra model metadata: ToolMode::CodeModeOnly
  -> native TUI request
  -> native app-server thread/turn
  -> GrpcCodeModeSessionProvider in app-server
  -> executor codex-code-mode-host over private Code Mode gRPC
  -> V8 Code Mode cell in executor
  -> CodeModeSessionDelegate callback over the same gRPC session
  -> CodeModeDispatchBroker in native Codex core
  -> ToolCallRuntime
  -> selected remote TurnEnvironment
  -> CODEX_EXEC_SERVER_URL
  -> executor exec-server
  -> exact /workspace operation
```

The first and last stages are native Codex. DevSpace supplies the executor
endpoint and lifecycle, the private networks, the physical mounts, the
effective managed configuration, and evidence collection. DevSpace does not
implement `CodeModeSessionDelegate`, `CodeModeDispatchBroker`, nested tool
semantics, approvals, or session history.

`CodeModeOnly` is important: direct shell tools are not model-visible, but the
Code Mode entrypoint can invoke the permitted nested execution tools. A real
`gpt-6-astra` turn must show that the Code Mode provider is the executor host
and that nested `pwd`, Git, file, or bounded write operations reach the remote
environment.

### Nested dispatch and remote project execution

The executor Code Mode host runs the cell and emits nested tool calls. The
native app-server's provider maps those calls into the normal core delegate and
dispatch broker. The normal Codex tool runtime then resolves the selected
`TurnEnvironment`.

For Unified Exec, the selected remote environment enters the remote branch of
the process manager before the local process branch. Shell commands, Git,
Node/Python/package scripts, and all child processes therefore start in the
executor. `apply_patch`, file reads/writes, metadata operations, and AGENTS.md
discovery use the selected remote filesystem. A command-output string is not
evidence of routing; process ancestry, container-local PID observations,
exec-server records, and worktree identities are required.

The managed profile must make the remote environment the only available
environment, set logical cwd and workspace root to `/workspace`, require
Unified Exec, and retain the executor's sandbox. If `CODEX_EXEC_SERVER_URL` is
missing, empty, `none`, stale, or replaced by a program entry, the native
app-server/TUI path is unavailable. There is no selection of the local
environment as a retry.

Under that effective profile, every model-directed project operation that can
change or inspect project state is forced through the executor: Code Mode
nested execution, shell/Unified Exec, Git and child processes, file reads and
writes, `apply_patch`, metadata helpers, and AGENTS.md discovery. The native
TUI, native app-server, authentication, session/history access, and the gRPC
client itself remain control-side processes; those are control authority, not
project execution. This forcing is a property to prove from effective
configuration and process evidence, not a conclusion from the endpoint URL
alone.

### AGENTS.md and control-local helpers

AGENTS.md discovery and project filesystem helpers must execute through the
remote environment. The control sidecar may read native global Codex
configuration, native auth/history files, the app-server socket, and trusted
control artifacts. It must not read project AGENTS.md or project files from an
image-local copy.

Some operator-selected Codex conveniences may be control-local by upstream
design, such as clipboard or an external editor. They are disabled or
degraded for this experiment and cannot be used to run model-directed project
commands. Any model-accessible local helper is a negative-path failure.

## Code Mode host capability analysis

### Exact upstream runtime surface

The Code Mode runtime is an embedded V8 runtime, not Node.js or Deno. At
`rust-v0.153.4`, `runtime/globals.rs` removes `console`, `Atomics`,
`SharedArrayBuffer`, and `WebAssembly`, then installs the explicit `tools`,
`ALL_TOOLS`, timer, output, state, notification, and exit helpers. The runtime
contract tests in `runtime/service_tests.rs` enumerate ordinary ECMAScript
objects such as `Array`, `Function`, `eval`, and `Proxy`, but do not provide
`process`, `require`, `fs`, `child_process`, `net`, `fetch`, `Deno`, or
WebAssembly. `runtime/module_loader.rs` rejects imports with
`unsupported import in exec`.

The `tools` callbacks do not run operating-system operations themselves. The
callback serializes the input and emits a runtime tool-call event. The native
delegate/broker receives that event and invokes the normal Codex tool runtime.
V8 sandbox support is enabled by the runtime build, but JIT is enabled by
default unless the host explicitly initializes V8 in jitless mode. These are
defense-in-depth properties, not a substitute for physical container
separation.

The capability results for model JavaScript are:

| Capability asked about | Direct JavaScript capability in exact runtime | Security consequence and evidence |
| --- | --- | --- |
| Read arbitrary local files | No documented filesystem API or import; ordinary ECMAScript values are not filesystem handles. | `runtime/globals.rs:15-49`, `runtime/service_tests.rs:807-923`, and `runtime/module_loader.rs:175-234` show the exposed surface. A V8/runtime vulnerability is not ruled out by this API list, so a local host is not accepted as the physical boundary. |
| Read `/codex-home` | No direct JS filesystem API. | A remote executor has no physical home path. A local host process would be co-located with the mounted home, so the architecture cannot rely on JS API absence alone. |
| Inspect process environment | No `process` global or environment helper. | A local host OS process can still inherit or inspect its container environment; `remote_session/connection.rs:155-196` spawns it as a child and `protocol/src/shell_environment.rs:13-33` is not a complete filesystem/credential boundary. The remote host receives only executor environment. |
| Read `/proc` | No direct JS filesystem API. | Separate PID namespaces and physical executor placement prevent the remote host from seeing control processes. A local host would share the control namespace. |
| Spawn subprocesses | No Node `child_process`, shell, or process API exposed to JS. | The host binary itself is already an OS process. `ProcessOwnedCodeModeSessionProvider` starts that process locally; this is why it is not accepted in control. |
| Open arbitrary network connections | No `net`, `fetch`, or socket API exposed to JS. | The remote host has only its intended private gRPC listener/callback path and no control-egress attachment. A local host would live on the control egress network. |
| Load native modules | No Node module loader; imports are rejected. | `runtime/module_loader.rs:223-234` rejects unsupported imports. Native V8/JIT exploitation remains outside the API guarantee. |
| Access Node.js APIs | No Node runtime is linked into Code Mode. | `code-mode-runtime/Cargo.toml:15-26` and the runtime globals/tests show a V8-only service surface. |
| Invoke shell without the delegate | No direct shell primitive exists in the JS runtime. | `runtime/callbacks.rs:14-73` emits a tool-call event; `core/src/tools/code_mode/delegate.rs:257-296` dispatches it through the native delegate. The managed tool list must still exclude local paths. |
| Bypass approval or sandbox policy | JS cannot set native approval state or directly select a local process branch. | Nested requests enter `ToolCallRuntime` and the selected `TurnEnvironment`; the executor applies its sandbox. A misconfigured enabled tool or local fallback remains a gate failure. |
| Obtain control credentials/auth state | Remote Code Mode JS has no home mount, credential env, or control namespace. | The gRPC protocol carries session/tool messages, not the native home. A local host has physical co-location and is rejected even if normal JS cannot read files. |

This table distinguishes normal supported capability from a container security
proof. The absence of Node APIs is useful defense in depth; it does not prove
that the control-side process is safe to co-locate with native credentials.

### Local Code Mode host option

Enabling `CodeModeHost` while leaving the native provider local selects
`ProcessOwnedCodeModeSessionProvider`. Its `connection` code invokes
`Command::new(host_program)`, pipes the host process, and keeps it alive across
sessions. The host is therefore an ordinary child in the control sidecar. It
shares the control filesystem, PID namespace, environment boundary, and
control-egress network. The environment scrubber removes selected inherited
variables but is not a secret filesystem boundary and does not remove the
physical `CODEX_HOME` mount.

Normal Code Mode JavaScript cannot call `fs` or `child_process`, and normal
nested project tools can still be sent to the remote executor. That is not
enough for this architecture: model-directed Code Mode execution itself would
run in the credential-bearing container, and a runtime or native-host defect
would have a path to the home and control OS resources. No separate container
or equivalent admitted `0.153.4` sandbox boundary protects it. Option A is
therefore not an acceptable implementation of the approved physical invariant.

### Remote Code Mode host option

The exact app-server composition is supported by `0.153.4`:

- `cli/src/main.rs` exposes `codex app-server` and passes its
  `--code-mode-host` option into `AppServerRuntimeOptions`;
- `app-server/src/code_mode_host.rs` parses the remote URL;
- `app-server/src/lib.rs:555-570` constructs a
  `GrpcCodeModeSessionProvider` when the feature is enabled;
- the `code-mode` gRPC provider supports reconnectable sessions;
- `code-mode-host/src/main.rs` and `transport.rs` support `grpc://IP:PORT`;
- `code-mode-host/src/grpc_transport.rs` serves the CodeModeHost service over
  HTTP/2 and exposes only a health route in addition to the service;
- the native TUI can connect to a native app-server over its Unix socket.

The TUI has no direct `--code-mode-host` option. The native app-server is the
supported composition point. This option is the subject of the next live
experiment, and its unqualified default-socket behavior must be proven rather
than inferred from the presence of the flags.

### Third-host option

An isolated third Code Mode host container could use the same native app-server
gRPC option and execution-network callback, but exact `0.153.4` does not expose
a direct TUI-to-host transport. The app-server would still be required as the
native TUI's endpoint. A third container adds another lifecycle, endpoint,
network-membership, artifact, and unauthenticated gRPC boundary without
removing the need to prove app-server default-socket selection. It is not part
of this experiment. It becomes a separate option only if the exact project
image cannot run the verified Code Mode host closure and a separately reviewed
executor-side placement is required; it must still have no native home,
credentials, control-egress, or host namespace.

### Direct-tool model option

A model whose metadata selects `ToolMode::Direct` can avoid Code Mode entirely,
but that is not a solution for `gpt-6-astra`. Selecting a direct-tool-only
allowlist would either fail when the service selects `CodeModeOnly` or change
the model/tool contract the experiment is required to test. Direct-tool models
may be useful as a separate compatibility comparison after the remote Code
Mode path is characterized; they do not satisfy the product requirement for
normal native model selection and cannot turn a failed Astra gate into a pass.

### Current bare-TUI composition

The current composition with `code_mode = false` and `code_mode_host = false`
is Option E: exact `CodeModeOnly` models fail closed before project execution.
It remains the correct fail-closed behavior and is not repaired by enabling
direct shell tools. The next experiment must provide the remote provider
through the app-server instead.

### Embedding-host boundary

The normal native UX does not require an embedding host or a DevSpace app-server
RPC wrapper. The native TUI connects to the native app-server through the
home-derived Unix socket, and the native app-server connects to the Code Mode
host through its upstream gRPC provider. A test-only app-server protocol client
may be used for an automated model-compatibility probe, but it is not a
production conversation authority and cannot replace the native TUI gate.

## Effective configuration and fail-closed rules

The managed native profile for this experiment has these required effective
properties:

```toml
[features]
unified_exec = true

[features.code_mode]
enabled = true

[features.code_mode_host]
enabled = true
disable_in_process_fallback = true
```

The equivalent managed requirements must produce the same effective values;
the exact 0.153.4 `config.toml` shape above is the source-backed form. The
runtime also requires:

```text
CODEX_EXEC_SERVER_URL = exact private executor exec-server endpoint
app-server --code-mode-host = exact private executor Code Mode gRPC endpoint
local environment = unavailable
program-based executor = unavailable
logical cwd = /workspace
workspace roots = [/workspace]
```

The app-server's Code Mode provider must be the explicit remote gRPC provider.
`code_mode_host = true` alone is insufficient because it can select the local
process-owned provider in a TUI-created or embedded app-server. The Agent must
inspect the actual app-server process configuration and provider readiness.

`disable_in_process_fallback = true` is mandatory for this experiment. It is
the exact `0.153.4` fail-closed setting under `[features.code_mode_host]`, and
must be effective for every native app-server process. `CodeModeOnly` itself
must never fall back to direct tools. Missing/stale remote Code Mode host
configuration must fail before or during the turn; it must never degrade to a
local provider or direct/local execution. If the old artifact cannot enforce
these values for all admitted model tool modes, the profile is unavailable
rather than selectively trusting a model.

The managed configuration is enforced against both native/global home layers
and project-controlled `.codex` layers. A project layer may not re-enable:

- local environment or `/shell`;
- disabled Unified Exec or a missing/alternate endpoint;
- local Code Mode provider or local Code Mode host;
- command hooks, legacy notify, local MCP stdio, local HTTP/helper execution;
- unsafe plugin installation/update/maintenance;
- a `program` executor, shared unrelated app-server daemon, or another
  endpoint;
- danger/full-access permission or sandbox bypass;
- remote-to-local fallback after executor failure.

The strongest managed configuration mechanism actually honored by exact
`0.153.4` must be identified in the feasibility implementation. A preflight
that checks one file and then permits a lower-trust project layer to override
it is not enforcement. If no trusted mechanism survives project-layer loading,
the experiment stops as a hard incompatibility.

## Security and mount boundaries

### Mount matrix

| Resource | Control sidecar | Project executor | Executor child/project process |
| --- | --- | --- | --- |
| Persistent native `CODEX_HOME` | read/write at `/codex-home` | absent | absent |
| Native auth/refresh/session/history | present only through native Codex | absent | absent |
| Real project worktree | absent | exact `/workspace`, read/write | inherited exact worktree |
| Git administration | absent | exact narrow required paths | exact Git paths |
| Codex artifact | trusted read-only closure | trusted read-only closure | executable as required |
| Docker/Agent socket | absent | absent | absent |
| Host namespace/production path | absent | absent | absent |
| Execution network | present | present | inherited executor network only |
| Control-egress network | present | absent | absent |

The control process itself does not need the real `/workspace` mount. Its
image-local `/workspace`, if present, is empty scaffolding only. App-server
filesystem calls that refer to logical `/workspace` must go through the remote
environment. A physical control-side project mount is a hard failure.

### Home canary and namespace proof

The live experiment creates a random non-secret canary only in the native home.
The control-side parent check may prove presence without printing contents. A
project-directed operation tests direct absolute path, traversal, symlink,
environment-variable discovery, `/proc` inspection, alternate mount paths, and
directory enumeration. The canary contents are never returned in output or
evidence. Any successful executor read is `FAIL`.

The executor and control have separate PID namespaces and no host namespaces.
The executor's `/proc` and process table must not reveal the control process or
its mounted home. This proof cannot be obtained by adding a shared namespace.

### Network proof

The live gate proves all of the following from Docker metadata and bounded
runtime probes:

- execution network members are exactly control and executor;
- control-egress members are exactly control;
- control reaches OpenAI/ChatGPT through control-egress;
- control reaches both private executor endpoints through execution;
- executor cannot reach the Internet, control-egress gateway, control egress
  address as a relay, host/gateway, or unrelated DevSpace service;
- executor cannot reach either endpoint through a non-execution path;
- control has no `NET_ADMIN`, IP forwarding, forwarding/NAT process, proxy, or
  relay listener;
- neither private network publishes a port or uses host networking.

If rootless Docker cannot express and prove this topology, the result is
`BLOCKED/INCOMPLETE`; the executor is never attached to control-egress as a
convenience.

## Native approvals, sessions, and history

The native TUI renders approvals and questions. The native app-server and Codex
core own the approval state and session/history files. The remote executor
changes the location of the approved project operation, not the authority that
asks for or records approval.

The experiment must show, from a real TUI and real authenticated model turn,
that:

- the operator sees the native approval surface where exact policy requires it;
- no DevSpace prompt or approval is substituted;
- Code Mode nested operations are routed through the normal native runtime;
- native history/session state persists under the same home;
- the native session ID is obtained passively and is never synthesized by
  DevSpace;
- resume is the exact native command and does not rebuild a transcript.

Multiple distinct native sessions may use the same workspace and executor at
once. DevSpace must not add a one-agent-per-workspace guard. It may reject only
a second launch of the same native session ID when a live process and identity
proof already exist. Ambiguous liveness is resume-unavailable, not permission
to launch a duplicate.

## Local execution escape paths

The following paths are denied or made unavailable by the effective managed
profile, with runtime evidence where the exact binary can reach the path:

| Path | Required result |
| --- | --- |
| Local environment and `/shell` | No local environment exists; the local shell path fails closed. |
| Unified Exec disabled | App-server/TUI launch is rejected before a model turn. |
| Missing, empty, `none`, stale, or alternate exec endpoint | No TUI launch or remote-turn failure; no local process. |
| Missing/stale Code Mode host | App-server startup or CodeModeOnly turn fails closed; no process-owned local host. |
| Command hooks and legacy notify | Effective config rejects/disables them; no control-side child is spawned. |
| Local MCP stdio | Rejected; only an explicitly proven executor-backed path could be considered. |
| Local HTTP/helper execution | Rejected when it would spawn or connect from control. |
| Unsafe plugin install/update/maintenance | Not model-accessible in this managed profile. |
| Program executor | Rejected; only an Agent-created private URL endpoint is allowed. |
| Shared unrelated app-server daemon | Per-workspace home/socket and ownership proof reject reuse. |
| Danger/full-access or sandbox bypass | Rejected before project execution. |
| Remote-to-local fallback | No code path exists after executor/provider loss. |

Both native/global and project-controlled configurations are adversarial test
inputs. “The project is trusted” is not an enforcement mechanism for this
experiment. A mandatory path that cannot be disabled or made to fail closed in
exact `0.153.4` is a hard gate failure.

## Artifact lifecycle

The verified Codex artifact closure for this experiment includes the exact
admitted version and all binaries required by the control app-server/TUI,
executor exec-server, and executor Code Mode host. Read-only injection into the
exact project image is allowed when that image lacks the closure; a generic
runner image is not allowed.

Artifact staging is content-addressed/reused by verified closure identity. The
previous feasibility work created 51 duplicate immutable approximately
320 MB staging directories under:

```text
/srv/devspace/managed/state/codex-artifacts
```

Reuse now prevents continued growth, but stale artifact garbage collection is
not part of this document's implementation. The lifecycle contract for the
next implementation must retain bounded cleanup ownership and must never delete
an artifact referenced by:

- a running owned control or executor container;
- a valid persisted split runtime record;
- the currently admitted reusable closure.

An artifact cleanup failure is bounded lifecycle evidence, not permission to
switch to an unverified binary or generic image.

## Live feasibility experiment and gates

The smallest experiment is the two-container topology above plus the native
app-server process inside control. It is not a browser integration. The
operator performs the real model turn and native lifecycle actions; DevSpace
does not inject prompts or approvals.

### A. Native TUI and app-server authority

Prove:

- exact Codex `0.153.4` artifact and persistent per-workspace native home;
- control sidecar has no real project/Git mount, Docker/Agent socket, host
  namespace, or unrelated managed state;
- native app-server process uses remote `--code-mode-host` and the exact
  `CODEX_EXEC_SERVER_URL`;
- effective configuration has CodeModeHost enabled and
  `disable_in_process_fallback = true`;
- app-server listens on the default home-derived Unix socket;
- bare `codex` has exactly `[codex]` argv and selects that socket instead of an
  embedded/local app-server;
- control reaches native authentication/model services through control-egress;
- control has no forwarding, NAT, proxy, or routing capability;
- native approval/session surfaces remain usable without DevSpace injection;
- logical `/workspace` works with no physical project bytes in control.

Failure to prove unqualified bare TUI selection is recorded separately from an
explicit `--remote` diagnostic success. The latter does not satisfy this gate.

### B. Exact executor and project environment

Prove:

- executor image identity equals the running project's exact image identity;
- `/workspace` and Git administration are the exact managed identities;
- exec-server and Code Mode host closure is trusted, verified, executable, and
  read-only where injected;
- executor has no native home, credentials, control session files, sockets,
  unrelated managed state, host namespace, or control-egress attachment;
- executor has only the execution network and no external default route;
- the executor sandbox remains enforced.

If the exact image cannot execute the verified closure, this gate is incompatible;
the runtime does not substitute a generic image.

### C. Real Astra CodeModeOnly turn

Use a real authenticated model turn with exact model `gpt-6-astra`. The evidence
must show the model's admitted metadata selected `ToolMode::CodeModeOnly`, the
remote Code Mode host accepted the session/cell, and at least one bounded
project operation succeeded through the nested callback path. Suitable
operator-requested operations include `pwd`, Git status, a harmless file read,
or writing/removing a uniquely named acceptance file.

Prove with runtime evidence, not output appearance, that:

- the Code Mode host process is in the executor;
- the nested tool operation reached the executor exec-server;
- the resulting process and all child processes are executor-side;
- no project process appeared in control;
- the executor has no native home or credentials;
- any required approval was rendered by the native TUI;
- logical cwd is `/workspace` and the exact worktree/Git state is used.

If the operation only succeeds with direct shell tools, local Code Mode, a
control-side process, or a mocked model, this gate fails.

### D. Physical home, network, and transport separation

Prove:

- native-home canary probes all fail from executor without printing contents;
- control and executor have separate PID namespaces and no host namespace;
- execution network contains only control and executor;
- control-egress contains only control;
- control reaches the required Codex/OpenAI service through control-egress;
- executor cannot reach the Internet, control-egress gateway, control egress
  address, host/unrelated service, or any indirect control relay;
- no forwarding/NAT/proxy capability or process exists;
- exec-server and Code Mode endpoints are private and not published;
- authentication status for each transport is recorded separately.

The execution network is the project boundary. The control sidecar's explicit
model/authentication egress is permitted only for the trusted control process
and is not evidence of project Internet access.

### E. Native session persistence and unqualified resume

Prove, from a real native session:

1. normal native TUI session creation persists provider-owned state;
2. normal TUI exit does not remove the home or app-server authority;
3. the native ID is identified passively;
4. a new PTY runs exactly `[codex, resume, NATIVE_SESSION_ID]` with no CLI
   configuration or launch overrides;
5. conversation continuity is native, not reconstructed by DevSpace;
6. the same home/account authority, default app-server socket, remote Code
   Mode provider, exec endpoint, and logical `/workspace` are restored;
7. no control-side project process appears during resume;
8. missing/stale executor or host blocks resume and never selects local
   execution.

The operator must also test TUI loss with app-server survival, app-server/TUI
restart with home survival, and executor recreation for the same valid
generation. A changed or stale generation must fail closed. A second distinct
session may run concurrently; the same live native ID may not be resumed twice.

### F. Local fallback and escape rejection

Run static/effective-configuration and runtime negative checks for every path in
the local-execution table. Apply the checks to native/global configuration and
project-controlled configuration layers after loading. Removing or staling
either remote endpoint must produce a bounded remote/provider failure and no
control-side project spawn.

### G. Transport classification

Classify exec-server and Code Mode gRPC transport separately:

- `protocol-authenticated` only when exact `0.153.4` protocol authentication
  is directly proven and its secret scope is recorded without secret contents;
- `private-network-only` when private topology is proven but protocol auth is
  absent;
- `unproven` when either transport property is not empirically established.

The combined result is capped at `PASS-WITH-TRANSPORT-BLOCK` if either required
direct transport remains private-network-only. A network-only result is not
migration authorization.

### H. Restart, concurrency, and ownership

Prove:

- Agent restart can rediscover home, app-server, control, executor, networks,
  endpoint identities, and generation without copying credentials;
- app-server restart does not change the native home or default socket identity;
- same-generation executor recreation restores the exact worktree/image and
  both remote services;
- stale generation, foreign resource, unknown live socket, or ambiguous PTY
  ownership fails closed;
- two distinct native sessions can run concurrently against the same workspace;
- only duplicate live resume of the same proven native ID is rejected.

## Result semantics and stop conditions

The result model remains:

### PASS

Every A–H gate passes, all project/model operations are proven remote, native
unqualified resume works, physical home/network separation is proven, all local
paths fail closed, and both direct transports are protocol-authenticated. This
result still requires a separate product/migration decision.

### PASS-WITH-TRANSPORT-BLOCK

Every functional, native, physical, routing, lifecycle, and negative-path gate
passes, but one or both direct transports are proven only by private-network
isolation without protocol authentication. This is a successful composition
characterization, not migration authorization or production security approval.

### FAIL

A required invariant is disproven. Examples include a control-side project
process, a project executor path to native home, a local Code Mode provider or
fallback, a project-layer policy override, a public endpoint, an executor route
to control-egress/Internet/host, an unqualified resume that selects the wrong
authority, or a native approval/sandbox bypass.

### BLOCKED/INCOMPLETE

The required proof cannot be completed because of operator abort, missing
authentication, exact-image incompatibility, unsupported exact-version
behavior, unavailable route evidence, an unproven socket/transport property,
or insufficient lifecycle evidence. It is not relabeled as a security failure
unless an invariant was actually disproven.

The experiment stops immediately if any fix would require a project mount in
control, native home/credentials in executor, executor control-egress
attachment, control routing/NAT/proxy, host namespace/socket, disabled
sandboxing, danger/full-access, local fallback, generic image, or a new
conversation protocol as the primary UX.

## Future automated model-compatibility probe

The prior preflight could prove container, network, PTY, endpoint, and policy
state but could not prove that a real model's `CodeModeOnly` turn traversed the
remote provider. A future pre-TUI probe should close that acceptance gap without
changing the native UX:

1. Build the same control/executor pair, native home, app-server default socket,
   remote Code Mode provider, and remote exec endpoint as the real gate.
2. Authenticate natively in the persistent home before the probe. If login
   requires human interaction, the probe reports that prerequisite rather than
   handling credentials itself.
3. Use a test-only, minimal client of the exact native app-server protocol over
   the private Unix socket to request one bounded turn for model `gpt-6-astra`.
   This client is a verification fixture, not a Web API, product wrapper,
   transcript store, or replacement TUI. It must not be used to manufacture
   approvals or hide a TUI failure.
4. Request one bounded, harmless project operation and observe the native
   app-server/model event path, Code Mode host session, nested callback, remote
   exec-server request, executor process table, and control process table.
5. Require explicit evidence of `ToolMode::CodeModeOnly`, remote provider
   identity, executor-side project process, no control-side project process,
   and no executor access to the native home.
6. If the operation needs an approval, the fixture stops and reports that the
   native operator gate is required; it never auto-answers. It never prints
   credentials, raw protocol, model output, canary contents, or full commands.
7. Only a successful real model turn may advance the status to
   `MODEL_REMOTE_COMPATIBLE`; mocks, static tool lists, and endpoint health do
   not.

This probe consumes model quota and depends on valid native authentication. It
may be slower and less representative of TUI approval rendering than the real
operator gate. It is valuable because it can reject a Code Mode incompatibility
before asking an operator to perform the full A–H lifecycle. The real TUI gate
remains mandatory for native approvals, native session creation, and unqualified
resume.

## Terminal frontend boundary

The DevSpace/browser terminal implementation is not part of this architecture.
The only required terminal contract is a correct PTY byte stream with input,
output, resize, close, and bounded lifecycle behavior between the operator and
the native Codex TUI process.

The current terminal UI may be replaced before public alpha without changing
native session semantics, native app-server ownership, native home, executor
topology, Code Mode provider placement, or unqualified resume. No terminal
rewrite is a prerequisite for this feasibility experiment.

## Relationship to the prior split architecture

The 2026-09-16 split design remains the physical and lifecycle baseline. This
document adds one native process and one executor service:

- it adds the native app-server in control;
- it places the verified Code Mode host beside the exec-server in executor;
- it requires the per-workspace default socket for this experiment so bare
  `codex` and bare `codex resume` cannot reuse another workspace's daemon;
- it requires Code Mode gRPC endpoint evidence in addition to exec-server
  endpoint evidence.

It does not change the prior decisions that control has no real project/Git
mount, executor has no native home/credentials/control-egress, all project
execution is remote, local fallback is forbidden, multiple distinct sessions
are allowed, and structured app-server remains shipped/default. It does not
retry the blocked recursive `/codex-home/**` deny or weaken the physical
separation.

## Explicitly not implemented by this specification

This document authorizes no runtime changes. It does not implement:

- native app-server lifecycle or default-socket ownership;
- executor-side Code Mode host injection or gRPC authentication;
- effective configuration enforcement;
- model compatibility probing;
- native TUI attachment or passive session provenance;
- Web/SQLite/Workbench/session migration;
- artifact garbage collection;
- structured app-server retirement or authority changes.

An implementation plan may be written only after this specification is reviewed
and approved. A later implementation must retain the existing structured
app-server path as shipped/default until a separate migration decision.

## Exact source evidence

All links below point to the pinned `rust-v0.153.4` commit
`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`.

| Decision/evidence | Exact source |
| --- | --- |
| `Direct`, `CodeMode`, and `CodeModeOnly` model tool modes | [`protocol/src/openai_models.rs:332-338`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/protocol/src/openai_models.rs#L332-L338) |
| Model metadata and feature-based tool-mode selection; only non-only CodeMode may fall back to direct | [`core/src/tools/mod.rs:68-90`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tools/mod.rs#L68-L90) |
| CodeModeOnly fail-closed selector behavior and hidden direct shell tools | [`core/tests/suite/model_runtime_selectors.rs:228-265`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/tests/suite/model_runtime_selectors.rs#L228-L265) |
| Feature meanings for Code Mode, Code Mode Host, Code Mode Only, and Unified Exec | [`features/src/lib.rs:91-126`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/features/src/lib.rs#L91-L126) |
| Exact `[features.code_mode_host]` TOML shape and `disable_in_process_fallback` resolution | [`core/src/config/config_tests.rs:589-624`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/config/config_tests.rs#L589-L624) |
| Local process-owned versus disabled Code Mode provider | [`core/src/thread_manager.rs:463-470`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/thread_manager.rs#L463-L470), [`code-mode/src/remote_session.rs:35-120`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode/src/remote_session.rs#L35-L120) |
| Local host process spawn and inherited process boundary | [`code-mode/src/remote_session/connection.rs:155-196`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode/src/remote_session/connection.rs#L155-L196) |
| Native app-server `--code-mode-host` option and Unix listen option | [`cli/src/main.rs:545-565`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/cli/src/main.rs#L545-L565), [`cli/src/main.rs:1245-1298`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/cli/src/main.rs#L1245-L1298) |
| App-server Code Mode host URL parsing | [`app-server/src/code_mode_host.rs:8-37`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/code_mode_host.rs#L8-L37) |
| App-server construction of `GrpcCodeModeSessionProvider` and feature check | [`app-server/src/lib.rs:440-455`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/lib.rs#L440-L455), [`app-server/src/lib.rs:555-570`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/lib.rs#L555-L570) |
| Code Mode host transport accepts `grpc://IP:PORT` | [`code-mode-host/src/main.rs:19-37`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode-host/src/main.rs#L19-L37), [`code-mode-host/src/transport.rs:8-40`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode-host/src/transport.rs#L8-L40) |
| Code Mode gRPC listener, service, health route, and lack of auth middleware | [`code-mode-host/src/grpc_transport.rs:24-67`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode-host/src/grpc_transport.rs#L24-L67), [`code-mode-protocol/src/grpc/codex.code_mode.v1.proto:5-35`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode-protocol/src/grpc/codex.code_mode.v1.proto#L5-L35) |
| Remote gRPC client URL validation and transport construction | [`code-mode/src/grpc_session/transport.rs:53-136`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode/src/grpc_session/transport.rs#L53-L136), [`code-mode/src/grpc_session/mod.rs:53-83`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode/src/grpc_session/mod.rs#L53-L83) |
| Reconnectable remote Code Mode session provider | [`code-mode/src/grpc_session/mod.rs:182-203`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode/src/grpc_session/mod.rs#L182-L203), [`code-mode/src/grpc_session/reconnect.rs:21-51`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode/src/grpc_session/reconnect.rs#L21-L51) |
| V8 globals, ordinary ECMAScript surface, and rejected imports | [`code-mode-runtime/src/runtime/globals.rs:15-49`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode-runtime/src/runtime/globals.rs#L15-L49), [`code-mode-runtime/src/service_tests.rs:807-923`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode-runtime/src/service_tests.rs#L807-L923), [`code-mode-runtime/src/runtime/module_loader.rs:175-234`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode-runtime/src/runtime/module_loader.rs#L175-L234) |
| JavaScript tool callbacks emit delegate events rather than spawning tools | [`code-mode-runtime/src/runtime/callbacks.rs:14-73`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode-runtime/src/runtime/callbacks.rs#L14-L73), [`core/src/tools/code_mode/delegate.rs:257-296`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tools/code_mode/delegate.rs#L257-L296) |
| Code Mode delegate creates `ToolCallRuntime` and routes nested calls through native core | [`core/src/tools/code_mode/delegate.rs:101-113`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tools/code_mode/delegate.rs#L101-L113), [`core/src/tools/code_mode/mod.rs:344-396`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tools/code_mode/mod.rs#L344-L396) |
| Remote environment selected by URL and local fallback when URL is absent | [`exec-server/src/environment_provider.rs:50-112`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/exec-server/src/environment_provider.rs#L50-L112), [`core/src/unified_exec/process_manager.rs:1230-1266`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/unified_exec/process_manager.rs#L1230-L1266) |
| Environment ID, logical cwd, and workspace roots carried into a turn | [`protocol/src/protocol.rs:151-169`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/protocol/src/protocol.rs#L151-L169), [`core/src/environment_selection.rs:114-129`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/environment_selection.rs#L114-L129) |
| Remote shell environment resolution | [`core/src/tools/handlers/unified_exec/exec_command.rs:175-231`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L175-L231) |
| Remote apply-patch/filesystem and AGENTS.md paths | [`core/src/tools/handlers/apply_patch.rs:398-438`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tools/handlers/apply_patch.rs#L398-L438), [`core/src/agents_md.rs:53-112`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/agents_md.rs#L53-L112) |
| Local `/shell` path requiring a local environment | [`core/src/tasks/user_shell.rs:136-238`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tasks/user_shell.rs#L136-L238) |
| Local MCP stdio and local command-hook process launchers | [`rmcp-client/src/stdio_server_launcher.rs:175-211`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/rmcp-client/src/stdio_server_launcher.rs#L175-L211), [`hooks/src/engine/command_runner.rs:205-243`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/hooks/src/engine/command_runner.rs#L205-L243) |
| Default native app-server socket path and `unix://` resolution | [`app-server-transport/src/transport/mod.rs:54-160`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-transport/src/transport/mod.rs#L54-L160) |
| Socket mode, stale-socket handling, and live-socket rejection | [`app-server-transport/src/transport/unix_socket.rs:20-132`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-transport/src/transport/unix_socket.rs#L20-L132) |
| Native TUI probing of default daemon socket and local-daemon target selection | [`tui/src/lib.rs:446-507`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/tui/src/lib.rs#L446-L507), [`tui/src/lib.rs:860-930`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/tui/src/lib.rs#L860-L930) |
| JIT mode defaults and optional jitless initialization | [`code-mode-runtime/src/v8_init.rs:18-48`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode-runtime/src/v8_init.rs#L18-L48) |

Newer upstream source has additional daemon/executor-selection guards and
transport behavior. Those changes are not evidence for the admitted artifact;
the experiment must prove every default-socket, provider, routing, and
authentication property on exact `0.153.4`.

## Architectural conclusion

The prior bare-TUI-with-host-disabled composition is incompatible with
`gpt-6-astra` because `CodeModeOnly` correctly fails closed. Enabling the local
Code Mode host in control is not accepted because it co-locates model-directed
Code Mode computation with persistent native credentials and lacks a separate
physical boundary.

The native `0.153.4` app-server composition with a remote Code Mode host in the
exact project executor is source-supported and preserves the intended native
TUI/session model without a DevSpace conversation wrapper. It is **GO WITH
CONDITIONS** as the next narrow feasibility experiment only:

- unqualified bare `codex` and `codex resume` must select the per-workspace
  default app-server socket;
- exact `gpt-6-astra` CodeModeOnly routing must be proven by a real authenticated
  model turn;
- every local path and project-layer override must fail closed;
- physical home, mount, namespace, and two-network separation must remain
  proven;
- both direct transports must be separately classified;
- without protocol authentication, the maximum experiment result is
  `PASS-WITH-TRANSPORT-BLOCK` and there is no migration authorization.

If any of these conditions cannot be proven on exact `0.153.4`, the result is
`FAIL` when an invariant is disproven or `BLOCKED/INCOMPLETE` when evidence or
native support is insufficient. No implementation plan or Workbench/session
migration follows from source compatibility alone.
