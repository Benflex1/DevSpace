import { describe, expect, test } from "vitest";
import {
  MAX_EVENT_SEQUENCE,
  cursorSequenceSchema,
  eventCursorSchema,
  eventSequenceSchema,
  formatEventCursor,
  parseEventCursor
} from "@devspace/contracts";

const bootId = "018f1f34-7abc-7def-8abc-0123456789ab";

describe("F10 cursor contract", () => {
  test.each([0, 1, MAX_EVENT_SEQUENCE])("accepts cursor sequence %s", (sequence) => {
    const cursor = `v1.${bootId}.${sequence}`;
    expect(eventCursorSchema.safeParse(cursor).success).toBe(true);
    expect(parseEventCursor(cursor)).toEqual({
      ok: true,
      value: { agentBootId: bootId, sequence },
      cursor
    });
  });

  test("keeps event and cursor sequence ranges distinct", () => {
    expect(cursorSequenceSchema.safeParse(0).success).toBe(true);
    expect(eventSequenceSchema.safeParse(0).success).toBe(false);
    expect(eventSequenceSchema.safeParse(1).success).toBe(true);
    expect(eventSequenceSchema.safeParse(MAX_EVENT_SEQUENCE + 1).success).toBe(false);
  });

  test.each([
    [undefined, "missing"],
    ["v2.018f1f34-7abc-7def-8abc-0123456789ab.1", "unsupported_version"],
    ["v01.018f1f34-7abc-7def-8abc-0123456789ab.1", "unsupported_version"],
    ["", "malformed"],
    ["v1", "malformed"],
    ["v1.018f1f34-7abc-7def-8abc-0123456789ab", "malformed"],
    ["v1.018f1f34-7abc-7def-8abc-0123456789ab.1.extra", "malformed"],
    ["v1.018f1f34-7abc-7def-8abc-0123456789ab. 1", "malformed"],
    ["v1.018f1f34-7abc-4def-8abc-0123456789ab.1", "invalid_agent_boot_id"],
    ["v1.018F1F34-7ABC-7DEF-8ABC-0123456789AB.1", "invalid_agent_boot_id"],
    [`v1.${bootId}.01`, "invalid_sequence"],
    [`v1.${bootId}.+1`, "invalid_sequence"],
    [`v1.${bootId}.-1`, "invalid_sequence"],
    [`v1.${bootId}.1.5`, "malformed"],
    [`v1.${bootId}.1e3`, "invalid_sequence"],
    [`v1.${bootId}.${MAX_EVENT_SEQUENCE + 1}`, "sequence_out_of_range"]
  ] as const)("selects deterministic invalid reason for %s", (cursor, reason) => {
    expect(parseEventCursor(cursor)).toEqual({ ok: false, reason });
  });

  test("formats and parses without opaque encoding or normalization", () => {
    const cursor = formatEventCursor(bootId, MAX_EVENT_SEQUENCE);
    expect(cursor).toBe(`v1.${bootId}.${MAX_EVENT_SEQUENCE}`);
    expect(parseEventCursor(cursor).ok).toBe(true);
  });
});
