import {
  githubConnectionIdSchema,
  githubDecimalIdSchema,
  gitBranchNameSchema,
  gitObjectIdSchema,
  projectPushDataSchema,
  uuidV7Schema,
  type ProjectPushData
} from "@devspace/contracts";
import * as z from "zod";
import {
  AgentResponseError,
  AgentUnavailableError,
  type FullAgentClient
} from "./agent-client.js";
import {
  type ProjectDatabase
} from "./database.js";
import { persistedFailureMessage } from "./failure-policy.js";
import { SafeWebFailure, type SafeFailureMetadata } from "./user-facing-failure.js";

export const projectPushActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("prepare") }),
  z.strictObject({ action: z.literal("confirm"), operationId: uuidV7Schema })
]);
export type ProjectPushAction = z.infer<typeof projectPushActionSchema>;

const projectPushSourceSchema = z.strictObject({
  kind: z.literal("github-app"),
  connectionId: githubConnectionIdSchema,
  repositoryId: githubDecimalIdSchema
});
const projectPushIntentSchema = z.strictObject({
  version: z.literal(1),
  phase: z.enum(["prepared", "submitted"]),
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  source: projectPushSourceSchema,
  branchName: gitBranchNameSchema,
  commitOid: gitObjectIdSchema,
  githubAuthorityGeneration: z.number().int().min(1).max(2_147_483_647),
  repositoryFullName: z.string().min(3).max(140),
  dirty: z.boolean(),
  aheadCount: z.number().int().min(0).max(2_147_483_647),
  behindCount: z.number().int().min(0).max(2_147_483_647)
});
export type ProjectPushIntent = z.infer<typeof projectPushIntentSchema>;

export interface ProjectPushStatus {
  readonly operationId: string;
  readonly state: "prepared" | "submitted" | "succeeded" | "failed";
  readonly repository: string;
  readonly branchName: string;
  readonly commitOid: string;
  readonly dirty: boolean;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly errorCode: string | null;
  readonly message: string | null;
}

export class ProjectPushError extends SafeWebFailure {
  constructor(code: string, message: string, metadata: SafeFailureMetadata = {}) {
    super(code, message, metadata);
    this.name = "ProjectPushError";
  }
}

export interface ProjectPushDependencies {
  readonly database: ProjectDatabase;
  readonly agent: FullAgentClient;
  readonly timeoutMs?: number;
}

const projectPushFailureCodes = new Set([
  "GITHUB_AUTHORITY_INVALID",
  "GITHUB_CONTENTS_WRITE_PERMISSION_REQUIRED",
  "GITHUB_CONNECTION_DISABLED",
  "GITHUB_AUTHORITY_GENERATION_STALE",
  "GITHUB_INSTALLATION_REMOVED",
  "GITHUB_INSTALLATION_SUSPENDED",
  "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE",
  "GITHUB_UPSTREAM_TRANSIENT",
  "GITHUB_INSTALLATION_UNAVAILABLE",
  "GITHUB_REPOSITORY_NOT_AUTHORIZED",
  "GITHUB_GIT_AUTHENTICATION_FAILED",
  "GITHUB_PUSH_INTENT_STALE",
  "GITHUB_PUSH_NON_FAST_FORWARD",
  "GITHUB_PUSH_OUTCOME_UNCERTAIN",
  "GITHUB_TOKEN_LEASE_ACTIVE",
  "AGENT_INTERNAL_ERROR"
]);

function operationError(operation: {
  readonly operationId: string;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}): ProjectPushError {
  const code = operation.errorCode ?? "GITHUB_PUSH_OUTCOME_UNCERTAIN";
  return new ProjectPushError(code, operation.errorMessage ?? persistedFailureMessage(code), {
    operationId: operation.operationId,
    messageOwnership: projectPushFailureCodes.has(code) ? "agent-code" : "web"
  });
}

function failure(code: string, operationId?: string, message = persistedFailureMessage(code), metadata: SafeFailureMetadata = {}): ProjectPushError {
  return new ProjectPushError(code, message, { ...metadata, ...(operationId === undefined ? {} : { operationId }) });
}

function terminalFailure(
  database: ProjectDatabase,
  operationId: string,
  code: string,
  message = persistedFailureMessage(code),
  metadata: SafeFailureMetadata = {}
): ProjectPushError {
  database.finishOperation(operationId, { state: "failed", code, message });
  return failure(code, operationId, message, metadata);
}

function recordWritePermissionLoss(
  database: ProjectDatabase,
  actor: string,
  intent: ProjectPushIntent
): void {
  try {
    database.recordGithubAuthorityFailure({ actor, connectionId: intent.source.connectionId,
      lifecycleGeneration: intent.githubAuthorityGeneration, failureCode: "GITHUB_CONTENTS_WRITE_PERMISSION_REQUIRED",
      lifecycleState: "permission-required" });
  } catch {
    // A newer lifecycle generation owns the connection; the operation still
    // remains terminal and the user must explicitly reauthorize or prepare again.
  }
}

function readIntent(operation: { readonly progressJson: string | null }): ProjectPushIntent {
  if (operation.progressJson === null) throw new Error("project-push-intent-missing");
  return projectPushIntentSchema.parse(JSON.parse(operation.progressJson));
}

function statusForOperation(operation: {
  readonly operationId: string;
  readonly state: "accepted" | "running" | "succeeded" | "failed" | "cancelled";
  readonly progressJson: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}): ProjectPushStatus {
  const intent = readIntent(operation);
  const state = operation.state === "accepted" ? "prepared"
    : operation.state === "running" ? "submitted"
      : operation.state;
  if (state === "cancelled") throw new Error("project-push-operation-cancelled");
  return {
    operationId: operation.operationId,
    state,
    repository: intent.repositoryFullName,
    branchName: intent.branchName,
    commitOid: intent.commitOid,
    dirty: intent.dirty,
    aheadCount: intent.aheadCount,
    behindCount: intent.behindCount,
    errorCode: operation.errorCode,
    message: operation.errorMessage
  };
}

function sourceFor(database: ProjectDatabase, projectId: string, actor: string) {
  const source = database.getProjectSourceLocator(projectId, actor);
  if (source === null) throw new ProjectPushError("PROJECT_NOT_FOUND", "The project was not found.");
  if (source.kind !== "github-app") {
    throw new ProjectPushError("PUSH_UNSUPPORTED", "Push is available only for private GitHub App repositories.");
  }
  const retained = database.getProjectGithubSource(projectId);
  if (retained === null || retained.connectionId !== source.connectionId || retained.repositoryId !== source.repositoryId || !retained.private) {
    throw new ProjectPushError("PUSH_UNSUPPORTED", "Push is available only for private GitHub App repositories.");
  }
  return { source, retained };
}

async function inspectWorkspaceGit(
  agent: FullAgentClient,
  projectId: string,
  workspaceId: string,
  operationId?: string
) {
  try {
    return await agent.inspectGit(projectId, workspaceId);
  } catch (error) {
    if (error instanceof AgentResponseError) {
      const message = persistedFailureMessage(error.code);
      throw failure(error.code, operationId, message, {
        failureCategory: error.failureCategory,
        retryable: error.retryable,
        incidentId: error.incidentId,
        requestId: error.requestId,
        diagnosticContext: error.diagnosticContext,
        messageOwnership: "agent-code"
      });
    }
    if (error instanceof AgentUnavailableError) {
      throw failure("PUSH_PREPARATION_UNAVAILABLE", operationId,
        "The workspace Git state could not be read safely. Try again.", {
          failureCategory: error.failureCategory,
          retryable: true,
          requestId: error.requestId,
          diagnosticContext: error.diagnosticContext
        });
    }
    throw failure("PUSH_PREPARATION_UNAVAILABLE", operationId,
      "The workspace Git state could not be read safely. Try again.", { retryable: true });
  }
}

function assertCapturedInspection(
  inspection: { readonly branchName: string | null; readonly headCommit: string | null },
  intent: ProjectPushIntent,
  operationId?: string
): void {
  if (inspection.branchName !== intent.branchName || inspection.headCommit !== intent.commitOid) {
    throw failure("GITHUB_PUSH_INTENT_STALE", operationId);
  }
}

export async function prepareProjectPush(
  projectId: string,
  actor: string,
  dependencies: ProjectPushDependencies
): Promise<ProjectPushStatus> {
  const context = dependencies.database.getRuntimeContext(projectId);
  const { source, retained } = sourceFor(dependencies.database, projectId, actor);
  const authority = dependencies.database.getGithubAuthorityContext(actor, source.connectionId);
  if (!authority.admitted) {
    throw new ProjectPushError("GITHUB_CONNECTION_DISABLED", "Reconnect the GitHub connection before preparing a private push.");
  }
  const inspection = await inspectWorkspaceGit(dependencies.agent, projectId, context.workspace.id);
  if (inspection.branchName === null || inspection.headCommit === null
    || inspection.branchName !== context.workspace.branchName) {
    throw new ProjectPushError("GITHUB_PUSH_INTENT_STALE", "The workspace branch or commit could not be captured. Prepare the push again.");
  }
  const intent = projectPushIntentSchema.parse({
    version: 1,
    phase: "prepared",
    projectId,
    workspaceId: context.workspace.id,
    source,
    branchName: inspection.branchName,
    commitOid: inspection.headCommit,
    githubAuthorityGeneration: authority.lifecycleGeneration,
    repositoryFullName: retained.fullName,
    dirty: inspection.dirty,
    aheadCount: inspection.aheadCount,
    behindCount: inspection.behindCount
  });
  const operation = dependencies.database.prepareProjectPushOperation({
    projectId, workspaceId: context.workspace.id, actor, progressJson: JSON.stringify(intent)
  });
  return statusForOperation(operation);
}

async function confirmProjectPushOperation(
  operation: ReturnType<ProjectDatabase["getProjectPushOperation"]>,
  projectId: string,
  actor: string,
  dependencies: ProjectPushDependencies
): Promise<ProjectPushStatus> {
  if (operation === undefined) throw new ProjectPushError("PUSH_INTENT_NOT_FOUND", "The push intent was not found.");
  if (operation.state === "succeeded") return statusForOperation(operation);
  if (operation.state === "failed" || operation.state === "cancelled") throw operationError(operation);
  let intent: ProjectPushIntent;
  try { intent = readIntent(operation); }
  catch { throw terminalFailure(dependencies.database, operation.operationId, "GITHUB_PUSH_OUTCOME_UNCERTAIN"); }
  if (operation.state !== "accepted" || intent.phase !== "prepared") {
    throw terminalFailure(dependencies.database, operation.operationId, "GITHUB_PUSH_OUTCOME_UNCERTAIN");
  }

  let context: ReturnType<ProjectDatabase["getRuntimeContext"]>;
  let sourceDetails: ReturnType<typeof sourceFor>;
  try {
    context = dependencies.database.getRuntimeContext(projectId);
    sourceDetails = sourceFor(dependencies.database, projectId, actor);
  } catch (error) {
    if (error instanceof ProjectPushError) {
      throw terminalFailure(dependencies.database, operation.operationId, error.code, error.message);
    }
    throw terminalFailure(dependencies.database, operation.operationId, "GITHUB_PUSH_INTENT_STALE");
  }
  const { source } = sourceDetails;
  if (context.workspace.id !== intent.workspaceId || context.workspace.branchName !== intent.branchName
    || source.connectionId !== intent.source.connectionId || source.repositoryId !== intent.source.repositoryId) {
    throw terminalFailure(dependencies.database, operation.operationId, "GITHUB_PUSH_INTENT_STALE");
  }
  let authority: ReturnType<ProjectDatabase["getGithubAuthorityContext"]>;
  try { authority = dependencies.database.getGithubAuthorityContext(actor, source.connectionId); }
  catch { throw terminalFailure(dependencies.database, operation.operationId, "PROJECT_NOT_FOUND"); }
  if (!authority.admitted) {
    throw terminalFailure(dependencies.database, operation.operationId, "GITHUB_CONNECTION_DISABLED",
      "Reconnect the GitHub connection before confirming this private push.");
  }
  if (authority.lifecycleGeneration !== intent.githubAuthorityGeneration) {
    throw terminalFailure(dependencies.database, operation.operationId, "GITHUB_AUTHORITY_GENERATION_STALE");
  }
  const inspection = await inspectWorkspaceGit(dependencies.agent, projectId, intent.workspaceId, operation.operationId);
  try { assertCapturedInspection(inspection, intent, operation.operationId); }
  catch (error) {
    if (error instanceof ProjectPushError) {
      throw terminalFailure(dependencies.database, operation.operationId, error.code, error.message);
    }
    throw terminalFailure(dependencies.database, operation.operationId, "GITHUB_PUSH_INTENT_STALE");
  }

  const submittedIntent = projectPushIntentSchema.parse({ ...intent, phase: "submitted" });
  try {
    dependencies.database.claimProjectPushOperation({
      operationId: operation.operationId,
      projectId,
      workspaceId: intent.workspaceId,
      actor,
      expectedProgressJson: operation.progressJson!,
      progressJson: JSON.stringify(submittedIntent)
    });
  } catch {
    const current = dependencies.database.getProjectPushOperation({ operationId: operation.operationId, projectId, actor });
    if (current?.state === "succeeded") return statusForOperation(current);
    if (current?.state === "failed" || current?.state === "cancelled") throw operationError(current);
    throw failure("GITHUB_PUSH_OUTCOME_UNCERTAIN", operation.operationId);
  }

  const request = projectPushDataSchema.parse({
    projectId,
    workspaceId: intent.workspaceId,
    source: intent.source,
    branchName: intent.branchName,
    commitOid: intent.commitOid,
    githubAuthorityGeneration: intent.githubAuthorityGeneration
  }) satisfies ProjectPushData;
  try {
    await dependencies.agent.pushProject(operation.operationId, request);
  } catch (error) {
    if (error instanceof AgentResponseError && projectPushFailureCodes.has(error.code)) {
      const message = persistedFailureMessage(error.code);
      if (error.code === "GITHUB_CONTENTS_WRITE_PERMISSION_REQUIRED") recordWritePermissionLoss(dependencies.database, actor, intent);
      throw terminalFailure(dependencies.database, operation.operationId, error.code, message, {
        failureCategory: error.failureCategory,
        retryable: error.retryable,
        incidentId: error.incidentId,
        requestId: error.requestId,
        diagnosticContext: error.diagnosticContext,
        messageOwnership: "agent-code"
      });
    }
    if (error instanceof AgentUnavailableError) {
      throw terminalFailure(dependencies.database, operation.operationId, "GITHUB_PUSH_OUTCOME_UNCERTAIN", undefined, {
        failureCategory: error.failureCategory,
        requestId: error.requestId,
        diagnosticContext: error.diagnosticContext
      });
    }
    throw terminalFailure(dependencies.database, operation.operationId, "GITHUB_PUSH_OUTCOME_UNCERTAIN");
  }

  const deadline = Date.now() + (dependencies.timeoutMs ?? 10_000);
  let delay = 25;
  while (Date.now() < deadline) {
    let snapshot;
    try { snapshot = await dependencies.agent.snapshot(); }
    catch (error) {
      if (error instanceof AgentUnavailableError) {
        throw terminalFailure(dependencies.database, operation.operationId, "GITHUB_PUSH_OUTCOME_UNCERTAIN", undefined, {
          failureCategory: error.failureCategory,
          requestId: error.requestId,
          diagnosticContext: error.diagnosticContext
        });
      }
      throw terminalFailure(dependencies.database, operation.operationId, "GITHUB_PUSH_OUTCOME_UNCERTAIN");
    }
    dependencies.database.applyExecutionSnapshot(snapshot);
    const observation = snapshot.operationObservations.find((candidate) => candidate.operationId === operation.operationId);
    if (observation?.state === "succeeded") {
      dependencies.database.finishOperation(operation.operationId, { state: "succeeded" });
      return { ...statusForOperation(dependencies.database.getProjectPushOperation({ operationId: operation.operationId, projectId, actor })!), state: "succeeded" };
    }
    if (observation?.state === "failed") {
      const message = persistedFailureMessage(observation.failure.code);
      if (observation.failure.code === "GITHUB_CONTENTS_WRITE_PERMISSION_REQUIRED") {
        recordWritePermissionLoss(dependencies.database, actor, intent);
      }
      throw terminalFailure(dependencies.database, operation.operationId, observation.failure.code, message, {
        retryable: observation.failure.retryable,
        messageOwnership: "agent-code"
      });
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(Math.ceil(delay * 1.7), 500);
  }
  throw terminalFailure(dependencies.database, operation.operationId, "GITHUB_PUSH_OUTCOME_UNCERTAIN");
}

export async function confirmProjectPush(
  projectId: string,
  actor: string,
  operationId: string,
  dependencies: ProjectPushDependencies
): Promise<ProjectPushStatus> {
  const operation = dependencies.database.getProjectPushOperation({ operationId, projectId, actor });
  return await confirmProjectPushOperation(operation, projectId, actor, dependencies);
}

export function getLatestProjectPushStatus(projectId: string, actor: string, database: ProjectDatabase): ProjectPushStatus | null {
  const operation = database.getLatestProjectPushOperation({ projectId, actor });
  return operation === undefined ? null : statusForOperation(operation);
}
