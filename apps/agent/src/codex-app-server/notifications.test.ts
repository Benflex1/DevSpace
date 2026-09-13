import { describe, expect, test } from "vitest";
import { CODEX_NOTIFICATION_CATEGORY_REGISTRY, validateCodexNotification } from "./notifications.js";

describe("Codex notification policy", () => {
  test("accepts additive fields without exposing them to semantic handlers", () => {
    expect(validateCodexNotification({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "idle" }, additiveFutureField: { private: true } }
    })).toBe("validated-and-ignored");
  });

  test("classifies known provider lifecycle and interaction-resolution notifications", () => {
    expect(CODEX_NOTIFICATION_CATEGORY_REGISTRY["serverRequest/resolved"]).toBe("projected-and-handled");
    expect(validateCodexNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "native-private-request" }
    })).toBe("projected-and-handled");
  });

  test("does not accept unknown notifications as safe", () => {
    expect(validateCodexNotification({ method: "future/blocking/request", params: {} })).toBeNull();
  });
});
