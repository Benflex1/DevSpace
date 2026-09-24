import { expect, test } from "vitest";
import { parseHarnessAction } from "../server/harness-sessions.js";

test("resume posts only workspace and session ids", () => {
  const workspaceId = "018f1f34-7000-7000-8000-000000000002";
  const sessionId = "018f1f34-7000-7000-8000-000000000003";
  expect(parseHarnessAction({ action: "resume", workspaceId, sessionId })).toEqual({
    action: "resume", workspaceId, sessionId
  });
  expect(parseHarnessAction({ action: "create-native", workspaceId, harnessId: "codex" })).toEqual({
    action: "create-native", workspaceId, harnessId: "codex"
  });
});
