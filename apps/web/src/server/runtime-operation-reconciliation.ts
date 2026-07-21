import type { AgentOperationObservation, AgentSnapshotData, WorkspaceInspectionData } from "@devspace/contracts";
import type { WorkspaceAgentClient } from "./agent-client.js";
import type { ProjectDatabase } from "./database.js";

export type RuntimeAction = "start" | "stop";
export type RuntimeActionBlockingReason =
  | "active-runtime-operation"
  | "agent-snapshot-unavailable"
  | "runtime-unavailable"
  | "inspection-unavailable"
  | "failed-start-unproven"
  | "runtime-state-not-actionable";

export interface RuntimeOperationReconciliation {
  readonly activeAction: RuntimeAction | null;
  readonly activeOperationId: string | null;
  readonly canStart: boolean;
  readonly canStop: boolean;
  readonly canRetryStart: boolean;
  readonly retryOperationId: string | null;
  readonly blockingReason: RuntimeActionBlockingReason | null;
  readonly inspection: WorkspaceInspectionData | null;
  readonly reconciledTerminal: null | { readonly action: RuntimeAction; readonly state: "succeeded" | "failed" };
}

function actionOf(operationName: string): RuntimeAction | null {
  return operationName === "workspace.start" ? "start" : operationName === "workspace.stop" ? "stop" : null;
}

function inactive(input: Omit<RuntimeOperationReconciliation, "activeAction" | "activeOperationId">): RuntimeOperationReconciliation {
  return { activeAction: null, activeOperationId: null, ...input };
}

function active(action: RuntimeAction, operationId: string, inspection: WorkspaceInspectionData | null): RuntimeOperationReconciliation {
  return { activeAction: action, activeOperationId: operationId, canStart: false, canStop: false, canRetryStart: false,
    retryOperationId: null, blockingReason: "active-runtime-operation", inspection, reconciledTerminal: null };
}

function exactObservation(snapshot: AgentSnapshotData | null, operationId: string): AgentOperationObservation | undefined {
  return snapshot?.operationObservations.find((candidate) => candidate.operationId === operationId);
}

export async function reconcilePrimaryWorkspaceRuntimeOperation(projectId: string, dependencies: {
  readonly database: ProjectDatabase;
  readonly agent: Pick<WorkspaceAgentClient, "snapshot" | "inspectWorkspace" | "runtimeStatus">;
  readonly snapshot?: AgentSnapshotData | null;
  readonly inspection?: WorkspaceInspectionData | null;
  /** True only when both the rootless runtime and Agent operation journal are available. */
  readonly runtimeAvailable?: boolean;
}): Promise<RuntimeOperationReconciliation> {
  const context = dependencies.database.getRuntimeContext(projectId);
  const snapshot = dependencies.snapshot === undefined
    ? await dependencies.agent.snapshot().catch(() => null)
    : dependencies.snapshot;
  const runtimeAvailable = dependencies.runtimeAvailable ?? await dependencies.agent.runtimeStatus()
    .then((status) => status.rootlessRuntime === "available" && status.operationJournal === "available")
    .catch(() => false);
  let operations = dependencies.database.listRuntimeOperations(projectId, context.workspace.id);
  const nonterminal = operations.find((operation) => operation.state === "accepted" || operation.state === "running");
  let inspection = dependencies.inspection;
  let reconciledTerminal: RuntimeOperationReconciliation["reconciledTerminal"] = null;

  if (nonterminal !== undefined) {
    const action = actionOf(nonterminal.operationName);
    if (action === null) throw new Error("non-runtime-operation-returned-for-runtime-reconciliation");
    const observation = exactObservation(snapshot, nonterminal.operationId);
    if (observation === undefined) return active(action, nonterminal.operationId, inspection ?? null);
    switch (observation.state) {
      case "accepted":
      case "running":
        return active(action, nonterminal.operationId, inspection ?? null);
      case "failed":
        dependencies.database.finishRuntimeMutation({ operationId: nonterminal.operationId, projectId,
          workspaceId: context.workspace.id, outcome: { state: "failed", code: observation.failure.code,
            message: observation.failure.message } });
        reconciledTerminal = { action, state: "failed" };
        break;
      case "succeeded":
        inspection ??= await dependencies.agent.inspectWorkspace(projectId, context.workspace.id).catch(() => null);
        if (inspection === null) return active(action, nonterminal.operationId, null);
        dependencies.database.finishRuntimeMutation({ operationId: nonterminal.operationId, projectId,
          workspaceId: context.workspace.id, outcome: { state: "succeeded", workspaceObserved: inspection.observedState,
            runtimeObserved: inspection.runtimeStack.observedState } });
        reconciledTerminal = { action, state: "succeeded" };
        break;
      default:
        return active(action, nonterminal.operationId, inspection ?? null);
    }
    operations = dependencies.database.listRuntimeOperations(projectId, context.workspace.id);
  }

  inspection ??= await dependencies.agent.inspectWorkspace(projectId, context.workspace.id).catch(() => null);
  const base = { inspection: inspection ?? null, reconciledTerminal };
  if (!runtimeAvailable) return inactive({ ...base, canStart: false, canStop: false, canRetryStart: false,
    retryOperationId: null, blockingReason: "runtime-unavailable" });
  if (inspection === null) return inactive({ ...base, canStart: false, canStop: false, canRetryStart: false,
    retryOperationId: null, blockingReason: "inspection-unavailable" });

  const canStop = inspection.observedState === "running" && inspection.runtimeStack.observedState === "running";
  if (snapshot === null) return inactive({ ...base, canStart: false, canStop, canRetryStart: false,
    retryOperationId: null, blockingReason: canStop ? null : "agent-snapshot-unavailable" });

  const latest = operations[0];
  const latestIsFailedStart = latest?.operationName === "workspace.start" && latest.state === "failed";
  const startableInspection = inspection.observedState === "stopped"
    && (inspection.runtimeStack.observedState === "absent" || inspection.runtimeStack.observedState === "stopped");
  const matchingFailure = latestIsFailedStart ? exactObservation(snapshot, latest.operationId) : undefined;
  const canRetryStart = latestIsFailedStart && matchingFailure?.state === "failed" && startableInspection;
  const canStart = latestIsFailedStart ? canRetryStart : startableInspection;
  const blockingReason = canStart || canStop ? null
    : latestIsFailedStart ? "failed-start-unproven" : "runtime-state-not-actionable";
  return inactive({ ...base, canStart, canStop, canRetryStart,
    retryOperationId: canRetryStart ? latest.operationId : null, blockingReason });
}
