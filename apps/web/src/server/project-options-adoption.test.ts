import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { gitInspectionDataSchema, workspaceInspectionDataSchema, type AgentOperationObservation } from "@devspace/contracts";
import { createApprovedPreviewBase, createApprovedPreviewBaseRegistry } from "@devspace/security";
import { parseProjectOptionsV1 } from "@devspace/project-options";
import { openProjectDatabase } from "./database.js";
import { readProjectOptions, saveProjectOptionsDraft, applyProjectOptions, type ProjectOptionsAdoptionAgent } from "./project-options-adoption.js";
import { reconcilePrimaryWorkspaceRuntimeOperation } from "./runtime-operation-reconciliation.js";
import { setupPrimaryWorkspace, type WorkspaceSetupAgent } from "./workspace-setup.js";

const directories: string[] = [];
afterEach(async () => await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true }))));

function previewRegistry() {
  const base = createApprovedPreviewBase("preview-main", "preview.example.com", "-preview");
  if (!base.ok) throw new Error("test-preview-base-invalid");
  const registry = createApprovedPreviewBaseRegistry([base.value]);
  if (!registry.ok) throw new Error("test-preview-registry-invalid");
  return registry.value;
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-project-options-adoption-")); directories.push(directory);
  const database = openProjectDatabase(path.join(directory, "devspace.sqlite"));
  const project = database.createProject({ name: "Options", slug: "options-project",
    repositoryUrl: "https://example.com/options.git", defaultBranch: "main", actor: "owner@example.com" });
  const observations = new Map<string, AgentOperationObservation>();
  let agentRevisionId = "";
  let agentRevisionHash = "";
  let running = false;
  let holdAdoption = false;
  let adoptionCalls = 0;
  let workspaceInspectionCalls = 0;
  let workspaceInspectionGate: { readonly callNumber: number; readonly entered: () => void; readonly wait: Promise<void> } | null = null;
  const succeed = (operationId: string) => observations.set(operationId, {
    operationId, state: "succeeded", updatedAt: "2026-10-12T12:00:00.000Z", failure: null
  });
  const agent = {
    health: () => Promise.resolve({ status: "ok" as const }),
    inspectSource: () => Promise.reject(new Error("unused")),
    registerRevision: (operationId: string) => {
      succeed(operationId); return Promise.resolve();
    },
    registerRuntimePlan: (operationId: string) => { succeed(operationId); return Promise.resolve(); },
    createManagedStore: (operationId: string) => { succeed(operationId); return Promise.resolve(); },
    fetchProject: (operationId: string) => { succeed(operationId); return Promise.resolve(); },
    createWorkspace: (operationId: string, data: { revision: { revisionId: string; revisionHash: string } }) => {
      agentRevisionId = data.revision.revisionId; agentRevisionHash = data.revision.revisionHash; succeed(operationId); return Promise.resolve();
    },
    runtimeStatus: () => Promise.resolve({ rootlessRuntime: "available" as const, operationJournal: "available" as const,
      checkedAt: "2026-10-12T12:00:00.000Z" }),
    snapshot: () => Promise.resolve({ agentBootId: "018f0f00-0000-7000-8000-000000000099",
      throughCursor: "v1.018f0f00-0000-7000-8000-000000000099.1" as const,
      resources: [], operationObservations: [...observations.values()] }),
    inspectGit: (projectId: string, workspaceId: string | null) => Promise.resolve(gitInspectionDataSchema.parse({
      projectId, workspaceId, branchName: "main", headCommit: "a".repeat(40), dirty: false, aheadCount: 0, behindCount: 0
    })),
    inspectWorkspace: async (projectId: string, workspaceId: string) => {
      workspaceInspectionCalls += 1;
      const gate = workspaceInspectionGate;
      if (gate !== null && workspaceInspectionCalls === gate.callNumber) {
        workspaceInspectionGate = null;
        gate.entered();
        await gate.wait;
      }
      return workspaceInspectionDataSchema.parse({
        projectId, workspaceId, kind: "primary", revisionId: agentRevisionId, revisionHash: agentRevisionHash,
        desiredState: running ? "running" : "stopped", observedState: running ? "running" : "stopped", dirty: true,
        runtimeStack: { desiredState: running ? "running" : "absent", observedState: running ? "running" : "absent" }
      });
    },
    adoptConfigurationRevision: (operationId: string, data: { candidateRevision: { revisionId: string; revisionHash: string } }) => {
      adoptionCalls += 1;
      agentRevisionId = data.candidateRevision.revisionId; agentRevisionHash = data.candidateRevision.revisionHash;
      observations.set(operationId, { operationId, state: holdAdoption ? "running" : "succeeded",
        updatedAt: "2026-10-12T12:00:00.000Z", failure: null });
      return Promise.resolve();
    }
  } satisfies WorkspaceSetupAgent & ProjectOptionsAdoptionAgent;
  const registry = previewRegistry();
  await setupPrimaryWorkspace({ imageReference: "node:24-bookworm", tasks: [{ key: "check", displayName: "Check",
    executable: "/usr/bin/printf", args: ["old"] }], preview: { key: "web", displayName: "Web", containerPort: 4173,
    domainBaseId: "preview-main" } }, project.id, "owner@example.com", {
    database, agent, previewBaseRegistry: registry
  });
  const current = readProjectOptions(project.id, { database, previewBaseRegistry: registry });
  const nextPreviews = current.activeRevision.options.previews.map((preview) => ({ ...preview, containerPort: 5180 }));
  const nextOptions = parseProjectOptionsV1({
    ...current.activeRevision.options,
    developmentEnvironment: { ...current.activeRevision.options.developmentEnvironment,
      source: { kind: "image", imageReference: "node:26-bookworm" },
      ports: nextPreviews.map((preview) => ({ name: preview.key, containerPort: preview.containerPort, protocol: "tcp" })) },
    tasks: current.activeRevision.options.tasks.map((task) => ({ ...task, displayName: "Check updated" })),
    previews: nextPreviews
  });
  const saved = saveProjectOptionsDraft({ projectId: project.id, actor: "owner@example.com",
    expectedRevision: { revisionId: current.activeRevision.id, revisionHash: current.activeRevision.hash }, options: nextOptions }, {
    database, previewBaseRegistry: registry
  });
  const dependencies = { database, agent, previewBaseRegistry: registry };
  return { database, project, agent, registry, current, nextOptions, saved, dependencies, observations,
    setRunning: (value: boolean) => { running = value; },
    setHoldAdoption: (value: boolean) => { holdAdoption = value; },
    holdNextWorkspaceInspection: () => {
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      workspaceInspectionGate = { callNumber: workspaceInspectionCalls + 1, entered, wait };
      return { entered: enteredPromise, release };
    },
    finishAdoption: (operationId: string) => succeed(operationId), adoptionCalls: () => adoptionCalls };
}

test("loads the saved active revision and validates a complete immutable draft", async () => {
  const value = await fixture();
  expect(value.current.activeRevision.options.developmentEnvironment.source).toEqual({ kind: "image", imageReference: "node:24-bookworm" });
  expect(value.current.activeRevision.options.tasks[0]?.displayName).toBe("Check");
  expect(value.current.activeRevision.options.previews[0]?.containerPort).toBe(4173);
  expect(value.saved.options.developmentEnvironment.source).toEqual({ kind: "image", imageReference: "node:26-bookworm" });
  expect(value.saved.options.tasks[0]?.displayName).toBe("Check updated");
  expect(value.saved.options.previews[0]?.containerPort).toBe(5180);
  expect(() => saveProjectOptionsDraft({ projectId: value.project.id, actor: "owner@example.com",
    expectedRevision: { revisionId: value.current.activeRevision.id, revisionHash: value.current.activeRevision.hash },
    options: { ...value.nextOptions, previews: [{ ...value.nextOptions.previews[0], domainBaseId: "unapproved" }] } }, {
    database: value.database, previewBaseRegistry: value.registry
  })).toThrow(/domain|preview|approved/iu);
  value.database.close();
});

test("Apply activates Web and workspace revision pointers only after stopped Agent adoption", async () => {
  const value = await fixture();
  const result = await applyProjectOptions({ projectId: value.project.id, actor: "owner@example.com",
    expectedRevision: { revisionId: value.current.activeRevision.id, revisionHash: value.current.activeRevision.hash },
    candidateRevisionId: value.saved.id }, value.dependencies);
  expect(result).toMatchObject({ state: "applied", activeRevisionId: value.saved.id, runtimeState: "absent" });
  expect(value.database.getProjectOptionsState(value.project.id)).toMatchObject({
    project: { activeConfigRevisionId: value.saved.id }, workspace: { configRevisionId: value.saved.id }, activeRevision: { state: "active" }
  });
  expect(JSON.parse(value.database.getProjectOptionsState(value.project.id).activeRevision.configurationJson)).toMatchObject({
    developmentEnvironment: { source: { kind: "image", imageReference: "node:26-bookworm" } },
    tasks: [{ key: "check", displayName: "Check updated" }], previews: [{ key: "web", containerPort: 5180 }]
  });
  expect(value.database.listPreviews(value.project.id, value.current.workspaceId)).toMatchObject([
    { configRevisionId: value.saved.id, containerPort: 5180, desiredState: "active", routePresent: false }
  ]);
  expect(value.database.getPendingProjectOptionsApply(value.project.id)).toBeNull();
  expect(value.database.getCompletedProjectOptionsApply(value.project.id, value.saved.id)?.state).toBe("succeeded");
  await expect(applyProjectOptions({ projectId: value.project.id, actor: "owner@example.com",
    expectedRevision: { revisionId: value.current.activeRevision.id, revisionHash: value.current.activeRevision.hash },
    candidateRevisionId: value.saved.id }, value.dependencies)).resolves.toMatchObject({
    state: "applied", operationId: result.operationId, activeRevisionId: value.saved.id
  });
  value.database.close();
});

test("a stopped-state rejection keeps the old revision authoritative", async () => {
  const value = await fixture(); value.setRunning(true);
  await expect(applyProjectOptions({ projectId: value.project.id, actor: "owner@example.com",
    expectedRevision: { revisionId: value.current.activeRevision.id, revisionHash: value.current.activeRevision.hash },
    candidateRevisionId: value.saved.id }, value.dependencies)).rejects.toMatchObject({ code: "WORKSPACE_STATE_CONFLICT" });
  expect(value.database.getProjectOptionsState(value.project.id).activeRevision.id).toBe(value.current.activeRevision.id);
  expect(value.adoptionCalls()).toBe(0);
  expect(value.database.getPendingProjectOptionsApply(value.project.id)).toBeNull();
  value.database.close();
});

test("recovers after Agent ownership changes and after Web activation commits", async () => {
  const value = await fixture(); value.setHoldAdoption(true);
  const request = { projectId: value.project.id, actor: "owner@example.com",
    expectedRevision: { revisionId: value.current.activeRevision.id, revisionHash: value.current.activeRevision.hash },
    candidateRevisionId: value.saved.id };
  const pending = await applyProjectOptions(request, { ...value.dependencies, timeoutMs: 0 });
  expect(pending.state).toBe("pending");
  expect(value.database.getProjectOptionsState(value.project.id).activeRevision.id).toBe(value.current.activeRevision.id);
  expect(value.database.getPendingProjectOptionsApply(value.project.id)?.phase).toBe("adoption-submitted");
  const pendingStatus = await reconcilePrimaryWorkspaceRuntimeOperation(value.project.id, {
    database: value.database, agent: value.agent, runtimeAvailable: true
  });
  expect(pendingStatus).toMatchObject({ canStart: false, canStop: false, blockingReason: "configuration-apply",
    configurationApply: { operationId: pending.operationId, candidateRevisionId: value.saved.id } });
  expect(() => value.database.getRuntimeContext(value.project.id)).toThrow(/Apply is in progress/iu);

  value.finishAdoption(pending.operationId);
  const recovered = await applyProjectOptions(request, value.dependencies);
  expect(recovered).toMatchObject({ state: "applied", activeRevisionId: value.saved.id });
  const replayed = await applyProjectOptions(request, value.dependencies);
  expect(replayed).toMatchObject({ state: "applied", operationId: recovered.operationId });
  expect(value.adoptionCalls()).toBe(1);
  value.database.close();
});

test("a delayed duplicate Apply cannot fail the shared reservation after Agent ownership changes", async () => {
  const value = await fixture(); value.setHoldAdoption(true);
  const request = { projectId: value.project.id, actor: "owner@example.com",
    expectedRevision: { revisionId: value.current.activeRevision.id, revisionHash: value.current.activeRevision.hash },
    candidateRevisionId: value.saved.id };
  const gate = value.holdNextWorkspaceInspection();
  const delayedApply = applyProjectOptions(request, { ...value.dependencies, timeoutMs: 0 });
  await gate.entered;
  const operationId = value.database.getPendingProjectOptionsApply(value.project.id)?.operation.operationId;

  const adoptingApply = await applyProjectOptions(request, { ...value.dependencies, timeoutMs: 0 });
  expect(adoptingApply).toMatchObject({ state: "pending", operationId });
  expect(value.database.getProjectOptionsState(value.project.id).activeRevision.id).toBe(value.current.activeRevision.id);
  expect(value.database.getPendingProjectOptionsApply(value.project.id)?.phase).toBe("adoption-submitted");
  const agentAfterAdoption = await value.agent.inspectWorkspace(value.project.id, value.current.workspaceId);
  expect(agentAfterAdoption.revisionId).toBe(value.saved.id);

  gate.release();
  const delayedResult = await delayedApply;
  expect(delayedResult).toMatchObject({ state: "pending", activeRevisionId: value.current.activeRevision.id });
  expect(value.database.getPendingProjectOptionsApply(value.project.id)?.phase).toBe("adoption-submitted");
  expect(value.database.getProjectOptionsState(value.project.id).activeRevision.id).toBe(value.current.activeRevision.id);
  expect(value.database.getCompletedProjectOptionsApply(value.project.id, value.saved.id)).toBeNull();
  value.database.close();
});

test("expected-revision compare-and-swap rejects stale Apply before contacting the Agent", async () => {
  const value = await fixture();
  const staleExpected = { revisionId: value.current.activeRevision.id, revisionHash: `sha256-jcs-v1:${"f".repeat(64)}` };
  await expect(applyProjectOptions({ projectId: value.project.id, actor: "owner@example.com",
    expectedRevision: staleExpected, candidateRevisionId: value.saved.id }, value.dependencies)).rejects.toThrow(/revision changed/iu);
  expect(value.adoptionCalls()).toBe(0);
  expect(value.database.getProjectOptionsState(value.project.id).activeRevision.id).toBe(value.current.activeRevision.id);
  value.database.close();
});
