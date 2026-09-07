import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  gitInspectionDataSchema,
  gitBranchNameSchema,
  workspaceInspectionDataSchema,
  type AgentSnapshotData,
  type AgentOperationObservation,
  type GitInspectionData
} from "@devspace/contracts";
import type { Operation } from "@devspace/database";
import { openProjectDatabase, type ProjectDatabase } from "./database.js";
import { AgentResponseError, AgentUnavailableError, type FullAgentClient } from "./agent-client.js";
import {
  confirmProjectPush,
  prepareProjectPush,
  projectPushActionSchema,
  type ProjectPushStatus
} from "./project-push.js";
import { setupPrimaryWorkspace, type WorkspaceSetupAgent } from "./workspace-setup.js";

const projectId = "018f0f00-0000-7000-8000-000000000101";
const workspaceId = "018f0f00-0000-7000-8000-000000000102";
const connectionId = "018f0f00-0000-7000-8000-000000000103";
const operationId = "018f0f00-0000-7000-8000-000000000104";
const repositoryId = "9007199254740993";
const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const branchName = gitBranchNameSchema.parse("feature/push");
const actor = "owner@example.test";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const source = { kind: "github-app" as const, connectionId, repositoryId };
const retainedSource = {
  projectId, connectionId, repositoryId, ownerLogin: "owner-org", name: "private-repo", fullName: "owner-org/private-repo",
  cleanHttpsUrl: "https://github.com/owner-org/private-repo.git", defaultBranch: "main", private: true, archived: false, disabled: false,
  verifiedAt: "2026-09-07T00:00:00.000Z", metadataUpdatedAt: "2026-09-07T00:00:00.000Z", rowVersion: 1
};

function inspection(commit = commitA, branch = branchName): GitInspectionData {
  return { projectId, workspaceId, branchName: branch, headCommit: commit, dirty: false, aheadCount: 1, behindCount: 0 };
}

function observation(state: "accepted" | "running" | "succeeded" | "failed", failure?: Exclude<AgentOperationObservation["failure"], null>): AgentOperationObservation {
  if (state === "failed") {
    if (failure === undefined) throw new Error("A failed observation needs a failure.");
    return { operationId, state, updatedAt: "2026-09-07T00:00:00.000Z", failure };
  }
  return { operationId, state, updatedAt: "2026-09-07T00:00:00.000Z", failure: null };
}

function snapshot(next: AgentOperationObservation): AgentSnapshotData {
  return {
    agentBootId: "018f0f00-0000-7000-8000-000000000105",
    throughCursor: "v1.018f0f00-0000-7000-8000-000000000000.0",
    resources: [], operationObservations: [next]
  };
}

function createFixture(options: {
  readonly authority?: { readonly lifecycleGeneration: number; readonly admitted: boolean };
  readonly inspection?: () => GitInspectionData;
  readonly push?: () => Promise<void>;
  readonly snapshot?: () => Promise<AgentSnapshotData>;
} = {}) {
  let operation: Operation | undefined;
  const recordGithubAuthorityFailure = vi.fn();
  const database = {
    getRuntimeContext: vi.fn(() => ({
      project: { id: projectId, state: "ready" as const },
      workspace: { id: workspaceId, kind: "primary" as const, branchName },
      revision: { id: "018f0f00-0000-7000-8000-000000000106" }
    })),
    getProjectSourceLocator: vi.fn(() => source),
    getProjectGithubSource: vi.fn(() => retainedSource),
    getGithubAuthorityContext: vi.fn(() => ({ connectionId, cleanupState: "settled" as const,
      lifecycleState: options.authority?.admitted === false ? "disconnected" as const : "enabled" as const,
      lifecycleGeneration: options.authority?.lifecycleGeneration ?? 1, admitted: options.authority?.admitted ?? true })),
    prepareProjectPushOperation: vi.fn((input: { projectId: string; workspaceId: string; actor: string; progressJson: string }) => {
      operation = { operationId, projectId: input.projectId, workspaceId: input.workspaceId, actor: input.actor,
        operationName: "project.push", resourceType: "workspace", resourceId: input.workspaceId, state: "accepted",
        progressJson: input.progressJson, errorCode: null, errorMessage: null, createdAt: "2026-09-07T00:00:00.000Z",
        startedAt: null, finishedAt: null };
      return operation;
    }),
    getProjectPushOperation: vi.fn(() => operation),
    getLatestProjectPushOperation: vi.fn(() => operation),
    claimProjectPushOperation: vi.fn((input: { progressJson: string }) => {
      if (operation === undefined) throw new Error("missing-operation");
      operation = { ...operation, state: "running", startedAt: "2026-09-07T00:00:00.000Z", progressJson: input.progressJson };
      return operation;
    }),
    finishOperation: vi.fn((finishedOperationId: string, result: { state: "succeeded" } | { state: "failed"; code: string; message: string }) => {
      if (operation?.operationId !== finishedOperationId) return;
      operation = { ...operation, state: result.state, finishedAt: "2026-09-07T00:00:00.000Z",
        errorCode: result.state === "failed" ? result.code : null, errorMessage: result.state === "failed" ? result.message : null };
    }),
    recordGithubAuthorityFailure,
    applyExecutionSnapshot: vi.fn()
  } as unknown as ProjectDatabase;
  const agent = {
    inspectGit: vi.fn(() => Promise.resolve((options.inspection ?? (() => inspection()))())),
    pushProject: vi.fn(options.push ?? (() => Promise.resolve())),
    snapshot: vi.fn(options.snapshot ?? (() => Promise.resolve(snapshot(observation("succeeded")))))
  } as unknown as FullAgentClient;
  return { database, agent, recordGithubAuthorityFailure, getOperation: () => operation };
}

function setupAgent(): WorkspaceSetupAgent {
  const observations = new Map<string, AgentOperationObservation>();
  let revisionId = "";
  let revisionHash = "";
  const succeed = (id: string) => observations.set(id, { operationId: id, state: "succeeded",
    updatedAt: "2026-09-07T00:00:00.000Z", failure: null });
  return {
    health: () => Promise.resolve({ status: "ok" as const }),
    inspectSource: () => Promise.reject(new Error("unused")),
    registerRevision: (id, data) => { revisionId = data.revisionId; revisionHash = data.configuration.hash; succeed(id); return Promise.resolve(); },
    registerRuntimePlan: (id) => { succeed(id); return Promise.resolve(); },
    createManagedStore: (id) => { succeed(id); return Promise.resolve(); },
    fetchProject: (id) => { succeed(id); return Promise.resolve(); },
    createWorkspace: (id) => { succeed(id); return Promise.resolve(); },
    snapshot: () => Promise.resolve({ agentBootId: "018f0f00-0000-7000-8000-000000000107",
      throughCursor: "v1.018f0f00-0000-7000-8000-000000000000.0" as const,
      resources: [], operationObservations: [...observations.values()] }),
    inspectGit: (requestedProjectId, requestedWorkspaceId) => Promise.resolve(gitInspectionDataSchema.parse({ projectId: requestedProjectId,
      workspaceId: requestedWorkspaceId, branchName: "main", headCommit: commitA, dirty: false, aheadCount: 0, behindCount: 0 })),
    inspectWorkspace: (requestedProjectId, requestedWorkspaceId) => Promise.resolve(workspaceInspectionDataSchema.parse({ projectId: requestedProjectId,
      workspaceId: requestedWorkspaceId, kind: "primary" as const, revisionId, revisionHash,
      desiredState: "stopped" as const, observedState: "stopped" as const, dirty: false,
      runtimeStack: { desiredState: "absent" as const, observedState: "absent" as const } }))
  };
}

async function prepare(fixture: ReturnType<typeof createFixture>): Promise<ProjectPushStatus> {
  return await prepareProjectPush(projectId, actor, { database: fixture.database, agent: fixture.agent });
}

test("browser push actions are strict and preparation captures server-observed identity", async () => {
  expect(projectPushActionSchema.safeParse({ action: "prepare", repositoryUrl: retainedSource.cleanHttpsUrl }).success).toBe(false);
  expect(projectPushActionSchema.safeParse({ action: "confirm", operationId, commitOid: commitB }).success).toBe(false);
  const fixture = createFixture();
  const prepared = await prepare(fixture);
  expect(prepared).toMatchObject({ operationId, state: "prepared", repository: retainedSource.fullName, branchName, commitOid: commitA });
  const captured = JSON.parse(fixture.getOperation()!.progressJson!) as Record<string, unknown>;
  expect(captured).toMatchObject({ projectId, workspaceId, branchName, commitOid: commitA, githubAuthorityGeneration: 1,
    source: { kind: "github-app", connectionId, repositoryId } });
});

test("confirmation pushes the captured commit to exactly the same branch and supports a new remote branch", async () => {
  const fixture = createFixture();
  await prepare(fixture);
  const result = await confirmProjectPush(projectId, actor, operationId, { database: fixture.database, agent: fixture.agent });
  expect(result).toMatchObject({ operationId, state: "succeeded", branchName, commitOid: commitA });
  expect(fixture.agent.pushProject).toHaveBeenCalledWith(operationId, {
    projectId, workspaceId, source, branchName, commitOid: commitA, githubAuthorityGeneration: 1
  });
  const request = (fixture.agent.pushProject as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as Record<string, unknown>;
  expect(JSON.stringify(request)).not.toContain("HEAD");
});

test("branch or commit drift before confirmation rejects without requesting write authority", async () => {
  // Use a fixture whose initial capture is stable, then make its confirmation read drift.
  const drifting = createFixture();
  await prepare(drifting);
  (drifting.agent.inspectGit as ReturnType<typeof vi.fn>).mockResolvedValueOnce(inspection(commitB));
  await expect(confirmProjectPush(projectId, actor, operationId, { database: drifting.database, agent: drifting.agent }))
    .rejects.toMatchObject({ code: "GITHUB_PUSH_INTENT_STALE" });
  expect(drifting.agent.pushProject).not.toHaveBeenCalled();
  expect(drifting.getOperation()).toMatchObject({ state: "failed", errorCode: "GITHUB_PUSH_INTENT_STALE" });
});

test("disconnected or stale authority rejects before push", async () => {
  const prepared = createFixture({ authority: { lifecycleGeneration: 1, admitted: false } });
  await expect(prepare(prepared)).rejects.toMatchObject({ code: "GITHUB_CONNECTION_DISABLED" });
  const stale = createFixture();
  await prepare(stale);
  vi.spyOn(stale.database, "getGithubAuthorityContext").mockReturnValue({ connectionId, lifecycleGeneration: 2,
    lifecycleState: "enabled", cleanupState: "settled", admitted: true, refreshable: false });
  await expect(confirmProjectPush(projectId, actor, operationId, { database: stale.database, agent: stale.agent }))
    .rejects.toMatchObject({ code: "GITHUB_AUTHORITY_GENERATION_STALE" });
  expect(stale.agent.pushProject).not.toHaveBeenCalled();
});

test("missing contents write permission is clear and never falls back to a read token", async () => {
  const fixture = createFixture({ push: () => Promise.reject(new AgentResponseError(
    "GITHUB_CONTENTS_WRITE_PERMISSION_REQUIRED", "ignored", false
  )) });
  await prepare(fixture);
  await expect(confirmProjectPush(projectId, actor, operationId, { database: fixture.database, agent: fixture.agent }))
    .rejects.toMatchObject({ code: "GITHUB_CONTENTS_WRITE_PERMISSION_REQUIRED", message: "GitHub Contents write permission is required. Reauthorize the GitHub App connection." });
  expect(fixture.getOperation()).toMatchObject({ state: "failed", errorCode: "GITHUB_CONTENTS_WRITE_PERMISSION_REQUIRED" });
  expect(fixture.recordGithubAuthorityFailure).toHaveBeenCalledWith({ actor, connectionId,
    lifecycleGeneration: 1, failureCode: "GITHUB_CONTENTS_WRITE_PERMISSION_REQUIRED", lifecycleState: "permission-required" });
});

test("non-fast-forward is useful, terminal, and never automatically retried", async () => {
  const fixture = createFixture({ snapshot: () => Promise.resolve(snapshot(observation("failed", {
    code: "GITHUB_PUSH_NON_FAST_FORWARD", message: "ignored", retryable: false, details: {}
  }))) });
  await prepare(fixture);
  let firstFailure: unknown;
  try { await confirmProjectPush(projectId, actor, operationId, { database: fixture.database, agent: fixture.agent }); }
  catch (error) { firstFailure = error; }
  expect(firstFailure).toMatchObject({ code: "GITHUB_PUSH_NON_FAST_FORWARD" });
  expect(firstFailure instanceof Error ? firstFailure.message : "").toContain("Fetch first");
  await expect(confirmProjectPush(projectId, actor, operationId, { database: fixture.database, agent: fixture.agent }))
    .rejects.toMatchObject({ code: "GITHUB_PUSH_NON_FAST_FORWARD" });
  expect(fixture.agent.pushProject).toHaveBeenCalledTimes(1);
});

test("ambiguous post-launch outcome is terminal and a later confirmation cannot resend", async () => {
  const fixture = createFixture({ push: () => Promise.reject(new AgentUnavailableError("AGENT_REQUEST_TIMEOUT")) });
  await prepare(fixture);
  await expect(confirmProjectPush(projectId, actor, operationId, { database: fixture.database, agent: fixture.agent }))
    .rejects.toMatchObject({ code: "GITHUB_PUSH_OUTCOME_UNCERTAIN" });
  expect(fixture.getOperation()).toMatchObject({ state: "failed", errorCode: "GITHUB_PUSH_OUTCOME_UNCERTAIN" });
  await expect(confirmProjectPush(projectId, actor, operationId, { database: fixture.database, agent: fixture.agent }))
    .rejects.toMatchObject({ code: "GITHUB_PUSH_OUTCOME_UNCERTAIN" });
  expect(fixture.agent.pushProject).toHaveBeenCalledTimes(1);
});

test("reopening the Web database terminalizes a submitted push while retaining its captured intent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-push-restart-"));
  directories.push(directory);
  const databasePath = path.join(directory, "devspace.sqlite");
  let database = openProjectDatabase(databasePath);
  const project = database.createProject({ name: "Repository", slug: "push-restart", repositoryUrl: "https://example.com/repository.git",
    defaultBranch: "main", actor });
  await setupPrimaryWorkspace({ imageReference: "node:24-bookworm" }, project.id, actor, { database, agent: setupAgent() });
  const context = database.getRuntimeContext(project.id);
  const intent = { version: 1, phase: "submitted", projectId: project.id, workspaceId: context.workspace.id,
    source, branchName: "main", commitOid: commitA, githubAuthorityGeneration: 1,
    repositoryFullName: retainedSource.fullName, dirty: false, aheadCount: 0, behindCount: 0 };
  const operation = database.prepareProjectPushOperation({ projectId: project.id, workspaceId: context.workspace.id,
    actor, progressJson: JSON.stringify(intent) });
  database.close();

  database = openProjectDatabase(databasePath);
  const reopened = database.getProjectPushOperation({ operationId: operation.operationId, projectId: project.id, actor });
  expect(reopened).toMatchObject({ state: "failed", errorCode: "GITHUB_PUSH_OUTCOME_UNCERTAIN" });
  expect(JSON.parse(reopened!.progressJson!)).toEqual(intent);
  database.close();
});

test("an Agent uncertainty snapshot terminalizes the matching submitted Web push", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-push-snapshot-"));
  directories.push(directory);
  const database = openProjectDatabase(path.join(directory, "devspace.sqlite"));
  const project = database.createProject({ name: "Repository", slug: "push-snapshot", repositoryUrl: "https://example.com/repository.git",
    defaultBranch: "main", actor });
  await setupPrimaryWorkspace({ imageReference: "node:24-bookworm" }, project.id, actor, { database, agent: setupAgent() });
  const context = database.getRuntimeContext(project.id);
  const intent = { version: 1, phase: "submitted", projectId: project.id, workspaceId: context.workspace.id,
    source, branchName: "main", commitOid: commitA, githubAuthorityGeneration: 1,
    repositoryFullName: retainedSource.fullName, dirty: false, aheadCount: 0, behindCount: 0 };
  const operation = database.prepareProjectPushOperation({ projectId: project.id, workspaceId: context.workspace.id,
    actor, progressJson: JSON.stringify(intent) });
  database.claimProjectPushOperation({ operationId: operation.operationId, projectId: project.id, workspaceId: context.workspace.id,
    actor, expectedProgressJson: JSON.stringify(intent), progressJson: JSON.stringify(intent) });

  database.applyExecutionSnapshot({ agentBootId: "018f0f00-0000-7000-8000-000000000108",
    throughCursor: "v1.018f0f00-0000-7000-8000-000000000000.0", resources: [], operationObservations: [{
      operationId: operation.operationId, state: "failed", updatedAt: "2026-09-07T00:00:00.000Z", failure: {
        code: "GITHUB_PUSH_OUTCOME_UNCERTAIN", message: "Agent interruption", retryable: false, details: {}
      }
    }] });

  const failed = database.getProjectPushOperation({ operationId: operation.operationId, projectId: project.id, actor });
  expect(failed).toMatchObject({ state: "failed", errorCode: "GITHUB_PUSH_OUTCOME_UNCERTAIN" });
  expect(JSON.parse(failed!.progressJson!)).toEqual(intent);
  database.close();
});
