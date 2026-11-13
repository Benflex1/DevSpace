import { afterEach, expect, test, vi } from "vitest";
import { AuthenticationError } from "../../../../../../../server/auth.js";
import { ProjectSetupConflictError } from "../../../../../../../server/database.js";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), read: vi.fn() }));
vi.mock("../../../../../../../server/auth.js", async (importOriginal) => {
  const original = Object.assign({}, await importOriginal());
  return { ...original, authenticateHeaders: mocks.authenticate };
});
vi.mock("../../../../../../../server/config.js", () => ({ readWebRuntimeConfig: () => ({
  auth: { mode: "development", actor: "owner@example.test" },
  databasePath: "/tmp/history-route-test.sqlite", agentSocketPath: "/tmp/history-route-agent.sock"
}) }));
vi.mock("../../../../../../../server/database.js", async (importOriginal) => {
  const original = Object.assign({}, await importOriginal());
  return { ...original, getProjectDatabase: () => ({}) };
});
vi.mock("../../../../../../../server/agent-client.js", async (importOriginal) => {
  const original = Object.assign({}, await importOriginal());
  return { ...original, createAgentClient: () => ({}) };
});
vi.mock("../../../../../../../server/harness-sessions.js", async (importOriginal) => {
  const original = Object.assign({}, await importOriginal());
  return { ...original, readNativeCodexHistory: mocks.read };
});

import { GET } from "./route.js";

const projectId = "018f1f34-7000-7000-8000-000000000301";
const workspaceId = "018f1f34-7000-7000-8000-000000000302";
const sessionId = "018f1f34-7000-7000-8000-000000000303";
const actor = "owner@example.test";
const context = { params: Promise.resolve({ projectId, sessionId }) };
const page = { messages: [], olderCursor: null, olderHistoryTruncated: false, snapshot: "live", available: true } as const;

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function request(url = `http://localhost/api/projects/${projectId}/harness/${sessionId}/history?workspaceId=${workspaceId}`) {
  return new Request(url, { headers: { accept: "application/json" } });
}

test("history route derives the actor and forwards exact project, workspace, and Native session IDs", async () => {
  mocks.authenticate.mockResolvedValue({ identity: actor });
  mocks.read.mockResolvedValue(page);

  const response = await GET(request(`http://localhost/api/projects/${projectId}/harness/${sessionId}/history?workspaceId=${workspaceId}&cursor=opaque`), context);

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(page);
  expect(mocks.read).toHaveBeenCalledWith({ projectId, actor, workspaceId, sessionId, cursor: "opaque" }, {
    database: {}, agent: {}
  });
});

test("history route rejects browser paths, native thread IDs, unknown query fields, and duplicate workspace IDs", async () => {
  mocks.authenticate.mockResolvedValue({ identity: actor });
  const invalidQueries = [
    `workspaceId=${workspaceId}&hostPath=%2Froot%2F.codex`,
    `workspaceId=${workspaceId}&nativeSessionId=provider-thread`,
    `workspaceId=${workspaceId}&workspaceId=${workspaceId}`
  ];
  for (const query of invalidQueries) {
    expect((await GET(request(`http://localhost/api/projects/${projectId}/harness/${sessionId}/history?${query}`), context)).status).toBe(422);
  }
  expect(mocks.read).not.toHaveBeenCalled();
});

test("history route requires authentication and fails closed when the project/workspace/session binding is absent", async () => {
  mocks.authenticate.mockRejectedValueOnce(new AuthenticationError());
  expect((await GET(request(), context)).status).toBe(403);
  mocks.authenticate.mockResolvedValue({ identity: actor });
  mocks.read.mockRejectedValue(new ProjectSetupConflictError("missing exact resource"));
  expect((await GET(request(), context)).status).toBe(404);
  expect(mocks.read).toHaveBeenCalledWith({ projectId, actor, workspaceId, sessionId, cursor: null }, {
    database: {}, agent: {}
  });
});
