import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthenticationError } from "../../../../../../server/auth.js";

const ids = {
  projectId: "018f0f00-0000-7000-8000-000000000001",
  workspaceId: "018f0f00-0000-7000-8000-000000000002",
  sessionId: "018f0f00-0000-7000-8000-000000000003"
};
const mocks = vi.hoisted(() => ({
  agentStream: vi.fn(async function* () { await Promise.resolve(); yield { frameType: "stream.synchronized", sessionId: ids.sessionId, throughSequence: 0 }; }),
  getSession: vi.fn(),
  getConfig: vi.fn(() => ({ databasePath: "test.sqlite", agentSocketPath: "test.sock", auth: { mode: "development", actor: "owner@example.invalid" } })),
  authenticate: vi.fn(() => Promise.resolve({ identity: "owner@example.invalid" }))
}));

vi.mock("../../../../../../server/config.js", () => ({ readWebRuntimeConfig: mocks.getConfig }));
vi.mock("../../../../../../server/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../../../server/auth.js")>("../../../../../../server/auth.js");
  return { ...actual, authenticateHeaders: mocks.authenticate };
});
vi.mock("../../../../../../server/database.js", () => ({ getProjectDatabase: () => ({ getAiSession: mocks.getSession }) }));
vi.mock("../../../../../../server/agent-client.js", () => ({ createAgentClient: () => ({ streamAiEvents: mocks.agentStream }) }));

import { GET } from "./route.js";

const request = (afterSequence: number) => new Request(
  `http://localhost/api/projects/${ids.projectId}/ai/events?workspaceId=${ids.workspaceId}&sessionId=${ids.sessionId}&afterSequence=${afterSequence}`
);
const context = { params: Promise.resolve({ projectId: ids.projectId }) };

afterEach(() => { mocks.getSession.mockReset(); mocks.agentStream.mockClear(); });

describe("AI event stream HTTP preflight", () => {
  test("returns the bounded conflict before HTTP 200 for a nonexistent session", async () => {
    mocks.getSession.mockReturnValue(null);

    const response = await GET(request(0), context);

    expect(response.status).toBe(409);
    expect(mocks.agentStream).not.toHaveBeenCalled();
  });

  test("returns the bounded history-gap conflict before HTTP 200", async () => {
    mocks.getSession.mockReturnValue({
      session: { id: ids.sessionId, workspaceId: ids.workspaceId, historyStartSequence: 12, lastSequence: 20 },
      turns: [], events: [], interactions: []
    });

    const response = await GET(request(0), context);

    expect(response.status).toBe(409);
    expect(mocks.agentStream).not.toHaveBeenCalled();
  });

  test("uses the same bounded conflict for a foreign project binding", async () => {
    mocks.getSession.mockReturnValue({
      session: { id: ids.sessionId, projectId: "018f0f00-0000-7000-8000-000000000099", workspaceId: ids.workspaceId, historyStartSequence: 1, lastSequence: 0 },
      turns: [], events: [], interactions: []
    });

    const response = await GET(request(0), context);

    expect(response.status).toBe(409);
    expect(await response.text()).toBe("The AI session is no longer available.");
    expect(mocks.agentStream).not.toHaveBeenCalled();
  });

  test("keeps authentication and malformed-query status decisions before stream creation", async () => {
    mocks.authenticate.mockRejectedValueOnce(new AuthenticationError());
    await expect(GET(request(0), context)).resolves.toMatchObject({ status: 403 });
    mocks.authenticate.mockResolvedValue({ identity: "owner@example.invalid" });

    const malformed = new Request(`http://localhost/api/projects/${ids.projectId}/ai/events?workspaceId=${ids.workspaceId}&sessionId=not-a-uuid&afterSequence=0`);
    await expect(GET(malformed, context)).resolves.toMatchObject({ status: 422 });
    expect(mocks.agentStream).not.toHaveBeenCalled();
  });

  test("pulls one Agent frame at a time and cancellation returns the iterator", async () => {
    mocks.getSession.mockReturnValue({
      session: {
        id: ids.sessionId,
        projectId: ids.projectId,
        workspaceId: ids.workspaceId,
        historyStartSequence: 1,
        lastSequence: 0
      },
      turns: [], events: [], interactions: []
    });
    let yielded = 0;
    let released = false;
    mocks.agentStream.mockImplementationOnce(async function* () {
      await Promise.resolve();
      try {
        yielded += 1;
        yield { frameType: "stream.synchronized", sessionId: ids.sessionId, throughSequence: 0 };
        yielded += 1;
        yield { frameType: "stream.synchronized", sessionId: ids.sessionId, throughSequence: 0 };
        yielded += 1;
        yield { frameType: "stream.synchronized", sessionId: ids.sessionId, throughSequence: 0 };
      } finally {
        released = true;
      }
    });

    const response = await GET(request(0), context);
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(yielded).toBe(2);
    await reader.cancel();
    expect(released).toBe(true);
  });
});
