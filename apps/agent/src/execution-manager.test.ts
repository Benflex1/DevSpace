/* eslint-disable @typescript-eslint/require-await -- test doubles model async Agent and Docker boundaries. */
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { encodeTerminalClientFrame } from "@devspace/contracts";
import { ExecutionManager, TaskStartRecoveryRequiredError, isSuccessfulTaskExitCode } from "./execution-manager.js";
import { DockerEngineError } from "./docker-runtime.js";
import type { WorkspaceExecutionContext } from "./managed-workspaces.js";
import { durableJsonWriter } from "./private-state.js";

const id = "018f0f00-0000-7000-8000-000000000001";
const workspaceId = "018f0f00-0000-7000-8000-000000000002";
const terminalId = "018f0f00-0000-7000-8000-000000000003";
const operationId = "018f0f00-0000-7000-8000-000000000004";
const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("configured task exit semantics", () => {
  test("uses the configured success exit codes rather than assuming zero", () => {
    expect(isSuccessfulTaskExitCode([0, 2], 2)).toBe(true);
    expect(isSuccessfulTaskExitCode([0, 2], 1)).toBe(false);
    expect(isSuccessfulTaskExitCode([], 0)).toBe(false);
  });
});

test.each([
  ["interactive", { interactive: true }],
  ["long-running", { longRunning: true }],
  ["timeout", { timeoutSeconds: 30 }],
  ["replace", { concurrencyPolicy: "replace" }]
] as const)("rejects %s task policy before Docker side effects", async (_name, unsupported) => {
  let createCalls = 0;
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } },
    options: { tasks: [{ key: "task", displayName: "Task", interactive: false, longRunning: false,
      timeoutSeconds: null, concurrencyPolicy: "reject", successExitCodes: [0], command: {
        executable: "/usr/bin/printf", args: ["ok"], workingDirectory: ".", environment: {}
      }, ...unsupported }] }
  } as unknown as WorkspaceExecutionContext;
  const manager = new ExecutionManager("/tmp/devspace-runtime-policy", { executionContext: async () => context } as never, {
    createExec: async () => { createCalls += 1; return "never"; }
  } as never);

  await expect(manager.startTask({ projectId: id, workspaceId, taskRunId: terminalId, processId: operationId, taskKey: "task" }, operationId))
    .rejects.toMatchObject({ failure: { code: "RUNTIME_POLICY_VIOLATION", details: { policy: "task-action-rejected" } } });
  expect(createCalls).toBe(0);
});

test("individual task and terminal stop fail closed without a signal attempt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-stop-unsupported-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [{ key: "task", interactive: false,
      longRunning: false, timeoutSeconds: null, concurrencyPolicy: "allow", successExitCodes: [0], command: {
        executable: "/usr/bin/printf", args: ["ok"], workingDirectory: ".", environment: {}
      } }] }
  } as unknown as WorkspaceExecutionContext;
  let creates = 0;
  const engine = {
    createExec: async () => `exec-${++creates}`,
    startExecAttached: async () => new PassThrough(),
    inspectExec: async (execId: string) => ({ ID: execId, Running: true, ExitCode: 0, ContainerID: "container-owned" })
  } as never;
  const manager = new ExecutionManager(root, { executionContext: async () => context } as never, engine);
  await manager.initialize();
  await manager.startTask({ projectId: id, workspaceId, taskRunId: terminalId, processId: operationId, taskKey: "task" }, operationId);
  await expect(manager.stop(id, workspaceId, operationId)).rejects.toMatchObject({
    failure: { code: "RESOURCE_STATE_CONFLICT", details: { resource: { type: "process", id: operationId }, action: "stop" } }
  });
  await manager.createTerminal({ projectId: id, workspaceId, terminalId });
  await expect(manager.closeTerminal({ projectId: id, workspaceId, terminalId })).rejects.toMatchObject({
    failure: { code: "RESOURCE_STATE_CONFLICT", details: { resource: { type: "terminal", id: terminalId }, action: "close" } }
  });
  expect(creates).toBe(2);
});

test("an exact task.start replay reuses a recovered execution instead of hitting concurrency checks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-task-replay-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const taskInput = { projectId: id, workspaceId, taskRunId: terminalId, processId: operationId, taskKey: "wait" } as const;
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } },
    options: { tasks: [{ key: "wait", interactive: false, timeoutSeconds: null,
      concurrencyPolicy: "reject", successExitCodes: [0], command: {
        executable: "/bin/sleep", args: [], workingDirectory: ".", environment: {}
      } }] }
  } as unknown as WorkspaceExecutionContext;
  let createCalls = 0;
  const engine = {
    createExec: async () => { createCalls += 1; return "exec-owned"; },
    startExecAttached: async () => new PassThrough(),
    inspectExec: async () => ({ ID: "exec-owned", Running: true, ExitCode: 0, ContainerID: "container-owned" })
  } as never;
  const managed = { executionContext: async () => context } as never;
  const first = new ExecutionManager(root, managed, engine);
  await first.initialize();
  await first.startTask(taskInput, operationId);

  const restarted = new ExecutionManager(root, managed, engine);
  await restarted.initialize();
  await restarted.startTask(taskInput, operationId);

  expect(createCalls).toBe(1);
});

test.each([{ exitCode: 0, state: "exited" }, { exitCode: 7, state: "failed" }] as const)(
  "exact replay preserves successful start after later $state lifecycle",
  async ({ exitCode, state }) => {
    const root = await mkdtemp(path.join(tmpdir(), `devspace-task-terminal-${state}-`)); roots.push(root);
    await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
    const input = { projectId: id, workspaceId, taskRunId: terminalId, processId: operationId, taskKey: "wait" } as const;
    const context = {
      projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
      runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
      ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [{ key: "wait", interactive: false,
        timeoutSeconds: null, concurrencyPolicy: "reject", successExitCodes: [0], command: {
          executable: "/bin/sleep", args: ["10"], workingDirectory: ".", environment: {}
        } }] }
    } as unknown as WorkspaceExecutionContext;
    let running = true; let creates = 0;
    const engine = {
      createExec: async () => { creates += 1; return "exec-owned"; }, startExecAttached: async () => new PassThrough(),
      inspectExec: async () => ({ ID: "exec-owned", Running: running, ExitCode: exitCode, ContainerID: "container-owned" })
    } as never;
    const manager = new ExecutionManager(root, { executionContext: async () => context } as never, engine);
    await manager.initialize(); await manager.startTask(input, operationId);
    running = false; await expect(manager.inspect(id, workspaceId, operationId)).resolves.toMatchObject({ observedState: state });
    await expect(manager.startTask(input, operationId)).resolves.toBeUndefined();
    expect(creates).toBe(1);
  }
);

test("task.start reserves before Docker and recovers an already-started exact exec without duplication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-task-phases-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const taskInput = { projectId: id, workspaceId, taskRunId: terminalId, processId: operationId, taskKey: "wait" } as const;
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } },
    options: { tasks: [{ key: "wait", interactive: false, timeoutSeconds: null,
      concurrencyPolicy: "reject", successExitCodes: [0], command: {
        executable: "/bin/sleep", args: ["10"], workingDirectory: ".", environment: {}
      } }] }
  } as unknown as WorkspaceExecutionContext;
  let writes = 0; let creates = 0; let starts = 0;
  const writer = { write: async (filePath: string, value: unknown) => {
    writes += 1;
    if (writes === 4) throw new Error("injected-final-start-evidence-failure");
    await durableJsonWriter.write(filePath, value);
  } };
  const engine = {
    createExec: async () => { creates += 1; return "exec-owned"; },
    startExecAttached: async () => { starts += 1; return new PassThrough(); },
    inspectExec: async () => ({ ID: "exec-owned", Running: true, ExitCode: 0, ContainerID: "container-owned" })
  } as never;
  const first = new ExecutionManager(root, { executionContext: async () => context } as never, engine, writer);
  await first.initialize();
  await expect(first.startTask(taskInput, operationId)).rejects.toBeInstanceOf(TaskStartRecoveryRequiredError);
  expect(creates).toBe(1); expect(starts).toBe(1);
  expect(JSON.parse(await readFile(path.join(root, "ownership", "executions", `${operationId}.json`), "utf8")))
    .toMatchObject({ creationPhase: "start-intent", execId: "exec-owned", observedState: "starting" });

  const restarted = new ExecutionManager(root, { executionContext: async () => context } as never, engine);
  await restarted.initialize();
  await restarted.startTask(taskInput, operationId);
  expect(creates).toBe(1); expect(starts).toBe(1);
  expect(JSON.parse(await readFile(path.join(root, "ownership", "executions", `${operationId}.json`), "utf8")))
    .toMatchObject({ creationPhase: "started", execId: "exec-owned", observedState: "running" });
});

test("task.start replay promotes an exact exec that exited before started evidence without a second start", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-task-exited-before-started-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const input = { projectId: id, workspaceId, taskRunId: terminalId, processId: operationId, taskKey: "wait" } as const;
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [{ key: "wait", interactive: false,
      longRunning: false, timeoutSeconds: null, concurrencyPolicy: "allow", successExitCodes: [0], command: {
        executable: "/usr/bin/printf", args: ["done"], workingDirectory: ".", environment: {}
      } }] }
  } as unknown as WorkspaceExecutionContext;
  let creates = 0; let starts = 0; let executed = false;
  const writer = { write: async (filePath: string, value: unknown) => {
    if (++writes === 4) throw new Error("injected-started-evidence-failure");
    await durableJsonWriter.write(filePath, value);
  } };
  let writes = 0;
  const engine = {
    createExec: async () => { creates += 1; return "exec-owned"; },
    startExecAttached: async () => { starts += 1; executed = true; return new PassThrough(); },
    inspectExec: async () => ({ ID: "exec-owned", Running: false, ExitCode: executed ? 0 : null, ContainerID: "container-owned" })
  } as never;
  const managed = { executionContext: async () => context } as never;
  const first = new ExecutionManager(root, managed, engine, writer);
  await first.initialize();
  await expect(first.startTask(input, operationId)).rejects.toBeInstanceOf(TaskStartRecoveryRequiredError);
  expect(creates).toBe(1); expect(starts).toBe(1);
  expect(JSON.parse(await readFile(path.join(root, "ownership", "executions", `${operationId}.json`), "utf8")))
    .toMatchObject({ creationPhase: "start-intent", observedState: "starting", exitCode: null });

  const restarted = new ExecutionManager(root, managed, engine);
  await restarted.initialize();
  await expect(restarted.startTask(input, operationId)).resolves.toBeUndefined();
  expect(creates).toBe(1); expect(starts).toBe(1);
  await expect(restarted.inspect(id, workspaceId, operationId)).resolves.toMatchObject({
    observedState: "exited", exitCode: 0
  });
  expect(JSON.parse(await readFile(path.join(root, "ownership", "executions", `${operationId}.json`), "utf8")))
    .toMatchObject({ creationPhase: "started", observedState: "exited", exitCode: 0 });
});

test("task.start replay starts a genuinely never-started retained exec exactly once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-task-never-started-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const input = { projectId: id, workspaceId, taskRunId: terminalId, processId: operationId, taskKey: "wait" } as const;
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [{ key: "wait", interactive: false,
      longRunning: false, timeoutSeconds: null, concurrencyPolicy: "allow", successExitCodes: [0], command: {
        executable: "/usr/bin/printf", args: ["done"], workingDirectory: ".", environment: {}
      } }] }
  } as unknown as WorkspaceExecutionContext;
  let creates = 0; let starts = 0; let executed = false; let writes = 0;
  const firstWriter = { write: async (filePath: string, value: unknown) => {
    if (++writes === 3) throw new Error("injected-start-intent-failure");
    await durableJsonWriter.write(filePath, value);
  } };
  const engine = {
    createExec: async () => { creates += 1; return "exec-owned"; },
    startExecAttached: async () => { starts += 1; executed = true; return new PassThrough(); },
    inspectExec: async () => ({ ID: "exec-owned", Running: false, ExitCode: executed ? 0 : null, ContainerID: "container-owned" })
  } as never;
  const managed = { executionContext: async () => context } as never;
  const first = new ExecutionManager(root, managed, engine, firstWriter);
  await first.initialize();
  await expect(first.startTask(input, operationId)).rejects.toThrow("injected-start-intent-failure");
  expect(creates).toBe(1); expect(starts).toBe(0);
  expect(JSON.parse(await readFile(path.join(root, "ownership", "executions", `${operationId}.json`), "utf8")))
    .toMatchObject({ creationPhase: "exec-created", execId: "exec-owned" });

  const restarted = new ExecutionManager(root, managed, engine);
  await restarted.initialize();
  await expect(restarted.startTask(input, operationId)).resolves.toBeUndefined();
  expect(creates).toBe(1); expect(starts).toBe(1);
});

test("an accepted task start remains resumable after the attach transport fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-task-ambiguous-start-running-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const input = { projectId: id, workspaceId, taskRunId: terminalId, processId: operationId, taskKey: "wait" } as const;
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [{ key: "wait", interactive: false,
      longRunning: false, timeoutSeconds: null, concurrencyPolicy: "allow", successExitCodes: [0], command: {
        executable: "/usr/bin/printf", args: ["done"], workingDirectory: ".", environment: {}
      } }] }
  } as unknown as WorkspaceExecutionContext;
  let creates = 0; let starts = 0; let accepted = false;
  const engine = {
    createExec: async () => { creates += 1; return "exec-owned"; },
    startExecAttached: async () => { starts += 1; accepted = true; throw new Error("upgrade-after-accept"); },
    inspectExec: async () => ({ ID: "exec-owned", Running: accepted, ExitCode: null, ContainerID: "container-owned" })
  } as never;
  const managed = { executionContext: async () => context } as never;
  const first = new ExecutionManager(root, managed, engine);
  await first.initialize();
  await expect(first.startTask(input, operationId)).rejects.toBeInstanceOf(TaskStartRecoveryRequiredError);
  expect(JSON.parse(await readFile(path.join(root, "ownership", "executions", `${operationId}.json`), "utf8")))
    .toMatchObject({ creationPhase: "start-intent", observedState: "starting" });
  const restarted = new ExecutionManager(root, managed, engine);
  await restarted.initialize();
  await expect(restarted.startTask(input, operationId)).resolves.toBeUndefined();
  expect(creates).toBe(1); expect(starts).toBe(1);
  expect(JSON.parse(await readFile(path.join(root, "ownership", "executions", `${operationId}.json`), "utf8")))
    .toMatchObject({ creationPhase: "started", observedState: "running", exitCode: null });
});

test("an accepted task start that exits before recovery preserves its exit result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-task-ambiguous-start-exited-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const input = { projectId: id, workspaceId, taskRunId: terminalId, processId: operationId, taskKey: "wait" } as const;
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [{ key: "wait", interactive: false,
      longRunning: false, timeoutSeconds: null, concurrencyPolicy: "allow", successExitCodes: [0], command: {
        executable: "/usr/bin/printf", args: ["done"], workingDirectory: ".", environment: {}
      } }] }
  } as unknown as WorkspaceExecutionContext;
  let creates = 0; let starts = 0; let accepted = false;
  const engine = {
    createExec: async () => { creates += 1; return "exec-owned"; },
    startExecAttached: async () => { starts += 1; accepted = true; throw new Error("attach-after-accept"); },
    inspectExec: async () => ({ ID: "exec-owned", Running: false, ExitCode: accepted ? 7 : null, ContainerID: "container-owned" })
  } as never;
  const managed = { executionContext: async () => context } as never;
  const first = new ExecutionManager(root, managed, engine);
  await first.initialize();
  await expect(first.startTask(input, operationId)).rejects.toBeInstanceOf(TaskStartRecoveryRequiredError);

  const restarted = new ExecutionManager(root, managed, engine);
  await restarted.initialize();
  await expect(restarted.startTask(input, operationId)).resolves.toBeUndefined();
  expect(creates).toBe(1); expect(starts).toBe(1);
  await expect(restarted.inspect(id, workspaceId, operationId)).resolves.toMatchObject({ observedState: "failed", exitCode: 7 });
  expect(JSON.parse(await readFile(path.join(root, "ownership", "executions", `${operationId}.json`), "utf8")))
    .toMatchObject({ creationPhase: "started", observedState: "failed", exitCode: 7 });
});

test("an ambiguous start with unavailable inspection remains resumable until exact evidence is available", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-task-ambiguous-inspection-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const input = { projectId: id, workspaceId, taskRunId: terminalId, processId: operationId, taskKey: "wait" } as const;
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [{ key: "wait", interactive: false,
      longRunning: false, timeoutSeconds: null, concurrencyPolicy: "allow", successExitCodes: [0], command: {
        executable: "/bin/sleep", args: ["10"], workingDirectory: ".", environment: {}
      } }] }
  } as unknown as WorkspaceExecutionContext;
  let creates = 0; let starts = 0; let inspectCalls = 0;
  const engine = {
    createExec: async () => { creates += 1; return "exec-owned"; },
    startExecAttached: async () => { starts += 1; throw new Error("stream-establishment-failed"); },
    inspectExec: async () => {
      inspectCalls += 1;
      if (inspectCalls === 1) throw new Error("temporary-inspection-failure");
      return { ID: "exec-owned", Running: true, ExitCode: null, ContainerID: "container-owned" };
    }
  } as never;
  const managed = { executionContext: async () => context } as never;
  const first = new ExecutionManager(root, managed, engine);
  await first.initialize();
  await expect(first.startTask(input, operationId)).rejects.toBeInstanceOf(TaskStartRecoveryRequiredError);

  const restarted = new ExecutionManager(root, managed, engine);
  await restarted.initialize();
  await expect(restarted.startTask(input, operationId)).rejects.toBeInstanceOf(TaskStartRecoveryRequiredError);
  expect(JSON.parse(await readFile(path.join(root, "ownership", "executions", `${operationId}.json`), "utf8")))
    .toMatchObject({ creationPhase: "start-intent", observedState: "starting" });
  await expect(restarted.startTask(input, operationId)).resolves.toBeUndefined();
  expect(creates).toBe(1); expect(starts).toBe(1);
});

test("a never-started exec after ambiguous start is started exactly once after null exit evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-task-ambiguous-never-started-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const input = { projectId: id, workspaceId, taskRunId: terminalId, processId: operationId, taskKey: "wait" } as const;
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [{ key: "wait", interactive: false,
      longRunning: false, timeoutSeconds: null, concurrencyPolicy: "allow", successExitCodes: [0], command: {
        executable: "/usr/bin/printf", args: ["done"], workingDirectory: ".", environment: {}
      } }] }
  } as unknown as WorkspaceExecutionContext;
  let creates = 0; let starts = 0; let successfulStarts = 0; let allowSuccessfulStart = false; let started = false;
  const engine = {
    createExec: async () => { creates += 1; return "exec-owned"; },
    startExecAttached: async () => {
      starts += 1;
      if (!allowSuccessfulStart) throw new Error("start-boundary-before-accept");
      started = true;
      successfulStarts += 1;
      return new PassThrough();
    },
    inspectExec: async () => ({ ID: "exec-owned", Running: started, ExitCode: null, ContainerID: "container-owned" })
  } as never;
  const managed = { executionContext: async () => context } as never;
  const first = new ExecutionManager(root, managed, engine);
  await first.initialize();
  await expect(first.startTask(input, operationId)).rejects.toBeInstanceOf(TaskStartRecoveryRequiredError);

  const restarted = new ExecutionManager(root, managed, engine);
  await restarted.initialize();
  allowSuccessfulStart = true;
  await expect(restarted.startTask(input, operationId)).resolves.toBeUndefined();
  expect(creates).toBe(1); expect(starts).toBe(2); expect(successfulStarts).toBe(1);
});

test("a deterministic create failure before start-intent is terminal and is not replayed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-task-pre-intent-failure-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const input = { projectId: id, workspaceId, taskRunId: terminalId, processId: operationId, taskKey: "wait" } as const;
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [{ key: "wait", interactive: false,
      longRunning: false, timeoutSeconds: null, concurrencyPolicy: "allow", successExitCodes: [0], command: {
        executable: "/usr/bin/printf", args: ["done"], workingDirectory: ".", environment: {}
      } }] }
  } as unknown as WorkspaceExecutionContext;
  let creates = 0; let starts = 0;
  const engine = {
    createExec: async () => { creates += 1; throw new Error("deterministic-create-rejection"); },
    startExecAttached: async () => { starts += 1; return new PassThrough(); }
  } as never;
  const managed = { executionContext: async () => context } as never;
  const first = new ExecutionManager(root, managed, engine);
  await first.initialize();
  await expect(first.startTask(input, operationId)).rejects.toThrow("deterministic-create-rejection");
  expect(JSON.parse(await readFile(path.join(root, "ownership", "executions", `${operationId}.json`), "utf8")))
    .toMatchObject({ creationPhase: "reserved", observedState: "failed" });

  const restarted = new ExecutionManager(root, managed, engine);
  await restarted.initialize();
  await expect(restarted.startTask(input, operationId)).rejects.toMatchObject({
    failure: { code: "RESOURCE_STATE_CONFLICT" }
  });
  expect(creates).toBe(1); expect(starts).toBe(0);
});

test("task.start persistence failure before Docker creates no exec and pre-start evidence failure never starts it", async () => {
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [{ key: "wait", interactive: false,
      timeoutSeconds: null, concurrencyPolicy: "reject", successExitCodes: [0], command: {
        executable: "/bin/sleep", args: ["10"], workingDirectory: ".", environment: {}
      } }] }
  } as unknown as WorkspaceExecutionContext;
  const input = { projectId: id, workspaceId, taskRunId: terminalId, processId: operationId, taskKey: "wait" } as const;
  for (const failureWrite of [1, 2]) {
    const root = await mkdtemp(path.join(tmpdir(), `devspace-task-phase-${failureWrite}-`)); roots.push(root);
    await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
    let writes = 0; let creates = 0; let starts = 0;
    const manager = new ExecutionManager(root, { executionContext: async () => context } as never, {
      createExec: async () => { creates += 1; return "exec-owned"; },
      startExecAttached: async () => { starts += 1; return new PassThrough(); }
    } as never, { write: async (filePath, value) => {
      writes += 1; if (writes === failureWrite) throw new Error("injected-persistence-failure");
      await durableJsonWriter.write(filePath, value);
    } });
    await manager.initialize();
    await expect(manager.startTask(input, operationId)).rejects.toThrow("injected-persistence-failure");
    expect(creates).toBe(failureWrite === 1 ? 0 : 1);
    expect(starts).toBe(0);
  }
});

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = this.OPEN;
  bufferedAmount = 0;
  send(): void { /* protocol output is not relevant to slot ownership */ }
  close(): void { this.readyState = 2; }
  terminate(): void { this.readyState = this.CLOSED; queueMicrotask(() => this.emit("close")); }
}

async function waitForTerminalAttachmentCleanup(manager: ExecutionManager, terminalId: string): Promise<void> {
  let cleanup: ReturnType<ExecutionManager["reserveTerminalAttachment"]> | undefined;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try { cleanup = manager.reserveTerminalAttachment(terminalId); break; }
    catch { await new Promise<void>((resolve) => setTimeout(resolve, 1)); }
  }
  expect(cleanup).toBeDefined();
  cleanup?.release();
}

async function waitForTerminalAttachmentFinalization(manager: ExecutionManager, terminalId: string): Promise<void> {
  const executions = (manager as unknown as {
    executions: Map<string, { attachmentCleanup: Promise<void> | null; attachment: unknown }>;
  }).executions;
  const live = executions.get(terminalId);
  expect(live).toBeDefined();
  const cleanup = live?.attachmentCleanup;
  expect(cleanup).not.toBeNull();
  await cleanup;
  expect(live?.attachmentCleanup).toBeNull();
  expect(live?.attachment).toBeNull();
}

test("a CLOSING terminal attachment retains the slot until close cleanup has persisted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-terminal-attachment-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const stream = new PassThrough();
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [] }
  } as unknown as WorkspaceExecutionContext;
  const engine = {
    createExec: async () => "exec-owned",
    startExecAttached: async () => stream,
    inspectExec: async () => ({ ID: "exec-owned", Running: true, ExitCode: 0, ContainerID: "container-owned" }),
    resizeExec: async () => undefined
  } as never;
  const manager = new ExecutionManager(root, { executionContext: async () => context } as never, engine);
  await manager.initialize();
  await manager.createTerminal({ projectId: id, workspaceId, terminalId });

  const first = new FakeSocket();
  const firstReservation = manager.reserveTerminalAttachment(terminalId);
  await firstReservation.attach(first as never);
  first.readyState = first.CLOSING;
  expect(() => manager.reserveTerminalAttachment(terminalId)).toThrow("cannot accept another attachment");

  first.readyState = first.CLOSED;
  first.emit("close");
  let later: ReturnType<ExecutionManager["reserveTerminalAttachment"]> | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { later = manager.reserveTerminalAttachment(terminalId); break; }
    catch { await new Promise<void>((resolve) => setTimeout(resolve, 1)); }
  }
  expect(later).toBeDefined();
  expect(manager.snapshotResources().find((resource) => resource.type === "terminal"))
    .toMatchObject({ type: "terminal", identity: { terminalId }, state: "disconnected" });
  const reopened = new FakeSocket();
  await later!.attach(reopened as never);
  expect(manager.snapshotResources().find((resource) => resource.type === "terminal"))
    .toMatchObject({ type: "terminal", identity: { terminalId }, state: "active" });
  reopened.readyState = reopened.CLOSED;
  reopened.emit("close");
  await waitForTerminalAttachmentCleanup(manager, terminalId);
});

test("an attached terminal process exit becomes closed without requiring a reopen", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-terminal-exit-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const stream = new PassThrough();
  let running = true;
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [] }
  } as unknown as WorkspaceExecutionContext;
  const manager = new ExecutionManager(root, { executionContext: async () => context } as never, {
    createExec: async () => "exec-owned", startExecAttached: async () => stream,
    inspectExec: async () => ({ ID: "exec-owned", Running: running, ExitCode: running ? null : 0, ContainerID: "container-owned" }),
    resizeExec: async () => undefined
  } as never);
  await manager.initialize();
  await manager.createTerminal({ projectId: id, workspaceId, terminalId });
  await manager.reserveTerminalAttachment(terminalId).attach(new FakeSocket() as never);

  running = false;
  await expect(manager.inspect(id, workspaceId, terminalId)).resolves.toMatchObject({ observedState: "exited", exitCode: 0 });
  expect(manager.snapshotResources().find((resource) => resource.type === "terminal"))
    .toMatchObject({ type: "terminal", identity: { terminalId }, state: "closed" });
  expect(() => manager.reserveTerminalAttachment(terminalId)).toThrow("cannot accept another attachment");
});

test("distinct terminals keep distinct Docker exec identities and independent attachments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-terminal-identities-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const secondTerminalId = "018f0f00-0000-7000-8000-000000000005";
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [] }
  } as unknown as WorkspaceExecutionContext;
  let creates = 0;
  const engine = {
    createExec: async () => `exec-${++creates}`,
    startExecAttached: async () => new PassThrough(),
    inspectExec: async (execId: string) => ({ ID: execId, Running: true, ExitCode: 0, ContainerID: "container-owned" }),
    resizeExec: async () => undefined
  } as never;
  const manager = new ExecutionManager(root, { executionContext: async () => context } as never, engine);
  await manager.initialize();
  await manager.createTerminal({ projectId: id, workspaceId, terminalId });
  await manager.createTerminal({ projectId: id, workspaceId, terminalId: secondTerminalId });

  const executions = (manager as unknown as { executions: Map<string, { record: { execId: string | null } }> }).executions;
  expect(executions.get(terminalId)?.record.execId).toBe("exec-1");
  expect(executions.get(secondTerminalId)?.record.execId).toBe("exec-2");

  const firstSocket = new FakeSocket();
  const secondSocket = new FakeSocket();
  await manager.reserveTerminalAttachment(terminalId).attach(firstSocket as never);
  await manager.reserveTerminalAttachment(secondTerminalId).attach(secondSocket as never);
  expect(manager.snapshotResources().filter((resource) => resource.type === "terminal").map((resource) =>
    resource.type === "terminal" ? [resource.identity.terminalId, resource.state] : []))
    .toEqual(expect.arrayContaining([[terminalId, "active"], [secondTerminalId, "active"]]));
  expect(() => manager.reserveTerminalAttachment(terminalId)).toThrow("cannot accept another attachment");
  expect(() => manager.reserveTerminalAttachment(secondTerminalId)).toThrow("cannot accept another attachment");

  firstSocket.readyState = firstSocket.CLOSED; firstSocket.emit("close");
  secondSocket.readyState = secondSocket.CLOSED; secondSocket.emit("close");
  await waitForTerminalAttachmentCleanup(manager, terminalId);
  await waitForTerminalAttachmentCleanup(manager, secondTerminalId);
});

test("attachment cleanup persistence failure becomes lost without overlap or an immortal CLOSING lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-terminal-cleanup-failure-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const stream = new PassThrough();
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [] }
  } as unknown as WorkspaceExecutionContext;
  let writes = 0;
  const writer = { write: async (filePath: string, value: unknown) => {
    writes += 1;
    if (writes === 6) throw new Error("injected-disconnect-persistence-failure");
    await durableJsonWriter.write(filePath, value);
  } };
  const manager = new ExecutionManager(root, { executionContext: async () => context } as never, {
    createExec: async () => "exec-owned", startExecAttached: async () => stream,
    inspectExec: async () => ({ ID: "exec-owned", Running: true, ExitCode: 0, ContainerID: "container-owned" }),
    resizeExec: async () => undefined
  } as never, writer);
  await manager.initialize();
  await manager.createTerminal({ projectId: id, workspaceId, terminalId });
  const socket = new FakeSocket();
  await manager.reserveTerminalAttachment(terminalId).attach(socket as never);
  socket.readyState = socket.CLOSING; socket.emit("error", new Error("transport failed")); socket.emit("close");
  expect(() => manager.reserveTerminalAttachment(terminalId)).toThrow("cannot accept another attachment");
  await waitForTerminalAttachmentFinalization(manager, terminalId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const terminal = manager.snapshotResources().find((item) => item.type === "terminal");
    if (terminal?.type === "terminal" && terminal.state === "lost") break;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  const terminal = manager.snapshotResources().find((item) => item.type === "terminal");
  expect(terminal).toMatchObject({ type: "terminal", state: "lost" });
  expect(() => manager.reserveTerminalAttachment(terminalId)).toThrow("cannot accept another attachment");
});

test("initial attachment persistence failure closes before releasing ownership and leaves no immortal reference", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-terminal-attach-failure-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const stream = new PassThrough();
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [] }
  } as unknown as WorkspaceExecutionContext;
  let writes = 0; let attachmentPersistEntered!: () => void; let releaseAttachmentPersist!: () => void;
  const attachmentPersistStarted = new Promise<void>((resolve) => { attachmentPersistEntered = resolve; });
  const attachmentPersistRelease = new Promise<void>((resolve) => { releaseAttachmentPersist = resolve; });
  const writer = { write: async (filePath: string, value: unknown) => {
    writes += 1;
    if (writes === 5) {
      attachmentPersistEntered();
      await attachmentPersistRelease;
      throw new Error("injected-attach-persistence-failure");
    }
    await durableJsonWriter.write(filePath, value);
  } };
  const manager = new ExecutionManager(root, { executionContext: async () => context } as never, {
    createExec: async () => "exec-owned", startExecAttached: async () => stream,
    inspectExec: async () => ({ ID: "exec-owned", Running: true, ExitCode: 0, ContainerID: "container-owned" }),
    resizeExec: async () => undefined
  } as never, writer);
  await manager.initialize();
  await manager.createTerminal({ projectId: id, workspaceId, terminalId });
  const socket = new FakeSocket();
  const attach = manager.reserveTerminalAttachment(terminalId).attach(socket as never);
  await attachmentPersistStarted;
  expect(() => manager.reserveTerminalAttachment(terminalId)).toThrow("cannot accept another attachment");
  releaseAttachmentPersist();
  await expect(attach).rejects.toThrow("injected-attach-persistence-failure");
  expect(socket.readyState).toBe(socket.CLOSED);
  expect(manager.snapshotResources().find((item) => item.type === "terminal"))
    .toMatchObject({ type: "terminal", state: "lost" });
  const live = (manager as unknown as { executions: Map<string, { attachment: unknown }> }).executions.get(terminalId);
  expect(live?.attachment).toBeNull();
  expect(() => manager.reserveTerminalAttachment(terminalId)).toThrow("cannot accept another attachment");
});

test("createHarness execs structured argv with CODEX_HOME only on that exec", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-exec-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [] }
  } as unknown as WorkspaceExecutionContext;
  const created: Array<{ command: readonly string[]; environment: Record<string, string>; workingDirectory: string; tty: boolean;
    consoleSize?: { columns: number; rows: number } }> = [];
  let identityAtStart: Record<string, unknown> | null = null;
  const engine = {
    createExec: async (_containerId: string, input: {
      command: readonly string[]; environment: Record<string, string>; workingDirectory: string; tty: boolean;
      consoleSize?: { columns: number; rows: number };
    }) => {
      created.push(input);
      return `exec-${created.length}`;
    },
    startExecAttached: async (execId: string) => {
      if (execId === "exec-1") {
        identityAtStart = JSON.parse(await readFile(path.join(root, "ownership", "executions", `${harnessTerminalId}.json`), "utf8")) as Record<string, unknown>;
      }
      return new PassThrough();
    },
    inspectExec: async (execId: string) => ({ ID: execId, Running: true, ExitCode: 0, ContainerID: "container-owned" })
  } as never;
  const manager = new ExecutionManager(root, { executionContext: async () => context } as never, engine);
  await manager.initialize();
  const harnessTerminalId = "018f0f00-0000-7000-8000-0000000000aa";
  await manager.createHarness({
    projectId: id, workspaceId, processId: harnessTerminalId, terminalId: harnessTerminalId,
    command: ["codex", "resume", "thread-1"],
    environment: { CODEX_HOME: "/opt/devspace/harness-home" },
    sessionId: "018f0f00-0000-7000-8000-0000000000ab", processGeneration: 7, leaseId: "lease-test"
  });
  expect(identityAtStart).toMatchObject({
    kind: "terminal", executionRole: "harness", harnessSessionId: "018f0f00-0000-7000-8000-0000000000ab",
    harnessGeneration: 7, harnessLeaseId: "lease-test", creationPhase: "start-intent"
  });
  expect(created[0]).toMatchObject({
    command: ["codex", "resume", "thread-1"],
    workingDirectory: "/workspace",
    tty: true,
    consoleSize: { columns: 80, rows: 24 },
    environment: { TERM: "xterm-256color", CODEX_HOME: "/opt/devspace/harness-home" }
  });
  await manager.createTerminal({ projectId: id, workspaceId, terminalId });
  const terminalRecord = JSON.parse(await readFile(path.join(root, "ownership", "executions", `${terminalId}.json`), "utf8")) as Record<string, unknown>;
  expect(terminalRecord.executionRole).toBe("terminal");
  expect(terminalRecord.harnessSessionId).toBeNull();
  expect(created[1]).toMatchObject({
    command: ["/bin/sh"],
    environment: { TERM: "xterm-256color" },
    consoleSize: { columns: 80, rows: 24 }
  });
  expect(created[1]!.environment.CODEX_HOME).toBeUndefined();
});

test("ordinary task execs stay non-TTY while interactive terminals receive initial PTY geometry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-exec-console-size-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [{ key: "check", interactive: false,
      longRunning: false, timeoutSeconds: null, concurrencyPolicy: "allow", successExitCodes: [0], command: {
        executable: "/usr/bin/printf", args: ["ok"], workingDirectory: ".", environment: {}
      } }] }
  } as unknown as WorkspaceExecutionContext;
  const created: Array<{ tty: boolean; consoleSize?: { columns: number; rows: number } }> = [];
  const engine = {
    createExec: async (_containerId: string, input: { tty: boolean; consoleSize?: { columns: number; rows: number } }) => {
      created.push(input);
      return `exec-${created.length}`;
    },
    startExecAttached: async () => new PassThrough(),
    inspectExec: async (execId: string) => ({ ID: execId, Running: true, ExitCode: 0, ContainerID: "container-owned" })
  } as never;
  const manager = new ExecutionManager(root, { executionContext: async () => context } as never, engine);
  await manager.initialize();
  await manager.startTask({ projectId: id, workspaceId, taskRunId: terminalId, processId: operationId, taskKey: "check" }, operationId);
  await manager.createTerminal({ projectId: id, workspaceId, terminalId });
  expect(created[0]).toMatchObject({ tty: false });
  expect(created[0]?.consoleSize).toBeUndefined();
  expect(created[1]).toMatchObject({ tty: true, consoleSize: { columns: 80, rows: 24 } });
});

test("terminal resize failures produce one bounded private diagnostic without Docker response details", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-resize-diagnostic-")); roots.push(root);
  await mkdir(path.join(root, "ownership", "executions"), { recursive: true });
  const context = {
    projectId: id, workspaceId, revisionId: id, revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    ownership: { developmentContainer: { id: "container-owned" } }, options: { tasks: [] }
  } as unknown as WorkspaceExecutionContext;
  const diagnostics: unknown[] = [];
  const engine = {
    createExec: async () => "exec-resize",
    startExecAttached: async () => new PassThrough(),
    inspectExec: async () => ({ ID: "exec-resize", Running: true, ExitCode: 0, ContainerID: "container-owned" }),
    resizeExec: async () => { throw new DockerEngineError(500, "secret path and arbitrary response text"); }
  } as never;
  const manager = new ExecutionManager(root, { executionContext: async () => context } as never, engine, undefined, undefined, {
    onTerminalResizeFailure: (event) => { diagnostics.push(event); }
  });
  await manager.initialize();
  await manager.createTerminal({ projectId: id, workspaceId, terminalId });
  const socket = new FakeSocket();
  await manager.reserveTerminalAttachment(terminalId).attach(socket as never);
  const resize = Buffer.from(encodeTerminalClientFrame({ type: "resize", columns: 120, rows: 40 }));
  socket.emit("message", resize, true);
  socket.emit("message", resize, true);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  expect(diagnostics).toEqual([{
    processId: terminalId, terminalId, columns: 120, rows: 40, failureClass: "docker-http", failureCode: 500
  }]);
  expect(JSON.stringify(diagnostics)).not.toContain("secret path");
  socket.terminate();
  const executions = (manager as unknown as {
    executions: Map<string, { attachmentCleanup: Promise<void> | null; attachment: unknown }>;
  }).executions;
  const live = executions.get(terminalId);
  for (let attempt = 0; attempt < 1_000 && (live?.attachment !== null || live.attachmentCleanup !== null); attempt += 1) {
    await live?.attachmentCleanup;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  expect(live?.attachment).toBeNull();
  expect(live?.attachmentCleanup).toBeNull();
});
