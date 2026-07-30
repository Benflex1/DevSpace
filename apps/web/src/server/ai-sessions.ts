import { v7 as uuidv7 } from "uuid";
import { uuidV7Schema, type AiEventStreamFrame, type AiProviderProfileProjection } from "@devspace/contracts";
import type { FullAgentClient } from "./agent-client.js";
import { ProjectSetupConflictError, type ProjectDatabase } from "./database.js";
import {
  AI_EVENT_STREAM_RESPONSE_MAX_BYTES,
  AI_EVENT_STREAM_RESPONSE_MAX_EVENTS,
  AI_SESSION_OUTPUT_MAX_BYTES,
  AI_SESSION_RESPONSE_MAX_BYTES,
  AI_TURN_OUTPUT_MAX_BYTES,
  normalizeRetainedHistory,
  serializedBytes,
  truncateUtf8,
  utf8ByteLength
} from "./ai-history.js";

export class AiSessionActionError extends Error {
  constructor(readonly code: "AI_NOT_CONFIGURED" | "AI_PROFILE_UNAVAILABLE" | "AI_SESSION_CONFLICT" | "AI_TURN_CONFLICT", message: string) {
    super(message); this.name = "AiSessionActionError";
  }
}

interface Dependencies { readonly database: ProjectDatabase; readonly agent: FullAgentClient }

function exactSession(projectId: string, workspaceId: string, sessionId: string, database: ProjectDatabase) {
  uuidV7Schema.parse(projectId); uuidV7Schema.parse(workspaceId); uuidV7Schema.parse(sessionId);
  let view: ReturnType<ProjectDatabase["getAiSession"]>;
  try {
    view = database.getAiSession(projectId, workspaceId, sessionId);
  } catch (error) {
    if (error instanceof ProjectSetupConflictError) {
      throw new AiSessionActionError("AI_SESSION_CONFLICT", "The AI session is no longer available.");
    }
    throw error;
  }
  const boundProjectId = (view?.session as { projectId?: unknown } | undefined)?.projectId;
  if (view === null || view.session.id !== sessionId || view.session.workspaceId !== workspaceId
    || (boundProjectId !== undefined && boundProjectId !== projectId)) {
    throw new AiSessionActionError("AI_SESSION_CONFLICT", "The AI session is no longer available.");
  }
  return view;
}

function exactTurn(projectId: string, workspaceId: string, sessionId: string, turnId: string, database: ProjectDatabase) {
  uuidV7Schema.parse(turnId);
  let turn: ReturnType<ProjectDatabase["getAiTurn"]>;
  try {
    turn = database.getAiTurn(projectId, workspaceId, sessionId, turnId);
  } catch (error) {
    if (error instanceof ProjectSetupConflictError) {
      throw new AiSessionActionError("AI_SESSION_CONFLICT", "The AI session is no longer available.");
    }
    throw error;
  }
  if (turn === null) throw new AiSessionActionError("AI_SESSION_CONFLICT", "The AI session is no longer available.");
  return turn;
}

function processBinding(projectId: string, session: { id: string; workspaceId: string; profileId: string; profileRevision: string; processGeneration: number }) {
  return { projectId, workspaceId: session.workspaceId, aiSessionId: session.id, profileId: session.profileId,
    profileRevision: session.profileRevision, processGeneration: session.processGeneration };
}

export async function inspectAiWorkbench(projectId: string, workspaceId: string, sessionId: string | undefined, dependencies: Dependencies): Promise<{
  profile: AiProviderProfileProjection;
  sessions: ReturnType<ProjectDatabase["listAiSessions"]>;
  session: ReturnType<ProjectDatabase["getAiSession"]>;
}> {
  const selected = sessionId === undefined ? null : exactSession(projectId, workspaceId, sessionId, dependencies.database);
  const profile = await dependencies.agent.inspectAiProvider(projectId, workspaceId, "codex");
  const sessions = dependencies.database.listAiSessions(projectId, workspaceId);
  return { profile, sessions, session: selected };
}

type AiWorkbenchProjection = Awaited<ReturnType<typeof inspectAiWorkbench>>;
type AiSelectedSession = NonNullable<AiWorkbenchProjection["session"]>;

function boundResponseTurns(turns: AiSelectedSession["turns"]): AiSelectedSession["turns"] {
  let remaining = AI_SESSION_OUTPUT_MAX_BYTES;
  const bounded = turns.map((turn) => ({ ...turn }));
  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    const turn = bounded[index]!;
    const output = truncateUtf8(turn.outputText, Math.min(AI_TURN_OUTPUT_MAX_BYTES, remaining));
    turn.outputText = output.value;
    turn.outputTruncated = turn.outputTruncated || output.truncated;
    remaining -= utf8ByteLength(output.value);
  }
  return bounded;
}

type ResponseBoundsOptions = { readonly measure?: (value: unknown) => number };

function newestSuffix<T>(items: readonly T[], build: (candidate: T[]) => unknown, measure: (value: unknown) => number, minimum = 0): T[] {
  if (measure(build([...items])) <= AI_SESSION_RESPONSE_MAX_BYTES) return [...items];
  let low = minimum;
  let high = items.length;
  let best = minimum;
  while (low <= high) {
    const retained = Math.floor((low + high) / 2);
    const candidate = items.slice(Math.max(0, items.length - retained));
    if (measure(build(candidate)) <= AI_SESSION_RESPONSE_MAX_BYTES) {
      best = retained; low = retained + 1;
    } else {
      high = retained - 1;
    }
  }
  return items.slice(Math.max(0, items.length - best));
}

function newestPrefix<T>(items: readonly T[], build: (candidate: T[]) => unknown, measure: (value: unknown) => number): T[] {
  if (measure(build([...items])) <= AI_SESSION_RESPONSE_MAX_BYTES) return [...items];
  let low = 0;
  let high = items.length;
  let best = 0;
  while (low <= high) {
    const retained = Math.floor((low + high) / 2);
    const candidate = items.slice(0, retained);
    if (measure(build(candidate)) <= AI_SESSION_RESPONSE_MAX_BYTES) {
      best = retained; low = retained + 1;
    } else {
      high = retained - 1;
    }
  }
  return items.slice(0, best);
}

export function boundAiWorkbenchResponse(data: AiWorkbenchProjection, options: ResponseBoundsOptions = {}): AiWorkbenchProjection {
  const measure = options.measure ?? serializedBytes;
  const source = data.session;
  let session: AiSelectedSession | null = source === null ? null : normalizeRetainedHistory({
    ...source,
    session: { ...source.session },
    turns: boundResponseTurns(source.turns),
    interactions: [...source.interactions],
    events: [...source.events]
  });
  let sessions = [...data.sessions];
  const originalTurnCount = session?.turns.length ?? 0;
  const build = (): AiWorkbenchProjection => ({ ...data, sessions, session });
  const initiallyOversized = measure(build()) > AI_SESSION_RESPONSE_MAX_BYTES;
  if (!initiallyOversized) return build();

  const markHistoryTruncated = () => {
    if (session !== null) session = { ...session, session: { ...session.session, historyTruncated: true } };
  };
  const markInteractionsTruncated = () => {
    if (session !== null) session = { ...session, session: { ...session.session, interactionsTruncated: true } };
  };
  if (session !== null && measure(build()) > AI_SESSION_RESPONSE_MAX_BYTES && session.events.length > 0) {
    const originalEvents = session.events;
    const events = newestSuffix(originalEvents, (candidate) => {
      const historyStartSequence = candidate.length > 0 ? candidate[0]!.sequence : session!.session.lastSequence + 1;
      return { ...session!, events: candidate, session: { ...session!.session, historyTruncated: true, historyStartSequence } };
    }, (candidateSession) => measure({ ...data, sessions, session: candidateSession }), 0);
    const historyStartSequence = events.length > 0 ? events[0]!.sequence : session.session.lastSequence + 1;
    session = { ...session, events, session: { ...session.session, historyTruncated: session.session.historyTruncated || events.length < originalEvents.length,
      historyStartSequence: events.length < originalEvents.length ? historyStartSequence : session.session.historyStartSequence } };
    session = normalizeRetainedHistory(session);
  }
  if (session !== null && measure(build()) > AI_SESSION_RESPONSE_MAX_BYTES && session.interactions.length > 0) {
    const originalInteractions = session.interactions;
    const interactions = newestSuffix(originalInteractions, (candidate) => {
      return { ...session!, interactions: candidate, session: { ...session!.session, interactionsTruncated: true } };
    }, (candidateSession) => measure({ ...data, sessions, session: candidateSession }), 0);
    session = { ...session, interactions, session: { ...session.session, interactionsTruncated: session.session.interactionsTruncated || interactions.length < originalInteractions.length } };
    markInteractionsTruncated();
  }
  if (session !== null && measure(build()) > AI_SESSION_RESPONSE_MAX_BYTES && session.turns.length > 1) {
    const turns = newestSuffix(session.turns, (candidate) => {
      return { ...session!, turns: candidate, session: { ...session!.session, historyTruncated: true } };
    }, (candidateSession) => measure({ ...data, sessions, session: candidateSession }), 1);
    session = { ...session, turns, session: { ...session.session, historyTruncated: session.session.historyTruncated || turns.length < originalTurnCount } };
    markHistoryTruncated();
  }
  if (measure(build()) > AI_SESSION_RESPONSE_MAX_BYTES && sessions.length > 0) {
    sessions = newestPrefix(sessions, (candidate) => ({ ...data, sessions: candidate, session }), measure);
  }
  if (session !== null) session = normalizeRetainedHistory(session);
  return build();
}

export async function createAiSession(projectId: string, workspaceId: string, actor: string, dependencies: Dependencies) {
  void actor;
  const profile = await dependencies.agent.inspectAiProvider(projectId, workspaceId, "codex");
  if (profile.availability.state !== "available") throw new AiSessionActionError("AI_PROFILE_UNAVAILABLE", "Codex is unavailable for this workspace.");
  const initial = dependencies.database.createInitialAiSession({ projectId, workspaceId, profileId: profile.profileId, profileRevision: profile.profileRevision });
  const created = initial.session;
  if (!initial.created) return { sessionId: created.id, operationId: null };
  const operationId = uuidv7();
  const startBinding = { projectId, workspaceId, aiSessionId: created.id, revisionId: created.revisionId, runtimePlanHash: created.runtimePlanHash,
    runtimeGeneration: created.runtimeGeneration, profileId: created.profileKey, profileRevision: created.profileRevision };
  await dependencies.agent.startAiSession(operationId, startBinding);
  return { sessionId: created.id, operationId };
}

export async function restartAiSession(projectId: string, workspaceId: string, sessionId: string, dependencies: Dependencies) {
  const selected = exactSession(projectId, workspaceId, sessionId, dependencies.database);
  if (selected.session.state !== "stopped") {
    throw new AiSessionActionError("AI_SESSION_CONFLICT", "Only a stopped AI session can be started again.");
  }
  const profile = await dependencies.agent.inspectAiProvider(projectId, workspaceId, "codex");
  if (profile.availability.state !== "available") {
    throw new AiSessionActionError("AI_PROFILE_UNAVAILABLE", "Codex is unavailable for this workspace.");
  }
  if (profile.profileId !== selected.session.profileId || profile.profileRevision !== selected.session.profileRevision) {
    throw new AiSessionActionError("AI_SESSION_CONFLICT", "The stopped AI session no longer matches this workspace.");
  }
  let prepared: ReturnType<ProjectDatabase["prepareAiSessionRestart"]>;
  try {
    prepared = dependencies.database.prepareAiSessionRestart({
      projectId, workspaceId, sessionId, profileId: profile.profileId, profileRevision: profile.profileRevision
    });
  } catch (error) {
    if (error instanceof ProjectSetupConflictError) {
      throw new AiSessionActionError("AI_SESSION_CONFLICT", "The stopped AI session can no longer be started again.");
    }
    throw error;
  }
  const operationId = uuidv7();
  const startBinding = {
    projectId, workspaceId, aiSessionId: prepared.id, revisionId: prepared.revisionId,
    runtimePlanHash: prepared.runtimePlanHash, runtimeGeneration: prepared.runtimeGeneration,
    profileId: prepared.profileKey, profileRevision: prepared.profileRevision
  };
  try {
    await dependencies.agent.startAiSession(operationId, startBinding);
  } catch (error) {
    dependencies.database.rollbackAiSessionRestart({
      projectId, workspaceId, sessionId, expectedUpdatedAt: prepared.updatedAt,
      expectedLastSequence: prepared.lastSequence, expectedProcessGeneration: prepared.processGeneration
    });
    throw error;
  }
  return { sessionId, operationId };
}

export async function sendAiTurn(projectId: string, workspaceId: string, sessionId: string, text: string, dependencies: Dependencies) {
  const view = exactSession(projectId, workspaceId, sessionId, dependencies.database);
  if (view.session.state !== "active") {
    throw new AiSessionActionError("AI_SESSION_CONFLICT", "The AI session is not accepting turns.");
  }
  const turnId = uuidv7();
  try {
    dependencies.database.createAiTurn({ projectId, workspaceId, sessionId, turnId, content: { kind: "text", text } });
  } catch (error) {
    if (error instanceof ProjectSetupConflictError) {
      throw new AiSessionActionError("AI_SESSION_CONFLICT", "The AI session is no longer available.");
    }
    throw error;
  }
  const operationId = uuidv7();
  const session = view.session;
  await dependencies.agent.sendAiTurn(operationId, { ...processBinding(projectId, session), turnId, content: { kind: "text", text } });
  return { turnId, operationId };
}

export async function interruptAiTurn(projectId: string, workspaceId: string, sessionId: string, turnId: string, dependencies: Dependencies) {
  const view = exactSession(projectId, workspaceId, sessionId, dependencies.database);
  if (view.session.state !== "active") {
    throw new AiSessionActionError("AI_SESSION_CONFLICT", "The AI session does not have an interruptible turn.");
  }
  const turn = exactTurn(projectId, workspaceId, sessionId, turnId, dependencies.database);
  if (turn.state !== "running") {
    throw new AiSessionActionError("AI_TURN_CONFLICT", "The AI turn is not active.");
  }
  const operationId = uuidv7(); const session = view.session;
  await dependencies.agent.interruptAiTurn(operationId, { ...processBinding(projectId, session), turnId });
  return { operationId };
}

export async function stopAiSession(projectId: string, workspaceId: string, sessionId: string, dependencies: Dependencies) {
  const view = exactSession(projectId, workspaceId, sessionId, dependencies.database);
  const operationId = uuidv7(); const session = view.session;
  await dependencies.agent.stopAiSession(operationId, processBinding(projectId, session));
  return { operationId };
}

export type AiEventStreamPreflight = ReturnType<typeof exactSession>;

export function preflightAiEventStream(projectId: string, workspaceId: string, sessionId: string, afterSequence: number, dependencies: Dependencies): AiEventStreamPreflight {
  const view = exactSession(projectId, workspaceId, sessionId, dependencies.database);
  if (afterSequence < view.session.historyStartSequence - 1) {
    throw new AiSessionActionError("AI_SESSION_CONFLICT", "The requested AI event history is no longer retained.");
  }
  return view;
}

export async function* streamAiEvents(projectId: string, workspaceId: string, sessionId: string, afterSequence: number, dependencies: Dependencies,
  preflight?: AiEventStreamPreflight): AsyncGenerator<AiEventStreamFrame> {
  const view = preflight ?? preflightAiEventStream(projectId, workspaceId, sessionId, afterSequence, dependencies);
  let frameCount = 0;
  let frameBytes = 0;
  const canYield = (frame: AiEventStreamFrame): boolean => {
    const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8") + 1;
    if (frameCount >= AI_EVENT_STREAM_RESPONSE_MAX_EVENTS || frameBytes + bytes > AI_EVENT_STREAM_RESPONSE_MAX_BYTES) return false;
    frameCount += 1; frameBytes += bytes;
    return true;
  };
  for (const event of view.events.filter((candidate) => candidate.sequence > afterSequence)) {
    if (!canYield(event)) return;
    yield event;
  }
  for await (const frame of dependencies.agent.streamAiEvents(view.session.id, view.session.lastSequence)) {
    if ("frameType" in frame) {
      if (!canYield(frame)) return;
      yield frame; continue;
    }
    const result = dependencies.database.commitAiEvent({ projectId, workspaceId, event: frame });
    await dependencies.agent.acknowledgeAiEvents({ projectId, workspaceId, aiSessionId: view.session.id, throughSequence: frame.sequence, throughEventId: frame.eventId });
    if (result === "appended" && frame.sequence > afterSequence) {
      if (!canYield(frame)) return;
      yield frame;
    }
  }
}

export function toAiActionError(error: unknown): AiSessionActionError {
  if (error instanceof AiSessionActionError) return error;
  if (error instanceof ProjectSetupConflictError) return new AiSessionActionError("AI_NOT_CONFIGURED", error.message);
  return new AiSessionActionError("AI_SESSION_CONFLICT", "The AI session action could not be completed safely.");
}
