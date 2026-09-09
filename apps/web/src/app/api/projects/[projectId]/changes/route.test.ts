import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  database: { getManagedProject: vi.fn() }, agent: {}, inspectProjectGit: vi.fn(), mutateProjectGit: vi.fn()
}));
vi.mock("../../../../../server/database.js", async (importOriginal) => ({ ...(await importOriginal()), getProjectDatabase: () => mocks.database }));
vi.mock("../../../../../server/agent-client.js", async (importOriginal) => ({ ...(await importOriginal()), createAgentClient: () => mocks.agent }));
vi.mock("../../../../../server/project-git.js", async (importOriginal) => ({
  ...(await importOriginal()), inspectProjectGit: mocks.inspectProjectGit, mutateProjectGit: mocks.mutateProjectGit
}));

import { GET, POST } from "./route.js";

const projectId = "018f0f00-0000-7000-8000-000000000101";
const workspaceId = "018f0f00-0000-7000-8000-000000000102";
const status = {
  projectId, workspaceId, branchName: "main", headCommit: "a".repeat(40), dirty: true, aheadCount: 1, behindCount: 0,
  files: [], identity: { name: "Dev", email: "dev@example.invalid" }
};

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
function configure(): void {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("DEVSPACE_AUTH_MODE", "development");
  vi.stubEnv("DEVSPACE_APP_ORIGIN", "http://localhost:3000"); vi.stubEnv("DEVSPACE_DATABASE_PATH", "/tmp/devspace-git-route.sqlite");
  vi.stubEnv("DEVSPACE_AGENT_SOCKET_PATH", "/tmp/devspace-agent.sock");
}
function context(): { params: Promise<{ projectId: string }> } { return { params: Promise.resolve({ projectId }) }; }

test("reads status and preserves the structured Changes payload", async () => {
  configure(); mocks.inspectProjectGit.mockResolvedValue(status);
  const response = await GET(new Request(`http://localhost:3000/api/projects/${projectId}/changes`), context());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(status);
  expect(mocks.inspectProjectGit).toHaveBeenCalledWith(projectId, mocks.database, mocks.agent);
});

test("accepts only CSRF-protected stage actions with a workspace-relative path", async () => {
  configure(); mocks.mutateProjectGit.mockResolvedValue({ operationId: "018f0f00-0000-7000-8000-000000000103", state: "succeeded", status });
  const response = await POST(new Request(`http://localhost:3000/api/projects/${projectId}/changes`, {
    method: "POST", headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1", "content-type": "application/json" },
    body: JSON.stringify({ action: "stage", path: "src/index.ts" })
  }), context());
  expect(response.status).toBe(200);
  expect(mocks.mutateProjectGit).toHaveBeenCalledWith(projectId, { action: "stage", path: "src/index.ts" }, expect.any(Object));

  const invalid = await POST(new Request(`http://localhost:3000/api/projects/${projectId}/changes`, {
    method: "POST", headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1", "content-type": "application/json" },
    body: JSON.stringify({ action: "stage", path: "../outside", command: "git add ." })
  }), context());
  expect(invalid.status).toBe(422);
  expect(mocks.mutateProjectGit).toHaveBeenCalledTimes(1);

  const csrf = await POST(new Request(`http://localhost:3000/api/projects/${projectId}/changes`, {
    method: "POST", headers: { origin: "http://attacker.invalid", "content-type": "application/json" },
    body: JSON.stringify({ action: "stage", path: "src/index.ts" })
  }), context());
  expect(csrf.status).toBe(403);
});

test("accepts a bounded commit identity without exposing repository config writes", async () => {
  configure(); mocks.mutateProjectGit.mockResolvedValue({ operationId: "018f0f00-0000-7000-8000-000000000104", state: "succeeded", status: { ...status, dirty: false } });
  const response = await POST(new Request(`http://localhost:3000/api/projects/${projectId}/changes`, {
    method: "POST", headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1", "content-type": "application/json" },
    body: JSON.stringify({ action: "commit", message: "Save work", userName: "Explicit Name", userEmail: "explicit@example.invalid" })
  }), context());
  expect(response.status).toBe(200);
  expect(mocks.mutateProjectGit.mock.calls[0]?.[1]).toEqual({ action: "commit", message: "Save work", userName: "Explicit Name", userEmail: "explicit@example.invalid" });
});
