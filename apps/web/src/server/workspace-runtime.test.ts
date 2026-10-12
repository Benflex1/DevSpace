import BetterSqlite3 from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { gitInspectionDataSchema, workspaceInspectionDataSchema, type AgentOperationObservation } from "@devspace/contracts";
import type { WorkspaceAgentClient } from "./agent-client.js";
import { openProjectDatabase } from "./database.js";
import { setupPrimaryWorkspace, type WorkspaceSetupAgent } from "./workspace-setup.js";
import { mutatePrimaryWorkspaceRuntime } from "./workspace-runtime.js";

const directories: string[] = [];
afterEach(async () => await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true }))));

test("lazily compiles an old null-plan revision and persists desired state before convergent start/stop", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-web-runtime-")); directories.push(directory);
  const databasePath = path.join(directory, "devspace.sqlite");
  let database = openProjectDatabase(databasePath);
  const project = database.createProject({ name: "Runtime", slug: "runtime", repositoryUrl: "https://example.com/runtime.git", defaultBranch: "main", actor: "actor" });
  const observations = new Map<string, AgentOperationObservation>();
  let revisionId = ""; let revisionHash = "";
  const succeed = (operationId: string) => observations.set(operationId, { operationId, state: "succeeded", updatedAt: "2026-07-17T12:00:00.000Z", failure: null });
  const setupAgent = {
    health: () => Promise.resolve({ status: "ok" as const }), inspectSource: () => Promise.reject(new Error("unused")),
    registerRevision: (operationId, data) => { revisionId = data.revisionId; revisionHash = data.configuration.hash; succeed(operationId); return Promise.resolve(); },
    registerRuntimePlan: (operationId) => { succeed(operationId); return Promise.resolve(); },
    createManagedStore: (operationId) => { succeed(operationId); return Promise.resolve(); },
    fetchProject: (operationId) => { succeed(operationId); return Promise.resolve(); },
    createWorkspace: (operationId) => { succeed(operationId); return Promise.resolve(); },
    snapshot: () => Promise.resolve({ agentBootId: "018f0f00-0000-7000-8000-000000000099", throughCursor: "v1.018f0f00-0000-7000-8000-000000000099.1" as const,
      resources: [], operationObservations: [...observations.values()] }),
    inspectGit: (projectId, selectedWorkspaceId) => Promise.resolve(gitInspectionDataSchema.parse({ projectId, workspaceId: selectedWorkspaceId,
      branchName: "main", headCommit: "a".repeat(40), dirty: false, aheadCount: 0, behindCount: 0 })),
    inspectWorkspace: (projectId, selectedWorkspaceId) => Promise.resolve(workspaceInspectionDataSchema.parse({ projectId, workspaceId: selectedWorkspaceId,
      kind: "primary", revisionId, revisionHash, desiredState: "stopped", observedState: "stopped", dirty: false,
      runtimeStack: { desiredState: "absent", observedState: "absent" } }))
  } satisfies WorkspaceSetupAgent;
  await setupPrimaryWorkspace({ imageReference: "node:24-bookworm" }, project.id, "actor", { database, agent: setupAgent });
  database.close();
  const raw = new BetterSqlite3(databasePath);
  raw.prepare("update project_config_revisions set compiled_runtime_plan_json = null, runtime_plan_hash = null").run();
  raw.prepare("delete from operations where operation_name = 'configuration-runtime-plan.register'").run(); raw.close();
  database = openProjectDatabase(databasePath);
  observations.clear(); let runtimeState: "stopped" | "running" = "stopped"; let planRegistrations = 0;
  let startAttempts = 0; const persistedBeforeAgent: boolean[] = []; const activeActions: Array<string | null> = [];
  const runtimeAgent = {
    ...setupAgent,
    runtimeStatus: () => Promise.resolve({ rootlessRuntime: "available" as const, operationJournal: "available" as const, checkedAt: "2026-07-17T12:00:00.000Z" }),
    registerRuntimePlan: (operationId) => { planRegistrations += 1; succeed(operationId); return Promise.resolve(); },
    startWorkspace: (operationId) => {
      persistedBeforeAgent.push(database.listOperations().some((item) => item.operationId === operationId && item.operationName === "workspace.start" && item.state === "accepted")
        && database.listRuntimeStacks().some((item) => item.desiredState === "running"));
      activeActions.push(database.listRuntimeOperations(project.id, database.getRuntimeContext(project.id).workspace.id)
        .find((item) => item.state === "accepted" || item.state === "running")?.operationName ?? null);
      startAttempts += 1;
      if (startAttempts === 1) {
        const context = database.getRuntimeContext(project.id);
        const concurrent = database.prepareRuntimeMutation({ projectId: project.id, workspaceId: context.workspace.id, actor: "actor",
          action: "start", runtimePlanHash: context.revision.runtimePlanHash!, imageReference: "node:24-bookworm" });
        expect(concurrent.operationId).toBe(operationId);
        expect(database.listOperations().filter((item) => item.operationName === "workspace.start")).toHaveLength(1);
        observations.set(operationId, { operationId, state: "failed", updatedAt: "2026-07-17T12:00:00.000Z",
          failure: { code: "AGENT_INTERNAL_ERROR", message: "Container creation failed safely.", retryable: true,
            details: { incidentId: "018f0f00-0000-7000-8000-000000000098" } } });
        return Promise.resolve();
      }
      runtimeState = "running"; succeed(operationId); return Promise.resolve();
    },
    stopWorkspace: (operationId) => {
      persistedBeforeAgent.push(database.listOperations().some((item) => item.operationId === operationId && item.operationName === "workspace.stop" && item.state === "accepted")
        && database.listRuntimeStacks().some((item) => item.desiredState === "stopped"));
      runtimeState = "stopped"; succeed(operationId); return Promise.resolve();
    },
    listWorkspaceDirectory: () => Promise.resolve({ path: "", entries: [] }),
    readWorkspaceFile: () => Promise.resolve({ path: "README.md", content: "", revision: "a".repeat(64), size: 0 }),
    saveWorkspaceFile: () => Promise.resolve({ path: "README.md", revision: "a".repeat(64) }),
    adoptConfigurationRevision: () => Promise.resolve(),
    inspectWorkspace: (projectId, selectedWorkspaceId) => Promise.resolve(workspaceInspectionDataSchema.parse({ projectId, workspaceId: selectedWorkspaceId,
      kind: "primary", revisionId, revisionHash, desiredState: runtimeState, observedState: runtimeState, dirty: false,
      runtimeStack: { desiredState: runtimeState, observedState: runtimeState } }))
  } satisfies WorkspaceAgentClient;
  await expect(mutatePrimaryWorkspaceRuntime("start", project.id, "actor", { database, agent: runtimeAgent }))
    .rejects.toMatchObject({ code: "AGENT_INTERNAL_ERROR" });
  expect(database.listManagedProjects()[0]).toMatchObject({ runtime: {
    errorMessage: "The DevSpace Agent encountered an unexpected error."
  } });
  await mutatePrimaryWorkspaceRuntime("start", project.id, "actor", { database, agent: runtimeAgent });
  await mutatePrimaryWorkspaceRuntime("stop", project.id, "actor", { database, agent: runtimeAgent });
  await mutatePrimaryWorkspaceRuntime("start", project.id, "actor", { database, agent: runtimeAgent });
  expect(planRegistrations).toBe(1);
  expect(persistedBeforeAgent).toEqual([true, true, true, true]);
  expect(activeActions).toEqual(["workspace.start", "workspace.start", "workspace.start"]);
  expect(typeof database.listConfigRevisions()[0]?.compiledRuntimePlanJson).toBe("string");
  expect(typeof database.listConfigRevisions()[0]?.runtimePlanHash).toBe("string");
  expect(database.listRuntimeStacks()).toEqual([expect.objectContaining({ runtimeGeneration: 1, desiredState: "running", observedState: "running" })]);
  expect(database.listWorkspaceServices()).toEqual([expect.objectContaining({ desiredState: "running", observedState: "running" })]);
  expect(database.listOperations().filter((operation) => operation.operationName === "workspace.start")).toHaveLength(3);
  database.close();
});
