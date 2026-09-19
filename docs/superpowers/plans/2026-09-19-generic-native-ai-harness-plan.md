# Generic Native AI Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first generic native-harness slice: real Codex TUI plus one custom command, running in the existing workspace PTY, with Agent-private per-harness state, exclusive home lease, native start/resume (including provider-handled resume), and reconnect, without writing credentials into `/workspace`.

**Architecture:** One generic runtime launches structured argv into a Docker-exec PTY in the exact workspace container. Built-in Codex is a preset; a custom harness is the same mechanism. A single per-workspace bind-mounted slot exposes only the selected harness home, under an exclusive Agent-owned home lease. Resume is offered for zero-placeholder templates without a DevSpace ID, and for one-placeholder templates only when a real native ID exists. The shipped structured Codex app-server path stays default and unmodified until a later migration stage.

**Tech Stack:** TypeScript, Zod contracts, Agent `ExecutionManager` / `DockerEngineClient`, `private-state.ts`, local `.lease` directory exclusive lock, Web SQLite/Drizzle, existing `devspace.terminal.v1` + xterm Workbench, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-19-generic-native-ai-harness-design.md`

## Global Constraints

- Base is exactly `72b52aae73afd169cc7a32271b53021a78c808ef` (`origin/main`) unless origin/main has legitimately advanced; do not merge or modify `feat/codex-cli-app-server-code-mode-implementation` (`caaaf0d24cfe7e171b17d5ee58fb0afdf23a21e2`) or any other Codex feasibility branch.
- Do not start old Task 11/12, do not run a real model compatibility probe, and do not retarget Codex to 0.153.4.
- Browser talks only to Web; Web is the sole SQLite writer; Agent owns Docker, PTY, and private harness state.
- Launch and resume are structured `{ executable, args[] }` only. Never `sh -c`, never string-concatenated shell lines, never host paths in argv.
- `{sessionId}` is a whole argv token. Zero placeholders → provider-handled resume. Exactly one placeholder → require a real native ID. More than one, or interpolation inside another token → reject the definition. Native provider session IDs never enter SQLite, browser payloads, URLs, or logs.
- Private state lives under `<agent-state-root>/harness-homes/<harnessId>/` and is exposed only via `<agent-state-root>/harness-slots/<workspaceId>/` bind-mounted at `/opt/devspace/harness-home`. Never write auth/session files into `/workspace`.
- A persistent home is exclusively leased while materialized/live. First slice rejects a second workspace with `HARNESS_HOME_IN_USE`. No distributed lock.
- Only the selected harness home is materialized into the slot. Codex launch must not receive Claude/Gemini/custom credentials in its env or slot. Custom launch receives no credentials by default. A populated slot **is** readable by other processes in the same container; do not claim otherwise.
- One live native harness PTY per workspace. Reject a second Start. Do not run a live structured app-server session and a live native harness on the same workspace.
- Builtin Codex prefers workspace-image `codex` on PATH; Agent-managed artifact is fallback only. Record `executableSource.kind`. Do not silently substitute the artifact when image `codex` exists. No native-TUI version floor.
- Slot-mount missing/mismatch on a dedicated-home harness uses existing workspace stop/start (new generation). Never mutate mounts on a created container. Never exec without the required mount.
- Copy-in/copy-out follows spec §6.8: regular files/directories only, no symlinks/specials, depth ≤ 16, files ≤ 4096, file ≤ 32 MiB, tree ≤ 256 MiB, atomic writeback. Fail closed on unsupported contents.
- First slice implements builtin Codex plus one custom harness. Claude/Gemini/OpenCode presets, secret-id env, PTY multiplexers, F11 turn cards on this path, and structured-path deletion are out of scope.
- Existing ADR 015 structured Codex Workbench remains shipped. This slice adds a parallel native runtime kind; it does not delete `codex-app-server/`, F11, or the current AI cards.
- Reuse `ExecutionManager`, F09 terminal frames, xterm `TerminalTab`, `private-state.ts`, and the Codex `.lease` directory pattern. Do not add a second PTY stack or a universal structured-event bus.
- After Agent restart, native PTYs are `lost`. Recovery writebacks the dirty slot, runs discovery, and may then offer Resume. Do not fake process survival or invent IDs.

## Review Focus

- A custom harness with `resume.args: ["--resume"]` (zero placeholders) must advertise Resume and must exec that argv without a native ID.
- A custom harness with `resume.args: ["--resume", "{sessionId}"]` and no discovered ID must not advertise Resume and must not exec a placeholder or DevSpace UUID.
- Two workspaces cannot materialize `harness-homes/codex/` at the same time; the second Start fails `HARNESS_HOME_IN_USE` and does not copy or write back.
- Agent restart with a live Codex (dirty slot, no prior discovered ID) writebacks, runs discovery on the persistent home, stores a real ID if present, leaves the session `lost`, and then allows ID-substitution Resume. Discovery failure stores nothing.
- Slot writeback after a crash restores bytes only to the recorded owner harness and never copies Codex slot files into a custom home.
- `{sessionId}` substitution rejects IDs with ASCII controls, NUL, leading `-`, or length > 512, and inserts the ID as exactly one argv element. Definitions with `{sessionId}` inside another token, or two placeholders, are rejected at parse.
- A live `/bin/sh` terminal on the same workspace must not receive `CODEX_HOME` in its exec env. The populated slot files **are** visible via `/opt/devspace/harness-home` until stop/writeback empties the slot.
- Browser create/resume requests that include a native session ID, host path, or shell string must fail closed as malformed.
- A workspace container whose inspection is `harnessSlotMount.missing` must not exec Codex. The start path must use workspace stop/start recreate and must not call Docker mount-update APIs.
- When image `codex` exists, launch must use it and record `executableSource.kind = "image-path"`, even if an Agent artifact is also configured.

---

## File map

Create:

- `packages/contracts/src/harness.ts` — public harness definition, resume classification, session control-plane schemas
- `apps/agent/src/harness-home.ts` — private homes, slots, exclusive lease, bounded copy, atomic writeback
- `apps/agent/src/harness-runtime.ts` — start/resume/settle, discovery, isolation, restart recovery
- `apps/agent/src/harness-codex-discovery.ts` — Codex sessions-dir adapter
- `apps/agent/src/harness-executable.ts` — image PATH vs artifact fallback
- `apps/web/src/server/harness-sessions.ts` — Web create/resume/list for native sessions
- `apps/web/src/app/harness-session-tab.tsx` — xterm AI surface for native runtime kind

Modify:

- `packages/contracts/src/endpoints.ts` and `shapes.ts` — harness inspect/create/start/resume/stop
- `packages/database/src/schema.ts` — `harness_definitions`, native runtime kind on `ai_sessions`
- `apps/agent/src/execution-manager.ts` — structured command + env for harness execs
- `apps/agent/src/docker-runtime.ts` — workspace container slot bind-mount
- `apps/agent/src/workspace-runtime.ts` — inspect `harnessSlotMount`; do not accept in-place mount mutation
- `apps/agent/src/server.ts` — new Agent routes
- `apps/web/src/server/agent-client.ts` — client methods
- `apps/web/src/app/ai-session-tab.tsx` / `project-workbench.tsx` — native vs legacy switch
- `docs/architecture.md` and a draft `docs/decisions/016-generic-native-ai-harnesses.md` at the end of the slice (not in this design-only commit)

Do not modify:

- `apps/agent/src/codex-app-server/**` except read-only reuse of artifact staging as fallback
- feasibility worktrees
- Project Options `aiProfile` (remains dormant)

---

### Task 1: Argv, resume classification, and native-ID validation

**Files:**

- Create: `packages/contracts/src/harness.ts`
- Create: `packages/contracts/src/harness.test.ts`
- Modify: `packages/contracts/src/index.ts` (export the new module; do not export private helpers that do not belong on the public surface)

**Interfaces:**

- Consumes: existing `ConfigurationKey` / bounded-text patterns from contracts.
- Produces:

```ts
export const harnessArgvSchema = z.strictObject({
  executable: z.string().regex(/^[A-Za-z0-9._+-]+$/).max(128),
  args: z.array(z.string().min(1).max(4096)).max(32)
});
export type HarnessArgv = z.infer<typeof harnessArgvSchema>;

export const SESSION_ID_PLACEHOLDER = "{sessionId}";

export type ResumeTemplateClass =
  | { kind: "none" }
  | { kind: "provider-handled" }
  | { kind: "native-id" };

export function classifyResumeArgv(resume: HarnessArgv | null): ResumeTemplateClass;
export function parseResumeArgv(resume: HarnessArgv): ResumeTemplateClass; // throws on invalid
export function assertNativeSessionId(value: string): string;
export function substituteResumeArgv(template: HarnessArgv, nativeSessionId: string): HarnessArgv;
export function resumeCapability(input: {
  resume: HarnessArgv | null;
  nativeSessionId: string | null;
}): boolean;
```

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, expect, test } from "vitest";
import {
  harnessArgvSchema,
  classifyResumeArgv,
  parseResumeArgv,
  substituteResumeArgv,
  assertNativeSessionId,
  resumeCapability
} from "./harness.js";

test("rejects host paths and shell-like executables", () => {
  expect(harnessArgvSchema.safeParse({ executable: "/usr/bin/codex", args: [] }).success).toBe(false);
  expect(harnessArgvSchema.safeParse({ executable: "codex;id", args: [] }).success).toBe(false);
  expect(harnessArgvSchema.safeParse({ executable: "codex", args: ["resume"] }).success).toBe(true);
});

test("zero-placeholder resume is provider-handled and resumable without an id", () => {
  const resume = { executable: "my-agent", args: ["--resume"] };
  expect(classifyResumeArgv(resume)).toEqual({ kind: "provider-handled" });
  expect(resumeCapability({ resume, nativeSessionId: null })).toBe(true);
});

test("one whole-token placeholder requires a real native id", () => {
  const resume = { executable: "codex", args: ["resume", "{sessionId}"] };
  expect(classifyResumeArgv(resume)).toEqual({ kind: "native-id" });
  expect(resumeCapability({ resume, nativeSessionId: null })).toBe(false);
  expect(resumeCapability({ resume, nativeSessionId: "thread-live" })).toBe(true);
});

test("null resume is never offered", () => {
  expect(classifyResumeArgv(null)).toEqual({ kind: "none" });
  expect(resumeCapability({ resume: null, nativeSessionId: "thread-live" })).toBe(false);
});

test("rejects interpolation inside another token and multiple placeholders", () => {
  expect(() => parseResumeArgv({ executable: "codex", args: ["resume={sessionId}"] })).toThrow(/placeholder/);
  expect(() => parseResumeArgv({
    executable: "my-agent", args: ["{sessionId}", "{sessionId}"]
  })).toThrow(/placeholder/);
});

test("substitutes {sessionId} as exactly one argv token", () => {
  const out = substituteResumeArgv(
    { executable: "codex", args: ["resume", "{sessionId}"] },
    "0196abc-native"
  );
  expect(out).toEqual({ executable: "codex", args: ["resume", "0196abc-native"] });
});

test("native id rejects controls, leading dash, empties, and oversize", () => {
  expect(() => assertNativeSessionId("-evil")).toThrow();
  expect(() => assertNativeSessionId("a\nb")).toThrow();
  expect(() => assertNativeSessionId("")).toThrow();
  expect(() => assertNativeSessionId("x".repeat(513))).toThrow();
  expect(assertNativeSessionId("thread_abc")).toBe("thread_abc");
});
```

- [ ] **Step 2: Run the test to verify it fails.**

```bash
pnpm exec vitest run packages/contracts/src/harness.test.ts
```

Expected: FAIL because `harness.ts` does not exist.

- [ ] **Step 3: Implement the schemas, `classifyResumeArgv` / `parseResumeArgv`, substitution, and `resumeCapability`. Reject any args element that contains `{sessionId}` unless the element is exactly `{sessionId}`. Require at most one placeholder. `assertNativeSessionId` trims, then applies: length 1..512, no code points ≤ 0x1f or 0x7f, no NUL, no leading `-`.

- [ ] **Step 4: Re-run the test and confirm it passes.**

```bash
pnpm exec vitest run packages/contracts/src/harness.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/harness.ts packages/contracts/src/harness.test.ts packages/contracts/src/index.ts
git commit -m "$(cat <<'EOF'
feat(contracts): classify generic harness resume argv templates

EOF
)"
```

---

### Task 2: Agent-private homes, exclusive lease, and bounded copy

**Files:**

- Create: `apps/agent/src/harness-home.ts`
- Create: `apps/agent/src/harness-home.test.ts`
- Modify: none of the Codex authority files (reuse the `.lease` *pattern*, do not overload the Codex auth lease)

**Interfaces:**

- Consumes: `establishPinnedDirectory`, `durableJsonWriter`, `readRegularFileNoFollow` from `private-state.ts`.
- Produces:

```ts
export const HARNESS_HOME_MAX_DEPTH = 16;
export const HARNESS_HOME_MAX_ENTRIES = 4096;
export const HARNESS_HOME_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const HARNESS_HOME_MAX_TREE_BYTES = 256 * 1024 * 1024;

export interface HarnessHomeStore {
  acquireLease(input: {
    harnessId: string;
    workspaceId: string;
    aiSessionId: string;
    processGeneration: number;
  }): Promise<{ leaseId: string }>;
  materialize(input: {
    workspaceId: string;
    harnessId: string;
    leaseId: string;
  }): Promise<{ containerPath: "/opt/devspace/harness-home"; slotHostPath: string }>;
  writeBackAndClear(input: { workspaceId: string; leaseId: string }): Promise<void>;
  releaseLease(input: { harnessId: string; leaseId: string }): Promise<void>;
  recoverDirtySlots(): Promise<readonly RecoveredSlot[]>;
  reapStaleLeases(): Promise<void>;
  persistentHomePath(harnessId: string): string;
}
export function createHarnessHomeStore(stateRoot: string): HarnessHomeStore;
```

Layout:

```text
<stateRoot>/harness-homes/<harnessId>/
<stateRoot>/harness-homes/<harnessId>/.lease/metadata.json
<stateRoot>/harness-slots/<workspaceId>/
<stateRoot>/harness-meta/<workspaceId>.json
```

Directories `0700`, files `0600`, Agent-owned. `harnessId` is a ConfigurationKey and `workspaceId` is UUIDv7 so they cannot escape the directory. `.lease` is created with exclusive-create semantics like `codex-credential-authority.ts`.

- [ ] **Step 1: Write the failing tests** covering the isolation, lease, and filesystem contract.

```ts
test("codex materialize does not expose a sibling claude auth file", async () => {
  await writeAuth(home.persistentHomePath("codex"), "codex-secret");
  await writeAuth(home.persistentHomePath("claude"), "claude-secret");
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId, harnessId: "codex", leaseId: lease.leaseId });
  const names = await readdir(slot.slotHostPath);
  expect(names).not.toContain("claude");
  expect(await readFile(path.join(slot.slotHostPath, "auth.json"), "utf8")).toBe("codex-secret");
});

test("second workspace cannot acquire the same harness home lease", async () => {
  await home.acquireLease({ harnessId: "codex", workspaceId: wsA, aiSessionId: sessionA, processGeneration: 1 });
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: sessionB, processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_HOME_IN_USE" });
});

test("same workspace re-acquires its lease after simulated agent restart", async () => {
  const first = await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId, processGeneration: 1 });
  const again = await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId, processGeneration: 1 });
  expect(again.leaseId).toBe(first.leaseId);
});

test("stale lease after writeback-before-release is recovered then acquired by another workspace", async () => {
  const leaseA = await home.acquireLease({
    harnessId: "codex", workspaceId: wsA, aiSessionId: sessionA, processGeneration: 1
  });
  await home.materialize({ workspaceId: wsA, harnessId: "codex", leaseId: leaseA.leaseId });
  await home.writeBackAndClear({ workspaceId: wsA, leaseId: leaseA.leaseId });
  // crash window: slot clean, .lease still present, no live process
  await home.reapStaleLeases();
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: sessionB, processGeneration: 1
  })).resolves.toMatchObject({ leaseId: expect.any(String) });
});

test("rejects symlink, special file, path escape, oversize file, and over-count trees", async () => {
  await plantSymlink(home.persistentHomePath("codex"));
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId, processGeneration: 1 });
  await expect(home.materialize({ workspaceId, harnessId: "codex", leaseId: lease.leaseId }))
    .rejects.toMatchObject({ code: "HARNESS_HOME_UNSUPPORTED" });
});

test("failed writeback leaves the previous persistent home intact and keeps the lease", async () => {
  await writeAuth(home.persistentHomePath("codex"), "previous");
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId, processGeneration: 1 });
  await home.materialize({ workspaceId, harnessId: "codex", leaseId: lease.leaseId });
  await plantUnsupportedInSlot(workspaceId);
  await expect(home.writeBackAndClear({ workspaceId, leaseId: lease.leaseId }))
    .rejects.toMatchObject({ code: "HARNESS_HOME_UNSUPPORTED" });
  expect(await readFile(path.join(home.persistentHomePath("codex"), "auth.json"), "utf8")).toBe("previous");
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: otherWorkspace, aiSessionId: otherSession, processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_HOME_IN_USE" });
});

test("rejects a harnessId with ..", async () => {
  await expect(home.acquireLease({
    harnessId: "../etc", workspaceId, aiSessionId, processGeneration: 1
  })).rejects.toThrow();
});
```

Also assert writeback after simulated crash uses the recorded owner and refuses to write harness A bytes into harness B.

- [ ] **Step 2: Run RED.**

```bash
pnpm exec vitest run apps/agent/src/harness-home.test.ts
```

Expected: FAIL, module missing.

- [ ] **Step 3: Implement exclusive `.lease` acquire/release, copy-in/copy-out with `lstat`/`O_NOFOLLOW`, spec §6.8 bounds, atomic incoming/previous rotation that does not move `.lease`, empty-slot after successful writeback, and `reapStaleLeases` for the writeback-before-release crash window. `writeBackAndClear` must not itself release the lease (release is a separate call) so that crash window is real.

- [ ] **Step 4: Run GREEN.**

```bash
pnpm exec vitest run apps/agent/src/harness-home.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/harness-home.ts apps/agent/src/harness-home.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add leased harness homes and bounded slot copy

EOF
)"
```

---

### Task 3: Bind-mount the slot and inspect runtime identity

**Files:**

- Modify: `apps/agent/src/docker-runtime.ts`
- Modify: `apps/agent/src/docker-runtime.test.ts`
- Modify: `apps/agent/src/workspace-runtime.ts` (pass slot host path at container create; inspect `harnessSlotMount`)
- Modify: `apps/agent/src/workspace-runtime.test.ts`

**Interfaces:**

- Consumes: `HarnessHomeStore` slot path for the workspace.
- Produces: every **new** development container HostConfig.Mounts includes `/workspace` plus:

```ts
{
  Type: "bind",
  Source: slotHostPath,
  Target: "/opt/devspace/harness-home",
  ReadOnly: false,
  BindOptions: { Propagation: "rprivate" }
}
```

Inspection projection:

```ts
harnessSlotMount:
  | { state: "present-and-exact" }
  | { state: "missing" }
  | { state: "mismatch" }
```

No other `harness-homes/` path is mounted. The slot directory is created empty at workspace start. There is no Docker API call that updates mounts on an existing container.

- [ ] **Step 1: Write the failing tests.**

  1. `createContainer` serialization: mounts are `/workspace` plus `/opt/devspace/harness-home`; source is the Agent slot path; no `CODEX_HOME` in **container** env.
  2. Inspect of a pre-slice fixture with only `/workspace` reports `harnessSlotMount.state === "missing"` and remains a valid ordinary terminal/task inspect (not `WORKSPACE_STATE_CONFLICT`).
  3. Inspect of a new-slice fixture whose slot source is the wrong host path reports `mismatch`.
  4. Inspect of a new-slice fixture with `/workspace` plus the exact slot reports `present-and-exact`.
  5. A new-slice container missing the slot after create is a runtime identity conflict, distinct from a pre-slice `missing` observation.
  6. No test helper or production function calls `/containers/{id}/update` or adds binds to an existing container.

- [ ] **Step 2: Run RED.**

```bash
pnpm exec vitest run apps/agent/src/docker-runtime.test.ts apps/agent/src/workspace-runtime.test.ts
```

Expected: FAIL because the extra mount and `harnessSlotMount` observation are absent.

- [ ] **Step 3: Add the mount on create. Create the empty slot directory through `HarnessHomeStore` before `createContainer`. Extend inspect. Do not mount the Docker socket or Agent socket. Keep existing workspaces that lack the mount inspectable.

- [ ] **Step 4: Run GREEN.** Same command. Expected: PASS, and existing workspace create tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/docker-runtime.ts apps/agent/src/docker-runtime.test.ts apps/agent/src/workspace-runtime.ts apps/agent/src/workspace-runtime.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): mount and inspect the workspace harness slot

EOF
)"
```

---

### Task 4: ExecutionManager launches a structured harness PTY

**Files:**

- Modify: `apps/agent/src/execution-manager.ts`
- Modify: `apps/agent/src/execution-manager.test.ts`

**Interfaces:**

- Consumes: existing `createExec({ command, workingDirectory, environment, attachStdin, tty })`.
- Produces:

```ts
createHarness(input: {
  projectId: string;
  workspaceId: string;
  processId: string;
  terminalId: string;
  command: readonly string[];      // [executable, ...args]
  environment: Readonly<Record<string, string>>;
}): Promise<void>;
```

`workingDirectory` is always `/workspace`. `attachStdin: true`, `tty: true`. `TERM=xterm-256color` is set. Kind is `"harness"` if the execution record enum can be extended; if extending the persisted enum is too large for this task, store `kind: "terminal"` plus Agent-private harness metadata in `harness-sessions/<id>.json` and keep F09 attach unchanged.

Review-focus test: a subsequent `/bin/sh` `createTerminal` on the same workspace uses `{ TERM: "xterm-256color" }` only and does not inherit `CODEX_HOME`.

- [ ] **Step 1: Write failing tests** for structured command `["codex", "resume", "thread-1"]` reaching `createExec` as `Cmd` array (not a joined string), cwd `/workspace`, and env containing `CODEX_HOME=/opt/devspace/harness-home` only on that exec.

- [ ] **Step 2: Run RED.**

```bash
pnpm exec vitest run apps/agent/src/execution-manager.test.ts
```

Expected: FAIL, `createHarness` missing.

- [ ] **Step 3: Implement by generalizing the private `createExec` already used by `createTerminal`. Do not call `/bin/sh -c`.

- [ ] **Step 4: Run GREEN.** Expected: PASS, existing terminal tests still pass (still `/bin/sh`).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/execution-manager.ts apps/agent/src/execution-manager.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): launch harness processes as structured PTY execs

EOF
)"
```

---

### Task 5: Codex builtin preset, executable source, and session discovery

**Files:**

- Create: `apps/agent/src/harness-presets.ts`
- Create: `apps/agent/src/harness-codex-discovery.ts`
- Create: `apps/agent/src/harness-codex-discovery.test.ts`
- Create: `apps/agent/src/harness-executable.ts`
- Create: `apps/agent/src/harness-executable.test.ts`
- Create: `apps/agent/src/harness-runtime.ts`
- Create: `apps/agent/src/harness-runtime.test.ts`

**Interfaces:**

- Consumes: bounded in-container PATH lookup; Codex artifact staging as fallback; `HarnessHomeStore`; `ExecutionManager.createHarness`; `assertNativeSessionId`.
- Produces:

```ts
export const CODEX_HARNESS_ID = "codex";
export const CODEX_PRESET = {
  id: "codex",
  launch: { executable: "codex", args: [] },
  resume: { executable: "codex", args: ["resume", "{sessionId}"] },
  privateState: { kind: "dedicated-home", env: { CODEX_HOME: "/opt/devspace/harness-home" } }
} as const;

export type ExecutableSource =
  | { kind: "image-path"; command: "codex"; reportedVersion: string | null }
  | { kind: "agent-artifact"; reportedVersion: string | null };

export function resolveCodexExecutable(input: {
  imageHasCodex: boolean;
  imageReportedVersion: string | null;
  artifactAvailable: boolean;
  artifactReportedVersion: string | null;
}): ExecutableSource | { kind: "unavailable" };

export function discoverCodexNativeSessionId(homePath: string): string | null;
```

Discovery reads only `homePath/sessions` (and `session_index.jsonl` if present). It never reads `/workspace`, never reads another harness home, never reads the operator `~/.codex`. If no usable ID is found, return `null`.

- [ ] **Step 1: Write failing tests.**

```ts
test("discovers the newest workspace session id from CODEX_HOME/sessions", async () => {
  await writeCodexSession(home, { id: "old", cwd: "/workspace", mtime: 1 });
  await writeCodexSession(home, { id: "new", cwd: "/workspace", mtime: 2 });
  await writeCodexSession(home, { id: "other-project", cwd: "/elsewhere", mtime: 3 });
  expect(discoverCodexNativeSessionId(home)).toBe("new");
});

test("returns null rather than inventing an id", () => {
  expect(discoverCodexNativeSessionId(emptyHome)).toBeNull();
});

test("image codex wins over a configured agent artifact", () => {
  expect(resolveCodexExecutable({
    imageHasCodex: true, imageReportedVersion: "0.155.1",
    artifactAvailable: true, artifactReportedVersion: "0.145.0"
  })).toEqual({ kind: "image-path", command: "codex", reportedVersion: "0.155.1" });
});

test("agent artifact is used only when image codex is absent", () => {
  expect(resolveCodexExecutable({
    imageHasCodex: false, imageReportedVersion: null,
    artifactAvailable: true, artifactReportedVersion: "0.145.0"
  })).toEqual({ kind: "agent-artifact", reportedVersion: "0.145.0" });
});

test("codex launch env contains CODEX_HOME and not CLAUDE_CONFIG_DIR", async () => {
  const env = await runtime.start({ harnessId: "codex", workspaceId, projectId, sessionId });
  expect(env.CODEX_HOME).toBe("/opt/devspace/harness-home");
  expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(env.HOME).not.toBe("/opt/devspace/harness-home");
});
```

Use fixture jsonl matching current Codex session files closely enough to extract an ID; keep the parser tiny. If the on-disk format is `session_index.jsonl`, prefer that over a full transcript walk. Do not assert a minimum Codex version.

- [ ] **Step 2: Run RED.**

```bash
pnpm exec vitest run apps/agent/src/harness-codex-discovery.test.ts apps/agent/src/harness-executable.test.ts apps/agent/src/harness-runtime.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement preset + PATH-then-artifact resolution + discovery + start path: require `harnessSlotMount.present-and-exact`, acquire lease, materialize `codex` home, `createHarness` with the resolved command, env `{ TERM, CODEX_HOME }`. After process exit, discover and store the native ID in Agent-private `harness-sessions/<aiSessionId>.json` only. Record `executableSource`.

- [ ] **Step 4: Run GREEN.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/harness-presets.ts apps/agent/src/harness-codex-discovery.ts apps/agent/src/harness-codex-discovery.test.ts apps/agent/src/harness-executable.ts apps/agent/src/harness-executable.test.ts apps/agent/src/harness-runtime.ts apps/agent/src/harness-runtime.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): resolve Codex from image PATH with artifact fallback

EOF
)"
```

---

### Task 6: Custom harness definitions, including provider-handled resume

**Files:**

- Modify: `packages/contracts/src/harness.ts` (custom definition schema)
- Modify: `packages/database/src/schema.ts`
- Create: matching Drizzle migration under `packages/database/`
- Modify: `packages/database/src/schema.test.ts`
- Create: `apps/web/src/server/harness-definitions.ts`
- Create: `apps/web/src/server/harness-definitions.test.ts`
- Modify: `apps/agent/src/harness-runtime.ts` / test

**Interfaces:**

```ts
export const customHarnessDefinitionSchema = z.strictObject({
  id: configurationKeySchema,
  displayName: boundedDisplayNameSchema,
  origin: z.literal("custom"),
  launch: harnessArgvSchema,
  resume: harnessArgvSchema.nullable(),
  environment: z.record(
    z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    z.strictObject({ kind: "literal", value: z.string().max(4096) })
  ).default({}),
  privateState: z.strictObject({ kind: z.literal("none") }).default({ kind: "none" })
}).superRefine((value, ctx) => {
  if (value.resume !== null) parseResumeArgv(value.resume);
});
```

SQLite table `harness_definitions` stores only this public shape. No secret values, no host paths, no native IDs. Invalid resume templates never persist.

Agent start for custom: exec `launch` from image PATH, env = literals + `TERM` only, no slot materialize and no home lease when `privateState.kind = "none"`. Custom start does **not** require the slot mount.

- [ ] **Step 1: Write failing tests.**

```ts
test("custom start does not set CODEX_HOME and does not acquire a home lease", async () => {
  const env = await runtime.start({ harnessId: "my-agent", ... });
  expect(env.CODEX_HOME).toBeUndefined();
  expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(leaseHeld("codex")).toBe(false);
  expect(leaseHeld("my-agent")).toBe(false);
});

test("custom provider-handled resume is offered without a native id", async () => {
  const projection = await runtime.inspect({ harnessId: "my-agent-continue", workspaceId, sessionId });
  expect(projection.capabilities.resume).toBe(true);
});

test("custom id-substitution resume without a native id reports resume: false", async () => {
  const projection = await runtime.inspect({ harnessId: "my-agent-id", workspaceId, sessionId });
  expect(projection.capabilities.resume).toBe(false);
});

test("id-substitution resume with no native id fails closed and does not exec", async () => {
  await expect(runtime.resume({ sessionId, harnessId: "my-agent-id" }))
    .rejects.toMatchObject({ code: "AI_CAPABILITY_UNSUPPORTED" });
  expect(createdExecs).toHaveLength(0);
});

test("provider-handled resume execs argv unchanged", async () => {
  await runtime.resume({ sessionId, harnessId: "my-agent-continue" });
  expect(createdExecs[0].command).toEqual(["my-agent", "--resume"]);
});
```

Also a schema test that `{ kind: "secret" }` env bindings and `resume.args: ["--resume={sessionId}"]` are rejected. Custom start with only `{ executable: "my-agent", args: [] }` and `resume: null` succeeds.

- [ ] **Step 2: Run RED** on the new tests.

- [ ] **Step 3: Implement Web persistence (actor-owned, instance-level, not in the project) and Agent validation. `id` must not collide with `codex`.

- [ ] **Step 4: Run GREEN**, plus `pnpm schema:check` / `pnpm db:migrate:test` if the migration was added.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/harness.ts packages/database/src/schema.ts packages/database/src/schema.test.ts packages/database/migrations apps/web/src/server/harness-definitions.ts apps/web/src/server/harness-definitions.test.ts apps/agent/src/harness-runtime.ts apps/agent/src/harness-runtime.test.ts
git commit -m "$(cat <<'EOF'
feat: persist custom harnesses with provider-handled resume

EOF
)"
```

---

### Task 7: Native resume for Codex and missing-slot recreate

**Files:**

- Modify: `apps/agent/src/harness-runtime.ts`
- Modify: `apps/agent/src/harness-runtime.test.ts`
- Modify: `packages/contracts/src/endpoints.ts` (prefer `harness-session.resume` over overloading F11 `ai-session.resume`)
- Modify: `apps/web/src/server/harness-sessions.ts` (may land in Task 8; if so, keep the recreate test here against the runtime)

Prefer a distinct Agent operation name `harness-session.resume` so ADR 015 resume semantics are not overloaded. Public browser action remains `{ action: "resume", workspaceId, sessionId }` with only DevSpace IDs.

**Interfaces:**

- Consumes: `classifyResumeArgv`, private `nativeSessionId`, `substituteResumeArgv`, slot materialize, exclusive lease, `harnessSlotMount` observation, existing workspace stop/start.
- Produces: new PTY generation; same DevSpace session ID.

- [ ] **Step 1: Write failing tests.**

  1. After a start+exit that discovered `"thread-live"`, Codex resume execs `["codex", "resume", "thread-live"]` (image PATH command) or the fallback artifact entrypoint plus those args, with `CODEX_HOME` set, and the browser-facing request object has no `nativeSessionId` field.
  2. A request that includes `nativeSessionId` is malformed.
  3. Codex start while another workspace holds the Codex lease fails `HARNESS_HOME_IN_USE` and creates zero execs.
  4. Codex start when `harnessSlotMount.state === "missing"` does not call `createHarness`. It requests the existing workspace stop then start (new generation) and only execs after a subsequent inspect is `present-and-exact`.
  5. The missing-slot path never invokes a Docker mount-update helper (assert the test double's `updateContainer` / similar is unused and, if no such method exists, that `createContainer` is the only mount writer).
  6. Custom `privateState.kind = "none"` start on a `missing` slot **does** exec (slot not required).

- [ ] **Step 2: Run RED.**

- [ ] **Step 3: Implement. One live harness per workspace: resume while live is a conflict. After Agent restart (`lost`), resume is allowed when §8.3 allows it. Dedicated-home start requires the slot; recreate uses existing workspace stop/start only.

- [ ] **Step 4: Run GREEN.**

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/harness-runtime.ts apps/agent/src/harness-runtime.test.ts packages/contracts/src/endpoints.ts packages/contracts/src/shapes.ts
git commit -m "$(cat <<'EOF'
feat(agent): resume native sessions and recreate slotless runtimes

EOF
)"
```

---

### Task 8: Web routes, SQLite native runtime kind, and attach reuse

**Files:**

- Modify: `packages/database/src/schema.ts` (`ai_sessions` add `runtime_kind` with `'structured' | 'native-pty'`, default `'structured'` so existing rows stay valid; add `harness_id`)
- Modify: `apps/web/src/server/ai-sessions.ts` or create `apps/web/src/server/harness-sessions.ts`
- Modify: `apps/web/src/app/api/projects/[projectId]/ai/route.ts` (or a sibling `harness` route — prefer sibling so structured handlers stay untouched)
- Modify: `apps/web/src/server/agent-client.ts`
- Modify: `apps/agent/src/server.ts`
- Tests beside each

**Interfaces:**

Browser may send:

```ts
{ action: "create-native", workspaceId, harnessId }
{ action: "resume", workspaceId, sessionId }
{ action: "attach" } // existing terminal stream on the bound terminalSessionId
```

Browser must not send argv, env, native IDs, or host paths.

Create allocates `ai_sessions` + `terminal_sessions` + process, then Agent start. Attach uses the existing terminal websocket.

Concurrency: if a nonterminal structured session or native session exists for the workspace, create-native fails with a state conflict.

Safe inspect may include `executableSource: { kind, reportedVersion }` and `capabilities.resume`. It must not include native IDs.

- [ ] **Step 1: Write failing route tests** for happy create, reject extra fields, reject live-session conflict, prove `external_session_id` stays null, and prove a body containing `nativeSessionId` is malformed.

- [ ] **Step 2: Run RED.**

- [ ] **Step 3: Implement the sibling route and Agent handler. Do not change F11 JSONL event commit for structured sessions.

- [ ] **Step 4: Run GREEN** including existing `apps/web/src/app/api/projects/[projectId]/ai/route.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/database apps/web/src/server/harness-sessions.ts apps/web/src/app/api/projects/[projectId] apps/web/src/server/agent-client.ts apps/agent/src/server.ts
git commit -m "$(cat <<'EOF'
feat(web): add native harness session routes beside structured Codex

EOF
)"
```

---

### Task 9: Workbench native PTY surface and reconnect

**Files:**

- Create: `apps/web/src/app/harness-session-tab.tsx`
- Create: `apps/web/src/app/harness-session-tab.test.ts`
- Modify: `apps/web/src/app/project-workbench.tsx` / `ai-session-tab.tsx` to branch on `runtimeKind` without deleting the structured cards
- Reuse: `terminal-tab.tsx` attach logic (extract a shared hook if the file would otherwise be duplicated; do not rewrite xterm)

**Behavior:**

- Picker: Codex builtin + custom definitions.
- Start / Resume / disconnect.
- Resume enabled when `capabilities.resume === true` (covers provider-handled custom resume with no ID).
- Resume disabled when `capabilities.resume === false`.
- xterm uses `devspace.terminal.v1` against the bound terminal.
- Show `executableSource.kind` / `reportedVersion` when present; never show host paths.
- Web restart: tab reloads, reattaches if state is `active`/`disconnected`.
- No composer, no approval cards, no fake transcript.

- [ ] **Step 1: Write failing UI/unit tests** for Resume enabled on provider-handled capability without an ID field, Resume disabled without capability, Start posting only `{ harnessId, workspaceId }`, and attachable states matching `terminal-lifecycle.ts`.

- [ ] **Step 2: Run RED.**

```bash
pnpm exec vitest run apps/web/src/app/harness-session-tab.test.ts
```

- [ ] **Step 3: Implement the tab. Keep structured `AiSessionTab` reachable as "Legacy Codex session".

- [ ] **Step 4: Run GREEN.** If Playwright is the repo's browser-check for Workbench, add a fixture-only test that the native tab renders and does not call F11 turn send. Do not require a live Codex login in CI.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/harness-session-tab.tsx apps/web/src/app/harness-session-tab.test.ts apps/web/src/app/project-workbench.tsx apps/web/src/app/ai-session-tab.tsx
git commit -m "$(cat <<'EOF'
feat(web): attach Workbench xterm to native harness PTYs

EOF
)"
```

---

### Task 10: Agent-restart recovery, discovery, and isolation regression pack

**Files:**

- Modify: `apps/agent/src/execution-manager.ts` (harness kind uses the same lost-on-recover path as terminals)
- Modify: `apps/agent/src/harness-home.test.ts`
- Modify: `apps/agent/src/harness-runtime.test.ts`
- Create: `apps/agent/src/harness-isolation.test.ts`
- Create: `apps/agent/src/harness-restart-recovery.test.ts`

**Interfaces:** Unchanged. This task pins the review-focus failures, especially Agent-restart discovery.

- [ ] **Step 1: Write failing tests** if any are missing:

  1. Recovered harness execution record becomes `lost`.
  2. Dirty slot after crash writebacks to the recorded `harnessId` only, under that home's lease.
  3. After writeback, Codex discovery runs against the **persistent home**, not the emptied slot. If the recovered tree contains a `/workspace` session `thread-crash`, that ID is stored privately.
  4. If the recovered tree has no discoverable ID, stored native ID remains null (nothing invented). Provider-handled custom resume still reports `capabilities.resume === true`; Codex ID-substitution reports false.
  5. After recovery, Resume for Codex with a stored ID is allowed; the session state remains `lost` until that Resume starts a new generation.
  6. Custom exec env snapshot never contains `CODEX_HOME` even if a Codex home exists on disk.
  7. After harness stop, slot directory is empty.
  8. `createTerminal` exec env does not include `CODEX_HOME`.
  9. Native ID is absent from Agent public snapshot JSON.
  10. A dirty slot plus a live lease for **another** workspace is not written onto that other home.
  11. Image `codex` still wins over artifact on the recovered Resume launch.

```ts
test("agent restart discovers a native id from the recovered persistent home", async () => {
  await plantLiveCodexHomeInSlot(workspaceId, { id: "thread-crash", cwd: "/workspace" });
  markDirty({ workspaceId, harnessId: "codex" });
  await runtime.recoverAfterAgentRestart();
  expect(await slotEntries(workspaceId)).toEqual([]);
  expect(privateNativeId(sessionId)).toBe("thread-crash");
  expect(publicSnapshot(sessionId)).toMatchObject({ state: "lost" });
  expect(JSON.stringify(publicSnapshot(sessionId))).not.toContain("thread-crash");
  expect(inspect(sessionId).capabilities.resume).toBe(true);
});

test("agent restart does not invent an id when discovery finds nothing", async () => {
  await plantLiveCodexHomeInSlot(workspaceId, { emptySessions: true });
  markDirty({ workspaceId, harnessId: "codex" });
  await runtime.recoverAfterAgentRestart();
  expect(privateNativeId(sessionId)).toBeNull();
  expect(inspect(sessionId).capabilities.resume).toBe(false);
});
```

- [ ] **Step 2: Run RED on any new assertions.**

```bash
pnpm exec vitest run apps/agent/src/harness-isolation.test.ts apps/agent/src/harness-restart-recovery.test.ts apps/agent/src/harness-home.test.ts apps/agent/src/harness-runtime.test.ts
```

- [ ] **Step 3: Fix gaps (writeback-on-lost, discovery-after-writeback, lease release, slot clear). Do not add a PTY multiplexer.

- [ ] **Step 4: Run GREEN.**

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/harness-isolation.test.ts apps/agent/src/harness-restart-recovery.test.ts apps/agent/src/harness-home.ts apps/agent/src/harness-runtime.ts apps/agent/src/execution-manager.ts
git commit -m "$(cat <<'EOF'
test(agent): pin leased writeback and restart session discovery

EOF
)"
```

---

### Task 11: Slice documentation (implementation-time, not this design commit)

**Files:**

- Create: `docs/decisions/016-generic-native-ai-harnesses.md` (Accepted as product target; ADR 015 remains accepted for the shipped structured path)
- Modify: `docs/architecture.md` process/AI sections to describe both runtime kinds
- Modify: `docs/current-state.md` at the implementation checkpoint
- Modify: `docs/specs/` with `harness-sessions-v1.md` rather than silently overloading `ai-sessions-v1.md`

- [ ] **Step 1: Write the ADR and harness-session contract so they match the code actually shipped in Tasks 1–10 (argv schema names, resume classification, lease path, slot path, executableSource, filesystem bounds, recreate rule).**
- [ ] **Step 2: Grep for leftover claims that structured JSONL is the only AI path, that the Agent artifact always wins, that only the harness process can read credentials, or that custom resume always needs a native ID.**
- [ ] **Step 3: Run `pnpm workspace:check` and the focused tests from Tasks 1–10.**
- [ ] **Step 4: Commit docs with the implementation branch, not with this design-only commit.**

This task is listed so the first implementation slice cannot ship code without the durable-doc update. It is not executed by the design-only change that adds this plan.

---

## Out of scope for this plan (later slices)

- Claude Code, Gemini CLI, OpenCode builtin presets (spec §5.4).
- Custom file-basename discovery.
- Secret-id environment bindings.
- Persistent PTY multiplexer across Agent restart.
- Safe individual harness kill / supervisor.
- Shared concurrent harness homes across workspaces.
- Default-switch and retirement of structured Codex (spec §14 Stages 3–4).
- Any work on the Code Mode / split-execution feasibility branches.

## Spec coverage

| Spec requirement | Task |
| --- | --- |
| Structured argv / resume classification (0 or 1 `{sessionId}`) | 1, 6, 7 |
| Agent-private homes + exclusive lease + bounded copy | 2, 10 |
| Slot bind-mount + inspect `harnessSlotMount` | 3 |
| Missing-slot uses existing stop/start recreate | 7 |
| PTY reuse / start | 4, 9 |
| Codex builtin + image PATH then artifact + discovery | 5, 10 |
| Custom launch; provider-handled resume; ID resume fail-closed | 6, 7, 9 |
| Web/Agent routes, SQLite kind, attach | 8, 9 |
| Agent-restart writeback + discovery | 10 |
| Isolation claims match container boundary | 6, 10 |
| Durable docs during implementation | 11 |
| Migration without deletion | 8, 9 (parallel path); Stage 4 not in this plan |

## Execution note

This plan is the first generic slice only. After it is implemented and dogfooded, write a separate plan for Claude/Gemini presets and a separate plan for structured-path retirement. Do not extend this plan in place into those stages.
