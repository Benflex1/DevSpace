import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  gitInspectionDataSchema, workspaceInspectionDataSchema, type AgentOperationObservation, type AgentSnapshotData
} from "@devspace/contracts";
import type { WorkspaceAgentClient } from "./agent-client.js";
import { openProjectDatabase } from "./database.js";
import { reconcilePrimaryWorkspaceRuntimeOperation } from "./runtime-operation-reconciliation.js";
import { mutatePrimaryWorkspaceRuntime } from "./workspace-runtime.js";
import { setupPrimaryWorkspace, type WorkspaceSetupAgent } from "./workspace-setup.js";

const directories: string[] = [];
afterEach(async () => await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true }))));

async function runtimeFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-web-runtime-reconciliation-")); directories.push(directory);
  const database = openProjectDatabase(path.join(directory, "devspace.sqlite"));
  const project = database.createProject({ name: "Runtime", slug: "runtime-reconcile",
    repositoryUrl: "https://example.com/runtime.git", defaultBranch: "main", actor: "actor" });
  const observations = new Map<string, AgentOperationObservation>();
  let revisionId = ""; let revisionHash = "";
  const succeed = (operationId: string) => observations.set(operationId, {
    operationId, state: "succeeded", updatedAt: "2026-07-18T12:00:00.000Z", failure: null
  });
  const setupAgent = {
    health: () => Promise.resolve({ status: "ok" as const }), inspectSource: () => Promise.reject(new Error("unused")),
    registerRevision: (operationId, data) => { revisionId = data.revisionId; revisionHash = data.configuration.hash; succeed(operationId); return Promise.resolve(); },
    registerRuntimePlan: (operationId) => { succeed(operationId); return Promise.resolve(); },
    createManagedStore: (operationId) => { succeed(operationId); return Promise.resolve(); },
    fetchProject: (operationId) => { succeed(operationId); return Promise.resolve(); },
    createWorkspace: (operationId) => { succeed(operationId); return Promise.resolve(); },
    snapshot: () => Promise.resolve({ agentBootId: "018f0f00-0000-7000-8000-000000000099",
      throughCursor: "v1.018f0f00-0000-7000-8000-000000000099.1" as const,
      resources: [], operationObservations: [...observations.values()] }),
    inspectGit: (projectId, workspaceId) => Promise.resolve(gitInspectionDataSchema.parse({ projectId, workspaceId,
      branchName: "main", headCommit: "a".repeat(40), dirty: false, aheadCount: 0, behindCount: 0 })),
    inspectWorkspace: (projectId, workspaceId) => Promise.resolve(workspaceInspectionDataSchema.parse({ projectId, workspaceId,
      kind: "primary", revisionId, revisionHash, desiredState: "stopped", observedState: "stopped", dirty: false,
      runtimeStack: { desiredState: "absent", observedState: "absent" } }))
  } satisfies WorkspaceSetupAgent;
  await setupPrimaryWorkspace({ imageReference: "node:24-bookworm" }, project.id, "actor", { database, agent: setupAgent });
  observations.clear();
  let runtimeState: "absent" | "stopped" | "running" | "lost" = "absent";
  let startCalls = 0;
  const runtimeAgent = {
    ...setupAgent,
    runtimeStatus: () => Promise.resolve({ rootlessRuntime: "available" as const, operationJournal: "available" as const,
      checkedAt: "2026-07-18T12:00:00.000Z" }),
    startWorkspace: (operationId) => {
      startCalls += 1;
      observations.set(operationId, { operationId, state: "accepted", updatedAt: "2026-07-18T12:00:00.000Z", failure: null });
      return Promise.resolve();
    },
    stopWorkspace: (operationId) => {
      observations.set(operationId, { operationId, state: "accepted", updatedAt: "2026-07-18T12:00:00.000Z", failure: null });
      return Promise.resolve();
    },
    inspectWorkspace: (projectId, workspaceId) => Promise.resolve(workspaceInspectionDataSchema.parse({ projectId, workspaceId,
      kind: "primary", revisionId, revisionHash, desiredState: runtimeState === "running" ? "running" : "stopped",
      observedState: runtimeState === "running" ? "running" : runtimeState === "lost" ? "lost" : "stopped", dirty: false,
      runtimeStack: { desiredState: runtimeState === "absent" ? "absent" : runtimeState === "running" ? "running" : "stopped",
        observedState: runtimeState } }))
  } satisfies WorkspaceAgentClient;
  const context = database.getRuntimeContext(project.id);
  return { database, project, runtimeAgent, observations, context,
    startCalls: () => startCalls, setRuntimeState: (state: typeof runtimeState) => { runtimeState = state; } };
}

function fail(observations: Map<string, AgentOperationObservation>, operationId: string): void {
  observations.set(operationId, { operationId, state: "failed", updatedAt: "2026-07-18T12:00:00.000Z",
    failure: { code: "AGENT_INTERNAL_ERROR", message: "Container creation failed safely.", retryable: true,
      details: { incidentId: "018f0f00-0000-7000-8000-000000000098" } } });
}

test("poll timeout remains nonterminal, blocks a parallel start, and later reconciles Agent success", async () => {
  const fixture = await runtimeFixture();
  await expect(mutatePrimaryWorkspaceRuntime("start", fixture.project.id, "actor", {
    database: fixture.database, agent: fixture.runtimeAgent, orchestrationTimeoutMs: 0, nowMonotonic: () => 0
  })).rejects.toMatchObject({ code: "RUNTIME_ACTION_IN_PROGRESS" });
  const operation = fixture.database.listRuntimeOperations(fixture.project.id, fixture.context.workspace.id)[0]!;
  expect(operation.state).toBe("accepted");
  await expect(mutatePrimaryWorkspaceRuntime("start", fixture.project.id, "actor", {
    database: fixture.database, agent: fixture.runtimeAgent
  })).rejects.toMatchObject({ code: "RUNTIME_ACTION_IN_PROGRESS" });
  expect(fixture.startCalls()).toBe(1);
  expect(fixture.database.listRuntimeOperations(fixture.project.id, fixture.context.workspace.id)).toHaveLength(1);

  fixture.setRuntimeState("running");
  fixture.observations.set(operation.operationId, { operationId: operation.operationId, state: "succeeded",
    updatedAt: "2026-07-18T12:00:01.000Z", failure: null });
  await expect(mutatePrimaryWorkspaceRuntime("start", fixture.project.id, "actor", {
    database: fixture.database, agent: fixture.runtimeAgent
  })).resolves.toMatchObject({ observedState: "running", runtimeStack: { observedState: "running" } });
  expect(fixture.startCalls()).toBe(1);
  expect(fixture.database.listRuntimeOperations(fixture.project.id, fixture.context.workspace.id)[0]?.state).toBe("succeeded");
  expect(fixture.database.listRuntimeStacks()[0]).toMatchObject({ observedState: "running" });
  fixture.database.close();
});

test("stale accepted Web operation reconciles Agent failure and exposes only exact stopped recovery as retryable", async () => {
  const fixture = await runtimeFixture();
  const operation = fixture.database.prepareRuntimeMutation({ projectId: fixture.project.id, workspaceId: fixture.context.workspace.id,
    actor: "actor", action: "start", runtimePlanHash: fixture.context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" });
  fail(fixture.observations, operation.operationId); fixture.setRuntimeState("stopped");
  const unavailable = await reconcilePrimaryWorkspaceRuntimeOperation(fixture.project.id, {
    database: fixture.database, agent: fixture.runtimeAgent, runtimeAvailable: false
  });
  expect(unavailable).toMatchObject({ activeAction: null, canRetryStart: false,
    reconciledTerminal: { action: "start", state: "failed" } });
  expect(fixture.database.listRuntimeOperations(fixture.project.id, fixture.context.workspace.id)[0]).toMatchObject({
    state: "failed", errorCode: "AGENT_INTERNAL_ERROR"
  });
  await expect(reconcilePrimaryWorkspaceRuntimeOperation(fixture.project.id, {
    database: fixture.database, agent: fixture.runtimeAgent, runtimeAvailable: true
  })).resolves.toMatchObject({ activeAction: null, canStart: true, canRetryStart: true,
    retryOperationId: operation.operationId, reconciledTerminal: null });
  const retry = fixture.database.prepareRuntimeMutation({ projectId: fixture.project.id, workspaceId: fixture.context.workspace.id,
    actor: "actor", action: "start", runtimePlanHash: fixture.context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" });
  expect(retry.operationId).not.toBe(operation.operationId);
  fixture.database.close();
});

test("failed Agent start with lost ownership is terminal but never retryable", async () => {
  const fixture = await runtimeFixture();
  const operation = fixture.database.prepareRuntimeMutation({ projectId: fixture.project.id, workspaceId: fixture.context.workspace.id,
    actor: "actor", action: "start", runtimePlanHash: fixture.context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" });
  fail(fixture.observations, operation.operationId); fixture.setRuntimeState("lost");
  await expect(reconcilePrimaryWorkspaceRuntimeOperation(fixture.project.id, {
    database: fixture.database, agent: fixture.runtimeAgent, runtimeAvailable: true
  })).resolves.toMatchObject({ activeAction: null, canRetryStart: false,
    reconciledTerminal: { action: "start", state: "failed" } });
  fixture.database.close();
});

test("stale accepted stop reconciles terminal Agent success and persists stopped observations", async () => {
  const fixture = await runtimeFixture();
  const start = fixture.database.prepareRuntimeMutation({ projectId: fixture.project.id, workspaceId: fixture.context.workspace.id,
    actor: "actor", action: "start", runtimePlanHash: fixture.context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" });
  fixture.database.finishRuntimeMutation({ operationId: start.operationId, projectId: fixture.project.id,
    workspaceId: fixture.context.workspace.id, outcome: { state: "succeeded", workspaceObserved: "running",
      runtimeObserved: "running" } });
  const stop = fixture.database.prepareRuntimeMutation({ projectId: fixture.project.id, workspaceId: fixture.context.workspace.id,
    actor: "actor", action: "stop", runtimePlanHash: fixture.context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" });
  fixture.observations.set(stop.operationId, { operationId: stop.operationId, state: "succeeded",
    updatedAt: "2026-07-18T12:00:01.000Z", failure: null });
  fixture.setRuntimeState("stopped");
  await expect(reconcilePrimaryWorkspaceRuntimeOperation(fixture.project.id, {
    database: fixture.database, agent: fixture.runtimeAgent, runtimeAvailable: true
  })).resolves.toMatchObject({ activeAction: null, canRetryStart: false,
    reconciledTerminal: { action: "stop", state: "succeeded" } });
  expect(fixture.database.listRuntimeOperations(fixture.project.id, fixture.context.workspace.id)[0]).toMatchObject({
    operationId: stop.operationId, state: "succeeded"
  });
  expect(fixture.database.listRuntimeStacks()[0]).toMatchObject({ observedState: "stopped" });
  expect(fixture.database.listWorkspaceServices()[0]).toMatchObject({ observedState: "stopped" });
  fixture.database.close();
});

test("terminal Agent success cannot leave a stale Web operation when current inspection is lost", async () => {
  const fixture = await runtimeFixture();
  const operation = fixture.database.prepareRuntimeMutation({ projectId: fixture.project.id, workspaceId: fixture.context.workspace.id,
    actor: "actor", action: "start", runtimePlanHash: fixture.context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" });
  fixture.observations.set(operation.operationId, { operationId: operation.operationId, state: "succeeded",
    updatedAt: "2026-07-18T12:00:01.000Z", failure: null });
  fixture.setRuntimeState("lost");
  await expect(reconcilePrimaryWorkspaceRuntimeOperation(fixture.project.id, {
    database: fixture.database, agent: fixture.runtimeAgent, runtimeAvailable: true
  })).resolves.toMatchObject({ activeAction: null, canRetryStart: false,
    reconciledTerminal: { action: "start", state: "succeeded" }, inspection: { observedState: "lost" } });
  expect(fixture.database.listRuntimeOperations(fixture.project.id, fixture.context.workspace.id)[0]).toMatchObject({
    operationId: operation.operationId, state: "succeeded"
  });
  expect(fixture.database.listRuntimeStacks()[0]).toMatchObject({ observedState: "lost" });
  expect(fixture.database.listWorkspaceServices()[0]).toMatchObject({ observedState: "lost" });
  fixture.database.close();
});

test("missing Agent observation leaves stale Web intent active and prevents any parallel durable intent", async () => {
  const fixture = await runtimeFixture();
  const operation = fixture.database.prepareRuntimeMutation({ projectId: fixture.project.id, workspaceId: fixture.context.workspace.id,
    actor: "actor", action: "start", runtimePlanHash: fixture.context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" });
  const reconciled = await reconcilePrimaryWorkspaceRuntimeOperation(fixture.project.id, {
    database: fixture.database, agent: fixture.runtimeAgent, runtimeAvailable: true
  });
  expect(reconciled).toMatchObject({ activeAction: "start", activeOperationId: operation.operationId,
    canStart: false, canStop: false, canRetryStart: false });
  const replay = fixture.database.prepareRuntimeMutation({ projectId: fixture.project.id, workspaceId: fixture.context.workspace.id,
    actor: "actor", action: "start", runtimePlanHash: fixture.context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" });
  expect(replay.operationId).toBe(operation.operationId);
  expect(() => fixture.database.prepareRuntimeMutation({ projectId: fixture.project.id, workspaceId: fixture.context.workspace.id,
    actor: "actor", action: "stop", runtimePlanHash: fixture.context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" }))
    .toThrow("still in progress");
  expect(fixture.database.listRuntimeOperations(fixture.project.id, fixture.context.workspace.id)).toHaveLength(1);
  expect(fixture.database.getRuntimeContext(fixture.project.id).workspace.desiredState).toBe("running");
  expect(fixture.database.listRuntimeStacks()[0]?.desiredState).toBe("running");
  fixture.database.close();
});

test.each(["accepted", "running"] as const)("Agent %s remains the active runtime action and prevents another durable intent", async (state) => {
  const fixture = await runtimeFixture();
  const operation = fixture.database.prepareRuntimeMutation({ projectId: fixture.project.id, workspaceId: fixture.context.workspace.id,
    actor: "actor", action: "start", runtimePlanHash: fixture.context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" });
  fixture.observations.set(operation.operationId, { operationId: operation.operationId, state,
    updatedAt: "2026-07-18T12:00:01.000Z", failure: null });

  await expect(reconcilePrimaryWorkspaceRuntimeOperation(fixture.project.id, {
    database: fixture.database, agent: fixture.runtimeAgent, runtimeAvailable: true
  })).resolves.toMatchObject({ activeAction: "start", activeOperationId: operation.operationId,
    canStart: false, canStop: false, canRetryStart: false, blockingReason: "active-runtime-operation" });
  const replay = fixture.database.prepareRuntimeMutation({ projectId: fixture.project.id, workspaceId: fixture.context.workspace.id,
    actor: "actor", action: "start", runtimePlanHash: fixture.context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" });
  expect(replay.operationId).toBe(operation.operationId);
  await expect(mutatePrimaryWorkspaceRuntime("start", fixture.project.id, "actor", {
    database: fixture.database, agent: fixture.runtimeAgent
  })).rejects.toMatchObject({ code: "RUNTIME_ACTION_IN_PROGRESS" });
  await expect(mutatePrimaryWorkspaceRuntime("stop", fixture.project.id, "actor", {
    database: fixture.database, agent: fixture.runtimeAgent
  })).rejects.toMatchObject({ code: "RUNTIME_ACTION_IN_PROGRESS" });
  expect(fixture.startCalls()).toBe(0);
  expect(fixture.database.listRuntimeOperations(fixture.project.id, fixture.context.workspace.id)).toHaveLength(1);
  fixture.database.close();
});

test("failed Web start with a missing matching Agent observation rejects the actual mutation path without a new operation", async () => {
  const fixture = await runtimeFixture();
  const failed = fixture.database.prepareRuntimeMutation({ projectId: fixture.project.id, workspaceId: fixture.context.workspace.id,
    actor: "actor", action: "start", runtimePlanHash: fixture.context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" });
  fixture.database.finishRuntimeMutation({ operationId: failed.operationId, projectId: fixture.project.id,
    workspaceId: fixture.context.workspace.id, outcome: { state: "failed", code: "AGENT_INTERNAL_ERROR",
      message: "Persisted failure is not retry proof." } });
  fixture.setRuntimeState("stopped");
  const before = fixture.database.listRuntimeOperations(fixture.project.id, fixture.context.workspace.id);

  await expect(reconcilePrimaryWorkspaceRuntimeOperation(fixture.project.id, {
    database: fixture.database, agent: fixture.runtimeAgent, runtimeAvailable: true
  })).resolves.toMatchObject({ canStart: false, canRetryStart: false, retryOperationId: null,
    blockingReason: "failed-start-unproven" });
  await expect(mutatePrimaryWorkspaceRuntime("start", fixture.project.id, "actor", {
    database: fixture.database, agent: fixture.runtimeAgent
  })).rejects.toMatchObject({ code: "RUNTIME_ACTION_NOT_AUTHORIZED" });
  expect(fixture.startCalls()).toBe(0);
  expect(fixture.database.listRuntimeOperations(fixture.project.id, fixture.context.workspace.id)).toEqual(before);
  fixture.database.close();
});

test("failed Web start with only an unrelated Agent failure cannot expose retry", async () => {
  const fixture = await runtimeFixture();
  const failed = fixture.database.prepareRuntimeMutation({ projectId: fixture.project.id, workspaceId: fixture.context.workspace.id,
    actor: "actor", action: "start", runtimePlanHash: fixture.context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" });
  fixture.database.finishRuntimeMutation({ operationId: failed.operationId, projectId: fixture.project.id,
    workspaceId: fixture.context.workspace.id, outcome: { state: "failed", code: "AGENT_INTERNAL_ERROR", message: "Stale Web failure." } });
  fail(fixture.observations, "018f0f00-0000-7000-8000-000000000077");
  fixture.setRuntimeState("stopped");

  await expect(reconcilePrimaryWorkspaceRuntimeOperation(fixture.project.id, {
    database: fixture.database, agent: fixture.runtimeAgent, runtimeAvailable: true
  })).resolves.toMatchObject({ canStart: false, canRetryStart: false, retryOperationId: null,
    blockingReason: "failed-start-unproven" });
  expect(fixture.database.listRuntimeOperations(fixture.project.id, fixture.context.workspace.id)).toHaveLength(1);
  fixture.database.close();
});

test("matching failed Agent proof remains fail-closed when the snapshot itself is unavailable", async () => {
  const fixture = await runtimeFixture();
  const failed = fixture.database.prepareRuntimeMutation({ projectId: fixture.project.id, workspaceId: fixture.context.workspace.id,
    actor: "actor", action: "start", runtimePlanHash: fixture.context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" });
  fixture.database.finishRuntimeMutation({ operationId: failed.operationId, projectId: fixture.project.id,
    workspaceId: fixture.context.workspace.id, outcome: { state: "failed", code: "AGENT_INTERNAL_ERROR", message: "Failed." } });
  fail(fixture.observations, failed.operationId); fixture.setRuntimeState("stopped");

  await expect(reconcilePrimaryWorkspaceRuntimeOperation(fixture.project.id, {
    database: fixture.database, agent: fixture.runtimeAgent, snapshot: null, runtimeAvailable: true
  })).resolves.toMatchObject({ canStart: false, canRetryStart: false, retryOperationId: null,
    blockingReason: "agent-snapshot-unavailable" });
  fixture.database.close();
});

test("an unexpected future Agent operation state remains active and cannot terminalize success", async () => {
  const fixture = await runtimeFixture();
  const operation = fixture.database.prepareRuntimeMutation({ projectId: fixture.project.id, workspaceId: fixture.context.workspace.id,
    actor: "actor", action: "start", runtimePlanHash: fixture.context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" });
  const snapshot = await fixture.runtimeAgent.snapshot();
  const unexpected = { ...snapshot, operationObservations: [{ operationId: operation.operationId, state: "future-running",
    updatedAt: "2026-07-18T12:00:01.000Z", failure: null }] } as unknown as AgentSnapshotData;

  await expect(reconcilePrimaryWorkspaceRuntimeOperation(fixture.project.id, {
    database: fixture.database, agent: fixture.runtimeAgent, snapshot: unexpected, runtimeAvailable: true
  })).resolves.toMatchObject({ activeAction: "start", activeOperationId: operation.operationId,
    canStart: false, canStop: false });
  expect(fixture.database.listRuntimeOperations(fixture.project.id, fixture.context.workspace.id)[0]).toMatchObject({
    operationId: operation.operationId, state: "accepted"
  });
  fixture.database.close();
});

test("a newer terminal runtime operation supersedes an older failed start instead of exposing retry", async () => {
  const fixture = await runtimeFixture();
  const failed = fixture.database.prepareRuntimeMutation({ projectId: fixture.project.id, workspaceId: fixture.context.workspace.id,
    actor: "actor", action: "start", runtimePlanHash: fixture.context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" });
  fixture.database.finishRuntimeMutation({ operationId: failed.operationId, projectId: fixture.project.id,
    workspaceId: fixture.context.workspace.id, outcome: { state: "failed", code: "AGENT_INTERNAL_ERROR", message: "Failed." } });
  fail(fixture.observations, failed.operationId); fixture.setRuntimeState("stopped");
  const newer = fixture.database.prepareRuntimeMutation({ projectId: fixture.project.id, workspaceId: fixture.context.workspace.id,
    actor: "actor", action: "stop", runtimePlanHash: fixture.context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" });
  fixture.database.finishRuntimeMutation({ operationId: newer.operationId, projectId: fixture.project.id,
    workspaceId: fixture.context.workspace.id, outcome: { state: "succeeded", workspaceObserved: "stopped", runtimeObserved: "stopped" } });

  await expect(reconcilePrimaryWorkspaceRuntimeOperation(fixture.project.id, {
    database: fixture.database, agent: fixture.runtimeAgent, runtimeAvailable: true
  })).resolves.toMatchObject({ canStart: true, canRetryStart: false, retryOperationId: null });
  fixture.database.close();
});
