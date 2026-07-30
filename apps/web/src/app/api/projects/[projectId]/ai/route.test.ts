import { afterEach, describe, expect, test, vi } from "vitest";
import { NextResponse } from "next/server";
import { AI_SESSION_RESPONSE_MAX_BYTES, serializedBytes } from "../../../../../server/ai-history.js";

const ids = {
  projectId: "018f0f00-0000-7000-8000-000000000101",
  workspaceId: "018f0f00-0000-7000-8000-000000000102",
  sessionId: "018f0f00-0000-7000-8000-000000000103"
};
const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  restart: vi.fn(),
  send: vi.fn(),
  getConfig: vi.fn(() => ({ databasePath: "test.sqlite", agentSocketPath: "test.sock", appOrigin: "http://localhost",
    auth: { mode: "development", actor: "owner@example.invalid" } })),
  authenticate: vi.fn(() => Promise.resolve({ identity: "owner@example.invalid" }))
}));

vi.mock("../../../../../server/config.js", () => ({ readWebRuntimeConfig: mocks.getConfig }));
vi.mock("../../../../../server/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../../server/auth.js")>("../../../../../server/auth.js");
  return { ...actual, authenticateHeaders: mocks.authenticate };
});
vi.mock("../../../../../server/database.js", () => ({ getProjectDatabase: () => ({}) }));
vi.mock("../../../../../server/agent-client.js", () => ({ createAgentClient: () => ({}) }));
vi.mock("../../../../../server/ai-sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../../server/ai-sessions.js")>("../../../../../server/ai-sessions.js");
  return { ...actual, inspectAiWorkbench: mocks.inspect, restartAiSession: mocks.restart, sendAiTurn: mocks.send };
});

import { GET, POST } from "./route.js";

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
  mocks.inspect.mockReset();
  mocks.restart.mockReset();
  mocks.send.mockReset();
  mocks.authenticate.mockReset();
  mocks.authenticate.mockResolvedValue({ identity: "owner@example.invalid" });
});

describe("complete AI workbench response bound", () => {
  test("bounds the exact object passed to NextResponse.json, including the envelope", async () => {
    mocks.inspect.mockResolvedValue({
      profile,
      sessions: [{ id: ids.sessionId, workspaceId: ids.workspaceId, title: "Session", state: "active", lastSequence: 1, historyStartSequence: 1, historyTruncated: false, createdAt: session.createdAt, updatedAt: session.updatedAt }],
      session: {
        session,
        turns: Array.from({ length: 6 }, (_, index) => ({ id: `turn-${index}`, state: "completed", content: { kind: "text", text: "prompt" }, outputText: "x".repeat(2 * 1024 * 1024), outputTruncated: false, activities: [], changedFiles: { files: [], truncated: false }, failure: null, createdAt: session.createdAt, updatedAt: session.updatedAt, completedAt: session.updatedAt })),
        interactions: [], events: []
      }
    });
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
});
