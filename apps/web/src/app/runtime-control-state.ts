export type RuntimeControlAction = "start" | "stop";

export interface RuntimeControlStateInput {
  readonly runtimeState: string;
  readonly runtimeAvailable: boolean;
  readonly activeAction: RuntimeControlAction | null;
  readonly canStart: boolean;
  readonly canStop: boolean;
  readonly requestedAction?: RuntimeControlAction;
}

export interface RuntimeControlState {
  readonly action: RuntimeControlAction;
  readonly visible: true;
  readonly disabled: boolean;
  readonly reason: string | null;
}

export function runtimeControlState(input: RuntimeControlStateInput): RuntimeControlState {
  const action = input.requestedAction
    ?? (input.runtimeState === "running" ? "stop"
      : input.runtimeState === "stopped" || input.runtimeState === "absent" ? "start"
        : input.canStop ? "stop" : "start");
  const authorized = action === "stop" ? input.canStop : input.canStart;
  const reason = input.activeAction !== null ? "Another runtime action is already in progress."
    : !input.runtimeAvailable ? "The dedicated rootless runtime is unavailable."
      : !authorized ? action === "stop"
        ? "The live Agent state does not currently authorize stopping this runtime."
        : "The live Agent state does not currently authorize starting this runtime."
        : null;
  return { action, visible: true, disabled: input.activeAction !== null || !input.runtimeAvailable || !authorized, reason };
}
