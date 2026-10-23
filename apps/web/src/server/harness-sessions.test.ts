import { expect, test } from "vitest";
import { parseHarnessAction } from "./harness-sessions.js";

const workspaceId = "018f1f34-7000-7000-8000-000000000002";
const sessionId = "018f1f34-7000-7000-8000-000000000003";

test("accepts create-native and resume with DevSpace ids only", () => {
  expect(parseHarnessAction({ action: "create-native", workspaceId, harnessId: "codex" }))
    .toEqual({ action: "create-native", workspaceId, harnessId: "codex" });
  expect(parseHarnessAction({ action: "resume", workspaceId, sessionId }))
    .toEqual({ action: "resume", workspaceId, sessionId });
  expect(parseHarnessAction({ action: "retry-native", workspaceId, sessionId, processGeneration: 1 }))
    .toEqual({ action: "retry-native", workspaceId, sessionId, processGeneration: 1 });
  expect(parseHarnessAction({ action: "retry-native", workspaceId, sessionId, processGeneration: 0 })).toBeNull();
});

test("rejects native session ids, host paths, env, and shell commands", () => {
  expect(parseHarnessAction({ action: "create-native", workspaceId, harnessId: "codex", nativeSessionId: "thread" })).toBeNull();
  expect(parseHarnessAction({ action: "resume", workspaceId, sessionId, command: "codex resume" })).toBeNull();
  expect(parseHarnessAction({ action: "create-native", workspaceId, harnessId: "codex", env: { CODEX_HOME: "/tmp" } })).toBeNull();
  expect(parseHarnessAction({ action: "create-native", workspaceId, harnessId: "codex", hostPath: "/root" })).toBeNull();
  expect(parseHarnessAction({ action: "retry-native", workspaceId, sessionId, processId: "arbitrary" })).toBeNull();
});
