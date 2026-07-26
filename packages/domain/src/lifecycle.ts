export const lifecycleNames = [
  "project",
  "configuration-revision",
  "operation",
  "workspace-desired",
  "workspace-observed",
  "runtime-stack-desired",
  "runtime-stack-observed",
  "workspace-service-desired",
  "workspace-service-observed",
  "workspace-service-health",
  "process-desired",
  "process-observed",
  "terminal",
  "preview-desired",
  "preview-observed",
  "ai-session",
  "ai-session-v1",
  "ai-provider-process",
  "ai-turn",
  "ai-interaction-request",
  "task-run"
] as const;

export type LifecycleName = (typeof lifecycleNames)[number];

declare const lifecycleStateBrand: unique symbol;
export type LifecycleState<Value extends string, Lifecycle extends LifecycleName> = Value & {
  readonly [lifecycleStateBrand]?: Lifecycle;
};

export const lifecycleTransitionErrorCodes = [
  "INVALID_LIFECYCLE_TRANSITION",
  "PROJECT_READINESS_REQUIRED",
  "OPERATION_CANCELLATION_UNSUPPORTED",
  "WORKSPACE_DIRTY_STATE_CONTEXT_REQUIRED",
  "WORKSPACE_DIRTY_HANDLING_REQUIRED",
  "RECOVERY_EVIDENCE_REQUIRED",
  "RUNTIME_STACK_ABSENCE_UNCONFIRMED",
  "WORKSPACE_SERVICE_OWNER_STACK_ABSENT",
  "SERVICE_HEALTH_REQUIRES_RUNNING_SERVICE",
  "PREVIEW_ROUTE_PRESENCE_REQUIRED",
  "PREVIEW_ROUTE_STATE_CONFLICT"
] as const;

export type LifecycleTransitionErrorCode = (typeof lifecycleTransitionErrorCodes)[number];

export type LifecycleTransitionError =
  | {
      readonly kind: "invalid-transition";
      readonly code: "INVALID_LIFECYCLE_TRANSITION";
      readonly lifecycle: LifecycleName;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly kind: "guard-rejected";
      readonly code: Exclude<LifecycleTransitionErrorCode, "INVALID_LIFECYCLE_TRANSITION">;
      readonly lifecycle: LifecycleName;
      readonly from: string;
      readonly to: string;
    };

export type TransitionResult<State> =
  | { readonly ok: true; readonly state: State }
  | { readonly ok: false; readonly error: LifecycleTransitionError };

export type TransitionDefinition<State extends string> = Readonly<
  Record<State, readonly State[]>
>;

export function createTransitionTable<State extends string>(
  definition: Readonly<Record<State, readonly State[]>>
): TransitionDefinition<State> {
  const sources = Object.keys(definition) as State[];
  const entries = sources.map((source) => [
    source,
    Object.freeze([...definition[source]])
  ] as const);
  return Object.freeze(Object.fromEntries(entries)) as TransitionDefinition<State>;
}

export interface RecoveryEvidence {
  readonly kind: "fresh-observation" | "reconciliation-result";
}

export interface RuntimeAbsenceEvidence {
  readonly kind: "owned-runtime-resources-absent";
}

export function invalidTransition(
  lifecycle: LifecycleName,
  from: unknown,
  to: unknown
): TransitionResult<never> {
  return {
    ok: false,
    error: { kind: "invalid-transition", code: "INVALID_LIFECYCLE_TRANSITION", lifecycle, from: String(from), to: String(to) }
  };
}

export function guardRejected(
  lifecycle: LifecycleName,
  from: unknown,
  to: unknown,
  code: Exclude<LifecycleTransitionErrorCode, "INVALID_LIFECYCLE_TRANSITION">
): TransitionResult<never> {
  return {
    ok: false,
    error: { kind: "guard-rejected", code, lifecycle, from: String(from), to: String(to) }
  };
}

export function evaluateTransition<State extends string>(
  lifecycle: LifecycleName,
  transitions: TransitionDefinition<State>,
  from: State,
  to: State
): TransitionResult<State> {
  if (!transitions[from].includes(to)) {
    return invalidTransition(lifecycle, from, to);
  }
  return { ok: true, state: to };
}

export function isStructuralLifecycleEdge<State extends string>(
  transitions: TransitionDefinition<State>,
  from: State,
  to: State
): boolean {
  return transitions[from].includes(to);
}

export function requiresRecoveryEvidence(
  lifecycle: LifecycleName,
  from: string,
  to: string,
  evidence: RecoveryEvidence | undefined
): TransitionResult<never> | undefined {
  return from === "lost" && evidence === undefined
    ? guardRejected(lifecycle, from, to, "RECOVERY_EVIDENCE_REQUIRED")
    : undefined;
}
