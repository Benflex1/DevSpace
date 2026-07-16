import {
  createTransitionTable,
  evaluateTransition,
  guardRejected,
  isStructuralLifecycleEdge,
  requiresRecoveryEvidence,
  type LifecycleState,
  type RecoveryEvidence,
  type TransitionDefinition,
  type TransitionResult
} from "./lifecycle.js";

export const previewDesiredStates = ["inactive", "active"] as const;
export type PreviewDesiredState = LifecycleState<
  (typeof previewDesiredStates)[number],
  "preview-desired"
>;
const previewDesiredTransitions: TransitionDefinition<
  (typeof previewDesiredStates)[number]
> = createTransitionTable<(typeof previewDesiredStates)[number]>({
  inactive: ["active"],
  active: ["inactive"]
});
export function isPreviewDesiredStructuralEdge(
  from: PreviewDesiredState,
  to: PreviewDesiredState
): boolean {
  return isStructuralLifecycleEdge(previewDesiredTransitions, from, to);
}
export function transitionPreviewDesired(
  from: PreviewDesiredState,
  to: PreviewDesiredState
): TransitionResult<PreviewDesiredState> {
  return evaluateTransition("preview-desired", previewDesiredTransitions, from, to);
}

export const previewObservedStates = [
  "inactive", "starting", "healthy", "unhealthy", "stopping", "failed", "lost"
] as const;
export type PreviewObservedState = LifecycleState<
  (typeof previewObservedStates)[number],
  "preview-observed"
>;
const previewObservedTransitions: TransitionDefinition<
  (typeof previewObservedStates)[number]
> = createTransitionTable<(typeof previewObservedStates)[number]>({
  inactive: ["starting"],
  starting: ["healthy", "unhealthy", "failed", "lost"],
  healthy: ["unhealthy", "stopping", "lost"],
  unhealthy: ["starting", "stopping", "failed", "lost"],
  stopping: ["inactive", "failed", "lost"],
  failed: ["starting", "inactive"],
  lost: ["starting", "inactive"]
});

export function isPreviewObservedStructuralEdge(
  from: PreviewObservedState,
  to: PreviewObservedState
): boolean {
  return isStructuralLifecycleEdge(previewObservedTransitions, from, to);
}

export interface PreviewObservedTransitionContext {
  readonly recoveryEvidence?: RecoveryEvidence;
  readonly routePresence?: { readonly routePresent: boolean };
}

export function validatePreviewRouteInvariant(
  state: PreviewObservedState,
  routePresence: { readonly routePresent: boolean }
): TransitionResult<PreviewObservedState> {
  return routePresence.routePresent && (state === "inactive" || state === "failed" || state === "lost")
    ? guardRejected("preview-observed", state, state, "PREVIEW_ROUTE_STATE_CONFLICT")
    : { ok: true, state };
}

export function transitionPreviewObserved(
  from: PreviewObservedState,
  to: PreviewObservedState,
  context?: PreviewObservedTransitionContext
): TransitionResult<PreviewObservedState> {
  const result = evaluateTransition("preview-observed", previewObservedTransitions, from, to);
  if (!result.ok) return result;
  const recoveryError = requiresRecoveryEvidence(
    "preview-observed", from, to, context?.recoveryEvidence
  );
  if (recoveryError !== undefined) return recoveryError;
  if (to !== "inactive" && to !== "failed" && to !== "lost") return result;
  if (context?.routePresence === undefined) {
    return guardRejected("preview-observed", from, to, "PREVIEW_ROUTE_PRESENCE_REQUIRED");
  }
  return context.routePresence.routePresent
    ? guardRejected("preview-observed", from, to, "PREVIEW_ROUTE_STATE_CONFLICT")
    : result;
}

export const aiSessionStates = [
  "creating", "active", "waiting_for_input", "interrupted", "stopped", "failed", "lost"
] as const;
export type AiSessionState = LifecycleState<(typeof aiSessionStates)[number], "ai-session">;
const aiSessionTransitions: TransitionDefinition<(typeof aiSessionStates)[number]> = createTransitionTable<
  (typeof aiSessionStates)[number]
>({
  creating: ["active", "stopped", "failed", "lost"],
  active: ["waiting_for_input", "interrupted", "stopped", "failed", "lost"],
  waiting_for_input: ["active", "interrupted", "stopped", "failed", "lost"],
  interrupted: ["active", "stopped", "failed", "lost"],
  stopped: [],
  failed: [],
  lost: []
});
export function isAiSessionStructuralEdge(from: AiSessionState, to: AiSessionState): boolean {
  return isStructuralLifecycleEdge(aiSessionTransitions, from, to);
}
export function transitionAiSession(
  from: AiSessionState,
  to: AiSessionState
): TransitionResult<AiSessionState> {
  return evaluateTransition("ai-session", aiSessionTransitions, from, to);
}

export const taskRunStates = [
  "queued", "starting", "running", "passed", "failed", "cancelled", "timed_out", "lost"
] as const;
export type TaskRunState = LifecycleState<(typeof taskRunStates)[number], "task-run">;
const taskRunTransitions: TransitionDefinition<(typeof taskRunStates)[number]> = createTransitionTable<
  (typeof taskRunStates)[number]
>({
  queued: ["starting", "cancelled"],
  starting: ["running", "failed", "cancelled", "lost"],
  running: ["passed", "failed", "cancelled", "timed_out", "lost"],
  passed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  lost: []
});
export function transitionTaskRun(
  from: TaskRunState,
  to: TaskRunState
): TransitionResult<TaskRunState> {
  return evaluateTransition("task-run", taskRunTransitions, from, to);
}
