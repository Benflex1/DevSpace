import { expect, test, vi } from "vitest";
import { ProjectSetupConflictError } from "./database.js";
import { parseHarnessAction, readNativeCodexHistory } from "./harness-sessions.js";

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

test("Native Codex history authorization derives process identity from the exact database session", async () => {
  const projectId = "018f1f34-7000-7000-8000-000000000301";
  const processId = "018f1f34-7000-7000-8000-000000000302";
  const processGeneration = 4;
  const result = { messages: [], olderCursor: null, olderHistoryTruncated: false, snapshot: "live", available: true };
  const getIdentity = vi.fn(() => ({ id: sessionId, workspaceId, processId, processGeneration, state: "active" }));
  const readAgent = vi.fn().mockResolvedValue(result);

  await expect(readNativeCodexHistory({ projectId, actor: "owner@example.test", workspaceId, sessionId, cursor: null }, {
    database: { getNativeHarnessHistoryIdentity: getIdentity } as never,
    agent: { readNativeCodexHistory: readAgent } as never
  })).resolves.toBe(result);

  expect(getIdentity).toHaveBeenCalledWith(projectId, workspaceId, sessionId);
  expect(readAgent).toHaveBeenCalledWith({ actorIdentity: "owner@example.test", projectId, sessionId, workspaceId,
    processId, processGeneration, cursor: null });
});

test("Native Codex history refuses unknown or non-live/non-settled session rows before the Agent call", async () => {
  const database = { getNativeHarnessHistoryIdentity: vi.fn(() => undefined) };
  const agent = { readNativeCodexHistory: vi.fn() };
  await expect(readNativeCodexHistory({
    projectId: "018f1f34-7000-7000-8000-000000000301", actor: "owner@example.test", workspaceId, sessionId, cursor: null
  }, { database: database as never, agent: agent as never })).rejects.toBeInstanceOf(ProjectSetupConflictError);
  expect(agent.readNativeCodexHistory).not.toHaveBeenCalled();
});
