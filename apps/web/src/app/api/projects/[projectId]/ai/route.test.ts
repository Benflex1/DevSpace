import { afterEach, describe, expect, test, vi } from "vitest";
import { NextResponse } from "next/server";
import { AI_SESSION_RESPONSE_MAX_BYTES, serializedBytes } from "../../../../../server/ai-history.js";

const ids = {
  projectId: "018f0f00-0000-7000-8000-000000000101",
  workspaceId: "018f0f00-0000-7000-8000-000000000102",
  sessionId: "018f0f00-0000-7000-8000-000000000103"
};
const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getAgent: vi.fn(),
  inspectProvider: vi.fn(),
  restart: vi.fn(),
  send: vi.fn(),
  respondApproval: vi.fn(),
  respondInput: vi.fn(),
  getConfig: vi.fn(() => ({ databasePath: "test.sqlite", agentSocketPath: "test.sock", appOrigin: "http://localhost",
    auth: { mode: "development", actor: "owner@example.invalid" } })),
  authenticate: vi.fn(() => Promise.resolve({ identity: "owner@example.invalid" }))
}));

vi.mock("../../../../../server/config.js", () => ({ readWebRuntimeConfig: mocks.getConfig }));
vi.mock("../../../../../server/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../../server/auth.js")>("../../../../../server/auth.js");
  return { ...actual, authenticateHeaders: mocks.authenticate };
});
vi.mock("../../../../../server/database.js", () => ({ getProjectDatabase: mocks.getDatabase }));
vi.mock("../../../../../server/agent-client.js", () => ({ createAgentClient: mocks.getAgent }));
vi.mock("../../../../../server/ai-sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../../server/ai-sessions.js")>("../../../../../server/ai-sessions.js");
  return { ...actual, restartAiSession: mocks.restart, sendAiTurn: mocks.send,
    respondToAiApproval: mocks.respondApproval, respondToAiStructuredInput: mocks.respondInput };
});

import { GET, POST } from "./route.js";
import { GET as GET_STATUS } from "./status/route.js";

const profile = { profileId: "codex", profileRevision: "revision", displayName: "Codex", availability: { state: "available" }, capabilities: { interrupt: true } };
const session = {
  id: ids.sessionId, workspaceId: ids.workspaceId, title: "Session", state: "active", profileId: "codex", profileRevision: "revision",
  revisionId: ids.projectId, runtimePlanHash: "sha256-project-options-v1:" + "a".repeat(64), runtimeGeneration: 1, processGeneration: 1,
  lastSequence: 1, historyStartSequence: 1, historyTruncated: false, interactionsTruncated: false, failureCode: null,
  createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T00:00:00.000Z"
};
const context = { params: Promise.resolve({ projectId: ids.projectId }) };
const request = new Request(`http://localhost/api/projects/${ids.projectId}/ai?workspaceId=${ids.workspaceId}&sessionId=${ids.sessionId}`);

afterEach(() => {
  mocks.getDatabase.mockReset();
  mocks.getAgent.mockReset();
  mocks.inspectProvider.mockReset();
  mocks.restart.mockReset();
  mocks.send.mockReset();
  mocks.respondApproval.mockReset();
  mocks.respondInput.mockReset();
  mocks.authenticate.mockReset();
  mocks.authenticate.mockResolvedValue({ identity: "owner@example.invalid" });
});

describe("complete AI workbench response bound", () => {
  test("bounds the exact object passed to NextResponse.json, including the envelope", async () => {
    mocks.getDatabase.mockReturnValue({
      listAiSessions: () => [{ id: ids.sessionId, workspaceId: ids.workspaceId, title: "Session", state: "active", lastSequence: 1,
        historyStartSequence: 1, historyTruncated: false, createdAt: session.createdAt, updatedAt: session.updatedAt }],
      getAiSession: () => ({
        session,
        turns: Array.from({ length: 6 }, (_, index) => ({ id: `turn-${index}`, state: "completed", content: { kind: "text", text: "prompt" }, outputText: "x".repeat(2 * 1024 * 1024), outputTruncated: false, activities: [], changedFiles: { files: [], truncated: false }, failure: null, createdAt: session.createdAt, updatedAt: session.updatedAt, completedAt: session.updatedAt })),
        interactions: [], events: []
      })
    });
    mocks.getAgent.mockReturnValue({ inspectAiProvider: mocks.inspectProvider });
    mocks.inspectProvider.mockResolvedValue(profile);
    const spy = vi.spyOn(NextResponse, "json");

    const response = await GET(request, context);
    const body = spy.mock.calls.at(-1)?.[0];

    expect(response.status).toBe(200);
    expect(body).toBeDefined();
    expect(serializedBytes(body)).toBeLessThanOrEqual(AI_SESSION_RESPONSE_MAX_BYTES);
    const responseText = await response.text();
    expect(Buffer.byteLength(responseText, "utf8")).toBeLessThanOrEqual(AI_SESSION_RESPONSE_MAX_BYTES);
    const parsed = JSON.parse(responseText) as { session?: { session?: { id?: string } } };
    expect(parsed.session?.session?.id).toBe(ids.sessionId);
    spy.mockRestore();
  });

  test("measures the session-list GET with deliberately slow Codex inspection", async () => {
    const summary = { id: ids.sessionId, workspaceId: ids.workspaceId, title: "Persisted", state: "stopped", lastSequence: 2,
      historyStartSequence: 1, historyTruncated: false, createdAt: session.createdAt, updatedAt: session.updatedAt };
    mocks.getDatabase.mockReturnValue({ listAiSessions: () => [summary] });
    mocks.getAgent.mockReturnValue({ inspectAiProvider: mocks.inspectProvider });
    mocks.inspectProvider.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(profile), 1_500)));
    const listRequest = new Request(`http://localhost/api/projects/${ids.projectId}/ai?workspaceId=${ids.workspaceId}`);
    const statusRequest = new Request(`http://localhost/api/projects/${ids.projectId}/ai/status?workspaceId=${ids.workspaceId}`);
    const statusPromise = GET_STATUS(statusRequest, context);
    await vi.waitFor(() => expect(mocks.inspectProvider).toHaveBeenCalledTimes(1));
    const startedAt = performance.now();

    const response = await GET(listRequest, context);
    const elapsedMs = performance.now() - startedAt;

    expect(response.status).toBe(200);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(mocks.inspectProvider).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({ profile: null, sessions: [summary], session: null });
    const statusResponse = await statusPromise;
    expect(statusResponse.status).toBe(200);
  });
});

describe("Legacy Codex provider status route", () => {
  const statusRequest = new Request(`http://localhost/api/projects/${ids.projectId}/ai/status?workspaceId=${ids.workspaceId}`);

  test("returns the provider's unavailable state without treating status as a session-list failure", async () => {
    const unavailableProfile = { ...profile, provider: "codex", availability: { state: "unavailable", code: "EXECUTABLE_MISSING" },
      capabilities: { inspect: true, start: true, resume: false, sendTurn: true, interrupt: false, approvals: false,
        structuredInput: false, stop: true, streamEvents: true } };
    mocks.getAgent.mockReturnValue({ inspectAiProvider: mocks.inspectProvider });
    mocks.inspectProvider.mockResolvedValue(unavailableProfile);

    const response = await GET_STATUS(statusRequest, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ profile: unavailableProfile });
    expect(mocks.inspectProvider).toHaveBeenCalledWith(ids.projectId, ids.workspaceId, "codex");
  });

  test("retains authentication and workspace validation before provider inspection", async () => {
    const { AuthenticationError } = await import("../../../../../server/auth.js");
    mocks.getAgent.mockReturnValue({ inspectAiProvider: mocks.inspectProvider });
    mocks.authenticate.mockRejectedValueOnce(new AuthenticationError());
    const denied = await GET_STATUS(statusRequest, context);
    expect(denied.status).toBe(403);
    expect(mocks.inspectProvider).not.toHaveBeenCalled();

    const invalid = await GET_STATUS(new Request(`http://localhost/api/projects/${ids.projectId}/ai/status?workspaceId=bad`), context);
    expect(invalid.status).toBe(422);
    expect(mocks.inspectProvider).not.toHaveBeenCalled();
  });
});

describe("AI stopped-session restart route", () => {
  const post = (body: unknown, csrf = true) => new Request(`http://localhost/api/projects/${ids.projectId}/ai`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost", ...(csrf ? { "x-devspace-csrf": "1" } : {}) },
    body: JSON.stringify(body)
  });

  test("accepts only the strict exact restart action", async () => {
    mocks.restart.mockResolvedValue({ sessionId: ids.sessionId, operationId: "018f0f00-0000-7000-8000-000000000104" });

    const response = await POST(post({ action: "restart", workspaceId: ids.workspaceId, sessionId: ids.sessionId }), context);

    expect(response.status).toBe(200);
    expect(mocks.restart).toHaveBeenCalledWith(ids.projectId, ids.workspaceId, ids.sessionId, expect.any(Object));
  });

  test("returns only the opaque turn ID for an ambiguous send outcome", async () => {
    const { AiTurnOutcomeAmbiguousError } = await import("../../../../../server/ai-sessions.js");
    const turnId = "018f0f00-0000-7000-8000-000000000105";
    mocks.send.mockRejectedValueOnce(new AiTurnOutcomeAmbiguousError(turnId));
    const response = await POST(post({
      action: "send",
      workspaceId: ids.workspaceId,
      sessionId: ids.sessionId,
      content: { kind: "text", text: "private prompt" }
    }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: "The AI turn outcome is being reconciled. The selected session will be reloaded.",
      code: "AI_SESSION_CONFLICT",
      turnId,
      outcome: "ambiguous"
    });
  });

  test.each([
    "sandbox",
    "approvalPolicy",
    "cwd",
    "environment",
    "executable",
    "provider",
    "processGeneration"
  ])("rejects an additional top-level send field named %s", async (field) => {
    const response = await POST(post({
      action: "send",
      workspaceId: ids.workspaceId,
      sessionId: ids.sessionId,
      content: { kind: "text", text: "private prompt" },
      [field]: "forbidden"
    }), context);
    expect(response.status).toBe(422);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  test.each([
    { action: "restart", workspaceId: ids.workspaceId },
    { action: "restart", workspaceId: ids.workspaceId, sessionId: "not-a-session" },
    { action: "restart", workspaceId: ids.workspaceId, sessionId: ids.sessionId, extra: true }
  ])("rejects malformed, missing, or extra restart fields", async (body) => {
    const response = await POST(post(body), context);
    expect(response.status).toBe(422);
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  test("retains CSRF rejection and bounded restart conflicts", async () => {
    expect((await POST(post({ action: "restart", workspaceId: ids.workspaceId, sessionId: ids.sessionId }, false), context)).status).toBe(403);
    const { AiSessionActionError } = await import("../../../../../server/ai-sessions.js");
    mocks.restart.mockRejectedValueOnce(new AiSessionActionError("AI_SESSION_CONFLICT", "Only a stopped AI session can be started again."));
    const response = await POST(post({ action: "restart", workspaceId: ids.workspaceId, sessionId: ids.sessionId }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: "Only a stopped AI session can be started again.", code: "AI_SESSION_CONFLICT" });
  });

  test("retains authentication rejection before restart dispatch", async () => {
    const { AuthenticationError } = await import("../../../../../server/auth.js");
    mocks.authenticate.mockRejectedValueOnce(new AuthenticationError());
    const response = await POST(post({ action: "restart", workspaceId: ids.workspaceId, sessionId: ids.sessionId }), context);
    expect(response.status).toBe(403);
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  test("dispatches strict approval and structured-input actions with browser-owned identifiers only", async () => {
    const turnId = "018f0f00-0000-7000-8000-000000000106";
    const requestId = "018f0f00-0000-7000-8000-000000000107";
    mocks.respondApproval.mockResolvedValue({ operationId: "018f0f00-0000-7000-8000-000000000108" });
    mocks.respondInput.mockResolvedValue({ operationId: "018f0f00-0000-7000-8000-000000000109" });
    const approval = await POST(post({ action: "respond-approval", workspaceId: ids.workspaceId, sessionId: ids.sessionId,
      turnId, requestId, decision: "approve-once" }), context);
    const input = await POST(post({ action: "respond-input", workspaceId: ids.workspaceId, sessionId: ids.sessionId,
      turnId, requestId, answers: [{ questionId: "question-1", kind: "selected", optionId: "option-1" }] }), context);
    expect(approval.status).toBe(200);
    expect(input.status).toBe(200);
    expect(mocks.respondApproval).toHaveBeenCalledWith(ids.projectId, ids.workspaceId, ids.sessionId, turnId, requestId, "approve-once", expect.any(Object));
    expect(mocks.respondInput).toHaveBeenCalledWith(ids.projectId, ids.workspaceId, ids.sessionId, turnId, requestId,
      [{ questionId: "question-1", kind: "selected", optionId: "option-1" }], expect.any(Object));
  });

  test.each([
    { action: "respond-approval", workspaceId: ids.workspaceId, sessionId: ids.sessionId, turnId: ids.projectId,
      requestId: ids.sessionId, decision: "approve-once", extra: "reject" },
    { action: "respond-input", workspaceId: ids.workspaceId, sessionId: ids.sessionId, turnId: ids.projectId,
      requestId: ids.sessionId, answers: [{ questionId: "question-1", kind: "selected", optionId: "option-1" }], extra: "reject" },
    { action: "respond-input", workspaceId: ids.workspaceId, sessionId: ids.sessionId, turnId: ids.projectId,
      requestId: ids.sessionId, answers: [{ questionId: "question-1", kind: "text", text: "ok", providerRequestId: "private" }] },
    { action: "respond-approval", workspaceId: ids.workspaceId, sessionId: ids.sessionId, turnId: ids.projectId,
      requestId: ids.sessionId, decision: "approve-once", profileRevision: "private", processGeneration: 9 }
  ])("rejects malformed or extra interaction response fields", async (body) => {
    const response = await POST(post(body), context);
    expect(response.status).toBe(422);
    expect(mocks.respondApproval).not.toHaveBeenCalled();
    expect(mocks.respondInput).not.toHaveBeenCalled();
  });
});
