export type AiAmbiguousSend = Readonly<{
  sessionId: string;
  selectionGeneration: number;
  turnId: string;
  draft: string;
}>;

export type AiSendReconciliationSnapshot = Readonly<{
  sessionId: string;
  selectionGeneration: number;
  state: string;
  canonicalTurnIds: ReadonlySet<string>;
}>;

type Options = Readonly<{
  restoreDraft: (draft: string) => void;
  setPending: (pending: boolean) => void;
  setMessage: (message: string | null) => void;
}>;

export function createAiSessionSendReconciliation(options: Options) {
  let unresolved: AiAmbiguousSend | null = null;
  return {
    begin(value: AiAmbiguousSend): boolean {
      if (unresolved !== null) return false;
      unresolved = value;
      options.setPending(true);
      options.setMessage("Delivery outcome is uncertain; reconciling.");
      return true;
    },
    observe(snapshot: AiSendReconciliationSnapshot): "pending" | "accepted" | "restored" | "stale" {
      if (unresolved === null) return "stale";
      if (snapshot.sessionId !== unresolved.sessionId
        || snapshot.selectionGeneration !== unresolved.selectionGeneration) return "stale";
      if (snapshot.canonicalTurnIds.has(unresolved.turnId)) {
        unresolved = null;
        options.setPending(false);
        options.setMessage(null);
        return "accepted";
      }
      if (snapshot.state !== "stopped" && snapshot.state !== "lost") {
        options.setMessage("Delivery outcome is uncertain; reconciling.");
        return "pending";
      }
      const draft = unresolved.draft;
      unresolved = null;
      options.restoreDraft(draft);
      options.setPending(false);
      return "restored";
    },
    fail(sessionId: string, selectionGeneration: number): void {
      if (unresolved?.sessionId !== sessionId || unresolved.selectionGeneration !== selectionGeneration) return;
      options.setMessage("Delivery outcome is uncertain; reconciling.");
    },
    hasPending(sessionId: string, selectionGeneration: number): boolean {
      return unresolved?.sessionId === sessionId && unresolved.selectionGeneration === selectionGeneration;
    }
  };
}
