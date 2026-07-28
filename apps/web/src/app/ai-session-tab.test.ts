import { describe, expect, test } from "vitest";
import { replayAiEvents, type AiSessionReplayEvent } from "./ai-session-replay.js";

describe("AI session browser hydration", () => {
  test("does not append historical output deltas to persisted turn text", () => {
    const turn = {
      id: "turn-1", state: "completed", content: { kind: "text" as const, text: "Prompt" }, outputText: "Answer",
      activities: [], changedFiles: { files: [], truncated: false }, createdAt: "2026-07-28T00:00:00.000Z"
    };
    const events: AiSessionReplayEvent[] = [
      { eventType: "turn.output.delta", turnId: "turn-1", payload: { text: "Answer" } },
      { eventType: "turn.activity.started", turnId: "turn-1", payload: { presentation: { summary: "Reading workspace" } } }
    ];

    const [hydrated] = replayAiEvents([turn], events);

    expect(hydrated?.outputText).toBe("Answer");
    expect(hydrated?.activities).toEqual(["Reading workspace"]);
  });
});
