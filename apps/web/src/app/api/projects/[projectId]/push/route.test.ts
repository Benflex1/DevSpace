import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), confirm: vi.fn(), latest: vi.fn(), database: {}, agent: {} }));
vi.mock("../../../../../server/project-push.js", async (importOriginal) => {
  const original = Object.assign({}, await importOriginal<typeof import("../../../../../server/project-push.js")>());
  return { ...original, prepareProjectPush: mocks.prepare, confirmProjectPush: mocks.confirm, getLatestProjectPushStatus: mocks.latest };
});
vi.mock("../../../../../server/database.js", async (importOriginal) => {
  const original = Object.assign({}, await importOriginal<typeof import("../../../../../server/database.js")>());
  return { ...original, getProjectDatabase: () => mocks.database };
});
vi.mock("../../../../../server/agent-client.js", async (importOriginal) => {
  const original = Object.assign({}, await importOriginal<typeof import("../../../../../server/agent-client.js")>());
  return { ...original, createAgentClient: () => mocks.agent };
});

import { GET, POST } from "./route.js";

const projectId = "018f0f00-0000-7000-8000-000000000101";
const operationId = "018f0f00-0000-7000-8000-000000000102";
const prepared = {
  operationId, state: "prepared" as const, repository: "owner-org/private-repo", branchName: "feature/push",
  commitOid: "a".repeat(40), dirty: false, aheadCount: 1, behindCount: 0, errorCode: null, message: null
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

function configure(): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEVSPACE_AUTH_MODE", "development");
  vi.stubEnv("DEVSPACE_APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("DEVSPACE_DATABASE_PATH", "/tmp/devspace-push-route.sqlite");
  vi.stubEnv("DEVSPACE_AGENT_SOCKET_PATH", "/tmp/devspace-agent.sock");
}

function request(body: unknown, csrf = true): Request {
  return new Request(`http://localhost:3000/api/projects/${projectId}/push`, {
    method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", ...(csrf ? { "x-devspace-csrf": "1" } : {}) },
    body: JSON.stringify(body)
  });
}

const context = { params: Promise.resolve({ projectId }) };

test("prepares a push from an action-only browser request", async () => {
  configure();
  mocks.prepare.mockResolvedValue(prepared);
  const response = await POST(request({ action: "prepare" }), context);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(prepared);
  expect(mocks.prepare).toHaveBeenCalledWith(projectId, "local-dev@example.invalid", { database: mocks.database, agent: mocks.agent });
});

test("confirmation accepts only the opaque operation ID and preserves CSRF", async () => {
  configure();
  mocks.confirm.mockResolvedValue({ ...prepared, state: "succeeded" });
  const response = await POST(request({ action: "confirm", operationId }), context);
  expect(response.status).toBe(200);
  expect(mocks.confirm).toHaveBeenCalledWith(projectId, "local-dev@example.invalid", operationId, { database: mocks.database, agent: mocks.agent });

  expect((await POST(request({ action: "confirm", operationId, commitOid: "b".repeat(40) }), context)).status).toBe(400);
  expect((await POST(request({ action: "prepare" }, false), context)).status).toBe(403);
});

test("returns the latest durable push intent for restart reconciliation without dispatching Agent work", async () => {
  configure();
  mocks.latest.mockReturnValue({ ...prepared, state: "failed", errorCode: "GITHUB_PUSH_OUTCOME_UNCERTAIN",
    message: "The push outcome is uncertain." });
  const response = await GET(new Request(`http://localhost:3000/api/projects/${projectId}/push`), context);
  expect(response.status).toBe(200);
  const body: unknown = await response.json() as unknown;
  expect(body).toEqual({ push: { ...prepared, state: "failed", errorCode: "GITHUB_PUSH_OUTCOME_UNCERTAIN", message: "The push outcome is uncertain." } });
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.confirm).not.toHaveBeenCalled();
});
