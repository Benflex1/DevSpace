import { describe, expect, test } from "vitest";
import {
  completeAgentApiV1ErrorSchema,
  f10AgentApiV1EndpointByOperation,
  f10ExecutableAgentErrorCodes,
  f10ExecutableAgentErrorRegistry,
  f10ExecutableAgentErrorSchema
} from "@devspace/contracts";

const id = "018f1f34-7000-7000-8000-000000000001";
const meta = { protocolVersion: 1, requestId: id, respondedAt: "2026-07-16T12:34:56.789Z" };
const envelope = (code: string, details: object) => ({
  meta, error: { code, message: "redacted", retryable: false, details }
});

describe("F10-only executable errors", () => {
  test("has exactly two fixed registry entries", () => {
    expect(f10ExecutableAgentErrorCodes).toEqual([
      "EVENT_CURSOR_INVALID",
      "EVENT_SNAPSHOT_REQUIRED"
    ]);
    expect(f10ExecutableAgentErrorRegistry.EVENT_CURSOR_INVALID).toMatchObject({
      statuses: [400], retryable: false
    });
    expect(f10ExecutableAgentErrorRegistry.EVENT_SNAPSHOT_REQUIRED).toMatchObject({
      statuses: [409], retryable: false
    });
  });

  test.each([
    envelope("EVENT_CURSOR_INVALID", { reason: "missing" }),
    envelope("EVENT_CURSOR_INVALID", { reason: "sequence_out_of_range" }),
    envelope("EVENT_SNAPSHOT_REQUIRED", {
      reason: "boot_mismatch", currentAgentBootId: id, snapshotPath: "/v1/snapshot"
    }),
    envelope("EVENT_SNAPSHOT_REQUIRED", {
      reason: "cursor_expired", currentAgentBootId: id, snapshotPath: "/v1/snapshot"
    }),
    envelope("EVENT_SNAPSHOT_REQUIRED", {
      reason: "history_unavailable", currentAgentBootId: id, snapshotPath: "/v1/snapshot"
    })
  ])("accepts exact details for $error.code", (value) => {
    expect(f10ExecutableAgentErrorSchema.safeParse(value).success).toBe(true);
    expect(completeAgentApiV1ErrorSchema.safeParse(value).success).toBe(true);
  });

  test("rejects unknown details, wrong snapshot path, and wrong retryability", () => {
    expect(f10ExecutableAgentErrorSchema.safeParse(
      envelope("EVENT_CURSOR_INVALID", { reason: "expired" })
    ).success).toBe(false);
    expect(f10ExecutableAgentErrorSchema.safeParse(
      envelope("EVENT_SNAPSHOT_REQUIRED", {
        reason: "boot_mismatch", currentAgentBootId: id, snapshotPath: "/snapshot"
      })
    ).success).toBe(false);
    expect(f10ExecutableAgentErrorSchema.safeParse({
      ...envelope("EVENT_CURSOR_INVALID", { reason: "missing" }),
      error: {
        ...envelope("EVENT_CURSOR_INVALID", { reason: "missing" }).error,
        retryable: true
      }
    }).success).toBe(false);
  });

  test("keeps exact route applicability separation", () => {
    const snapshot = f10AgentApiV1EndpointByOperation["snapshot.get"];
    const stream = f10AgentApiV1EndpointByOperation["event.stream"];
    const cursorError = envelope("EVENT_CURSOR_INVALID", { reason: "missing" });
    const snapshotRequired = envelope("EVENT_SNAPSHOT_REQUIRED", {
      reason: "history_unavailable", currentAgentBootId: id, snapshotPath: "/v1/snapshot"
    });
    expect(snapshot.errorSchema.safeParse(cursorError).success).toBe(false);
    expect(snapshot.errorSchema.safeParse(snapshotRequired).success).toBe(false);
    expect(stream.errorSchema.safeParse(cursorError).success).toBe(true);
    expect(stream.errorSchema.safeParse(snapshotRequired).success).toBe(true);
  });
});
