import { v7 as uuidv7 } from "uuid";
import { uuidV7Schema, type AiEventStreamFrame, type AiProviderProfileProjection } from "@devspace/contracts";
import type { FullAgentClient } from "./agent-client.js";
import { ProjectSetupConflictError, type ProjectDatabase } from "./database.js";
import { AI_EVENT_STREAM_RESPONSE_MAX_BYTES, AI_EVENT_STREAM_RESPONSE_MAX_EVENTS } from "./ai-history.js";

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
  if (view === null || view.session.id !== sessionId || view.session.workspaceId !== workspaceId) {
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

export async function createAiSession(projectId: string, workspaceId: string, actor: string, dependencies: Dependencies) {
  void actor;
  const profile = await dependencies.agent.inspectAiProvider(projectId, workspaceId, "codex");
  if (profile.availability.state !== "available") throw new AiSessionActionError("AI_PROFILE_UNAVAILABLE", "Codex is unavailable for this workspace.");
  const created = dependencies.database.createAiSession({ projectId, workspaceId, profileId: profile.profileId, profileRevision: profile.profileRevision });
  const operationId = uuidv7();
  const startBinding = { projectId, workspaceId, aiSessionId: created.id, revisionId: created.revisionId, runtimePlanHash: created.runtimePlanHash,
    runtimeGeneration: created.runtimeGeneration, profileId: created.profileKey, profileRevision: created.profileRevision };
  await dependencies.agent.startAiSession(operationId, startBinding);
  return { sessionId: created.id, operationId };
}

export async function sendAiTurn(projectId: string, workspaceId: string, sessionId: string, text: string, dependencies: Dependencies) {
  const view = exactSession(projectId, workspaceId, sessionId, dependencies.database);
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
  exactTurn(projectId, workspaceId, sessionId, turnId, dependencies.database);
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

export async function* streamAiEvents(projectId: string, workspaceId: string, sessionId: string, afterSequence: number, dependencies: Dependencies): AsyncGenerator<AiEventStreamFrame> {
  const view = exactSession(projectId, workspaceId, sessionId, dependencies.database);
  if (afterSequence < view.session.historyStartSequence - 1) {
    throw new AiSessionActionError("AI_SESSION_CONFLICT", "The requested AI event history is no longer retained.");
  }
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
