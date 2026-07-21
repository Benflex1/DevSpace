import type { RuntimeControlAction, RuntimeRestartMode } from "./runtime-control-state.js";

export type RuntimeActionRequester = (action: RuntimeControlAction) => Promise<void>;

export async function restartRuntime(mode: RuntimeRestartMode, request: RuntimeActionRequester): Promise<void> {
  if (mode === "running") await request("stop");
  await request("start");
}
