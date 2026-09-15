# Codex CLI Sidecar Feasibility Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove, before any Workbench/session migration, that DevSpace can run the real native Codex TUI in a workspace-scoped sidecar using the exact project runtime image, exact worktree/Git authority, a shared persistent native `CODEX_HOME`, and an enforced filesystem sandbox that prevents Codex-launched tools from reading that private home.

**Architecture:** Add an Agent-only experimental sidecar path. The Agent resolves and stages the already-supported Codex artifact, creates a hardened sidecar from the exact running development image, mounts the exact worktree plus only the Git administration needed by that worktree, mounts one Agent-private native Codex home, and installs a system Codex requirements policy that denies tool access to `/codex-home`. New Codex executions are bare `codex` Docker exec PTYs. This plan does not add Web/SQLite session persistence, native resume, passive session correlation, or switch the shipped structured app-server path.

**Tech Stack:** TypeScript, Node 24, Vitest, Docker Engine API through the existing dedicated rootless Docker client, existing DevSpace managed-workspace/runtime authority, existing Codex artifact identity/staging, native Codex CLI/TUI, Codex Linux filesystem sandbox requirements, Git.

**Spec:** `docs/superpowers/specs/2026-09-15-codex-cli-sidecar-design.md`

## Global Constraints

- This is only the hard feasibility/security gate. Do not implement browser UI, Web routes, SQLite schema, native session persistence, resume, passive rollout correlation, automatic worktrees, or removal of the current structured Codex path.
- Read `AGENTS.md`, the approved spec, and this plan before changing code. Explicit current product decisions in the approved spec override older structured-AI-session documents for this experimental path, while the shipped structured path remains active until a later deliberate migration.
- Use Luna-family models only for implementation and review in this slice. Use Luna Max for the container/credential/security-boundary work; Luna High is acceptable only for clearly bounded tests or documentation.
- Do not run concurrent editing agents on the same branch. Multiple runtime Codex sessions are a product requirement, but multiple implementation agents editing this branch concurrently are unnecessary risk.
- Apply TDD: write the focused failing test first, run it and observe the intended failure, implement the minimum behavior, rerun the focused test, then self-review before committing.
- Preserve the existing rootless-Docker, Web/Agent, workspace ownership, GitHub App, and no-auto-merge/no-auto-deploy boundaries.
- Do not add a one-Codex-per-workspace lock, global native-home lock, or old credential lease to the new sidecar path.
- The native home is not copied from or synchronized with `<stateRoot>/codex-auth/codex/` in normal operation. The feasibility verifier may require the operator to complete native Codex login interactively if the new native home is unauthenticated.
- `+ New Codex` semantics are represented in this gate only by an exec whose command is exactly `codex`; no prompt argument, hidden `/status`, synthetic input, or prompt injection is permitted.
- The project image must be exact. Do not silently substitute a generic runner image when Codex or the required sandbox does not work in the project runtime.
- The private-home boundary is a hard stop condition. Never “fix” a failed gate by making `/codex-home` broadly readable, moving the same credential files to another tool-readable path, selecting danger/full-access mode, mounting a Docker/Agent socket, or disabling the Codex sandbox.
- The sidecar may use the exact project network required for Codex/provider access, but must not use host networking, host PID, privileged mode, the Docker socket, the Agent socket, or unrelated managed-root mounts.
- For this owner-only alpha gate, use one explicit Agent-private account binding such as `owner-default`; do not invent a generic multi-user identity system in this slice.
- Keep the current `fix/workbench-runtime-ai-truthfulness` branch untouched. Do not merge or cherry-pick it as part of this gate.
- Each task below gets one implementation/self-check pass. After the integrated live gate, perform one focused independent Luna security review and one final correction/self-review pass only if substantive findings exist.
- If the same blocker has three evidence-backed failed fixes, stop and report the architectural problem instead of continuing to patch around it.
- Never include shell commands that terminate the current interactive SSH session (`exit`, `logout`, etc.).

## Target File Map

Create:

- `apps/agent/src/codex-cli/security-policy.ts` — Agent-private native-home and immutable system-requirements preparation.
- `apps/agent/src/codex-cli/security-policy.test.ts` — ownership, symlink, mode, and exact-policy tests.
- `apps/agent/src/codex-cli/sidecar-runtime.ts` — experimental exact-workspace sidecar creation and bare Codex PTY launch.
- `apps/agent/src/codex-cli/sidecar-runtime.test.ts` — authority, mount, exact-image, concurrency, and bare-launch tests.
- `apps/agent/test/verify-codex-cli-sidecar.ts` — opt-in real-rootless acceptance verifier for the hard gate.

Modify:

- `apps/agent/src/docker-runtime.ts` — explicit Codex CLI sidecar container input/builder/create operation and any image metadata needed to preserve the image PATH.
- `apps/agent/src/docker-runtime.test.ts` — exact serialized Docker-policy tests.
- `apps/agent/package.json` — add the explicit real-environment verifier script.
- `docs/current-state.md` — update only after the live gate passes; do not claim success before then.

Do not modify in this plan:

- `apps/web/**`
- `packages/database/**`
- public AI-session contracts or domain state machines
- the shipped structured Codex app-server behavior
- ADR 015 / `docs/specs/ai-sessions-v1.md` authority status

---

## Task 1: Add the native-home and system sandbox policy primitives

**Files:**
- Create: `apps/agent/src/codex-cli/security-policy.ts`
- Create: `apps/agent/src/codex-cli/security-policy.test.ts`
- Reuse: `apps/agent/src/private-state.ts`

### 1.1 Write the failing policy-content test

- [ ] Create `security-policy.test.ts` with a test that expects one exported canonical requirements string or builder to contain exactly the managed restrictions needed for this gate:

```toml
allowed_sandbox_modes = ["read-only", "workspace-write"]
default_permissions = ":workspace"

[allowed_permission_profiles]
":read-only" = true
":workspace" = true
":danger-full-access" = false

[permissions.filesystem]
deny_read = ["/codex-home"]
```

- [ ] Assert that the policy does not contain `dangerously-bypass-approvals-and-sandbox`, an allow for `:danger-full-access`, Docker/Agent socket paths, or any host credential path.
- [ ] Run:

```bash
pnpm exec vitest run apps/agent/src/codex-cli/security-policy.test.ts
```

Expected: fail because the module does not exist yet.

### 1.2 Implement the exact managed requirements policy

- [ ] Add `security-policy.ts` with a small named export for the canonical requirements content. Keep the file focused on filesystem/home preparation and policy materialization; do not add session logic.
- [ ] Document in a short code comment that this is a system requirements layer for the managed sidecar, not a replacement for Codex-owned user `config.toml`.
- [ ] Do not constrain native approval mode here; constrain the sandbox modes and permission profiles so native approval UX can still operate without ever granting child processes access to `/codex-home`.
- [ ] Re-run the focused test and make it pass.

### 1.3 Write the failing private-state preparation tests

- [ ] Add tests for a helper such as `ensureCodexCliPrivateState({ stateRoot, accountBinding })` that returns only Agent-private paths needed by later tasks: native home, policy file, and launcher root.
- [ ] Test the owner-only gate binding `owner-default` and assert paths remain contained under `stateRoot`.
- [ ] Assert the native home is a real non-symlink directory with mode `0700`.
- [ ] Assert the requirements file is a regular non-symlink file with mode `0600` and exact canonical bytes.
- [ ] Assert repeated preparation is idempotent when the exact owned files/directories are unchanged.
- [ ] Assert preparation fails closed if the expected native-home, policy-root, or requirements path is replaced by a symlink.
- [ ] Assert no file is created under the old `codex-auth/codex` authority and no old credential bytes are copied into the native home.
- [ ] Run the focused test and observe the expected failures.

### 1.4 Implement private-state preparation using existing hardened helpers

- [ ] Build the native home under an Agent-private path conceptually equivalent to:

```text
<stateRoot>/codex-homes/owner-default/
```

- [ ] Build the managed requirements file under an Agent-private policy root such as:

```text
<stateRoot>/codex-cli-policy/requirements.toml
```

- [ ] Use the existing `establishPinnedDirectory`, `pinExistingDirectory`, containment, and no-follow/private-state patterns instead of ad hoc `mkdir -p` trust.
- [ ] Materialize the exact requirements bytes atomically and verify the resulting file identity/type/mode before returning it.
- [ ] Keep `config.toml`, auth files, and `sessions/` provider-owned. Do not create a synthetic Codex config or auth file.
- [ ] Re-run the focused tests until green.

### 1.5 Self-review and commit Task 1

- [ ] Review only the Task 1 diff for path containment, symlink handling, permissions, and accidental old-authority coupling.
- [ ] Run:

```bash
pnpm exec vitest run apps/agent/src/codex-cli/security-policy.test.ts
git diff --check
```

- [ ] Commit intentionally, for example:

```bash
git add apps/agent/src/codex-cli/security-policy.ts apps/agent/src/codex-cli/security-policy.test.ts
git commit -m "feat(agent): prepare Codex CLI private state"
```

---

## Task 2: Add the exact-image Codex sidecar Docker policy

**Files:**
- Modify: `apps/agent/src/docker-runtime.ts`
- Modify: `apps/agent/src/docker-runtime.test.ts`

### 2.1 Write the failing serialized-container policy test

- [ ] Extend the existing recording-engine tests with a case for `createCodexCliSidecarContainer` (or equivalent) using fixture values for:
  - exact inspected image ID/reference;
  - fixed numeric sidecar user;
  - exact worktree path;
  - exact project bare repository path;
  - native Codex home path;
  - requirements file path;
  - staged Codex artifact root;
  - launcher root;
  - workspace network name;
  - bounded resources and labels.
- [ ] Assert the Docker create body uses the exact project image, not a generic image.
- [ ] Assert `WorkingDir` is `/workspace` and the long-lived sidecar startup command is neutral rather than a Codex conversation.
- [ ] Assert mounts are only the expected exact resources:
  - worktree -> `/workspace`, read/write, `rprivate`;
  - exact project bare repository -> the same absolute repository path inside the container, read/write, `rprivate`;
  - native home -> `/codex-home`, read/write, `rprivate`;
  - requirements file -> `/etc/codex/requirements.toml`, read-only, `rprivate`;
  - staged artifact -> `/opt/devspace-codex`, read-only, `rprivate`;
  - launcher root -> `/opt/devspace-codex-bin`, read-only, `rprivate`.
- [ ] Assert `CODEX_HOME=/codex-home`, `HOME=/codex-home`, `TERM=xterm-256color`, and a PATH that prepends `/opt/devspace-codex-bin` while preserving the inspected image PATH.
- [ ] Assert `Privileged=false`, empty `PidMode`, private IPC/cgroup namespace, `CapDrop=["ALL"]`, no added capabilities, `no-new-privileges:true`, no published ports, no devices, and no Docker/Agent socket strings.
- [ ] Assert the sidecar joins only the exact workspace network. Reject host networking and unrelated network identities.
- [ ] Assert the JSON does not contain a general managed-root mount, old Codex credential authority, or host `~/.codex`.
- [ ] Run:

```bash
pnpm exec vitest run apps/agent/src/docker-runtime.test.ts
```

Expected: new case fails because the sidecar builder/create operation does not exist.

### 2.2 Extend image inspection only as needed to preserve PATH

- [ ] Extend `DockerImageInspection.Config` and its Zod schema to accept the image `Env` array if the Engine supplies it.
- [ ] Add a small parser/helper that extracts a usable image `PATH` deterministically. Reject duplicate/invalid PATH entries or absence if preserving the runtime environment cannot be proven; do not silently fabricate a project toolchain PATH during this gate.
- [ ] Add focused unit cases for normal, missing, and malformed PATH metadata.

### 2.3 Implement the sidecar container input and builder

- [ ] Add a dedicated input type such as `DockerCodexCliSidecarContainerInput`; do not overload the normal runtime or old bootstrap input with optional sidecar semantics.
- [ ] Validate every host path as absolute/NUL-free before serialization and require an exact image ID/reference already proven by the Agent runtime path.
- [ ] Use the project image with a neutral long-running command such as the existing controlled shell/sleep pattern so Codex sessions are separate Docker exec PTYs.
- [ ] Run the sidecar as an explicit numeric UID:GID supplied by the Agent for the private native home. For this gate, use the managed deployment identity rather than chowning the shared home between arbitrary image users.
- [ ] Keep `ReadonlyRootfs: false` for project-runtime parity/tooling in this gate; the credential boundary is mount minimization plus the provider filesystem sandbox, not a misleading whole-container read-only claim.
- [ ] Preserve resource limits and the existing rootless runtime policy.
- [ ] Re-run `docker-runtime.test.ts` until green.

### 2.4 Add strict creation/inspection helpers

- [ ] Add `createCodexCliSidecarContainer(name, input)` to `DockerEngineClient`, mirroring the existing create methods but using only the dedicated validated builder.
- [ ] Ensure the existing container inspection schema can later prove every expected mount, image, user, network, and security field without adding unbounded/raw passthrough state.
- [ ] Do not add browser-visible APIs or public contracts.

### 2.5 Self-review and commit Task 2

- [ ] Review the serialized Docker body line-by-line against the approved spec.
- [ ] Run:

```bash
pnpm exec vitest run apps/agent/src/docker-runtime.test.ts
pnpm --filter @devspace/agent typecheck
git diff --check
```

- [ ] Commit intentionally, for example:

```bash
git add apps/agent/src/docker-runtime.ts apps/agent/src/docker-runtime.test.ts
git commit -m "feat(agent): add Codex CLI sidecar policy"
```

---

## Task 3: Build the experimental Agent-side sidecar runtime and bare Codex PTY launcher

**Files:**
- Create: `apps/agent/src/codex-cli/sidecar-runtime.ts`
- Create: `apps/agent/src/codex-cli/sidecar-runtime.test.ts`
- Reuse: `apps/agent/src/managed-workspaces.ts`
- Reuse: `apps/agent/src/workspace-runtime.ts`
- Reuse: `apps/agent/src/codex-app-server/artifact-identity.ts`
- Reuse: `apps/agent/src/docker-runtime.ts`

### 3.1 Write the failing exact-authority tests

- [ ] Create fakes around `ManagedWorkspaces`/runtime context and `DockerEngineClient` sufficient to prove behavior without requiring a live daemon.
- [ ] Test that sidecar creation first resolves the exact `(projectId, workspaceId)` execution context and rejects a stopped, lost, wrong-project, wrong-workspace, or generation-mismatched runtime.
- [ ] Test that the sidecar image is taken from the exact running development-container inspection and must match the workspace runtime ownership.
- [ ] Test that the bare repository mount is exactly `managed.repositoryPath(projectId)` and the worktree mount is exactly the context-owned worktree.
- [ ] Test that labels contain only safe IDs/generation/role metadata and never host paths or auth values.
- [ ] Run:

```bash
pnpm exec vitest run apps/agent/src/codex-cli/sidecar-runtime.test.ts
```

Expected: fail because the runtime does not exist.

### 3.2 Write the failing Codex artifact/launcher tests

- [ ] Test that the runtime reuses `resolveCodexExecutionArtifact`, `stageCodexExecutionArtifact`, and staged-artifact verification rather than trusting an arbitrary executable path inside the project.
- [ ] Create an Agent-private launcher root whose `codex` entry resolves inside the sidecar to the exact staged artifact entrypoint under `/opt/devspace-codex/...`.
- [ ] Prefer a verified symlink named `codex` with a fixed sidecar-absolute target if the host-side no-follow/identity checks can prove it safely. If a wrapper is required by platform behavior, keep it static, argument-transparent, and covered by exact-content tests; do not add prompts or provider flags.
- [ ] Test repeated launcher preparation and fail closed on symlink/path substitution of the launcher root itself.
- [ ] Run the focused tests and observe failure before implementation.

### 3.3 Implement sidecar ensure/create with post-create proof

- [ ] Add a focused `CodexCliSidecarRuntime` (or equivalent) whose dependencies are explicit: state root, managed-workspace authority, Docker client, configured Codex path, and sidecar numeric UID:GID.
- [ ] On `ensureSidecar(projectId, workspaceId)`:
  1. resolve the exact running workspace execution context;
  2. inspect the owned development container and exact image;
  3. inspect image metadata/PATH;
  4. resolve and stage the admitted Codex artifact;
  5. prepare native private state and launcher;
  6. calculate the exact project repository path;
  7. create/start the sidecar with the dedicated Docker policy;
  8. inspect the resulting container and prove image, user, network, security settings, and every mount before returning it.
- [ ] Reuse one sidecar for the same exact workspace runtime generation; do not reuse across a changed runtime generation without proof.
- [ ] Do not use a workspace-wide Codex session lease.
- [ ] Keep the native home persistent when the experimental sidecar is removed.

### 3.4 Write the failing bare-exec and concurrency tests

- [ ] Add a test that `createBareCodexExec()` calls Docker with exactly:

```text
command = ["codex"]
workingDirectory = "/workspace"
attachStdin = true
tty = true
```

- [ ] Assert it does not add a prompt, `resume`, `/status`, approval flags, sandbox-bypass flags, or hidden stdin bytes.
- [ ] Assert `startExecAttached(execId, true)` is used so the real TUI receives a PTY stream.
- [ ] Start two fake Codex execs against the same sidecar and assert both are permitted simultaneously with distinct exec IDs and no global lock/home lease.
- [ ] Add a negative test proving an exact duplicate native-session guard is not invented here; native-session identity is outside this feasibility slice.
- [ ] Run the focused test and observe failure before implementation.

### 3.5 Implement bare Codex exec creation

- [ ] Implement only the PTY creation/attachment primitive needed for the verifier. Do not create a new public session protocol.
- [ ] Return an Agent-private handle containing only what the verifier/runtime needs (sidecar ID, exec ID, attached stream/resize operations). Do not expose Docker IDs through Web contracts.
- [ ] Preserve terminal resizing/input semantics supported by the existing Docker exec client, but do not yet wire this path into the browser Workbench.
- [ ] Re-run the focused tests until green.

### 3.6 Self-review and commit Task 3

- [ ] Review exact workspace authority, reuse across runtime generations, artifact provenance, mount proof, and bare-launch semantics.
- [ ] Run:

```bash
pnpm exec vitest run apps/agent/src/codex-cli/security-policy.test.ts apps/agent/src/docker-runtime.test.ts apps/agent/src/codex-cli/sidecar-runtime.test.ts
pnpm --filter @devspace/agent typecheck
pnpm --filter @devspace/agent build
git diff --check
```

- [ ] Commit intentionally, for example:

```bash
git add apps/agent/src/codex-cli/sidecar-runtime.ts apps/agent/src/codex-cli/sidecar-runtime.test.ts
git commit -m "feat(agent): add experimental Codex CLI sidecar runtime"
```

---

## Task 4: Add the opt-in real-rootless hard-gate verifier

**Files:**
- Create: `apps/agent/test/verify-codex-cli-sidecar.ts`
- Modify: `apps/agent/package.json`

### 4.1 Write verifier argument/environment validation first

- [ ] Make the verifier require all of these explicitly, with no production/default fallback:

```text
DEVSPACE_TEST_DOCKER_SOCKET_PATH
DEVSPACE_MANAGED_ROOT
DEVSPACE_CODEX_EXECUTABLE_PATH
DEVSPACE_CODEX_VERIFY_PROJECT_ID
DEVSPACE_CODEX_VERIFY_WORKSPACE_ID
```

- [ ] Add a script such as:

```json
"verify:codex-cli-sidecar": "tsx test/verify-codex-cli-sidecar.ts"
```

- [ ] Keep the verifier opt-in so normal `pnpm test` does not require Docker, Codex credentials, or a managed live workspace.
- [ ] Add small testable parsing/helper functions if needed rather than making environment validation impossible to unit-test.

### 4.2 Implement automated pre-interactive assertions

- [ ] Assert the requested Docker socket is a dedicated rootless daemon using the existing `assertRootlessAvailable()` path.
- [ ] Resolve the exact managed workspace and create/inspect the experimental sidecar.
- [ ] Create a random non-secret canary file inside the native home, for example `devspace-security-canary`. Never use or print real `auth.json` bytes as the probe secret.
- [ ] From the normal project development container, run a bounded command proving `/codex-home` is not mounted/accessible.
- [ ] From a direct Agent-controlled exec in the Codex sidecar (not a Codex-launched tool), prove the canary exists. Print only a pass/fail assertion, never the canary contents.
- [ ] Run project-scoped Git probes directly in the sidecar and require success:

```text
git -C /workspace rev-parse --show-toplevel
git -C /workspace status --short
git -C /workspace log -1 --oneline
git -C /workspace diff --stat
```

- [ ] Verify the reported Git top-level is `/workspace` and the sidecar is operating on the exact managed repository/worktree.

### 4.3 Prove shared-home runtime concurrency before operator interaction

- [ ] Create two bare `codex` PTY execs concurrently in the same workspace sidecar against the same native home.
- [ ] Inspect both execs and require both to be running simultaneously.
- [ ] If native authentication is missing and Codex presents login UI, allow the operator to complete native login in one session; do not seed credentials from the old authority and do not synthesize login input.
- [ ] Do not serialize the two sessions with a DevSpace home/session lease.

### 4.4 Attach one real TUI without injecting input

- [ ] Attach one PTY stream to the operator's current stdin/stdout so the operator is interacting with the actual Codex TUI.
- [ ] Forward terminal resize if practical in the verifier; keep this bounded and do not build the browser transport in this task.
- [ ] The verifier must not type prompts, slash commands, confirmation responses, or test commands on behalf of the operator.
- [ ] Print a concise manual acceptance checklist before attachment, then let the operator enter the checks themselves in the native Codex UI.

### 4.5 Perform the manual security/toolchain acceptance through real Codex

- [ ] In the native Codex TUI, instruct Codex to run each of these categories as tool/shell subprocess work. The exact shell spelling can adapt to the project image, but the observed security result may not:
  - direct read of `/codex-home/devspace-security-canary` must fail;
  - listing/searching `/codex-home` for files must fail;
  - Python read of the canary must fail when Python exists;
  - Node read of the canary must fail when Node exists;
  - create a symlink under `/workspace` pointing at the canary, then reading through that symlink must fail;
  - `git status`, `git diff`, and `git log -1 --oneline` must work;
  - one harmless project package/toolchain command must work;
  - create and remove one harmless file under `/workspace` must work.
- [ ] Exercise the native permission/sandbox UX available in the admitted Codex version. Confirm that managed requirements expose only `read-only`/`workspace-write` (or their current native equivalents) and that `danger-full-access` / dangerous bypass cannot be selected for the managed sidecar.
- [ ] Do not test by printing real credential/token files. The canary is the security oracle.
- [ ] Record only bounded pass/fail evidence: admitted Codex version, image ID/digest, runtime generation, sandbox modes observed, Git checks, concurrency result, and canary-denial outcomes. Do not persist terminal transcripts containing provider content or secrets.

### 4.6 Cleanup safely

- [ ] Stop/remove the experimental sidecar and its test execs.
- [ ] Remove only the verifier-owned canary and temporary launcher artifacts that are explicitly safe to remove.
- [ ] Preserve the native Codex home itself, its native auth/config/session state, and all existing managed workspace/repository data.
- [ ] Cleanup failures must be surfaced truthfully; never delete broad parent directories as a shortcut.

### 4.7 Self-review and commit Task 4

- [ ] Review for accidental secret output, hidden TUI input, destructive cleanup, and any fallback to old credentials.
- [ ] Run:

```bash
pnpm exec vitest run apps/agent/src/codex-cli/security-policy.test.ts apps/agent/src/docker-runtime.test.ts apps/agent/src/codex-cli/sidecar-runtime.test.ts
pnpm --filter @devspace/agent typecheck
pnpm --filter @devspace/agent build
git diff --check
```

- [ ] Commit intentionally, for example:

```bash
git add apps/agent/test/verify-codex-cli-sidecar.ts apps/agent/package.json
git commit -m "test(agent): add Codex CLI sidecar security verifier"
```

---

## Task 5: Run the hard gate, review the security boundary, and record the result

**Files:**
- Modify on PASS only: `docs/current-state.md`
- Review: all Task 1-4 files

### 5.1 Run focused automated verification first

- [ ] Run:

```bash
pnpm exec vitest run apps/agent/src/codex-cli/security-policy.test.ts apps/agent/src/docker-runtime.test.ts apps/agent/src/codex-cli/sidecar-runtime.test.ts
pnpm --filter @devspace/agent typecheck
pnpm --filter @devspace/agent build
```

Expected: all pass before attempting the live gate.

### 5.2 Run the live verifier against the real managed workspace

- [ ] With DevSpace's real managed workspace/runtime running, execute the verifier with the explicit environment values for this deployment. A representative bash invocation is:

```bash
env \
  DEVSPACE_TEST_DOCKER_SOCKET_PATH=/run/devspace-docker/docker.sock \
  DEVSPACE_MANAGED_ROOT=/srv/devspace/managed \
  DEVSPACE_CODEX_EXECUTABLE_PATH=/config/.local/bin/codex \
  DEVSPACE_CODEX_VERIFY_PROJECT_ID='<exact-project-id>' \
  DEVSPACE_CODEX_VERIFY_WORKSPACE_ID='<exact-workspace-id>' \
  pnpm --filter @devspace/agent run verify:codex-cli-sidecar
```

- [ ] Use the exact IDs returned by the managed DevSpace state/UI; never substitute a guessed workspace or arbitrary host path.
- [ ] Complete the native-TUI manual checklist from Task 4 and retain only bounded redacted acceptance evidence.

### 5.3 Apply the hard stop criteria literally

- [ ] Mark the gate **FAIL** and stop this architecture slice if any of these are true:
  - a Codex-launched tool/subprocess can read or enumerate `/codex-home` or the canary;
  - a supported native permission choice can disable the private-home boundary or enable danger/full-access for child processes;
  - the exact project runtime image cannot execute the admitted Codex TUI with the required sandbox;
  - the exact narrow Git mounts cannot provide normal project Git behavior;
  - the normal project container can access the private native home;
  - two normal Codex processes cannot safely operate concurrently against the shared native home without a DevSpace serialization lock;
  - satisfying the gate would require a Docker/Agent socket, privileged/host namespace, generic runner fallback, or other prohibited authority expansion.
- [ ] On FAIL, preserve evidence, clean up the experimental sidecar, do not start lifecycle/UI migration, and report the exact failed invariant for architectural reconsideration.
- [ ] Do not weaken the invariant after a failed result merely to make the test green.

### 5.4 If the hard gate passes, run one independent focused Luna security review

- [ ] Use one fresh Luna Max review agent. Scope it only to:
  - container/mount authority;
  - native-home isolation;
  - system requirements policy and sandbox bypass possibilities;
  - exact-image/runtime provenance;
  - Git mount scope;
  - secret/log leakage;
  - verifier validity and cleanup.
- [ ] Ask for concrete P0/P1 findings with file/line evidence; do not request broad style refactoring or a second architecture redesign.
- [ ] Correct substantive findings once, rerun the focused tests and live check affected by the correction, and stop the review loop after that correction pass unless a new P0 is proven.

### 5.5 On PASS only, update current state

- [ ] Add a concise factual checkpoint to `docs/current-state.md` stating:
  - date of the gate;
  - admitted Codex version/artifact identity;
  - exact runtime image identity and workspace generation used;
  - private-home canary denial passed for native Codex tool subprocesses;
  - exact Git functionality passed;
  - concurrent Codex processes against the shared native home passed;
  - the structured app-server path is still the shipped/default path at this checkpoint;
  - the next architectural implementation plan is native CLI session lifecycle/persistence, not deletion of the old path.
- [ ] Do not claim browser Workbench CLI support, native resume, passive session binding, or Agent-restart recovery; those are not implemented by this plan.

### 5.6 Run the full repository verification only after the live gate passes

- [ ] Run the repository verification contract:

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

- [ ] If a full-gate failure is unrelated/flaky, gather evidence before changing code. Do not broaden the slice without a proven causal link.

### 5.7 Final diff/evidence gate and commit the PASS checkpoint

- [ ] Run:

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git status --short
git rev-parse HEAD
git rev-parse origin/main
git log --oneline --decorate -n 10
```

- [ ] Verify the branch contains the approved design, this plan, the feasibility-gate implementation/tests, and the PASS current-state checkpoint only. No structured-path deletion or Workbench migration belongs here.
- [ ] Commit the current-state update separately, for example:

```bash
git add docs/current-state.md
git commit -m "docs: record Codex CLI sidecar feasibility gate"
```

- [ ] Do not merge, deploy, switch the default AI experience, or delete the old structured integration automatically. Return the evidence to Benjamin for the next decision.

---

## Gate Outcome and Follow-up Contract

A successful completion of this plan proves only the execution/security foundation:

```text
exact project image
+ exact workspace/Git
+ native shared CODEX_HOME
+ real bare Codex TUI PTYs
+ concurrent sessions
+ enforced tool denial of /codex-home
```

It deliberately does **not** prove or implement:

```text
Workbench session navigation over the CLI path
passive native-session ID correlation
persistent lightweight CLI session records
browser/Web restart attachment semantics
codex resume <native-id>
workspace-stop recovery
Agent-restart reconciliation
future live PTY reattachment after Agent restart
retirement of app-server/turn/event/credential-lease machinery
```

If the gate passes, create a separate implementation plan for the native CLI session lifecycle and persistence slice. If the gate fails, stop and revisit the approved sidecar security architecture before writing that plan.