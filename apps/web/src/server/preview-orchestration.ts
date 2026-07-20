import type { ApprovedPreviewBaseRegistry } from "@devspace/security";
import type { PreviewInspectionData } from "@devspace/contracts";
import { AgentResponseError, AgentUnavailableError, type FullAgentClient } from "./agent-client.js";
import type { PreviewView, ProjectDatabase } from "./database.js";

export type PreviewReconciliationMode = "running" | "stopped" | "lost" | "observe";
export type PreviewOrchestrationAgent = Pick<FullAgentClient,
  "activatePreview" | "deactivatePreview" | "inspectPreview" | "snapshot">;

export interface PreviewOrchestrationDependencies {
  readonly database: ProjectDatabase;
  readonly agent: PreviewOrchestrationAgent;
  readonly previewBaseRegistry?: ApprovedPreviewBaseRegistry;
  readonly observationTimeoutMs?: number;
  readonly nowMonotonic?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class PreviewOrchestrationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "PreviewOrchestrationError"; }
}

async function waitForOperation(operationId: string, dependencies: PreviewOrchestrationDependencies): Promise<"succeeded" | "failed" | "pending"> {
  const now = dependencies.nowMonotonic ?? (() => Date.now());
  const sleep = dependencies.sleep ?? (async (milliseconds: number) => await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + (dependencies.observationTimeoutMs ?? 8_000);
  let delay = 50;
  while (now() < deadline) {
    try {
      const snapshot = await dependencies.agent.snapshot();
      dependencies.database.applyExecutionSnapshot(snapshot);
      const observation = snapshot.operationObservations.find((candidate) => candidate.operationId === operationId);
      if (observation?.state === "succeeded") return "succeeded";
      if (observation?.state === "failed") return "failed";
    } catch {
      return "pending";
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(delay, remaining));
    delay = Math.min(Math.ceil(delay * 1.7), 750);
  }
  return "pending";
}

function currentPreview(database: ProjectDatabase, projectId: string, workspaceId: string, previewId: string): PreviewView | undefined {
  return database.listPreviews(projectId, workspaceId).find((candidate) => candidate.id === previewId);
}

function persistObservation(
  database: ProjectDatabase,
  context: ReturnType<ProjectDatabase["getRuntimeContext"]>,
  preview: PreviewView,
  observation: Pick<PreviewInspectionData, "observedState" | "routePresent">,
  operationId: string | null | undefined,
  errorCode: string | null = null,
  errorMessage: string | null = null
): void {
  database.updatePreviewObservation({
    projectId: context.project.id,
    workspaceId: context.workspace.id,
    previewId: preview.id,
    revisionId: context.revision.id,
    observedState: observation.observedState,
    routePresent: observation.routePresent,
    observationJson: JSON.stringify(observation),
    errorCode,
    errorMessage,
    ...(operationId === undefined ? {} : { operationId })
  });
}

async function inspectAndPersist(
  context: ReturnType<ProjectDatabase["getRuntimeContext"]>,
  preview: PreviewView,
  operationId: string | null,
  action: "activate" | "deactivate",
  dependencies: PreviewOrchestrationDependencies,
  operationPending = false
): Promise<void> {
  try {
    const observation = await dependencies.agent.inspectPreview(context.project.id, context.workspace.id, context.revision.id, preview.id);
    persistObservation(dependencies.database, context, preview, observation, operationId);
  } catch (error) {
    if (error instanceof AgentResponseError && error.code === "RESOURCE_NOT_FOUND" && action === "deactivate") {
      persistObservation(dependencies.database, context, preview, { observedState: "inactive", routePresent: false }, operationId);
      dependencies.database.finishOperation(operationId!, { state: "succeeded" });
      return;
    }
    if (error instanceof AgentResponseError && error.code === "RESOURCE_NOT_FOUND" && action === "activate") {
      // The Agent may still be executing the accepted mutation. Keep the operation
      // open and present the configured preview as Waiting until a later reconcile.
      const retained = currentPreview(dependencies.database, context.project.id, context.workspace.id, preview.id) ?? preview;
      persistObservation(dependencies.database, context, retained, { observedState: "starting", routePresent: false }, operationId);
      if (!operationPending) dependencies.database.finishOperation(operationId!, {
        state: "failed", code: "RESOURCE_NOT_FOUND", message: "The Agent no longer has the exact preview state."
      });
      return;
    }
    if (error instanceof AgentResponseError) {
      dependencies.database.finishOperation(operationId!, { state: "failed", code: error.code, message: error.message });
      const retained = currentPreview(dependencies.database, context.project.id, context.workspace.id, preview.id) ?? preview;
      persistObservation(dependencies.database, context, retained, { observedState: "failed", routePresent: retained.routePresent }, operationId,
        error.code, error.message);
      return;
    }
    if (error instanceof AgentUnavailableError) {
      const retained = currentPreview(dependencies.database, context.project.id, context.workspace.id, preview.id) ?? preview;
      persistObservation(dependencies.database, context, retained, { observedState: retained.observedState as PreviewInspectionData["observedState"], routePresent: retained.routePresent },
        operationId, "AGENT_UNAVAILABLE", error.message);
      return;
    }
    dependencies.database.finishOperation(operationId!, { state: "failed", code: "AGENT_INTERNAL_ERROR", message: "The preview could not be inspected safely." });
    const retained = currentPreview(dependencies.database, context.project.id, context.workspace.id, preview.id) ?? preview;
    persistObservation(dependencies.database, context, retained, { observedState: "failed", routePresent: retained.routePresent }, operationId,
      "AGENT_INTERNAL_ERROR", "The preview could not be inspected safely.");
  }
}

async function reconcileOne(
  context: ReturnType<ProjectDatabase["getRuntimeContext"]>,
  preview: PreviewView,
  action: "activate" | "deactivate",
  actor: string,
  dependencies: PreviewOrchestrationDependencies
): Promise<void> {
  const intent = dependencies.database.preparePreviewMutation({
    projectId: context.project.id, workspaceId: context.workspace.id, previewId: preview.id, actor, action
  });
  const operationId = intent.operation.operationId;
  let operationPending = false;
  if (intent.operation.state !== "succeeded") {
    try {
      if (action === "activate") {
        await dependencies.agent.activatePreview(operationId, {
          projectId: context.project.id,
          workspaceId: context.workspace.id,
          revisionId: context.revision.id,
          previewId: intent.preview.id,
          previewKey: intent.preview.previewKey,
          hostname: intent.preview.hostname,
          projectSlug: intent.projectSlug,
          workspaceSlug: intent.workspaceSlug
        });
      } else {
        await dependencies.agent.deactivatePreview(operationId, context.project.id, context.workspace.id, context.revision.id, intent.preview.id);
      }
    } catch (error) {
      if (error instanceof AgentUnavailableError) {
        persistObservation(dependencies.database, context, intent.preview, {
          observedState: intent.preview.observedState as PreviewInspectionData["observedState"], routePresent: intent.preview.routePresent
        }, operationId, "AGENT_UNAVAILABLE", error.message);
        return;
      }
      const failure = error instanceof AgentResponseError
        ? { code: error.code, message: error.message }
        : { code: "AGENT_INTERNAL_ERROR", message: "The preview action failed safely." };
      dependencies.database.finishOperation(operationId, { state: "failed", code: failure.code, message: failure.message });
      persistObservation(dependencies.database, context, intent.preview, { observedState: "failed", routePresent: intent.preview.routePresent }, operationId,
        failure.code, failure.message);
      return;
    }
    const terminal = await waitForOperation(operationId, dependencies);
    operationPending = terminal === "pending";
    if (terminal === "failed") {
      const retained = currentPreview(dependencies.database, context.project.id, context.workspace.id, preview.id) ?? intent.preview;
      if (retained.lastErrorCode === null) {
        persistObservation(dependencies.database, context, retained, { observedState: "failed", routePresent: retained.routePresent }, operationId,
          "AGENT_OPERATION_FAILED", "The Agent preview operation failed.");
      }
      return;
    }
  }
  await inspectAndPersist(context, intent.preview, operationId, action, dependencies, operationPending);
}

function persistUnsupportedPreview(context: ReturnType<ProjectDatabase["getRuntimeContext"]>, preview: PreviewView,
  dependencies: PreviewOrchestrationDependencies): void {
  persistObservation(dependencies.database, context, preview, { observedState: "failed", routePresent: false }, null,
    "RUNTIME_POLICY_VIOLATION", "This service-target preview is unavailable under the current runtime policy.");
}

export async function reconcileWorkspacePreviews(projectId: string, actor: string, mode: PreviewReconciliationMode,
  dependencies: PreviewOrchestrationDependencies, previewId?: string): Promise<readonly PreviewView[]> {
  const context = dependencies.database.getRuntimeContext(projectId);
  if (dependencies.previewBaseRegistry !== undefined) {
    dependencies.database.materializePreviews({ projectId, workspaceId: context.workspace.id, revisionId: context.revision.id,
      previewBaseRegistry: dependencies.previewBaseRegistry });
  }
  let previews = dependencies.database.listPreviews(projectId, context.workspace.id);
  if (previewId !== undefined) previews = previews.filter((preview) => preview.id === previewId);
  for (const preview of previews) {
    if (preview.targetKind === "service") {
      persistUnsupportedPreview(context, preview, dependencies);
      continue;
    }
    if (mode === "running") {
      await reconcileOne(context, preview, "activate", actor, dependencies);
    } else if (mode === "stopped" || mode === "lost") {
      if (preview.desiredState === "active" || preview.routePresent || preview.observedState !== "inactive") {
        await reconcileOne(context, preview, "deactivate", actor, dependencies);
      }
    } else if (preview.desiredState === "active" || preview.routePresent) {
      try {
        const observation = await dependencies.agent.inspectPreview(projectId, context.workspace.id, context.revision.id, preview.id);
        persistObservation(dependencies.database, context, preview, observation, undefined);
      } catch (error) {
        if (!(error instanceof AgentResponseError && error.code === "RESOURCE_NOT_FOUND")) {
          const code = error instanceof AgentResponseError ? error.code : error instanceof AgentUnavailableError ? "AGENT_UNAVAILABLE" : "AGENT_INTERNAL_ERROR";
          const message = error instanceof Error ? error.message : "The preview could not be inspected safely.";
          persistObservation(dependencies.database, context, preview, { observedState: preview.observedState as PreviewInspectionData["observedState"], routePresent: false },
            undefined, code, message);
        }
      }
    }
  }
  return dependencies.database.listPreviews(projectId, context.workspace.id);
}

export async function reloadPreview(projectId: string, previewId: string, actor: string,
  dependencies: PreviewOrchestrationDependencies): Promise<readonly PreviewView[]> {
  const context = dependencies.database.getRuntimeContext(projectId);
  if (dependencies.previewBaseRegistry !== undefined) {
    dependencies.database.materializePreviews({ projectId, workspaceId: context.workspace.id, revisionId: context.revision.id,
      previewBaseRegistry: dependencies.previewBaseRegistry });
  }
  const preview = dependencies.database.listPreviews(projectId, context.workspace.id).find((candidate) => candidate.id === previewId);
  if (preview === undefined) throw new PreviewOrchestrationError("PREVIEW_NOT_FOUND", "The preview was not found.");
  const managed = dependencies.database.getManagedProject(projectId);
  const running = context.workspace.observedState === "running" && managed?.runtime?.observedState === "running";
  if (preview.targetKind === "service") persistUnsupportedPreview(context, preview, dependencies);
  else if (running) await reconcileOne(context, preview, "activate", actor, dependencies);
  else {
    persistObservation(dependencies.database, context, preview,
      { observedState: preview.observedState as PreviewInspectionData["observedState"], routePresent: false }, undefined);
  }
  return dependencies.database.listPreviews(projectId, context.workspace.id);
}
