import {
  createTransitionTable,
  evaluateTransition,
  guardRejected,
  type LifecycleState,
  type TransitionDefinition,
  type TransitionResult
} from "./lifecycle.js";

export const projectStates = ["registering", "ready", "invalid", "archived"] as const;
export type ProjectState = LifecycleState<(typeof projectStates)[number], "project">;
const projectTransitions: TransitionDefinition<(typeof projectStates)[number]> = createTransitionTable<
  (typeof projectStates)[number]
>({
  registering: ["ready", "invalid"],
  ready: ["archived"],
  invalid: ["registering"],
  archived: ["ready"]
});

export interface ProjectReadinessContext {
  readonly activeConfigurationRevisionExists: boolean;
  readonly nonRemovedPrimaryWorkspaceExists: boolean;
}

export function transitionProject(
  from: ProjectState,
  to: ProjectState,
  context?: ProjectReadinessContext
): TransitionResult<ProjectState> {
  const result = evaluateTransition("project", projectTransitions, from, to);
  if (!result.ok || from !== "registering" || to !== "ready") return result;
  if (
    context?.activeConfigurationRevisionExists !== true
    || context.nonRemovedPrimaryWorkspaceExists !== true
  ) {
    return guardRejected("project", from, to, "PROJECT_READINESS_REQUIRED");
  }
  return result;
}

export const configurationRevisionStates = ["draft", "active", "rejected", "superseded"] as const;
export type ConfigurationRevisionState = LifecycleState<
  (typeof configurationRevisionStates)[number],
  "configuration-revision"
>;
const configurationRevisionTransitions: TransitionDefinition<
  (typeof configurationRevisionStates)[number]
> = createTransitionTable<(typeof configurationRevisionStates)[number]>({
  draft: ["active", "rejected"],
  active: ["superseded"],
  rejected: [],
  superseded: []
});

export function transitionConfigurationRevision(
  from: ConfigurationRevisionState,
  to: ConfigurationRevisionState
): TransitionResult<ConfigurationRevisionState> {
  return evaluateTransition("configuration-revision", configurationRevisionTransitions, from, to);
}

export const operationStates = ["accepted", "running", "succeeded", "failed", "cancelled"] as const;
export type OperationState = LifecycleState<(typeof operationStates)[number], "operation">;
const operationTransitions: TransitionDefinition<(typeof operationStates)[number]> = createTransitionTable<
  (typeof operationStates)[number]
>({
  accepted: ["running", "succeeded", "failed", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: []
});

export interface OperationTransitionContext {
  readonly cancellationCapability?: { readonly kind: "operation-type-supports-cancellation" };
}

export function transitionOperation(
  from: OperationState,
  to: OperationState,
  context?: OperationTransitionContext
): TransitionResult<OperationState> {
  const result = evaluateTransition("operation", operationTransitions, from, to);
  if (!result.ok || to !== "cancelled") return result;
  return context?.cancellationCapability === undefined
    ? guardRejected("operation", from, to, "OPERATION_CANCELLATION_UNSUPPORTED")
    : result;
}
