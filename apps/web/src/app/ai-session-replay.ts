import { applyAiInteractionEvent, boundAiSessionTurns, projectAiInteractions, type BrowserAiInteraction, type BrowserAiTurn } from "./ai-session-projection.js";

export type { BrowserAiTurn } from "./ai-session-projection.js";

export type AiSessionReplayTurn = BrowserAiTurn;

export type AiSessionReplayEvent = {
  eventType: string;
  turnId: string | null;
  observedAt?: string;
  payload: Record<string, unknown>;
};

export function replayAiInteractions(initial: readonly unknown[], events: readonly AiSessionReplayEvent[]): BrowserAiInteraction[] {
  return events.reduce((current, event) => applyAiInteractionEvent(current, event), projectAiInteractions(initial));
}

export function replayAiEvents(initial: readonly AiSessionReplayTurn[], events: readonly AiSessionReplayEvent[]): AiSessionReplayTurn[] {
  const replayed = events.reduce((current, event) => {
    if (event.turnId === null) return current;
    const index = current.findIndex((turn) => turn.id === event.turnId);
    const existing = index < 0 ? {
      id: event.turnId, state: "accepted", content: { kind: "text" as const, text: "" }, outputText: "", outputTruncated: false, activities: [],
      changedFiles: { files: [], truncated: false }, createdAt: new Date().toISOString()
    } : current[index]!;
    const next = { ...existing };
    if (event.eventType === "turn.accepted") next.content = event.payload.content as AiSessionReplayTurn["content"];
    if (event.eventType === "turn.started" || event.eventType === "turn.activity.started" || event.eventType === "turn.output.delta") next.state = "running";
    if (event.eventType === "turn.activity.started") {
      const presentation = event.payload.presentation;
      const summary = presentation !== null && typeof presentation === "object" && typeof (presentation as { summary?: unknown }).summary === "string"
        ? (presentation as { summary: string }).summary : "Activity";
      next.activities = [...next.activities, summary];
    }
    if (event.eventType === "turn.files.changed") next.changedFiles = event.payload as AiSessionReplayTurn["changedFiles"];
    if (event.eventType === "turn.interrupted") next.state = "interrupted";
    if (event.eventType === "turn.quiesced") next.state = typeof event.payload.outcome === "string" ? event.payload.outcome : "completed";
    if (event.eventType === "turn.failed") next.state = "failed";
    if (index < 0) return [...current, next];
    return current.map((turn, candidate) => candidate === index ? next : turn);
  }, initial.map((turn) => ({ ...turn, outputTruncated: turn.outputTruncated ?? false, activities: [...turn.activities] })));
  return boundAiSessionTurns(replayed);
}
