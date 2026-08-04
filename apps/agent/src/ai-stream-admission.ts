export interface AiStreamAdmission {
  tryAcquire(sessionId: string): (() => void) | null;
}

export function createAiStreamAdmission(options: {
  readonly globalLimit: number;
  readonly perSessionLimit: number;
}): AiStreamAdmission {
  let active = 0;
  const activeBySession = new Map<string, number>();
  return {
    tryAcquire(sessionId) {
      const sessionActive = activeBySession.get(sessionId) ?? 0;
      if (active >= options.globalLimit || sessionActive >= options.perSessionLimit) return null;
      active += 1;
      activeBySession.set(sessionId, sessionActive + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
        const remaining = (activeBySession.get(sessionId) ?? 1) - 1;
        if (remaining === 0) activeBySession.delete(sessionId);
        else activeBySession.set(sessionId, remaining);
      };
    }
  };
}
