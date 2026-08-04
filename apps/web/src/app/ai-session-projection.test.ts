import { describe, expect, test } from "vitest";
import {
  AI_SESSION_OUTPUT_MAX_BYTES,
  AI_TURN_OUTPUT_MAX_BYTES,
  appendAiTurnOutput,
  boundAiSessionTurns,
  type BrowserAiTurn
} from "./ai-session-projection.js";

const turn = (id: string, outputText = "", outputTruncated = false): BrowserAiTurn => ({
  id,
  state: "completed",
  content: { kind: "text", text: id },
  outputText,
  outputTruncated,
  activities: [],
  changedFiles: { files: [], truncated: false },
  createdAt: "2026-07-30T00:00:00.000Z"
});

describe("bounded browser AI projection", () => {
  const outputBytes = (turns: readonly BrowserAiTurn[]) => turns.reduce(
    (total, current) => total + new TextEncoder().encode(current.outputText).byteLength, 0
  );

  test("marks a live turn sticky when one delta crosses 2 MiB", () => {
    const result = appendAiTurnOutput([turn("turn-a")], "turn-a", "x".repeat(AI_TURN_OUTPUT_MAX_BYTES + 1));
    expect(new TextEncoder().encode(result[0]!.outputText).byteLength).toBe(AI_TURN_OUTPUT_MAX_BYTES);
    expect(result[0]!.outputTruncated).toBe(true);
  });

  test("retains newest turns first when the session output reaches 8 MiB", () => {
    const result = boundAiSessionTurns([
      turn("old", "o".repeat(AI_TURN_OUTPUT_MAX_BYTES)),
      turn("older-2", "2".repeat(AI_TURN_OUTPUT_MAX_BYTES)),
      turn("older-1", "1".repeat(AI_TURN_OUTPUT_MAX_BYTES)),
      turn("newer-2", "2".repeat(AI_TURN_OUTPUT_MAX_BYTES)),
      turn("new", "n".repeat(AI_TURN_OUTPUT_MAX_BYTES))
    ]);
    expect(result.reduce((bytes, item) => bytes + new TextEncoder().encode(item.outputText).byteLength, 0))
      .toBeLessThanOrEqual(AI_SESSION_OUTPUT_MAX_BYTES);
    expect(result[4]!.outputText).toBe("n".repeat(AI_TURN_OUTPUT_MAX_BYTES));
    expect(result[0]!.outputTruncated).toBe(true);
  });

  test("keeps exact boundaries and does not split multibyte text", () => {
    const exactTurn = appendAiTurnOutput([turn("exact")], "exact", "é".repeat(AI_TURN_OUTPUT_MAX_BYTES / 2));
    expect(new TextEncoder().encode(exactTurn[0]!.outputText).byteLength).toBe(AI_TURN_OUTPUT_MAX_BYTES);
    expect(exactTurn[0]!.outputTruncated).toBe(false);
    const over = appendAiTurnOutput(exactTurn, "exact", "é");
    expect(over[0]!.outputText).not.toContain("�");
    expect(over[0]!.outputTruncated).toBe(true);
  });

  test("does not clear truncation after later events or reload", () => {
    const truncated = appendAiTurnOutput([turn("sticky")], "sticky", "x".repeat(AI_TURN_OUTPUT_MAX_BYTES + 1));
    const later = appendAiTurnOutput(truncated, "sticky", "later");
    expect(later[0]!.outputTruncated).toBe(true);
    const reloaded = boundAiSessionTurns(JSON.parse(JSON.stringify(later)) as BrowserAiTurn[]);
    expect(reloaded[0]!.outputTruncated).toBe(true);
    expect(JSON.stringify(reloaded)).toBe(JSON.stringify(boundAiSessionTurns(reloaded)));
  });

  test("retains an exact 8 MiB session aggregate without aggregate truncation", () => {
    const result = boundAiSessionTurns(Array.from({ length: 4 }, (_, index) =>
      turn(`exact-${index}`, "😀".repeat(524_288))));
    expect(outputBytes(result)).toBe(AI_SESSION_OUTPUT_MAX_BYTES);
    expect(result.every((current) => current.outputTruncated === false)).toBe(true);
    expect(result.some((current) => current.outputText.includes("�"))).toBe(false);
  });

  test("truncates the oldest turn when one ASCII byte crosses the aggregate limit", () => {
    const base = "x".repeat(1_677_721);
    const oldest = "x".repeat(1_677_725);
    const result = boundAiSessionTurns([
      turn("oldest", oldest), turn("newer-3", base), turn("newer-2", base), turn("newer-1", base), turn("newest", base)
    ]);
    expect(outputBytes(result)).toBeLessThanOrEqual(AI_SESSION_OUTPUT_MAX_BYTES);
    expect(result.at(-1)?.outputText).toBe(base);
    expect(result[0]?.outputTruncated).toBe(true);
    expect(result[0]?.outputText).toBe("x".repeat(1_677_724));
  });

  test("keeps an exact multibyte aggregate valid through JSON roundtrip", () => {
    const result = boundAiSessionTurns(Array.from({ length: 4 }, (_, index) =>
      turn(`emoji-${index}`, "😀".repeat(524_288))));
    const reloaded = boundAiSessionTurns(JSON.parse(JSON.stringify(result)) as BrowserAiTurn[]);
    expect(outputBytes(reloaded)).toBe(AI_SESSION_OUTPUT_MAX_BYTES);
    expect(JSON.stringify(reloaded)).toBe(JSON.stringify(result));
    expect(reloaded.some((current) => current.outputText.includes("�"))).toBe(false);
  });

  test("drops a complete multibyte character only when it crosses the aggregate limit", () => {
    const newest = "😀".repeat(419_430);
    const oldest = "😀".repeat(419_432) + "😀";
    const result = boundAiSessionTurns([
      turn("oldest", oldest), turn("newer-3", newest), turn("newer-2", newest), turn("newer-1", newest), turn("newest", newest)
    ]);
    expect(outputBytes(result)).toBe(AI_SESSION_OUTPUT_MAX_BYTES);
    expect(result[0]?.outputText).toBe("😀".repeat(419_432));
    expect(result[0]?.outputTruncated).toBe(true);
    expect(result[0]?.outputText.includes("�")).toBe(false);
    expect(boundAiSessionTurns(JSON.parse(JSON.stringify(result)) as BrowserAiTurn[])).toEqual(result);
  });
});
