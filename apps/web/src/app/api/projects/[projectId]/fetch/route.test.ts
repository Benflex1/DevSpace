import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchProject: vi.fn(), database: {}, agent: {} }));
vi.mock("../../../../../server/project-fetch.js", async (importOriginal) => {
  const original = Object.assign({}, await importOriginal());
  return { ...original, fetchProject: mocks.fetchProject };
});
vi.mock("../../../../../server/database.js", async (importOriginal) => {
  const original = Object.assign({}, await importOriginal());
  return { ...original, getProjectDatabase: () => mocks.database };
});
vi.mock("../../../../../server/agent-client.js", async (importOriginal) => {
  const original = Object.assign({}, await importOriginal());
  return { ...original, createAgentClient: () => mocks.agent };
});

import { POST } from "./route.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

function configure(): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEVSPACE_AUTH_MODE", "development");
  vi.stubEnv("DEVSPACE_APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("DEVSPACE_DATABASE_PATH", "/tmp/devspace-fetch-route.sqlite");
  vi.stubEnv("DEVSPACE_AGENT_SOCKET_PATH", "/tmp/devspace-agent.sock");
}

test("accepts an authenticated CSRF-protected later fetch action", async () => {
  configure();
  mocks.fetchProject.mockResolvedValue({ operationId: "018f0f00-0000-7000-8000-000000000001", state: "succeeded" });
  const response = await POST(new Request("http://localhost:3000/api/projects/018f0f00-0000-7000-8000-000000000099/fetch", {
    method: "POST", headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1" }
  }), { params: Promise.resolve({ projectId: "018f0f00-0000-7000-8000-000000000099" }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ operationId: "018f0f00-0000-7000-8000-000000000001", state: "succeeded" });
  expect(mocks.fetchProject).toHaveBeenCalledWith("018f0f00-0000-7000-8000-000000000099", "local-dev@example.invalid", {
    database: mocks.database, agent: mocks.agent
  });
});

test("rejects a later fetch without the Web CSRF proof", async () => {
  configure();
  const response = await POST(new Request("http://localhost:3000/api/projects/018f0f00-0000-7000-8000-000000000099/fetch", {
    method: "POST", headers: { origin: "http://attacker.invalid" }
  }), { params: Promise.resolve({ projectId: "018f0f00-0000-7000-8000-000000000099" }) });
  expect(response.status).toBe(403);
  expect(mocks.fetchProject).not.toHaveBeenCalled();
});
