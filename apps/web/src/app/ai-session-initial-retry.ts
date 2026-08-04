export type AiSessionInitialRetrySelection = Readonly<{
  sessionId: string;
  selectionGeneration: number;
  state: string;
  lastSequence: number;
}>;

type InitialRetryCoordinatorOptions = Readonly<{
  workspaceId: string;
  getSelection: () => AiSessionInitialRetrySelection | null;
  post: (body: { action: "create"; workspaceId: string }) => Promise<{ sessionId?: string }>;
  load: (sessionId: string) => Promise<void>;
  setPending: (pending: boolean) => void;
  setMessage: (message: string) => void;
}>;

function isSameSelection(current: AiSessionInitialRetrySelection | null, expected: AiSessionInitialRetrySelection): boolean {
  return current?.sessionId === expected.sessionId
    && current.selectionGeneration === expected.selectionGeneration;
}

function isInitialRecovery(current: AiSessionInitialRetrySelection | null, expected: AiSessionInitialRetrySelection): boolean {
  return isSameSelection(current, expected)
    && current?.state === "creating"
    && current.lastSequence === 0;
}

export function createAiSessionInitialRetryCoordinator(options: InitialRetryCoordinatorOptions) {
  let requestPending = false;
  let coordinationGeneration = 0;
  let pendingVisible = false;

  const setPending = (pending: boolean) => {
    if (pendingVisible === pending) return;
    pendingVisible = pending;
    options.setPending(pending);
  };

  return {
    async retry(expected: AiSessionInitialRetrySelection): Promise<boolean> {
      if (requestPending || !isInitialRecovery(options.getSelection(), expected)) return false;
      requestPending = true;
      const requestGeneration = ++coordinationGeneration;
      setPending(true);
      try {
        const result = await options.post({ action: "create", workspaceId: options.workspaceId });
        if (requestGeneration !== coordinationGeneration || !isInitialRecovery(options.getSelection(), expected)) return false;
        if (result.sessionId !== expected.sessionId) {
          options.setMessage("The AI session is no longer available.");
          return false;
        }
        await options.load(result.sessionId);
        return requestGeneration === coordinationGeneration
          && isSameSelection(options.getSelection(), expected);
      } catch (error) {
        if (requestGeneration === coordinationGeneration && isInitialRecovery(options.getSelection(), expected)) {
          options.setMessage(error instanceof Error ? error.message : "Session creation failed.");
        }
        return false;
      } finally {
        requestPending = false;
        if (requestGeneration === coordinationGeneration) setPending(false);
      }
    },
    invalidate(): void {
      coordinationGeneration += 1;
      setPending(false);
    }
  };
}
