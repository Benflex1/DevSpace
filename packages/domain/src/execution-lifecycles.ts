import {
  createTransitionTable,
  evaluateTransition,
  requiresRecoveryEvidence,
  type LifecycleState,
  type RecoveryEvidence,
  type TransitionDefinition,
  type TransitionResult
} from "./lifecycle.js";

export const processDesiredStates = ["running", "stopped"] as const;
export type ProcessDesiredState = LifecycleState<
  (typeof processDesiredStates)[number],
  "process-desired"
>;
const processDesiredTransitions: TransitionDefinition<
  (typeof processDesiredStates)[number]
> = createTransitionTable<(typeof processDesiredStates)[number]>({
  running: ["stopped"],
  stopped: ["running"]
});

export function transitionProcessDesired(
  from: ProcessDesiredState,
  to: ProcessDesiredState
): TransitionResult<ProcessDesiredState> {
  return evaluateTransition("process-desired", processDesiredTransitions, from, to);
}

export const processObservedStates = [
  "queued", "starting", "running", "stopping", "exited", "failed", "killed", "lost"
] as const;
export type ProcessObservedState = LifecycleState<
  (typeof processObservedStates)[number],
  "process-observed"
>;
const processObservedTransitions: TransitionDefinition<
  (typeof processObservedStates)[number]
> = createTransitionTable<(typeof processObservedStates)[number]>({
  queued: ["starting", "killed", "failed"],
  starting: ["running", "stopping", "failed", "killed", "lost"],
  running: ["stopping", "exited", "failed", "lost"],
  stopping: ["exited", "killed", "failed", "lost"],
  exited: [],
  failed: [],
  killed: [],
  lost: ["exited", "killed", "failed"]
});

export interface ProcessObservedTransitionContext {
  readonly recoveryEvidence?: RecoveryEvidence;
}

export function transitionProcessObserved(
  from: ProcessObservedState,
  to: ProcessObservedState,
  context?: ProcessObservedTransitionContext
): TransitionResult<ProcessObservedState> {
  const result = evaluateTransition("process-observed", processObservedTransitions, from, to);
  if (!result.ok) return result;
  return requiresRecoveryEvidence("process-observed", from, to, context?.recoveryEvidence) ?? result;
}

export const terminalStates = ["creating", "active", "disconnected", "closing", "closed", "failed", "lost"] as const;
export type TerminalState = LifecycleState<(typeof terminalStates)[number], "terminal">;
const terminalTransitions: TransitionDefinition<(typeof terminalStates)[number]> = createTransitionTable<
  (typeof terminalStates)[number]
>({
  creating: ["active", "failed", "lost"],
  active: ["disconnected", "closing", "failed", "lost"],
  disconnected: ["active", "closing", "failed", "lost"],
  closing: ["closed", "failed", "lost"],
  closed: [],
  failed: [],
  lost: []
});

export function transitionTerminal(
  from: TerminalState,
  to: TerminalState
): TransitionResult<TerminalState> {
  return evaluateTransition("terminal", terminalTransitions, from, to);
}
