import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  resume: vi.fn(),
  save: vi.fn(),
  list: vi.fn(),
  listDefinitions: vi.fn()
}));
vi.mock("../../../../../server/harness-sessions.js", async (importOriginal) => {
  const original = Object.assign({}, await importOriginal());
  return {
    ...original,
    createNativeHarnessSession: mocks.create,
    resumeNativeHarnessSession: mocks.resume,
    listProjectedHarnessSessions: mocks.list
  };
});
vi.mock("../../../../../server/harness-definitions.js", async (importOriginal) => {
  const original = Object.assign({}, await importOriginal());
  return { ...original, listCustomHarnessDefinitions: mocks.listDefinitions, saveCustomHarnessDefinition: mocks.save };
});
vi.mock("../../../../../server/database.js", async (importOriginal) => {
  const original = Object.assign({}, await importOriginal());
  return { ...original, getProjectDatabase: () => ({}) };
});
vi.mock("../../../../../server/agent-client.js", async (importOriginal) => {
  const original = Object.assign({}, await importOriginal());
  return { ...original, createAgentClient: () => ({}) };
});

import { POST } from "./route.js";

const projectId = "018f1f34-7000-7000-8000-000000000001";
const workspaceId = "018f1f34-7000-7000-8000-000000000002";
const sessionId = "018f1f34-7000-7000-8000-000000000003";
const context = { params: Promise.resolve({ projectId }) };
const definition = {
  id: "my-agent", displayName: "My Agent", origin: "custom",
  launch: { executable: "my-agent", args: [] },
  resume: { executable: "my-agent", args: ["--resume", "{sessionId}"] },
  environment: {}, privateState: { kind: "none" }
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function configure(): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEVSPACE_AUTH_MODE", "development");
  vi.stubEnv("DEVSPACE_APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("DEVSPACE_DATABASE_PATH", "/tmp/devspace-harness-route.sqlite");
  vi.stubEnv("DEVSPACE_AGENT_SOCKET_PATH", "/tmp/devspace-agent.sock");
}

function request(body: unknown, origin = "http://localhost:3000", csrf = true): Request {
  return new Request(`http://localhost:3000/api/projects/${projectId}/harness`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(csrf ? { "x-devspace-csrf": "1" } : {})
    },
    body: JSON.stringify(body)
  });
}

test("native harness mutations fail closed on the wrong origin", async () => {
  configure();
  const bodies = [
    { action: "create-native", workspaceId, harnessId: "codex" },
    { action: "resume", workspaceId, sessionId },
    { action: "save-definition", definition }
  ];
  for (const body of bodies) {
    expect((await POST(request(body, "http://evil.example"), context)).status).toBe(403);
    expect((await POST(request(body, "http://localhost:3000", false), context)).status).toBe(403);
  }
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.resume).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});

test("native harness mutations succeed with the app origin and CSRF marker", async () => {
  configure();
  const admissionLines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line) => { admissionLines.push(String(line)); });
  mocks.create.mockResolvedValue({ sessionId, terminalId: sessionId, workspaceId, harnessId: "codex" });
  mocks.resume.mockResolvedValue({ sessionId, terminalId: sessionId, workspaceId, harnessId: "codex" });
  mocks.save.mockReturnValue(definition);
  expect((await POST(request({ action: "create-native", workspaceId, harnessId: "codex" }), context)).status).toBe(200);
  expect((await POST(request({ action: "resume", workspaceId, sessionId }), context)).status).toBe(200);
  expect((await POST(request({ action: "save-definition", definition }), context)).status).toBe(200);
  expect(mocks.create).toHaveBeenCalledOnce();
  expect(mocks.resume).toHaveBeenCalledOnce();
  expect(mocks.save).toHaveBeenCalledWith({}, definition);
  const admissionRecords = admissionLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(admissionRecords).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: "web.harness.admission.completed", operationName: "native-harness.start",
      sessionId, terminalId: sessionId, workspaceId, harnessId: "codex", phase: "web-request",
      outcome: "success" }),
    expect.objectContaining({ event: "web.harness.admission.completed", operationName: "native-harness.resume",
      sessionId, workspaceId, phase: "web-request", outcome: "success" })
  ]));
  for (const operationName of ["native-harness.start", "native-harness.resume"]) {
    const durationMs = admissionRecords.find((record) => record.operationName === operationName)?.durationMs;
    expect(typeof durationMs).toBe("number");
    if (typeof durationMs === "number") {
      expect(Number.isFinite(durationMs)).toBe(true);
      expect(durationMs).toBeGreaterThanOrEqual(0);
    }
  }
});
