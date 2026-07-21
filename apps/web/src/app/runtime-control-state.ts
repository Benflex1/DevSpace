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

export interface RuntimeRestartControlStateInput {
  readonly runtimeState: string;
  readonly runtimeAvailable: boolean;
  readonly activeAction: RuntimeControlAction | null;
  readonly canStart: boolean;
  readonly canStop: boolean;
  readonly pending?: boolean;
}

export type RuntimeRestartMode = "running" | "start";

export interface RuntimeRestartControlState {
  readonly mode: RuntimeRestartMode | null;
  readonly disabled: boolean;
  readonly reason: string | null;
}

export function runtimeRestartMode(runtimeState: string): RuntimeRestartMode | null {
  if (runtimeState === "running") return "running";
  if (runtimeState === "stopped" || runtimeState === "absent") return "start";
  return null;
}

export function runtimeRestartControlState(input: RuntimeRestartControlStateInput): RuntimeRestartControlState {
  const mode = runtimeRestartMode(input.runtimeState);
  const authorized = mode === "running" ? input.canStop && input.canStart : mode === "start" ? input.canStart : false;
  const reason = input.pending ? "Workspace restart is already in progress."
    : input.activeAction !== null ? "Another runtime action is already in progress."
      : !input.runtimeAvailable ? "The dedicated rootless runtime is unavailable."
        : mode === null ? "The runtime state does not currently support restart recovery."
          : !authorized ? mode === "running"
            ? "The live Agent state does not currently authorize restarting this runtime."
            : "The live Agent state does not currently authorize starting this runtime."
            : null;
  return { mode, disabled: input.pending === true || input.activeAction !== null || !input.runtimeAvailable || mode === null || !authorized, reason };
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
