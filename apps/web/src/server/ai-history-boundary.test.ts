import { describe, expect, test } from "vitest";
import { normalizeRetainedHistory } from "./ai-history.js";

type Projection = {
  session: { lastSequence: number; historyStartSequence: number; historyTruncated: boolean };
  events: Array<{ sequence: number }>;
};

const projection = (lastSequence: number, historyStartSequence: number, events: number[], historyTruncated = false): Projection => ({
  session: { lastSequence, historyStartSequence, historyTruncated },
  events: events.map((sequence) => ({ sequence }))
});

describe("public retained history boundary", () => {
  test("normalizes a retained suffix and marks the advanced boundary truncated", () => {
    const result = normalizeRetainedHistory(projection(42, 1, [37, 38, 39, 40, 41, 42]));
    expect(result.session.historyStartSequence).toBe(37);
    expect(result.session.historyTruncated).toBe(true);
  });

  test("normalizes an empty retained collection after the latest sequence", () => {
    const result = normalizeRetainedHistory(projection(42, 1, []));
    expect(result.session.historyStartSequence).toBe(43);
    expect(result.session.historyTruncated).toBe(true);
  });

  test("keeps a never-started session at its natural sequence one boundary", () => {
    const result = normalizeRetainedHistory(projection(0, 1, []));
    expect(result.session.historyStartSequence).toBe(1);
    expect(result.session.historyTruncated).toBe(false);
  });

  test.each([
    ["a sequence gap", [37, 38, 40, 41, 42]],
    ["duplicate sequences", [37, 38, 39, 39, 40, 41, 42]],
    ["descending events", [42, 41]],
    ["an event beyond lastSequence", [37, 38, 43]]
  ])("rejects %s", (_label, events) => {
    expect(() => normalizeRetainedHistory(projection(42, 1, events))).toThrow();
  });
});
