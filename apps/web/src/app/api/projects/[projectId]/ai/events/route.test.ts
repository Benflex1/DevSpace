import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthenticationError } from "../../../../../../server/auth.js";

const ids = {
  projectId: "018f0f00-0000-7000-8000-000000000001",
  workspaceId: "018f0f00-0000-7000-8000-000000000002",
  sessionId: "018f0f00-0000-7000-8000-000000000003"
};
const mocks = vi.hoisted(() => ({
  agentStream: vi.fn(async function* (_sessionId: string, _afterSequence: number, _options?: { signal?: AbortSignal }) {
    await Promise.resolve();
    yield { schemaVersion: "devspace.ai-stream/v1" as const, frameType: "stream.synchronized" as const, sessionId: ids.sessionId, throughSequence: 0,
      processGeneration: 1, pendingInteractionIds: [] };
  }),
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

  test("aborts a pending Agent read before returning the iterator on browser cancellation", async () => {
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
    let abortObserved = false;
    let cleanupCount = 0;
    mocks.agentStream.mockImplementationOnce(async function* (
      _sessionId: string,
      _afterSequence: number,
      options?: { signal?: AbortSignal }
    ) {
      try {
        yielded += 1;
        yield { schemaVersion: "devspace.ai-stream/v1" as const, frameType: "stream.synchronized" as const, sessionId: ids.sessionId, throughSequence: 0,
          processGeneration: 1, pendingInteractionIds: [] };
        await new Promise<void>((resolve) => {
          if (options?.signal === undefined) return resolve();
          if (options.signal.aborted) {
            abortObserved = true;
            return resolve();
          }
          options.signal.addEventListener("abort", () => {
            abortObserved = true;
            resolve();
          }, { once: true });
        });
        yielded += 1;
      } finally {
        cleanupCount += 1;
      }
    });

    const response = await GET(request(0), context);
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(yielded).toBe(1);
    await reader.cancel();
    expect(abortObserved).toBe(true);
    expect(cleanupCount).toBe(1);
    expect(yielded).toBe(2);
  });

  test("incoming Request abort interrupts a pending Agent read without producing a stream error", async () => {
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
    let abortObserved = false;
    let cleanupCount = 0;
    mocks.agentStream.mockImplementationOnce(async function* (
      _sessionId: string,
      _afterSequence: number,
      options?: { signal?: AbortSignal }
    ) {
      try {
        yield { schemaVersion: "devspace.ai-stream/v1" as const, frameType: "stream.synchronized" as const, sessionId: ids.sessionId, throughSequence: 0,
          processGeneration: 1, pendingInteractionIds: [] };
        await new Promise<void>((resolve) => {
          options!.signal!.addEventListener("abort", () => {
            abortObserved = true;
            resolve();
          }, { once: true });
        });
      } finally {
        cleanupCount += 1;
      }
    });
    const incoming = new AbortController();
    const routeRequest = new Request(
      `http://localhost/api/projects/${ids.projectId}/ai/events?workspaceId=${ids.workspaceId}&sessionId=${ids.sessionId}&afterSequence=0`,
      { signal: incoming.signal }
    );
    const response = await GET(routeRequest, context);
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    const pending = reader.read();

    incoming.abort();

    await expect(Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error("incoming-abort-did-not-settle")), 100))
    ])).resolves.toEqual({ done: true, value: undefined });
    expect(abortObserved).toBe(true);
    expect(cleanupCount).toBe(1);
  });

  test("browser cancellation racing a valid frame does not enqueue that frame", async () => {
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
    let secondFrameProduced = false;
    mocks.agentStream.mockImplementationOnce(async function* (
      _sessionId: string,
      _afterSequence: number,
      options?: { signal?: AbortSignal }
    ) {
      yield { schemaVersion: "devspace.ai-stream/v1" as const, frameType: "stream.synchronized" as const, sessionId: ids.sessionId, throughSequence: 0,
        processGeneration: 1, pendingInteractionIds: [] };
      await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      secondFrameProduced = true;
      yield { schemaVersion: "devspace.ai-stream/v1" as const, frameType: "stream.synchronized" as const, sessionId: ids.sessionId, throughSequence: 1,
        processGeneration: 1, pendingInteractionIds: [] };
    });
    const response = await GET(request(0), context);
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await reader.cancel();

    expect(secondFrameProduced).toBe(true);
  });
});
