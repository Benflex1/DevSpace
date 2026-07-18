/* eslint-disable @typescript-eslint/require-await -- test doubles model async Agent boundaries. */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { gitInspectionDataSchema } from "@devspace/contracts";
import { AgentEventLog } from "./event-log.js";
import { ManagedWorkspaces } from "./managed-workspaces.js";
import { OperationExecutor } from "./operation-executor.js";
import { OperationJournal } from "./operation-journal.js";
import { TaskStartRecoveryRequiredError } from "./execution-manager.js";

const boot = "018f0f00-0000-7000-8000-000000000001";
const project = "018f0f00-0000-7000-8000-000000000002";
const operation1 = "018f0f00-0000-7000-8000-000000000003";
const operation2 = "018f0f00-0000-7000-8000-000000000004";
const timestamp = "2026-07-17T12:00:00.000Z";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

async function waitFor(journal: OperationJournal, ids: string[]): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (ids.every((id) => journal.get(id)?.state === "succeeded")) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`executor did not settle: ${JSON.stringify(ids.map((id) => journal.get(id)))}`);
}
const projectResources = () => Promise.resolve([{ type: "project" as const, projectId: project, gitInspections: [{
  scope: { kind: "managed-store" as const }, inspection: gitInspectionDataSchema.parse({
    projectId: project, workspaceId: null, branchName: null, headCommit: null, dirty: false, aheadCount: 0, behindCount: 0
  })
}] }]);

test("accepted incomplete work resumes after restart and duplicate scheduling executes once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-executor-restart-")); roots.push(root);
  const journalRoot = path.join(root, "operations");
  await mkdir(journalRoot);
  const firstJournal = new OperationJournal(journalRoot, () => new Date(timestamp)); await firstJournal.initialize();
  await firstJournal.accept(operation1, "project.fetch", { projectId: project });
  const restarted = new OperationJournal(journalRoot, () => new Date(timestamp)); await restarted.initialize();
  let calls = 0;
  class RecordingManaged extends ManagedWorkspaces {
    override fetch(): Promise<void> { calls += 1; return Promise.resolve(); }
    override inspectGit(projectId: string, workspaceId: string | null) { return Promise.resolve(gitInspectionDataSchema.parse({
      projectId, workspaceId, branchName: null, headCommit: null, dirty: false, aheadCount: 0, behindCount: 0
    })); }
    override snapshotResources() { return projectResources(); }
  }
  const managed = new RecordingManaged({ projects: path.join(root, "projects"), workspaces: path.join(root, "workspaces"), state: path.join(root, "state") });
  await Promise.all(["projects", "workspaces", "state"].map(async (name) => await mkdir(path.join(root, name), { recursive: true })));
  await managed.initialize();
  const executor = new OperationExecutor(restarted, managed, new AgentEventLog(boot, () => new Date(timestamp)));
  executor.resumeAccepted();
  const record = restarted.get(operation1)!;
  for (let index = 0; index < 10; index += 1) executor.schedule(record);
  await waitFor(restarted, [operation1]);
  expect(calls).toBe(1);
});

test("an exact task.start replay after Agent restart reuses the accepted execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-task-operation-replay-")); roots.push(root);
  const journalRoot = path.join(root, "operations"); await mkdir(journalRoot);
  const journal = new OperationJournal(journalRoot, () => new Date(timestamp)); await journal.initialize();
  const request = { projectId: project, workspaceId: boot, taskRunId: operation2, processId: operation1, taskKey: "wait" };
  const accepted = await journal.accept(operation1, "task.start", request);
  let launchCount = 0; let replayCount = 0; let release!: () => void;
  const firstExecutionStarted = new Promise<void>((resolve) => { release = resolve; });
  const execution = {
    snapshotResources: () => [],
    startTask: async (_input: typeof request, replayedOperationId?: string) => {
      expect(replayedOperationId).toBe(operation1);
      if (launchCount === 0) { launchCount += 1; await firstExecutionStarted; }
      else replayCount += 1;
    },
    stop: async () => undefined, createTerminal: async () => undefined, closeTerminal: async () => undefined,
    stopWorkspace: async () => undefined
  } as never;
  const managed = { awaitProjectExecutionFence: async () => undefined, snapshotResources: async () => [] } as never;
  const first = new OperationExecutor(journal, managed, new AgentEventLog(boot, () => new Date(timestamp)), undefined, execution);
  first.schedule(accepted);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && launchCount !== 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(journal.get(operation1)?.state).toBe("running");

  const restarted = new OperationExecutor(journal, managed, new AgentEventLog(boot, () => new Date(timestamp)), undefined, execution);
  restarted.resumeAccepted();
  await restarted.drain();
  expect(journal.get(operation1)?.state).toBe("succeeded");
  expect(launchCount).toBe(1);
  expect(replayCount).toBe(1);
  release();
  await first.drain();
  expect(journal.get(operation1)?.state).toBe("succeeded");
});

test("indeterminate final task-start evidence remains resumable and is never rewritten as failed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-task-operation-evidence-")); roots.push(root);
  const journalRoot = path.join(root, "operations"); await mkdir(journalRoot);
  const journal = new OperationJournal(journalRoot, () => new Date(timestamp)); await journal.initialize();
  const request = { projectId: project, workspaceId: boot, taskRunId: operation2, processId: operation1, taskKey: "wait" };
  const accepted = await journal.accept(operation1, "task.start", request);
  let attempts = 0;
  const execution = {
    snapshotResources: () => [],
    startTask: async () => { attempts += 1; if (attempts === 1) throw new TaskStartRecoveryRequiredError(); },
    stop: async () => undefined, createTerminal: async () => undefined, closeTerminal: async () => undefined,
    stopWorkspace: async () => undefined
  } as never;
  const managed = { awaitProjectExecutionFence: async () => undefined, snapshotResources: async () => [] } as never;
  const first = new OperationExecutor(journal, managed, new AgentEventLog(boot, () => new Date(timestamp)), undefined, execution);
  first.schedule(accepted); await first.drain();
  expect(journal.get(operation1)).toMatchObject({ state: "running", failure: null });

  const restarted = new OperationExecutor(journal, managed, new AgentEventLog(boot, () => new Date(timestamp)), undefined, execution);
  restarted.resumeAccepted(); await restarted.drain();
  expect(journal.get(operation1)).toMatchObject({ state: "succeeded", failure: null });
  expect(attempts).toBe(2);
});

test("a journal-terminal failed task.start is never rescheduled after Agent restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-task-operation-failed-")); roots.push(root);
  const journalRoot = path.join(root, "operations"); await mkdir(journalRoot);
  const journal = new OperationJournal(journalRoot, () => new Date(timestamp)); await journal.initialize();
  const request = { projectId: project, workspaceId: boot, taskRunId: operation2, processId: operation1, taskKey: "wait" };
  await journal.accept(operation1, "task.start", request);
  await journal.markRunning(operation1);
  await journal.fail(operation1, {
    code: "RUNTIME_POLICY_VIOLATION", message: "unsupported task policy", retryable: false,
    details: { policy: "task-action-rejected" }
  });
  const restarted = new OperationJournal(journalRoot, () => new Date(timestamp)); await restarted.initialize();
  let attempts = 0;
  const execution = {
    snapshotResources: () => [], startTask: async () => { attempts += 1; },
    stop: async () => undefined, createTerminal: async () => undefined, closeTerminal: async () => undefined,
    stopWorkspace: async () => undefined
  } as never;
  const managed = { awaitProjectExecutionFence: async () => undefined, snapshotResources: async () => [] } as never;
  const executor = new OperationExecutor(restarted, managed, new AgentEventLog(boot, () => new Date(timestamp)), undefined, execution);
  executor.resumeAccepted(); await executor.drain();
  expect(restarted.get(operation1)).toMatchObject({ state: "failed" });
  expect(attempts).toBe(0);
});

test("operations for one project are serialized even when accepted concurrently", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-executor-serial-")); roots.push(root);
  await mkdir(path.join(root, "operations"));
  const journal = new OperationJournal(path.join(root, "operations"), () => new Date(timestamp)); await journal.initialize();
  const first = await journal.accept(operation1, "project.fetch", { projectId: project });
  const second = await journal.accept(operation2, "project.fetch", { projectId: project });
  let active = 0; let maximum = 0;
  class RecordingManaged extends ManagedWorkspaces {
    override async fetch(): Promise<void> { active += 1; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 20)); active -= 1; }
    override inspectGit(projectId: string, workspaceId: string | null) { return Promise.resolve(gitInspectionDataSchema.parse({
      projectId, workspaceId, branchName: null, headCommit: null, dirty: false, aheadCount: 0, behindCount: 0
    })); }
    override snapshotResources() { return projectResources(); }
  }
  const managed = new RecordingManaged({ projects: path.join(root, "projects"), workspaces: path.join(root, "workspaces"), state: path.join(root, "state") });
  await Promise.all(["projects", "workspaces", "state"].map(async (name) => await mkdir(path.join(root, name), { recursive: true })));
  await managed.initialize();
  const executor = new OperationExecutor(journal, managed, new AgentEventLog(boot, () => new Date(timestamp)));
  executor.schedule(first); executor.schedule(second);
  await waitFor(journal, [operation1, operation2]);
  expect(maximum).toBe(1);
});
