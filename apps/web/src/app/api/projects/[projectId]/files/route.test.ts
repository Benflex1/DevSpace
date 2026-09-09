import { afterEach, expect, test, vi } from "vitest";
import { AgentResponseError } from "../../../../../server/agent-client.js";

const mocks = vi.hoisted(() => ({
  database: { getManagedProject: vi.fn() },
  agent: { listWorkspaceDirectory: vi.fn(), readWorkspaceFile: vi.fn(), saveWorkspaceFile: vi.fn() }
}));
vi.mock("../../../../../server/database.js", async (importOriginal) => ({
  ...(await importOriginal()), getProjectDatabase: () => mocks.database
}));
vi.mock("../../../../../server/agent-client.js", async (importOriginal) => ({
  ...(await importOriginal()), createAgentClient: () => mocks.agent
}));

import { GET, POST } from "./route.js";

const projectId = "018f0f00-0000-7000-8000-000000000101";
const workspaceId = "018f0f00-0000-7000-8000-000000000102";
const project = { state: "ready", primaryWorkspace: { id: workspaceId } };

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

function configure(): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEVSPACE_AUTH_MODE", "development");
  vi.stubEnv("DEVSPACE_APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("DEVSPACE_DATABASE_PATH", "/tmp/devspace-files-route.sqlite");
  vi.stubEnv("DEVSPACE_AGENT_SOCKET_PATH", "/tmp/devspace-agent.sock");
}

function context(): { params: Promise<{ projectId: string }> } {
  return { params: Promise.resolve({ projectId }) };
}

test("lists and reads files through the project primary workspace Agent", async () => {
  configure();
  mocks.database.getManagedProject.mockReturnValue(project);
  mocks.agent.listWorkspaceDirectory.mockResolvedValue({ path: "src", entries: [] });
  mocks.agent.readWorkspaceFile.mockResolvedValue({ path: "README.md", content: "hello\n", revision: "a".repeat(64), size: 6 });

  const list = await GET(new Request(`http://localhost:3000/api/projects/${projectId}/files?action=list&path=src`), context());
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual({ path: "src", entries: [] });
  expect(mocks.agent.listWorkspaceDirectory).toHaveBeenCalledWith(projectId, workspaceId, "src");

  const read = await GET(new Request(`http://localhost:3000/api/projects/${projectId}/files?action=read&path=README.md`), context());
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ path: "README.md", content: "hello\n" });
  expect(mocks.agent.readWorkspaceFile).toHaveBeenCalledWith(projectId, workspaceId, "README.md");
});

test("saves only through a CSRF-protected browser mutation", async () => {
  configure();
  mocks.database.getManagedProject.mockReturnValue(project);
  mocks.agent.saveWorkspaceFile.mockResolvedValue({ path: "README.md", revision: "b".repeat(64) });
  const request = new Request(`http://localhost:3000/api/projects/${projectId}/files`, {
    method: "POST", headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1", "content-type": "application/json" },
    body: JSON.stringify({ action: "save", path: "README.md", content: "updated\n", expectedRevision: "a".repeat(64) })
  });
  const response = await POST(request, context());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ path: "README.md", revision: "b".repeat(64) });
  expect(mocks.agent.saveWorkspaceFile).toHaveBeenCalledWith(projectId, workspaceId, "README.md", "updated\n", "a".repeat(64));

  const rejected = await POST(new Request(`http://localhost:3000/api/projects/${projectId}/files`, {
    method: "POST", headers: { origin: "http://attacker.invalid", "content-type": "application/json" }, body: JSON.stringify({
      action: "save", path: "README.md", content: "nope", expectedRevision: "a".repeat(64)
    })
  }), context());
  expect(rejected.status).toBe(403);
  expect(mocks.agent.saveWorkspaceFile).toHaveBeenCalledTimes(1);
});

test("maps a stale Agent revision to a useful conflict response", async () => {
  configure();
  mocks.database.getManagedProject.mockReturnValue(project);
  mocks.agent.saveWorkspaceFile.mockRejectedValue(new AgentResponseError("WORKSPACE_FILE_CHANGED"));
  const response = await POST(new Request(`http://localhost:3000/api/projects/${projectId}/files`, {
    method: "POST", headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({
      action: "save", path: "README.md", content: "nope", expectedRevision: "a".repeat(64)
    })
  }), context());
  expect(response.status).toBe(409);
  const body = await response.json() as { code?: string; message?: string };
  expect(body.code).toBe("WORKSPACE_FILE_CHANGED");
  expect(body.message).toContain("changed");
});

test("requires an existing ready project with its primary workspace", async () => {
  configure();
  mocks.database.getManagedProject.mockReturnValue(undefined);
  const missing = await GET(new Request(`http://localhost:3000/api/projects/${projectId}/files?action=list&path=`), context());
  expect(missing.status).toBe(404);
  expect(mocks.agent.listWorkspaceDirectory).not.toHaveBeenCalled();

  mocks.database.getManagedProject.mockReturnValue({ state: "registering", primaryWorkspace: null });
  const notReady = await GET(new Request(`http://localhost:3000/api/projects/${projectId}/files?action=list&path=`), context());
  expect(notReady.status).toBe(409);
  expect(mocks.agent.listWorkspaceDirectory).not.toHaveBeenCalled();
});
