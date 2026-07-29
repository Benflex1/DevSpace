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
import { openProjectDatabase } from "./database.js";
import { inspectAiWorkbench, interruptAiTurn, sendAiTurn, stopAiSession, streamAiEvents } from "./ai-sessions.js";
import {
  AI_SESSION_EVENT_HISTORY_MAX_EVENTS,
  AI_SESSION_OUTPUT_MAX_BYTES,
  AI_SESSION_RESPONSE_MAX_BYTES,
  AI_TURN_OUTPUT_MAX_BYTES,
  serializedBytes,
  utf8ByteLength
} from "./ai-history.js";
import { setupPrimaryWorkspace, type WorkspaceSetupAgent } from "./workspace-setup.js";

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
      requestedSessionId === sessionAId && requestedTurnId === turnId ? { id: turnId, sessionId: sessionAId } : null),
    createAiTurn: vi.fn(() => undefined),
    commitAiEvent: vi.fn(() => "appended" as const)
  };
  return { agent, database };
}

test("binds a supplied older session instead of acting on the newer workspace session", async () => {
  const agent = fakeAgent();
  const database = {
    getAiSession: vi.fn((_project: string, _workspace: string, requestedSessionId?: string) =>
      requestedSessionId === sessionAId ? view(sessionAId) : view(sessionBId)),
    createAiTurn: vi.fn(() => undefined)
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
  expect(agent.streamAiEvents).toHaveBeenCalledWith(sessionAId, 0);
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
      createAiTurn: vi.fn()
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

async function historyFixture() {
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
  const createdTurnId = `018f0f00-0000-7000-8000-${(10 + directories.length).toString(16).padStart(12, "0")}`;
  database.createAiTurn({
    projectId: project.id,
    workspaceId: primaryWorkspace.id,
    sessionId: created.id,
    turnId: createdTurnId,
    content: { kind: "text", text: "produce a bounded answer" }
  });
  return { database, databasePath, projectId: project.id, workspaceId: primaryWorkspace.id, sessionId: created.id, turnId: createdTurnId };
}

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
      event: outputEvent(reopened.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)!.session.id, 1, fixture.turnId)
    });
    const loaded = reopened.getAiSession(fixture.projectId, fixture.workspaceId, fixture.sessionId)!;
    expect(utf8ByteLength(loaded.turns[0]!.outputText)).toBe(AI_TURN_OUTPUT_MAX_BYTES);
    expect(loaded.turns[0]!.outputTruncated).toBe(true);
    reopened.close();
  });

  test("does not let many small output deltas exceed the 2 MiB per-turn aggregate bound", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "devspace-ai-history-red-"));
    directories.push(directory);
    const database = openProjectDatabase(path.join(directory, "devspace.sqlite"));
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
    const createdTurnId = "018f0f00-0000-7000-8000-000000000009";
    database.createAiTurn({
      projectId: project.id,
      workspaceId: primaryWorkspace.id,
      sessionId: created.id,
      turnId: createdTurnId,
      content: { kind: "text", text: "produce a bounded answer" }
    });
    for (let sequence = 1; sequence <= 33; sequence += 1) {
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
      const event = outputEvent(fixture.sessionId, sequence, fixture.turnId);
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
    for (let turnIndex = 0; turnIndex < 5; turnIndex += 1) {
      const currentTurnId = `018f0f00-0000-7000-8000-${(100 + turnIndex).toString(16).padStart(12, "0")}`;
      fixture.database.createAiTurn({
        projectId: fixture.projectId, workspaceId: fixture.workspaceId, sessionId: fixture.sessionId,
        turnId: currentTurnId, content: { kind: "text", text: `turn ${turnIndex}` }
      });
      for (let deltaIndex = 1; deltaIndex <= 33; deltaIndex += 1) {
        const sequence = turnIndex * 33 + deltaIndex;
        fixture.database.commitAiEvent({
          projectId: fixture.projectId,
          workspaceId: fixture.workspaceId,
          event: outputEvent(fixture.sessionId, sequence, currentTurnId)
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
      for (let sequence = 1; sequence <= eventCount; sequence += 1) {
        const event = turnStartedEvent(fixture.sessionId, sequence, fixture.turnId);
        statement.run(event.eventId, event.sessionId, event.turnId, event.sequence, event.eventType, JSON.stringify(event), event.observedAt);
      }
      raw.prepare("update ai_sessions set last_sequence = ? where id = ?").run(eventCount, fixture.sessionId);
    });
    insert();
    raw.close();
    const database = openProjectDatabase(fixture.databasePath);
    const terminalSequence = eventCount + 1;
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
      event: turnStartedEvent(fixture.sessionId, 1, fixture.turnId)
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
