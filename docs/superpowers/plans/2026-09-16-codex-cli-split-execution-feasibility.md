# Codex CLI Split Execution Feasibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build only the Agent-owned, opt-in feasibility harness for the approved
Codex split control-plane/execution-plane architecture. The harness will create a
real native Codex `0.153.4` control sidecar with persistent Agent-private native
`CODEX_HOME`, a separate exact-image project executor with the exact managed
worktree and Git administration, and a remote-only Codex environment. It will
produce an honest `PASS`, `PASS-WITH-TRANSPORT-BLOCK`, `FAIL`, or
`BLOCKED/INCOMPLETE` result from source checks, focused tests, process/mount
observations, and an operator-run native TUI/resume gate.

**Architecture:** Agent-owned two-container topology with two distinct network
roles. The control sidecar contains the native Codex TUI, native
authentication, persistent native home, and two network attachments: an
execution network shared only with the executor, plus a separate control-egress
network for OpenAI/ChatGPT authentication and model traffic. The project
executor is created from the running project's exact image and contains only
the exact `/workspace` worktree, narrowly required Git administration, exact
project toolchain, and trusted verified Codex exec-server closure; it attaches
only to the execution network. The control sidecar cannot route, NAT, proxy, or
forward executor traffic to its egress network. Remote-only configuration is
complete before any native TUI process starts and there is no local execution
fallback. The shipped structured app-server path remains the production/default
authority.

**Tech Stack:** TypeScript in `apps/agent`, Vitest, the existing Agent Docker
Engine client over the explicitly supplied rootless Docker socket, the existing
managed-workspace/runtime authority, native Codex `0.153.4`, Docker exec PTY
streams, verified Codex artifact closures, pinned private-state helpers, and
bounded/redacted diagnostics. No Web, Workbench, SQLite, browser session, or
structured-conversation changes are part of this work.

**Spec:** docs/superpowers/specs/2026-09-16-codex-cli-split-execution-design.md

## Global Constraints

- [ ] Read and follow `AGENTS.md`, `docs/README.md`, the superseded
  `docs/superpowers/specs/2026-09-15-codex-cli-sidecar-design.md`, the historical
  `docs/superpowers/plans/2026-09-15-codex-cli-sidecar-feasibility.md`, and the
  approved split-execution spec before changing implementation files.
- [ ] Treat `e201c29fe26b0c46c49ba5464d5c38945713e804` as the approved
  architecture-spec commit and verify the checked-in spec content matches it.
  The clean Codex planning branch is based on `origin/main` and carries a
  documentation-equivalent copy of that approved spec followed by this plan.
  Implementation starts only from the commit containing this approved plan, on
  `feat/codex-cli-split-execution-feasibility`; no implementation agent starts
  from the architecture-spec-only commit or from the unrelated Workbench branch.
- [ ] Do not modify the approved spec, reset history, merge the Workbench fix,
  or import any Workbench/runtime implementation. The clean branch may
  reconstruct documentation commits only as required to remove unrelated
  ancestry.
- [ ] Use Codex `0.153.4` as the admitted artifact. A different artifact requires
  a separately recorded compatibility decision and must not inherit newer
  upstream transport or daemon behavior by assumption.
- [ ] Keep the current structured app-server path, ADR 015 authority,
  `docs/specs/ai-sessions-v1.md` authority, Web/Agent contracts, SQLite schema,
  Workbench/session behavior, and browser UX unchanged.
- [ ] Do not reuse the old single-sidecar security policy, recursive
  `/codex-home/**` denial, same-container verifier, temporary credential lease,
  structured credential staging/writeback, or any old path that puts native home
  and project execution in one container. Historical code may supply only
  low-level patterns after its security assumptions are independently checked.
- [ ] Keep the physical invariant primary: the project executor has no physical
  path, mount, namespace, socket, credential, or shared state through which any
  project process can reach native `CODEX_HOME`. Do not replace this with UID
  separation, a same-UID child-process assumption, a prompt instruction, or a
  recursive home deny.
- [ ] Keep the control sidecar free of the real project worktree and Git state.
  An image-local empty `/workspace` directory may be used as logical process-CWD
  scaffolding only; it must contain no managed project bytes and must not be a
  mount of managed state.
- [ ] Create two networks with distinct roles. The execution network is a
  per-workspace private/internal network containing only control and executor,
  with no published ports. The control-egress network contains only the trusted
  control sidecar; its upstream path is the rootless Docker runtime's explicitly
  configured external gateway/DNS path, not another DevSpace container. The
  executor never attaches to it.
- [ ] Prevent the control sidecar from becoming a router: give it no
  `NET_ADMIN` or equivalent routing capability, use no forwarding/NAT/proxy
  process, keep IP forwarding unavailable, and inspect both container and host
  network state. The executor must not reach the Internet, egress gateway, host,
  or unrelated services through the control sidecar.
- [ ] Keep the project executor on the exact project's runtime image. Inject a
  trusted, verified, read-only Codex exec-server closure only when the exact
  image lacks it. Never substitute a generic runner image.
- [ ] Start the exec-server separately inside the project executor. Never use a
  Codex `program` environment entry to launch an executor in the credential-
  bearing sidecar.
- [ ] Configure and prove a remote-only environment before starting native
  `codex`. Missing, empty, `none`, stale, unauthenticated-in-production, or
  otherwise invalid executor configuration fails closed. No local retry or
  local fallback is allowed after executor loss.
- [ ] Use the native TUI as the operator surface. The Agent may attach a Docker
  exec PTY and resize/input stream, but it must not inject prompts, slash
  commands, checklist text, hidden keystrokes, or reconstructed conversations.
- [ ] Preserve native Codex ownership of authentication, native session IDs,
  history, approvals, questions, and `codex resume NATIVE_SESSION_ID`. Agent records may hold
  only opaque IDs and bounded lifecycle/provenance state; they must not become a
  second conversation authority.
- [ ] Permit multiple native sessions against one workspace. Do not add a
  one-agent-per-workspace guard. Refuse only a second live launch of the same
  proven native session ID, and treat ambiguous liveness as resume-unavailable.
- [ ] The Agent is trusted to know and own the private native-home host path,
  validate it, mount it into the control sidecar, and own Docker/network and
  transport credentials. Web, project executor, logs, events, SQLite, labels,
  and project-accessible APIs must never receive home or credential contents.
- [ ] Keep native home persistent and provider-owned. Do not create a temporary
  per-turn `CODEX_HOME`, copy credentials into the executor, synthesize auth
  files, or write back staged credentials from the existing structured path.
- [ ] Enforce forbidden local paths against both native/global home configuration
  and project-controlled configuration layers. Preflight-only checking is not
  sufficient. If `0.153.4` cannot make a mandatory path unavailable or fail
  closed against a lower-trust project layer, the live gate is a hard failure.
- [ ] Treat unauthenticated direct WebSocket transport in `0.153.4` as usable
  only for a feasibility-only private-network result. It can produce at most
  `PASS-WITH-TRANSPORT-BLOCK`; it can never authorize migration or production
  use.
- [ ] Do not update `docs/current-state.md` merely because unit tests pass. Update
  it only after the actual operator-run gate, with exactly the bounded result
  category and with the structured app-server path still described as shipped
  and default.
- [ ] Every implementation task below follows TDD: write the failing test,
  record the expected failure, make the smallest implementation change, run the
  focused passing command, and make the stated focused commit.

---

## Verified repository and Codex source map

The implementation must consume existing authorities rather than create parallel
ownership:

- `apps/agent/src/managed-workspaces.ts` owns durable project/workspace
  ownership, canonical `repositoryPath()` and `worktreePath()`, revision/runtime
  cross-checks, Git worktree registration, and the private
  `worktreeAdministration()` validation. Its public
  `executionContext(projectId, workspaceId)` returns the exact running runtime
  generation, ownership, options, and hashes.
- `apps/agent/src/workspace-runtime.ts` owns the existing development runtime
  association and `WorkspaceRuntimeManager.exactRunningOwnership()`. The split
  executor is a separate container and must not replace or weaken the existing
  development runtime.
- `apps/agent/src/docker-runtime.ts` owns the rootless Docker Engine client,
  rootless assertion, image/container/network inspection, normal runtime
  creation, Docker exec framing, attached streams, resize, and exec inspection.
  The normal `createContainer()` path must remain behaviorally unchanged.
- `apps/agent/src/private-state.ts` supplies `pinExistingDirectory()`,
  `establishPinnedDirectory()`, `lstatIdentity()`, `identitiesEqual()`,
  `comparePersistedIdentity()`, `assertContained()`, `readRegularFileNoFollow()`,
  `durableJsonWriter`, and strict JSON validation. These are the basis for private
  home, evidence, and ownership hardening.
- `apps/agent/src/codex-app-server/artifact-identity.ts` supplies
  `resolveCodexExecutionArtifact()`, `stageCodexExecutionArtifact()`,
  `verifyStagedCodexExecutionArtifact()`,
  `codexExecutionArtifactClosureDigest()`,
  `CodexExecutionArtifact`, and `StagedCodexExecutionArtifact`. Reuse its
  artifact identity and staging primitives, not its structured credential
  authority or provider upload/readback lifecycle.
- `apps/agent/src/codex-app-server/probe-runtime.ts` supplies architecture
  normalization and bounded Docker-exec/probe patterns. Its old managed runtime
  assumptions must not be copied into the split boundary.
- `apps/agent/src/codex-executable-resolution.ts` supplies
  `resolveCodexExecutablePath()`, including the explicit
  `DEVSPACE_CODEX_EXECUTABLE_PATH` behavior. The verifier must not discover an
  arbitrary executable from a personal home.
- `apps/agent/src/execution-manager.ts` supplies existing Docker exec/PTY
  lifecycle patterns, but the native TUI attachment is Agent-internal test
  tooling and is not a Web terminal or a replacement for the structured path.
- `packages/project-options/src/runtime-plan.ts` supplies
  `runtimePlanV1Schema`, `parseRuntimePlanV1()`, `hashRuntimePlanV1()`, and the
  exact development image, user, working directory, environment, and resource
  contract.
- `packages/security/src/canonical-paths.ts` and `relative-paths.ts` provide
  path rules where their existing contract applies. Do not expose a new browser
  path API.
- `packages/diagnostics/src/index.ts` supplies `createLogger()`,
  `sanitizeLogFields()`, and `redactSensitiveText()`. Split verifier diagnostics
  need a bounded developer-only allowlist for phase, stable failure code,
  exception class, and capped sanitized stack context; raw command output,
  endpoint credentials, home paths, and private errors remain excluded.
- `apps/agent/package.json` has the existing real runtime script pattern
  `verify:runtime:real` and Agent-focused test command
  `pnpm --dir ../.. exec vitest run --project @devspace/agent`. Add one explicit
  opt-in split verifier command without changing the normal Agent startup.

The historical branch `feat/codex-cli-sidecar-feasibility` is evidence only. Its
`apps/agent/src/codex-cli/security-policy.ts`, `sidecar-runtime.ts`, Docker
sidecar input, and same-container verifier carry the blocked recursive home-deny
model and are excluded. Only bounded process framing, rootless assertions,
artifact launcher identity, labels, mount validation, and cleanup patterns may be
recreated after review.

The exact admitted Codex source was inspected at `rust-v0.153.4`, commit
`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`, and compared with newer upstream
source. The relevant 0.153.4 path is:

- `codex-rs/protocol/src/protocol.rs`: `TurnEnvironmentSelection` carries
  `environment_id`, logical `cwd`, workspace roots, and configuration.
- `codex-rs/exec-server/src/environment_provider.rs`:
  `DefaultEnvironmentProvider::snapshot_inner()` maps a non-empty URL to a
  remote/default environment and can omit local.
- `codex-rs/exec-server/src/environment_toml.rs`: environment entries support
  `id`, `url`, `program`, `args`, `env`, and `cwd`; only `url` is permitted here.
- `codex-rs/exec-server/src/environment.rs`:
  `EnvironmentManager::prepare_from_codex_home()` and
  `prepare_from_env()` load environment configuration.
- `codex-rs/core/src/environment_selection.rs`:
  `default_thread_environment_selections()` and `TurnEnvironments` carry the
  selected environment into a turn.
- `codex-rs/core/src/session/turn_context.rs`: `TurnEnvironment` carries the
  selected sandbox context.
- `codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs` and
  `codex-rs/core/src/unified_exec/process_manager.rs`: selected environment/cwd
  resolution and remote backend process start; local spawning is a separate
  branch and must not be reachable as fallback.
- `codex-rs/core/src/tools/handlers/apply_patch.rs` and the apply-patch runtime:
  selected-environment filesystem routing.
- `codex-rs/core/src/agents_md.rs`: AGENTS discovery through the selected
  environment filesystem.
- `codex-rs/exec-server/src/remote_process.rs` and
  `remote_file_system.rs`: executor process and filesystem implementations.
- `codex-rs/core/src/tasks/user_shell.rs`: `/shell` local-environment path.
- `codex-rs/rmcp-client/src/stdio_server_launcher.rs` and
  `codex-rs/rmcp-client/src/rmcp_client.rs`: local versus executor MCP/helper
  routing.
- `codex-rs/hooks/src/engine/command_runner.rs` and legacy notification paths:
  locally spawned command hooks.
- Plugin install/update/maintenance modules: local Git/npm/process paths that
  must not be model-accessible in this profile.
- `codex-rs/exec-server/src/server/transport.rs`: the 0.153.4 direct listener
  accepts `ws://IP:PORT` or `stdio`, exposes `/readyz`, and rejects Origin, but
  does not prove bearer, token, or mutual authentication. Newer upstream daemon
  and auth behavior is not evidence for 0.153.4.
- `codex-rs/cli/src/main.rs`: native `ExecServerCommand`, `--listen`, `--remote`,
  `--environment-id`, and program-entry handling.

These source findings prove that an external executor abstraction exists in the
native 0.153.4 core path. They do not prove that zero physical workspace mount,
project-layer policy enforcement, native TUI approvals/resume, transport
authentication, or every negative path is safe. Those remain live-gate claims.

The native CLI/TUI is a hard integration requirement. If the admitted binary can
reach an external executor only through an embedding host's app-server RPC and
cannot select that executor from an ordinary native TUI launch, the gate stops as
`FAIL`/NO-GO. This work does not introduce a replacement conversation protocol,
large app-server wrapper, prompt relay, or structured UI to compensate. If the
native path is source-compatible but the live proof cannot be completed, the
result is `BLOCKED/INCOMPLETE` instead.

## Relationship to the older design

The approved split spec supersedes the older single-sidecar spec and its
feasibility plan in these specific portions: the control sidecar no longer mounts
the real worktree or Git state; native-home secrecy no longer depends on a
recursive Codex deny mask; the old same-container `security-policy.ts`,
`sidecar-runtime.ts`, temporary-home credential flow, and verifier are not
implementation inputs; and the executor is now a separately inspected exact-image
container reached through a remote-only environment. The old design's native TUI,
native approval/session/history authority, passive session correlation, Agent
ownership of managed workspace state, and the existing structured app-server path
as shipped/default remain in force. This plan operationalizes only the approved
split spec and does not reopen the blocked single-sidecar branch.

## Target file map

The split implementation is kept in small Agent-internal modules under
`apps/agent/src/codex-cli-split/` and is used only by the opt-in verifier:

```text
compatibility.ts       admitted binary and source capability checks
native-home.ts         persistent Agent-private native home binding
network.ts             execution/control-egress network topology and membership
artifact.ts            verified Codex closure injection
project-executor.ts    exact-image executor policy and inspection
transport.ts           executor URL/authentication classification
exec-server.ts         executor-side exec-server launch/readiness
remote-policy.ts       remote-only effective policy and denial matrix
control-sidecar.ts     no-project-mount native control container policy
native-pty.ts          real native TUI Docker exec PTY
session-provenance.ts  passive native session ID observation
runtime-record.ts      Agent-private lifecycle/concurrency records
split-runtime.ts       ordered two-container lifecycle and fail-closed resume
feasibility-result.ts  A-F evidence and exact outcome model
feasibility-verifier.ts opt-in live gate orchestration and diagnostics
```

The plan intentionally does not add an index export, a Web route, a contract
schema, a database record, or a Workbench integration. The verifier imports the
modules directly so the experiment cannot silently become production authority.

### Network source of truth

`CodexSplitNetworkBinding` is the only network topology value passed between
the split modules. It always contains both roles:

| Role | Members | Route/purpose | Publication |
| --- | --- | --- | --- |
| `execution` | control sidecar + exact-image executor | internal/private control-to-exec-server traffic only; not a control default route | no published ports |
| `control-egress` | control sidecar only | the control sidecar's sole external default route for native Codex authentication/model traffic | no published ports |

The executor receives the one-element execution attachment tuple and no other
network attachment. The control sidecar receives the two-element execution plus
control-egress tuple. The topology builder rejects Docker's default `bridge`,
host/none/container modes, caller-supplied shared networks, unexpected
members, and any route or capability that would let the control sidecar forward
executor traffic. If the rootless Docker runtime cannot express and empirically
prove this two-network routing boundary, the verifier returns
`BLOCKED/INCOMPLETE`; it never attaches the executor to control-egress as a
convenience.

### Implementation base

The approved architecture reference remains
`e201c29fe26b0c46c49ba5464d5c38945713e804`; it is not the implementation base
because it predates this plan. After this plan is approved, create or retain
`feat/codex-cli-split-execution-feasibility` at the commit that contains this
plan and start implementation from that commit. The historical
`fix/workbench-runtime-ai-truthfulness` branch is not an ancestor to import,
merge, or use as a base. Reporting may compare the resulting branch separately
with `origin/main` and with the approved architecture reference.

## Task 1: Admit the exact Codex artifact and bind managed workspace/Git state

**Files**

- Create `apps/agent/src/codex-cli-split/compatibility.ts`.
- Create `apps/agent/src/codex-cli-split/compatibility.test.ts`.
- Create `apps/agent/src/codex-cli-split/native-home.ts`.
- Create `apps/agent/src/codex-cli-split/native-home.test.ts`.
- Modify `apps/agent/src/managed-workspaces.ts`.
- Modify `apps/agent/src/managed-workspaces.test.ts`.
- Test the created modules and modified managed-workspace tests with
  `apps/agent/src/codex-cli-split/compatibility.test.ts`,
  `apps/agent/src/codex-cli-split/native-home.test.ts`, and
  `apps/agent/src/managed-workspaces.test.ts`.

**Consumes**

- `resolveCodexExecutablePath()` from
  `apps/agent/src/codex-executable-resolution.ts`.
- `runBoundedProcess()` and `BoundedProcessResult` from
  `apps/agent/src/git-inspector.ts` for bounded version probing.
- `pinExistingDirectory()`, `establishPinnedDirectory()`, `lstatIdentity()`,
  `identitiesEqual()`, `assertContained()`, and `FileIdentity` from
  `apps/agent/src/private-state.ts`.
- `ManagedWorkspaces.loadWorkspaceOwnership()` and its existing
  `worktreeAdministration()` validation internally, via a new public
  Agent-internal method; `repositoryPath()`, `worktreePath()`, and
  `executionContext()` remain the authority for paths and runtime identity.

**Produces**

```ts
export const ADMITTED_CODEX_VERSION = "0.153.4" as const;

export interface CodexVersionEvidence {
  readonly executablePath: string;
  readonly versionOutput: string;
  readonly version: string;
  readonly exact: boolean;
}

export function parseCodexVersionOutput(output: string): string;
export function assertAdmittedCodexVersion(input: {
  readonly executablePath: string;
  readonly versionOutput: string;
}): CodexVersionEvidence;
```

```ts
export const CODEX_NATIVE_ACCOUNT_BINDING = "owner-default" as const;

export interface CodexNativeHomeBinding {
  readonly accountBinding: typeof CODEX_NATIVE_ACCOUNT_BINDING;
  readonly homePath: string;
  readonly mountTarget: "/codex-home";
  readonly identity: FileIdentity;
  readonly ownerUid: number;
  readonly ownerGid: number;
}

export function nativeCodexHomePath(stateRoot: string): string;
export async function ensureNativeCodexHome(input: {
  readonly homePath: string;
  readonly ownerUid: number;
  readonly ownerGid: number;
}): Promise<CodexNativeHomeBinding>;
```

```ts
export interface WorkspaceGitAdministrationBinding {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly worktreePath: string;
  readonly repositoryPath: string;
  readonly administrationPath: string;
  readonly worktreeIdentity: FileIdentity;
  readonly repositoryIdentity: FileIdentity;
  readonly administrationIdentity: FileIdentity;
}

// Agent-internal authority method added to ManagedWorkspaces.
async codexExecutorGitBinding(
  projectId: string,
  workspaceId: string
): Promise<WorkspaceGitAdministrationBinding>;
```

**Failing test first**

- [ ] Add tests that reject a version other than exactly `0.153.4`, malformed
  version output, relative/NUL executable values, a missing home, a symlinked
  home, a replaced pinned directory, and an owner/mode mismatch. Assert that
  error values contain stable categories and never home contents.
- [ ] Add managed-workspace tests that return the exact worktree, bare repository,
  and linked-worktree administration directory only after ownership, identities,
  `gitdir`, common directory, branch, registration, and revision checks pass.
  Reject a foreign repository, a foreign administration directory, a regular
  `.git` directory, a symlink, or a path outside the registered repository.
- [ ] Run:

  ```bash
  pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/compatibility.test.ts apps/agent/src/codex-cli-split/native-home.test.ts apps/agent/src/managed-workspaces.test.ts
  ```

  Expected failure: the new modules and `ManagedWorkspaces.codexExecutorGitBinding()`
  do not exist.

**Minimal implementation**

- [ ] Parse only the native version line needed to prove the exact admitted
  artifact; run the supplied executable with bounded output and no shell.
- [ ] Derive `stateRoot/codex-homes/owner-default` with `assertContained()`;
  establish and pin all parent directories; create or validate the final
  directory with restrictive ownership and mode; return identity only.
- [ ] Add `ManagedWorkspaces.codexExecutorGitBinding()` as a thin authority
  method that calls existing private ownership checks and returns only the exact
  worktree, bare repository, and administration identities. Do not expose a
  managed-root parent mount.
- [ ] Ensure this task does not read or serialize auth, refresh, session, or other
  native-home file contents. Native login/refresh will write directly to this
  persistent home in the control sidecar.

**Passing verification**

- [ ] Run the same focused Vitest command and require all new and existing tests
  to pass.
- [ ] Run the Agent typecheck for the new signatures:

  ```bash
  pnpm --filter @devspace/agent run typecheck
  ```

**Commit**

```text
feat(agent): bind Codex split workspace and native home
```

## Task 2: Add dedicated networks and split-container Docker primitives

**Files**

- Create `apps/agent/src/codex-cli-split/network.ts`.
- Create `apps/agent/src/codex-cli-split/network.test.ts`.
- Modify `apps/agent/src/docker-runtime.ts`.
- Modify `apps/agent/src/docker-runtime.test.ts`.
- Test the new network module and Docker tests with
  `apps/agent/src/codex-cli-split/network.test.ts` and
  `apps/agent/src/docker-runtime.test.ts`.

**Consumes**

- `DockerEngineClient.assertRootlessAvailable()`, `createNetwork()`,
  `inspectNetwork()`, `listContainers()`, `inspectContainer()`,
  `inspectImage()`, `startContainer()`, `stopContainer()`, and
  `removeContainer()` from `apps/agent/src/docker-runtime.ts`.
- `uuidV7Schema` and existing runtime label conventions from
  `apps/agent/src/workspace-runtime.ts`.
- `assertContained()` and `lstatIdentity()` for source-path validation.

**Produces**

```ts
export interface DockerCodexSplitBindMount {
  readonly Type: "bind";
  readonly Source: string;
  readonly Target: string;
  readonly ReadOnly: boolean;
  readonly BindOptions: { readonly Propagation: "rprivate" };
}

export interface DockerCodexSplitContainerInput {
  readonly role: "control" | "executor";
  readonly imageId: string;
  readonly entrypoint: readonly string[];
  readonly command: readonly string[];
  readonly workingDirectory: string;
  readonly user: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly mounts: readonly DockerCodexSplitBindMount[];
  readonly tmpfs: Readonly<Record<string, string>>;
  readonly networks: readonly DockerCodexSplitNetworkAttachment[];
  readonly sysctls: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly cpuMillicores: number;
  readonly memoryBytes: number;
  readonly pidLimit: number;
  readonly readOnlyRootfs: boolean;
}

export interface DockerCodexSplitNetworkAttachment {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly role: "execution" | "control-egress";
  /** True only for the control-egress attachment; proven by route inspection. */
  readonly defaultRoute: boolean;
}

export type DockerCodexSplitExecutionAttachment =
  DockerCodexSplitNetworkAttachment & { readonly role: "execution"; readonly defaultRoute: false };
export type DockerCodexSplitControlEgressAttachment =
  DockerCodexSplitNetworkAttachment & { readonly role: "control-egress"; readonly defaultRoute: true };

// Added to DockerEngineClient; the normal createContainer() path is unchanged.
async createNetwork(
  name: string,
  labels: Record<string, string>,
  options?: { readonly internal?: boolean; readonly attachable?: boolean }
): Promise<string>;
async createCodexSplitContainer(
  name: string,
  input: DockerCodexSplitContainerInput
): Promise<string>;
async removeNetwork(id: string): Promise<void>;
async topContainer(id: string, psArgs: string): Promise<DockerProcessTable>;
```

```ts
export interface DockerProcessTable {
  readonly titles: readonly string[];
  readonly processes: readonly (readonly string[])[];
}

export interface CodexSplitExecutionNetworkBinding {
  readonly role: "execution";
  readonly workspaceId: string;
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly controlAlias: "codex-control";
  readonly executorAlias: "codex-executor";
  readonly internal: true;
  readonly defaultRoute: false;
  readonly publishedPorts: readonly [];
}

export interface CodexSplitControlEgressNetworkBinding {
  readonly role: "control-egress";
  readonly workspaceId: string;
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly controlAlias: "codex-control";
  readonly executorAttached: false;
  readonly internal: false;
  readonly defaultRoute: true;
  readonly publishedPorts: readonly [];
  readonly defaultBridgeUsed: false;
}

export interface CodexSplitNetworkBinding {
  readonly execution: CodexSplitExecutionNetworkBinding;
  readonly controlEgress: CodexSplitControlEgressNetworkBinding;
}

export function buildCodexSplitExecutionNetworkName(workspaceId: string, generation: number): string;
export function buildCodexSplitControlEgressNetworkName(workspaceId: string, generation: number): string;
export async function createCodexSplitNetwork(input: {
  readonly docker: DockerEngineClient;
  readonly workspaceId: string;
  readonly generation: number;
  readonly labels: Readonly<Record<string, string>>;
}): Promise<CodexSplitNetworkBinding>;
export function assertCodexSplitNetworkInspection(
  inspections: {
    readonly execution: DockerNetworkInspection;
    readonly controlEgress: DockerNetworkInspection;
  },
  expected: CodexSplitNetworkBinding
): void;
export function assertCodexSplitContainerNetworks(input: {
  readonly role: "control" | "executor";
  readonly networks: readonly DockerCodexSplitNetworkAttachment[];
  readonly expected: CodexSplitNetworkBinding;
}): void;
export function buildCodexSplitNetworkAttachments(input: {
  readonly role: "control";
  readonly network: CodexSplitNetworkBinding;
}): readonly [DockerCodexSplitExecutionAttachment, DockerCodexSplitControlEgressAttachment];
export function buildCodexSplitNetworkAttachments(input: {
  readonly role: "executor";
  readonly network: CodexSplitNetworkBinding;
}): readonly [DockerCodexSplitExecutionAttachment];
```

`createCodexSplitNetwork()` creates both derived networks. Its result is one
topology object, not a single network: `execution` is the only network accepted
by an executor, while `controlEgress` is the only network that may provide
upstream model/authentication egress and is accepted by the control sidecar
only. The control-egress network is a dedicated per-control/per-workspace bridge
with `Internal: false`, no published ports, and no unrelated container members;
it is never Docker's default bridge and is not shared with project runtimes.

Extend existing inspection types/schemas with the fields needed to prove the
boundary, without changing normal runtime semantics:

- `DockerContainerInspection.Config.Env` and `DockerImageInspection.Config.Env`;
- `DockerNetworkInspection.Driver`, `Internal`, `Attachable`, `Ingress`,
  `EnableIPv6`, `Options`, and attached container aliases/IDs for both network
  roles;
- per-network container `IPAddress`/`Gateway` data and container route-table
  observations needed to prove that only the control-egress attachment is the
  control container's default route;
- `DockerEngineClient.removeNetwork()` and `topContainer()`;
- `DockerEngineClient.createNetwork()` accepts optional internal/attachable
  settings while preserving the current normal-runtime defaults;
- `parseImagePath(environment: readonly string[] | null | undefined): string`
  for inspection of the exact image's declared path without exposing all env
  values in diagnostics.

**Failing test first**

- [ ] Add request-shape tests proving the execution network is a derived
  `Driver: "bridge"`, `Internal: true`, `Attachable: false`, `Ingress: false`,
  IPv6-disabled network with no published ports, and carries
  workspace/generation/role labels.
- [ ] Add request-shape tests proving the control-egress network is a separately
  derived non-internal bridge network with no published ports, no arbitrary
  shared network name, and no executor attachment. It is the only experiment
  network allowed to provide upstream OpenAI/ChatGPT egress; its dedicated
  network name must not be Docker's default `bridge` network.
- [ ] Add rejection tests for host/none/container network modes, privileged
  containers, host PID/IPC/UTS/user namespaces, host binds, missing
  `no-new-privileges`, non-`rprivate` propagation, writable trusted mounts,
  missing `net.ipv4.ip_forward=0`, `NET_ADMIN`/equivalent capability, and any
  mount or network attachment not explicitly present in the role policy.
- [ ] Add inspection tests for an unexpected attached container, unexpected
  network alias, executor on control-egress, control missing control-egress,
  non-internal execution network, unexpected control-egress settings, published
  port, mismatched label, or a control container whose default route is not the
  control-egress attachment. Reject an executor with any external default route,
  and reject a topology whose route table cannot be inspected.
- [ ] Run:

  ```bash
  pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/network.test.ts apps/agent/src/docker-runtime.test.ts
  ```

  Expected failure: the specialized Docker request, expanded inspection
  schemas, and network helpers are not present.

**Minimal implementation**

- [ ] Add the specialized request builder and schema parsing alongside the
  existing Docker Engine methods. Keep all ordinary project runtime requests on
  `createContainer()` unchanged.
- [ ] Create two derived workspace/generation networks: an internal execution
  network containing only the future control/executor pair, and a dedicated
  control-egress network with `Internal: false` only because the trusted control
  process must reach OpenAI/ChatGPT. Do not use Docker's default bridge or a
  caller-supplied shared network for either role.
- [ ] Encode the executor attachment as execution-only and the control
  attachment as execution-plus-control-egress, with the executor having no
  external default route and the control sidecar's only external default route
  on control-egress. Prove those route choices from container state; do not
  infer them from attachment order. Do not expose the executor to the egress
  network even if project tools later need Internet access; that is
  outside this feasibility design.
- [ ] Make the split container request set `net.ipv4.ip_forward=0` and the
  equivalent IPv6 forwarding setting when supported by rootless Docker, drop
  `NET_ADMIN` and all equivalent routing capabilities, and reject the topology
  if the daemon cannot prove forwarding is unavailable. Use the exact
  rootless-Docker endpoint setting available in the admitted daemon to prefer
  control-egress as the control sidecar's only external default route; if that
  setting is unavailable, accept the topology only when route inspection proves
  the same deterministic result. Never rely on attachment order alone. The
  execution attachment is not a default route. The control sidecar is not a
  router, proxy, or NAT hop between the two networks; if rootless Docker cannot
  express or prove this topology, the live gate is `BLOCKED/INCOMPLETE`.
- [ ] Make cleanup refuse unowned networks and refuse removal while an unexpected
  container is attached. Record only bounded IDs/roles in diagnostics.
- [ ] Implement `topContainer()` with a bounded `ps_args` value and parse process
  rows without persisting raw command arguments.

**Passing verification**

- [ ] Run the focused Vitest command above.
- [ ] Run:

  ```bash
  pnpm --filter @devspace/agent run typecheck
  ```

**Commit**

```text
feat(agent): add Codex split Docker network primitives
```

## Task 3: Stage and inject a trusted Codex exec-server closure

**Files**

- Create `apps/agent/src/codex-cli-split/artifact.ts`.
- Create `apps/agent/src/codex-cli-split/artifact.test.ts`.
- Test against `apps/agent/src/codex-app-server/artifact-identity.test.ts` where
  the existing artifact behavior is consumed; do not alter the structured
  artifact-stager lifecycle.

**Consumes**

- `resolveCodexExecutionArtifact()`, `stageCodexExecutionArtifact()`,
  `verifyStagedCodexExecutionArtifact()`,
  `codexExecutionArtifactClosureDigest()`,
  `CodexExecutionArtifact`, and `StagedCodexExecutionArtifact` from
  `apps/agent/src/codex-app-server/artifact-identity.ts`.
- `architectureCompatible()` from `apps/agent/src/codex-app-server/probe-runtime.ts`.
- `readRegularFileNoFollow()`, `lstatIdentity()`, `assertContained()`, and
  existing durable staging-root authority from `private-state.ts`.

**Produces**

```ts
export interface CodexSplitArtifactBinding {
  readonly staged: StagedCodexExecutionArtifact;
  readonly packageVersion: string;
  readonly closureDigest: string;
  readonly mountTarget: "/opt/devspace/codex";
  readonly entrypointPath: "/opt/devspace/codex/bin/codex";
  readonly launcherPath: "/opt/devspace/codex-launcher/codex";
}

export async function prepareCodexSplitArtifact(input: {
  readonly configuredPath: string;
  readonly stateRoot: string;
}): Promise<CodexSplitArtifactBinding>;

export function assertCodexArtifactCompatibleWithImage(input: {
  readonly artifact: CodexSplitArtifactBinding;
  readonly image: DockerImageInspection;
}): void;

export function codexCommand(
  artifact: CodexSplitArtifactBinding,
  args: readonly string[]
): readonly string[];
```

**Failing test first**

- [ ] Add fixture tests for a valid ELF/package closure, altered bytes, a
  symlink escaping the staging root, setuid/setgid mode, architecture mismatch,
  missing `exec-server` closure, and a non-0.153.4 package version.
- [ ] Assert the generated launcher is a fixed staged-artifact path and cannot
  resolve `codex` from an image `PATH` or a project-controlled directory.
- [ ] Assert injection mounts are read-only and no home, auth, or structured
  credential staging path is part of the binding.
- [ ] Run:

  ```bash
  pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/artifact.test.ts apps/agent/src/codex-app-server/artifact-identity.test.ts
  ```

  Expected failure: the split artifact binding and compatibility checks do not
  exist.

**Minimal implementation**

- [ ] Reuse the existing closure digest and no-follow verification rather than
  copying its code or the old sidecar launcher.
- [ ] Verify the artifact's exact version, Linux architecture/ABI, entrypoint,
  closure members, modes, symlink targets, and read-back identity before any
  container is created.
- [ ] Build one read-only trusted mount usable by both control and executor
  policies. The project image remains the image selected by the runtime plan.
- [ ] Reject an exact image that cannot execute the verified closure and required
  sandbox helper. Do not select another image.

**Passing verification**

- [ ] Run the focused Vitest command above.
- [ ] Run:

  ```bash
  pnpm --filter @devspace/agent run typecheck
  ```

**Commit**

```text
feat(agent): stage trusted Codex split artifact
```

## Task 4: Enforce the exact-image project executor policy

**Files**

- Create `apps/agent/src/codex-cli-split/project-executor.ts`.
- Create `apps/agent/src/codex-cli-split/project-executor.test.ts`.
- Modify `apps/agent/src/docker-runtime.ts` only if Task 2 leaves a narrowly
  required request validation field unimplemented.
- Modify `apps/agent/src/docker-runtime.test.ts` only for that field's request
  and inspection coverage.
- Test the new module with
  `apps/agent/src/codex-cli-split/project-executor.test.ts`.

**Consumes**

- `ManagedWorkspaces.executionContext()` and
  `ManagedWorkspaces.codexExecutorGitBinding()` from Tasks 1 and the existing
  managed-workspace authority.
- `RuntimeOwnership` and `WorkspaceRuntimeManager.exactRunningOwnership()` from
  `apps/agent/src/workspace-runtime.ts`.
- `parseRuntimePlanV1()` and `RuntimePlanV1` from
  `packages/project-options/src/runtime-plan.ts`.
- `DockerEngineClient.inspectContainer()`, `inspectImage()`,
  `createCodexSplitContainer()`, `startContainer()`, and the inspection types
  from `docker-runtime.ts`.
- `parseImagePath()` from `docker-runtime.ts` for bounded image-environment
  inspection.
- `CodexSplitNetworkBinding`, `CodexSplitExecutionNetworkBinding`,
  `DockerCodexSplitNetworkAttachment`, `buildCodexSplitNetworkAttachments()`,
  and `CodexSplitArtifactBinding`.

**Produces**

```ts
export interface CodexProjectExecutorPolicy {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly generation: number;
  readonly imageId: string;
  readonly imageReference: string;
  readonly imageArchitecture: string;
  readonly worktreePath: string;
  readonly repositoryPath: string;
  readonly administrationPath: string;
  readonly mounts: readonly DockerCodexSplitBindMount[];
  readonly executionNetwork: CodexSplitExecutionNetworkBinding;
  readonly networkAttachments: readonly [DockerCodexSplitExecutionAttachment];
  readonly artifact: CodexSplitArtifactBinding;
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: "/workspace";
}

export interface CodexProjectExecutorBinding {
  readonly policy: CodexProjectExecutorPolicy;
  readonly containerId: string;
  readonly containerName: string;
  readonly endpointHost: "codex-executor";
  readonly endpointPort: number;
  readonly controlEgressAttached: false;
}

export async function buildCodexProjectExecutorPolicy(input: {
  readonly context: WorkspaceExecutionContext;
  readonly git: WorkspaceGitAdministrationBinding;
  readonly network: CodexSplitNetworkBinding;
  readonly artifact: CodexSplitArtifactBinding;
  readonly imagePort: number;
}): Promise<CodexProjectExecutorPolicy>;

export async function createCodexProjectExecutor(input: {
  readonly docker: DockerEngineClient;
  readonly policy: CodexProjectExecutorPolicy;
  readonly name: string;
}): Promise<CodexProjectExecutorBinding>;

export function assertCodexProjectExecutorInspection(input: {
  readonly container: DockerContainerInspection;
  readonly image: DockerImageInspection;
  readonly binding: CodexProjectExecutorBinding;
}): void;
```

**Mount decision that the tests must prove**

- [ ] Mount the exact managed worktree source at `/workspace` read/write.
- [ ] Mount only the exact bare repository and linked-worktree administration
  state required for Git to resolve the worktree's existing `.git` file. Preserve
  the path Git expects rather than rewriting project metadata. If preserving
  Git's absolute administration path requires a second bind of the same exact
  worktree source at that exact path, include that source only after identity
  checks prove it is the same worktree; never mount the parent managed root.
- [ ] The live executor must prove `git rev-parse --git-dir`,
  `--git-common-dir`, `git status --short`, `git diff --stat`, and
  `git log -1 --oneline` against the exact worktree. A path arrangement that
  makes these commands work only by mounting unrelated state is incompatible.
- [ ] Mount the staged Codex closure read-only at `/opt/devspace/codex` and a
  read-only launcher/policy path. All scratch state is ephemeral container-local
  state. The executor has no `/codex-home`, no `CODEX_HOME` value or mount
  pointing to the control home, no auth/refresh files, no Agent/Docker socket,
  no production or unrelated managed-state mount, no host namespace, and only
  one network attachment: `network.execution`. Its `HOME`/temporary state, if
  required by the exact exec-server artifact, is an ephemeral executor-local
  tmpfs and is checked for the absence of native credentials.

**Failing test first**

- [ ] Add policy tests that use a fake exact runtime ownership record and assert
  image ID equality with the running development runtime, exact worktree and Git
  identities, exact user/working directory, and exact network/generation labels.
- [ ] Add rejection tests for a generic image, image reference drift, worktree
  identity drift, broad managed-root mount, missing Git administration, home or
  credential env/mount, socket mount, host namespace, published port, writable
  artifact mount, missing sandbox helper, and unsupported image architecture.
- [ ] Add a request test that confirms the exact project's runtime image is used
  to create the dedicated executor rather than the convenient existing
  development container being reused as the executor.
- [ ] Run:

  ```bash
  pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/project-executor.test.ts apps/agent/src/docker-runtime.test.ts apps/agent/src/workspace-runtime.test.ts
  ```

  Expected failure: no exact-image split executor policy or inspection exists.

**Minimal implementation**

- [ ] Resolve the managed context and Git binding through Agent authority before
  constructing any Docker request.
- [ ] Inspect the currently running project's development container and image;
  bind the dedicated executor to that image ID, runtime plan hash, revision,
  generation, worktree identity, and Git administration identities.
- [ ] Construct only the exact mount set described above and validate every
  container field after creation. A validation mismatch stops and cleans up the
  new executor; it never repairs the request by adding a broad mount.
- [ ] Keep the executor's process sandbox enabled. The split boundary removes the
  home from the executor; it does not authorize danger/full-access or sandbox
  bypass.

**Passing verification**

- [ ] Run the focused Vitest command above.
- [ ] Run:

  ```bash
  pnpm --filter @devspace/agent run typecheck
  ```

**Commit**

```text
feat(agent): enforce Codex project executor image policy
```

## Task 5: Start the executor-side exec-server and classify transport security

**Files**

- Create `apps/agent/src/codex-cli-split/transport.ts`.
- Create `apps/agent/src/codex-cli-split/transport.test.ts`.
- Create `apps/agent/src/codex-cli-split/exec-server.ts`.
- Create `apps/agent/src/codex-cli-split/exec-server.test.ts`.
- Modify `apps/agent/src/docker-runtime.ts` only if a focused exec inspection or
  bounded attached-stream method is required by the already existing Docker
  client.
- Test the new modules with both new test files.

**Consumes**

- The exact 0.153.4 `codex exec-server --listen` CLI path from
  `codex-rs/cli/src/main.rs` and `codex-rs/exec-server/src/server/transport.rs`.
- `DockerEngineClient.createExec()`, `startExecAttached()`, `inspectExec()`,
  `topContainer()`, and `inspectContainer()`.
- `CodexProjectExecutorBinding`, `CodexSplitNetworkBinding`,
  `CodexSplitArtifactBinding`, and `codexCommand()`.
- Existing `ws` dependency only for a bounded protocol probe if it can be
  connected from the intended control-side network path.

**Produces**

```ts
export type CodexSplitTransportSecurity =
  | "protocol-authenticated"
  | "private-network-only"
  | "unproven";

export interface CodexSplitTransportCredential {
  readonly delivery: "control-only-file" | "control-only-environment";
  readonly target: string;
  readonly fingerprint: string;
}

export interface CodexSplitTransportBinding {
  readonly endpointUrl: string;
  readonly endpointHost: "codex-executor";
  readonly endpointPort: number;
  readonly security: CodexSplitTransportSecurity;
  readonly authenticationEvidence: "verified" | "absent" | "not-tested";
  readonly credential: CodexSplitTransportCredential | null;
  readonly workspaceId: string;
  readonly generation: number;
  readonly executionNetworkId: string;
}

export function classifyCodexSplitTransport(input: {
  readonly protocolAuthenticationVerified: boolean;
  readonly privateNetworkIsolationVerified: boolean;
  readonly admittedVersion: string;
}): CodexSplitTransportSecurity;

export interface CodexExecServerHandle {
  readonly executorContainerId: string;
  readonly execId: string;
  readonly endpoint: CodexSplitTransportBinding;
  readonly serverPid: number;
}

export async function startCodexExecServer(input: {
  readonly docker: DockerEngineClient;
  readonly executor: CodexProjectExecutorBinding;
  readonly transport: CodexSplitTransportBinding;
}): Promise<CodexExecServerHandle>;

export async function assertCodexExecServerReady(input: {
  readonly docker: DockerEngineClient;
  readonly handle: CodexExecServerHandle;
}): Promise<void>;

export async function stopCodexExecServer(input: {
  readonly docker: DockerEngineClient;
  readonly handle: CodexExecServerHandle;
}): Promise<void>;
```

**Failing test first**

- [ ] Add command-shape tests proving the server starts inside the executor with
  the verified artifact and `--listen ws://0.0.0.0:PORT` where `PORT` is the
  validated allocated numeric port, never with a
  `program` environment entry, control-side home, Agent socket, or Docker
  socket.
- [ ] Add transport classification tests proving an authenticated protocol is
  required for `protocol-authenticated`; an old direct listener with no protocol
  auth is exactly `private-network-only`; missing evidence is `unproven`.
- [ ] Add failure tests for wrong workspace/generation/network, an endpoint bound
  to loopback only inside the wrong container, a public/published listener, a
  stale server PID, a non-ready `/readyz`, an endpoint reachable through the
  control-egress source route, an endpoint not reachable through the execution
  source route, and an executor process that exits.
- [ ] Run:

  ```bash
  pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/transport.test.ts apps/agent/src/codex-cli-split/exec-server.test.ts
  ```

  Expected failure: the transport and exec-server lifecycle interfaces do not
  exist.

**Minimal implementation**

- [ ] Use a per-workspace endpoint alias/port on `network.execution` and keep
  all Docker host port bindings empty. The transport binding records the
  execution-network ID, never the control-egress ID. The verifier must probe
  the endpoint from the control sidecar using the execution-network source
  address and separately using the control-egress source address; only the
  former may succeed.
- [ ] Start the server as an executor-side process through Docker exec and
  retain only bounded exec/PID/ready state. The executor process receives no
  native home environment.
- [ ] Test the exact 0.153.4 listener for protocol authentication rather than
  assuming current upstream behavior. Record whether auth is bearer, mutual,
  token, or absent without logging secret material.
- [ ] If a supported authenticated transport needs a secret, represent only an
  Agent-owned fingerprint and the exact Codex-supported control-only delivery
  mechanism. Mount or inject that secret into the control sidecar only; never
  place it in the executor, URL userinfo, labels, logs, events, SQLite, or Web.
  If 0.153.4 has no such mechanism, keep `credential: null` and classify the
  result as private-network-only rather than inventing an authentication layer.
- [ ] If direct 0.153.4 transport has no protocol authentication, mark the
  binding `private-network-only`; the result model in Task 10 will cap the live
  outcome at `PASS-WITH-TRANSPORT-BLOCK`. Do not expose the endpoint on host,
  Agent, browser, shared network, or public ingress.
- [ ] Treat a control-egress route that can reach the exec-server, a published
  endpoint, or a host/public listener as a security failure. Treat inability to
  prove the execution-only source route or the control-egress isolation as
  `BLOCKED/INCOMPLETE`; do not convert an unproven route into a transport pass.
- [ ] If the exact image lacks a ready probe utility, use only an existing image
  tool or a verified Codex transport probe on the private pair. Absence of a
  bounded readiness proof is `BLOCKED/INCOMPLETE`, not a pass.

**Passing verification**

- [ ] Run the focused Vitest command above.
- [ ] Run:

  ```bash
  pnpm --filter @devspace/agent run typecheck
  ```

**Commit**

```text
feat(agent): run Codex split exec-server
```

## Task 6: Enforce the remote-only effective policy and reject local escape paths

**Files**

- Create `apps/agent/src/codex-cli-split/remote-policy.ts`.
- Create `apps/agent/src/codex-cli-split/remote-policy.test.ts`.
- Test any reused low-level private policy materialization only through the new
  tests; do not modify the old branch or copy its recursive home denial.

**Consumes**

- Exact 0.153.4 configuration loader/requirements source, especially
  `config/src/config_requirements.rs`, `config/src/loader/local.rs`,
  `config/src/state.rs`, and the `requirements.toml` precedence path.
- `TurnEnvironmentSelection`, `DefaultEnvironmentProvider`,
  `EnvironmentManager`, `default_thread_environment_selections()`, and
  `TurnEnvironment` from the admitted Codex source.
- The local escape source paths listed in the source map:
  `user_shell.rs`, unified-exec feature handling, MCP stdio/HTTP/helper launchers,
  hook command/legacy notify runners, and plugin maintenance.
- `CodexNativeHomeBinding`, `CodexSplitTransportBinding`, and
  `CodexProjectExecutorBinding`.
- `establishPinnedDirectory()`, `readRegularFileNoFollow()`,
  `durableJsonWriter`, and `redactSensitiveText()`.

**Produces**

```ts
export type CodexForbiddenLocalPath =
  | "local-environment"
  | "shell"
  | "unified-exec-disabled"
  | "missing-endpoint"
  | "stale-endpoint"
  | "command-hooks"
  | "legacy-notify"
  | "local-mcp-stdio"
  | "local-http-helper"
  | "unsafe-plugin-maintenance"
  | "program-executor"
  | "shared-app-server-daemon"
  | "danger-full-access"
  | "sandbox-bypass"
  | "remote-local-fallback";

export type CodexManagedPolicyMechanism =
  | "0.153.4-managed-requirements"
  | "trusted-launch-configuration"
  | "unsupported";

export interface CodexManagedPolicyBinding {
  readonly mechanism: CodexManagedPolicyMechanism;
  readonly requirementsPath: string;
  readonly mountTarget: "/etc/codex/requirements.toml";
  readonly environment: Readonly<Record<string, string>>;
  readonly forbiddenPaths: readonly CodexForbiddenLocalPath[];
  readonly projectLayerOverrideProof: "cannot-override" | "overrides" | "unproven";
}

export interface CodexRemoteOnlyConfiguration {
  readonly environment: Readonly<Record<string, string>>;
  readonly managedPolicy: CodexManagedPolicyBinding;
  readonly endpoint: CodexSplitTransportBinding;
  readonly environmentId: string;
  readonly logicalCwd: "/workspace";
  readonly workspaceRoots: readonly ["/workspace"];
  readonly localEnvironmentAvailable: false;
  readonly unifiedExecRequired: true;
}

export async function prepareCodexManagedPolicy(input: {
  readonly stateRoot: string;
  readonly home: CodexNativeHomeBinding;
  readonly endpoint: CodexSplitTransportBinding;
  readonly admittedVersion: "0.153.4";
}): Promise<CodexManagedPolicyBinding>;

export function buildRemoteOnlyConfiguration(input: {
  readonly home: CodexNativeHomeBinding;
  readonly endpoint: CodexSplitTransportBinding;
  readonly policy: CodexManagedPolicyBinding;
}): CodexRemoteOnlyConfiguration;

export function assertNativeHomeEnvironmentOverride(input: {
  readonly homeConfig: string | null;
  readonly environmentToml: string | null;
  readonly endpoint: CodexSplitTransportBinding;
}): void;

export function assertForbiddenProjectConfiguration(input: {
  readonly projectConfig: string;
  readonly policy: CodexManagedPolicyBinding;
}): void;
```

**Policy decision required by this task**

- [ ] Inspect the admitted 0.153.4 configuration precedence and implement the
  strongest trusted managed mechanism the binary actually honors. The preferred
  path is a system-managed requirements file plus per-sidecar
  `CODEX_EXEC_SERVER_URL`, with no shared-home `environments.toml` override. Do
  not assume a current upstream managed field exists in 0.153.4.
- [ ] The generated policy may constrain allowed workspace-safe sandbox/permission
  modes and require Unified Exec, but it must not contain a recursive
  `/codex-home/**` denial. The split mount boundary makes that denial unnecessary
  and avoids the blocked Bubblewrap expansion.
- [ ] Require `include_local = false` semantics or the exact equivalent proven by
  source/runtime evidence. Reject local default, empty endpoint, `none`, and
  `program` entries.
- [ ] Disable/reject command hooks and legacy notify, local MCP stdio, local HTTP
  or helper execution, unsafe plugin install/update/maintenance, danger/full
  access, sandbox bypass, and shared-daemon reuse. If the managed mechanism can
  only allow hooks rather than disable them, prove the effective managed layer
  yields no project/user hooks or mark the mechanism unsupported.
- [ ] Test both a conflicting native/global `config.toml`/`environments.toml`
  layer in the persistent home and conflicting project `.codex` configuration
  layers in the remote worktree. A project layer that can re-enable any forbidden
  path is a hard failure; trusting the project is not an alternative.
- [ ] Use a URL environment entry only. A `program` entry is always rejected
  because it launches inside the control sidecar and violates the boundary.

**Failing test first**

- [ ] Add serialization/precedence tests for remote default, no local
  environment, Unified Exec required, allowed sandbox profile, and exact current
  endpoint binding.
- [ ] Add an adversarial matrix covering every `CodexForbiddenLocalPath`, with
  both native/global and project-controlled configuration fixtures. Assert that
  each fixture is rejected or made unavailable before launch and after the
  project layer is loaded.
- [ ] Add tests that accept no recursive home-deny policy and reject any generated
  control profile that enables danger/full access, a program executor, or local
  fallback.
- [ ] Run:

  ```bash
  pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/remote-policy.test.ts
  ```

  Expected failure: no remote-only policy binding or adversarial configuration
  enforcement exists.

**Minimal implementation**

- [ ] Materialize one Agent-owned, pinned managed policy file with restrictive
  mode and exact content; mount it read-only into the control sidecar.
- [ ] Build the per-sidecar environment with `CODEX_HOME=/codex-home`,
  `HOME=/codex-home`, the exact remote endpoint, and no local/program endpoint.
  Do not put the private home host path into the environment. If the admitted
  Codex transport requires a secret, use only the Task 5 control-only delivery
  binding; never place that secret in the executor environment or diagnostics.
- [ ] Bind the selected environment ID, logical cwd `/workspace`, and workspace
  root `/workspace` to the remote executor contract. The live evidence must
  inspect the resulting `TurnEnvironmentSelection`, not only the endpoint URL.
- [ ] Implement source-backed config inspection and runtime adversarial checks.
  If a mandatory restriction cannot survive project-layer precedence in
  0.153.4, return a stable hard incompatibility rather than starting the TUI.
- [ ] Make executor loss an explicit remote failure. Do not catch it in a way
  that permits `process_manager.rs` to select local spawning.

**Passing verification**

- [ ] Run the focused Vitest command above.
- [ ] Run:

  ```bash
  pnpm --filter @devspace/agent run typecheck
  ```

**Commit**

```text
feat(agent): enforce Codex split remote policy
```

## Task 7: Build and inspect the credential-bearing control sidecar

**Files**

- Create `apps/agent/src/codex-cli-split/control-sidecar.ts`.
- Create `apps/agent/src/codex-cli-split/control-sidecar.test.ts`.
- Modify `apps/agent/package.json` only if a control-image fixture script is
  required for the focused test; do not change normal Agent startup.
- Test the new module with
  `apps/agent/src/codex-cli-split/control-sidecar.test.ts`.

**Consumes**

- `CodexNativeHomeBinding`, `CodexSplitArtifactBinding`,
  `CodexRemoteOnlyConfiguration`, `CodexSplitNetworkBinding`, and
  `DockerCodexSplitContainerInput`, including
  `buildCodexSplitNetworkAttachments({ role: "control", ... })` from
  `network.ts`.
- `DockerEngineClient.ensureImage()`, `createCodexSplitContainer()`,
  `inspectContainer()`, `inspectImage()`, `startContainer()`, and
  `removeContainer()`.
- The explicit `DEVSPACE_CODEX_CONTROL_IMAGE_REFERENCE` supplied to the live
  verifier. It is a trusted control image reference, not the project image.

**Produces**

```ts
export interface CodexControlSidecarPolicy {
  readonly imageReference: string;
  readonly home: CodexNativeHomeBinding;
  readonly artifact: CodexSplitArtifactBinding;
  readonly remote: CodexRemoteOnlyConfiguration;
  readonly network: CodexSplitNetworkBinding;
  readonly mounts: readonly DockerCodexSplitBindMount[];
  readonly networkAttachments: readonly [
    DockerCodexSplitExecutionAttachment,
    DockerCodexSplitControlEgressAttachment
  ];
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: "/workspace";
  readonly physicalWorkspaceMounts: readonly [];
  readonly physicalGitMounts: readonly [];
  readonly forwardingDisabled: true;
  readonly proxyProcesses: readonly [];
}

export interface CodexControlSidecarBinding {
  readonly policy: CodexControlSidecarPolicy;
  readonly containerId: string;
  readonly containerName: string;
}

export async function buildCodexControlSidecarPolicy(input: {
  readonly imageReference: string;
  readonly home: CodexNativeHomeBinding;
  readonly artifact: CodexSplitArtifactBinding;
  readonly remote: CodexRemoteOnlyConfiguration;
  readonly network: CodexSplitNetworkBinding;
}): Promise<CodexControlSidecarPolicy>;

export async function createCodexControlSidecar(input: {
  readonly docker: DockerEngineClient;
  readonly policy: CodexControlSidecarPolicy;
  readonly name: string;
}): Promise<CodexControlSidecarBinding>;

export function assertCodexControlSidecarInspection(input: {
  readonly container: DockerContainerInspection;
  readonly binding: CodexControlSidecarBinding;
}): void;
```

**Failing test first**

- [ ] Add request tests that the only private state mount is the persistent
  native home at `/codex-home` with the mode required for native login/refresh,
  and that Codex artifact and managed policy mounts are read-only.
- [ ] Assert no real worktree, repository, Git administration, Docker socket,
  Agent socket, host namespace, host PID/network mode, production directory,
  unrelated managed state, or project toolchain mount exists.
- [ ] Assert the sidecar has exactly two network attachments: the execution
  network and the control-egress network. Assert it has no `NET_ADMIN` or
  equivalent routing capability, `net.ipv4.ip_forward=0` (and IPv6 forwarding
  disabled where supported), the control-egress attachment is its only external
  default route, the execution attachment is not a default route, no
  forwarding/NAT/proxy process, and no listener that exposes native home
  services to the executor.
- [ ] Assert `/workspace` is only image-local CWD scaffolding and contains no
  managed files before TUI launch. Assert no recursive home deny policy is
  mounted or generated.
- [ ] Assert the container cannot start if remote-only policy or endpoint is
  absent/stale; it must not start a local TUI and attach later.
- [ ] Run:

  ```bash
  pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/control-sidecar.test.ts
  ```

  Expected failure: no control-sidecar policy or inspection exists.

**Minimal implementation**

- [ ] Create the control container from the explicit trusted control image and
  mount only native home, trusted Codex closure, and managed policy/config assets.
  Add the Task 5 control-only transport credential delivery only when the
  admitted protocol requires it. Use an image-local empty `/workspace` and set
  its logical working directory to `/workspace`.
- [ ] Set `CODEX_HOME` and `HOME` to the in-container target only. Do not expose
  the Agent-private host path to Codex or project processes.
- [ ] Validate the fully created Docker object before TUI launch. Remove the
  container on mismatch and preserve the native home.
- [ ] Keep no Docker/Agent socket and no host namespace. The sidecar may reach
  the intended executor alias only through `network.execution`, and may reach
  OpenAI/ChatGPT only through `network.controlEgress`. Prove the control-egress
  source route reaches the required Codex service while the execution source
  route reaches only the executor. Never bridge those networks in the sidecar
  process, and never introduce a forwarding, NAT, or proxy process.

**Passing verification**

- [ ] Run the focused Vitest command above.
- [ ] Run:

  ```bash
  pnpm --filter @devspace/agent run typecheck
  ```

**Commit**

```text
feat(agent): enforce Codex control sidecar policy
```

## Task 8: Attach a real native TUI PTY and passively observe native session IDs

**Files**

- Create `apps/agent/src/codex-cli-split/native-pty.ts`.
- Create `apps/agent/src/codex-cli-split/native-pty.test.ts`.
- Create `apps/agent/src/codex-cli-split/session-provenance.ts`.
- Create `apps/agent/src/codex-cli-split/session-provenance.test.ts`.
- Test both modules with the new focused test files.

**Consumes**

- `DockerEngineClient.createExec()`, `startExecAttached()`, `resizeExec()`, and
  `inspectExec()`.
- `CodexControlSidecarBinding`, `CodexRemoteOnlyConfiguration`,
  `CodexNativeHomeBinding`, and `resolveCodexExecutablePath()`.
- `lstatIdentity()`, `readRegularFileNoFollow()`, and bounded directory traversal
  from `private-state.ts` for passive provider-owned session provenance.

**Produces**

```ts
export interface NativeCodexPty {
  readonly containerId: string;
  readonly execId: string;
  readonly command: readonly string[];
  readonly workingDirectory: "/workspace";
  readonly stream: Duplex;
  resize(columns: number, rows: number): Promise<void>;
  inspect(): Promise<DockerExecInspection>;
}

export async function startNativeCodexPty(input: {
  readonly docker: DockerEngineClient;
  readonly control: CodexControlSidecarBinding;
  readonly executablePath: "/opt/devspace/codex-launcher/codex";
  readonly resumeSessionId: string | null;
  readonly environment: Readonly<Record<string, string>>;
  readonly columns: number;
  readonly rows: number;
}): Promise<NativeCodexPty>;
```

The command is exactly `[/opt/devspace/codex-launcher/codex]` for a new session
or `[/opt/devspace/codex-launcher/codex, "resume", nativeSessionId]` for resume.
No prompt, slash command, `--dangerously-bypass-approvals-and-sandbox`, hidden
input, or conversation payload is accepted by this function.

```ts
export interface NativeSessionProvenance {
  readonly nativeSessionId: string;
  readonly homeIdentity: FileIdentity;
  readonly providerStateIdentity: FileIdentity;
  readonly observedAt: string;
}

export interface NativeSessionSnapshot {
  readonly homeIdentity: FileIdentity;
  readonly providerStateIdentities: ReadonlyMap<string, FileIdentity>;
}

export async function snapshotNativeSessionState(input: {
  readonly home: CodexNativeHomeBinding;
}): Promise<NativeSessionSnapshot>;

export async function discoverNativeSession(input: {
  readonly before: NativeSessionSnapshot;
  readonly after: NativeSessionSnapshot;
  readonly home: CodexNativeHomeBinding;
}): Promise<NativeSessionProvenance>;
```

**Failing test first**

- [ ] Add PTY request tests proving `tty: true`, stdin/stdout/stderr attachment,
  `/workspace` logical CWD, exact new/resume argv, bounded resize validation,
  and no extra input writer.
- [ ] Add tests proving a prompt argument, arbitrary command, local executable,
  invalid resume ID, hidden input callback, or missing remote policy is rejected.
- [ ] Add provenance tests that identify a newly created provider-owned session
  from filename/metadata identity only, reject zero or multiple candidates, and
  never return session file contents or prompt text.
- [ ] Run:

  ```bash
  pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/native-pty.test.ts apps/agent/src/codex-cli-split/session-provenance.test.ts
  ```

  Expected failure: the native PTY and passive provenance interfaces do not
  exist.

**Minimal implementation**

- [ ] Create a Docker exec with `attachStdin: true`, `tty: true`, exact native
  command, exact logical CWD, and the already validated remote-only environment;
  attach the returned stream to operator stdin/stdout without writing to it.
- [ ] Propagate terminal resize through `resizeExec()` and close/inspect the
  exec without converting the stream into structured Codex conversation events.
- [ ] Snapshot only provider-owned session identities before and after normal
  native TUI use. Do not inject an input to ask Codex for its own ID.

**Passing verification**

- [ ] Run the focused Vitest command above.
- [ ] Run:

  ```bash
  pnpm --filter @devspace/agent run typecheck
  ```

**Commit**

```text
feat(agent): launch native Codex split PTYs
```

## Task 9: Implement ordered split lifecycle, restart reconciliation, and session concurrency

**Files**

- Create `apps/agent/src/codex-cli-split/runtime-record.ts`.
- Create `apps/agent/src/codex-cli-split/runtime-record.test.ts`.
- Create `apps/agent/src/codex-cli-split/split-runtime.ts`.
- Create `apps/agent/src/codex-cli-split/split-runtime.test.ts`.
- Test both modules with the new focused test files.

**Consumes**

- `ManagedWorkspaces.initialize()`, `executionContext()`,
  `codexExecutorGitBinding()`, `repositoryPath()`, and `worktreePath()`.
- All policies/bindings from Tasks 1–8.
- `durableJsonWriter`, `readStrictJson()`, `pinExistingDirectory()`,
  `comparePersistedIdentity()`, and `assertContained()`.
- Docker lifecycle and PTY methods from `DockerEngineClient`.

**Produces**

```ts
export interface CodexSplitSessionRecord {
  readonly nativeSessionId: string;
  readonly controlContainerId: string;
  readonly controlExecId: string;
  readonly homeIdentity: FileIdentity;
  readonly state: "starting" | "live" | "stopped" | "ambiguous";
  readonly startedAt: string;
  readonly stoppedAt: string | null;
}

export interface CodexSplitRuntimeRecord {
  readonly version: 1;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly runtimePlanHash: string;
  readonly generation: number;
  readonly networks: {
    readonly execution: {
      readonly id: string;
      readonly name: string;
      readonly role: "execution";
      readonly internal: true;
      readonly defaultRoute: false;
    };
    readonly controlEgress: {
      readonly id: string;
      readonly name: string;
      readonly role: "control-egress";
      readonly internal: false;
      readonly defaultRoute: true;
    };
  };
  readonly executor: {
    readonly id: string;
    readonly imageId: string;
    readonly endpointUrl: string;
    readonly transportSecurity: CodexSplitTransportSecurity;
  };
  readonly control: { readonly id: string; readonly homeBinding: "owner-default" };
  readonly sessions: readonly CodexSplitSessionRecord[];
}

export class CodexSplitRuntime {
  constructor(input: {
    readonly managed: ManagedWorkspaces;
    readonly docker: DockerEngineClient;
    readonly stateRoot: string;
    readonly controlImageReference: string;
    readonly codexExecutablePath: string;
  });

  initialize(): Promise<void>;
  ensure(input: { readonly projectId: string; readonly workspaceId: string }): Promise<CodexSplitRuntimeRecord>;
  startNewSession(input: { readonly projectId: string; readonly workspaceId: string; readonly columns: number; readonly rows: number }): Promise<NativeCodexPty>;
  startResume(input: { readonly projectId: string; readonly workspaceId: string; readonly nativeSessionId: string; readonly columns: number; readonly rows: number }): Promise<NativeCodexPty>;
  stop(input: { readonly projectId: string; readonly workspaceId: string }): Promise<void>;
  reconcileAfterAgentRestart(input: { readonly projectId: string; readonly workspaceId: string }): Promise<CodexSplitRuntimeRecord>;
}
```

**Lifecycle order**

- [ ] `ensure()` must rootless-check and resolve exact managed ownership first;
  validate the image, Git binding, home, artifact, both network roles, executor policy,
  executor process, transport readiness/authentication, remote policy, and
  control-sidecar inspection in that order. No native TUI exec is created until
  all preceding checks pass.
- [ ] Persist both execution-network and control-egress IDs/names, roles, and
  expected route properties in the Agent-private record. Reconcile both networks
  after an Agent restart; a missing, replaced, shared, unexpectedly attached, or
  route-mismatched network fails closed. The persisted executor endpoint always
  references `networks.execution`; the control's upstream route always
  references `networks.controlEgress`.
- [ ] Persist only opaque IDs, identities, hashes, generation, endpoint security
  category, and lifecycle state under a pinned Agent-private `codex-split`
  state directory. Never persist transcript, raw terminal output, auth, refresh,
  cookies, token, endpoint secret, complete command, or home file contents.
- [ ] On any creation failure, stop/remove only resources proven by labels and
  identities to belong to this attempt; preserve native home and managed
  worktree/Git state. A partial executor/control state is not a local-execution
  reason.
- [ ] `startNewSession()` creates the ordinary native command and binds its PTY.
  After normal exit, it passively discovers the native ID and marks the record.
  Failure to discover an ID leaves the session unbound; it does not inject input.
- [ ] `startResume()` refuses a native ID whose record proves a live original
  process, or whose liveness/identity is ambiguous. It reconstructs the exact
  executor generation and endpoint and launches only `codex resume NATIVE_SESSION_ID`.
- [ ] Agent restart inspects surviving labeled containers, process tables,
  endpoint, home identity, and record identity. Reattach only with complete proof;
  otherwise preserve home, mark ambiguous state safely, and allow a later native
  resume. Never start a second TUI merely because a PTY is hard to observe.
- [ ] Multiple distinct native IDs may have simultaneous PTYs and executor
  processes against the same worktree. Do not serialize or reject them by
  workspace.

**Failing test first**

- [ ] Add state-schema tests for malformed records, path/identity drift, missing
  generations, secret-looking fields, duplicate live native IDs, and an
  unowned Docker resource.
- [ ] Add lifecycle tests with fakes that assert the exact creation order and
  fail closed at every boundary; executor loss must never invoke local
  `spawn_process` or create a control-side project mount.
- [ ] Add concurrency tests accepting two different native IDs and rejecting
  only a duplicate live native ID. Add restart tests for complete reattach,
  stale endpoint, missing executor, orphan TUI, and ambiguous process identity.
- [ ] Run:

  ```bash
  pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/runtime-record.test.ts apps/agent/src/codex-cli-split/split-runtime.test.ts
  ```

  Expected failure: no split runtime record or lifecycle coordinator exists.

**Minimal implementation**

- [ ] Implement the ordered coordinator as an Agent-internal composition root.
  It may call the existing development runtime authority but must create a
  separate executor container and never alter the existing runtime record.
- [ ] Use durable atomic records and explicit state transitions. Treat Docker
  inspection disagreement as state conflict, not as permission to recreate with
  broader access.
- [ ] On executor failure, mark affected remote operations failed and preserve
  native home. Provide no code path that starts local tools in the control
  sidecar.

**Passing verification**

- [ ] Run the focused Vitest command above.
- [ ] Run:

  ```bash
  pnpm --filter @devspace/agent run typecheck
  ```

**Commit**

```text
feat(agent): manage Codex split runtime lifecycle
```

## Task 10: Model A–F evidence and exact feasibility outcomes

**Files**

- Create `apps/agent/src/codex-cli-split/feasibility-result.ts`.
- Create `apps/agent/src/codex-cli-split/feasibility-result.test.ts`.
- Test the new pure result model with its focused test file.

**Consumes**

- `CodexSplitTransportSecurity` from `transport.ts`.
- Runtime, mount, process, canary, configuration, and native lifecycle evidence
  types from Tasks 1–9.

**Produces**

```ts
export type CodexSplitFeasibilityOutcome =
  | "PASS"
  | "PASS-WITH-TRANSPORT-BLOCK"
  | "FAIL"
  | "BLOCKED/INCOMPLETE";

export type CodexSplitGateSection = "A" | "B" | "C" | "D" | "E" | "F";

export interface CodexSplitGateEvidence {
  readonly admittedCodexVersion: "0.153.4";
  readonly sections: Readonly<Record<CodexSplitGateSection, boolean>>;
  readonly transportSecurity: CodexSplitTransportSecurity;
  readonly liveOperatorProof: boolean;
  readonly physicalHomeSeparation: boolean;
  readonly noLocalFallback: boolean;
  readonly controlModelEgressProven: boolean;
  readonly executorCannotReachControlEgressProven: boolean;
  readonly controlRoutingDisabledProven: boolean;
  readonly securityViolation: boolean;
  readonly incompleteReason: string | null;
  readonly unsupportedReason: string | null;
  readonly evidenceVersion: 1;
}

export function evaluateCodexSplitOutcome(
  evidence: CodexSplitGateEvidence
): CodexSplitFeasibilityOutcome;
```

**Outcome rules**

- [ ] Return `FAIL` for any disproven security invariant: executor can reach
  native home, any project operation executes in control, local fallback occurs,
  a forbidden config path remains usable, host/unrelated network or namespace
  exposure is proven, or a required exact-image/mount boundary is violated.
- [ ] Return `BLOCKED/INCOMPLETE` when operator aborts, exact image compatibility
  is unsupported, Codex version limitation prevents proof, endpoint/transport
  evidence is missing, or the empirical proof is insufficient. Do not relabel
  missing evidence as a security failure.
- [ ] Return `PASS` only when every A–F section is true, live operator proof is
  true, physical separation and no-local-fallback are true, and
  `protocol-authenticated` transport is proven. The three explicit network
  proofs (`controlModelEgressProven`,
  `executorCannotReachControlEgressProven`, and
  `controlRoutingDisabledProven`) must also be true.
- [ ] Return `PASS-WITH-TRANSPORT-BLOCK` only when every A–F section and physical
  separation/no-fallback proof is true, the three explicit network proofs are
  true, but the exact direct transport is proven only by the dedicated private
  execution network. The separate control-egress path is still proven for
  native model/authentication traffic. This is not migration authorization.
- [ ] Require `admittedCodexVersion === "0.153.4"` unless a separately approved
  compatibility decision is added before implementation. Unit or mocked evidence
  cannot set `liveOperatorProof` and therefore cannot produce a live PASS.

**Failing test first**

- [ ] Add table tests for every outcome rule, including security violation taking
  precedence over incomplete evidence, operator abort, exact-image
  incompatibility, no transport authentication, authenticated transport, and
  mocked/unit-only evidence. Add cases where control model egress, executor
  egress isolation, or control routing-disabled proof is absent; those cases
  must not produce either pass outcome.
- [ ] Add a test that an A–F section map with one false value never produces a
  pass outcome.
- [ ] Run:

  ```bash
  pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/feasibility-result.test.ts
  ```

  Expected failure: no exact four-state result evaluator exists.

**Minimal implementation**

- [ ] Keep the evaluator pure and schema-validated. Do not let console output,
  operator text, or a guessed transport category mutate evidence.
- [ ] Use stable bounded reason categories and omit secret/path/output fields from
  serialized evidence.

**Passing verification**

- [ ] Run the focused Vitest command above.
- [ ] Run:

  ```bash
  pnpm --filter @devspace/agent run typecheck
  ```

**Commit**

```text
feat(agent): model Codex split feasibility outcomes
```

## Task 11: Build the opt-in live verifier and operator-run A–F gate

**Files**

- Create `apps/agent/src/codex-cli-split/feasibility-verifier.ts`.
- Create `apps/agent/src/codex-cli-split/feasibility-verifier.test.ts`.
- Create `apps/agent/test/verify-codex-cli-split-execution.ts`.
- Modify `apps/agent/package.json` to add the exact opt-in script
  `verify:codex:split:real`.
- Test the verifier module with
  `apps/agent/src/codex-cli-split/feasibility-verifier.test.ts`. The executable
  entrypoint is covered by a parser/abort smoke test without starting Docker.

**Consumes**

- `ManagedWorkspaces` constructed with
  `DEVSPACE_MANAGED_ROOT/projects`, `/workspaces`, and `/state`, then initialized
  through the existing Agent authority.
- `DockerEngineClient` constructed only from
  `DEVSPACE_TEST_DOCKER_SOCKET_PATH`, followed by
  `assertRootlessAvailable()`.
- `resolveCodexExecutablePath()` and `assertAdmittedCodexVersion()`.
- `CodexSplitRuntime`, all split policies, PTY/provenance helpers, and
  `evaluateCodexSplitOutcome()`.
- Existing Docker exec framing patterns from `probe-runtime.ts`; no old
  same-container sidecar verifier.
- `createLogger()`, `sanitizeLogFields()`, and `redactSensitiveText()` with a
  developer-only bounded diagnostic formatter.

**Produces**

```ts
export const CODEX_SPLIT_VERIFY_ENV = [
  "DEVSPACE_TEST_DOCKER_SOCKET_PATH",
  "DEVSPACE_MANAGED_ROOT",
  "DEVSPACE_CODEX_EXECUTABLE_PATH",
  "DEVSPACE_CODEX_CONTROL_IMAGE_REFERENCE",
  "DEVSPACE_CODEX_VERIFY_PROJECT_ID",
  "DEVSPACE_CODEX_VERIFY_WORKSPACE_ID"
] as const;

export interface CodexSplitVerifyConfiguration {
  readonly dockerSocketPath: string;
  readonly managedRoot: string;
  readonly codexExecutablePath: string;
  readonly controlImageReference: string;
  readonly projectId: string;
  readonly workspaceId: string;
}

export function parseCodexSplitVerifyEnvironment(
  environment: NodeJS.ProcessEnv
): CodexSplitVerifyConfiguration;

export interface CodexSplitLiveEvidence extends CodexSplitGateEvidence {
  readonly runId: string;
  readonly processObservations: readonly {
    readonly role: "control" | "executor";
    readonly projectProcessCount: number;
  }[];
  readonly mountObservations: readonly {
    readonly role: "control" | "executor";
    readonly allowedMounts: boolean;
  }[];
  readonly networkObservations: readonly {
    readonly executionNetworkExpectedMembers: boolean;
    readonly controlEgressExpectedMembers: boolean;
    readonly controlCodexServiceReachableOnEgress: boolean;
    readonly executorEndpointReachableOnExecution: boolean;
    readonly executorEndpointReachableFromControlEgress: boolean;
    readonly executorInternetReachable: boolean;
    readonly executorControlEgressGatewayReachable: boolean;
    readonly executorHostReachable: boolean;
    readonly executorUnrelatedServiceReachable: boolean;
    readonly controlForwardingDisabled: boolean;
    readonly controlRoutingCapabilitiesAbsent: boolean;
    readonly controlProxyProcessAbsent: boolean;
    readonly endpointPublished: boolean;
    readonly hostNetworkListener: boolean;
  }[];
}

export async function runCodexSplitFeasibilityGate(input: {
  readonly configuration: CodexSplitVerifyConfiguration;
  readonly operator: CodexSplitOperator;
}): Promise<CodexSplitLiveEvidence>;

export interface CodexSplitOperator {
  printChecklist(text: string): void;
  attach(pty: NativeCodexPty): Promise<"exited" | "aborted">;
  confirmFinalResult(): Promise<"PASS" | "FAIL">;
}
```

**Required opt-in behavior**

- [ ] Refuse to run unless all six named variables are present, absolute where
  paths are required, valid UUIDs where IDs are required, and the control image
  reference is an explicit immutable reference accepted by the Docker policy.
  There is no socket or managed-root fallback.
- [ ] Construct roots exactly as the existing Agent does from
  `DEVSPACE_MANAGED_ROOT`; resolve the exact project/workspace and current
  runtime ownership before any experiment resource is created.
- [ ] Assert the Docker socket is a direct Unix socket and the daemon is
  rootless. Refuse a host Docker socket, symlink replacement, host namespace,
  host network, or published endpoint. The Agent must create two dedicated
  networks itself: an internal execution network and a non-internal
  control-egress network; the verifier must reject Docker's default `bridge`, a
  caller-supplied shared network, or any executor attachment to control-egress.
- [ ] Before TUI attachment, inspect both network objects and both container
  endpoint settings, prove the control-egress default route and the executor's
  absence of an external default route, and prove the control container has no
  routing capability, IP forwarding, NAT/forwarding process, or proxy listener.
- [ ] Print the complete manual A–F checklist before attaching the first native
  TUI. The checklist is operator guidance printed by the verifier, never text
  sent to Codex. Attach a real native `codex` PTY with no injected input.
- [ ] Create a disposable verifier fixture only through Agent-owned paths: a
  random non-secret canary in native home and uniquely named project test files
  where needed. Snapshot identities/hashes first, never overwrite a pre-existing
  file, remove only verifier-created files, and leave native auth/history and
  project/Git state intact.

**Automated prechecks and live evidence**

- [ ] Prove A: exact 0.153.4 version, persistent home binding, control container
  mount/process/namespace inspection, no real project/Git mount, no sockets,
  bare native TUI start, remote-only effective configuration, no local
  environment, native home persistence, and successful native authentication or
  model traffic through the control-egress network. Prove the control sidecar
  has both network attachments but no forwarding capability, route, or proxy
  path that could serve the executor's traffic.
- [ ] Prove B: exact running project image ID, exact worktree and Git admin
  identities/mounts, trusted artifact/helper closure, no home/credentials/
  sockets/unrelated state, project sandbox enabled, separate PID namespace, and
  exactly one network attachment: `network.execution`, with no external default
  route. The executor is never attached to `network.controlEgress`.
- [ ] From the operator's real TUI, print and collect only bounded result
  categories for the manual checks: `pwd` reports logical `/workspace`; Git
  status/diff/log; Node child if present; Python child if present; package
  script/toolchain child; nested child process; AGENTS.md read; normal file
  read/write; and apply_patch. The verifier must inspect the executor's process
  table/exec records and worktree identities to prove each operation was remote,
  not infer it from output.
- [ ] For process proof, snapshot both container process tables before and after
  each operator-approved check and count project/toolchain descendants. Control
  may contain native Codex and approved control helpers only; all project
  processes must appear under the executor. Do not persist raw argv or output.
- [ ] Create a non-secret canary only under the native home. The operator-run
  project probe must test direct absolute path, traversal, a workspace symlink,
  environment-variable discovery, `/proc` process/root inspection, alternate
  mount paths, and directory enumeration. The probe reports booleans and never
  prints canary contents. Any successful read is `FAIL`.
- [ ] Prove D from both Docker metadata and runtime probes: the execution network
  contains only control and executor; the control-egress network contains only
  control; the control-egress source route reaches the required Codex/OpenAI
  service; the execution source route reaches the exec-server; and the
  exec-server is not reachable from the control-egress source route. Inspect
  capabilities, `/proc/sys/net/ipv4/ip_forward` and IPv6 forwarding where
  supported, route tables, listeners, and process tables to prove no control
  forwarding/NAT/proxy path exists. From the executor, explicitly probe the
  Internet, control-egress gateway, control's egress address, host/gateway, and
  unrelated DevSpace services; all must fail. Also prove separate PID
  namespaces, no host namespaces, no published ports, and no host-network
  listener. “No published ports” alone is not enough. If the exact image lacks
  a bounded probe capability or rootless Docker cannot expose the required route
  evidence, record `BLOCKED/INCOMPLETE` rather than infer isolation from network
  metadata.
- [ ] Prove executor loss while the TUI is live causes a remote failure and no
  control-side local process. Repeat for missing, empty, and stale endpoint
  records. A missing or stale execution endpoint must not cause the control
  sidecar to use its control-egress route for the executor request.

**Native lifecycle checks**

- [ ] Attach the bare native TUI with no physical project mount. The operator
  creates/uses a native session and performs native approval choices. The
  verifier snapshots provider-owned state and confirms native session state is
  persisted without reading or logging its contents.
- [ ] After the operator exits the TUI normally, passively identify exactly one
  native session ID. Ctrl+C, attach failure, ambiguous state, or multiple new
  candidates is `BLOCKED/INCOMPLETE`, never PASS.
- [ ] Recreate/reuse the exact compatible executor generation and attach a new
  PTY with exactly `codex resume NATIVE_SESSION_ID`. Do not inject the ID into
  the TUI; it is an argv value supplied by the Agent after passive provenance.
- [ ] Prove resumed native home identity, remote-only endpoint, logical
  `/workspace`, AGENTS/filesystem routing, and no local project process. A
  missing/stale executor during resume fails closed.
- [ ] Run a second distinct native session concurrently against the same
  workspace and accept it if all isolation/routing checks pass. Attempting a
  second resume of the first live native ID must be rejected; no workspace-wide
  lock is permitted.

**Negative-path matrix**

- [ ] Run static and live checks for local environment, `/shell`, Unified Exec
  disabled, missing/empty/`none`/stale endpoint, command hooks, legacy notify,
  local MCP stdio, local HTTP/helper execution, unsafe plugin
  install/update/maintenance, program executor entries, shared app-server
  daemon reuse, danger/full-access, sandbox bypass, and remote-to-local
  fallback after executor failure.
- [ ] Apply the same matrix to native/global home configuration and to
  project-controlled `.codex`/configuration layers. A preflight pass followed by
  a project-layer override is a hard `FAIL`.
- [ ] Ensure the native TUI remains native: no hidden prompt injection, slash
  command injection, synthetic approval, conversation reconstruction, or
  structured UI replacement is used to obtain evidence.

**Diagnostics and cleanup**

- [ ] Emit a bounded run ID, phase, stable reason code, exception class, capped
  sanitized stack context, result category, resource role, and transport
  security category. Use `redactSensitiveText()` and an explicit allowlist;
  never emit native-home paths/contents, auth/refresh/cookie/token values,
  transport secrets, raw protocol, raw command/output, private host paths, or
  unbounded Docker errors.
- [ ] On all exits, stop TUI/executor/control in an ownership-checked order,
  remove only the dedicated network/resources, remove only verifier-created
  canary/fixture files, and preserve native auth/config/session history and
  project workspace/Git state. Cleanup failure changes the evidence to
  `BLOCKED/INCOMPLETE` and is reported with bounded cleanup context.
- [ ] Require an explicit operator `PASS` or `FAIL` only after every manual A–F
  check and automated evidence record exists. Ctrl+C, process termination,
  missing input, or any abort can never be converted to PASS.

**Failing test first**

- [ ] Add parser tests for each required environment variable, missing/empty
  values, invalid IDs, relative paths, and unsafe image references. Assert no
  Docker client is constructed on parse failure.
- [ ] Add orchestration tests with fake Docker/runtime/operator implementations
  proving precheck ordering, no TUI before policy validation, no local fallback,
  cleanup on every failure, preservation of home/worktree, and abort yielding
  `BLOCKED/INCOMPLETE`.
- [ ] Add tests that process/mount/network evidence cannot become true from
  command-output strings alone and that an unexpected control-side project
  process or canary read becomes `FAIL`.
- [ ] Add tests for exact command argv for new/resume, passive session discovery,
  duplicate-live-session refusal, and resume after a stale/missing executor.
- [ ] Run:

  ```bash
  pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/feasibility-verifier.test.ts
  ```

  Expected failure: no opt-in parser, verifier orchestration, or evidence
  collection exists.

**Minimal implementation**

- [ ] Compose the Task 1–10 units in one verifier module with explicit phases;
  do not add a second runtime authority or arbitrary-CLI framework.
- [ ] Add the package script:

  ```json
  "verify:codex:split:real": "pnpm --dir ../.. exec tsx apps/agent/test/verify-codex-cli-split-execution.ts"
  ```

- [ ] Make `apps/agent/test/verify-codex-cli-split-execution.ts` parse the six
  variables, construct Agent roots and Docker client, require explicit operator
  attachment, print a bounded result, set a nonzero exit status for FAIL or
  BLOCKED/INCOMPLETE, and never invoke the verifier without the explicit opt-in.
- [ ] Keep the live verifier outside normal `pnpm test`; unit tests must not
  create Docker containers or start Codex.

**Passing verification**

- [ ] Run the focused Vitest command above.
- [ ] Run the no-input safety check; it must fail before Docker access:

  ```bash
  env -i PATH="$PATH" pnpm --filter @devspace/agent run verify:codex:split:real
  ```

- [ ] Run:

  ```bash
  pnpm --filter @devspace/agent run typecheck
  ```

- [ ] The actual live command is run only as the operator gate after the exact
  artifact/image/network inputs are prepared:

  ```bash
  DEVSPACE_TEST_DOCKER_SOCKET_PATH="$DEVSPACE_TEST_DOCKER_SOCKET_PATH" DEVSPACE_MANAGED_ROOT="$DEVSPACE_MANAGED_ROOT" DEVSPACE_CODEX_EXECUTABLE_PATH="$DEVSPACE_CODEX_EXECUTABLE_PATH" DEVSPACE_CODEX_CONTROL_IMAGE_REFERENCE="$DEVSPACE_CODEX_CONTROL_IMAGE_REFERENCE" DEVSPACE_CODEX_VERIFY_PROJECT_ID="$DEVSPACE_CODEX_VERIFY_PROJECT_ID" DEVSPACE_CODEX_VERIFY_WORKSPACE_ID="$DEVSPACE_CODEX_VERIFY_WORKSPACE_ID" pnpm --filter @devspace/agent run verify:codex:split:real
  ```

  The verifier must reject unset/empty values; the command must not provide
  defaults. Its result is not a pass until the operator completes all A–F
  evidence and explicitly confirms the final result.

**Commit**

```text
feat(agent): add Codex split feasibility verifier
```

## Task 12: Run one focused security review, conditional bounded status update, and final repository gates

**Files**

- Review all files created or modified by Tasks 1–11.
- Modify `docs/current-state.md` only after a real operator-run verifier has
  completed and only with the exact bounded result category. Do not modify it for
  unit-test success, a mocked run, or an incomplete live run.
- Do not modify the approved split spec, old spec, old feasibility plan, ADR 015,
  `docs/specs/ai-sessions-v1.md`, Web, SQLite, Workbench, or the structured
  app-server path.
- Test the final Agent implementation with the focused Agent suite and the full
  repository gates below.
- Test files: `apps/agent/src/codex-cli-split/compatibility.test.ts`,
  `native-home.test.ts`, `network.test.ts`, `artifact.test.ts`,
  `project-executor.test.ts`, `transport.test.ts`, `exec-server.test.ts`,
  `remote-policy.test.ts`, `control-sidecar.test.ts`, `native-pty.test.ts`,
  `session-provenance.test.ts`, `runtime-record.test.ts`,
  `split-runtime.test.ts`, `feasibility-result.test.ts`, and
  `feasibility-verifier.test.ts`; modified authority tests
  `apps/agent/src/docker-runtime.test.ts`,
  `apps/agent/src/managed-workspaces.test.ts`, and
  `apps/agent/src/workspace-runtime.test.ts`; plus the full Agent test project.

**Consumes**

- The complete A–F evidence and result from Task 11.
- `docs/README.md` authority order and `AGENTS.md` required checks.
- Existing structured app-server tests and all normal workspace/runtime tests.

**Produces**

- [ ] One focused independent Luna Max security/architecture review after the
  complete implementation and actual live-gate evidence exist. Review only
  physical home separation, exact image/mount/network policy, remote routing,
  effective-config adversarial enforcement, local escape paths, transport
  classification, native lifecycle/resume, restart/concurrency, and secret
  diagnostics.
- [ ] If that review finds substantive issues, make one correction pass, rerun
  the affected focused tests and the live proof, and obtain the reviewer's
  disposition. Do not create a cascade of generic reviewers.
- [ ] Perform one final self-review after any correction pass. Confirm the
  structured app-server path is still shipped/default and no migration work was
  introduced.
- [ ] If the live result is `PASS`, `PASS-WITH-TRANSPORT-BLOCK`, `FAIL`, or
  `BLOCKED/INCOMPLETE`, update `docs/current-state.md` with that exact category,
  the bounded reason, and the statement that structured app-server remains
  shipped/default. A transport-block result must explicitly say it is not
  migration authorization. An incomplete run must not be described as FAIL.

**Failing test first**

- [ ] Before the final gates, run the focused Agent suite and inspect failures;
  do not claim the architecture is proven from unit tests.
- [ ] Run:

  ```bash
  pnpm --dir ../.. exec vitest run --project @devspace/agent
  ```

  Expected failure before implementation is complete: new split modules are not
  yet present or integrated. During implementation this command must become the
  focused passing baseline.

**Minimal implementation**

- [ ] Compare the live result and all bounded evidence against the A–F checklist
  and the approved spec. Do not interpret a unit-test pass, source inspection,
  or operator assertion without process/mount evidence as a live pass.
- [ ] Run exactly one independent Luna Max security/architecture review after
  complete implementation and live-gate evidence. If substantive issues are
  found, make one correction pass and rerun only affected focused tests plus the
  live proof before the final self-review.
- [ ] Apply the conditional `docs/current-state.md` update only after the live
  result exists, preserving the structured app-server shipped/default statement.

**Passing verification**

- [ ] Run the focused Agent test suite again after the implementation and after
  any review correction.
- [ ] Run every required clean-clone gate from `AGENTS.md` exactly:

  ```bash
  pnpm install --frozen-lockfile
  pnpm workspace:check
  pnpm lint
  pnpm test
  pnpm typecheck
  pnpm build
  pnpm contracts:check
  pnpm schema:check
  pnpm db:migrate:test
  pnpm db:check
  ```

- [ ] Run final repository checks:

  ```bash
  git diff --check
  git status --short
  git branch --show-current
  git rev-parse HEAD
  git rev-parse origin/main
  git merge-base origin/main HEAD
  git log --graph --decorate --oneline --boundary origin/main..HEAD
  git diff --stat origin/main...HEAD
  git diff --stat e201c29fe26b0c46c49ba5464d5c38945713e804...HEAD
  ```

- [ ] Verify the complete diff from `origin/main` and the separate diff from the
  approved architecture-spec commit contain only the intended split feasibility
  implementation and the conditional bounded status update; no
  Web/Workbench/SQLite/migration/structured-path files may appear. The branch
  graph must show the implementation branch descended from the commit containing
  this approved plan, with no `fix/workbench-runtime-ai-truthfulness` ancestry.

**Commit**

```text
docs: record Codex split feasibility result
```

This commit is conditional on the actual live result and is not part of the
current planning change. The implementation plan itself is committed separately
as `docs: plan Codex split execution feasibility`.

## Hard A–F acceptance checklist

The implementation is not ready for review or migration discussion until the
live verifier has explicit evidence for every row below. A mocked test cannot
check a row that depends on a real container, real native TUI, real executor
process, or real filesystem/network boundary.

### A. Control plane

- [ ] Exact admitted Codex `0.153.4` runs from the trusted verified artifact.
- [ ] Native home is persistent Agent-private provider-owned state; native auth,
  refresh, session, and history state remains there.
- [ ] Control sidecar has no real worktree, Git, Docker socket, Agent socket,
  host PID/network/namespace, production path, or unrelated managed state.
- [ ] Control sidecar is attached to both dedicated networks: execution for the
  exec-server pair and control-egress for OpenAI/ChatGPT traffic. The
  control-egress attachment is its only external default route, and the control
  process has no capability, route, forwarding setting, or proxy that can relay
  executor traffic.
- [ ] Image-local `/workspace` is empty scaffolding only; logical `/workspace` is
  distinct from the physical project mount.
- [ ] Bare native `codex` starts a real TUI without injected prompt or keystroke.
- [ ] Remote-only environment is effective by default and local is unavailable.
- [ ] Native authentication/model access succeeds through control-egress; this
  proof is separate from the private execution-network endpoint.
- [ ] Native approvals appear and remain native.
- [ ] Native session is persisted and can be passively identified.

### B. Project executor

- [ ] Dedicated executor image ID equals the running project's exact image ID.
- [ ] `/workspace` is the exact managed worktree with identity proof.
- [ ] Only exact required Git administration is mounted at the path Git expects.
- [ ] Verified Codex exec-server/helper closure is read-only and executable in the
  exact image; incompatibility is a hard stop.
- [ ] No native home, credential, Agent/Docker socket, production path, unrelated
  managed state, host namespace, or shared credential volume is present.
- [ ] Executor is attached only to the private/internal execution network, has
  no control-egress attachment and no external default route, and cannot reach
  the control-egress gateway or upstream service through the control sidecar.
- [ ] Executor process sandbox remains enforced.

### C. Remote routing

- [ ] Native-TUI `pwd`, Git status/diff/log, Node, Python, package/toolchain,
  nested children, AGENTS read, normal file read/write, and apply_patch all use
  the executor filesystem/process namespace.
- [ ] Docker/process observations prove no project process spawned in control.
- [ ] Logical cwd remains `/workspace` while control has no real project bytes.

### D. Security and transport

- [ ] Home canary is unreadable by direct path, traversal, symlink, environment,
  `/proc`, alternate mount, and enumeration probes; canary contents are never
  printed.
- [ ] PID namespaces are separate; neither container has host namespace access;
  executor cannot inspect control filesystem/processes.
- [ ] Execution network is internal/private and contains only control and
  executor. Control-egress is a separate non-internal dedicated network that
  contains only control and has no published ports. The exec-server is reachable
  only on execution; neither network publishes it to host/browser/public ingress.
- [ ] Control reaches the required Codex/OpenAI service through control-egress,
  while executor probes for Internet, control-egress gateway, control egress
  address, host/gateway, and unrelated service all fail. Control's route table
  and process/capability inspection prove no forwarding/NAT/proxy path exists.
- [ ] Exact transport authentication/isolation evidence is recorded. Direct
  0.153.4 network-only transport caps the result at
  `PASS-WITH-TRANSPORT-BLOCK`.
- [ ] Executor loss fails closed with no local fallback.

### E. Native lifecycle

- [ ] Native TUI stops normally without losing persistent native home.
- [ ] Native session ID is identified passively from provider-owned state.
- [ ] Exact `codex resume NATIVE_SESSION_ID` runs in a new native PTY.
- [ ] Resume uses the same home, remote-only endpoint, logical `/workspace`, and
  no local project process.
- [ ] Missing/stale executor during resume fails closed.

### F. Negative paths

- [ ] Local environment, `/shell`, disabled Unified Exec, missing/empty/`none`/
  stale endpoint, hooks, legacy notify, local MCP, local HTTP/helper, unsafe
  plugin maintenance, program executor, shared daemon, danger/full-access,
  sandbox bypass, and remote-to-local fallback are rejected or unavailable.
- [ ] Native/global and project-controlled configuration layers cannot re-enable
  any forbidden path. Failure to prove this is a hard failure.

## Plan self-review checklist

- [ ] Map every material approved-spec requirement to at least one task or the
  A–F checklist: trust boundaries and lifecycle (Tasks 1, 4, 7, 9, 11), native
  home (Tasks 1, 7, 9, 11), remote environment and transport (Tasks 5–6), exact
  image/Git/mounts (Tasks 1–4), shell/unified exec/apply_patch/AGENTS routing
  (Tasks 6 and 11), approvals/sessions/resume/concurrency/restart (Tasks 8–9,
  11), local deny paths and adversarial config (Task 6 and 11), failure/logging
  boundaries (Tasks 9–11), and migration relationship/status (Global Constraints
  and Task 12).
- [ ] Confirm the plan contains no unfinished markers, undefined task
  dependencies, or vague test language. Every task names files, consumed
  authorities, produced interfaces, failing command/expected failure, minimal
  implementation, passing command, and commit message.
- [ ] Confirm interfaces are consistent: Task 1 provides
  `WorkspaceGitAdministrationBinding`; Tasks 4 and 9 consume it; Task 2 provides
  Docker split mounts, the two-role `CodexSplitNetworkBinding`, route/process
  inspection, and persisted execution/control-egress network state; Tasks 4, 5,
  7, 9, and 11 consume them;
  Task 5 provides `CodexSplitTransportSecurity`; Tasks 6, 9, and 10 consume it;
  Task 8 provides `NativeCodexPty`; Tasks 9 and 11 consume it; Task 10 provides
  `evaluateCodexSplitOutcome()`; Task 11 consumes it.
- [ ] Confirm every network reference uses `network.execution` for the
  control-to-executor endpoint and `network.controlEgress` only for trusted
  control model/authentication egress. There are no singular network-name or
  network-ID fields or persisted single-network records; executor attachments
  are execution-only, control attachments are both roles, and neither role uses
  Docker's default bridge or publishes the exec-server.
- [ ] Confirm no task adds Web, Workbench, SQLite, browser session navigation,
  migration, generic arbitrary-CLI infrastructure, automatic worktrees, or
  structured-path retirement.
- [ ] Confirm no task weakens physical home absence, adds a local fallback,
  exposes Docker/Agent sockets, uses host namespaces, copies credentials, or
  treats network-only unauthenticated transport as production-ready.
- [ ] Confirm the control sidecar has model/API egress without becoming a router:
  no `NET_ADMIN`/equivalent capability, no IP forwarding, no forwarding/NAT/proxy
  process, and no executor route to the control-egress network, its gateway, the
  host, or unrelated services. If rootless Docker cannot provide and prove this
  two-network topology, the result is `BLOCKED/INCOMPLETE` and no migration is
  authorized.
- [ ] Confirm implementation starts from the commit containing this approved
  plan on `feat/codex-cli-split-execution-feasibility`, not from the approved
  spec-only commit and not from `fix/workbench-runtime-ai-truthfulness`.
- [ ] Confirm live evidence, not mocked tests, is required for every PASS and that
  security violation, incomplete proof, transport block, and operator abort are
  distinct outcomes.
