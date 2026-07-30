export type AiSessionMutationControls = Readonly<{
  showHistory: boolean;
  showComposer: boolean;
  showInterrupt: boolean;
  showStop: boolean;
  showRestart: boolean;
  restartDisabled: boolean;
}>;

export function aiSessionMutationControls(state: string, running: boolean, restartPending: boolean): AiSessionMutationControls {
  const active = state === "active";
  const stopped = state === "stopped";
  return {
    showHistory: true,
    showComposer: active,
    showInterrupt: active && running,
    showStop: active,
    showRestart: stopped,
    restartDisabled: !stopped || restartPending
  };
}

type RestartCoordinatorOptions = Readonly<{
  workspaceId: string;
  post: (body: { action: "restart"; workspaceId: string; sessionId: string }) => Promise<unknown>;
  cancel: () => void;
  load: (sessionId: string) => Promise<void>;
  setPending: (pending: boolean) => void;
  setMessage?: (message: string) => void;
}>;

export function createAiSessionRestartCoordinator(options: RestartCoordinatorOptions) {
  let pending = false;
  return {
    async restart(sessionId: string): Promise<boolean> {
      if (pending) return false;
      pending = true;
      options.setPending(true);
      options.cancel();
      try {
        await options.post({ action: "restart", workspaceId: options.workspaceId, sessionId });
        await options.load(sessionId);
        return true;
      } catch (error) {
        options.setMessage?.(error instanceof Error ? error.message : "Session restart failed.");
        return false;
      } finally {
        pending = false;
        options.setPending(false);
      }
    }
  };
}
