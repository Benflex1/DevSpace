/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment -- fake exec lifecycle is synchronous. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { ExecutionManager } from "./execution-manager.js";
import { createHarnessHomeStore } from "./harness-home.js";
import { createHarnessRuntime } from "./harness-runtime.js";
import type { WorkspaceExecutionContext } from "./managed-workspaces.js";

const projectId = "018f1f34-7000-7000-8000-000000000001";
const workspaceId = "018f1f34-7000-7000-8000-000000000002";
const sessionId = "018f1f34-7000-7000-8000-000000000003";
const processId = "018f1f34-7000-7000-8000-000000000004";
const terminalId = "018f1f34-7000-7000-8000-000000000005";
const shellTerminalId = "018f1f34-7000-7000-8000-000000000006";
const wsB = "018f1f34-7000-7000-8000-00000000000b";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function context(): WorkspaceExecutionContext {
  return {
    projectId, workspaceId, revisionId: projectId, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [] }
  } as unknown as WorkspaceExecutionContext;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for harness lifecycle");
}

test("real exec exit settles once and a shell exit does not", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-lifecycle-"));
  roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const home = createHarnessHomeStore(root);
  const running = new Map<string, boolean>();
  const streams: PassThrough[] = [];
  const engine = {
    createExec: async () => `exec-${streams.length + 1}`,
    startExecAttached: async (execId: string) => {
      running.set(execId, true);
      const stream = new PassThrough();
      streams.push(stream);
      return stream;
    },
    inspectExec: async (execId: string) => ({
      ID: execId,
      Running: running.get(execId) !== false,
      ExitCode: running.get(execId) === false ? 0 : null,
      ContainerID: "container-owned"
    })
  };
  const hooks: string[] = [];
  let runtime: ReturnType<typeof createHarnessRuntime> = undefined!;
  const manager = new ExecutionManager(root, { executionContext: async () => context() } as never, engine as never, undefined, () => new Date("2026-09-24T00:00:00.000Z"), {
    onHarnessSettled: async (event) => {
      hooks.push(event.processId);
      await runtime.settleByProcess(event.processId);
    }
  });
  runtime = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async (input) => { await manager.createHarness(input); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    imageCodex: { present: true, version: "0.155.1" }
  });
  await manager.initialize();
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  expect(await runtime.publicSnapshot(sessionId)).toMatchObject({ state: "live" });
  await manager.createTerminal({ projectId, workspaceId, terminalId: shellTerminalId });
  expect(streams).toHaveLength(2);
  running.set("exec-2", false);
  streams[1]!.end();
  await waitFor(async () => manager.snapshotResources().some((resource) => resource.type === "terminal" && resource.identity.terminalId === shellTerminalId && resource.state === "closed"));
  expect(hooks).toEqual([]);
  expect(await runtime.publicSnapshot(sessionId)).toMatchObject({ state: "live" });

  const slot = path.join(root, "harness-slots", workspaceId, "sessions");
  await mkdir(slot, { recursive: true });
  await writeFile(path.join(slot, "thread-live.jsonl"), `${JSON.stringify({ id: "thread-live", cwd: "/workspace" })}\n`);
  running.set("exec-1", false);
  streams[0]!.end();
  await waitFor(async () => (await runtime.publicSnapshot(sessionId)).state === "stopped");
  expect(hooks).toEqual([processId]);
  expect(await runtime.privateNativeId(sessionId)).toBe("thread-live");
  expect(JSON.stringify(await runtime.publicSnapshot(sessionId))).not.toContain("thread-live");
  expect(await readdir(path.join(root, "harness-slots", workspaceId))).toEqual([]);
  streams[0]!.emit("end");
  streams[0]!.emit("close");
  await manager.flushHarnessSettlements();
  expect(hooks).toEqual([processId]);
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).resolves.toMatchObject({ leaseId: expect.any(String) });
  expect(await readFile(path.join(home.persistentHomePath("codex"), "sessions", "thread-live.jsonl"), "utf8")).toContain("thread-live");
});

test("agent restart recovers the slot, discovers the id, and projects lost without settleExit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-restart-"));
  roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const home = createHarnessHomeStore(root);
  const stream = new PassThrough();
  const engine = {
    createExec: async () => "exec-live",
    startExecAttached: async () => stream,
    inspectExec: async () => ({ ID: "exec-live", Running: true, ExitCode: null, ContainerID: "container-owned" })
  };
  let settled = 0;
  const manager = new ExecutionManager(root, { executionContext: async () => context() } as never, engine as never, undefined, () => new Date("2026-09-24T00:00:00.000Z"), {
    onHarnessSettled: async () => { settled += 1; }
  });
  const runtime = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async (input) => { await manager.createHarness(input); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    imageCodex: { present: true, version: null }
  });
  await manager.initialize();
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  const slot = path.join(root, "harness-slots", workspaceId, "sessions");
  await mkdir(slot, { recursive: true });
  await writeFile(path.join(slot, "thread-crash.jsonl"), `${JSON.stringify({ id: "thread-crash", cwd: "/workspace" })}\n`);
  const restarted = new ExecutionManager(root, { executionContext: async () => context() } as never, engine as never);
  await restarted.initialize();
  expect(settled).toBe(0);
  expect(restarted.snapshotResources().find((resource) => resource.type === "terminal")).toMatchObject({ state: "lost" });
  const recovered = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async () => { throw new Error("restart-must-not-exec"); },
    inspectSlot: async () => ({ state: "present-and-exact" })
  });
  await recovered.recoverAfterAgentRestart();
  expect(await recovered.privateNativeId(sessionId)).toBe("thread-crash");
  expect(await recovered.publicSnapshot(sessionId)).toMatchObject({ state: "lost" });
  expect(await recovered.capability(sessionId)).toMatchObject({ resume: true, state: "lost" });
  expect(JSON.stringify(await recovered.publicSnapshot(sessionId))).not.toContain("thread-crash");
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).resolves.toMatchObject({ leaseId: expect.any(String) });
});
