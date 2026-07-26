import {
  createTransitionTable,
  evaluateTransition,
  isStructuralLifecycleEdge,
  type LifecycleState,
  type TransitionDefinition,
  type TransitionResult
} from "./lifecycle.js";

/**
 * First-class structured AI sessions. The older `aiSessionStates` export remains
 * the dormant database-v1 vocabulary until the persistence slice migrates it.
 */
export const aiSessionV1States = [
  "creating",
  "ready",
  "running",
  "waiting-for-approval",
  "waiting-for-input",
  "interrupting",
  "stopping",
  "stopped",
  "unavailable",
  "lost"
] as const;
export type AiSessionV1State = LifecycleState<
  (typeof aiSessionV1States)[number],
  "ai-session-v1"
>;
const aiSessionV1Transitions: TransitionDefinition<
  (typeof aiSessionV1States)[number]
> = createTransitionTable<(typeof aiSessionV1States)[number]>({
  creating: ["ready", "stopping", "unavailable", "lost"],
  ready: ["running", "stopping", "unavailable", "lost"],
  running: [
    "ready",
    "waiting-for-approval",
    "waiting-for-input",
    "interrupting",
    "stopping",
    "lost"
  ],
  "waiting-for-approval": ["running", "interrupting", "stopping", "lost"],
  "waiting-for-input": ["running", "interrupting", "stopping", "lost"],
  interrupting: ["ready", "stopping", "lost"],
  stopping: ["stopped", "lost"],
  stopped: ["creating"],
  unavailable: ["creating", "stopping", "lost"],
  lost: ["creating", "stopping"]
});

export function isAiSessionV1StructuralEdge(
  from: AiSessionV1State,
  to: AiSessionV1State
): boolean {
  return isStructuralLifecycleEdge(aiSessionV1Transitions, from, to);
}

export function transitionAiSessionV1(
  from: AiSessionV1State,
  to: AiSessionV1State
): TransitionResult<AiSessionV1State> {
  return evaluateTransition("ai-session-v1", aiSessionV1Transitions, from, to);
}

export const aiProviderProcessStates = [
  "creating",
  "exec-created",
  "identity-confirming",
  "running",
  "stopping",
  "exited",
  "failed",
  "lost"
] as const;
export type AiProviderProcessState = LifecycleState<
  (typeof aiProviderProcessStates)[number],
  "ai-provider-process"
>;
const aiProviderProcessTransitions: TransitionDefinition<
  (typeof aiProviderProcessStates)[number]
> = createTransitionTable<(typeof aiProviderProcessStates)[number]>({
  creating: ["exec-created", "failed", "lost"],
  "exec-created": ["identity-confirming", "failed", "lost"],
  "identity-confirming": ["running", "failed", "lost"],
  running: ["stopping", "exited", "failed", "lost"],
  stopping: ["exited", "failed", "lost"],
  exited: [],
  failed: [],
  lost: []
});

export function isAiProviderProcessStructuralEdge(
  from: AiProviderProcessState,
  to: AiProviderProcessState
): boolean {
  return isStructuralLifecycleEdge(aiProviderProcessTransitions, from, to);
}

export function transitionAiProviderProcess(
  from: AiProviderProcessState,
  to: AiProviderProcessState
): TransitionResult<AiProviderProcessState> {
  return evaluateTransition("ai-provider-process", aiProviderProcessTransitions, from, to);
}

export const aiTurnStates = [
  "accepted",
  "starting",
  "running",
  "waiting-for-approval",
  "waiting-for-input",
  "interrupting",
  "provider-completed",
  "quiesced",
  "completed",
  "interrupted",
  "failed",
  "lost"
] as const;
export type AiTurnState = LifecycleState<(typeof aiTurnStates)[number], "ai-turn">;
const aiTurnTransitions: TransitionDefinition<
  (typeof aiTurnStates)[number]
> = createTransitionTable<(typeof aiTurnStates)[number]>({
  accepted: ["starting", "failed", "lost"],
  starting: ["running", "failed", "lost"],
  running: [
    "waiting-for-approval",
    "waiting-for-input",
    "interrupting",
    "provider-completed",
    "failed",
    "lost"
  ],
  "waiting-for-approval": ["running", "interrupting", "failed", "lost"],
  "waiting-for-input": ["running", "interrupting", "failed", "lost"],
  interrupting: ["provider-completed", "interrupted", "failed", "lost"],
  "provider-completed": ["quiesced", "failed", "lost"],
  quiesced: ["completed", "interrupted", "failed"],
  completed: [],
  interrupted: [],
  failed: [],
  lost: []
});

export function isAiTurnStructuralEdge(from: AiTurnState, to: AiTurnState): boolean {
  return isStructuralLifecycleEdge(aiTurnTransitions, from, to);
}

export function transitionAiTurn(
  from: AiTurnState,
  to: AiTurnState
): TransitionResult<AiTurnState> {
  return evaluateTransition("ai-turn", aiTurnTransitions, from, to);
}

export const aiInteractionRequestStates = [
  "pending",
  "responded",
  "cancelled",
  "expired",
  "lost"
] as const;
export type AiInteractionRequestState = LifecycleState<
  (typeof aiInteractionRequestStates)[number],
  "ai-interaction-request"
>;
const aiInteractionRequestTransitions: TransitionDefinition<
  (typeof aiInteractionRequestStates)[number]
> = createTransitionTable<(typeof aiInteractionRequestStates)[number]>({
  pending: ["responded", "cancelled", "expired", "lost"],
  responded: [],
  cancelled: [],
  expired: [],
  lost: []
});

export function isAiInteractionRequestStructuralEdge(
  from: AiInteractionRequestState,
  to: AiInteractionRequestState
): boolean {
  return isStructuralLifecycleEdge(aiInteractionRequestTransitions, from, to);
}

export function transitionAiInteractionRequest(
  from: AiInteractionRequestState,
  to: AiInteractionRequestState
): TransitionResult<AiInteractionRequestState> {
  return evaluateTransition("ai-interaction-request", aiInteractionRequestTransitions, from, to);
}
