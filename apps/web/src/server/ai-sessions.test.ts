import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  gitInspectionDataSchema,
  workspaceInspectionDataSchema,
  type AgentOperationObservation,
  type CanonicalAiEvent
} from "@devspace/contracts";
import { openProjectDatabase, ProjectSetupConflictError } from "./database.js";
import { boundAiWorkbenchResponse, createAiSession, inspectAiWorkbench, interruptAiTurn, restartAiSession, sendAiTurn, stopAiSession, streamAiEvents } from "./ai-sessions.js";
import {
  AI_SESSION_EVENT_HISTORY_MAX_EVENTS,
  AI_SESSION_OUTPUT_MAX_BYTES,
  AI_SESSION_RESPONSE_MAX_BYTES,
  AI_TURN_OUTPUT_MAX_BYTES,
  serializedBytes,
  utf8ByteLength
} from "./ai-history.js";
import { setupPrimaryWorkspace, type WorkspaceSetupAgent } from "./workspace-setup.js";
import { AgentUnavailableError } from "./agent-client.js";

const projectId = "018f0f00-0000-7000-8000-000000000001";
const workspaceId = "018f0f00-0000-7000-8000-000000000002";
const sessionAId = "018f0f00-0000-7000-8000-000000000003";
const sessionBId = "018f0f00-0000-7000-8000-000000000004";
const turnId = "018f0f00-0000-7000-8000-000000000005";
const profileRevision = `sha256-ai-profile-v1:${"a".repeat(64)}`;
const runtimePlanHash = `sha256-jcs-v1:${"b".repeat(64)}`;
const timestamp = "2026-07-30T12:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function session(id: string) {
  return {
    id,
    workspaceId,
    title: `Session ${id.slice(-1)}`,
    state: "active",
    profileId: "codex",
    profileRevision,
    revisionId: "018f0f00-0000-7000-8000-000000000006",
    runtimePlanHash,
    runtimeGeneration: 1,
    processGeneration: 1,
    lastSequence: 0,
    failureCode: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function view(id: string) {
  return { session: session(id), turns: [], events: [] };
}

function fakeAgent() {
  return {
    inspectAiProvider: vi.fn(() => Promise.resolve({
      profileId: "codex", profileRevision, provider: "codex", displayName: "Codex",
      capabilities: { inspect: true, start: true, resume: false, sendTurn: true, interrupt: true, approvals: false,
        structuredInput: false, stop: true, streamEvents: true }, availability: { state: "available" as const }
    })),
    startAiSession: vi.fn((_operationId: string, _data: Record<string, unknown>) =>
      Promise.resolve({ operationId: "018f0f00-0000-7000-8000-000000000006" })),
    sendAiTurn: vi.fn(() => Promise.resolve({ operationId: "018f0f00-0000-7000-8000-000000000007" })),
    interruptAiTurn: vi.fn(() => Promise.resolve({ operationId: "018f0f00-0000-7000-8000-000000000008" })),
    stopAiSession: vi.fn(() => Promise.resolve({ operationId: "018f0f00-0000-7000-8000-000000000009" })),
    streamAiEvents: vi.fn(async function* (requestedSessionId: string) {
      await Promise.resolve();
      yield { schemaVersion: "devspace.ai-stream/v1" as const, frameType: "stream.synchronized" as const,
        sessionId: requestedSessionId, throughSequence: 0 };
    }),
    acknowledgeAiEvents: vi.fn((value: unknown) => Promise.resolve(value))
  };
}

function fakeSessionDatabase() {
  const agent = fakeAgent();
  const database = {
    getAiSession: vi.fn((_project: string, _workspace: string, requestedSessionId?: string) =>
      requestedSessionId === sessionAId ? view(sessionAId) : requestedSessionId === sessionBId ? view(sessionBId) : null),
    listAiSessions: vi.fn(() => [
      { ...session(sessionBId), historyStartSequence: 1, historyTruncated: false },
      { ...session(sessionAId), historyStartSequence: 1, historyTruncated: false }
    ]),
    getAiTurn: vi.fn((_project: string, _workspace: string, requestedSessionId: string, requestedTurnId: string) =>
      requestedSessionId === sessionAId && requestedTurnId === turnId ? { id: turnId, sessionId: sessionAId, state: "running" } : null),
    ensureAiTurnAccepted: vi.fn(() => undefined),
    commitAiEvent: vi.fn(() => "appended" as const)
  };
  return { agent, database };
}

test("binds a supplied older session instead of acting on the newer workspace session", async () => {
  const agent = fakeAgent();
  const database = {
    getAiSession: vi.fn((_project: string, _workspace: string, requestedSessionId?: string) =>
      requestedSessionId === sessionAId ? view(sessionAId) : view(sessionBId)),
    ensureAiTurnAccepted: vi.fn(() => undefined)
  };

  await sendAiTurn(projectId, workspaceId, sessionAId, "use session A", {
    database,
    agent
  } as never);

  expect(agent.sendAiTurn).toHaveBeenCalledTimes(1);
  const firstCall = agent.sendAiTurn.mock.calls[0] as unknown as readonly [unknown, Record<string, unknown>?] | undefined;
  const binding = firstCall?.[1];
  expect(binding).toMatchObject({
    projectId,
    workspaceId,
    aiSessionId: sessionAId
  });
  expect(typeof binding?.turnId).toBe("string");
});

test.each(["stopped", "lost", "creating"] as const)("rejects a %s session before creating or sending a turn", async (state) => {
  const agent = fakeAgent();
  const ensureAiTurnAccepted = vi.fn();
  const database = {
    getAiSession: vi.fn(() => ({ ...view(sessionAId), session: { ...session(sessionAId), state } })),
    ensureAiTurnAccepted
  };

  await expect(sendAiTurn(projectId, workspaceId, sessionAId, "must not persist", { database, agent } as never))
    .rejects.toMatchObject({ code: "AI_SESSION_CONFLICT" });

  expect(ensureAiTurnAccepted).not.toHaveBeenCalled();
  expect(agent.sendAiTurn).not.toHaveBeenCalled();
});

test("definitive Agent rejection leaves no Web turn while success performs one exact post-receipt ensure", async () => {
  const rejected = fakeSessionDatabase();
  rejected.agent.sendAiTurn.mockRejectedValueOnce(new Error("definitive-rejection"));
  await expect(sendAiTurn(projectId, workspaceId, sessionAId, "reject me", rejected as never)).rejects.toThrow("definitive-rejection");
  expect(rejected.database.ensureAiTurnAccepted).not.toHaveBeenCalled();

  const accepted = fakeSessionDatabase();
  const result = await sendAiTurn(projectId, workspaceId, sessionAId, "accept me", accepted as never);
  expect(accepted.agent.sendAiTurn).toHaveBeenCalledTimes(1);
  expect(accepted.database.ensureAiTurnAccepted).toHaveBeenCalledWith({
    projectId,
    workspaceId,
    sessionId: sessionAId,
    turnId: result.turnId,
    processGeneration: 1,
    content: { kind: "text", text: "accept me" }
  });
  expect(accepted.agent.sendAiTurn.mock.invocationCallOrder[0])
    .toBeLessThan(accepted.database.ensureAiTurnAccepted.mock.invocationCallOrder[0]!);
});

test("transport ambiguity returns the exact opaque turn ID without creating a Web-only row", async () => {
  const fixture = fakeSessionDatabase();
  fixture.agent.sendAiTurn.mockRejectedValueOnce(new AgentUnavailableError("AGENT_UNAVAILABLE", "transport-failure"));
  const error = await sendAiTurn(projectId, workspaceId, sessionAId, "possibly accepted", fixture as never)
    .catch((caught: unknown) => caught);
  expect(error).toMatchObject({
    name: "AiTurnOutcomeAmbiguousError",
    code: "AI_SESSION_CONFLICT"
  });
  expect(typeof (error as { turnId?: unknown }).turnId).toBe("string");
  expect(fixture.database.ensureAiTurnAccepted).not.toHaveBeenCalled();
  expect(JSON.stringify(error)).not.toContain("possibly accepted");
});

test.each([
  new Error("sqlite-io-failure"),
  new ProjectSetupConflictError("conflicting-local-projection")
])("treats every post-receipt local acceptance failure as ambiguous", async (localFailure) => {
  const fixture = fakeSessionDatabase();
  fixture.database.ensureAiTurnAccepted.mockImplementationOnce(() => {
    throw localFailure;
  });

  const error = await sendAiTurn(projectId, workspaceId, sessionAId, "accepted by Agent", fixture as never)
    .catch((caught: unknown) => caught);

  expect(error).toMatchObject({
    name: "AiTurnOutcomeAmbiguousError",
    code: "AI_SESSION_CONFLICT"
  });
  expect(typeof (error as { turnId?: unknown }).turnId).toBe("string");
  expect(JSON.stringify(error)).not.toContain("sqlite-io-failure");
  expect(JSON.stringify(error)).not.toContain("conflicting-local-projection");
});

test("restarts the exact stopped session without sending process generation authority", async () => {
  const agent = fakeAgent();
  const stopped = { ...session(sessionAId), state: "stopped", profileKey: "codex" };
  const database = {
    getAiSession: vi.fn(() => ({ ...view(sessionAId), session: stopped })),
    prepareAiSessionRestart: vi.fn(() => ({ ...stopped, state: "creating", updatedAt: "2026-07-30T12:00:00.001Z" })),
    rollbackAiSessionRestart: vi.fn(() => true)
  };

  const result = await restartAiSession(projectId, workspaceId, sessionAId, { database, agent } as never);

  expect(result.sessionId).toBe(sessionAId);
  expect(database.prepareAiSessionRestart).toHaveBeenCalledWith({
    projectId, workspaceId, sessionId: sessionAId, profileId: "codex", profileRevision
  });
  expect(agent.startAiSession).toHaveBeenCalledWith(expect.any(String), {
    projectId, workspaceId, aiSessionId: sessionAId, revisionId: stopped.revisionId,
    runtimePlanHash, runtimeGeneration: 1, profileId: "codex", profileRevision
  });
  expect(agent.startAiSession.mock.calls[0]?.[1]).not.toHaveProperty("processGeneration");
  expect(database.rollbackAiSessionRestart).not.toHaveBeenCalled();
});

test.each(["active", "creating", "lost"] as const)("rejects restart from %s before inspecting or calling Agent", async (state) => {
  const agent = fakeAgent();
  const database = {
    getAiSession: vi.fn(() => ({ ...view(sessionAId), session: { ...session(sessionAId), state } })),
    prepareAiSessionRestart: vi.fn()
  };

  await expect(restartAiSession(projectId, workspaceId, sessionAId, { database, agent } as never))
    .rejects.toMatchObject({ code: "AI_SESSION_CONFLICT" });

  expect(agent.inspectAiProvider).not.toHaveBeenCalled();
  expect(database.prepareAiSessionRestart).not.toHaveBeenCalled();
  expect(agent.startAiSession).not.toHaveBeenCalled();
});

test.each([
  ["foreign", "018f0f00-0000-7000-8000-000000000010"],
  ["nonexistent", "018f0f00-0000-7000-8000-000000000011"]
] as const)("rejects restart for a %s exact session without calling Agent", async (_label, requestedSessionId) => {
  const agent = fakeAgent();
  const database = { getAiSession: vi.fn(() => null), prepareAiSessionRestart: vi.fn() };
  await expect(restartAiSession(projectId, workspaceId, requestedSessionId, { database, agent } as never))
    .rejects.toMatchObject({ code: "AI_SESSION_CONFLICT", message: "The AI session is no longer available." });
  expect(agent.inspectAiProvider).not.toHaveBeenCalled();
  expect(agent.startAiSession).not.toHaveBeenCalled();
});

test("restores only the exact claimed stopped session when Agent rejects restart acceptance", async () => {
  const agent = fakeAgent();
  agent.startAiSession.mockRejectedValueOnce(new Error("agent unavailable"));
  const stopped = { ...session(sessionAId), state: "stopped", profileKey: "codex", updatedAt: timestamp };
  const prepared = { ...stopped, state: "creating", updatedAt: "2026-07-30T12:00:00.001Z" };
  const rollbackAiSessionRestart = vi.fn(() => true);
  const database = {
    getAiSession: vi.fn(() => ({ ...view(sessionAId), session: stopped })),
    prepareAiSessionRestart: vi.fn(() => prepared),
    rollbackAiSessionRestart
  };

  await expect(restartAiSession(projectId, workspaceId, sessionAId, { database, agent } as never)).rejects.toThrow("agent unavailable");

  expect(rollbackAiSessionRestart).toHaveBeenCalledWith({
    projectId, workspaceId, sessionId: sessionAId, expectedUpdatedAt: prepared.updatedAt,
    expectedLastSequence: prepared.lastSequence, expectedProcessGeneration: prepared.processGeneration
  });
});

test("keeps workspace-level initial creation idempotent without treating an existing stopped session as restart", async () => {
  const agent = fakeAgent();
  const existing = { ...session(sessionAId), state: "stopped", profileKey: "codex" };
  const database = {
    createInitialAiSession: vi.fn(() => ({ session: existing, created: false }))
  };

  const result = await createAiSession(projectId, workspaceId, "owner", { database, agent } as never);

  expect(result).toEqual({ sessionId: sessionAId, operationId: null });
  expect(agent.startAiSession).not.toHaveBeenCalled();
});

test("retries the exact zero-sequence creating session after synchronized-empty replay", async () => {
  const agent = fakeAgent();
  const creating = { ...session(sessionAId), state: "creating", profileKey: "codex", updatedAt: timestamp };
  const prepared = { ...creating, updatedAt: "2026-07-30T12:00:00.001Z" };
  const database = {
    createInitialAiSession: vi.fn(() => ({ session: creating, created: false })),
    prepareInitialAiSessionRetry: vi.fn(() => prepared),
    commitAiEvent: vi.fn()
  };

  const result = await createAiSession(projectId, workspaceId, "owner", { database, agent } as never);

  expect(result).toMatchObject({ sessionId: sessionAId });
  expect(database.prepareInitialAiSessionRetry).toHaveBeenCalledWith(expect.objectContaining({
    projectId,
    workspaceId,
    sessionId: sessionAId,
    expectedUpdatedAt: timestamp,
    synchronizedEmpty: true
  }));
  expect(agent.startAiSession).toHaveBeenCalledTimes(1);
  expect(agent.startAiSession.mock.calls[0]?.[1]).toMatchObject({ aiSessionId: sessionAId });
});

test("returns only the durable session identity when initial start and replay are unavailable", async () => {
  const agent = fakeAgent();
  agent.startAiSession.mockRejectedValueOnce(new AgentUnavailableError("AGENT_UNAVAILABLE", "transport-failure"));
  agent.streamAiEvents.mockImplementation(async function* () {
    yield await Promise.reject(new AgentUnavailableError("AGENT_UNAVAILABLE", "transport-failure"));
  });
  const creating = { ...session(sessionAId), state: "creating", profileKey: "codex", updatedAt: timestamp };
  const database = {
    createInitialAiSession: vi.fn(() => ({ session: creating, created: true })),
    commitAiEvent: vi.fn()
  };

  await expect(createAiSession(projectId, workspaceId, "owner", { database, agent } as never))
    .resolves.toEqual({ sessionId: sessionAId, operationId: null });
  expect(database.createInitialAiSession).toHaveBeenCalledTimes(1);
});

test("commits and acknowledges canonical startup history after a lost start response", async () => {
  const agent = fakeAgent();
  agent.startAiSession.mockRejectedValueOnce(new AgentUnavailableError("AGENT_UNAVAILABLE", "transport-failure"));
  const started = sessionEvent(sessionAId, 1, "session.started", 1);
  agent.streamAiEvents.mockImplementation((async function* () {
    await Promise.resolve();
    yield started;
    yield {
      schemaVersion: "devspace.ai-stream/v1",
      frameType: "stream.synchronized",
      sessionId: sessionAId,
      throughSequence: 1
    };
  }) as never);
  const creating = { ...session(sessionAId), state: "creating", profileKey: "codex", updatedAt: timestamp };
  const database = {
    createInitialAiSession: vi.fn(() => ({ session: creating, created: true })),
    commitAiEvent: vi.fn(() => "appended" as const)
  };

  await expect(createAiSession(projectId, workspaceId, "owner", { database, agent } as never))
    .resolves.toEqual({ sessionId: sessionAId });
  expect(database.commitAiEvent).toHaveBeenCalledWith({ projectId, workspaceId, event: started });
  expect(agent.acknowledgeAiEvents).toHaveBeenCalledWith({
    projectId,
    workspaceId,
    aiSessionId: sessionAId,
    throughSequence: 1,
    throughEventId: started.eventId
  });
  expect(database.createInitialAiSession).toHaveBeenCalledTimes(1);
});

test("does not silently retry a zero-sequence session under a changed binding", async () => {
  const agent = fakeAgent();
  const creating = { ...session(sessionAId), state: "creating", profileKey: "codex",
    profileRevision: `sha256-ai-profile-v1:${"c".repeat(64)}`, updatedAt: timestamp };
  const database = {
    createInitialAiSession: vi.fn(() => ({ session: creating, created: false })),
    prepareInitialAiSessionRetry: vi.fn(() => {
      throw new Error("changed-runtime-binding");
    }),
    commitAiEvent: vi.fn()
  };

  await expect(createAiSession(projectId, workspaceId, "owner", { database, agent } as never))
    .resolves.toEqual({ sessionId: sessionAId, operationId: null });
  expect(agent.startAiSession).not.toHaveBeenCalled();
  expect(database.prepareInitialAiSessionRetry).not.toHaveBeenCalled();
});

test("a rejected first start remains retryable under the exact session identity", async () => {
  const agent = fakeAgent();
  agent.startAiSession
    .mockRejectedValueOnce(new Error("provider-rejected-before-started"))
    .mockResolvedValueOnce({ operationId: "018f0f00-0000-7000-8000-000000000012" });
  const creating = { ...session(sessionAId), state: "creating", profileKey: "codex", updatedAt: timestamp };
  const prepared = { ...creating, updatedAt: "2026-07-30T12:00:00.001Z" };
  let createCalls = 0;
  const database = {
    createInitialAiSession: vi.fn(() => ({ session: creating, created: createCalls++ === 0 })),
    prepareInitialAiSessionRetry: vi.fn(() => prepared),
    commitAiEvent: vi.fn()
  };

  await expect(createAiSession(projectId, workspaceId, "owner", { database, agent } as never))
    .resolves.toEqual({ sessionId: sessionAId });
  const retried = await createAiSession(projectId, workspaceId, "owner", { database, agent } as never);
  expect(retried.sessionId).toBe(sessionAId);
  expect(typeof retried.operationId).toBe("string");
  expect(agent.startAiSession).toHaveBeenCalledTimes(2);
  expect(agent.startAiSession.mock.calls.map((call) => call[1])).toEqual([
    expect.objectContaining({ aiSessionId: sessionAId }),
    expect.objectContaining({ aiSessionId: sessionAId })
  ]);
});

test("concurrent Create calls join one initial provider generation", async () => {
  const agent = fakeAgent();
  let release!: () => void;
  agent.startAiSession.mockImplementationOnce(async () => await new Promise<void>((resolve) => {
    release = resolve;
  }) as never);
  const creating = { ...session(sessionAId), state: "creating", profileKey: "codex", updatedAt: timestamp };
  let createCalls = 0;
  const database = {
    createInitialAiSession: vi.fn(() => ({ session: creating, created: createCalls++ === 0 })),
    prepareInitialAiSessionRetry: vi.fn(),
    commitAiEvent: vi.fn()
  };

  const first = createAiSession(projectId, workspaceId, "owner", { database, agent } as never);
  const second = createAiSession(projectId, workspaceId, "owner", { database, agent } as never);
  await vi.waitFor(() => expect(agent.startAiSession).toHaveBeenCalledTimes(1));
  release();

  const results = await Promise.all([first, second]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]?.sessionId).toBe(sessionAId);
  expect(typeof results[0]?.operationId).toBe("string");
  expect(agent.startAiSession).toHaveBeenCalledTimes(1);
});

test("complete response metadata advances past an event-empty retained suffix", () => {
  const selected = {
    session: { ...session(sessionAId), lastSequence: 42, historyStartSequence: 1, historyTruncated: false },
    turns: Array.from({ length: 5 }, (_, index) => ({
      id: `018f0f00-0000-7000-8000-${(200 + index).toString(16).padStart(12, "0")}`,
      state: index === 4 ? "completed" : "active", content: { kind: "text" as const, text: "prompt" },
      outputText: "x".repeat(AI_TURN_OUTPUT_MAX_BYTES), outputTruncated: false, activities: [],
      changedFiles: { files: [], truncated: false }, failure: null, createdAt: timestamp, updatedAt: timestamp, completedAt: timestamp
    })),
    interactions: [],
    events: [{ eventId: "018f0f00-0000-7000-8000-000000000099", sessionId: sessionAId, turnId, sequence: 42,
      eventType: "turn.quiesced", observedAt: timestamp, schemaVersion: "devspace.ai-event/v1", profile: { profileId: "codex", profileRevision, provider: "codex" },
      processGeneration: 1, payload: { outcome: "completed" } }]
  };
  const bounded = boundAiWorkbenchResponse({
    profile: { profileId: "codex", profileRevision, provider: "codex", displayName: "Codex", availability: { state: "available" }, capabilities: {} },
    sessions: [], session: selected
  } as never);
  expect(bounded.session?.events).toEqual([]);
  expect(bounded.session?.session.historyTruncated).toBe(true);
  expect(bounded.session?.session.historyStartSequence).toBe(43);
  expect(bounded.session?.turns.at(-1)?.state).toBe("completed");
  expect(serializedBytes(bounded)).toBeLessThanOrEqual(AI_SESSION_RESPONSE_MAX_BYTES);
});

function smallPublicProjection(lastSequence: number, historyStartSequence: number, events: number[], historyTruncated = false) {
  return {
    profile: { profileId: "codex", profileRevision, provider: "codex", displayName: "Codex", availability: { state: "available" }, capabilities: {} },
    sessions: [],
    session: {
      session: { ...session(sessionAId), projectId, lastSequence, historyStartSequence, historyTruncated, interactionsTruncated: false },
      turns: [], interactions: [], events: events.map((sequence) => ({ sequence }))
    }
  } as never;
}

test("normalizes an already-truncated under-limit response suffix", () => {
  const bounded = boundAiWorkbenchResponse(smallPublicProjection(42, 1, [37, 38, 39, 40, 41, 42]));
  expect(bounded.session?.session.historyStartSequence).toBe(37);
  expect(bounded.session?.session.historyTruncated).toBe(true);
});

test("normalizes an already-empty under-limit response suffix", () => {
  const bounded = boundAiWorkbenchResponse(smallPublicProjection(42, 1, []));
  expect(bounded.session?.session.historyStartSequence).toBe(43);
  expect(bounded.session?.session.historyTruncated).toBe(true);
});

test("does not mark a never-started under-limit response truncated", () => {
  const bounded = boundAiWorkbenchResponse(smallPublicProjection(0, 1, []));
  expect(bounded.session?.session.historyStartSequence).toBe(1);
  expect(bounded.session?.session.historyTruncated).toBe(false);
});

test("bounds a maximum event collection with a logarithmic number of envelope measurements", () => {
  const events = Array.from({ length: AI_SESSION_EVENT_HISTORY_MAX_EVENTS }, (_, index) => ({
    eventId: `018f0f00-0000-7000-8000-${(10_000 + index).toString(16).padStart(12, "0")}`,
    sessionId: sessionAId, turnId, sequence: index + 1, eventType: "turn.activity.started", observedAt: timestamp,
    schemaVersion: "devspace.ai-event/v1" as const, profile: { profileId: "codex", profileRevision, provider: "codex" }, processGeneration: 1,
    payload: { presentation: { summary: `activity-${index}` } }
  }));
  const selected = {
    session: { ...session(sessionAId), lastSequence: AI_SESSION_EVENT_HISTORY_MAX_EVENTS, historyStartSequence: 1, historyTruncated: false },
    turns: Array.from({ length: 4 }, (_, index) => ({
      id: `018f0f00-0000-7000-8000-${(300 + index).toString(16).padStart(12, "0")}`,
      state: index === 3 ? "completed" : "active", content: { kind: "text" as const, text: "prompt" },
      outputText: "x".repeat(1_900_000), outputTruncated: false, activities: [], changedFiles: { files: [], truncated: false },
      failure: null, createdAt: timestamp, updatedAt: timestamp, completedAt: timestamp
    })),
    interactions: [], events
  };
  const measure = vi.fn((value: unknown) => serializedBytes(value));
  const bounded = boundAiWorkbenchResponse({
    profile: { profileId: "codex", profileRevision, provider: "codex", displayName: "Codex", availability: { state: "available" }, capabilities: {} },
    sessions: [], session: selected
  } as never, { measure });
  expect(measure.mock.calls.length).toBeLessThan(100);
  expect(serializedBytes(bounded)).toBeLessThanOrEqual(AI_SESSION_RESPONSE_MAX_BYTES);
  const retainedSequences = bounded.session?.events.map((event) => event.sequence) ?? [];
  expect(retainedSequences.every((value, index) => index === 0 || value === retainedSequences[index - 1]! + 1)).toBe(true);
  if (retainedSequences.length > 0) expect(bounded.session?.session.historyStartSequence).toBe(retainedSequences[0]);
  else expect(bounded.session?.session.historyStartSequence).toBe(AI_SESSION_EVENT_HISTORY_MAX_EVENTS + 1);
  expect(bounded.session?.turns.at(-1)?.state).toBe("completed");
});

test("uses the exact session for history, interrupt, stop, and Agent replay", async () => {
  const { agent, database } = fakeSessionDatabase();
  const inspected = await inspectAiWorkbench(projectId, workspaceId, sessionAId, { database, agent } as never);
  expect(inspected.session?.session.id).toBe(sessionAId);

  await interruptAiTurn(projectId, workspaceId, sessionAId, turnId, { database, agent } as never);
  await stopAiSession(projectId, workspaceId, sessionAId, { database, agent } as never);
  const frames = [];
  for await (const frame of streamAiEvents(projectId, workspaceId, sessionAId, 0, { database, agent } as never)) frames.push(frame);

  expect(agent.interruptAiTurn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ aiSessionId: sessionAId, turnId }));
  expect(agent.stopAiSession).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ aiSessionId: sessionAId }));
  expect(agent.streamAiEvents).toHaveBeenCalledWith(sessionAId, 0, {});
  expect(database.getAiSession).toHaveBeenCalledWith(projectId, workspaceId, sessionAId);
  expect(frames).toEqual([{ schemaVersion: "devspace.ai-stream/v1", frameType: "stream.synchronized", sessionId: sessionAId, throughSequence: 0 }]);
});

test.each([
  ["foreign session", "018f0f00-0000-7000-8000-000000000010"],
  ["nonexistent session", "018f0f00-0000-7000-8000-000000000011"]
] as const)("rejects a %s through the same bounded error", async (_label, requestedSessionId) => {
  const { agent, database } = fakeSessionDatabase();
  await expect(sendAiTurn(projectId, workspaceId, requestedSessionId, "must fail", { database, agent } as never))
    .rejects.toMatchObject({ code: "AI_SESSION_CONFLICT", message: "The AI session is no longer available." });
  expect(agent.sendAiTurn).not.toHaveBeenCalled();
});

test.each([
  ["foreign workspace", projectId, "018f0f00-0000-7000-8000-000000000012"],
  ["foreign project", "018f0f00-0000-7000-8000-000000000013", workspaceId]
] as const)("rejects a %s through the same bounded error", async (_label, requestedProjectId, requestedWorkspaceId) => {
  const agent = fakeAgent();
  await expect(sendAiTurn(requestedProjectId, requestedWorkspaceId, sessionAId, "must fail", {
    database: {
      getAiSession: vi.fn((project: string, workspace: string, requestedSessionId?: string) =>
        project === projectId && workspace === workspaceId && requestedSessionId === sessionAId ? view(sessionAId) : null),
      ensureAiTurnAccepted: vi.fn()
    },
    agent
  } as never)).rejects.toMatchObject({ code: "AI_SESSION_CONFLICT", message: "The AI session is no longer available." });
  expect(agent.sendAiTurn).not.toHaveBeenCalled();
});

test("rejects a turn that belongs to another exact session", async () => {
  const { agent, database } = fakeSessionDatabase();
  await expect(interruptAiTurn(projectId, workspaceId, sessionAId, sessionBId, { database, agent } as never))
    .rejects.toMatchObject({ code: "AI_SESSION_CONFLICT", message: "The AI session is no longer available." });
  expect(agent.interruptAiTurn).not.toHaveBeenCalled();
});

test.each([
  ["stopped session", "stopped", "running", "AI_SESSION_CONFLICT"],
  ["creating session", "creating", "running", "AI_SESSION_CONFLICT"],
  ["completed turn", "active", "completed", "AI_TURN_CONFLICT"]
] as const)("rejects interruption for an exact %s before calling Agent", async (_label, state, turnState, expectedCode) => {
  const agent = fakeAgent();
  const database = {
    getAiSession: vi.fn(() => ({ ...view(sessionAId), session: { ...session(sessionAId), state } })),
    getAiTurn: vi.fn(() => ({ id: turnId, sessionId: sessionAId, state: turnState }))
  };

  await expect(interruptAiTurn(projectId, workspaceId, sessionAId, turnId, { database, agent } as never))
    .rejects.toMatchObject({ code: expectedCode });
  expect(agent.interruptAiTurn).not.toHaveBeenCalled();
});

function successfulSetupAgent(): WorkspaceSetupAgent {
  const observations = new Map<string, AgentOperationObservation>();
  let revisionId = "";
  let revisionHash = "";
  const succeed = (operationId: string) => observations.set(operationId, {
    operationId, state: "succeeded", updatedAt: timestamp, failure: null
  });
  return {
    health: () => Promise.resolve({ status: "ok" as const }),
    inspectSource: () => Promise.reject(new Error("unused")),
    registerRevision: (operationId, data) => {
      revisionId = data.revisionId;
      revisionHash = data.configuration.hash;
      succeed(operationId);
      return Promise.resolve();
    },
    registerRuntimePlan: (operationId) => { succeed(operationId); return Promise.resolve(); },
    createManagedStore: (operationId) => { succeed(operationId); return Promise.resolve(); },
    fetchProject: (operationId) => { succeed(operationId); return Promise.resolve(); },
    createWorkspace: (operationId) => { succeed(operationId); return Promise.resolve(); },
    snapshot: () => Promise.resolve({
      agentBootId: "018f0f00-0000-7000-8000-000000000008",
      throughCursor: "v1.018f0f00-0000-7000-8000-000000000008.0" as const,
      resources: [], operationObservations: [...observations.values()]
    }),
    inspectGit: (requestedProjectId, requestedWorkspaceId) => Promise.resolve(gitInspectionDataSchema.parse({
      projectId: requestedProjectId,
      workspaceId: requestedWorkspaceId,
      branchName: "main",
      headCommit: "a".repeat(40),
      dirty: false,
      aheadCount: 0,
      behindCount: 0
    })),
    inspectWorkspace: (requestedProjectId, requestedWorkspaceId) => Promise.resolve(workspaceInspectionDataSchema.parse({
      projectId: requestedProjectId,
      workspaceId: requestedWorkspaceId,
      kind: "primary",
      revisionId,
      revisionHash,
      desiredState: "stopped",
      observedState: "stopped",
      dirty: false,
      runtimeStack: { desiredState: "absent", observedState: "absent" }
    }))
  };
}

function outputEvent(sessionId: string, sequence: number, turnIdValue: string): CanonicalAiEvent {
  return {
    schemaVersion: "devspace.ai-event/v1",
    eventId: `018f0f00-0000-7000-8000-${(sequence + 100).toString(16).padStart(12, "0")}`,
    sessionId,
    turnId: turnIdValue,
    sequence,
    observedAt: timestamp,
    profile: { profileId: "codex", profileRevision, provider: "codex" },
    processGeneration: 1,
    eventType: "turn.output.delta",
    payload: { stream: "assistant", text: "x".repeat(65_536) }
  };
}

function turnAcceptedEvent(sessionId: string, sequence: number, turnIdValue: string, text = "canonical prompt"): CanonicalAiEvent {
  return {
    schemaVersion: "devspace.ai-event/v1",
    eventId: `018f0f00-0000-7000-8000-${(sequence + 5_000).toString(16).padStart(12, "0")}`,
    sessionId,
    turnId: turnIdValue,
    sequence,
    observedAt: timestamp,
    profile: { profileId: "codex", profileRevision, provider: "codex" },
    processGeneration: 1,
    eventType: "turn.accepted",
    payload: { content: { kind: "text", text } }
  };
}

function turnStartedEvent(sessionId: string, sequence: number, turnIdValue: string): CanonicalAiEvent {
  return {
    schemaVersion: "devspace.ai-event/v1",
    eventId: `018f0f00-0000-7000-8000-${(sequence + 10_000).toString(16).padStart(12, "0")}`,
    sessionId,
    turnId: turnIdValue,
    sequence,
    observedAt: timestamp,
    profile: { profileId: "codex", profileRevision, provider: "codex" },
    processGeneration: 1,
    eventType: "turn.started",
    payload: {}
  };
}

function turnQuiescedEvent(sessionId: string, sequence: number, turnIdValue: string): CanonicalAiEvent {
  return {
    schemaVersion: "devspace.ai-event/v1",
    eventId: `018f0f00-0000-7000-8000-${(sequence + 20_000).toString(16).padStart(12, "0")}`,
    sessionId,
    turnId: turnIdValue,
    sequence,
    observedAt: timestamp,
    profile: { profileId: "codex", profileRevision, provider: "codex" },
    processGeneration: 1,
    eventType: "turn.quiesced",
    payload: { outcome: "completed" }
  };
}

function sessionEvent(sessionId: string, sequence: number, eventType: "session.started" | "session.ready" | "session.stopping" | "session.stopped",
  processGeneration: number): CanonicalAiEvent {
  const payload = eventType === "session.started" ? { processGeneration }
    : eventType === "session.stopping" ? { reason: "user-request" as const }
      : eventType === "session.stopped" ? { reason: "user-request" as const } : {};
  return {
    schemaVersion: "devspace.ai-event/v1",
    eventId: `018f0f00-0000-7000-8000-${(30_000 + sequence).toString(16).padStart(12, "0")}`,
    sessionId,
    turnId: null,
    sequence,
    observedAt: timestamp,
    profile: { profileId: "codex", profileRevision, provider: "codex" },
    processGeneration,
    eventType,
    payload
  } as CanonicalAiEvent;
}

function approvalRequestedEvent(sessionId: string, sequence: number, turnIdValue: string, requestId: string): CanonicalAiEvent {
  return {
    schemaVersion: "devspace.ai-event/v1",
    eventId: `018f0f00-0000-7000-8000-${(50_000 + sequence).toString(16).padStart(12, "0")}`,
    sessionId,
    turnId: turnIdValue,
    sequence,
    observedAt: timestamp,
    profile: { profileId: "codex", profileRevision, provider: "codex" },
    processGeneration: 1,
    eventType: "turn.approval.requested",
    payload: {
      requestId,
      presentation: {
        kind: "command",
        summary: "Run the bounded test command.",
        commandText: "pnpm test",
        workingDirectory: ".",
        risk: "read",
        redacted: true
      }
    }
  };
}

function inputRequestedEvent(sessionId: string, sequence: number, turnIdValue: string, requestId: string): CanonicalAiEvent {
  return {
    schemaVersion: "devspace.ai-event/v1",
    eventId: `018f0f00-0000-7000-8000-${(51_000 + sequence).toString(16).padStart(12, "0")}`,
    sessionId,
    turnId: turnIdValue,
    sequence,
    observedAt: timestamp,
    profile: { profileId: "codex", profileRevision, provider: "codex" },
    processGeneration: 1,
    eventType: "turn.input.requested",
    payload: {
      requestId,
      questions: [{
        questionId: "question-1", header: "Mode", question: "Choose a mode", responseKind: "single-select", secret: false,
        options: [{ optionId: "option-1", label: "Safe", description: "Use the safe mode" }]
      }]
    }
  };
}

function turnLostEvent(sessionId: string, sequence: number, turnIdValue: string): CanonicalAiEvent {
  return {
    schemaVersion: "devspace.ai-event/v1",
    eventId: `018f0f00-0000-7000-8000-${(52_000 + sequence).toString(16).padStart(12, "0")}`,
    sessionId,
    turnId: turnIdValue,
    sequence,
    observedAt: timestamp,
    profile: { profileId: "codex", profileRevision, provider: "codex" },
    processGeneration: 1,
    eventType: "turn.lost",
    payload: { code: "AGENT_RESTART" }
  };
}

function sessionLostEvent(sessionId: string, sequence: number): CanonicalAiEvent {
  return {
    schemaVersion: "devspace.ai-event/v1",
    eventId: `018f0f00-0000-7000-8000-${(53_000 + sequence).toString(16).padStart(12, "0")}`,
    sessionId,
    turnId: null,
    sequence,
    observedAt: timestamp,
    profile: { profileId: "codex", profileRevision, provider: "codex" },
    processGeneration: 1,
    eventType: "session.lost",
    payload: { code: "AGENT_RESTART" }
  };
}

async function historyFixture(canonicalAcceptance = true) {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-ai-history-fixture-"));
  directories.push(directory);
  const databasePath = path.join(directory, "devspace.sqlite");
  const database = openProjectDatabase(databasePath);
  const project = database.createProject({
    name: "AI history test",
    slug: `ai-history-${directories.length}`,
    repositoryUrl: "https://example.test/ai-history.git",
    defaultBranch: "main",
    actor: "owner"
  });
  const setup = await setupPrimaryWorkspace({ imageReference: "node:24-bookworm" }, project.id, "owner", {
    database,
    agent: successfulSetupAgent(),
    nowMonotonic: () => 0,
    sleep: () => Promise.resolve()
  });
  const primaryWorkspace = setup.project.primaryWorkspace;
  if (primaryWorkspace === null) throw new Error("Expected a primary workspace.");
  const created = database.createAiSession({
    projectId: project.id,
    workspaceId: primaryWorkspace.id,
    profileId: "codex",
    profileRevision
  });
  const raw = new BetterSqlite3(databasePath);
  raw.prepare("update ai_sessions set state = 'active' where id = ?").run(created.id);
  raw.close();
  const createdTurnId = `018f0f00-0000-7000-8000-${(10 + directories.length).toString(16).padStart(12, "0")}`;
  database.createAiTurn({
    projectId: project.id,
    workspaceId: primaryWorkspace.id,
    sessionId: created.id,
    turnId: createdTurnId,
    content: { kind: "text", text: "produce a bounded answer" }
  });
  if (canonicalAcceptance) {
    database.commitAiEvent({
      projectId: project.id,
      workspaceId: primaryWorkspace.id,
      event: turnAcceptedEvent(created.id, 1, createdTurnId, "produce a bounded answer")
    });
  }
  return { database, databasePath, projectId: project.id, workspaceId: primaryWorkspace.id, sessionId: created.id, turnId: createdTurnId };
}

async function stoppedHistoryFixture() {
  const fixture = await historyFixture(false);
  const raw = new BetterSqlite3(fixture.databasePath);
  raw.prepare("update ai_sessions set state = 'creating' where id = ?").run(fixture.sessionId);
  raw.prepare(`
    insert into runtime_stacks
      (id, workspace_id, runtime_namespace, runtime_plan_hash, desired_state, observed_state, runtime_generation, created_at, updated_at)
    select ?, workspace_id, 'workspace-runtime:' || workspace_id, runtime_plan_hash, 'running', 'running', runtime_generation, ?, ?
    from ai_sessions where id = ?
  `).run("018f0f00-0000-7000-8000-000000000098", timestamp, timestamp, fixture.sessionId);
  raw.prepare("update ai_turns set state = 'completed', completed_at = ? where session_id = ?").run(timestamp, fixture.sessionId);
  raw.close();
  for (const [index, eventType] of ["session.started", "session.ready", "session.stopping", "session.stopped"].entries()) {
    fixture.database.commitAiEvent({
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      event: sessionEvent(fixture.sessionId, index + 1, eventType as "session.started" | "session.ready" | "session.stopping" | "session.stopped", 1)
    });
  }
  return fixture;
}

describe("SQLite canonical turn acceptance convergence", () => {
  function finishFixtureTurn(fixture: Awaited<ReturnType<typeof historyFixture>>): void {
    const raw = new BetterSqlite3(fixture.databasePath);
    raw.prepare("update ai_turns set state = 'completed', completed_at = ? where id = ?").run(timestamp, fixture.turnId);
    raw.close();
  }

  test("creates a current-revision session after terminal historical Codex rows while reusing a live row", async () => {
    const fixture = await historyFixture(false);
    const initial = fixture.database.createInitialAiSession({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId, profileId: "codex", profileRevision
    });
    expect(initial).toMatchObject({ session: { id: fixture.sessionId }, created: false });
    const raw = new BetterSqlite3(fixture.databasePath);
    raw.prepare("update ai_sessions set state = 'stopped', profile_revision = ? where id = ?")
      .run(`sha256-ai-profile-v1:${"c".repeat(64)}`, fixture.sessionId);
    raw.close();
    const created = fixture.database.createInitialAiSession({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId, profileId: "codex", profileRevision
    });
    expect(created.created).toBe(true);
    expect(created.session.id).not.toBe(fixture.sessionId);
    expect(created.session.profileRevision).toBe(profileRevision);
    const repeated = fixture.database.createInitialAiSession({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId, profileId: "codex", profileRevision
    });
    expect(repeated).toMatchObject({ session: { id: created.session.id }, created: false });
  });

  test("projects requested and responded interactions atomically and idempotently", async () => {
    const fixture = await historyFixture();
    const approvalRequestId = "018f0f00-0000-7000-8000-000000000020";
    const inputRequestId = "018f0f00-0000-7000-8000-000000000021";
    fixture.database.commitAiEvent({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId,
      event: approvalRequestedEvent(fixture.sessionId, 2, fixture.turnId, approvalRequestId)
    });
    expect(fixture.database.commitAiEvent({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId,
      event: approvalRequestedEvent(fixture.sessionId, 2, fixture.turnId, approvalRequestId)
    })).toBe("duplicate");
    expect(fixture.database.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)?.interactions)
      .toEqual([expect.objectContaining({ id: approvalRequestId, state: "pending", response: null })]);

    const approvalResponded = {
      ...approvalRequestedEvent(fixture.sessionId, 3, fixture.turnId, approvalRequestId),
      eventId: "018f0f00-0000-7000-8000-000000000022",
      eventType: "turn.approval.responded",
      payload: { requestId: approvalRequestId, decision: "approve-once" }
    } as CanonicalAiEvent;
    expect(fixture.database.commitAiEvent({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId, event: approvalResponded
    })).toBe("appended");
    expect(fixture.database.commitAiEvent({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId, event: approvalResponded
    })).toBe("duplicate");

    fixture.database.commitAiEvent({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId,
      event: inputRequestedEvent(fixture.sessionId, 4, fixture.turnId, inputRequestId)
    });
    const inputResponded = {
      ...inputRequestedEvent(fixture.sessionId, 5, fixture.turnId, inputRequestId),
      eventId: "018f0f00-0000-7000-8000-000000000023",
      eventType: "turn.input.responded",
      payload: {
        requestId: inputRequestId,
        answers: [{ questionId: "question-1", kind: "selected", optionId: "option-1" }]
      }
    } as CanonicalAiEvent;
    fixture.database.commitAiEvent({ projectId: fixture.projectId, workspaceId: fixture.workspaceId, event: inputResponded });
    const interactions = fixture.database.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)?.interactions;
    expect(interactions).toEqual([
      expect.objectContaining({ id: approvalRequestId, state: "responded", response: { decision: "approve-once" } }),
      expect.objectContaining({ id: inputRequestId, state: "responded", response: { answers: [{ questionId: "question-1", kind: "selected", optionId: "option-1" }] } })
    ]);
    expect(() => fixture.database.commitAiEvent({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId,
      event: {
        ...inputResponded,
        eventId: "018f0f00-0000-7000-8000-000000000024",
        sequence: 6
      }
    })).toThrow();
  });

  test.each(["turn", "session"] as const)("retires pending interactions when the owning %s becomes terminal", async (cause) => {
    const fixture = await historyFixture();
    const requestId = "018f0f00-0000-7000-8000-000000000025";
    fixture.database.commitAiEvent({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId,
      event: approvalRequestedEvent(fixture.sessionId, 2, fixture.turnId, requestId)
    });
    fixture.database.commitAiEvent({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId,
      event: cause === "turn" ? turnLostEvent(fixture.sessionId, 3, fixture.turnId) : sessionLostEvent(fixture.sessionId, 3)
    });
    expect(fixture.database.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)?.interactions)
      .toEqual([expect.objectContaining({ id: requestId, state: "lost", response: null })]);
  });

  test("stream-first and POST-first each converge to one exact turn row", async () => {
    const streamFirst = await historyFixture(false);
    finishFixtureTurn(streamFirst);
    const streamTurnId = "018f0f00-0000-7000-8000-000000000090";
    streamFirst.database.commitAiEvent({
      projectId: streamFirst.projectId,
      workspaceId: streamFirst.workspaceId,
      event: turnAcceptedEvent(streamFirst.sessionId, 1, streamTurnId, "stream first")
    });
    streamFirst.database.ensureAiTurnAccepted({
      projectId: streamFirst.projectId, workspaceId: streamFirst.workspaceId, sessionId: streamFirst.sessionId,
      turnId: streamTurnId, processGeneration: 1, content: { kind: "text", text: "stream first" }
    });
    expect(streamFirst.database.getAiSession(streamFirst.projectId, streamFirst.workspaceId, streamFirst.sessionId)?.turns
      .filter((turn) => turn.id === streamTurnId)).toHaveLength(1);

    const postFirst = await historyFixture(false);
    finishFixtureTurn(postFirst);
    const postTurnId = "018f0f00-0000-7000-8000-000000000091";
    postFirst.database.ensureAiTurnAccepted({
      projectId: postFirst.projectId, workspaceId: postFirst.workspaceId, sessionId: postFirst.sessionId,
      turnId: postTurnId, processGeneration: 1, content: { kind: "text", text: "post first" }
    });
    postFirst.database.commitAiEvent({
      projectId: postFirst.projectId,
      workspaceId: postFirst.workspaceId,
      event: turnAcceptedEvent(postFirst.sessionId, 1, postTurnId, "post first")
    });
    expect(postFirst.database.getAiSession(postFirst.projectId, postFirst.workspaceId, postFirst.sessionId)?.turns
      .filter((turn) => turn.id === postTurnId)).toHaveLength(1);
  });

  test("an exact duplicate accepted event repairs a missing row without advancing sequence twice", async () => {
    const fixture = await historyFixture(false);
    finishFixtureTurn(fixture);
    const acceptedTurnId = "018f0f00-0000-7000-8000-000000000092";
    const event = turnAcceptedEvent(fixture.sessionId, 1, acceptedTurnId);
    expect(fixture.database.commitAiEvent({ projectId: fixture.projectId, workspaceId: fixture.workspaceId, event })).toBe("appended");
    const raw = new BetterSqlite3(fixture.databasePath);
    raw.prepare("delete from ai_turns where id = ?").run(acceptedTurnId);
    raw.close();
    expect(fixture.database.commitAiEvent({ projectId: fixture.projectId, workspaceId: fixture.workspaceId, event })).toBe("duplicate");
    const view = fixture.database.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)!;
    expect(view.session.lastSequence).toBe(1);
    expect(view.turns.filter((turn) => turn.id === acceptedTurnId)).toHaveLength(1);
  });

  test("conflicting accepted content and exact identity or generation substitution fail closed", async () => {
    const fixture = await historyFixture(false);
    finishFixtureTurn(fixture);
    const acceptedTurnId = "018f0f00-0000-7000-8000-000000000093";
    fixture.database.ensureAiTurnAccepted({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId, sessionId: fixture.sessionId,
      turnId: acceptedTurnId, processGeneration: 1, content: { kind: "text", text: "original" }
    });
    expect(() => fixture.database.ensureAiTurnAccepted({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId, sessionId: fixture.sessionId,
      turnId: acceptedTurnId, processGeneration: 1, content: { kind: "text", text: "substituted" }
    })).toThrow();
    expect(() => fixture.database.ensureAiTurnAccepted({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId, sessionId: fixture.sessionId,
      turnId: acceptedTurnId, processGeneration: 2, content: { kind: "text", text: "original" }
    })).toThrow();
  });

  const laterTurnCases = [
    ["turn.started", {}],
    ["turn.output.delta", { stream: "assistant", text: "not accepted" }],
    ["turn.activity.started", {
      activityId: "018f0f00-0000-7000-8000-000000000095",
      presentation: { kind: "analysis", summary: "not accepted" }
    }],
    ["turn.interrupt.requested", {}],
    ["turn.interrupted", { reason: "provider-confirmed" }],
    ["turn.provider-completed", { outcome: "completed" }],
    ["turn.files.changed", { files: [], truncated: false }],
    ["turn.quiesced", { outcome: "completed" }],
    ["turn.failed", {
      failure: {
        code: "AI_PROVIDER_PROTOCOL_FAILURE",
        category: "protocol-failure",
        incidentId: "018f0f00-0000-7000-8000-000000000096"
      }
    }],
    ["turn.lost", { code: "AGENT_RESTART" }]
  ] as const;

  test.each(laterTurnCases)("rejects %s when no canonical turn.accepted event exists", async (eventType, payload) => {
    const fixture = await historyFixture(false);
    const before = fixture.database.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)!;
    const event = {
      schemaVersion: "devspace.ai-event/v1",
      eventId: "018f0f00-0000-7000-8000-000000000097",
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      sequence: 1,
      observedAt: timestamp,
      profile: { profileId: "codex", profileRevision, provider: "codex" },
      processGeneration: 1,
      eventType,
      payload
    } as CanonicalAiEvent;

    expect(() => fixture.database.commitAiEvent({
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      event
    })).toThrow();

    expect(fixture.database.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)).toEqual(before);
  });

  test("does not acknowledge a later turn event rejected for missing canonical acceptance", async () => {
    const fixture = await historyFixture(false);
    const event = outputEvent(fixture.sessionId, 1, fixture.turnId);
    const agent = fakeAgent();
    agent.streamAiEvents.mockImplementation((async function* () {
      await Promise.resolve();
      yield event;
    }) as never);

    await expect(streamAiEvents(
      fixture.projectId,
      fixture.workspaceId,
      fixture.sessionId,
      0,
      { database: fixture.database, agent } as never
    ).next()).rejects.toThrow();
    expect(agent.acknowledgeAiEvents).not.toHaveBeenCalled();
  });
});

describe("SQLite stopped-session restart fencing", () => {
  test("does not create a turn row for a stopped session", async () => {
    const fixture = await stoppedHistoryFixture();
    const before = fixture.database.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)!.turns;
    expect(() => fixture.database.createAiTurn({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId, sessionId: fixture.sessionId,
      turnId: "018f0f00-0000-7000-8000-000000000099", content: { kind: "text", text: "must not persist" }
    })).toThrow();
    expect(fixture.database.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)?.turns).toEqual(before);
  });

  test("moves only the exact stopped session to creating without changing its durable history", async () => {
    const fixture = await stoppedHistoryFixture();
    const before = fixture.database.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)!;

    const prepared = fixture.database.prepareAiSessionRestart({
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      profileId: "codex",
      profileRevision
    });

    const after = fixture.database.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)!;
    expect(prepared).toMatchObject({ id: fixture.sessionId, state: "creating", processGeneration: 1, lastSequence: 4 });
    expect(after.session.id).toBe(before.session.id);
    expect(after.session.state).toBe("creating");
    expect(after.turns).toEqual(before.turns);
    expect(after.events).toEqual(before.events);
    expect(after.session.title).toBe(before.session.title);
  });

  test("terminal-projects a provably noncanonical legacy orphan but preserves a canonical active turn blocker", async () => {
    const orphan = await stoppedHistoryFixture();
    const orphanTurnId = "018f0f00-0000-7000-8000-000000000094";
    const orphanRaw = new BetterSqlite3(orphan.databasePath);
    orphanRaw.prepare(`
      insert into ai_turns
        (id, session_id, state, content_json, output_text, output_truncated, changed_files_json, failure_json, created_at, updated_at, completed_at)
      values (?, ?, 'accepted', ?, '', 0, ?, null, ?, ?, null)
    `).run(orphanTurnId, orphan.sessionId, JSON.stringify({ kind: "text", text: "legacy intent" }),
      JSON.stringify({ files: [], truncated: false }), timestamp, timestamp);
    orphanRaw.close();
    expect(() => orphan.database.prepareAiSessionRestart({
      projectId: orphan.projectId, workspaceId: orphan.workspaceId, sessionId: orphan.sessionId,
      profileId: "codex", profileRevision
    })).not.toThrow();
    expect(orphan.database.getAiSession(orphan.projectId, orphan.workspaceId, orphan.sessionId)?.turns
      .find((turn) => turn.id === orphanTurnId)?.state).toBe("failed");

    const canonical = await historyFixture();
    canonical.database.commitAiEvent({
      projectId: canonical.projectId, workspaceId: canonical.workspaceId,
      event: turnAcceptedEvent(canonical.sessionId, 1, canonical.turnId, "produce a bounded answer")
    });
    canonical.database.commitAiEvent({
      projectId: canonical.projectId, workspaceId: canonical.workspaceId,
      event: sessionEvent(canonical.sessionId, 2, "session.stopping", 1)
    });
    canonical.database.commitAiEvent({
      projectId: canonical.projectId, workspaceId: canonical.workspaceId,
      event: sessionEvent(canonical.sessionId, 3, "session.stopped", 1)
    });
    const canonicalRaw = new BetterSqlite3(canonical.databasePath);
    canonicalRaw.prepare(`
      insert into runtime_stacks
        (id, workspace_id, runtime_namespace, runtime_plan_hash, desired_state, observed_state, runtime_generation, created_at, updated_at)
      select ?, workspace_id, 'workspace-runtime:' || workspace_id, runtime_plan_hash, 'running', 'running', runtime_generation, ?, ?
      from ai_sessions where id = ?
    `).run("018f0f00-0000-7000-8000-000000000097", timestamp, timestamp, canonical.sessionId);
    canonicalRaw.close();
    expect(() => canonical.database.prepareAiSessionRestart({
      projectId: canonical.projectId, workspaceId: canonical.workspaceId, sessionId: canonical.sessionId,
      profileId: "codex", profileRevision
    })).toThrow();
    expect(canonical.database.getAiSession(canonical.projectId, canonical.workspaceId, canonical.sessionId)?.turns[0]?.state).toBe("accepted");
  });

  test("rejects changed profile/runtime identity and process-generation overflow", async () => {
    const profileFixture = await stoppedHistoryFixture();
    expect(() => profileFixture.database.prepareAiSessionRestart({
      projectId: profileFixture.projectId, workspaceId: profileFixture.workspaceId, sessionId: profileFixture.sessionId,
      profileId: "codex", profileRevision: `sha256-ai-profile-v1:${"c".repeat(64)}`
    })).toThrow();

    const runtimeFixture = await stoppedHistoryFixture();
    const runtimeRaw = new BetterSqlite3(runtimeFixture.databasePath);
    runtimeRaw.prepare("update runtime_stacks set runtime_generation = runtime_generation + 1 where workspace_id = ?")
      .run(runtimeFixture.workspaceId);
    runtimeRaw.close();
    expect(() => runtimeFixture.database.prepareAiSessionRestart({
      projectId: runtimeFixture.projectId, workspaceId: runtimeFixture.workspaceId, sessionId: runtimeFixture.sessionId,
      profileId: "codex", profileRevision
    })).toThrow();

    const overflowFixture = await stoppedHistoryFixture();
    const overflowRaw = new BetterSqlite3(overflowFixture.databasePath);
    overflowRaw.prepare("update ai_sessions set process_generation = ? where id = ?")
      .run(Number.MAX_SAFE_INTEGER, overflowFixture.sessionId);
    overflowRaw.close();
    expect(() => overflowFixture.database.prepareAiSessionRestart({
      projectId: overflowFixture.projectId, workspaceId: overflowFixture.workspaceId, sessionId: overflowFixture.sessionId,
      profileId: "codex", profileRevision
    })).toThrow();
  });

  test("advances generation only on the next canonical started event and fences older or future generations", async () => {
    const fixture = await stoppedHistoryFixture();
    const prepared = fixture.database.prepareAiSessionRestart({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId, sessionId: fixture.sessionId,
      profileId: "codex", profileRevision
    });
    const started = sessionEvent(fixture.sessionId, 5, "session.started", 2);

    expect(fixture.database.commitAiEvent({ projectId: fixture.projectId, workspaceId: fixture.workspaceId, event: started })).toBe("appended");
    expect(fixture.database.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)?.session)
      .toMatchObject({ state: "creating", processGeneration: 2, lastSequence: 5 });
    expect(fixture.database.commitAiEvent({ projectId: fixture.projectId, workspaceId: fixture.workspaceId, event: started })).toBe("duplicate");
    expect(fixture.database.rollbackAiSessionRestart({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId, sessionId: fixture.sessionId,
      expectedUpdatedAt: prepared.updatedAt, expectedLastSequence: prepared.lastSequence, expectedProcessGeneration: prepared.processGeneration
    })).toBe(false);
    expect(() => fixture.database.commitAiEvent({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId,
      event: sessionEvent(fixture.sessionId, 6, "session.ready", 1)
    })).toThrow();
    expect(() => fixture.database.commitAiEvent({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId,
      event: sessionEvent(fixture.sessionId, 6, "session.ready", 3)
    })).toThrow();
    expect(fixture.database.commitAiEvent({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId,
      event: sessionEvent(fixture.sessionId, 6, "session.ready", 2)
    })).toBe("appended");
    expect(fixture.database.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)?.session.state).toBe("active");
  });

  test("requires an initial generation-one started event", async () => {
    const fixture = await historyFixture(false);
    const raw = new BetterSqlite3(fixture.databasePath);
    raw.prepare("update ai_sessions set state = 'creating' where id = ?").run(fixture.sessionId);
    raw.close();
    expect(() => fixture.database.commitAiEvent({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId,
      event: sessionEvent(fixture.sessionId, 1, "session.started", 2)
    })).toThrow();
    expect(fixture.database.commitAiEvent({
      projectId: fixture.projectId, workspaceId: fixture.workspaceId,
      event: sessionEvent(fixture.sessionId, 1, "session.started", 1)
    })).toBe("appended");
    expect(fixture.database.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)?.session.processGeneration).toBe(1);
  });

  test("defensively rejects mismatched started payload generations before any SQLite mutation", async () => {
    const initial = await historyFixture(false);
    const initialRaw = new BetterSqlite3(initial.databasePath);
    initialRaw.prepare("update ai_sessions set state = 'creating' where id = ?").run(initial.sessionId);
    initialRaw.close();
    const beforeInitial = initial.database.getAiSession(initial.projectId, initial.workspaceId, initial.sessionId);
    const initialMismatch = {
      ...sessionEvent(initial.sessionId, 1, "session.started", 1),
      payload: { processGeneration: 2 }
    } as CanonicalAiEvent;
    expect(() => initial.database.commitAiEvent({
      projectId: initial.projectId,
      workspaceId: initial.workspaceId,
      event: initialMismatch
    })).toThrow();
    expect(initial.database.getAiSession(initial.projectId, initial.workspaceId, initial.sessionId)).toEqual(beforeInitial);

    const restarted = await stoppedHistoryFixture();
    restarted.database.prepareAiSessionRestart({
      projectId: restarted.projectId,
      workspaceId: restarted.workspaceId,
      sessionId: restarted.sessionId,
      profileId: "codex",
      profileRevision
    });
    const beforeRestart = restarted.database.getAiSession(restarted.projectId, restarted.workspaceId, restarted.sessionId);
    const restartMismatch = {
      ...sessionEvent(restarted.sessionId, 5, "session.started", 2),
      payload: { processGeneration: 1 }
    } as CanonicalAiEvent;
    expect(() => restarted.database.commitAiEvent({
      projectId: restarted.projectId,
      workspaceId: restarted.workspaceId,
      event: restartMismatch
    })).toThrow();
    expect(restarted.database.getAiSession(restarted.projectId, restarted.workspaceId, restarted.sessionId)).toEqual(beforeRestart);

    const duplicate = await historyFixture(false);
    const duplicateRaw = new BetterSqlite3(duplicate.databasePath);
    duplicateRaw.prepare("update ai_sessions set state = 'creating' where id = ?").run(duplicate.sessionId);
    duplicateRaw.close();
    const valid = sessionEvent(duplicate.sessionId, 1, "session.started", 1);
    duplicate.database.commitAiEvent({
      projectId: duplicate.projectId,
      workspaceId: duplicate.workspaceId,
      event: valid
    });
    const beforeDuplicate = duplicate.database.getAiSession(duplicate.projectId, duplicate.workspaceId, duplicate.sessionId);
    expect(() => duplicate.database.commitAiEvent({
      projectId: duplicate.projectId,
      workspaceId: duplicate.workspaceId,
      event: { ...valid, payload: { processGeneration: 2 } } as CanonicalAiEvent
    })).toThrow();
    expect(duplicate.database.getAiSession(duplicate.projectId, duplicate.workspaceId, duplicate.sessionId)).toEqual(beforeDuplicate);
  });
});

describe("SQLite AI aggregate bounds", () => {
  test("truncates one delta that crosses an already full turn aggregate", async () => {
    const fixture = await historyFixture();
    fixture.database.close();
    const raw = new BetterSqlite3(fixture.databasePath);
    raw.prepare("update ai_turns set output_text = ?, output_truncated = 0 where id = ?")
      .run("x".repeat(AI_TURN_OUTPUT_MAX_BYTES - 8), fixture.turnId);
    raw.close();
    const reopened = openProjectDatabase(fixture.databasePath);
    reopened.commitAiEvent({
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      event: outputEvent(reopened.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)!.session.id, 2, fixture.turnId)
    });
    const loaded = reopened.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)!;
    expect(utf8ByteLength(loaded.turns[0]!.outputText)).toBe(AI_TURN_OUTPUT_MAX_BYTES);
    expect(loaded.turns[0]!.outputTruncated).toBe(true);
    reopened.close();
  });

  test("does not let many small output deltas exceed the 2 MiB per-turn aggregate bound", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "devspace-ai-history-red-"));
    directories.push(directory);
    const databasePath = path.join(directory, "devspace.sqlite");
    const database = openProjectDatabase(databasePath);
    const project = database.createProject({
      name: "AI history test",
      slug: "ai-history-test",
      repositoryUrl: "https://example.test/ai-history.git",
      defaultBranch: "main",
      actor: "owner"
    });
    const setup = await setupPrimaryWorkspace({ imageReference: "node:24-bookworm" }, project.id, "owner", {
      database,
      agent: successfulSetupAgent(),
      nowMonotonic: () => 0,
      sleep: () => Promise.resolve()
    });
    const primaryWorkspace = setup.project.primaryWorkspace;
    if (primaryWorkspace === null) throw new Error("Expected a primary workspace.");
    const created = database.createAiSession({
      projectId: project.id,
      workspaceId: primaryWorkspace.id,
      profileId: "codex",
      profileRevision
    });
    const raw = new BetterSqlite3(databasePath);
    raw.prepare("update ai_sessions set state = 'active' where id = ?").run(created.id);
    raw.close();
    const createdTurnId = "018f0f00-0000-7000-8000-000000000009";
    database.createAiTurn({
      projectId: project.id,
      workspaceId: primaryWorkspace.id,
      sessionId: created.id,
      turnId: createdTurnId,
      content: { kind: "text", text: "produce a bounded answer" }
    });
    database.commitAiEvent({
      projectId: project.id,
      workspaceId: primaryWorkspace.id,
      event: turnAcceptedEvent(created.id, 1, createdTurnId, "produce a bounded answer")
    });
    for (let sequence = 2; sequence <= 34; sequence += 1) {
      database.commitAiEvent({
        projectId: project.id,
        workspaceId: primaryWorkspace.id,
        event: outputEvent(created.id, sequence, createdTurnId)
      });
    }
    const loaded = (database as unknown as { getAiSession: (projectId: string, workspaceId: string, sessionId: string) => {
      turns: Array<{ outputText: string; outputTruncated?: boolean }>;
    } | null }).getAiSession(project.id, primaryWorkspace.id, created.id);
    expect(loaded).not.toBeNull();
    expect(Buffer.byteLength(loaded!.turns[0]!.outputText, "utf8")).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(loaded!.turns[0]!.outputTruncated).toBe(true);
    database.close();
  });

  test("keeps multibyte output valid at the aggregate boundary", async () => {
    const fixture = await historyFixture();
    const delta = "😀".repeat(16_384);
    for (let sequence = 1; sequence <= 33; sequence += 1) {
      const event = outputEvent(fixture.sessionId, sequence + 1, fixture.turnId);
      fixture.database.commitAiEvent({
        projectId: fixture.projectId,
        workspaceId: fixture.workspaceId,
        event: { ...event, payload: { stream: "assistant", text: sequence === 33 ? "é" : delta } } as CanonicalAiEvent
      });
    }
    const loaded = fixture.database.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId);
    const output = loaded!.turns[0]!;
    expect(utf8ByteLength(output.outputText)).toBeLessThanOrEqual(AI_TURN_OUTPUT_MAX_BYTES);
    expect(output.outputText).not.toContain("�");
    expect(output.outputTruncated).toBe(true);
    fixture.database.close();
  }, 30_000);

  test("keeps the session output aggregate bounded across retained turns", async () => {
    const fixture = await historyFixture();
    let sequence = 1;
    for (let turnIndex = 0; turnIndex < 5; turnIndex += 1) {
      const raw = new BetterSqlite3(fixture.databasePath);
      raw.prepare("update ai_turns set state = 'completed', completed_at = ? where session_id = ? and state in ('accepted', 'running')")
        .run(timestamp, fixture.sessionId);
      raw.close();
      const currentTurnId = `018f0f00-0000-7000-8000-${(100 + turnIndex).toString(16).padStart(12, "0")}`;
      fixture.database.createAiTurn({
        projectId: fixture.projectId, workspaceId: fixture.workspaceId, sessionId: fixture.sessionId,
        turnId: currentTurnId, content: { kind: "text", text: `turn ${turnIndex}` }
      });
      fixture.database.commitAiEvent({
        projectId: fixture.projectId,
        workspaceId: fixture.workspaceId,
        event: turnAcceptedEvent(fixture.sessionId, ++sequence, currentTurnId, `turn ${turnIndex}`)
      });
      for (let deltaIndex = 1; deltaIndex <= 33; deltaIndex += 1) {
        fixture.database.commitAiEvent({
          projectId: fixture.projectId,
          workspaceId: fixture.workspaceId,
          event: outputEvent(fixture.sessionId, ++sequence, currentTurnId)
        });
      }
    }
    const loaded = fixture.database.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)!;
    const totalOutputBytes = loaded.turns.reduce((total, turn) => total + utf8ByteLength(turn.outputText), 0);
    expect(totalOutputBytes).toBeLessThanOrEqual(AI_SESSION_OUTPUT_MAX_BYTES);
    expect(loaded.turns.some((turn) => turn.outputTruncated)).toBe(true);
    fixture.database.close();
  }, 30_000);

  test("retains one contiguous event suffix while preserving terminal aggregate state", async () => {
    const fixture = await historyFixture();
    const eventCount = AI_SESSION_EVENT_HISTORY_MAX_EVENTS + 2;
    fixture.database.close();
    const raw = new BetterSqlite3(fixture.databasePath);
    const insert = raw.transaction(() => {
      const statement = raw.prepare(`
        insert into ai_events (event_id, session_id, turn_id, sequence, event_type, event_json, observed_at)
        values (?, ?, ?, ?, ?, ?, ?)
      `);
      for (let sequence = 2; sequence <= eventCount + 1; sequence += 1) {
        const event = turnStartedEvent(fixture.sessionId, sequence, fixture.turnId);
        statement.run(event.eventId, event.sessionId, event.turnId, event.sequence, event.eventType, JSON.stringify(event), event.observedAt);
      }
      raw.prepare("update ai_sessions set last_sequence = ? where id = ?").run(eventCount + 1, fixture.sessionId);
    });
    insert();
    raw.close();
    const database = openProjectDatabase(fixture.databasePath);
    const providerSequence = eventCount + 2;
    const filesSequence = eventCount + 3;
    const terminalSequence = eventCount + 4;
    const terminalBase = turnQuiescedEvent(fixture.sessionId, terminalSequence, fixture.turnId);
    database.commitAiEvent({
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      event: {
        ...terminalBase,
        eventId: `018f0f00-0000-7000-8000-${(40_000 + providerSequence).toString(16).padStart(12, "0")}`,
        sequence: providerSequence,
        eventType: "turn.provider-completed",
        payload: { outcome: "completed" }
      } as CanonicalAiEvent
    });
    database.commitAiEvent({
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      event: {
        ...terminalBase,
        eventId: `018f0f00-0000-7000-8000-${(40_000 + filesSequence).toString(16).padStart(12, "0")}`,
        sequence: filesSequence,
        eventType: "turn.files.changed",
        payload: { files: [], truncated: false }
      } as CanonicalAiEvent
    });
    database.commitAiEvent({
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      event: turnQuiescedEvent(fixture.sessionId, terminalSequence, fixture.turnId)
    });
    const loaded = database.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)!;
    const sequences = loaded.events.map((event) => event.sequence);
    expect(sequences).toHaveLength(AI_SESSION_EVENT_HISTORY_MAX_EVENTS);
    expect(sequences[0]).toBe(terminalSequence - AI_SESSION_EVENT_HISTORY_MAX_EVENTS + 1);
    expect(sequences.at(-1)).toBe(terminalSequence);
    expect(sequences.every((sequence, index) => index === 0 || sequence === sequences[index - 1]! + 1)).toBe(true);
    expect(loaded.session.historyStartSequence).toBe(sequences[0]);
    expect(loaded.session.historyTruncated).toBe(true);
    expect(loaded.turns[0]?.state).toBe("completed");
    expect(serializedBytes(loaded)).toBeLessThanOrEqual(AI_SESSION_RESPONSE_MAX_BYTES);
    await expect(streamAiEvents(
      fixture.projectId, fixture.workspaceId, fixture.sessionId, sequences[0]! - 2,
      { database, agent: fakeAgent() } as never
    ).next()).rejects.toMatchObject({ code: "AI_SESSION_CONFLICT" });
    database.close();
  }, 30_000);

  test("normalizes the real inner response projection without rewriting SQLite history metadata", async () => {
    const fixture = await historyFixture();
    fixture.database.close();
    const raw = new BetterSqlite3(fixture.databasePath);
    const secondTurnId = "018f0f00-0000-7000-8000-000000000010";
    const output = "x".repeat(1_800_000);
    raw.prepare(`
      insert into ai_turns (id, session_id, state, content_json, output_text, output_truncated, changed_files_json, failure_json, created_at, updated_at, completed_at)
      values (?, ?, 'completed', ?, ?, 0, ?, null, ?, ?, ?)
    `).run(secondTurnId, fixture.sessionId, JSON.stringify({ kind: "text", text: "second" }), output,
      JSON.stringify({ files: [], truncated: false }), timestamp, timestamp, timestamp);
    raw.prepare("update ai_turns set output_text = ?, output_truncated = 0 where id = ?")
      .run(output, fixture.turnId);
    const requestJson = JSON.stringify({ text: "x".repeat(120_000) });
    const insertInteraction = raw.prepare(`
      insert into ai_interaction_requests (id, session_id, turn_id, kind, state, request_json, response_json, created_at, updated_at)
      values (?, ?, ?, 'input', 'pending', ?, null, ?, ?)
    `);
    for (let index = 0; index < 33; index += 1) {
      const interactionId = `018f0f00-0000-7000-8000-${(40_000 + index).toString(16).padStart(12, "0")}`;
      insertInteraction.run(interactionId, fixture.sessionId, fixture.turnId, requestJson, timestamp, timestamp);
    }
    const largeEvent = { ...outputEvent(fixture.sessionId, 42, fixture.turnId), payload: { stream: "assistant", text: "x".repeat(1_000_000) } };
    raw.prepare(`
      insert into ai_events (event_id, session_id, turn_id, sequence, event_type, event_json, observed_at)
      values (?, ?, ?, ?, ?, ?, ?)
    `).run(largeEvent.eventId, largeEvent.sessionId, largeEvent.turnId, largeEvent.sequence, largeEvent.eventType,
      JSON.stringify(largeEvent), largeEvent.observedAt);
    raw.prepare("delete from ai_events where session_id = ? and event_type = 'turn.accepted'").run(fixture.sessionId);
    raw.prepare("update ai_sessions set last_sequence = 42, history_start_sequence = 1, history_truncated = 0 where id = ?")
      .run(fixture.sessionId);
    raw.close();

    const reopened = openProjectDatabase(fixture.databasePath);
    const loaded = reopened.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)!;
    expect(loaded.session.id).toBe(fixture.sessionId);
    expect(loaded.session.projectId).toBe(fixture.projectId);
    expect(loaded.session.lastSequence).toBe(42);
    expect(loaded.session.historyTruncated).toBe(true);
    expect(serializedBytes(loaded)).toBeLessThanOrEqual(AI_SESSION_RESPONSE_MAX_BYTES);
    if (loaded.events.length === 0) {
      expect(loaded.session.historyStartSequence).toBe(43);
    } else {
      expect(loaded.events.at(-1)?.sequence).toBe(42);
      expect(loaded.events[0]?.sequence).toBe(loaded.session.historyStartSequence);
      expect(loaded.events.every((event, index) => index === 0 || event.sequence === loaded.events[index - 1]!.sequence + 1)).toBe(true);
    }
    const persisted = new BetterSqlite3(fixture.databasePath);
    expect(persisted.prepare("select history_start_sequence from ai_sessions where id = ?").get(fixture.sessionId))
      .toEqual({ history_start_sequence: 1 });
    persisted.close();
    reopened.close();
  }, 30_000);

  test("normalizes an oversized legacy output row on read and preserves it after reload", async () => {
    const fixture = await historyFixture();
    fixture.database.close();
    const raw = new BetterSqlite3(fixture.databasePath);
    raw.prepare("update ai_turns set output_text = ?, output_truncated = 0 where id = ?")
      .run("😀".repeat(700_000), fixture.turnId);
    raw.close();
    const reopened = openProjectDatabase(fixture.databasePath);
    const first = reopened.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)!;
    expect(utf8ByteLength(first.turns[0]!.outputText)).toBeLessThanOrEqual(AI_TURN_OUTPUT_MAX_BYTES);
    expect(first.turns[0]!.outputText).not.toContain("�");
    expect(first.turns[0]!.outputTruncated).toBe(true);
    const snapshot = JSON.stringify(first);
    reopened.close();
    const reloaded = openProjectDatabase(fixture.databasePath);
    expect(JSON.stringify(reloaded.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId))).toBe(snapshot);
    reloaded.close();
  });

  test("bounds legacy interaction rows by deterministic newest retention and total bytes", async () => {
    const fixture = await historyFixture();
    fixture.database.close();
    const raw = new BetterSqlite3(fixture.databasePath);
    const request = JSON.stringify({ text: "x".repeat(131_000) });
    const insert = raw.prepare(`
      insert into ai_interaction_requests (id, session_id, turn_id, kind, state, request_json, response_json, created_at, updated_at)
      values (?, ?, ?, 'input', 'pending', ?, null, ?, ?)
    `);
    for (let index = 0; index < 40; index += 1) {
      const id = `018f0f00-0000-7000-8000-${(30_000 + index).toString(16).padStart(12, "0")}`;
      insert.run(id, fixture.sessionId, fixture.turnId, request, timestamp, timestamp);
    }
    raw.close();
    const reopened = openProjectDatabase(fixture.databasePath);
    reopened.commitAiEvent({
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      event: turnStartedEvent(fixture.sessionId, 2, fixture.turnId)
    });
    const persisted = new BetterSqlite3(fixture.databasePath);
    expect(persisted.prepare("select count(*) as count from ai_interaction_requests where session_id = ?")
      .get(fixture.sessionId)).toEqual({ count: 32 });
    expect(persisted.prepare("select interaction_history_truncated from ai_sessions where id = ?")
      .get(fixture.sessionId)).toEqual({ interaction_history_truncated: 1 });
    persisted.close();
    const loaded = reopened.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)! as unknown as {
      session: { interactionsTruncated: boolean };
      interactions: Array<{ id: string }>;
    };
    expect(loaded.interactions.length).toBeLessThanOrEqual(40);
    expect(loaded.interactions.length).toBe(32);
    expect(loaded.session.interactionsTruncated).toBe(true);
    expect(loaded.interactions[0]?.id).toBe("018f0f00-0000-7000-8000-000000007538");
    expect(loaded.interactions.at(-1)?.id).toBe("018f0f00-0000-7000-8000-000000007557");
    reopened.close();
  });
});
