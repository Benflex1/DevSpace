import {
  createTransitionTable,
  evaluateTransition,
  guardRejected,
  isStructuralLifecycleEdge,
  requiresRecoveryEvidence,
  type LifecycleState,
  type RecoveryEvidence,
  type RuntimeAbsenceEvidence,
  type TransitionDefinition,
  type TransitionResult
} from "./lifecycle.js";

export const runtimeStackDesiredStates = ["absent", "stopped", "running"] as const;
export type RuntimeStackDesiredState = LifecycleState<
  (typeof runtimeStackDesiredStates)[number],
  "runtime-stack-desired"
>;
const runtimeStackDesiredTransitions: TransitionDefinition<
  (typeof runtimeStackDesiredStates)[number]
> = createTransitionTable<(typeof runtimeStackDesiredStates)[number]>({
  absent: ["stopped"],
  stopped: ["absent", "running"],
  running: ["stopped"]
});

export function transitionRuntimeStackDesired(
  from: RuntimeStackDesiredState,
  to: RuntimeStackDesiredState
): TransitionResult<RuntimeStackDesiredState> {
  return evaluateTransition("runtime-stack-desired", runtimeStackDesiredTransitions, from, to);
}

export const runtimeStackObservedStates = [
  "absent", "creating", "stopped", "starting", "running", "stopping", "degraded", "failed", "removing", "lost"
] as const;
export type RuntimeStackObservedState = LifecycleState<
  (typeof runtimeStackObservedStates)[number],
  "runtime-stack-observed"
>;
const runtimeStackObservedTransitions: TransitionDefinition<
  (typeof runtimeStackObservedStates)[number]
> = createTransitionTable<(typeof runtimeStackObservedStates)[number]>({
  absent: ["creating"],
  creating: ["stopped", "degraded", "failed", "lost"],
  stopped: ["starting", "removing", "lost"],
  starting: ["running", "degraded", "failed", "lost"],
  running: ["stopping", "degraded", "failed", "lost"],
  stopping: ["stopped", "degraded", "failed", "lost"],
  degraded: ["starting", "running", "stopping", "removing", "failed", "lost"],
  failed: ["creating", "starting", "stopping", "removing", "lost"],
  removing: ["absent", "failed", "lost"],
  lost: ["absent", "creating", "stopped", "starting", "running", "stopping", "degraded", "failed", "removing"]
});

export function isRuntimeStackObservedStructuralEdge(
  from: RuntimeStackObservedState,
  to: RuntimeStackObservedState
): boolean {
  return isStructuralLifecycleEdge(runtimeStackObservedTransitions, from, to);
}

export interface RuntimeStackObservedTransitionContext {
  readonly recoveryEvidence?: RecoveryEvidence;
  readonly absenceEvidence?: RuntimeAbsenceEvidence;
}

export function transitionRuntimeStackObserved(
  from: RuntimeStackObservedState,
  to: RuntimeStackObservedState,
  context?: RuntimeStackObservedTransitionContext
): TransitionResult<RuntimeStackObservedState> {
  const result = evaluateTransition("runtime-stack-observed", runtimeStackObservedTransitions, from, to);
  if (!result.ok) return result;
  const recoveryError = requiresRecoveryEvidence(
    "runtime-stack-observed", from, to, context?.recoveryEvidence
  );
  if (recoveryError !== undefined) return recoveryError;
  return to === "absent" && context?.absenceEvidence === undefined
    ? guardRejected("runtime-stack-observed", from, to, "RUNTIME_STACK_ABSENCE_UNCONFIRMED")
    : result;
}

export const workspaceServiceDesiredStates = ["absent", "stopped", "running"] as const;
export type WorkspaceServiceDesiredState = LifecycleState<
  (typeof workspaceServiceDesiredStates)[number],
  "workspace-service-desired"
>;
const workspaceServiceDesiredTransitions: TransitionDefinition<
  (typeof workspaceServiceDesiredStates)[number]
> = createTransitionTable<(typeof workspaceServiceDesiredStates)[number]>({
  absent: ["stopped"],
  stopped: ["absent", "running"],
  running: ["stopped"]
});

export function transitionWorkspaceServiceDesired(
  from: WorkspaceServiceDesiredState,
  to: WorkspaceServiceDesiredState
): TransitionResult<WorkspaceServiceDesiredState> {
  return evaluateTransition("workspace-service-desired", workspaceServiceDesiredTransitions, from, to);
}

export const workspaceServiceObservedStates = runtimeStackObservedStates;
export type WorkspaceServiceObservedState = LifecycleState<
  (typeof workspaceServiceObservedStates)[number],
  "workspace-service-observed"
>;
const workspaceServiceObservedTransitions: TransitionDefinition<
  (typeof workspaceServiceObservedStates)[number]
> = createTransitionTable<(typeof workspaceServiceObservedStates)[number]>({
  absent: ["creating"],
  creating: ["stopped", "degraded", "failed", "lost"],
  stopped: ["starting", "removing", "lost"],
  starting: ["running", "degraded", "failed", "lost"],
  running: ["stopping", "degraded", "failed", "lost"],
  stopping: ["stopped", "degraded", "failed", "lost"],
  degraded: ["starting", "running", "stopping", "removing", "failed", "lost"],
  failed: ["creating", "starting", "stopping", "removing", "lost"],
  removing: ["absent", "failed", "lost"],
  lost: ["absent", "creating", "stopped", "starting", "running", "stopping", "degraded", "failed", "removing"]
});

export function isWorkspaceServiceObservedStructuralEdge(
  from: WorkspaceServiceObservedState,
  to: WorkspaceServiceObservedState
): boolean {
  return isStructuralLifecycleEdge(workspaceServiceObservedTransitions, from, to);
}

export interface WorkspaceServiceObservedTransitionContext {
  readonly recoveryEvidence?: RecoveryEvidence;
  readonly owningStackObservedState?: RuntimeStackObservedState;
}

export function validateWorkspaceServiceOwnershipInvariant(
  serviceState: WorkspaceServiceObservedState,
  owningStackObservedState: RuntimeStackObservedState
): TransitionResult<WorkspaceServiceObservedState> {
  return serviceState === "running" && owningStackObservedState === "absent"
    ? guardRejected(
        "workspace-service-observed", serviceState, serviceState, "WORKSPACE_SERVICE_OWNER_STACK_ABSENT"
      )
    : { ok: true, state: serviceState };
}

export function transitionWorkspaceServiceObserved(
  from: WorkspaceServiceObservedState,
  to: WorkspaceServiceObservedState,
  context?: WorkspaceServiceObservedTransitionContext
): TransitionResult<WorkspaceServiceObservedState> {
  const result = evaluateTransition(
    "workspace-service-observed", workspaceServiceObservedTransitions, from, to
  );
  if (!result.ok) return result;
  const recoveryError = requiresRecoveryEvidence(
    "workspace-service-observed", from, to, context?.recoveryEvidence
  );
  if (recoveryError !== undefined) return recoveryError;
  return to === "running" && context?.owningStackObservedState === "absent"
    ? guardRejected(
        "workspace-service-observed", from, to, "WORKSPACE_SERVICE_OWNER_STACK_ABSENT"
      )
    : result;
}

export const workspaceServiceHealthStates = ["unknown", "starting", "healthy", "unhealthy"] as const;
export type WorkspaceServiceHealthState = LifecycleState<
  (typeof workspaceServiceHealthStates)[number],
  "workspace-service-health"
>;
const workspaceServiceHealthTransitions: TransitionDefinition<
  (typeof workspaceServiceHealthStates)[number]
> = createTransitionTable<(typeof workspaceServiceHealthStates)[number]>({
  unknown: ["starting", "healthy", "unhealthy"],
  starting: ["healthy", "unhealthy", "unknown"],
  healthy: ["unhealthy", "unknown"],
  unhealthy: ["healthy", "unknown"]
});

export function isWorkspaceServiceHealthStructuralEdge(
  from: WorkspaceServiceHealthState,
  to: WorkspaceServiceHealthState
): boolean {
  return isStructuralLifecycleEdge(workspaceServiceHealthTransitions, from, to);
}

export interface WorkspaceServiceHealthTransitionContext {
  readonly serviceObservedState?: WorkspaceServiceObservedState;
}

export function validateWorkspaceServiceHealthInvariant(
  healthState: WorkspaceServiceHealthState,
  serviceObservedState: WorkspaceServiceObservedState
): TransitionResult<WorkspaceServiceHealthState> {
  return healthState !== "unknown" && serviceObservedState !== "running"
    ? guardRejected(
        "workspace-service-health", healthState, healthState, "SERVICE_HEALTH_REQUIRES_RUNNING_SERVICE"
      )
    : { ok: true, state: healthState };
}

export function transitionWorkspaceServiceHealth(
  from: WorkspaceServiceHealthState,
  to: WorkspaceServiceHealthState,
  context?: WorkspaceServiceHealthTransitionContext
): TransitionResult<WorkspaceServiceHealthState> {
  const result = evaluateTransition(
    "workspace-service-health", workspaceServiceHealthTransitions, from, to
  );
  if (!result.ok || to === "unknown") return result;
  return context?.serviceObservedState !== "running"
    ? guardRejected(
        "workspace-service-health", from, to, "SERVICE_HEALTH_REQUIRES_RUNNING_SERVICE"
      )
    : result;
}
