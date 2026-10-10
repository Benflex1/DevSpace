import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { replayAiEvents, type AiSessionReplayEvent } from "./ai-session-replay.js";

describe("AI session browser hydration", () => {
  test("does not append historical output deltas to persisted turn text", () => {
    const turn = {
      id: "turn-1", state: "completed", content: { kind: "text" as const, text: "Prompt" }, outputText: "Answer",
      outputTruncated: false, activities: [], changedFiles: { files: [], truncated: false }, createdAt: "2026-07-28T00:00:00.000Z"
    };
    const events: AiSessionReplayEvent[] = [
      { eventType: "turn.output.delta", turnId: "turn-1", payload: { text: "Answer" } },
      { eventType: "turn.activity.started", turnId: "turn-1", payload: { presentation: { summary: "Reading workspace" } } }
    ];

    const [hydrated] = replayAiEvents([turn], events);

    expect(hydrated?.outputText).toBe("Answer");
    expect(hydrated?.activities).toEqual(["Reading workspace"]);
  });

  test("renders explicit initial-start recovery through the Create coordinator", async () => {
    const source = await readFile(new URL("./ai-session-tab.tsx", import.meta.url), "utf8");

    expect(source).toContain("Codex did not finish starting.");
    expect(source).toContain("Retry starting Codex");
    expect(source).toContain("controls?.showInitialRetry");
    expect(source).toContain("disabled={controls.initialRetryDisabled}");
    expect(source).toContain("initialRetryCoordinator.retry(selected)");
    expect(source).toContain("aiSessionMutationControls(");
  });

  test("keeps historical sessions inspectable without offering a cross-revision restart", async () => {
    const source = await readFile(new URL("./ai-session-tab.tsx", import.meta.url), "utf8");

    expect(source).toContain("profile.profileRevision === session.profileRevision");
    expect(source).toContain("historical-only");
  });
});
