import { v7 as uuidv7 } from "uuid";
import type { AiEventStreamFrame, AiProviderProfileProjection } from "@devspace/contracts";
import type { FullAgentClient } from "./agent-client.js";
import { ProjectSetupConflictError, type ProjectDatabase } from "./database.js";

export class AiSessionActionError extends Error {
  constructor(readonly code: "AI_NOT_CONFIGURED" | "AI_PROFILE_UNAVAILABLE" | "AI_SESSION_CONFLICT" | "AI_TURN_CONFLICT", message: string) {
    super(message); this.name = "AiSessionActionError";
  }
}

interface Dependencies { readonly database: ProjectDatabase; readonly agent: FullAgentClient }

function processBinding(projectId: string, session: { id: string; workspaceId: string; profileId: string; profileRevision: string; processGeneration: number }) {
  return { projectId, workspaceId: session.workspaceId, aiSessionId: session.id, profileId: session.profileId,
    profileRevision: session.profileRevision, processGeneration: session.processGeneration };
}

export async function inspectAiWorkbench(projectId: string, workspaceId: string, dependencies: Dependencies): Promise<{
  profile: AiProviderProfileProjection; session: ReturnType<ProjectDatabase["getAiSession"]>;
}> {
  const profile = await dependencies.agent.inspectAiProvider(projectId, workspaceId, "codex");
  return { profile, session: dependencies.database.getAiSession(projectId, workspaceId) };
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
  const view = dependencies.database.getAiSession(projectId, workspaceId);
  if (view === null) throw new AiSessionActionError("AI_SESSION_CONFLICT", "Create an AI session first.");
  const turnId = uuidv7();
  dependencies.database.createAiTurn({ projectId, workspaceId, sessionId, turnId, content: { kind: "text", text } });
  const operationId = uuidv7();
  const session = view.session;
  await dependencies.agent.sendAiTurn(operationId, { ...processBinding(projectId, session), turnId, content: { kind: "text", text } });
  return { turnId, operationId };
}

export async function interruptAiTurn(projectId: string, workspaceId: string, _sessionId: string, turnId: string, dependencies: Dependencies) {
  const view = dependencies.database.getAiSession(projectId, workspaceId);
  if (view === null) throw new AiSessionActionError("AI_SESSION_CONFLICT", "The AI session is no longer available.");
  const operationId = uuidv7(); const session = view.session;
  await dependencies.agent.interruptAiTurn(operationId, { ...processBinding(projectId, session), turnId });
  return { operationId };
}

export async function stopAiSession(projectId: string, workspaceId: string, _sessionId: string, dependencies: Dependencies) {
  const view = dependencies.database.getAiSession(projectId, workspaceId);
  if (view === null) throw new AiSessionActionError("AI_SESSION_CONFLICT", "The AI session is no longer available.");
  const operationId = uuidv7(); const session = view.session;
  await dependencies.agent.stopAiSession(operationId, processBinding(projectId, session));
  return { operationId };
}

export async function* streamAiEvents(projectId: string, workspaceId: string, sessionId: string, afterSequence: number, dependencies: Dependencies): AsyncGenerator<AiEventStreamFrame> {
  const view = dependencies.database.getAiSession(projectId, workspaceId);
  if (view === null) throw new AiSessionActionError("AI_SESSION_CONFLICT", "The AI session is no longer available.");
  for (const event of view.events.filter((candidate) => candidate.sequence > afterSequence)) yield event;
  for await (const frame of dependencies.agent.streamAiEvents(sessionId, view.session.lastSequence)) {
    if ("frameType" in frame) { yield frame; continue; }
    const result = dependencies.database.commitAiEvent({ projectId, workspaceId, event: frame });
    await dependencies.agent.acknowledgeAiEvents({ projectId, workspaceId, aiSessionId: sessionId, throughSequence: frame.sequence, throughEventId: frame.eventId });
    if (result === "appended" && frame.sequence > afterSequence) yield frame;
  }
}

export function toAiActionError(error: unknown): AiSessionActionError {
  if (error instanceof AiSessionActionError) return error;
  if (error instanceof ProjectSetupConflictError) return new AiSessionActionError("AI_NOT_CONFIGURED", error.message);
  return new AiSessionActionError("AI_SESSION_CONFLICT", "The AI session action could not be completed safely.");
}
