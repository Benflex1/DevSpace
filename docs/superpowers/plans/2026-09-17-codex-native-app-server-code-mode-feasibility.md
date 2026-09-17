# Codex Native App-Server Code Mode Feasibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove, with the exact admitted Codex `0.153.4`, that an unmodified native `codex` TUI and native `codex resume <NATIVE_SESSION_ID>` can use a native app-server in the credential-bearing control sidecar, a remote Code Mode host in the exact project executor, and remote project execution through `CODEX_EXEC_SERVER_URL`, without giving project-directed code any physical or logical path to the native Codex home.

**Architecture:** Extend the already-proven two-container split execution harness. The control sidecar owns the persistent Agent-private `CODEX_HOME`, native authentication, native app-server, TUI, sessions, history, and approvals. It attaches to the private execution network and the control-only egress network, but has no project worktree or Git mount. The exact-image project executor owns `/workspace`, narrowly required Git state, project tools, `codex exec-server`, and `codex-code-mode-host`; it attaches only to the private execution network and receives no native home, credentials, control state, Docker/Agent socket, or external route. The app-server connects to the executor's Code Mode gRPC endpoint while `CODEX_EXEC_SERVER_URL` independently routes nested project operations to the executor's exec-server. The experiment keeps the current structured app-server path shipped/default and does not add Web, Workbench, SQLite, migration, or product session integration.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, Zod, the existing Agent `DockerEngineClient` over the trusted rootless Docker socket, existing managed-workspace/runtime and Git-authority primitives, the staged exact Codex `0.153.4` artifact, native Codex app-server Unix transport, native `codex-code-mode-host` gRPC transport, Docker exec TTY/hijack/resize, and bounded redacted diagnostics.

**Spec:** `docs/superpowers/specs/2026-09-17-codex-native-app-server-code-mode-design.md`

## Global Constraints

- Implementation starts from the commit containing this approved plan on `feat/codex-cli-app-server-code-mode-feasibility`. It must not start from `origin/main`, the prior architecture-spec commit, `fix/workbench-runtime-ai-truthfulness`, or `feat/codex-cli-sidecar-feasibility`. The implementation branch must contain this plan before any runtime task begins.
- The admitted native artifact is exactly Codex `0.153.4`, unless a live gate records an exact-version incompatibility. A newer binary may not be substituted to make a test pass.
- Normal native TUI launches use exactly `[codex]`; native resume uses exactly `[codex, resume, NATIVE_SESSION_ID]`. The absolute staged launcher path is the executable implementation detail. No `-c`, `--enable`, `--disable`, `--profile`, `--remote`, `--strict-config`, `notify=[]`, or equivalent TUI launch override is permitted.
- The native app-server may receive its required app-server arguments, exactly `app-server --listen unix:// --code-mode-host http://codex-code-mode-host:<port>`. Those app-server arguments do not become TUI arguments and do not replace default-socket daemon reuse.
- Effective managed policy must enable Unified Exec, Code Mode, and Code Mode Host, and must set `disable_in_process_fallback = true`. Missing, stale, unreachable, or overridden remote endpoints fail closed.
- The control sidecar has a private persistent native home and no physical project worktree/Git mount. Its image-local `/workspace` is only a logical cwd and must contain no project bytes or Git state.
- The executor uses the exact running project's image identity, exact managed worktree, exact required Git administration state, and exact project toolchain. It is never replaced by a generic runner image.
- The executor attaches only to the internal/private execution network. The control sidecar attaches to the execution network plus the separate non-internal control-egress network. The control sidecar has no `NET_ADMIN`, forwarding, NAT, proxy, or relay capability. No executor Internet access or indirect route through control is introduced.
- Neither split workload receives a Docker socket, Agent socket, host namespace, host network, unrelated managed state, or native Codex home. The executor receives no Codex credential or native session state.
- All model-directed project execution must occur in the executor. There is no local execution fallback, local Code Mode host, local environment, program executor, shared unrelated daemon, danger/full-access mode, sandbox bypass, or unaudited local hook/MCP/helper path.
- Native Codex remains the authority for authentication, approvals, session IDs, history, and resume. DevSpace may validate provenance and liveness but may not synthesize conversation state, approvals, hidden prompt text, slash commands, or a DevSpace-specific resume command.
- Multiple distinct native sessions may run concurrently against one workspace. Only a proven duplicate live native-session identity is rejected.
- The model compatibility probe is test-only and consumes real model quota only after infrastructure readiness. It must stop on an approval request rather than approving automatically. It is not a product API or conversation wrapper.
- Mocks may prove type and failure behavior but can never produce a readiness or PASS result. `MODEL_REMOTE_COMPATIBLE`, `READY_FOR_OPERATOR_TUI`, and either passing feasibility outcome require bounded evidence from the real rootless Docker/native Codex path.
- Direct exec-server and Code Mode gRPC transport authentication are independently recorded. Private-network isolation is not protocol authentication. Without protocol authentication for both required transports, the maximum result is `PASS-WITH-TRANSPORT-BLOCK` and migration remains unauthorized.
- The existing structured implementation under `apps/agent/src/codex-app-server/` remains unchanged in authority and behavior. In particular, do not modify its credential lease, staging/writeback, JSONL provider, or Workbench integration for this experiment.
- Do not update `docs/current-state.md` as part of implementation before an actual live result. Do not add deployment, PR, merge, generic arbitrary-CLI support, automatic worktrees, or unrelated refactors.
- Every production behavior change follows RED/GREEN TDD, receives a focused commit, and is checked with the exact focused test, Agent typecheck, changed-file ESLint, and required repository gates.

---

## Existing Repository Map and Reuse Contract

Before Task 1, the implementing engineer must verify the following inspected primitives and preserve their ownership boundaries.

- Managed authority: `ManagedWorkspaces.executionContext(projectId, workspaceId)` resolves the owned running workspace/runtime context; `ManagedWorkspaces.codexExecutorGitBinding(projectId, workspaceId)` resolves the exact worktree, bare repository, and Git administration paths. The split experiment consumes these instead of reconstructing host paths.
- Runtime image authority: `WorkspaceRuntimeManager` is reached through the managed execution context and supplies the authoritative running development container/image identity, working directory, and runtime generation. `packages/project-options/src/runtime-plan.ts` remains the source for nullable image-default versus explicit `containerUser` semantics and is not changed.
- Native home authority: `apps/agent/src/codex-cli-split/native-home.ts` owns private per-workspace home identity, directory hardening, path validation, and the persisted native home. The new path is provider-owned native state; it does not use the structured provider's credential lease or temporary writeback.
- Docker authority: `apps/agent/src/docker-runtime.ts` supplies `DockerEngineClient`, rootless assertions, exact-image inspection, hardened split-container creation, `createExec`, `startExecAttached`, `resizeExec`, `inspectExec`, `topContainer`, and bounded Docker diagnostics. TTY/hijack behavior remains shared with the already-tested native PTY.
- Network authority: `apps/agent/src/codex-cli-split/network.ts` supplies the two-network `CodexSplitNetworkBinding`, exact member attachment checks, default-route policy, forwarding checks, and no-published-port assertions.
- Artifact authority: `apps/agent/src/codex-cli-split/artifact.ts` and `apps/agent/src/codex-app-server/artifact-identity.ts` resolve, stage/reuse, verify, and digest the exact Codex closure. The split experiment may extend capability verification but must not copy structured credentials or alter the generic structured provider.
- Existing split lifecycle: `project-executor.ts`, `exec-server.ts`, `control-sidecar.ts`, `transport.ts`, `remote-policy.ts`, `native-pty.ts`, `pty-harness.ts`, `session-provenance.ts`, `runtime-record.ts`, `split-runtime.ts`, `feasibility-result.ts`, and `feasibility-verifier.ts` are the reusable split units. Extend them with focused modules rather than creating a single replacement runtime module.
- Existing structured path: `apps/agent/src/codex-app-server/provider.ts`, `transport.ts`, and their tests remain the shipped/default structured app-server authority. New native app-server lifecycle code must not call that provider's lease or staging APIs.
- Existing verification: `apps/agent/test/verify-codex-cli-split-preflight.ts`, `verify-codex-cli-split-execution.ts`, and `verify-codex-cli-split-pty.ts` provide bounded opt-in entrypoints and must retain no-input safety. The new readiness levels are layered onto these entrypoints without opening a TUI before the real model probe succeeds.

## Target File Map

The following files are the planned ownership boundaries. A task may add a narrowly associated test fixture, but it may not move logic into a generic utility or modify Web/Workbench/SQLite files.

- Modify `apps/agent/src/codex-cli-split/remote-policy.ts` and `remote-policy.test.ts` for the effective Code Mode policy, default-daemon launch eligibility, exact TUI argv, and trusted global/project configuration proof.
- Modify `apps/agent/src/codex-cli-split/artifact.ts` and `artifact.test.ts`; consume `apps/agent/src/codex-app-server/artifact-identity.ts` as the read-only source of the already-resolved exact closure and do not change that structured identity module.
- Create `apps/agent/src/codex-cli-split/code-mode-host.ts` and `code-mode-host.test.ts` for the executor-side native gRPC host process, endpoint, readiness, and process-state lifecycle.
- Create `apps/agent/src/codex-cli-split/native-app-server.ts` and `native-app-server.test.ts` for the control-side native app-server command, default Unix socket, ownership, readiness, stale/foreign detection, and reattachment.
- Modify `apps/agent/src/codex-cli-split/project-executor.ts`, `project-executor.test.ts`, `split-runtime.ts`, `split-runtime.test.ts`, `runtime-record.ts`, and `runtime-record.test.ts` for the additional Code Mode host and app-server handles.
- Modify `apps/agent/src/codex-cli-split/native-pty.ts`, `native-pty.test.ts`, `session-provenance.ts`, and `session-provenance.test.ts` for exact bare/resume argv and native daemon/session provenance.
- Create `apps/agent/src/codex-cli-split/negative-policy.ts` and `negative-policy.test.ts` for pure final runtime admission predicates. This module owns no Docker lifecycle.
- Create `apps/agent/src/codex-cli-split/artifact-gc.ts` and `artifact-gc.test.ts` for bounded ownership-safe stale artifact collection.
- Modify `apps/agent/src/codex-cli-split/feasibility-result.ts`, `feasibility-result.test.ts`, `feasibility-verifier.ts`, and `feasibility-verifier.test.ts` for A-H evidence, infrastructure/model readiness states, and four-state outcome projection.
- Create the test-only `apps/agent/test/codex-native-app-server-probe.ts` and `codex-native-app-server-probe.test.ts` for the minimal native app-server protocol model probe. It must not be imported by product code.
- Modify `apps/agent/test/verify-codex-cli-split-preflight.ts`, create `apps/agent/test/verify-codex-cli-split-model.ts` for the explicit model-probe command, and modify `apps/agent/test/verify-codex-cli-split-execution.ts` for the infrastructure, model, and final human gates.
- Modify `apps/agent/package.json` only to register the explicit test-only `verify:codex:split:model` script; do not change existing structured scripts.

## Upstream 0.153.4 Source Anchors

The implementation worker must use the pinned `rust-v0.153.4` source already cited by the approved spec rather than current upstream behavior when validating these contracts.

- Model tool mode selection: `protocol/src/openai_models.rs` (`ToolMode` metadata), `core/src/tools/mod.rs` (model-to-tool selection), and `core/tests/suite/model_runtime_selectors.rs` (`CodeModeOnly` behavior).
- Code Mode configuration and provider choice: `core/src/config/config_tests.rs`, `core/src/thread_manager.rs`, `code-mode/src/remote_session.rs`, and `code-mode/src/remote_session/connection.rs`.
- Remote host startup and gRPC transport: `app-server/src/code_mode_host.rs`, `app-server/src/lib.rs`, `code-mode-host/src/main.rs`, `code-mode-host/src/transport.rs`, `code-mode-host/src/grpc_transport.rs`, and `code-mode-protocol/src/grpc/codex.code_mode.v1.proto`.
- Embedded Code Mode capability surface and callbacks: `code-mode-runtime/src/runtime/globals.rs`, `code-mode-runtime/src/runtime/module_loader.rs`, `code-mode-runtime/src/runtime/callbacks.rs`, `code-mode-runtime/src/v8_init.rs`, `core/src/code_mode/delegate.rs`, and `core/src/code_mode/mod.rs`.
- Nested tool and execution routing: `core/src/tools/handlers/exec_command.rs`, `core/src/tools/handlers/apply_patch.rs`, `core/src/agents_md.rs`, `core/src/environment_selection.rs`, and `exec-server/src/environment_provider.rs`.
- Native app-server transport/socket and TUI selection: `app-server-transport/src/transport/mod.rs`, `app-server-transport/src/transport/unix_socket.rs`, `tui/src/lib.rs`, and the exact app-server CLI options in `cli/src/main.rs`.
- Local escape surfaces that must remain rejected: `core/src/tasks/user_shell.rs`, `rmcp-client/src/stdio_server_launcher.rs`, `hooks/src/engine/command_runner.rs`, plugin maintenance paths, and program-executor configuration tests.

## Task 1: Enforce effective remote Code Mode policy and exact native argv

**Files:** Create — none. Modify — `apps/agent/src/codex-cli-split/remote-policy.ts`. Test — `apps/agent/src/codex-cli-split/remote-policy.test.ts`.

- [ ] **Test first — define the required effective configuration and launch contract.**
  - Modify `apps/agent/src/codex-cli-split/remote-policy.test.ts`.
  - Consume `prepareCodexManagedPolicy`, `buildRemoteOnlyConfiguration`, `assertForbiddenProjectConfiguration`, and the existing `CodexManagedPolicyBinding`/`CodexRemoteOnlyConfiguration` types.
  - Add RED cases proving the current policy is wrong because it emits `code_mode = false`, `code_mode_host = false`, retains `launchArguments: ["-c", "notify=[]"]`, and lacks `disable_in_process_fallback = true`.
  - Add RED cases for `buildNativeCodexArgv(null)` and `buildNativeCodexArgv("<valid UUID>")`, with expected exact logical argv `["codex"]` and `["codex", "resume", id]`; `-c`, `--remote`, profile, strict-config, enable, and disable variants must be rejected.
  - Add a RED effective-layer test with trusted/native config plus a project `.codex` layer attempting to enable local execution, hooks, local MCP, a program executor, danger mode, or another endpoint. Expected result is rejection rather than “project layer trusted.”
  - Add a RED test that a diagnostic command containing `-c notify=[]` does not count as default-daemon proof.
  - Run:
    `pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/remote-policy.test.ts`
  - Expected RED result: assertions fail for the old disabled Code Mode TOML, nonempty launch arguments, and missing effective-layer/argv enforcement.
- [ ] **Implement the smallest managed-policy change.**
  - Change `MANAGED_REQUIREMENTS_TOML` to the exact Codex `0.153.4` shape supported by the approved spec:
    ```toml
    [features]
    unified_exec = true

    [features.code_mode]
    enabled = true

    [features.code_mode_host]
    enabled = true
    disable_in_process_fallback = true
    ```
  - Replace the old `launchArguments` field with an explicit empty launch-override contract or remove it; no normal TUI configuration is carried in argv.
  - Produce these exact interfaces:
    ```ts
    export interface CodexCodeModeConfiguration {
      readonly enabled: true;
      readonly hostEnabled: true;
      readonly disableInProcessFallback: true;
      readonly remoteHostUrl: string;
    }

    export interface CodexRemoteOnlyConfiguration {
      readonly environmentId: "remote";
      readonly logicalCwd: "/workspace";
      readonly workspaceRoots: readonly ["/workspace"];
      readonly localEnvironmentAvailable: false;
      readonly unifiedExecRequired: true;
      readonly execServerUrl: string;
      readonly codeMode: CodexCodeModeConfiguration;
      readonly managedPolicy: CodexManagedPolicyBinding;
    }

    export function buildNativeCodexArgv(resumeSessionId: string | null): readonly string[];

    export function assertNativeCodexArgv(
      argv: readonly string[],
      expectedResumeSessionId: string | null,
    ): void;

    export interface CodexEffectivePolicyProof {
      readonly nativeConfig: "managed";
      readonly projectConfig: "cannot-override";
      readonly effective: CodexCodeModeConfiguration;
      readonly forbiddenLocalPaths: readonly CodexForbiddenLocalPath[];
    }

    export function assertEffectiveCodexPolicy(input: {
      readonly nativeConfigText: string;
      readonly projectConfigTexts: readonly string[];
      readonly expected: CodexCodeModeConfiguration;
    }): CodexEffectivePolicyProof;
    ```
  - Keep all existing forbidden paths and add explicit Code Mode host missing/stale, in-process fallback, and embedded-app-server/default-daemon violations. A project layer that cannot be proven lower trust must fail closed.
- [ ] **Run GREEN and the focused static/config regressions.**
  - Run the same focused Vitest command; expected result is green.
  - Run `pnpm --filter @devspace/agent run typecheck`.
  - Run `pnpm exec eslint apps/agent/src/codex-cli-split/remote-policy.ts apps/agent/src/codex-cli-split/remote-policy.test.ts --max-warnings 0`.
  - Self-check that no normal TUI code path can receive `-c notify=[]` or any other override.
- [ ] **Commit the task.**
  - `git add apps/agent/src/codex-cli-split/remote-policy.ts apps/agent/src/codex-cli-split/remote-policy.test.ts`
  - `git commit -m "feat(agent): enforce native Codex Code Mode policy"`

## Task 2: Verify the exact 0.153.4 artifact closure for both native services

**Files:** Create — none. Modify — `apps/agent/src/codex-cli-split/artifact.ts`. Test — `apps/agent/src/codex-cli-split/artifact.test.ts`. Read-only inputs — `apps/agent/src/codex-app-server/artifact-identity.ts` and its existing identity tests.

- [ ] **Test first — make service capability omissions fail.**
  - Modify `apps/agent/src/codex-cli-split/artifact.test.ts`; use the existing artifact-identity fixture shape without changing the structured artifact-identity module.
  - Consume `prepareCodexSplitArtifact`, `assertCodexArtifactCompatibleWithImage`, `resolveCodexExecutionArtifact`, `stageCodexExecutionArtifact`, and `verifyStagedCodexExecutionArtifact`.
  - Add RED fixtures for an artifact that has the native CLI/exec-server but lacks the exact `codex-code-mode-host` closure entry, and for an artifact whose helper path exists but whose closure digest does not match the staged manifest.
  - Add a RED fixture proving a generic runner executable or a helper copied from another Codex version is rejected.
  - Add a passing-shape test that records the exact native CLI path, exact `codex-code-mode-host` path, `app-server` capability, `exec-server` capability, and closure digest without recording credentials.
  - Run:
    `pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/artifact.test.ts`
  - Expected RED result: the current binding does not prove all three service capabilities as one exact immutable closure.
- [ ] **Implement the capability extension using existing artifact identity.**
  - Extend `CodexSplitArtifactBinding` with an exact capability record, without changing staging ownership:
    ```ts
    export interface CodexSplitArtifactCapabilities {
      readonly nativeCliPath: string;
      readonly execServerCapability: "codex-0.153.4-exec-server";
      readonly appServerCapability: "codex-0.153.4-app-server";
      readonly codeModeHostPath: string;
      readonly codeModeHostCapability: "codex-0.153.4-code-mode-host";
      readonly closureDigest: string;
    }
    ```
  - Produce `assertCodexSplitArtifactCapabilities(artifact, image)` that validates exact version/OS/architecture, the existing staged closure digest, the native CLI, and the native Code Mode host helper. The app-server uses the same exact native CLI closure; do not invent a second binary or generic runner.
  - Expose the capability check with this signature:
    ```ts
    export function assertCodexSplitArtifactCapabilities(input: {
      readonly artifact: CodexSplitArtifactBinding;
      readonly image: DockerImageInspection;
    }): CodexSplitArtifactCapabilities;
    ```
  - Reuse artifact identity/staging and reuse an existing verified closure. Inject it read-only into the exact project image only when inspection proves the image cannot run the verified closure in place. Record the injected paths and digest in the policy.
  - Reject incompatible exact images; never switch images and never copy home/credentials.
- [ ] **Run GREEN.**
  - Run `pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/artifact.test.ts`.
  - Run `pnpm --filter @devspace/agent run typecheck`.
  - Run `pnpm exec eslint apps/agent/src/codex-cli-split/artifact.ts apps/agent/src/codex-cli-split/artifact.test.ts --max-warnings 0`.
- [ ] **Commit the task.**
  - `git add apps/agent/src/codex-cli-split/artifact.ts apps/agent/src/codex-cli-split/artifact.test.ts`
  - `git commit -m "feat(agent): verify Codex split capability closure"`

## Task 3: Add the executor-side native Code Mode host lifecycle

**Files:** Create — `apps/agent/src/codex-cli-split/code-mode-host.ts`, `apps/agent/src/codex-cli-split/code-mode-host.test.ts`. Modify — `apps/agent/src/codex-cli-split/project-executor.ts` only for the explicit Code Mode endpoint/policy fields. Test — `apps/agent/src/codex-cli-split/project-executor.test.ts` for executor-policy integration and `code-mode-host.test.ts` for service lifecycle.

- [ ] **Test first — specify a separate gRPC service and exact executor policy.**
  - Create `apps/agent/src/codex-cli-split/code-mode-host.test.ts` before `code-mode-host.ts`.
  - Consume `CodexProjectExecutorPolicy`, `CodexSplitArtifactBinding`, `DockerEngineClient.createExec`, `startExecAttached`, `inspectExec`, `topContainer`, and the existing execution-network binding.
  - Define the produced boundary:
    ```ts
    export interface CodexCodeModeHostEndpoint {
      readonly host: "codex-code-mode-host";
      readonly port: number;
      readonly url: string;
      readonly listenUrl: string;
      readonly networkId: string;
    }

    export interface CodexCodeModeHostPolicy {
      readonly executorContainerId: string;
      readonly artifact: CodexSplitArtifactCapabilities;
      readonly endpoint: CodexCodeModeHostEndpoint;
      readonly command: readonly [string, "--listen", string];
      readonly environment: Readonly<Record<string, string>>;
      readonly workingDirectory: "/workspace";
      readonly credentialsPresent: false;
      readonly controlEgressAttached: false;
    }

    export interface CodexCodeModeHostHandle {
      readonly executorContainerId: string;
      readonly execId: string;
      readonly endpoint: CodexCodeModeHostEndpoint;
      readonly serverPid: number;
      readonly transportSecurity: "protocol-authenticated" | "private-network-only";
    }

    export async function startCodexCodeModeHost(input: {
      readonly docker: DockerEngineClient;
      readonly policy: CodexCodeModeHostPolicy;
    }): Promise<CodexCodeModeHostHandle>;

    export async function probeCodexCodeModeHostReady(input: {
      readonly docker: DockerEngineClient;
      readonly handle: CodexCodeModeHostHandle;
      readonly deadlineMs: number;
      readonly pollIntervalMs: number;
    }): Promise<void>;

    export async function assertCodexCodeModeHostReady(input: {
      readonly docker: DockerEngineClient;
      readonly handle: CodexCodeModeHostHandle;
      readonly policy: CodexCodeModeHostPolicy;
    }): Promise<void>;

    export async function reattachCodexCodeModeHost(input: {
      readonly docker: DockerEngineClient;
      readonly handle: CodexCodeModeHostHandle;
      readonly policy: CodexCodeModeHostPolicy;
    }): Promise<void>;
    ```
  - Add RED tests for missing helper, wrong image, wrong network, credentials in the environment/mounts, control-egress attachment, malformed listener, wrong PID/container, nonzero exit, readiness timeout, and separate handling of exec-server versus Code Mode host readiness.
  - Add a deterministic fake readiness probe test that accepts a transient unavailable listener then succeeds, and a test that never treats exec-server `/readyz` as Code Mode host readiness.
  - Run:
    `pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/code-mode-host.test.ts`
  - Expected RED result: the module does not exist and the current executor only models the exec-server service.
- [ ] **Implement the narrow native host process.**
  - Create `code-mode-host.ts` with a fixed private execution-network listener and the exact `0.153.4` native helper command confirmed from the staged artifact/source. The implementation must fail closed if the helper does not expose the required listener form; it may not fall back to a Node/HTTP/generic runner.
  - Use a separate port and endpoint from the exec-server. The app-server URL is `http://codex-code-mode-host:<port>` while the helper's native gRPC listener uses its exact accepted listen scheme. No host port is published.
  - Start and inspect the helper inside the already-created exact executor. Validate exact exec ID/container ID, positive PID, `Running=true`, `ExitCode=null`, exact execution-network attachment, and no external route. Readiness must use the native gRPC health/readiness behavior, not merely TCP connect or exec-server `/readyz`, and must use bounded polling.
  - Drain/discard service output with existing bounded stream handling; never return raw protocol or environment content.
  - Set the transport classification independently from `CodexExecServerHandle`; lack of protocol auth is recorded as `private-network-only`.
- [ ] **Run GREEN and focused policy tests.**
  - Run the focused Code Mode host command.
  - Run `pnpm --filter @devspace/agent run typecheck`.
  - Run `pnpm exec eslint apps/agent/src/codex-cli-split/code-mode-host.ts apps/agent/src/codex-cli-split/code-mode-host.test.ts --max-warnings 0`.
- [ ] **Commit the task.**
  - `git add apps/agent/src/codex-cli-split/code-mode-host.ts apps/agent/src/codex-cli-split/code-mode-host.test.ts`
  - `git commit -m "feat(agent): run Codex split Code Mode host"`

## Task 4: Own the native app-server and default Unix socket in the control sidecar

**Files:** Create — `apps/agent/src/codex-cli-split/native-app-server.ts`, `apps/agent/src/codex-cli-split/native-app-server.test.ts`. Modify — `apps/agent/src/codex-cli-split/control-sidecar.ts` only for the app-server-owned control policy fields. Test — `apps/agent/src/codex-cli-split/control-sidecar.test.ts` for control-policy integration and `native-app-server.test.ts` for socket/process lifecycle.

- [ ] **Test first — model socket ownership and daemon lifecycle.**
  - Create `apps/agent/src/codex-cli-split/native-app-server.test.ts` before `native-app-server.ts`.
  - Consume `CodexControlSidecarPolicy`, `CodexSplitArtifactCapabilities`, `CodexCodeModeHostEndpoint`, `ensureNativeCodexHome`, `nativeCodexHomePath`, `DockerEngineClient.createExec`, `startExecAttached`, `inspectExec`, and the existing bounded process-observation helpers.
  - Define the produced boundary:
    ```ts
    export interface CodexNativeAppServerPolicy {
      readonly controlContainerId: string;
      readonly executablePath: string;
      readonly command: readonly [string, "app-server", "--listen", "unix://", "--code-mode-host", string];
      readonly socketPath: "/codex-home/app-server-control/app-server-control.sock";
      readonly codeModeHostUrl: string;
      readonly environment: Readonly<Record<string, string>>;
      readonly workingDirectory: "/workspace";
      readonly homeIdentity: string;
      readonly projectMounts: readonly [];
      readonly gitMounts: readonly [];
    }

    export interface CodexNativeAppServerHandle {
      readonly controlContainerId: string;
      readonly execId: string;
      readonly serverPid: number;
      readonly socketPath: "/codex-home/app-server-control/app-server-control.sock";
      readonly homeIdentity: string;
      readonly codeModeHostUrl: string;
      readonly transportSecurity: "protocol-authenticated" | "private-network-only";
    }

    export function buildCodexNativeAppServerPolicy(input: {
      readonly control: CodexControlSidecarPolicy;
      readonly artifact: CodexSplitArtifactCapabilities;
      readonly codeModeHost: CodexCodeModeHostEndpoint;
    }): CodexNativeAppServerPolicy;

    export async function startCodexNativeAppServer(input: {
      readonly docker: DockerEngineClient;
      readonly policy: CodexNativeAppServerPolicy;
    }): Promise<CodexNativeAppServerHandle>;

    export async function assertCodexNativeAppServerReady(input: {
      readonly docker: DockerEngineClient;
      readonly handle: CodexNativeAppServerHandle;
      readonly deadlineMs: number;
      readonly pollIntervalMs: number;
    }): Promise<void>;

    export async function reattachCodexNativeAppServer(input: {
      readonly docker: DockerEngineClient;
      readonly handle: CodexNativeAppServerHandle;
      readonly policy: CodexNativeAppServerPolicy;
    }): Promise<void>;
    ```
  - Add RED tests for the exact app-server command, exact socket path, private home ownership, no project/Git mounts, remote Code Mode URL, missing host, wrong home identity, foreign socket, stale socket with a live owner, stale socket with no owner, app-server exit, readiness timeout, and control-side unauthorized local Code Mode provider.
  - Add tests proving the live correctly-owned socket is reused, while an unknown/foreign socket is rejected and a provably stale socket is removed only within the exact home identity.
  - Run:
    `pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/native-app-server.test.ts`
  - Expected RED result: the native split runtime has no app-server process/socket lifecycle and no default-socket ownership assertions.
- [ ] **Implement the control-side native app-server lifecycle.**
  - Create `native-app-server.ts`. Start the native artifact in the control container with the exact app-server command `codex app-server --listen unix:// --code-mode-host http://codex-code-mode-host:<port>`. The TUI command remains separate and has no CLI overrides.
  - Prepare the home-scoped `app-server-control` directory through the existing private-home hardening. Require restrictive ownership/permissions and record only the logical socket path and home identity, never the host path or socket contents.
  - Before start, classify the socket as absent, live-owned, provably stale-owned, or foreign/ambiguous. Reuse only a live app-server whose process/container/home identity and Code Mode endpoint match; remove only a provably stale socket under the same owned home. Foreign or ambiguous state fails closed.
  - Observe the app-server exec with exact container/exec identity, positive PID, running state, and bounded socket readiness. Keep service output bounded and redacted. Do not mount `/workspace` or Git into control.
  - Reattach only after process provenance, socket identity, home identity, Code Mode endpoint, and executor generation all match.
- [ ] **Run GREEN.**
  - Run the focused native app-server command.
  - Run `pnpm --filter @devspace/agent run typecheck`.
  - Run `pnpm exec eslint apps/agent/src/codex-cli-split/native-app-server.ts apps/agent/src/codex-cli-split/native-app-server.test.ts --max-warnings 0`.
- [ ] **Commit the task.**
  - `git add apps/agent/src/codex-cli-split/native-app-server.ts apps/agent/src/codex-cli-split/native-app-server.test.ts`
  - `git commit -m "feat(agent): own native Codex app-server socket"`

## Task 5: Extend split assembly, runtime records, and reattach validation

**Files:** Create — none. Modify — `apps/agent/src/codex-cli-split/runtime-record.ts`, `apps/agent/src/codex-cli-split/split-runtime.ts`. Test — `apps/agent/src/codex-cli-split/runtime-record.test.ts`, `apps/agent/src/codex-cli-split/split-runtime.test.ts`.

- [ ] **Test first — require both service handles in current state.**
  - Modify `apps/agent/src/codex-cli-split/runtime-record.test.ts` and `split-runtime.test.ts`.
  - Consume `CodexSplitRuntimeAssembly`, `CodexSplitRuntime.ensure`, `recordFromAssembly`, `parseCodexSplitRuntimeRecord`, `endpointFromRecord`, `reattachAssembly`, and the existing exact context/Git/network/home validation.
  - Add RED round-trip coverage for a current assembly containing `CodexExecServerHandle`, `CodexCodeModeHostHandle`, and `CodexNativeAppServerHandle`; persist with the real current record builder, parse, reconstruct endpoints, and reassert every security-relevant field.
  - Add RED tests proving an old bare-TUI record without Code Mode/app-server fields, a stale generation, a changed image/worktree, a missing executor service, a foreign socket, or a changed home identity is rejected and cannot be silently attached.
  - Add RED tests for two distinct live native sessions in one record and for duplicate live resume of the same native ID; the former must remain allowed and the latter must fail only with proven identity/liveness.
  - Run:
    `pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/runtime-record.test.ts apps/agent/src/codex-cli-split/split-runtime.test.ts`
  - Expected RED result: current records persist only exec-server/control data and cannot reconstruct the app-server/Code Mode topology without undefined or omitted security fields.
- [ ] **Implement strict current-record and lifecycle composition.**
  - Advance the split runtime record schema to a current version that explicitly contains:
    - execution and control-egress network IDs/names/roles;
    - exact artifact closure digest/capabilities;
    - executor image/worktree/Git identities;
    - exec-server endpoint and transport classification;
    - Code Mode host endpoint, exec ID/PID, container ID, and transport classification;
    - control container ID, home identity, app-server exec ID/PID, logical socket path, and Code Mode URL;
    - runtime generation and native session provenance.
  - Keep parsing strict. Treat older experimental records as incompatible, validate their ownership before narrowly cleaning/rebuilding resources for the same exact workspace/generation, and never accept a partial record as current. Preserve bounded resource references for cleanup without storing secrets, transcripts, or host home paths.
  - Produce the exact assembly extension:
    ```ts
    export interface CodexSplitRuntimeAssembly {
      readonly home: CodexNativeHomeBinding;
      readonly artifact: CodexSplitArtifactBinding;
      readonly network: CodexSplitNetworkBinding;
      readonly executor: CodexProjectExecutorBinding;
      readonly transport: CodexSplitTransportBinding;
      readonly server: CodexExecServerHandle;
      readonly codeModeHost: CodexCodeModeHostHandle;
      readonly appServer: CodexNativeAppServerHandle;
      readonly remote: CodexRemoteOnlyConfiguration;
      readonly control: CodexControlSidecarBinding;
    }
    ```
  - Update `buildDefaultAssembly` ordering to: resolve authoritative context/home/artifact/networks; create exact executor; start and ready exec-server; start and ready Code Mode host; build/evaluate managed policy; create/inspect control; start/ready native app-server; persist record; only then permit TUI PTY creation.
  - Update reattach/reconciliation to validate both executor services, the app-server socket/process, endpoint security classifications, generation, home, image, worktree, and network topology before any TUI or model operation.
  - Stop dependencies in reverse order and preserve native home/session history. Executor recreation is allowed only within the same valid runtime generation and must recreate both private execution services.
- [ ] **Run GREEN.**
  - Run the focused runtime-record/split-runtime command.
  - Run `pnpm --filter @devspace/agent run typecheck`.
  - Run `pnpm exec eslint apps/agent/src/codex-cli-split/runtime-record.ts apps/agent/src/codex-cli-split/runtime-record.test.ts apps/agent/src/codex-cli-split/split-runtime.ts apps/agent/src/codex-cli-split/split-runtime.test.ts --max-warnings 0`.
- [ ] **Commit the task.**
  - `git add apps/agent/src/codex-cli-split/runtime-record.ts apps/agent/src/codex-cli-split/runtime-record.test.ts apps/agent/src/codex-cli-split/split-runtime.ts apps/agent/src/codex-cli-split/split-runtime.test.ts`
  - `git commit -m "feat(agent): persist split app-server runtime"`

## Task 6: Require native default-daemon TUI attachment and exact resume argv

**Files:** Create — none. Modify — `apps/agent/src/codex-cli-split/native-pty.ts`, `apps/agent/src/codex-cli-split/session-provenance.ts`, and `apps/agent/src/codex-cli-split/pty-harness.ts` only for shared launch evidence. Test — `apps/agent/src/codex-cli-split/native-pty.test.ts`, `apps/agent/src/codex-cli-split/session-provenance.test.ts`, and `pty-harness.test.ts` when harness evidence changes.

- [ ] **Test first — reject embedded-daemon and override paths.**
  - Modify `apps/agent/src/codex-cli-split/native-pty.test.ts` and `session-provenance.test.ts`.
  - Consume `startNativeCodexPty`, `CodexSplitRuntime.startNewSession`, `CodexSplitRuntime.startResume`, `buildNativeCodexArgv`, `assertNativeCodexArgv`, `snapshotNativeSessionState`, and `discoverNativeSession`.
  - Add RED tests proving new-session argv is exactly `[codex]`, resume argv is exactly `[codex, resume, id]`, and any `-c notify=[]`, `--remote`, profile, strict-config, enable, or disable argument is rejected.
  - Add RED lifecycle tests proving the TUI is admitted only with a live owned app-server socket/process, no second embedded app-server process, the expected home identity, and the expected Code Mode/exec endpoints. A diagnostic `-c notify=[]` launch must not satisfy this evidence.
  - Add RED tests for passive session ID discovery from provider-owned state, exact unqualified resume, unknown/stale executor during resume, duplicate live resume, two distinct concurrent sessions, and no synthesized session record.
  - Run:
    `pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/native-pty.test.ts apps/agent/src/codex-cli-split/session-provenance.test.ts`
  - Expected RED result: the existing split PTY path still allows the old launch override and has no owned default app-server admission proof.
- [ ] **Implement the native attachment boundary.**
  - Route `CodexSplitRuntime.startNewSession()` through `buildNativeCodexArgv(null)` and `startResume()` through `buildNativeCodexArgv(nativeSessionId)`. The Docker exec command may use the absolute staged launcher but must normalize/evidence the logical argv as `[codex]` or `[codex, resume, id]`.
  - Require app-server readiness and socket/process provenance immediately before TUI exec creation. Observe the control container process list and app-server exec identity to reject an embedded/alternate app-server. Do not infer daemon selection from model output.
  - Keep PTY bytes, resize, input, approvals, session history, and resume native. The agent only passively observes bounded native session identity/provenance and refuses duplicate live identity.
- [ ] **Run GREEN.**
  - Run the focused native PTY/session command.
  - Run `pnpm --filter @devspace/agent run typecheck`.
  - Run `pnpm exec eslint apps/agent/src/codex-cli-split/native-pty.ts apps/agent/src/codex-cli-split/native-pty.test.ts apps/agent/src/codex-cli-split/session-provenance.ts apps/agent/src/codex-cli-split/session-provenance.test.ts --max-warnings 0`.
- [ ] **Commit the task.**
  - `git add apps/agent/src/codex-cli-split/native-pty.ts apps/agent/src/codex-cli-split/native-pty.test.ts apps/agent/src/codex-cli-split/session-provenance.ts apps/agent/src/codex-cli-split/session-provenance.test.ts`
  - `git commit -m "feat(agent): require native Codex daemon reuse"`

## Task 7: Enforce runtime fail-closed and adversarial configuration admission

**Files:** Create — `apps/agent/src/codex-cli-split/negative-policy.ts`, `apps/agent/src/codex-cli-split/negative-policy.test.ts`. Modify — `apps/agent/src/codex-cli-split/remote-policy.ts`, `control-sidecar.ts`, `project-executor.ts`, and `split-runtime.ts` only for their final admission checks. Test — `remote-policy.test.ts`, `control-sidecar.test.ts`, `project-executor.test.ts`, `split-runtime.test.ts`, and `negative-policy.test.ts`.

- [ ] **Test first — prove every local escape is rejected after layer loading.**
  - Modify `apps/agent/src/codex-cli-split/remote-policy.test.ts`, `control-sidecar.test.ts`, `project-executor.test.ts`, and `split-runtime.test.ts`; create `negative-policy.test.ts` before `negative-policy.ts`.
  - Consume `assertEffectiveCodexPolicy`, `assertCodexControlSidecarInspection`, `assertCodexProjectExecutorInspection`, `assertCodexExecServerReady`, `assertCodexCodeModeHostReady`, `assertCodexNativeAppServerReady`, and the strict runtime assembly/reattach functions.
  - Add tests with both native/global configuration and project-controlled configuration attempting to re-enable local environment, `/shell`, hooks, legacy notify, local MCP stdio, local HTTP/helper execution, unsafe plugin maintenance, program executor, shared daemon, danger/full-access, sandbox bypass, missing/stale Code Mode host, missing/stale exec-server, alternate endpoint, and remote-to-local fallback.
  - Add tests proving `unified_exec=false`, `disable_in_process_fallback=false`, `code_mode_host=false`, missing `CODEX_EXEC_SERVER_URL`, an embedded/local Code Mode provider, or a stale app-server socket fails before TUI/model admission.
  - Add runtime failure tests showing executor loss, Code Mode host loss, exec-server loss, and control/app-server loss return a bounded fail-closed error without spawning any control-side project process.
  - Run:
    `pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/remote-policy.test.ts apps/agent/src/codex-cli-split/control-sidecar.test.ts apps/agent/src/codex-cli-split/project-executor.test.ts apps/agent/src/codex-cli-split/split-runtime.test.ts`
  - Expected RED result: preflight-only checks do not yet prove the final effective configuration and some runtime absence/fallback cases are not an explicit admission failure.
- [ ] **Implement narrow admission predicates and runtime checks.**
  - Create `negative-policy.ts` with these exact pure interfaces:
    ```ts
    export type CodexSplitForbiddenLocalPath =
      | "local-environment"
      | "shell"
      | "command-hook"
      | "legacy-notify"
      | "local-mcp-stdio"
      | "local-http-helper"
      | "unsafe-plugin-maintenance"
      | "program-executor"
      | "shared-app-server-daemon"
      | "danger-full-access"
      | "sandbox-bypass"
      | "remote-local-fallback";

    export interface CodexSplitRemoteAdmissionInput {
      readonly effectivePolicy: CodexEffectivePolicyProof;
      readonly execServer: CodexExecServerHandle | null;
      readonly codeModeHost: CodexCodeModeHostHandle | null;
      readonly appServer: CodexNativeAppServerHandle | null;
      readonly forbiddenPaths: readonly CodexSplitForbiddenLocalPath[];
      readonly localEnvironmentAvailable: false;
    }

    export function assertCodexSplitRemoteAdmission(
      input: CodexSplitRemoteAdmissionInput,
    ): void;
    ```
  - Make each forbidden path and missing/stale service an explicit stable rejection. The pure predicate must not launch a process, inspect a socket, or mutate state; Docker/socket evidence remains supplied by the owning lifecycle modules.
  - Enforce the trusted managed requirements after native/global and project layers are loaded, using the exact `0.153.4` precedence/config mechanism. If the binary cannot prevent a project layer from overriding a mandatory rule, return `BLOCKED/INCOMPLETE` and do not trust the project.
  - Reject local provider selection and all forbidden path indicators at the final effective-configuration boundary. Require both remote endpoints and both service handles for every model/TUI admission.
  - Ensure all executor failure paths terminate or invalidate the assembly before a local retry. No error handler may call a local shell, local Code Mode provider, local MCP, local hook, or embedded app-server as fallback.
  - Keep controls in the split workloads: no Code Mode host in control, no executor control-egress attachment, no Docker/Agent socket, no host namespace, no network forwarding/NAT/proxy.
- [ ] **Run GREEN.**
  - Run the focused command above.
  - Run `pnpm --filter @devspace/agent run typecheck`.
  - Run changed-file ESLint over every modified file in this task.
- [ ] **Commit the task.**
  - `git add apps/agent/src/codex-cli-split/negative-policy.ts apps/agent/src/codex-cli-split/negative-policy.test.ts apps/agent/src/codex-cli-split/remote-policy.ts apps/agent/src/codex-cli-split/remote-policy.test.ts apps/agent/src/codex-cli-split/control-sidecar.ts apps/agent/src/codex-cli-split/control-sidecar.test.ts apps/agent/src/codex-cli-split/project-executor.ts apps/agent/src/codex-cli-split/project-executor.test.ts apps/agent/src/codex-cli-split/split-runtime.ts apps/agent/src/codex-cli-split/split-runtime.test.ts`
  - `git commit -m "feat(agent): fail closed on split Code Mode fallbacks"`

## Task 8: Add ownership-safe stale Codex artifact collection

**Files:** Create — `apps/agent/src/codex-cli-split/artifact-gc.ts`, `apps/agent/src/codex-cli-split/artifact-gc.test.ts`. Modify — `apps/agent/src/codex-cli-split/split-runtime.ts` for the post-reconciliation invocation. Test — `artifact-gc.test.ts`, `split-runtime.test.ts`.

- [ ] **Test first — protect every live or referenced closure.**
  - Create `apps/agent/src/codex-cli-split/artifact-gc.test.ts` before `artifact-gc.ts`.
  - Consume existing `CodexSplitArtifactBinding`, artifact staging/reuse, strict runtime-record parsing, owned container/resource reference parsing, and private-state identity helpers.
  - Add RED tests for the 51 historical duplicate staging directories, an active running-container reference, a valid persisted-record reference, the currently admitted reusable closure, a stale owned closure, a foreign directory, a symlink/path mismatch, and a malformed directory name.
  - Expected behavior: active/referenced/admitted/foreign/malformed entries remain; only an ownership-verified stale split artifact under the managed artifact root is eligible for bounded removal.
  - Run:
    `pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/artifact-gc.test.ts`
  - Expected RED result: no focused split artifact GC module exists.
- [ ] **Implement bounded non-critical GC.**
  - Produce:
    ```ts
    export interface CodexSplitArtifactGcReport {
      readonly scanned: number;
      readonly retained: number;
      readonly removed: number;
      readonly skipped: number;
    }

    export async function collectStaleCodexSplitArtifacts(input: {
      readonly managedArtifactRoot: string;
      readonly workspaceId: string;
      readonly currentClosureDigest: string;
      readonly activeRuntimeRecords: readonly CodexSplitRuntimeRecord[];
      readonly activeOwnedContainerIds: readonly string[];
      readonly nowMs: number;
      readonly maxAgeMs: number;
    }): Promise<CodexSplitArtifactGcReport>;
    ```
  - Verify canonical path, private-state identity, ownership labels, digest, exact workspace scope, and references before removal. Never delete a directory referenced by a running owned container, valid record, or current reusable closure. Use the existing safe filesystem deletion primitive, bounded diagnostics, and no recursive broad-root deletion.
  - Invoke GC from `CodexSplitRuntime.reconcileAfterAgentRestart` only after runtime ownership and reattachment succeed; it must not be required for the critical Code Mode proof. A GC failure is reported as bounded maintenance evidence after the valid runtime remains available, while an ownership ambiguity retains the artifact.
- [ ] **Run GREEN.**
  - Run the focused artifact GC command.
  - Run `pnpm --filter @devspace/agent run typecheck` and changed-file ESLint.
- [ ] **Commit the task.**
  - `git add apps/agent/src/codex-cli-split/artifact-gc.ts apps/agent/src/codex-cli-split/artifact-gc.test.ts apps/agent/src/codex-cli-split/split-runtime.ts apps/agent/src/codex-cli-split/split-runtime.test.ts`
  - `git commit -m "feat(agent): collect stale Codex split artifacts"`

## Task 9: Extend feasibility evidence to A-H and readiness levels

**Files:** Create — none. Modify — `apps/agent/src/codex-cli-split/feasibility-result.ts`, `apps/agent/src/codex-cli-split/feasibility-verifier.ts`. Test — `apps/agent/src/codex-cli-split/feasibility-result.test.ts`, `apps/agent/src/codex-cli-split/feasibility-verifier.test.ts`.

- [ ] **Test first — prevent incomplete evidence from becoming PASS.**
  - Modify `apps/agent/src/codex-cli-split/feasibility-result.test.ts` and `feasibility-verifier.test.ts`.
  - Consume `CodexSplitGateEvidence`, `CodexSplitLiveEvidence`, `evaluateCodexSplitOutcome`, the existing strict base/live schema projection, and bounded diagnostic/result helpers.
  - Add RED tests for explicit A-H gate records:
    - A native TUI/app-server authority and exact default-daemon argv;
    - B exact executor/project environment;
    - C real Astra `CodeModeOnly` remote execution;
    - D home/credential/network/process separation;
    - E native persistence and exact unqualified resume;
    - F local fallback/escape rejection;
    - G separate exec-server/Code Mode transport classification;
    - H restart/concurrency/ownership.
  - Add tests for readiness states `INFRASTRUCTURE_READY`, `MODEL_REMOTE_COMPATIBLE`, `READY_FOR_OPERATOR_TUI`, and `BLOCKED/INCOMPLETE`.
  - Add tests proving missing, null, or unproven observations are not converted to `false` security failures or `true` proofs; incomplete network probes remain explicitly incomplete.
  - Add tests proving unit/mocked evidence cannot set the real model proof or operator proof and cannot yield PASS/PASS-WITH-TRANSPORT-BLOCK.
  - Add tests preserving exact outcome rules: PASS requires both authenticated transports; private-only transport yields at most PASS-WITH-TRANSPORT-BLOCK; disproven invariant yields FAIL; missing proof/operator abort/environment incompatibility yields BLOCKED/INCOMPLETE.
  - Run:
    `pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/feasibility-result.test.ts apps/agent/src/codex-cli-split/feasibility-verifier.test.ts`
  - Expected RED result: current evidence model has A-F assumptions and no separate real model/readiness proof required for the new composition.
- [ ] **Implement strict evidence and result projection.**
  - Extend the strict base schema with explicit A-H fields and separate transport details:
    ```ts
    export type CodexSplitReadinessState =
      | "INFRASTRUCTURE_READY"
      | "MODEL_REMOTE_COMPATIBLE"
      | "READY_FOR_OPERATOR_TUI"
      | "BLOCKED/INCOMPLETE";

    export interface CodexSplitTransportEvidence {
      readonly execServer: "protocol-authenticated" | "private-network-only" | "unproven";
      readonly codeModeHost: "protocol-authenticated" | "private-network-only" | "unproven";
    }

    export interface CodexSplitModelCompatibilityProof {
      readonly provenance: "real-native-app-server";
      readonly model: "gpt-6-astra";
      readonly toolMode: "CodeModeOnly";
      readonly codeModeProvider: "remote-grpc";
      readonly codeModeHostContainerId: string;
      readonly execServerContainerId: string;
      readonly logicalCwd: "/workspace";
      readonly controlProjectProcessCount: 0;
      readonly executorProjectProcessCount: number;
      readonly codeModeHostProcessObserved: true;
      readonly execServerProcessObserved: true;
      readonly nestedProjectExecObserved: true;
      readonly operationCompleted: true;
      readonly executorHasNativeHome: false;
    }
    ```
  - Keep known live-only fields explicitly modeled by the live schema and project only the base semantics into `evaluateCodexSplitOutcome`; reject arbitrary unknown properties at the applicable boundary.
  - Require `realModelProof.provenance === "real-native-app-server"` and `liveOperatorProof.provenance === "real-native-tui"` before either pass state. Treat unobserved/unknown as incomplete, never as success or definitive failure.
- [ ] **Run GREEN.**
  - Run the focused result/verifier command.
  - Run `pnpm --filter @devspace/agent run typecheck` and changed-file ESLint.
- [ ] **Commit the task.**
  - `git add apps/agent/src/codex-cli-split/feasibility-result.ts apps/agent/src/codex-cli-split/feasibility-result.test.ts apps/agent/src/codex-cli-split/feasibility-verifier.ts apps/agent/src/codex-cli-split/feasibility-verifier.test.ts`
  - `git commit -m "feat(agent): model native Code Mode feasibility outcomes"`

## Task 10: Build the real noninteractive infrastructure preflight

**Files:** Create — none. Modify — `apps/agent/src/codex-cli-split/feasibility-verifier.ts`, `apps/agent/test/verify-codex-cli-split-preflight.ts`. Test — `apps/agent/src/codex-cli-split/feasibility-verifier.test.ts` and the script's existing no-input test coverage.

- [ ] **Test first — require all automated dependencies before readiness.**
  - Modify `apps/agent/src/codex-cli-split/feasibility-verifier.test.ts` and `apps/agent/test/verify-codex-cli-split-preflight.ts`.
  - Consume `CodexSplitVerifyConfiguration`, `runCodexSplitFeasibilityPreflight`, `CodexSplitRuntime.ensure`, `CodexSplitRuntime.reconcileAfterAgentRestart`, `CodexSplitPtyProof`, all split inspection helpers, and the strict readiness/result types from Task 9.
  - Add RED tests for missing explicit opt-in environment, wrong Codex version, stale record/resource cleanup, missing Code Mode host, absent app-server socket, incomplete network observation, and a fake/mocked Docker source attempting to report `INFRASTRUCTURE_READY`.
  - Add a real-harness sequencing test that records the required pre-TUI phases in order: exact artifact, home, managed context/Git, both networks, executor, both executor services, remote policy, control, native app-server/socket, record write/read, reattach, PTY smoke, process/mount/network/security probes, and cleanup/reconciliation.
  - Add a no-input test proving the command exits boundedly without TUI, login, approval, prompt, slash command, resume, or model request.
  - Run:
    `pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/feasibility-verifier.test.ts apps/agent/test/verify-codex-cli-split-preflight.ts`
  - Expected RED result: current preflight stops before app-server/Code Mode host and has no readiness state that can distinguish infrastructure from model compatibility.
- [ ] **Implement the opt-in real infrastructure preflight.**
  - Keep the explicit environment contract and add only values needed for the Code Mode host/app-server proof, using the existing naming conventions. Refuse to run unless the Docker socket, managed root, exact Codex executable, control image reference, project ID, and workspace ID are all present.
  - Execute the actual rootless Docker path with no mocked readiness. Require exact `0.153.4`, exact project image, exact worktree/Git state, both service readies, control app-server socket/process, exact no-override TUI eligibility, persisted-record round trip, reattach, PTY attach/resize/lifecycle, mount/process/network/forwarding/proxy/endpoint-publication checks, and safe cleanup.
  - Probe the executor canary through direct path, traversal, symlink, environment, `/proc`, alternate mount, enumeration, host/gateway/unrelated services, and Internet attempts. Never print the canary or native home path/content.
  - Record `evidenceOrigin: "real-rootless-docker"`, phase, stable reason, exception class, capped sanitized cause context, and resource role. Do not collapse unexpected failures into an opaque generic message, and do not expose Docker bodies, raw protocol, environment values, credentials, or project output.
  - Stop before app-server model turns and human TUI interaction with `INFRASTRUCTURE_READY`; return `BLOCKED/INCOMPLETE` with a precise reason otherwise. The first successful run retains its current owned record for reattachment, the second successful run exercises that reattachment path, and cleanup runs on failure/abort or after the model probe so the next phase does not need manual JSON/container deletion.
- [ ] **Run GREEN and real preflight stability.**
  - Run the focused verifier tests and no-input check.
  - Run `pnpm --filter @devspace/agent run typecheck` and changed-file ESLint.
  - Run the real command with all six explicit non-secret inputs from the approved environment:
    ```bash
    DEVSPACE_TEST_DOCKER_SOCKET_PATH="/run/devspace-docker/docker.sock" \
    DEVSPACE_MANAGED_ROOT="/srv/devspace/managed" \
    DEVSPACE_CODEX_EXECUTABLE_PATH="/config/.local/bin/codex" \
    DEVSPACE_CODEX_CONTROL_IMAGE_REFERENCE="node@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059" \
    DEVSPACE_CODEX_VERIFY_PROJECT_ID="01a0a28b-797f-702e-abb1-56f7319fbbe5" \
    DEVSPACE_CODEX_VERIFY_WORKSPACE_ID="01a0a28c-776d-723a-9465-493c4259d650" \
    pnpm --filter @devspace/agent run verify:codex:split:preflight
    ```
  - Require two consecutive real results of `INFRASTRUCTURE_READY`, including one fresh creation and one persisted-record/reattach path. A mock or one successful subcheck is insufficient.
- [ ] **Commit the task.**
  - `git add apps/agent/src/codex-cli-split/feasibility-verifier.ts apps/agent/src/codex-cli-split/feasibility-verifier.test.ts apps/agent/test/verify-codex-cli-split-preflight.ts`
  - `git commit -m "feat(agent): add native Code Mode infrastructure preflight"`

## Task 11: Add the real Astra CodeModeOnly compatibility probe

**Files:** Create — `apps/agent/test/codex-native-app-server-probe.ts`, `apps/agent/test/codex-native-app-server-probe.test.ts`, `apps/agent/test/verify-codex-cli-split-model.ts`. Modify — `apps/agent/package.json` only to register the explicit test-only model command. Test — `codex-native-app-server-probe.test.ts`.

- [ ] **Test first — define a minimal test-only native app-server client.**
  - Create `apps/agent/test/codex-native-app-server-probe.test.ts` before `codex-native-app-server-probe.ts`.
  - Consume the exact Codex `0.153.4` app-server protocol fixtures under `packages/contracts/fixtures/codex-app-server/0.153.4`, `CodexSplitModelCompatibilityProof` from `feasibility-result.ts`, the owned Unix socket from `CodexNativeAppServerHandle`, `CodexCodeModeHostHandle`, `CodexExecServerHandle`, `DockerEngineClient.topContainer`, `inspectExec`, and the A-H evidence types.
  - Produce only this test-only interface:
    ```ts
    export interface CodexNativeAppServerModelProbeInput {
      readonly socketPath: "/codex-home/app-server-control/app-server-control.sock";
      readonly model: "gpt-6-astra";
      readonly logicalCwd: "/workspace";
      readonly operation: "pwd" | "git-status" | "read-acceptance-file" | "write-remove-acceptance-file";
      readonly timeoutMs: number;
    }

    export interface CodexNativeAppServerModelProbeEvidence {
      readonly provenance: "real-native-app-server";
      readonly model: "gpt-6-astra";
      readonly toolMode: "CodeModeOnly";
      readonly codeModeProvider: "remote-grpc";
      readonly codeModeHostContainerId: string;
      readonly execServerContainerId: string;
      readonly logicalCwd: "/workspace";
      readonly controlProjectProcessCount: 0;
      readonly executorProjectProcessCount: number;
      readonly codeModeHostProcessObserved: true;
      readonly execServerProcessObserved: true;
      readonly nestedProjectExecObserved: true;
      readonly operationCompleted: true;
      readonly executorHasNativeHome: false;
      readonly approval: "not-requested" | "required-stop";
    }

    export interface CodexNativeAppServerProbeConnection {
      readonly send: (request: Readonly<Record<string, unknown>>) => Promise<void>;
      readonly receive: () => Promise<Readonly<Record<string, unknown>>>;
      readonly close: () => Promise<void>;
    }

    export interface CodexNativeAppServerModelProbeDependencies {
      readonly connect: (socketPath: string) => Promise<CodexNativeAppServerProbeConnection>;
      readonly inspectControl: () => Promise<{
        readonly projectProcessCount: number;
        readonly appServerProcessCount: number;
      }>;
      readonly inspectExecutor: () => Promise<{
        readonly projectProcessCount: number;
        readonly codeModeHostProcessCount: number;
        readonly execServerProcessCount: number;
        readonly hasNativeHome: false;
      }>;
      readonly now: () => number;
      readonly sleep: (milliseconds: number) => Promise<void>;
    }

    export async function runCodexNativeAppServerModelProbe(
      input: CodexNativeAppServerModelProbeInput,
      deps: CodexNativeAppServerModelProbeDependencies,
    ): Promise<CodexNativeAppServerModelProbeEvidence & CodexSplitModelCompatibilityProof>;
    ```
  - Add RED tests for wrong model/tool mode, local provider selection, missing/stale host, missing exec endpoint, approval request, executor process absence, control process appearance, and a fake protocol response attempting to claim remote execution.
  - Add a test proving raw transcripts, model output, credentials, and approval decisions are not persisted or returned.
  - Run:
    `pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/test/codex-native-app-server-probe.test.ts`
  - Expected RED result: no test-only app-server socket probe exists and no real-model readiness proof is part of the verifier.
- [ ] **Implement the smallest upstream-native probe.**
  - Use the exact 0.153.4 app-server Unix-socket framing from `app-server-transport` and the generated fixture schemas for only `initialize`, thread start/resume as required, one bounded turn, and the protocol events needed to identify model metadata/tool mode/provider and completion/approval. Implement the socket client only in this test file pair rather than reusing the structured stdio `CodexJsonlTransport`; do not expose this client as a product API.
  - Authenticate through the already-owned native home/app-server; if authentication is unavailable, return `BLOCKED/INCOMPLETE` before consuming model quota. Request exactly `gpt-6-astra` and a fixed bounded harmless operation. If native approval is requested, stop with `approval: "required-stop"`; never auto-approve or synthesize a user turn.
  - Prove remote execution from container/process/runtime evidence: CodeModeOnly metadata, remote gRPC provider identity, Code Mode host process in executor, nested exec-server process in executor, logical `/workspace`, no control project process, no executor home/credentials, and successful operation. Model text claiming execution is not evidence.
  - Return `MODEL_REMOTE_COMPATIBLE` only from the real native app-server path with bounded evidence satisfying `CodexSplitModelCompatibilityProof`. The test-only entrypoint passes that proof to the pure result evaluator; production verifier code accepts the serialized proof but does not import the test client. Mocks always return an incomplete/non-ready classification.
- [ ] **Run GREEN and consume real model quota only here.**
  - Run the focused probe tests and Agent typecheck/changed-file ESLint.
  - Run the explicit opt-in model probe only after two real infrastructure-preflight successes, using the same six environment values and this command:
    ```bash
    DEVSPACE_TEST_DOCKER_SOCKET_PATH="/run/devspace-docker/docker.sock" \
    DEVSPACE_MANAGED_ROOT="/srv/devspace/managed" \
    DEVSPACE_CODEX_EXECUTABLE_PATH="/config/.local/bin/codex" \
    DEVSPACE_CODEX_CONTROL_IMAGE_REFERENCE="node@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059" \
    DEVSPACE_CODEX_VERIFY_PROJECT_ID="01a0a28b-797f-702e-abb1-56f7319fbbe5" \
    DEVSPACE_CODEX_VERIFY_WORKSPACE_ID="01a0a28c-776d-723a-9465-493c4259d650" \
    pnpm --filter @devspace/agent run verify:codex:split:model
    ```
  - Require a bounded real result `MODEL_REMOTE_COMPATIBLE`; an approval request, auth failure, unsupported protocol, or insufficient evidence is `BLOCKED/INCOMPLETE`, not a failed security proof and not permission to open the TUI. The probe reattaches the valid runtime record retained by the infrastructure phase and performs cleanup only after its bounded result is recorded.
- [ ] **Commit the task.**
  - `git add apps/agent/test/codex-native-app-server-probe.ts apps/agent/test/codex-native-app-server-probe.test.ts apps/agent/test/verify-codex-cli-split-model.ts apps/agent/package.json`
  - Include only the script/package files actually needed.
  - `git commit -m "test(agent): probe native Astra remote Code Mode"`

## Task 12: Add the final native A-H operator verifier after model compatibility (not the independent review)

**Files:** Create — none. Modify — `apps/agent/src/codex-cli-split/feasibility-verifier.ts`, `apps/agent/test/verify-codex-cli-split-execution.ts`. Test — `apps/agent/src/codex-cli-split/feasibility-verifier.test.ts` and the existing execution entrypoint's no-input tests.

- [ ] **Test first — make the human boundary and final result explicit.**
  - Modify `apps/agent/src/codex-cli-split/feasibility-verifier.test.ts` and `apps/agent/test/verify-codex-cli-split-execution.ts`.
  - Consume `runCodexSplitInfrastructurePreflight`, the serialized `CodexSplitModelCompatibilityProof` produced by the test-only model probe, `CodexSplitRuntime.startNewSession`, `startResume`, `snapshotNativeSessionState`, `discoverNativeSession`, `startNativeCodexPty`, the strict A-H evidence/result model, and bounded diagnostics. The test entrypoint may invoke `runCodexNativeAppServerModelProbe`; `feasibility-verifier.ts` must consume only the pure proof/result types.
  - Add RED tests proving the final verifier refuses TUI attachment unless infrastructure is ready and the real model probe is `MODEL_REMOTE_COMPATIBLE`; refuses `-c notify=[]` evidence; refuses synthetic session IDs/approvals; treats Ctrl+C/abort as `BLOCKED/INCOMPLETE`; and cannot produce a pass state from mocks.
  - Add tests for the operator sequence: printed external checklist, native TUI attach, normal TUI exit, passive native ID discovery, exact `codex resume <id>`, continuity/remote topology checks, executor recreation same generation, TUI/app-server restart, control recreation, stale generation rejection, duplicate live resume rejection, and two distinct concurrent sessions.
  - Run:
    `pnpm --dir ../.. exec vitest run --project @devspace/agent apps/agent/src/codex-cli-split/feasibility-verifier.test.ts apps/agent/test/verify-codex-cli-split-execution.ts`
  - Expected RED result: current verifier can open the human gate before a real model compatibility proof and does not project all A-H requirements.
- [ ] **Implement the final operator-only boundary.**
  - Print the A-H checklist outside the PTY and attach the real native TUI only after infrastructure and model readiness. Do not write keystrokes, prompts, slash commands, approval answers, or checklist text into the TUI.
  - Require the human to use exactly `codex`, then natively stop, passively identify the provider-owned native session ID, and use exactly `codex resume NATIVE_SESSION_ID`. The verifier must record argv and default-socket/app-server provenance while keeping the native UI/session/approval authority intact.
  - Collect automatable process, mount, network, endpoint, home, transport, generation, and session evidence itself. The human confirms only genuinely interactive/native behavior. A missing/stale endpoint during resume fails closed.
  - The native A-H checklist must include executor-observed `pwd`, `git status --short`, `git diff --stat`, `git log -1 --oneline`, AGENTS.md discovery, normal file read/write, `apply_patch`, and available Node/Python/package-script child processes. Each result must be tied to executor-side process/container evidence; command text or model narration alone is not accepted.
  - Project the result as PASS, PASS-WITH-TRANSPORT-BLOCK, FAIL, or BLOCKED/INCOMPLETE. PASS requires both internal transports protocol-authenticated; private-only direct transports cap the result at PASS-WITH-TRANSPORT-BLOCK; no result authorizes migration or changes the structured default.
- [ ] **Run GREEN and complete repository verification without starting the independent post-live security review.**
  - Run focused native app-server/split tests, all `apps/agent/src/codex-cli-split/*.test.ts`, all modified Docker/runtime/managed-workspace tests, and `pnpm --filter @devspace/agent test`.
  - Run `pnpm --filter @devspace/agent run typecheck`.
  - Run changed-file ESLint with `--max-warnings 0` and `pnpm lint`.
  - Run the verifier no-input safety check; do not run the interactive real gate during implementation automation.
  - Run `git diff --check`.
  - Run the real noninteractive infrastructure preflight twice consecutively from clean owned state, then the real model probe only after those successes. The human A-H gate is the final step and is not automated or faked.
  - On the clean-clone verification pass required by `AGENTS.md`, run `pnpm install --frozen-lockfile`, `pnpm workspace:check`, `pnpm lint`, `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm contracts:check`, `pnpm schema:check`, `pnpm db:migrate:test`, and `pnpm db:check`.
- [ ] **Commit the task.**
  - `git add apps/agent/src/codex-cli-split/feasibility-verifier.ts apps/agent/src/codex-cli-split/feasibility-verifier.test.ts apps/agent/test/verify-codex-cli-split-execution.ts`
  - Include only directly required script/package changes.
  - `git commit -m "feat(agent): add native Code Mode feasibility gate"`

## Cross-Task Verification and Acceptance Matrix

The implementation worker must keep these checks green at each task boundary and must not claim the architecture passes from mocked evidence.

| Spec gate | Concrete proof owner | Required observable evidence |
| --- | --- | --- |
| A. Native TUI/app-server authority | Tasks 4, 6, 12 | Owned per-home Unix socket, app-server PID/provenance, exact `[codex]`/`[codex, resume, id]`, no embedded daemon, native PTY/approval/session authority |
| B. Exact executor/project environment | Tasks 2, 3, 5, 10 | Exact image ID, exact worktree/Git identities, exact toolchain, both native services ready in executor, no home/credential/socket/control-egress |
| C. Astra CodeModeOnly remote execution | Task 11, projected by Task 12 | Real authenticated `gpt-6-astra`, observed `CodeModeOnly`, remote gRPC host and exec-server process/container evidence, bounded project operation, no control project process |
| D. Physical home/network separation | Tasks 3, 5, 7, 10, 11, 12 | Canary attack matrix, mounts/processes/PIDs, execution network members exactly control+executor, control-egress only control, no forwarding/NAT/proxy/host/unrelated route |
| E. Native persistence/unqualified resume | Tasks 4, 6, 5, 12 | Persistent home, session provenance, normal TUI exit, exact unqualified resume, continuity and same executor topology, restart evidence |
| F. Local fallback/escape rejection | Tasks 1, 7, 10, 12 | Effective global/project config proof and negative-path results for every forbidden path; missing/stale services fail closed |
| G. Transport classification | Tasks 3, 5, 9, 10, 12 | Separate exec-server and Code Mode gRPC authentication/isolation evidence; private-only remains a transport block |
| H. Restart/concurrency/ownership | Tasks 5, 8, 10, 12 | TUI/app-server/control/Agent restart cases, executor same-generation recreation, stale generation/foreign socket rejection, duplicate-live-only rejection, distinct sessions allowed, safe artifact GC |

### Readiness progression

1. `INFRASTRUCTURE_READY` is emitted only after the real rootless-Docker preflight completes every automated infrastructure/security/lifecycle check and two consecutive real runs succeed. It does not consume model quota and does not open the TUI.
2. `MODEL_REMOTE_COMPATIBLE` is emitted only after the real authenticated native app-server probe uses `gpt-6-astra`, observes `CodeModeOnly`, and proves Code Mode plus nested project execution in the executor. An approval request stops the probe.
3. `READY_FOR_OPERATOR_TUI` is emitted only after model compatibility and repeated infrastructure evidence. At this point the human is asked to perform native TUI approvals, session, resume, and other interactive A-H checks.
4. `PASS`, `PASS-WITH-TRANSPORT-BLOCK`, `FAIL`, and `BLOCKED/INCOMPLETE` are final feasibility outcomes. A preflight, model probe, or operator abort cannot be projected to PASS. No outcome changes the shipped/default structured app-server path.

### Transport and security stop conditions

- If either native service cannot run in the exact project image with the verified `0.153.4` closure, the result is `BLOCKED/INCOMPLETE` or `FAIL` according to whether incompatibility or invariant violation is proven; no generic image is introduced.
- If exact 0.153.4 cannot enforce mandatory remote-only configuration against project-controlled layers, stop as `BLOCKED/INCOMPLETE` and do not trust the project configuration.
- If any project process, Code Mode JS host process, nested shell, Git, package script, or file operation appears in control, stop with `FAIL`.
- If the executor can read the native home canary or obtain credentials through direct path, traversal, symlink, environment, `/proc`, alternate mount, socket, host service, control relay, or unrelated state, stop with `FAIL`.
- If the executor reaches the control-egress network, Internet, host, gateway, or unrelated managed service, or if control forwarding/NAT/proxy capability/process exists, stop with `FAIL`.
- If app-server or either executor service is missing/stale/unreachable and any path attempts local execution or fallback, stop with `FAIL`; if proof simply cannot be completed, return `BLOCKED/INCOMPLETE`.
- If direct exec-server or Code Mode gRPC protocol authentication remains unproven while all physical and functional gates pass, classify at most `PASS-WITH-TRANSPORT-BLOCK`; never call that migration approval.

## Final Review Boundary

This plan ends after the implementation, noninteractive infrastructure readiness, real model compatibility proof, and human A-H feasibility result. It does not include the independent Luna Max security/architecture review, `docs/current-state.md` update, Workbench/session migration, structured-path retirement, deployment, merge, or PR creation. Those actions require the live result and a separate explicit decision.

## Plan Self-Review Checklist

- [ ] Every material requirement in `docs/superpowers/specs/2026-09-17-codex-native-app-server-code-mode-design.md` maps to Tasks 1–12 or the acceptance matrix.
- [ ] A-H gates each have an implementation owner and observable evidence requirement.
- [ ] The plan contains no placeholder task, undefined error behavior, arbitrary generic runner, or unbounded diagnostic instruction.
- [ ] Produced interfaces are consumed by named downstream tasks: policy/config by executor/app-server/verifier; artifact capabilities by Code Mode host/app-server; service handles by runtime records and verifier; readiness/evidence by model probe and final result.
- [ ] No task mounts project/Git into control, mounts native home into executor, enables a local Code Mode host, adds a TUI CLI override, requires `--remote`, or permits local fallback.
- [ ] No task synthesizes approvals, native session history, conversation protocol for product use, or Web/Workbench/SQLite state.
- [ ] The model probe is the first quota-consuming step and the human TUI is requested only after `MODEL_REMOTE_COMPATIBLE`.
- [ ] Mocked tests cannot yield a pass state; real preflight and real model evidence are mandatory.
- [ ] The existing structured app-server path remains shipped/default and its authority documents are untouched.
