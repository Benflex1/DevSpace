type StopRequest = Readonly<{
  action: "stop";
  workspaceId: string;
  sessionId: string;
}>;

type StopCoordinatorOptions = Readonly<{
  workspaceId: string;
  post: (body: StopRequest) => Promise<unknown>;
  setPending: (pending: boolean) => void;
  isStreamUnavailable?: () => boolean;
  reconcile?: () => void | Promise<void>;
  setMessage?: (message: string) => void;
}>;

/** Coordinates Stop without invalidating the canonical event transport first. */
export function createAiSessionStopCoordinator(options: StopCoordinatorOptions) {
  let pending = false;
  return {
    async stop(sessionId: string): Promise<boolean> {
      if (pending) return false;
      pending = true;
      options.setPending(true);
      try {
        await options.post({ action: "stop", workspaceId: options.workspaceId, sessionId });
        if (options.isStreamUnavailable?.() === true) await options.reconcile?.();
        return true;
      } catch (error) {
        options.setMessage?.(error instanceof Error ? error.message : "Stop failed.");
        return false;
      } finally {
        pending = false;
        options.setPending(false);
      }
    }
  };
}
