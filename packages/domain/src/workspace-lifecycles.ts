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

export type WorkspaceKind = "primary" | "isolated";
export type DirtyStateHandling = "none" | "selected";
export interface WorkspaceDirtyStateContext {
  readonly workspaceKind: WorkspaceKind;
  readonly isDirty: boolean;
  readonly dirtyStateHandling: DirtyStateHandling;
}

export const workspaceDesiredStates = ["stopped", "running", "archived", "removed"] as const;
export type WorkspaceDesiredState = LifecycleState<
  (typeof workspaceDesiredStates)[number],
  "workspace-desired"
>;
const workspaceDesiredTransitions: TransitionDefinition<
  (typeof workspaceDesiredStates)[number]
> = createTransitionTable<(typeof workspaceDesiredStates)[number]>({
  stopped: ["running", "archived"],
  running: ["stopped"],
  archived: ["stopped", "removed"],
  removed: []
});

export interface WorkspaceDesiredTransitionContext {
  readonly dirtyState?: WorkspaceDirtyStateContext;
}

function workspaceDirtyGuard<State extends string>(
  lifecycle: "workspace-desired" | "workspace-observed",
  from: State,
  to: State,
  context: WorkspaceDirtyStateContext | undefined
): TransitionResult<State> | undefined {
  if (to !== "archived" && to !== "removed") return undefined;
  if (context === undefined) {
    return guardRejected(lifecycle, from, to, "WORKSPACE_DIRTY_STATE_CONTEXT_REQUIRED");
  }
  return context.workspaceKind === "isolated"
    && context.isDirty
    && context.dirtyStateHandling === "none"
    ? guardRejected(lifecycle, from, to, "WORKSPACE_DIRTY_HANDLING_REQUIRED")
    : undefined;
}

export function transitionWorkspaceDesired(
  from: WorkspaceDesiredState,
  to: WorkspaceDesiredState,
  context?: WorkspaceDesiredTransitionContext
): TransitionResult<WorkspaceDesiredState> {
  const result = evaluateTransition("workspace-desired", workspaceDesiredTransitions, from, to);
  if (!result.ok) return result;
  return workspaceDirtyGuard("workspace-desired", from, to, context?.dirtyState) ?? result;
}

export const workspaceObservedStates = [
  "provisioning", "stopped", "starting", "running", "stopping", "degraded", "failed", "lost", "archived", "removed"
] as const;
export type WorkspaceObservedState = LifecycleState<
  (typeof workspaceObservedStates)[number],
  "workspace-observed"
>;
const workspaceObservedTransitions: TransitionDefinition<
  (typeof workspaceObservedStates)[number]
> = createTransitionTable<(typeof workspaceObservedStates)[number]>({
  provisioning: ["stopped", "failed", "lost"],
  stopped: ["starting", "archived", "lost"],
  starting: ["running", "degraded", "failed", "lost"],
  running: ["stopping", "degraded", "failed", "lost"],
  stopping: ["stopped", "failed", "lost"],
  degraded: ["running", "stopping", "failed", "lost"],
  failed: ["starting", "stopping", "archived", "lost"],
  lost: ["provisioning", "stopped", "running", "degraded", "failed", "archived", "removed"],
  archived: ["provisioning", "stopped", "removed", "lost"],
  removed: []
});

export function isWorkspaceObservedStructuralEdge(
  from: WorkspaceObservedState,
  to: WorkspaceObservedState
): boolean {
  return isStructuralLifecycleEdge(workspaceObservedTransitions, from, to);
}

export interface WorkspaceObservedTransitionContext {
  readonly recoveryEvidence?: RecoveryEvidence;
  readonly dirtyState?: WorkspaceDirtyStateContext;
}

export function transitionWorkspaceObserved(
  from: WorkspaceObservedState,
  to: WorkspaceObservedState,
  context?: WorkspaceObservedTransitionContext
): TransitionResult<WorkspaceObservedState> {
  const result = evaluateTransition("workspace-observed", workspaceObservedTransitions, from, to);
  if (!result.ok) return result;
  return requiresRecoveryEvidence("workspace-observed", from, to, context?.recoveryEvidence)
    ?? workspaceDirtyGuard("workspace-observed", from, to, context?.dirtyState)
    ?? result;
}
