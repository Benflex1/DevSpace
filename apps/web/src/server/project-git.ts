import { gitCommitDataSchema, gitWorkspaceFileDataSchema, type GitInspectionData } from "@devspace/contracts";
import { v7 as uuidv7 } from "uuid";
import { AgentResponseError, AgentUnavailableError, type FullAgentClient } from "./agent-client.js";
import { type ProjectDatabase, ProjectSetupConflictError } from "./database.js";
import { persistedFailureMessage } from "./failure-policy.js";
import { SafeWebFailure, type SafeFailureMetadata } from "./user-facing-failure.js";

export class ProjectGitError extends SafeWebFailure {
  constructor(code: string, message: string, metadata: SafeFailureMetadata = {}) {
    super(code, message, metadata);
    this.name = "ProjectGitError";
  }
}

export function primaryWorkspaceId(projectId: string, database: ProjectDatabase): string {
  const project = database.getManagedProject(projectId);
  if (project === undefined) throw new ProjectSetupConflictError("The project was not found.");
  if (project.state !== "ready" || project.primaryWorkspace === null) {
    throw new ProjectSetupConflictError("A ready project with a managed primary workspace is required.");
  }
  return project.primaryWorkspace.id;
}

export async function inspectProjectGit(projectId: string, database: ProjectDatabase, agent: FullAgentClient): Promise<GitInspectionData> {
  return await agent.inspectGit(projectId, primaryWorkspaceId(projectId, database));
}

export type GitMutationInput =
  | { readonly action: "stage"; readonly path: string }
  | { readonly action: "unstage"; readonly path: string }
  | { readonly action: "commit"; readonly message: string; readonly userName?: string; readonly userEmail?: string };

export type GitMutationResult = {
  readonly operationId: string;
  readonly state: "succeeded" | "in-progress";
  readonly status?: GitInspectionData;
  readonly commitOid?: string | null;
};

function failureFromAgent(error: AgentResponseError, operationId: string): ProjectGitError {
  return new ProjectGitError(error.code, persistedFailureMessage(error.code), {
    failureCategory: error.failureCategory, retryable: error.retryable, incidentId: error.incidentId,
    requestId: error.requestId, operationId, diagnosticContext: error.diagnosticContext, messageOwnership: "agent-code"
  });
}

export async function mutateProjectGit(projectId: string, input: GitMutationInput, dependencies: {
  readonly database: ProjectDatabase;
  readonly agent: FullAgentClient;
  readonly timeoutMs?: number;
}): Promise<GitMutationResult> {
  const workspaceId = primaryWorkspaceId(projectId, dependencies.database);
  const operationId = uuidv7();
  try {
    if (input.action === "stage") {
      const data = gitWorkspaceFileDataSchema.parse({ projectId, workspaceId, path: input.path });
      await dependencies.agent.stageWorkspaceFile(operationId, data);
    } else if (input.action === "unstage") {
      const data = gitWorkspaceFileDataSchema.parse({ projectId, workspaceId, path: input.path });
      await dependencies.agent.unstageWorkspaceFile(operationId, data);
    } else {
      const data = gitCommitDataSchema.parse({ projectId, workspaceId, message: input.message,
        ...(input.userName === undefined ? {} : { userName: input.userName }),
        ...(input.userEmail === undefined ? {} : { userEmail: input.userEmail }) });
      await dependencies.agent.commitWorkspace(operationId, data);
    }
  } catch (error) {
    if (error instanceof AgentResponseError) throw failureFromAgent(error, operationId);
    if (error instanceof AgentUnavailableError) return { operationId, state: "in-progress" };
    throw error;
  }

  const deadline = Date.now() + (dependencies.timeoutMs ?? 10_000);
  let delay = 25;
  while (Date.now() < deadline) {
    try {
      const snapshot = await dependencies.agent.snapshot();
      const observation = snapshot.operationObservations.find((candidate) => candidate.operationId === operationId);
      if (observation?.state === "succeeded") {
        const status = await dependencies.agent.inspectGit(projectId, workspaceId);
        return { operationId, state: "succeeded", status, ...(input.action === "commit" ? { commitOid: status.headCommit } : {}) };
      }
      if (observation?.state === "failed") {
        throw new ProjectGitError(observation.failure.code, persistedFailureMessage(observation.failure.code), {
          retryable: observation.failure.retryable, operationId, messageOwnership: "agent-code"
        });
      }
    } catch (error) {
      if (error instanceof ProjectGitError) throw error;
      if (!(error instanceof AgentResponseError) && !(error instanceof AgentUnavailableError)) throw error;
      return { operationId, state: "in-progress" };
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(Math.ceil(delay * 1.7), 500);
  }
  return { operationId, state: "in-progress" };
}
