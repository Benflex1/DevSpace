import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  database: { getManagedProject: vi.fn() }, agent: { diffGit: vi.fn() }, primaryWorkspaceId: vi.fn(() => "018f0f00-0000-7000-8000-000000000102")
}));
vi.mock("../../../../../../server/database.js", async (importOriginal) => ({ ...(await importOriginal()), getProjectDatabase: () => mocks.database }));
vi.mock("../../../../../../server/agent-client.js", async (importOriginal) => ({ ...(await importOriginal()), createAgentClient: () => mocks.agent }));
vi.mock("../../../../../../server/project-git.js", async (importOriginal) => ({ ...(await importOriginal()), primaryWorkspaceId: mocks.primaryWorkspaceId }));

import { GET } from "./route.js";

const projectId = "018f0f00-0000-7000-8000-000000000101";
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
function configure(): void {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("DEVSPACE_AUTH_MODE", "development");
  vi.stubEnv("DEVSPACE_APP_ORIGIN", "http://localhost:3000"); vi.stubEnv("DEVSPACE_DATABASE_PATH", "/tmp/devspace-git-diff-route.sqlite");
  vi.stubEnv("DEVSPACE_AGENT_SOCKET_PATH", "/tmp/devspace-agent.sock");
}

test("loads only a bounded staged or unstaged diff through the Agent", async () => {
  configure(); mocks.agent.diffGit.mockResolvedValue({ available: true, projectId, workspaceId: "018f0f00-0000-7000-8000-000000000102", path: "README.md", oldPath: null, kind: "staged", oldContent: "old\n", newContent: "new\n" });
  const response = await GET(new Request(`http://localhost:3000/api/projects/${projectId}/changes/diff?path=README.md&kind=staged`), { params: Promise.resolve({ projectId }) });
  expect(response.status).toBe(200);
  expect(mocks.agent.diffGit).toHaveBeenCalledWith(projectId, "018f0f00-0000-7000-8000-000000000102", "README.md", "staged");
});

test("rejects invalid path and diff kind before contacting the Agent", async () => {
  configure();
  const response = await GET(new Request(`http://localhost:3000/api/projects/${projectId}/changes/diff?path=../outside&kind=staged`), { params: Promise.resolve({ projectId }) });
  expect(response.status).toBe(422);
  expect(mocks.agent.diffGit).not.toHaveBeenCalled();
});
