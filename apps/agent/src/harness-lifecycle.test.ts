/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment -- fake exec lifecycle is synchronous. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { DockerEngineError } from "./docker-runtime.js";
import { ExecutionManager, type HarnessRecoveryIdentity } from "./execution-manager.js";
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

function context(containerId = "container-owned"): WorkspaceExecutionContext {
  return {
    projectId, workspaceId, revisionId: projectId, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: containerId } }, options: { tasks: [] }
  } as unknown as WorkspaceExecutionContext;
}

async function legacyHarnessFixture(label: string) {
  const root = await mkdtemp(path.join(tmpdir(), `devspace-harness-legacy-${label}-`));
  roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const home = createHarnessHomeStore(root);
  const engine = {
    createExec: async () => "exec-live",
    startExecAttached: async () => new PassThrough(),
    inspectExec: async () => ({ ID: "exec-live", Running: true, ExitCode: null, ContainerID: "container-owned" }),
    inspectContainer: async () => ({ Id: "container-owned" })
  };
  const manager = new ExecutionManager(root, { executionContext: async () => context() } as never, engine as never);
  const runtime = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async (input) => { await manager.createHarness(input); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    imageCodex: { present: true, version: null }
  });
  await manager.initialize();
  await runtime.start({ projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1 });
  const slot = path.join(root, "harness-slots", workspaceId);
  const nativeId = "018f1f34-7000-7000-8000-000000000230";
  const rollout = await writeCanonicalRollout(slot, nativeId);
  return {
    root, home, manager, runtime,
    nativeId, rollout,
    recordPath: path.join(root, "ownership", "executions", `${processId}.json`),
    sessionPath: path.join(root, "harness-sessions", `${sessionId}.json`),
    leasePath: path.join(root, "harness-homes", "codex", ".lease", "metadata.json"),
    slotMetaPath: path.join(root, "harness-meta", `${workspaceId}.json`),
    slotPath: slot
  };
}

async function writeCanonicalRollout(home: string, id: string): Promise<string> {
  const timestamp = "2026-10-01T14:38:06.144Z";
  const directory = path.join(home, "sessions", "2026", "10", "01");
  await mkdir(directory, { recursive: true });
  const rollout = path.join(directory, `rollout-2026-10-01T14-38-06-${id}.jsonl`);
  await writeFile(rollout, `${JSON.stringify({
    timestamp, type: "session_meta",
    payload: { id, session_id: id, cwd: "/workspace", timestamp }
  })}\n`);
  return rollout;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  // Recovered-exec monitoring backs off to a two-second poll interval.
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
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

  const nativeId = "018f1f34-7000-7000-8000-000000000231";
  const rollout = await writeCanonicalRollout(path.join(root, "harness-slots", workspaceId), nativeId);
  running.set("exec-1", false);
  streams[0]!.end();
  await waitFor(async () => (await runtime.publicSnapshot(sessionId)).state === "stopped");
  expect(hooks).toEqual([processId]);
  expect(await runtime.privateNativeId(sessionId)).toBe(nativeId);
  expect(JSON.stringify(await runtime.publicSnapshot(sessionId))).not.toContain(nativeId);
  expect(await readdir(path.join(root, "harness-slots", workspaceId))).toEqual([]);
  streams[0]!.emit("end");
  streams[0]!.emit("close");
  await manager.flushHarnessSettlements();
  expect(hooks).toEqual([processId]);
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).resolves.toMatchObject({ leaseId: expect.any(String) });
  const persistedRollout = path.join(home.persistentHomePath("codex"), "sessions", "2026", "10", "01", path.basename(rollout));
  expect(await readFile(persistedRollout, "utf8")).toContain(nativeId);
});

test("restart recovers a durable exec exit whose clean-settlement hook was interrupted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-exit-restart-"));
  roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const home = createHarnessHomeStore(root);
  const stream = new PassThrough();
  const engine = {
    createExec: async () => "exec-exited",
    startExecAttached: async () => stream,
    inspectExec: async () => ({ ID: "exec-exited", Running: false, ExitCode: 0, ContainerID: "container-owned" }),
    inspectContainer: async () => ({ Id: "container-owned", State: { Running: true, Status: "running" } })
  };
  const first = new ExecutionManager(root, { executionContext: async () => context() } as never, engine as never);
  const interruptedRuntime = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async (input) => { await first.createHarness(input); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    imageCodex: { present: true, version: null }
  });
  await first.initialize();
  await interruptedRuntime.start({ projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1 });
  const executionPath = path.join(root, "ownership", "executions", `${processId}.json`);
  expect(JSON.parse(await readFile(executionPath, "utf8"))).toMatchObject({ observedState: "exited", terminalState: "closed" });
  const nativeId = "018f1f34-7000-7000-8000-000000000232";
  const rollout = await writeCanonicalRollout(path.join(root, "harness-slots", workspaceId), nativeId);

  const hooks: { onHarnessRecovered?: (event: HarnessRecoveryIdentity) => Promise<void> } = {};
  const restarted = new ExecutionManager(root, { executionContext: async () => context() } as never, engine as never,
    undefined, () => new Date("2026-09-24T00:00:00.000Z"), hooks);
  const recovered = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async () => { throw new Error("restart-must-not-exec"); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    observeHarnessRecovery: () => restarted.harnessRecoveryReports(),
    imageCodex: { present: true, version: null }
  });
  hooks.onHarnessRecovered = async (event) => { await recovered.finalizeRecoveredLoss(event); };
  await restarted.initialize();
  await recovered.recoverAfterAgentRestart();

  expect(restarted.harnessRecoveryReports()).toMatchObject([{ observation: "terminated", processId, sessionId }]);
  expect(await recovered.publicSnapshot(sessionId)).toMatchObject({ state: "lost" });
  expect(await recovered.privateNativeId(sessionId)).toBe(nativeId);
  expect(await recovered.capability(sessionId)).toMatchObject({ resume: true });
  expect(await readdir(path.join(root, "harness-slots", workspaceId))).toEqual([]);
  expect(await readFile(path.join(home.persistentHomePath("codex"), "sessions", "2026", "10", "01", path.basename(rollout)), "utf8")).toContain(nativeId);
});

test("a still-running harness exec survives Agent restart until it exits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-restart-"));
  roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const home = createHarnessHomeStore(root);
  const stream = new PassThrough();
  let running = true;
  const engine = {
    createExec: async () => "exec-live",
    startExecAttached: async () => stream,
    inspectExec: async () => ({ ID: "exec-live", Running: running, ExitCode: running ? null : 0, ContainerID: "container-owned" }),
    inspectContainer: async () => ({ Id: "container-owned" })
  };
  const manager = new ExecutionManager(root, { executionContext: async () => context() } as never, engine as never, undefined, () => new Date("2026-09-24T00:00:00.000Z"));
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
  await writeFile(path.join(home.persistentHomePath("codex"), "kept.txt"), "original");
  const nativeId = "018f1f34-7000-7000-8000-000000000233";
  const rollout = await writeCanonicalRollout(path.join(root, "harness-slots", workspaceId), nativeId);
  const hooks: { onHarnessRecovered?: (event: HarnessRecoveryIdentity) => Promise<void> } = {};
  const restarted = new ExecutionManager(root, { executionContext: async () => context() } as never, engine as never, undefined, () => new Date("2026-09-24T00:00:00.000Z"), hooks);
  const recovered = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async () => { throw new Error("restart-must-not-exec"); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    observeHarnessRecovery: () => restarted.harnessRecoveryReports()
  });
  hooks.onHarnessRecovered = async (event) => { await recovered.finalizeRecoveredLoss(event); };
  await restarted.initialize();
  await recovered.recoverAfterAgentRestart();
  expect(restarted.harnessRecoveryReports()).toMatchObject([{
    processId, workspaceId, sessionId, processGeneration: 1, leaseId: expect.any(String), observation: "running"
  }]);
  expect(restarted.snapshotResources().find((resource) => resource.type === "terminal")).toMatchObject({ state: "lost" });
  expect(restarted.snapshotResources().find((resource) => resource.type === "process")).toMatchObject({ observation: { observedState: "running" } });
  expect(await recovered.publicSnapshot(sessionId)).toMatchObject({ state: "lost" });
  expect(await recovered.capability(sessionId)).toMatchObject({ resume: false, state: "lost" });
  await expect(recovered.resumeExec({
    sessionId, projectId, processId: "018f1f34-7000-7000-8000-0000000000ae",
    terminalId: "018f1f34-7000-7000-8000-0000000000af", processGeneration: 2
  })).rejects.toMatchObject({ code: "RESOURCE_STATE_CONFLICT" });
  expect(await readdir(path.dirname(rollout))).toEqual([path.basename(rollout)]);
  await expect(readFile(path.join(home.persistentHomePath("codex"), "sessions", "2026", "10", "01", path.basename(rollout)), "utf8")).rejects.toThrow();
  expect(await readFile(path.join(home.persistentHomePath("codex"), "kept.txt"), "utf8")).toBe("original");
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_HOME_IN_USE" });
  await expect(recovered.start({
    projectId, workspaceId, sessionId: "018f1f34-7000-7000-8000-0000000000aa", harnessId: "codex",
    processId: "018f1f34-7000-7000-8000-0000000000ab", terminalId: "018f1f34-7000-7000-8000-0000000000ac", processGeneration: 1
  })).rejects.toMatchObject({ code: "RESOURCE_STATE_CONFLICT" });
  running = false;
  await waitFor(async () => (await recovered.capability(sessionId)).resume === true);
  expect(await recovered.publicSnapshot(sessionId)).toMatchObject({ state: "lost" });
  expect(await recovered.privateNativeId(sessionId)).toBe(nativeId);
  expect(JSON.stringify(await recovered.publicSnapshot(sessionId))).not.toContain(nativeId);
  expect(await readdir(path.join(root, "harness-slots", workspaceId))).toEqual([]);
  expect(await readFile(path.join(home.persistentHomePath("codex"), "sessions", "2026", "10", "01", path.basename(rollout)), "utf8")).toContain(nativeId);
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).resolves.toMatchObject({ leaseId: expect.any(String) });
});

test.each(["stopped", "stopped-with-stale-exec", "removed"] as const)("workspace %s finalizes an orphan and a foreign container does not", async (workspaceState) => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-container-"));
  roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const home = createHarnessHomeStore(root);
  const writeBack = home.writeBackAndClear.bind(home);
  let writeBackCount = 0;
  home.writeBackAndClear = async (input) => { writeBackCount += 1; await writeBack(input); };
  const stream = new PassThrough();
  let execMissing = false;
  let containerMissing = false;
  let containerStopped = false;
  let inspectedContainer = "container-owned";
  const engine = {
    createExec: async () => "exec-live",
    startExecAttached: async () => stream,
    inspectExec: async () => {
      if (execMissing) throw new DockerEngineError(404, "missing");
      return { ID: "exec-live", Running: true, ExitCode: null, ContainerID: inspectedContainer };
    },
    inspectContainer: async () => {
      if (containerMissing) throw new DockerEngineError(404, "missing");
      return { Id: "container-owned", State: { Running: !containerStopped, Status: containerStopped ? "exited" : "running" } };
    }
  };
  const manager = new ExecutionManager(root, { executionContext: async () => context() } as never, engine as never);
  const runtime = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async (input) => { await manager.createHarness(input); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    imageCodex: { present: true, version: null }
  });
  await manager.initialize();
  await runtime.start({ projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1 });
  const slot = path.join(root, "harness-slots", workspaceId);
  await mkdir(slot, { recursive: true });
  const nativeId = "018f1f34-7000-7000-8000-000000000235";
  const rollout = await writeCanonicalRollout(slot, nativeId);
  inspectedContainer = "foreign-container";
  containerMissing = true;
  const foreignHooks: { onHarnessRecovered?: (event: HarnessRecoveryIdentity) => Promise<void> } = {};
  const foreign = new ExecutionManager(root, { executionContext: async () => context() } as never, engine as never, undefined, () => new Date("2026-09-24T00:00:00.000Z"), foreignHooks);
  const foreignRuntime = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async () => { throw new Error("restart-must-not-exec"); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    observeHarnessRecovery: () => foreign.harnessRecoveryReports()
  });
  foreignHooks.onHarnessRecovered = async (event) => { await foreignRuntime.finalizeRecoveredLoss(event); };
  await foreign.initialize();
  await foreignRuntime.recoverAfterAgentRestart();
  expect(foreign.harnessRecoveryReports()).toMatchObject([{ observation: "unproven" }]);
  expect(await readdir(path.dirname(rollout))).toEqual([path.basename(rollout)]);
  expect(await foreignRuntime.capability(sessionId)).toMatchObject({ resume: false });
  inspectedContainer = "container-owned";
  execMissing = workspaceState !== "stopped-with-stale-exec";
  containerStopped = workspaceState !== "removed";
  containerMissing = workspaceState === "removed";
  const hooks: { onHarnessRecovered?: (event: HarnessRecoveryIdentity) => Promise<void> } = {};
  const restarted = new ExecutionManager(root, { executionContext: async () => context() } as never, engine as never, undefined, () => new Date("2026-09-24T00:00:00.000Z"), hooks);
  const recovered = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async () => { throw new Error("restart-must-not-exec"); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    observeHarnessRecovery: () => restarted.harnessRecoveryReports()
  });
  hooks.onHarnessRecovered = async (event) => { await recovered.finalizeRecoveredLoss(event); };
  await restarted.initialize();
  await recovered.recoverAfterAgentRestart();
  expect(await recovered.publicSnapshot(sessionId)).toMatchObject({ state: "lost" });
  expect(await recovered.capability(sessionId)).toMatchObject({ resume: true });
  expect(await readdir(path.join(root, "harness-slots", workspaceId))).toEqual([]);
  const recovery = restarted.harnessRecoveryReports()[0]!;
  await recovered.finalizeRecoveredLoss({
    processId, workspaceId, sessionId, processGeneration: 1, leaseId: recovery.leaseId
  });
  expect(await recovered.privateNativeId(sessionId)).toBe(nativeId);
  expect(writeBackCount).toBe(1);
});

test("workspace replacement alone does not prove the old harness container is gone", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-replaced-container-"));
  roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const home = createHarnessHomeStore(root);
  const stream = new PassThrough();
  let execMissing = false;
  const engine = {
    createExec: async () => "exec-live",
    startExecAttached: async () => stream,
    inspectExec: async () => {
      if (execMissing) throw new DockerEngineError(404, "missing");
      return { ID: "exec-live", Running: true, ExitCode: null, ContainerID: "container-owned" };
    },
    inspectContainer: async (containerId: string) => ({ Id: containerId })
  };
  const manager = new ExecutionManager(root, { executionContext: async () => context() } as never, engine as never);
  const runtime = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async (input) => { await manager.createHarness(input); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    imageCodex: { present: true, version: null }
  });
  await manager.initialize();
  await runtime.start({ projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1 });
  const slot = path.join(root, "harness-slots", workspaceId);
  await mkdir(path.join(slot, "sessions"), { recursive: true });
  const rollout = await writeCanonicalRollout(slot, "018f1f34-7000-7000-8000-000000000234");

  execMissing = true;
  const hooks: { onHarnessRecovered?: (event: HarnessRecoveryIdentity) => Promise<void> } = {};
  const replaced = new ExecutionManager(root, { executionContext: async () => context("replacement-container") } as never,
    engine as never, undefined, () => new Date("2026-09-24T00:00:00.000Z"), hooks);
  const recovered = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async () => { throw new Error("restart-must-not-exec"); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    observeHarnessRecovery: () => replaced.harnessRecoveryReports()
  });
  hooks.onHarnessRecovered = async (event) => { await recovered.finalizeRecoveredLoss(event); };
  await replaced.initialize();
  await recovered.recoverAfterAgentRestart();

  expect(replaced.harnessRecoveryReports()).toMatchObject([{ observation: "unproven" }]);
  expect(await recovered.publicSnapshot(sessionId)).toMatchObject({ state: "lost" });
  expect(await recovered.capability(sessionId)).toMatchObject({ resume: false });
  expect(await readdir(path.dirname(rollout))).toEqual([path.basename(rollout)]);
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_HOME_IN_USE" });
});

test("a pre-fix terminal record is adopted when the harness session and lease agree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-legacy-"));
  roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const home = createHarnessHomeStore(root);
  const engine = {
    createExec: async () => "exec-live",
    startExecAttached: async () => new PassThrough(),
    inspectExec: async () => ({ ID: "exec-live", Running: true, ExitCode: null, ContainerID: "container-owned" }),
    inspectContainer: async () => ({ Id: "container-owned" })
  };
  const manager = new ExecutionManager(root, { executionContext: async () => context() } as never, engine as never);
  const runtime = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async (input) => { await manager.createHarness(input); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    imageCodex: { present: true, version: null }
  });
  await manager.initialize();
  await runtime.start({ projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1 });
  const recordPath = path.join(root, "ownership", "executions", `${processId}.json`);
  const stored = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
  delete stored.executionRole;
  delete stored.harnessSessionId;
  delete stored.harnessGeneration;
  delete stored.harnessLeaseId;
  await writeFile(recordPath, JSON.stringify(stored));
  const restarted = new ExecutionManager(root, { executionContext: async () => context() } as never, engine as never);
  await restarted.initialize();
  const upgraded = JSON.parse(await readFile(recordPath, "utf8")) as {
    executionRole?: string; harnessSessionId?: string; harnessGeneration?: number; harnessLeaseId?: string | null
  };
  expect(upgraded.executionRole).toBe("harness");
  expect(upgraded.harnessSessionId).toBe(sessionId);
  expect(upgraded.harnessGeneration).toBe(1);
  expect(upgraded.harnessLeaseId).toEqual(expect.any(String));
  const recovered = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async () => { throw new Error("restart-must-not-exec"); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    observeHarnessRecovery: () => restarted.harnessRecoveryReports()
  });
  await recovered.recoverAfterAgentRestart();
  expect(await recovered.publicSnapshot(sessionId)).toMatchObject({ state: "lost" });
  expect(await recovered.capability(sessionId)).toMatchObject({ resume: false });
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_HOME_IN_USE" });
});

test.each(["workspace", "process", "generation", "slot", "multiple", "missing-exec"] as const)(
  "pre-fix harness correlation fails closed when %s evidence is not exact", async (mismatch) => {
    const fixture = await legacyHarnessFixture(mismatch);
    const stored = JSON.parse(await readFile(fixture.recordPath, "utf8")) as Record<string, unknown>;
    delete stored.executionRole;
    delete stored.harnessSessionId;
    delete stored.harnessGeneration;
    delete stored.harnessLeaseId;
    if (mismatch === "missing-exec") stored.execId = null;
    await writeFile(fixture.recordPath, JSON.stringify(stored));

    if (mismatch === "workspace" || mismatch === "process" || mismatch === "multiple") {
      const session = JSON.parse(await readFile(fixture.sessionPath, "utf8")) as Record<string, unknown>;
      if (mismatch === "workspace") session.workspaceId = wsB;
      if (mismatch === "process") session.processId = shellTerminalId;
      if (mismatch === "multiple") {
        await writeFile(path.join(fixture.root, "harness-sessions", "018f1f34-7000-7000-8000-0000000000ad.json"), JSON.stringify(session));
      } else {
        await writeFile(fixture.sessionPath, JSON.stringify(session));
      }
    }
    if (mismatch === "generation") {
      const lease = JSON.parse(await readFile(fixture.leasePath, "utf8")) as Record<string, unknown>;
      lease.processGeneration = 2;
      await writeFile(fixture.leasePath, JSON.stringify(lease));
    }
    if (mismatch === "slot") {
      const meta = JSON.parse(await readFile(fixture.slotMetaPath, "utf8")) as Record<string, unknown>;
      meta.leaseId = "foreign-lease";
      await writeFile(fixture.slotMetaPath, JSON.stringify(meta));
    }

    const restarted = new ExecutionManager(fixture.root, { executionContext: async () => context() } as never,
      {
        createExec: async () => "unused",
        inspectExec: async () => ({ ID: "exec-live", Running: true, ExitCode: null, ContainerID: "container-owned" }),
        inspectContainer: async () => ({ Id: "container-owned" })
      } as never);
    await restarted.initialize();
    expect(restarted.harnessRecoveryReports()).toEqual([]);
    const upgraded = JSON.parse(await readFile(fixture.recordPath, "utf8")) as { executionRole?: string };
    expect(upgraded.executionRole).not.toBe("harness");

    const recovered = createHarnessRuntime({
      home: fixture.home, stateRoot: fixture.root,
      createHarnessExec: async () => { throw new Error("restart-must-not-exec"); },
      inspectSlot: async () => ({ state: "present-and-exact" }),
      observeHarnessRecovery: () => restarted.harnessRecoveryReports()
    });
    await recovered.recoverAfterAgentRestart();
    expect(await recovered.publicSnapshot(sessionId)).toMatchObject({ state: "lost" });
    expect(await recovered.capability(sessionId)).toMatchObject({ resume: false });
    expect(await readdir(path.dirname(fixture.rollout))).toEqual([path.basename(fixture.rollout)]);
    expect(await readFile(path.join(fixture.home.persistentHomePath("codex"), "sessions", "2026", "10", "01", path.basename(fixture.rollout)), "utf8")
      .catch(() => null)).toBeNull();
    await expect(fixture.home.acquireLease({
      harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
    })).rejects.toMatchObject({ code: "HARNESS_HOME_IN_USE" });
  }
);
