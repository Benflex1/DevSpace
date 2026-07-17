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
  observations.clear(); let runtimeState: "stopped" | "running" = "stopped"; let planRegistrations = 0; const persistedBeforeAgent: boolean[] = [];
  const runtimeAgent = {
    ...setupAgent,
    runtimeStatus: () => Promise.resolve({ rootlessRuntime: "available" as const, operationJournal: "available" as const, checkedAt: "2026-07-17T12:00:00.000Z" }),
    registerRuntimePlan: (operationId) => { planRegistrations += 1; succeed(operationId); return Promise.resolve(); },
    startWorkspace: (operationId) => {
      persistedBeforeAgent.push(database.listOperations().some((item) => item.operationId === operationId && item.operationName === "workspace.start" && item.state === "accepted")
        && database.listRuntimeStacks().some((item) => item.desiredState === "running"));
      runtimeState = "running"; succeed(operationId); return Promise.resolve();
    },
    stopWorkspace: (operationId) => {
      persistedBeforeAgent.push(database.listOperations().some((item) => item.operationId === operationId && item.operationName === "workspace.stop" && item.state === "accepted")
        && database.listRuntimeStacks().some((item) => item.desiredState === "stopped"));
      runtimeState = "stopped"; succeed(operationId); return Promise.resolve();
    },
    inspectWorkspace: (projectId, selectedWorkspaceId) => Promise.resolve(workspaceInspectionDataSchema.parse({ projectId, workspaceId: selectedWorkspaceId,
      kind: "primary", revisionId, revisionHash, desiredState: runtimeState, observedState: runtimeState, dirty: false,
      runtimeStack: { desiredState: runtimeState, observedState: runtimeState } }))
  } satisfies WorkspaceAgentClient;
  await mutatePrimaryWorkspaceRuntime("start", project.id, "actor", { database, agent: runtimeAgent });
  await mutatePrimaryWorkspaceRuntime("stop", project.id, "actor", { database, agent: runtimeAgent });
  await mutatePrimaryWorkspaceRuntime("start", project.id, "actor", { database, agent: runtimeAgent });
  expect(planRegistrations).toBe(1);
  expect(persistedBeforeAgent).toEqual([true, true, true]);
  expect(typeof database.listConfigRevisions()[0]?.compiledRuntimePlanJson).toBe("string");
  expect(typeof database.listConfigRevisions()[0]?.runtimePlanHash).toBe("string");
  expect(database.listRuntimeStacks()).toEqual([expect.objectContaining({ runtimeGeneration: 1, desiredState: "running", observedState: "running" })]);
  expect(database.listWorkspaceServices()).toEqual([expect.objectContaining({ desiredState: "running", observedState: "running" })]);
  expect(database.listOperations().filter((operation) => operation.operationName === "workspace.start")).toHaveLength(2);
  database.close();
});
