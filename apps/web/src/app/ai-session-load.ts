export type AiSessionLoadCoordinator = {
  load: (requestedSessionId?: string) => Promise<void>;
  cancel: () => void;
};

type AiSessionLoadOptions<T> = {
  run: (requestedSessionId: string | undefined, signal: AbortSignal, isCurrent: () => boolean) => Promise<T>;
  apply: (value: T) => void;
  setLoading: (loading: boolean) => void;
  setMessage: (message: string | null) => void;
  setController?: (controller: AbortController | null) => void;
};

function abortError(): DOMException {
  return new DOMException("The AI session load was superseded.", "AbortError");
}

export function createAiSessionLoadCoordinator<T>(options: AiSessionLoadOptions<T>): AiSessionLoadCoordinator {
  let generation = 0;
  let activeController: AbortController | null = null;

  const load = async (requestedSessionId?: string): Promise<void> => {
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const requestGeneration = ++generation;
    const isCurrent = () => generation === requestGeneration && activeController === controller && !controller.signal.aborted;
    options.setController?.(controller);
    options.setLoading(true);
    try {
      const result = await options.run(requestedSessionId, controller.signal, isCurrent);
      if (!isCurrent()) return;
      options.apply(result);
    } catch (error) {
      if (isCurrent() && !controller.signal.aborted) options.setMessage(error instanceof Error ? error.message : "AI session unavailable.");
    } finally {
      if (isCurrent()) {
        options.setLoading(false);
        options.setController?.(null);
      }
    }
  };

  const cancel = () => {
    generation += 1;
    activeController?.abort(abortError());
    options.setController?.(null);
    activeController = null;
  };

  return { load, cancel };
}
