import { AgentResponseError, AgentUnavailableError, type FullAgentClient } from "./agent-client.js";
import type { ProjectDatabase } from "./database.js";
import { persistedFailureMessage } from "./failure-policy.js";
import { SafeWebFailure, type SafeFailureMetadata } from "./user-facing-failure.js";

export class ProjectFetchError extends SafeWebFailure {
  constructor(code: string, message: string, metadata: SafeFailureMetadata = {}) {
    super(code, message, metadata);
    this.name = "ProjectFetchError";
  }
}

export async function fetchProject(projectId: string, actor: string, dependencies: {
  readonly database: ProjectDatabase;
  readonly agent: FullAgentClient;
  readonly timeoutMs?: number;
}): Promise<{ readonly operationId: string; readonly state: "succeeded" }> {
  const operation = dependencies.database.getOrCreateProjectFetchOperation({ projectId, actor });
  if (operation.state === "succeeded") return { operationId: operation.operationId, state: "succeeded" };
  if (operation.state === "failed") throw new ProjectFetchError(
    operation.errorCode ?? "SOURCE_UNAVAILABLE", persistedFailureMessage(operation.errorCode ?? "SOURCE_UNAVAILABLE")
  );
  const source = dependencies.database.getProjectSourceLocator(projectId, actor);
  if (source === null) throw new ProjectFetchError("PROJECT_NOT_FOUND", "The project was not found.");
  try {
    if (source.kind === "github-app") {
      const resolved = await dependencies.agent.resolveGithubRepository(source.connectionId, source.repositoryId);
      const timestamp = new Date().toISOString();
      dependencies.database.refreshProjectGithubSource({ projectId, actor, connectionId: source.connectionId,
        repository: resolved.repository, verifiedAt: timestamp, metadataUpdatedAt: timestamp });
    }
    await dependencies.agent.fetchProject(operation.operationId, projectId, source.kind === "github-app" ? source : undefined);
  } catch (error) {
    if (error instanceof AgentResponseError) {
      const message = persistedFailureMessage(error.code);
      dependencies.database.finishOperation(operation.operationId, { state: "failed", code: error.code, message });
      throw new ProjectFetchError(error.code, message, {
        failureCategory: error.failureCategory, retryable: error.retryable,
        incidentId: error.incidentId, requestId: error.requestId, operationId: error.operationId,
        diagnosticContext: error.diagnosticContext, messageOwnership: "agent-code"
      });
    }
    if (error instanceof AgentUnavailableError) {
      throw new ProjectFetchError("FETCH_IN_PROGRESS", "The repository fetch outcome is still being reconciled safely.", {
        failureCategory: error.failureCategory, retryable: true, operationId: operation.operationId,
        requestId: error.requestId, diagnosticContext: error.diagnosticContext
      });
    }
    throw new ProjectFetchError("FETCH_IN_PROGRESS", "The repository fetch outcome is still being reconciled safely.", {
      retryable: true, operationId: operation.operationId
    });
  }

  const deadline = Date.now() + (dependencies.timeoutMs ?? 10_000);
  let delay = 25;
  while (Date.now() < deadline) {
    const snapshot = await dependencies.agent.snapshot();
    dependencies.database.applyExecutionSnapshot(snapshot);
    const observation = snapshot.operationObservations.find((candidate) => candidate.operationId === operation.operationId);
    if (observation?.state === "succeeded") {
      dependencies.database.finishOperation(operation.operationId, { state: "succeeded" });
      return { operationId: operation.operationId, state: "succeeded" };
    }
    if (observation?.state === "failed") {
      const message = persistedFailureMessage(observation.failure.code);
      dependencies.database.finishOperation(operation.operationId, {
        state: "failed", code: observation.failure.code, message
      });
      throw new ProjectFetchError(observation.failure.code, message, {
        retryable: observation.failure.retryable,
        operationId: operation.operationId, messageOwnership: "agent-code"
      });
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(Math.ceil(delay * 1.7), 500);
  }
  throw new ProjectFetchError("FETCH_IN_PROGRESS", "The repository fetch is still in progress safely. Retry to reconcile the same operation.", {
    retryable: true, operationId: operation.operationId
  });
}
