import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { gitInspectionDataSchema, workspaceInspectionDataSchema, type AgentOperationObservation } from "@devspace/contracts";
import { createApprovedPreviewBase, createApprovedPreviewBaseRegistry } from "@devspace/security";
import { parseProjectOptionsV1 } from "@devspace/project-options";
import { openProjectDatabase } from "./database.js";
import { parseWorkspaceSetupInput, setupPrimaryWorkspace, type WorkspaceSetupAgent } from "./workspace-setup.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function approvedPreviewRegistry() {
  const base = createApprovedPreviewBase("preview-main", "preview.example.com", "-preview");
  if (!base.ok) throw new Error("The test preview base is invalid.");
  const registry = createApprovedPreviewBaseRegistry([base.value]);
  if (!registry.ok) throw new Error("The test preview registry is invalid.");
  return registry.value;
}

function successfulSetupAgent(): WorkspaceSetupAgent {
  const observations = new Map<string, AgentOperationObservation>();
  let revisionId = "";
  let revisionHash = "";
  const succeeded = (operationId: string) => observations.set(operationId, {
    operationId, state: "succeeded", updatedAt: "2026-07-17T12:00:00.000Z", failure: null
  });
  return {
    health: () => Promise.resolve({ status: "ok" as const }),
    inspectSource: () => Promise.reject(new Error("unused")),
    registerRevision: (operationId, data) => { revisionId = data.revisionId; revisionHash = data.configuration.hash; succeeded(operationId); return Promise.resolve(); },
    registerRuntimePlan: (operationId) => { succeeded(operationId); return Promise.resolve(); },
    createManagedStore: (operationId) => { succeeded(operationId); return Promise.resolve(); },
    fetchProject: (operationId) => { succeeded(operationId); return Promise.resolve(); },
    createWorkspace: (operationId) => { succeeded(operationId); return Promise.resolve(); },
    snapshot: () => Promise.resolve({
      agentBootId: "018f0f00-0000-7000-8000-000000000099",
      throughCursor: "v1.018f0f00-0000-7000-8000-000000000000.0" as const,
      resources: [], operationObservations: [...observations.values()]
    }),
    inspectGit: (projectId, workspaceId) => Promise.resolve(gitInspectionDataSchema.parse({
      projectId, workspaceId, branchName: "main", headCommit: "a".repeat(40), dirty: false, aheadCount: 0, behindCount: 0
    })),
    inspectWorkspace: (projectId, workspaceId) => Promise.resolve(workspaceInspectionDataSchema.parse({
      projectId, workspaceId, kind: "primary", revisionId, revisionHash,
      desiredState: "stopped", observedState: "stopped", dirty: false,
      runtimeStack: { desiredState: "absent", observedState: "absent" }
    }))
  };
}

test("persists a ready primary workspace and recovers it without repeating Agent mutations", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-setup-test-")); directories.push(directory);
  const databasePath = path.join(directory, "devspace.sqlite");
  let database = openProjectDatabase(databasePath);
  const project = database.createProject({
    name: "Repository", slug: "repository", repositoryUrl: "https://example.com/repository.git",
    defaultBranch: "main", actor: "developer@example.com"
  });
  const observations = new Map<string, AgentOperationObservation>();
  let revisionId = ""; let revisionHash = ""; let workspaceId = "";
  const succeeded = (operationId: string) => observations.set(operationId, {
    operationId, state: "succeeded", updatedAt: "2026-07-17T12:00:00.000Z", failure: null
  });
  const mutations = vi.fn((_name: string) => undefined);
  const agent = {
    health: () => Promise.resolve({ status: "ok" as const }),
    inspectSource: () => Promise.reject(new Error("unused")),
    registerRevision: (operationId, data) => { mutations("register"); revisionId = data.revisionId; revisionHash = data.configuration.hash; succeeded(operationId); return Promise.resolve(); },
    registerRuntimePlan: (operationId) => { mutations("runtime-plan"); succeeded(operationId); return Promise.resolve(); },
    createManagedStore: (operationId) => { mutations("store"); succeeded(operationId); return Promise.resolve(); },
    fetchProject: (operationId) => { mutations("fetch"); succeeded(operationId); return Promise.resolve(); },
    createWorkspace: (operationId, data) => { mutations("workspace"); workspaceId = data.workspaceId; succeeded(operationId); return Promise.resolve(); },
    snapshot: () => Promise.resolve({
      agentBootId: "018f0f00-0000-7000-8000-000000000099",
      throughCursor: "v1.018f0f00-0000-7000-8000-000000000099.0" as const,
      resources: [], operationObservations: [...observations.values()]
    }),
    inspectGit: (requestedProjectId, requestedWorkspaceId) => Promise.resolve(gitInspectionDataSchema.parse({
      projectId: requestedProjectId, workspaceId: requestedWorkspaceId, branchName: "main",
      headCommit: "a".repeat(40), dirty: false, aheadCount: 0, behindCount: 0
    })),
    inspectWorkspace: (requestedProjectId, requestedWorkspaceId) => Promise.resolve(workspaceInspectionDataSchema.parse({
      projectId: requestedProjectId, workspaceId: requestedWorkspaceId, kind: "primary", revisionId, revisionHash,
      desiredState: "stopped", observedState: "stopped", dirty: false,
      runtimeStack: { desiredState: "absent", observedState: "absent" }
    }))
  } satisfies WorkspaceSetupAgent;

  const result = await setupPrimaryWorkspace({ imageReference: "node:24-bookworm" }, project.id, "developer@example.com", { database, agent });
  expect(result.project).toMatchObject({ state: "ready", activeRevision: { number: 1 }, primaryWorkspace: { id: workspaceId, observedState: "stopped" } });
  expect(result.workspace.runtimeStack).toEqual({ desiredState: "absent", observedState: "absent" });
  expect(mutations.mock.calls.map(([name]) => name)).toEqual(["register", "runtime-plan", "store", "fetch", "workspace"]);
  database.close();

  database = openProjectDatabase(databasePath);
  const recovered = await setupPrimaryWorkspace({ imageReference: "node:24-bookworm" }, project.id, "developer@example.com", { database, agent });
  expect(recovered.project.primaryWorkspace?.id).toBe(workspaceId);
  expect(database.listManagedProjects()[0]).toMatchObject({ state: "ready", primaryWorkspace: { desiredState: "stopped" } });
  expect(mutations).toHaveBeenCalledTimes(5);
  database.close();
});

test("initial setup stores a workspace preview and matching development port, then materializes it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-setup-preview-")); directories.push(directory);
  const database = openProjectDatabase(path.join(directory, "devspace.sqlite"));
  const project = database.createProject({
    name: "Repository", slug: "repository", repositoryUrl: "https://example.com/repository.git",
    defaultBranch: "main", actor: "developer@example.com"
  });
  const result = await setupPrimaryWorkspace({
    imageReference: "node:24-bookworm",
    tasks: [{ key: "check", displayName: "Check workspace", executable: "/usr/bin/printf", args: ["ok"] }],
    preview: { key: "web", displayName: "Web", containerPort: 5173, domainBaseId: "preview-main" }
  }, project.id, "developer@example.com", {
    database, agent: successfulSetupAgent(), previewBaseRegistry: approvedPreviewRegistry()
  });
  const revision = database.listConfigRevisions()[0];
  if (revision === undefined || result.project.primaryWorkspace === null || result.project.activeRevision === null) {
    throw new Error("The setup test did not create its expected revision and workspace.");
  }
  const options = parseProjectOptionsV1(JSON.parse(revision.configurationJson));
  expect(options.developmentEnvironment.ports).toEqual([{ name: "web", containerPort: 5173, protocol: "tcp" }]);
  expect(options.previews).toEqual([expect.objectContaining({
    key: "web", displayName: "Web", target: { kind: "workspace" }, containerPort: 5173,
    domainBaseId: "preview-main", hostnamePattern: "{project}-{workspace}-{preview}-{shortId}",
    protocol: "http", healthPath: "/", healthStatuses: [200], startupTimeoutSeconds: 60, webSocketForwarding: true
  })]);
  expect(options.tasks).toEqual([expect.objectContaining({ key: "check", displayName: "Check workspace" })]);

  database.materializePreviews({ projectId: project.id, workspaceId: result.project.primaryWorkspace.id,
    revisionId: result.project.activeRevision.id, previewBaseRegistry: approvedPreviewRegistry() });
  const materialized = database.getManagedProject(project.id)?.previews;
  expect(materialized).toHaveLength(1);
  expect(materialized?.[0]).toMatchObject({ previewKey: "web", displayName: "Web", containerPort: 5173 });
  expect(materialized?.[0]?.hostname).toMatch(/^repository-primary-web-[0-9a-f]{8}-preview\.preview\.example\.com$/u);
  database.close();
});

test("rejects invalid preview ports before setup mutations", () => {
  for (const containerPort of [0, 65536, 5173.5, "5173"]) {
    expect(() => parseWorkspaceSetupInput({ imageReference: "node:24-bookworm", preview: {
      key: "web", displayName: "Web", containerPort, domainBaseId: "preview-main"
    }})).toThrow(/valid workspace preview/u);
  }
});

test("rejects a preview base that is not in the administrator registry", async () => {
  const input = parseWorkspaceSetupInput({ imageReference: "node:24-bookworm", preview: {
    key: "web", displayName: "Web", containerPort: 5173, domainBaseId: "attacker-base"
  }});
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-setup-preview-invalid-base-")); directories.push(directory);
  const database = openProjectDatabase(path.join(directory, "devspace.sqlite"));
  const project = database.createProject({
    name: "Repository", slug: "repository", repositoryUrl: "https://example.com/repository.git",
    defaultBranch: "main", actor: "developer@example.com"
  });
  await expect(setupPrimaryWorkspace(input, project.id, "developer@example.com", {
    database, agent: {} as WorkspaceSetupAgent, previewBaseRegistry: approvedPreviewRegistry()
  })).rejects.toThrow("Select an approved preview base.");
  expect(database.listOperations()).toHaveLength(0);
  database.close();
});

test("keeps the project registering when an accepted Agent mutation fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-setup-failure-")); directories.push(directory);
  const database = openProjectDatabase(path.join(directory, "devspace.sqlite"));
  const project = database.createProject({
    name: "Repository", slug: "repository", repositoryUrl: "https://example.com/repository.git",
    defaultBranch: "main", actor: "developer@example.com"
  });
  let failedOperationId = "";
  const agent = {
    health: () => Promise.resolve({ status: "ok" as const }), inspectSource: () => Promise.reject(new Error("unused")),
    registerRevision: (operationId: string) => { failedOperationId = operationId; return Promise.resolve(); },
    registerRuntimePlan: () => Promise.reject(new Error("must not continue")),
    createManagedStore: () => Promise.reject(new Error("must not continue")),
    fetchProject: () => Promise.reject(new Error("must not continue")),
    createWorkspace: () => Promise.reject(new Error("must not continue")),
    snapshot: () => Promise.resolve({
      agentBootId: "018f0f00-0000-7000-8000-000000000099",
      throughCursor: "v1.018f0f00-0000-7000-8000-000000000099.0" as const, resources: [],
      operationObservations: [{
        operationId: failedOperationId, state: "failed" as const, updatedAt: "2026-07-17T12:00:00.000Z",
        failure: { code: "AGENT_INTERNAL_ERROR" as const, message: "The Agent encountered an unexpected error.", retryable: true as const,
          details: { incidentId: "018f0f00-0000-7000-8000-000000000098" } }
      }]
    }),
    inspectGit: () => Promise.reject(new Error("must not inspect")),
    inspectWorkspace: () => Promise.reject(new Error("must not inspect"))
  } satisfies WorkspaceSetupAgent;
  await expect(setupPrimaryWorkspace({ imageReference: "node:24-bookworm" }, project.id, "developer@example.com", { database, agent }))
    .rejects.toMatchObject({ code: "AGENT_INTERNAL_ERROR" });
  expect(database.listManagedProjects()).toEqual([expect.objectContaining({
    id: project.id, state: "registering", activeRevision: null, primaryWorkspace: null
  })]);
  database.close();
});

test("a bounded polling timeout remains recoverable and retry converges on retained identities", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-setup-timeout-")); directories.push(directory);
  const database = openProjectDatabase(path.join(directory, "devspace.sqlite"));
  const project = database.createProject({ name: "Repository", slug: "repository", repositoryUrl: "https://example.com/repository.git", defaultBranch: "main", actor: "actor" });
  const observations = new Map<string, AgentOperationObservation>(); let clock = 0; let complete = false;
  let revisionId = ""; let revisionHash = ""; let workspaceId = "";
  const mutation = (operationId: string) => {
    observations.set(operationId, complete
      ? { operationId, state: "succeeded", updatedAt: "2026-07-17T12:00:00.000Z", failure: null }
      : { operationId, state: "accepted", updatedAt: "2026-07-17T12:00:00.000Z", failure: null });
    return Promise.resolve();
  };
  const agent = {
    health: () => Promise.resolve({ status: "ok" as const }), inspectSource: () => Promise.reject(new Error("unused")),
    registerRevision: (operationId, data) => { revisionId = data.revisionId; revisionHash = data.configuration.hash; return mutation(operationId); },
    registerRuntimePlan: (operationId) => mutation(operationId),
    createManagedStore: (operationId) => mutation(operationId), fetchProject: (operationId) => mutation(operationId),
    createWorkspace: (operationId, data) => { workspaceId = data.workspaceId; return mutation(operationId); },
    snapshot: () => Promise.resolve({ agentBootId: "018f0f00-0000-7000-8000-000000000099", throughCursor: "v1.018f0f00-0000-7000-8000-000000000099.1" as const,
      resources: [], operationObservations: [...observations.values()] }),
    inspectGit: (requestedProjectId, requestedWorkspaceId) => Promise.resolve(gitInspectionDataSchema.parse({ projectId: requestedProjectId, workspaceId: requestedWorkspaceId,
      branchName: "main", headCommit: "a".repeat(40), dirty: false, aheadCount: 0, behindCount: 0 })),
    inspectWorkspace: (requestedProjectId, requestedWorkspaceId) => Promise.resolve(workspaceInspectionDataSchema.parse({ projectId: requestedProjectId,
      workspaceId: requestedWorkspaceId, kind: "primary", revisionId, revisionHash, desiredState: "stopped", observedState: "stopped", dirty: false,
      runtimeStack: { desiredState: "absent", observedState: "absent" } }))
  } satisfies WorkspaceSetupAgent;
  const timing = { orchestrationTimeoutMs: 100, nowMonotonic: () => clock, sleep: (milliseconds: number) => { clock += milliseconds; return Promise.resolve(); } };
  await expect(setupPrimaryWorkspace({ imageReference: "node:24-bookworm" }, project.id, "actor", { database, agent, ...timing }))
    .rejects.toMatchObject({ code: "SETUP_IN_PROGRESS" });
  const retained = database.listOperations();
  expect(retained).toHaveLength(2);
  expect(retained).toEqual(expect.arrayContaining([
    expect.objectContaining({ operationName: "workspace.create", state: "accepted" }),
    expect.objectContaining({ operationName: "configuration-revision.register", state: "accepted" })
  ]));
  const retainedRevision = database.listConfigRevisions()[0]!;
  complete = true; clock = 0;
  const result = await setupPrimaryWorkspace({ imageReference: "node:24-bookworm" }, project.id, "actor", { database, agent, ...timing });
  expect(result.project).toMatchObject({ state: "ready", primaryWorkspace: { id: workspaceId } });
  expect(database.listConfigRevisions()).toHaveLength(1);
  expect(database.listConfigRevisions()[0]!.id).toBe(retainedRevision.id);
  expect(database.listWorkspaces()).toHaveLength(1);
  database.close();
});

test("two same-project setup requests converge on one revision, workspace, and operation set", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-setup-concurrent-")); directories.push(directory);
  const database = openProjectDatabase(path.join(directory, "devspace.sqlite"));
  const project = database.createProject({ name: "Repository", slug: "repository", repositoryUrl: "https://example.com/repository.git", defaultBranch: "main", actor: "actor" });
  const observations = new Map<string, AgentOperationObservation>(); let revisionId = ""; let revisionHash = ""; let workspaceId = "";
  const succeed = async (operationId: string) => {
    await new Promise((resolve) => setImmediate(resolve));
    observations.set(operationId, { operationId, state: "succeeded", updatedAt: "2026-07-17T12:00:00.000Z", failure: null });
  };
  const agent = {
    health: () => Promise.resolve({ status: "ok" as const }), inspectSource: () => Promise.reject(new Error("unused")),
    registerRevision: async (operationId, data) => { revisionId = data.revisionId; revisionHash = data.configuration.hash; await succeed(operationId); },
    registerRuntimePlan: succeed,
    createManagedStore: succeed, fetchProject: async (operationId) => await succeed(operationId),
    createWorkspace: async (operationId, data) => { workspaceId ||= data.workspaceId; expect(data.workspaceId).toBe(workspaceId); await succeed(operationId); },
    snapshot: () => Promise.resolve({ agentBootId: "018f0f00-0000-7000-8000-000000000099", throughCursor: "v1.018f0f00-0000-7000-8000-000000000099.8" as const,
      resources: [], operationObservations: [...observations.values()] }),
    inspectGit: (requestedProjectId, requestedWorkspaceId) => Promise.resolve(gitInspectionDataSchema.parse({ projectId: requestedProjectId, workspaceId: requestedWorkspaceId,
      branchName: "main", headCommit: "b".repeat(40), dirty: false, aheadCount: 0, behindCount: 0 })),
    inspectWorkspace: (requestedProjectId, requestedWorkspaceId) => Promise.resolve(workspaceInspectionDataSchema.parse({ projectId: requestedProjectId,
      workspaceId: requestedWorkspaceId, kind: "primary", revisionId, revisionHash, desiredState: "stopped", observedState: "stopped", dirty: false,
      runtimeStack: { desiredState: "absent", observedState: "absent" } }))
  } satisfies WorkspaceSetupAgent;
  const [left, right] = await Promise.all([
    setupPrimaryWorkspace({ imageReference: "node:24-bookworm" }, project.id, "actor", { database, agent }),
    setupPrimaryWorkspace({ imageReference: "node:24-bookworm" }, project.id, "actor", { database, agent })
  ]);
  expect(left.project.primaryWorkspace?.id).toBe(right.project.primaryWorkspace?.id);
  expect(database.listConfigRevisions()).toHaveLength(1);
  expect(database.listConfigRevisions()[0]).toMatchObject({ revisionNumber: 1, state: "active" });
  expect(database.listWorkspaces()).toHaveLength(1);
  expect(database.listOperations()).toHaveLength(5);
  expect(new Set(database.listOperations().map((operation) => operation.operationName)).size).toBe(5);
  database.close();
});
