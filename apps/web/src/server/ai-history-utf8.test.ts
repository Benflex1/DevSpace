import { describe, expect, test } from "vitest";
import { decodeUtf8Prefix, truncateUtf8 } from "./ai-history.js";

describe("shared UTF-8 prefix bounds", () => {
  test.each([
    ["éx", 2, "é"],
    ["😀x", 4, "😀"],
    ["éx", 1, ""],
    ["😀x", 3, ""],
    ["abcdef", 3, "abc"],
    ["Aé😀z", 7, "Aé😀"],
  ])("keeps the longest valid prefix for %j at %d bytes", (value, limit, expected) => {
    expect(truncateUtf8(value, limit)).toEqual({ value: expected, truncated: true });
    expect(decodeUtf8Prefix(new TextEncoder().encode(value), limit)).toEqual({ value: expected, truncated: true });
  });

  test("keeps an exact ASCII boundary unmarked", () => {
    expect(truncateUtf8("abc", 3)).toEqual({ value: "abc", truncated: false });
    expect(decodeUtf8Prefix(new TextEncoder().encode("abc"), 3)).toEqual({ value: "abc", truncated: false });
  });

  test("fails safely for malformed legacy byte sequences without replacement characters", () => {
    expect(decodeUtf8Prefix(new Uint8Array([0xc3, 0x28]), 2)).toEqual({ value: "", truncated: true });
    expect(decodeUtf8Prefix(new Uint8Array([0xf0, 0x9f, 0x98]), 3)).toEqual({ value: "", truncated: true });
  });
});
