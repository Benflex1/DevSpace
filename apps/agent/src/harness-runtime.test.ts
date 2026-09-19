import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createHarnessHomeStore } from "./harness-home.js";
import { createHarnessRuntime } from "./harness-runtime.js";
import type { HarnessSlotMountObservation } from "./workspace-runtime.js";

const projectId = "018f1f34-7000-7000-8000-000000000001";
const workspaceId = "018f1f34-7000-7000-8000-000000000002";
const wsB = "018f1f34-7000-7000-8000-00000000000b";
const sessionId = "018f1f34-7000-7000-8000-000000000003";
const processId = "018f1f34-7000-7000-8000-000000000004";
const terminalId = "018f1f34-7000-7000-8000-000000000005";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(input: {
  slot?: HarnessSlotMountObservation;
  recreate?: () => Promise<HarnessSlotMountObservation>;
  imageHasCodex?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-runtime-"));
  roots.push(root);
  const home = createHarnessHomeStore(root);
  const createdExecs: Array<{ command: readonly string[]; environment: Record<string, string> }> = [];
  let slot: HarnessSlotMountObservation = input.slot ?? { state: "present-and-exact" };
  const runtime = createHarnessRuntime({
    home,
    stateRoot: root,
    createHarnessExec: async (exec) => {
      createdExecs.push({ command: exec.command, environment: { ...exec.environment } });
    },
    inspectSlot: async () => slot,
    recreateWorkspace: input.recreate ?? (async (workspace) => {
      void workspace;
      throw new Error("recreate-not-configured");
    }),
    imageCodex: { present: input.imageHasCodex !== false, version: "0.155.1" },
    artifact: { available: true, version: "0.145.0", command: ["/opt/codex/codex"] }
  });
  return { runtime, home, createdExecs, setSlot: (next: HarnessSlotMountObservation) => { slot = next; }, root };
}

test("codex launch env contains CODEX_HOME and not CLAUDE_CONFIG_DIR", async () => {
  const { runtime, createdExecs } = await fixture();
  const env = await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  expect(env.CODEX_HOME).toBe("/opt/devspace/harness-home");
  expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(env.HOME).not.toBe("/opt/devspace/harness-home");
  expect(createdExecs[0]?.command).toEqual(["codex"]);
});

test("image codex wins over artifact on start", async () => {
  const { createdExecs, runtime } = await fixture({ imageHasCodex: true });
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  expect(createdExecs[0]?.command[0]).toBe("codex");
  expect(await runtime.publicSnapshot(sessionId)).toMatchObject({
    executableSource: { kind: "image-path", command: "codex", reportedVersion: "0.155.1" }
  });
});

test("custom start does not set CODEX_HOME and does not acquire a home lease", async () => {
  const { runtime, createdExecs, home } = await fixture();
  runtime.registerCustom({
    id: "my-agent", displayName: "My Agent", origin: "custom",
    launch: { executable: "my-agent", args: [] }, resume: null, environment: {}, privateState: { kind: "none" }
  });
  const env = await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "my-agent", processId, terminalId, processGeneration: 1
  });
  expect(env.CODEX_HOME).toBeUndefined();
  expect(createdExecs[0]?.environment.CODEX_HOME).toBeUndefined();
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).resolves.toMatchObject({ leaseId: expect.any(String) });
});

test("custom provider-handled resume is offered without a native id", async () => {
  const { runtime, createdExecs } = await fixture();
  runtime.registerCustom({
    id: "my-agent-continue", displayName: "Continue", origin: "custom",
    launch: { executable: "my-agent", args: [] },
    resume: { executable: "my-agent", args: ["--resume"] },
    environment: {}, privateState: { kind: "none" }
  });
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "my-agent-continue", processId, terminalId, processGeneration: 1
  });
  await runtime.settleExit({ sessionId });
  expect((await runtime.inspect({ harnessId: "my-agent-continue", workspaceId, sessionId })).capabilities.resume).toBe(true);
  const result = await runtime.resumeExec({
    sessionId, projectId, processId: "018f1f34-7000-7000-8000-000000000006",
    terminalId: "018f1f34-7000-7000-8000-000000000007", processGeneration: 2
  });
  expect(result.command).toEqual(["my-agent", "--resume"]);
  expect(createdExecs[1]?.command).toEqual(["my-agent", "--resume"]);
});

test("id-substitution resume with no native id fails closed and does not exec", async () => {
  const { runtime, createdExecs } = await fixture();
  runtime.registerCustom({
    id: "my-agent-id", displayName: "Id", origin: "custom",
    launch: { executable: "my-agent", args: [] },
    resume: { executable: "my-agent", args: ["--resume", "{sessionId}"] },
    environment: {}, privateState: { kind: "none" }
  });
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "my-agent-id", processId, terminalId, processGeneration: 1
  });
  await runtime.settleExit({ sessionId });
  expect((await runtime.inspect({ harnessId: "my-agent-id", workspaceId, sessionId })).capabilities.resume).toBe(false);
  const before = createdExecs.length;
  await expect(runtime.resumeExec({
    sessionId, projectId, processId: "018f1f34-7000-7000-8000-000000000006",
    terminalId: "018f1f34-7000-7000-8000-000000000007", processGeneration: 2
  })).rejects.toMatchObject({ code: "AI_CAPABILITY_UNSUPPORTED" });
  expect(createdExecs).toHaveLength(before);
});

test("second workspace cannot start Codex while the home is leased", async () => {
  const { runtime, createdExecs } = await fixture();
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  await expect(runtime.start({
    projectId, workspaceId: wsB, sessionId: "018f1f34-7000-7000-8000-000000000023",
    harnessId: "codex", processId: "018f1f34-7000-7000-8000-000000000024",
    terminalId: "018f1f34-7000-7000-8000-000000000025", processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_HOME_IN_USE" });
  expect(createdExecs).toHaveLength(1);
});

test("codex start with missing slot does not exec and recreates then launches", async () => {
  let recreates = 0;
  const { runtime, createdExecs, setSlot } = await fixture({
    slot: { state: "missing" },
    recreate: async () => {
      recreates += 1;
      setSlot({ state: "present-and-exact" });
      return { state: "present-and-exact" };
    }
  });
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  expect(recreates).toBe(1);
  expect(createdExecs).toHaveLength(1);
});

test("agent restart discovers a native id from the recovered persistent home", async () => {
  const { runtime, home, root } = await fixture();
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  const slot = path.join(root, "harness-slots", workspaceId);
  await mkdir(path.join(slot, "sessions"), { recursive: true });
  await writeFile(path.join(slot, "sessions", "thread-crash.jsonl"), `${JSON.stringify({ id: "thread-crash", cwd: "/workspace" })}\n`);
  await runtime.recoverAfterAgentRestart();
  expect(await runtime.privateNativeId(sessionId)).toBe("thread-crash");
  expect(await runtime.publicSnapshot(sessionId)).toMatchObject({ state: "lost" });
  expect(JSON.stringify(await runtime.publicSnapshot(sessionId))).not.toContain("thread-crash");
  expect((await runtime.inspect({ harnessId: "codex", workspaceId, sessionId })).capabilities.resume).toBe(true);
  expect(await home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).toMatchObject({ leaseId: expect.any(String) });
});

test("agent restart does not invent an id when discovery finds nothing", async () => {
  const { runtime } = await fixture();
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  await runtime.recoverAfterAgentRestart();
  expect(await runtime.privateNativeId(sessionId)).toBeNull();
  expect((await runtime.inspect({ harnessId: "codex", workspaceId, sessionId })).capabilities.resume).toBe(false);
});

test("codex resume after discovery execs resume argv with native id", async () => {
  const { runtime, createdExecs, root } = await fixture();
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  const slot = path.join(root, "harness-slots", workspaceId);
  await mkdir(path.join(slot, "sessions"), { recursive: true });
  await writeFile(path.join(slot, "sessions", "thread-live.jsonl"), `${JSON.stringify({ id: "thread-live", cwd: "/workspace" })}\n`);
  await runtime.settleExit({ sessionId });
  const result = await runtime.resumeExec({
    sessionId, projectId, processId: "018f1f34-7000-7000-8000-000000000016",
    terminalId: "018f1f34-7000-7000-8000-000000000017", processGeneration: 2
  });
  expect(result.command).toEqual(["codex", "resume", "thread-live"]);
  expect(createdExecs.at(-1)?.command).toEqual(["codex", "resume", "thread-live"]);
  expect(createdExecs.at(-1)?.environment.CODEX_HOME).toBe("/opt/devspace/harness-home");
});

test("custom privateState none may start when the slot is missing", async () => {
  const { runtime, createdExecs } = await fixture({ slot: { state: "missing" } });
  runtime.registerCustom({
    id: "my-agent", displayName: "My Agent", origin: "custom",
    launch: { executable: "my-agent", args: [] }, resume: null, environment: {}, privateState: { kind: "none" }
  });
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "my-agent", processId, terminalId, processGeneration: 1
  });
  expect(createdExecs).toHaveLength(1);
});
