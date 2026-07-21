import type { RuntimeControlAction, RuntimeRestartMode } from "./runtime-control-state.js";

export type RuntimeActionRequester = (action: RuntimeControlAction) => Promise<void>;
export interface RuntimeRestartAuthorization {
  readonly runtimeState: string;
  readonly canStart: boolean;
}
export type RuntimeAuthorizationReader = () => Promise<RuntimeRestartAuthorization>;

export async function restartRuntime(mode: RuntimeRestartMode, request: RuntimeActionRequester, readAuthorization?: RuntimeAuthorizationReader): Promise<void> {
  if (mode === "running") {
    await request("stop");
    if (readAuthorization === undefined) throw new Error("Runtime authorization could not be refreshed before start.");
    const authorization = await readAuthorization();
    if (!authorization.canStart || (authorization.runtimeState !== "stopped" && authorization.runtimeState !== "absent")) {
      throw new Error("The workspace stopped, but fresh runtime reconciliation does not authorize starting it.");
    }
  }
  await request("start");
}
