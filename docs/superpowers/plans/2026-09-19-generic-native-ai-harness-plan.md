# Generic Native AI Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first generic native-harness slice: real Codex TUI plus one custom command, running in the existing workspace PTY, with Agent-private per-harness state, native start/resume, and reconnect, without exposing unrelated credentials.

**Architecture:** One generic runtime launches structured argv into a Docker-exec PTY in the exact workspace container. Built-in Codex is a preset; a custom harness is the same mechanism with no credentials and no resume until a real native ID exists. A single per-workspace bind-mounted slot exposes only the selected harness home. The shipped structured Codex app-server path stays default and unmodified until a later migration stage.

**Tech Stack:** TypeScript, Zod contracts, Agent `ExecutionManager` / `DockerEngineClient`, `private-state.ts`, Web SQLite/Drizzle, existing `devspace.terminal.v1` + xterm Workbench, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-19-generic-native-ai-harness-design.md`

## Global Constraints

- Base is exactly `72b52aae73afd169cc7a32271b53021a78c808ef` (`origin/main`) unless origin/main has legitimately advanced; do not merge or modify `feat/codex-cli-app-server-code-mode-implementation` (`caaaf0d24cfe7e171b17d5ee58fb0afdf23a21e2`) or any other Codex feasibility branch.
- Do not start old Task 11/12, do not run a real model compatibility probe, and do not retarget Codex to 0.153.4.
- Browser talks only to Web; Web is the sole SQLite writer; Agent owns Docker, PTY, and private harness state.
- Launch and resume are structured `{ executable, args[] }` only. Never `sh -c`, never string-concatenated shell lines, never host paths in argv.
- `{sessionId}` is a whole argv token. Native provider session IDs never enter SQLite, browser payloads, URLs, or logs.
- Private state lives under `<agent-state-root>/harness-homes/<harnessId>/` and is exposed only via `<agent-state-root>/harness-slots/<workspaceId>/` bind-mounted at `/opt/devspace/harness-home`. Never write auth/session files into `/workspace`.
- Only the selected harness home is materialized into the slot. Codex launch must not receive Claude/Gemini/custom credentials; custom launch receives no credentials by default.
- One live native harness PTY per workspace. Reject a second Start. Do not run a live structured app-server session and a live native harness on the same workspace.
- First slice implements builtin Codex plus one custom harness. Claude/Gemini/OpenCode presets, secret-id env, PTY multiplexers, F11 turn cards on this path, and structured-path deletion are out of scope.
- Existing ADR 015 structured Codex Workbench remains shipped. This slice adds a parallel native runtime kind; it does not delete `codex-app-server/`, F11, or the current AI cards.
- Reuse `ExecutionManager`, F09 terminal frames, xterm `TerminalTab`, and `private-state.ts`. Do not add a second PTY stack or a universal structured-event bus.
- After Agent restart, native PTYs are `lost`. Resume is offered only when a real native ID was discovered. Do not fake process survival.

## Review Focus

- A custom harness whose resume template is present but whose native ID was never discovered must not advertise Resume and must not exec a placeholder or DevSpace UUID.
- Slot writeback after a crash must restore bytes to the recorded owner harness and must never copy Codex slot files into a custom/Claude home.
- `{sessionId}` substitution must reject IDs with ASCII controls, NUL, leading `-`, or length > 512, and must insert the ID as exactly one argv element.
- A live `/bin/sh` terminal on the same workspace must not receive `CODEX_HOME` from a harness launch; only the harness exec environment does. After harness stop, the slot must be empty so a later shell does not keep leftover auth.
- Browser create/resume requests that include a native session ID, host path, or shell string must fail closed as malformed; the client cannot supply private-plane launch authority.

---

## File map

Create:

- `packages/contracts/src/harness.ts` — public harness definition and session control-plane schemas
- `packages/domain/src/harness-argv.ts` — argv / `{sessionId}` substitution (or live in contracts if that matches local pattern)
- `apps/agent/src/harness-home.ts` — private homes, slots, materialize/writeback
- `apps/agent/src/harness-runtime.ts` — start/resume/settle, discovery, isolation
- `apps/agent/src/harness-codex-discovery.ts` — Codex sessions-dir adapter
- `apps/web/src/server/harness-sessions.ts` — Web create/resume/list for native sessions
- `apps/web/src/app/harness-session-tab.tsx` — xterm AI surface for native runtime kind

Modify:

- `packages/contracts/src/endpoints.ts` and `shapes.ts` — harness inspect/create/start/resume/stop
- `packages/database/src/schema.ts` — `harness_definitions`, native runtime kind on `ai_sessions`
- `apps/agent/src/execution-manager.ts` — structured command + env for harness execs
- `apps/agent/src/docker-runtime.ts` — workspace container slot bind-mount
- `apps/agent/src/server.ts` — new Agent routes
- `apps/web/src/server/agent-client.ts` — client methods
- `apps/web/src/app/ai-session-tab.tsx` / `project-workbench.tsx` — native vs legacy switch
- `docs/architecture.md` and a draft `docs/decisions/016-generic-native-ai-harnesses.md` at the end of the slice (not in this design-only commit)

Do not modify:

- `apps/agent/src/codex-app-server/**` except read-only reuse of artifact staging
- feasibility worktrees
- Project Options `aiProfile` (remains dormant)

---

### Task 1: Argv, resume template, and native-ID validation

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

export function assertNativeSessionId(value: string): string;
export function substituteResumeArgv(template: HarnessArgv, nativeSessionId: string): HarnessArgv;
```

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, expect, test } from "vitest";
import {
  harnessArgvSchema,
  substituteResumeArgv,
  assertNativeSessionId
} from "./harness.js";

test("rejects host paths and shell-like executables", () => {
  expect(harnessArgvSchema.safeParse({ executable: "/usr/bin/codex", args: [] }).success).toBe(false);
  expect(harnessArgvSchema.safeParse({ executable: "codex;id", args: [] }).success).toBe(false);
  expect(harnessArgvSchema.safeParse({ executable: "codex", args: ["resume"] }).success).toBe(true);
});

test("substitutes {sessionId} as exactly one argv token", () => {
  const out = substituteResumeArgv(
    { executable: "codex", args: ["resume", "{sessionId}"] },
    "0196abc-native"
  );
  expect(out).toEqual({ executable: "codex", args: ["resume", "0196abc-native"] });
});

test("rejects interpolation inside another token", () => {
  expect(() =>
    substituteResumeArgv({ executable: "codex", args: ["resume={sessionId}"] }, "abc")
  ).toThrow(/placeholder/);
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

- [ ] **Step 3: Implement the schemas and substitution.** Reject any args element that contains `{sessionId}` unless the element is exactly `{sessionId}`. Require at most one placeholder. `assertNativeSessionId` trims, then applies: length 1..512, no code points ≤ 0x1f or 0x7f, no NUL, no leading `-`.

- [ ] **Step 4: Re-run the test and confirm it passes.**

```bash
pnpm exec vitest run packages/contracts/src/harness.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/harness.ts packages/contracts/src/harness.test.ts packages/contracts/src/index.ts
git commit -m "$(cat <<'EOF'
feat(contracts): add generic harness argv and native session-id rules

EOF
)"
```

---

### Task 2: Agent-private harness homes and workspace slot

**Files:**

- Create: `apps/agent/src/harness-home.ts`
- Create: `apps/agent/src/harness-home.test.ts`
- Modify: none of the Codex authority files

**Interfaces:**

- Consumes: `establishPinnedDirectory`, `durableJsonWriter`, `readRegularFileNoFollow` from `private-state.ts`.
- Produces:

```ts
export interface HarnessHomeStore {
  materialize(input: {
    workspaceId: string;
    harnessId: string;
  }): Promise<{ containerPath: "/opt/devspace/harness-home"; slotHostPath: string }>;
  writeBackAndClear(input: { workspaceId: string }): Promise<void>;
  persistentHomePath(harnessId: string): string;
}
export function createHarnessHomeStore(stateRoot: string): HarnessHomeStore;
```

Layout:

```text
<stateRoot>/harness-homes/<harnessId>/
<stateRoot>/harness-slots/<workspaceId>/
<stateRoot>/harness-meta/<workspaceId>.json
```

Directories `0700`, files `0600`, Agent-owned. `harnessId` and `workspaceId` must be ConfigurationKey / UUIDv7 so they cannot escape the directory.

- [ ] **Step 1: Write the failing tests** covering: materialize copies only the selected home; a second materialize for another harness writebacks the first and never leaves `auth.json` from Codex in a custom slot; writeback after simulated crash uses the recorded owner; refusing to write harness A bytes into harness B; rejecting a `harnessId` with `..`.

```ts
test("codex materialize does not expose a sibling claude auth file", async () => {
  await writeAuth(home.persistentHomePath("codex"), "codex-secret");
  await writeAuth(home.persistentHomePath("claude"), "claude-secret");
  const slot = await home.materialize({ workspaceId, harnessId: "codex" });
  const names = await readdir(slot.slotHostPath);
  expect(names).not.toContain("claude");
  expect(await readFile(path.join(slot.slotHostPath, "auth.json"), "utf8")).toBe("codex-secret");
});
```

- [ ] **Step 2: Run RED.**

```bash
pnpm exec vitest run apps/agent/src/harness-home.test.ts
```

Expected: FAIL, module missing.

- [ ] **Step 3: Implement copy-in/copy-out with no-follow reads, bounded file size (reuse Codex auth max for `auth.json`; a larger but still bounded budget for session jsonl, documented in the test). Empty the slot after writeback.

- [ ] **Step 4: Run GREEN.**

```bash
pnpm exec vitest run apps/agent/src/harness-home.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/harness-home.ts apps/agent/src/harness-home.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add isolated per-harness homes and workspace slots

EOF
)"
```

---

### Task 3: Bind-mount the slot into the workspace development container

**Files:**

- Modify: `apps/agent/src/docker-runtime.ts`
- Modify: `apps/agent/src/docker-runtime.test.ts`
- Modify: `apps/agent/src/workspace-runtime.ts` (pass slot host path at container create)
- Modify: `apps/agent/src/workspace-runtime.test.ts`

**Interfaces:**

- Consumes: `HarnessHomeStore` slot path for the workspace.
- Produces: every development container HostConfig.Mounts includes, in addition to `/workspace`:

```ts
{
  Type: "bind",
  Source: slotHostPath,
  Target: "/opt/devspace/harness-home",
  ReadOnly: false,
  BindOptions: { Propagation: "rprivate" }
}
```

No other `harness-homes/` path is mounted. The slot directory is created empty at workspace start.

- [ ] **Step 1: Write the failing test** on `createContainer` serialization: mounts are exactly `/workspace` plus `/opt/devspace/harness-home`; source is the Agent slot path; no `CODEX_HOME` is injected into the **container** env (only later into the harness exec).

- [ ] **Step 2: Run RED.**

```bash
pnpm exec vitest run apps/agent/src/docker-runtime.test.ts apps/agent/src/workspace-runtime.test.ts
```

Expected: FAIL because the extra mount is absent.

- [ ] **Step 3: Add the mount. Create the empty slot directory through `HarnessHomeStore` before `createContainer`. Do not mount the Docker socket or Agent socket.

- [ ] **Step 4: Run GREEN.** Same command. Expected: PASS, and existing workspace create tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/docker-runtime.ts apps/agent/src/docker-runtime.test.ts apps/agent/src/workspace-runtime.ts apps/agent/src/workspace-runtime.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): mount a single harness slot into workspace containers

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

### Task 5: Codex builtin preset, private env, and session discovery

**Files:**

- Create: `apps/agent/src/harness-presets.ts`
- Create: `apps/agent/src/harness-codex-discovery.ts`
- Create: `apps/agent/src/harness-codex-discovery.test.ts`
- Create: `apps/agent/src/harness-runtime.ts`
- Create: `apps/agent/src/harness-runtime.test.ts`

**Interfaces:**

- Consumes: Codex artifact staging (`resolveCodexExecutionArtifact` / stager) so `executable` resolves inside the container; `HarnessHomeStore`; `ExecutionManager.createHarness`; `assertNativeSessionId`.
- Produces:

```ts
export const CODEX_HARNESS_ID = "codex";
export const CODEX_PRESET = {
  id: "codex",
  launch: { executable: "codex", args: [] },
  resume: { executable: "codex", args: ["resume", "{sessionId}"] },
  privateState: { kind: "dedicated-home", env: { CODEX_HOME: "/opt/devspace/harness-home" } }
} as const;

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

test("codex launch env contains CODEX_HOME and not CLAUDE_CONFIG_DIR", async () => {
  const env = await runtime.start({ harnessId: "codex", workspaceId, projectId, sessionId });
  expect(env.CODEX_HOME).toBe("/opt/devspace/harness-home");
  expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(env.HOME).not.toBe("/opt/devspace/harness-home"); // Codex uses CODEX_HOME only
});
```

Use fixture jsonl matching current Codex session files closely enough to extract an ID; keep the parser tiny. If the on-disk format in the managed artifact is `session_index.jsonl`, prefer that over a full transcript walk.

- [ ] **Step 2: Run RED.**

```bash
pnpm exec vitest run apps/agent/src/harness-codex-discovery.test.ts apps/agent/src/harness-runtime.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement preset + discovery + start path: materialize `codex` home, resolve artifact into the container, `createHarness` with `["<codex-entrypoint>"]` or `PATH` that contains the staged artifact, env `{ TERM, CODEX_HOME }`. After process exit, discover and store the native ID in Agent-private `harness-sessions/<aiSessionId>.json` only.

- [ ] **Step 4: Run GREEN.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/harness-presets.ts apps/agent/src/harness-codex-discovery.ts apps/agent/src/harness-codex-discovery.test.ts apps/agent/src/harness-runtime.ts apps/agent/src/harness-runtime.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add Codex native-harness preset and session discovery

EOF
)"
```

---

### Task 6: Custom harness definitions without credentials or invented resume

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
    z.strictObject({ kind: z.literal("literal"), value: z.string().max(4096) })
  ).default({}),
  privateState: z.strictObject({ kind: z.literal("none") }).default({ kind: "none" })
});
```

SQLite table `harness_definitions` stores only this public shape. No secret values, no host paths, no native IDs.

Agent start for custom: exec `launch` from image PATH, env = literals + `TERM` only, no slot materialize when `privateState.kind = "none"`. Capability `resume` is false unless Agent-private metadata already has a native ID (impossible in slice 1 without discovery — keep the resume template stored for later, never advertised).

- [ ] **Step 1: Write failing tests.**

```ts
test("custom start does not set CODEX_HOME", async () => {
  const env = await runtime.start({ harnessId: "my-agent", ... });
  expect(env.CODEX_HOME).toBeUndefined();
  expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
});

test("custom with resume template but no native id reports resume: false", async () => {
  const projection = await runtime.inspect({ harnessId: "my-agent", workspaceId, sessionId });
  expect(projection.capabilities.resume).toBe(false);
});

test("resume with no native id fails closed and does not exec", async () => {
  await expect(runtime.resume({ sessionId, harnessId: "my-agent" }))
    .rejects.toMatchObject({ code: "AI_CAPABILITY_UNSUPPORTED" });
  expect(createdExecs).toHaveLength(0);
});
```

Also a schema test that `{ kind: "secret" }` env bindings are rejected.

- [ ] **Step 2: Run RED** on the new tests.

- [ ] **Step 3: Implement Web persistence (actor-owned, instance-level, not in the project) and Agent validation. `id` must not collide with `codex`.

- [ ] **Step 4: Run GREEN**, plus `pnpm schema:check` / `pnpm db:migrate:test` if the migration was added.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/harness.ts packages/database/src/schema.ts packages/database/src/schema.test.ts packages/database/migrations apps/web/src/server/harness-definitions.ts apps/web/src/server/harness-definitions.test.ts apps/agent/src/harness-runtime.ts apps/agent/src/harness-runtime.test.ts
git commit -m "$(cat <<'EOF'
feat: persist custom harness definitions without credential access

EOF
)"
```

---

### Task 7: Native resume for Codex using the stored private ID

**Files:**

- Modify: `apps/agent/src/harness-runtime.ts`
- Modify: `apps/agent/src/harness-runtime.test.ts`
- Modify: `packages/contracts/src/endpoints.ts` (resume route if a native-specific action is cleaner than overloading F11 `ai-session.resume`)

Prefer a distinct Agent operation name `harness-session.resume` so ADR 015 resume semantics are not overloaded. Public browser action remains `{ action: "resume", workspaceId, sessionId }` with only DevSpace IDs.

**Interfaces:**

- Consumes: private `nativeSessionId`, `substituteResumeArgv`, slot materialize.
- Produces: new PTY generation; same DevSpace session ID.

- [ ] **Step 1: Write failing tests.** After a start+exit that discovered `"thread-live"`, resume execs `["codex", "resume", "thread-live"]` (or the staged entrypoint plus those args), with `CODEX_HOME` set, and the browser-facing request object has no `nativeSessionId` field.

Add the review-focus case: a request that includes `nativeSessionId` is malformed.

- [ ] **Step 2: Run RED.**

- [ ] **Step 3: Implement. One live harness per workspace: resume while live is a conflict. After Agent restart (`lost`), resume is allowed if the private ID remains.

- [ ] **Step 4: Run GREEN.**

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/harness-runtime.ts apps/agent/src/harness-runtime.test.ts packages/contracts/src/endpoints.ts packages/contracts/src/shapes.ts
git commit -m "$(cat <<'EOF'
feat(agent): resume native Codex sessions by private provider id

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

- [ ] **Step 1: Write failing route tests** for happy create, reject extra fields, reject live-session conflict, and prove `external_session_id` stays null.

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
- Start / Resume (disabled when `capabilities.resume === false`) / disconnect.
- xterm uses `devspace.terminal.v1` against the bound terminal.
- Web restart: tab reloads, reattaches if state is `active`/`disconnected`.
- No composer, no approval cards, no fake transcript.

- [ ] **Step 1: Write failing UI/unit tests** for Resume disabled without capability, Start posting only `{ harnessId, workspaceId }`, and attachable states matching `terminal-lifecycle.ts`.

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

### Task 10: Agent-restart loss, slot writeback, and isolation regression pack

**Files:**

- Modify: `apps/agent/src/execution-manager.ts` (harness kind uses the same lost-on-recover path as terminals)
- Modify: `apps/agent/src/harness-home.test.ts`
- Modify: `apps/agent/src/harness-runtime.test.ts`
- Create: `apps/agent/src/harness-isolation.test.ts`

**Interfaces:** Unchanged. This task pins the review-focus failures.

- [ ] **Step 1: Write failing tests** if any are missing:

  1. Recovered harness execution record becomes `lost`; Resume still possible when private ID exists.
  2. Dirty slot after crash writebacks to the recorded `harnessId` only.
  3. Custom exec env snapshot never contains `CODEX_HOME` even if a Codex home exists on disk.
  4. After harness stop, slot directory is empty.
  5. `createTerminal` exec env does not include `CODEX_HOME`.
  6. Native ID is absent from Agent public snapshot JSON.

- [ ] **Step 2: Run RED on any new assertions.**

```bash
pnpm exec vitest run apps/agent/src/harness-isolation.test.ts apps/agent/src/harness-home.test.ts apps/agent/src/harness-runtime.test.ts
```

- [ ] **Step 3: Fix gaps (likely writeback-on-lost and slot clear). Do not add a PTY multiplexer.

- [ ] **Step 4: Run GREEN.**

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/harness-isolation.test.ts apps/agent/src/harness-home.ts apps/agent/src/harness-runtime.ts apps/agent/src/execution-manager.ts
git commit -m "$(cat <<'EOF'
test(agent): pin harness isolation, lost-pty, and slot writeback

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

- [ ] **Step 1: Write the ADR and harness-session contract so they match the code actually shipped in Tasks 1–10 (argv schema names, routes, slot path).**
- [ ] **Step 2: Grep for leftover claims that structured JSONL is the only AI path.**
- [ ] **Step 3: Run `pnpm workspace:check` and the focused tests from Tasks 1–10.**
- [ ] **Step 4: Commit docs with the implementation branch, not with this design-only commit.**

This task is listed so the first implementation slice cannot ship code without the durable-doc update. It is not executed by the design-only change that adds this plan.

---

## Out of scope for this plan (later slices)

- Claude Code, Gemini CLI, OpenCode builtin presets (spec §5.4 table).
- Custom file-basename discovery.
- Secret-id environment bindings.
- Persistent PTY multiplexer across Agent restart.
- Safe individual harness kill / supervisor.
- Default-switch and retirement of structured Codex (spec §14 Stages 3–4).
- Any work on the Code Mode / split-execution feasibility branches.

## Spec coverage

| Spec requirement | Task |
| --- | --- |
| Structured argv / `{sessionId}` token | 1, 7 |
| Agent-private homes + one slot | 2, 3 |
| PTY reuse / start | 4, 9 |
| Codex builtin + discovery + resume | 5, 7 |
| Custom launch, no credentials, no fake resume | 6 |
| Web/Agent routes, SQLite kind, attach | 8, 9 |
| Isolation, lost-on-Agent-restart | 10 |
| Durable docs during implementation | 11 |
| Migration without deletion | 8, 9 (parallel path); Stage 4 not in this plan |

## Execution note

This plan is the first generic slice only. After it is implemented and dogfooded, write a separate plan for Claude/Gemini presets and a separate plan for structured-path retirement. Do not extend this plan in place into those stages.
