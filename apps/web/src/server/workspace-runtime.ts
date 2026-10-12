import {
  canonicalizeProjectOptionsV1, canonicalizeRuntimePlanV1, compileRuntimePlanV1,
  hashProjectOptionsV1, hashRuntimePlanV1, parseProjectOptionsV1, parseRuntimePlanV1
} from "@devspace/project-options";
import type { ApprovedPreviewBaseRegistry } from "@devspace/security";
import { AgentResponseError, type WorkspaceAgentClient } from "./agent-client.js";
import type { ProjectDatabase } from "./database.js";
import { persistedFailureMessage } from "./failure-policy.js";
import { reconcileWorkspacePreviews, type PreviewOrchestrationAgent } from "./preview-orchestration.js";
import { reconcilePrimaryWorkspaceRuntimeOperation } from "./runtime-operation-reconciliation.js";
import { SafeWebFailure, type SafeFailureMetadata } from "./user-facing-failure.js";

export class WorkspaceRuntimeExecutionError extends SafeWebFailure {
  constructor(code: string, message: string, metadata: SafeFailureMetadata = {}) {
    super(code, message, metadata);
    this.name = "WorkspaceRuntimeExecutionError";
  }
}

function agentRuntimeError(error: AgentResponseError): WorkspaceRuntimeExecutionError {
  return new WorkspaceRuntimeExecutionError(error.code, persistedFailureMessage(error.code), {
    failureCategory: error.failureCategory,
    retryable: error.retryable,
    incidentId: error.incidentId,
    requestId: error.requestId,
    operationId: error.operationId,
    diagnosticContext: error.diagnosticContext,
    messageOwnership: "agent-code"
  });
}
type WorkspaceRuntimeAgent = Pick<WorkspaceAgentClient,
  "snapshot" | "runtimeStatus" | "inspectWorkspace" | "registerRuntimePlan" | "startWorkspace" | "stopWorkspace">;

async function reconcilePreviewsAfterRuntime(action: "start" | "stop", projectId: string, actor: string, dependencies: {
  readonly database: ProjectDatabase;
  readonly agent: WorkspaceRuntimeAgent & Partial<PreviewOrchestrationAgent>;
  readonly previewBaseRegistry?: ApprovedPreviewBaseRegistry;
}): Promise<void> {
  if (typeof dependencies.agent.activatePreview !== "function"
    || typeof dependencies.agent.deactivatePreview !== "function"
    || typeof dependencies.agent.inspectPreview !== "function") return;
  try {
    const orchestration = { database: dependencies.database, agent: dependencies.agent as PreviewOrchestrationAgent };
    await reconcileWorkspacePreviews(projectId, actor, action === "start" ? "running" : "stopped",
      dependencies.previewBaseRegistry === undefined
        ? { ...orchestration, reason: "runtime-lifecycle-transition" }
        : { ...orchestration, previewBaseRegistry: dependencies.previewBaseRegistry, reason: "runtime-lifecycle-transition" });
  } catch {
    // Preview failures are retained in the preview row. They must not turn a
    // proven runtime start/stop into an unproven runtime operation.
  }
}

async function pollMutation(input: {
  database: ProjectDatabase; agent: WorkspaceRuntimeAgent; operationId: string;
  execute: () => Promise<void>; deadline: number; now: () => number; sleep: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  await input.execute();
  let delay = 25;
  while (input.now() < input.deadline) {
    const observation = (await input.agent.snapshot()).operationObservations.find((item) => item.operationId === input.operationId);
    if (observation?.state === "succeeded") return;
    if (observation?.state === "failed") {
      const details = observation.failure.details;
      const incidentId = "incidentId" in details ? details.incidentId : undefined;
      throw new WorkspaceRuntimeExecutionError(observation.failure.code, persistedFailureMessage(observation.failure.code), {
        retryable: observation.failure.retryable,
        operationId: input.operationId,
        messageOwnership: "agent-code",
        ...(incidentId === undefined ? {} : { incidentId })
      });
    }
    const remaining = input.deadline - input.now();
    if (remaining <= 0) break;
    await input.sleep(Math.min(delay, remaining));
    delay = Math.min(Math.ceil(delay * 1.7), 1_000);
  }
  throw new WorkspaceRuntimeExecutionError("RUNTIME_ACTION_IN_PROGRESS", "The runtime action is still running safely. Retry to continue observing it.");
}

export async function mutatePrimaryWorkspaceRuntime(action: "start" | "stop", projectId: string, actor: string, dependencies: {
  readonly database: ProjectDatabase; readonly agent: WorkspaceRuntimeAgent & Partial<PreviewOrchestrationAgent>; readonly previewBaseRegistry?: ApprovedPreviewBaseRegistry;
  readonly orchestrationTimeoutMs?: number;
  readonly nowMonotonic?: () => number; readonly sleep?: (milliseconds: number) => Promise<void>;
}) {
  const context = dependencies.database.getRuntimeContext(projectId);
  let options: ReturnType<typeof parseProjectOptionsV1>;
  try {
    options = parseProjectOptionsV1(JSON.parse(context.revision.configurationJson));
    if (canonicalizeProjectOptionsV1(options) !== context.revision.configurationJson
      || hashProjectOptionsV1(options) !== context.revision.configurationHash) throw new Error("configuration-revision-mismatch");
  } catch {
    throw new WorkspaceRuntimeExecutionError("CONFIGURATION_INVALID", "The immutable Project Options revision is invalid.");
  }
  let plan;
  try { plan = compileRuntimePlanV1(options); }
  catch (error) {
    throw new WorkspaceRuntimeExecutionError("RUNTIME_PLAN_UNSUPPORTED", error instanceof Error ? error.message : "This configuration is not executable yet.");
  }
  const canonicalPlan = canonicalizeRuntimePlanV1(plan);
  const planHash = hashRuntimePlanV1(plan);
  if (context.revision.compiledRuntimePlanJson !== null || context.revision.runtimePlanHash !== null) {
    try {
      const retained = parseRuntimePlanV1(JSON.parse(context.revision.compiledRuntimePlanJson ?? "null"));
      if (canonicalizeRuntimePlanV1(retained) !== canonicalPlan || hashRuntimePlanV1(retained) !== planHash
        || context.revision.runtimePlanHash !== planHash) throw new Error("derived-plan-mismatch");
    } catch { throw new WorkspaceRuntimeExecutionError("RUNTIME_PLAN_INVALID", "The retained runtime plan is inconsistent."); }
  } else {
    dependencies.database.storeRuntimePlanPair({ projectId, revisionId: context.revision.id, canonicalJson: canonicalPlan, hash: planHash });
  }
  const now = dependencies.nowMonotonic ?? (() => Date.now());
  const sleep = dependencies.sleep ?? (async (milliseconds: number) => await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + (dependencies.orchestrationTimeoutMs ?? 120_000);
  const registration = dependencies.database.getOrCreateRevisionOperation({ projectId, actor,
    operationName: "configuration-runtime-plan.register", revisionId: context.revision.id });
  if (registration.state !== "succeeded") {
    try {
      await pollMutation({ database: dependencies.database, agent: dependencies.agent, operationId: registration.operationId,
        execute: async () => await dependencies.agent.registerRuntimePlan(registration.operationId, {
          projectId, revisionId: context.revision.id, revisionHash: context.revision.configurationHash,
          runtimePlan: { format: "devspace.runtime-plan/v1", hash: planHash, canonicalJson: canonicalPlan }
        }), deadline, now, sleep });
      dependencies.database.finishOperation(registration.operationId, { state: "succeeded" });
    } catch (error) {
      const failure = error instanceof WorkspaceRuntimeExecutionError ? error
        : error instanceof AgentResponseError ? agentRuntimeError(error)
        : new WorkspaceRuntimeExecutionError("AGENT_UNAVAILABLE", "The DevSpace Agent is unavailable.");
      dependencies.database.finishOperation(registration.operationId, { state: "failed", code: failure.code, message: failure.message });
      throw failure;
    }
  }
  const reconciliation = await reconcilePrimaryWorkspaceRuntimeOperation(projectId, {
    database: dependencies.database, agent: dependencies.agent
  });
  if (reconciliation.activeAction !== null) {
    throw new WorkspaceRuntimeExecutionError("RUNTIME_ACTION_IN_PROGRESS", "The runtime action is still running safely.");
  }
  if (reconciliation.reconciledTerminal?.state === "succeeded"
    && reconciliation.reconciledTerminal.action === action && reconciliation.inspection !== null) {
    await reconcilePreviewsAfterRuntime(action, projectId, actor, dependencies);
    return reconciliation.inspection;
  }
  const authorized = action === "start" ? reconciliation.canStart : reconciliation.canStop;
  if (!authorized) {
    const message = reconciliation.blockingReason === "failed-start-unproven"
      ? "Retry start requires the exact failed Agent operation and a recoverable stopped runtime inspection."
      : reconciliation.blockingReason === "agent-snapshot-unavailable"
        ? "The Agent operation snapshot is unavailable, so the runtime action cannot be authorized safely."
        : reconciliation.blockingReason === "runtime-unavailable"
          ? "The Agent operation journal or dedicated rootless runtime is unavailable."
          : reconciliation.blockingReason === "inspection-unavailable"
            ? "The live workspace runtime inspection is unavailable."
            : "The requested runtime action is not valid for the authoritative current state.";
    const subsystemUnavailable = reconciliation.blockingReason === "agent-snapshot-unavailable"
      || reconciliation.blockingReason === "runtime-unavailable"
      || reconciliation.blockingReason === "inspection-unavailable";
    throw new WorkspaceRuntimeExecutionError("RUNTIME_ACTION_NOT_AUTHORIZED", message,
      subsystemUnavailable ? { failureCategory: "dependency-unavailable", retryable: true } : {});
  }
  const operation = dependencies.database.prepareRuntimeMutation({ projectId, workspaceId: context.workspace.id, actor, action,
    runtimePlanHash: planHash, imageReference: plan.developmentContainer.source.imageReference });
  if (operation.state === "succeeded") {
    const observed = await dependencies.agent.inspectWorkspace(projectId, context.workspace.id);
    await reconcilePreviewsAfterRuntime(action, projectId, actor, dependencies);
    return observed;
  }
  try {
    await pollMutation({ database: dependencies.database, agent: dependencies.agent, operationId: operation.operationId,
      execute: async () => action === "start"
        ? await dependencies.agent.startWorkspace(operation.operationId, projectId, context.workspace.id)
        : await dependencies.agent.stopWorkspace(operation.operationId, projectId, context.workspace.id),
      deadline, now, sleep });
    const observed = await dependencies.agent.inspectWorkspace(projectId, context.workspace.id);
    const expected = action === "start" ? "running" : "stopped";
    if (observed.observedState !== expected || observed.runtimeStack.observedState !== expected) {
      throw new WorkspaceRuntimeExecutionError("WORKSPACE_STATE_CONFLICT", "The Agent did not observe the requested runtime state.");
    }
    dependencies.database.finishRuntimeMutation({ operationId: operation.operationId, projectId, workspaceId: context.workspace.id,
      outcome: { state: "succeeded", workspaceObserved: observed.observedState,
        runtimeObserved: observed.runtimeStack.observedState } });
    await reconcilePreviewsAfterRuntime(action, projectId, actor, dependencies);
    return observed;
  } catch (error) {
    const deliveryOutcomeUnknown = !(error instanceof WorkspaceRuntimeExecutionError)
      && !(error instanceof AgentResponseError);
    const failure = error instanceof WorkspaceRuntimeExecutionError ? error
      : error instanceof AgentResponseError ? agentRuntimeError(error)
      : new WorkspaceRuntimeExecutionError("AGENT_UNAVAILABLE", "The DevSpace Agent is unavailable.");
    if (failure.code !== "RUNTIME_ACTION_IN_PROGRESS" && !deliveryOutcomeUnknown) {
      dependencies.database.finishRuntimeMutation({ operationId: operation.operationId, projectId, workspaceId: context.workspace.id,
        outcome: { state: "failed", code: failure.code, message: failure.message } });
    }
    if (deliveryOutcomeUnknown) {
      throw new WorkspaceRuntimeExecutionError("RUNTIME_ACTION_IN_PROGRESS",
        "The runtime action outcome is not yet confirmed. Reconciliation will continue safely.");
    }
    throw failure;
  }
}
