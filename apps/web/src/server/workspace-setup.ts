import {
  canonicalizeProjectOptionsV1,
  canonicalizeRuntimePlanV1,
  compileRuntimePlanV1,
  hashProjectOptionsV1,
  hashRuntimePlanV1,
  parseProjectOptionsV1
} from "@devspace/project-options";
import { gitBranchNameSchema } from "@devspace/contracts";
import type { WorkspaceAgentClient } from "./agent-client.js";
import type { ManagedProjectView, ProjectDatabase } from "./database.js";

export class WorkspaceSetupValidationError extends Error {
  constructor(message: string) { super(message); this.name = "WorkspaceSetupValidationError"; }
}
export class WorkspaceSetupExecutionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WorkspaceSetupExecutionError"; }
}

export interface WorkspaceSetupInput { readonly imageReference: string }
export type WorkspaceSetupAgent = Pick<WorkspaceAgentClient,
  "health" | "inspectSource" | "registerRevision" | "registerRuntimePlan" | "createManagedStore" | "fetchProject" |
  "createWorkspace" | "snapshot" | "inspectGit" | "inspectWorkspace">;

export function parseWorkspaceSetupInput(value: unknown): WorkspaceSetupInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceSetupValidationError("Enter development environment details.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "imageReference")) {
    throw new WorkspaceSetupValidationError("The request contains unknown fields.");
  }
  const imageReference = typeof record.imageReference === "string" ? record.imageReference.trim() : "";
  const hasControlCharacter = [...imageReference].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (imageReference.length < 1 || imageReference.length > 512 || hasControlCharacter) {
    throw new WorkspaceSetupValidationError("Enter a valid development container image reference.");
  }
  return { imageReference };
}

function initialProjectOptions(input: WorkspaceSetupInput) {
  return parseProjectOptionsV1({
    schemaVersion: 1,
    developmentEnvironment: { source: { kind: "image", imageReference: input.imageReference } }
  });
}

async function completeMutation(
  database: ProjectDatabase,
  agent: Pick<WorkspaceAgentClient, "snapshot">,
  operation: ReturnType<ProjectDatabase["getOrCreateOperation"]>,
  execute: () => Promise<void>,
  polling: { deadline: number; now: () => number; sleep: (milliseconds: number) => Promise<void> }
): Promise<void> {
  if (operation.state === "succeeded") return;
  if (operation.state === "failed") {
    throw new WorkspaceSetupExecutionError(operation.errorCode ?? "SETUP_FAILED", operation.errorMessage ?? "Workspace setup failed.");
  }
  await execute();
  let delayMs = 25;
  while (polling.now() < polling.deadline) {
    const observation = (await agent.snapshot()).operationObservations.find((item) => item.operationId === operation.operationId);
    if (observation?.state === "failed") {
      database.finishOperation(operation.operationId, {
        state: "failed", code: observation.failure.code, message: observation.failure.message
      });
      throw new WorkspaceSetupExecutionError(observation.failure.code, observation.failure.message);
    }
    if (observation?.state === "succeeded") {
      database.finishOperation(operation.operationId, { state: "succeeded" });
      return;
    }
    const remaining = polling.deadline - polling.now();
    if (remaining <= 0) break;
    await polling.sleep(Math.min(delayMs, remaining));
    delayMs = Math.min(Math.ceil(delayMs * 1.7), 1_000);
  }
  throw new WorkspaceSetupExecutionError("SETUP_IN_PROGRESS", "Workspace setup is still running safely. Retry to continue observing the same setup.");
}

export async function setupPrimaryWorkspace(input: WorkspaceSetupInput, projectId: string, actor: string, dependencies: {
  readonly database: ProjectDatabase; readonly agent: WorkspaceSetupAgent;
  readonly orchestrationTimeoutMs?: number; readonly nowMonotonic?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): Promise<{
  readonly project: ManagedProjectView;
  readonly git: Awaited<ReturnType<WorkspaceAgentClient["inspectGit"]>>;
  readonly workspace: Awaited<ReturnType<WorkspaceAgentClient["inspectWorkspace"]>>;
}> {
  await dependencies.agent.health();
  const options = initialProjectOptions(input);
  const configurationJson = canonicalizeProjectOptionsV1(options);
  const configurationHash = hashProjectOptionsV1(options);
  const runtimePlan = compileRuntimePlanV1(options);
  const compiledRuntimePlanJson = canonicalizeRuntimePlanV1(runtimePlan);
  const runtimePlanHash = hashRuntimePlanV1(runtimePlan);
  const setup = dependencies.database.preparePrimaryWorkspace({ projectId, configurationJson, configurationHash,
    compiledRuntimePlanJson, runtimePlanHash, actor });
  const nowMonotonic = dependencies.nowMonotonic ?? (() => Date.now());
  const polling = {
    deadline: nowMonotonic() + (dependencies.orchestrationTimeoutMs ?? 120_000), now: nowMonotonic,
    sleep: dependencies.sleep ?? (async (milliseconds: number) => await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  };

  if (setup.project.state !== "ready") {
    const revisionData = {
      projectId, revisionId: setup.revision.id,
      configuration: { format: "devspace.project-options/v1" as const, hash: configurationHash, canonicalJson: configurationJson }
    };
    const register = dependencies.database.getOrCreateOperation({
      projectId, actor, operationName: "configuration-revision.register", resourceType: "configuration-revision", resourceId: setup.revision.id
    });
    await completeMutation(dependencies.database, dependencies.agent, register, async () => {
      await dependencies.agent.registerRevision(register.operationId, revisionData);
    }, polling);

    const registerRuntimePlan = dependencies.database.getOrCreateOperation({
      projectId, actor, operationName: "configuration-runtime-plan.register", resourceType: "configuration-revision", resourceId: setup.revision.id
    });
    await completeMutation(dependencies.database, dependencies.agent, registerRuntimePlan, async () => {
      await dependencies.agent.registerRuntimePlan(registerRuntimePlan.operationId, {
        projectId, revisionId: setup.revision.id, revisionHash: configurationHash,
        runtimePlan: { format: "devspace.runtime-plan/v1", hash: runtimePlanHash, canonicalJson: compiledRuntimePlanJson }
      });
    }, polling);

    const createStore = dependencies.database.getOrCreateOperation({
      projectId, actor, operationName: "project.managed-store.create", resourceType: "project", resourceId: projectId
    });
    await completeMutation(dependencies.database, dependencies.agent, createStore, async () => {
      await dependencies.agent.createManagedStore(createStore.operationId, {
        projectId, source: { kind: "remote", url: setup.project.repositoryUrl }
      });
    }, polling);

    const fetch = dependencies.database.getOrCreateOperation({
      projectId, actor, operationName: "project.fetch", resourceType: "project", resourceId: projectId
    });
    await completeMutation(dependencies.database, dependencies.agent, fetch, async () => {
      await dependencies.agent.fetchProject(fetch.operationId, projectId);
    }, polling);

    const branchName = gitBranchNameSchema.parse(setup.project.defaultBranch);
    const createWorkspace = dependencies.database.getOrCreateOperation({
      projectId, actor, operationName: "workspace.create", resourceType: "workspace", resourceId: setup.workspaceId
    });
    await completeMutation(dependencies.database, dependencies.agent, createWorkspace, async () => {
      await dependencies.agent.createWorkspace(createWorkspace.operationId, {
        projectId, workspaceId: setup.workspaceId, kind: "primary",
        revision: { revisionId: setup.revision.id, revisionHash: configurationHash },
        branchName,
        baseRef: { kind: "branch", branchName }
      });
    }, polling);
  }

  const [git, workspace] = await Promise.all([
    dependencies.agent.inspectGit(projectId, setup.workspaceId),
    dependencies.agent.inspectWorkspace(projectId, setup.workspaceId)
  ]);
  if (workspace.observedState !== "stopped" || workspace.runtimeStack.observedState !== "absent") {
    throw new WorkspaceSetupExecutionError("WORKSPACE_STATE_CONFLICT", "The primary workspace was created but is not safely stopped without a runtime.");
  }
  const project = dependencies.database.finalizePrimaryWorkspace({
    projectId, revisionId: setup.revision.id, workspaceId: setup.workspaceId,
    branchName: setup.project.defaultBranch, baseRef: setup.project.defaultBranch, actor,
    dirtyState: git.dirty ? "dirty" : "clean"
  });
  return { project, git, workspace };
}
