import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { gitInspectionDataSchema, workspaceInspectionDataSchema, type AgentOperationObservation } from "@devspace/contracts";
import { createApprovedPreviewBase, createApprovedPreviewBaseRegistry } from "@devspace/security";
import { openProjectDatabase, getProjectDatabase } from "./database.js";
import { loadProjectWorkspaceData } from "./project-workspace.js";
import { setupPrimaryWorkspace, type WorkspaceSetupAgent } from "./workspace-setup.js";

vi.mock("./agent-client.js", () => ({
  createAgentClient: () => ({ health: () => Promise.reject(new Error("Agent unavailable for materialization test.")) })
}));

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function previewRegistry() {
  const base = createApprovedPreviewBase("preview-main", "preview.example.com", "-preview");
  if (!base.ok) throw new Error("The test preview base is invalid.");
  const registry = createApprovedPreviewBaseRegistry([base.value]);
  if (!registry.ok) throw new Error("The test preview registry is invalid.");
  return registry.value;
}

function setupAgent(): WorkspaceSetupAgent {
  const observations = new Map<string, AgentOperationObservation>();
  let revisionId = "";
  let revisionHash = "";
  const succeed = (operationId: string) => observations.set(operationId, {
    operationId, state: "succeeded", updatedAt: "2026-07-17T12:00:00.000Z", failure: null
  });
  return {
    health: () => Promise.resolve({ status: "ok" as const }),
    inspectSource: () => Promise.reject(new Error("unused")),
    registerRevision: (operationId, data) => { revisionId = data.revisionId; revisionHash = data.configuration.hash; succeed(operationId); return Promise.resolve(); },
    registerRuntimePlan: (operationId) => { succeed(operationId); return Promise.resolve(); },
    createManagedStore: (operationId) => { succeed(operationId); return Promise.resolve(); },
    fetchProject: (operationId) => { succeed(operationId); return Promise.resolve(); },
    createWorkspace: (operationId) => { succeed(operationId); return Promise.resolve(); },
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

test("normal project loading materializes a preview from the active setup revision", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-project-loading-preview-")); directories.push(directory);
  const databasePath = path.join(directory, "devspace.sqlite");
  const database = openProjectDatabase(databasePath);
  const project = database.createProject({
    name: "Repository", slug: "repository", repositoryUrl: "https://example.com/repository.git",
    defaultBranch: "main", actor: "developer@example.com"
  });
  const registry = previewRegistry();
  const setup = await setupPrimaryWorkspace({
    imageReference: "node:24-bookworm",
    preview: { key: "web", displayName: "Web", containerPort: 5173, domainBaseId: "preview-main" }
  }, project.id, "developer@example.com", { database, agent: setupAgent(), previewBaseRegistry: registry });
  expect(setup.project.state).toBe("ready");
  database.close();

  vi.stubEnv("DEVSPACE_DATABASE_PATH", databasePath);
  vi.stubEnv("DEVSPACE_APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("DEVSPACE_AUTH_MODE", "development");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEVSPACE_PREVIEW_BASES", JSON.stringify([{ id: "preview-main", domain: "preview.example.com", labelSuffix: "-preview" }]));
  const loaded = await loadProjectWorkspaceData(project.id);
  expect(loaded?.project.previews).toEqual([expect.objectContaining({ previewKey: "web", containerPort: 5173 })]);
  expect(loaded?.pushAvailable).toBe(false);
  getProjectDatabase(databasePath).close();
});

test("keeps the project page usable while surfacing a preview materialization diagnostic", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-project-loading-preview-diagnostic-")); directories.push(directory);
  const databasePath = path.join(directory, "devspace.sqlite");
  const database = openProjectDatabase(databasePath);
  const project = database.createProject({
    name: "Repository", slug: "repository", repositoryUrl: "https://example.com/repository.git",
    defaultBranch: "main", actor: "developer@example.com"
  });
  const registry = previewRegistry();
  const setup = await setupPrimaryWorkspace({
    imageReference: "node:24-bookworm",
    preview: { key: "web", displayName: "Web", containerPort: 5173, domainBaseId: "preview-main" }
  }, project.id, "developer@example.com", { database, agent: setupAgent(), previewBaseRegistry: registry });
  database.materializePreviews({ projectId: project.id, workspaceId: setup.project.primaryWorkspace!.id,
    revisionId: setup.project.activeRevision!.id, previewBaseRegistry: registry });
  database.close();

  vi.stubEnv("DEVSPACE_DATABASE_PATH", databasePath);
  vi.stubEnv("DEVSPACE_APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("DEVSPACE_AUTH_MODE", "development");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEVSPACE_PREVIEW_BASES", JSON.stringify([{ id: "preview-main", domain: "other.example.com", labelSuffix: "-preview" }]));
  const loaded = await loadProjectWorkspaceData(project.id);
  expect(loaded?.project.id).toBe(project.id);
  expect(loaded?.previewMaterializationError).toBe("Preview configuration could not be materialized safely. Review the active Project Options and preview base configuration.");
  getProjectDatabase(databasePath).close();
});
