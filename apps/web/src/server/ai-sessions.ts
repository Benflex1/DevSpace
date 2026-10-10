import { v7 as uuidv7 } from "uuid";
import {
  aiApprovalDecisionSchema,
  aiApprovalPresentationSchema,
  aiStructuredInputAnswersSchema,
  aiStructuredInputQuestionsSchema,
  uuidV7Schema,
  type AiApprovalDecision,
  type AiEventStreamFrame,
  type AiProviderProfileProjection,
  type AiStructuredInputAnswers
} from "@devspace/contracts";
import { createLogger } from "@devspace/diagnostics";
import { AgentResponseError, AgentUnavailableError, type FullAgentClient } from "./agent-client.js";
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
  constructor(readonly code: "AI_NOT_CONFIGURED" | "AI_PROFILE_UNAVAILABLE" | "AI_PROFILE_REVISION_CONFLICT" | "AI_CAPABILITY_UNSUPPORTED"
    | "AI_SESSION_CONFLICT" | "AI_TURN_CONFLICT" | "AI_INTERACTION_STATE_CONFLICT", message: string) {
    super(message); this.name = "AiSessionActionError";
  }
}

export class AiTurnOutcomeAmbiguousError extends AiSessionActionError {
  constructor(readonly turnId: string) {
    super("AI_SESSION_CONFLICT", "The AI turn outcome is being reconciled. The selected session will be reloaded.");
    this.name = "AiTurnOutcomeAmbiguousError";
  }
}

interface Dependencies { readonly database: ProjectDatabase; readonly agent: FullAgentClient }
const initialSessionAttempts = new Map<string, Promise<{ sessionId: string; operationId?: string | null }>>();
const aiSessionLogger = createLogger({ component: "web", subsystem: "ai-sessions" });

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

export function inspectAiWorkbench(projectId: string, workspaceId: string, sessionId: string | undefined, dependencies: Dependencies): {
  profile: AiProviderProfileProjection | null;
  sessions: ReturnType<ProjectDatabase["listAiSessions"]>;
  session: ReturnType<ProjectDatabase["getAiSession"]>;
} {
  const selected = sessionId === undefined ? null : exactSession(projectId, workspaceId, sessionId, dependencies.database);
  const sessions = dependencies.database.listAiSessions(projectId, workspaceId);
  return { profile: null, sessions, session: selected };
}

export function inspectAiProviderStatus(
  projectId: string,
  workspaceId: string,
  agent: Pick<FullAgentClient, "inspectAiProvider">
): Promise<AiProviderProfileProjection> {
  return agent.inspectAiProvider(projectId, workspaceId, "codex");
}

type AiWorkbenchProjection = Awaited<ReturnType<typeof inspectAiWorkbench>>;
type AiSelectedSession = NonNullable<AiWorkbenchProjection["session"]>;

type AiInteractionProjection = {
  readonly id: string;
  readonly turnId: string | null;
  readonly kind: string;
  readonly state: string;
  readonly request: unknown;
};

function interactionStateConflict(message: string): AiSessionActionError {
  return new AiSessionActionError("AI_INTERACTION_STATE_CONFLICT", message);
}

async function prepareAiInteraction(
  projectId: string,
  workspaceId: string,
  sessionId: string,
  turnId: string,
  requestId: string,
  kind: "approval" | "input",
  dependencies: Dependencies
): Promise<{ readonly view: AiSelectedSession; readonly turn: ReturnType<ProjectDatabase["getAiTurn"]>; readonly interaction: AiInteractionProjection; readonly operationId: string; readonly binding: ReturnType<typeof processBinding> }> {
  const view = exactSession(projectId, workspaceId, sessionId, dependencies.database);
  if (view.session.state !== "active") {
    throw new AiSessionActionError("AI_SESSION_CONFLICT", "The AI session is not accepting interaction responses.");
  }
  const turn = exactTurn(projectId, workspaceId, sessionId, turnId, dependencies.database);
  if (turn === null || turn.id !== turnId || turn.sessionId !== sessionId) throw interactionStateConflict("The AI turn binding is no longer valid.");
  if (turn.state !== "running" && turn.state !== "waiting-for-approval" && turn.state !== "waiting-for-input") {
    throw new AiSessionActionError("AI_TURN_CONFLICT", "The AI turn is no longer accepting interaction responses.");
  }
  const interaction = (view.interactions as unknown as readonly AiInteractionProjection[]).find((candidate) => candidate.id === requestId);
  if (interaction === undefined || interaction.id !== requestId || interaction.turnId !== turnId
    || interaction.kind !== kind || interaction.state !== "pending") {
    throw interactionStateConflict("The AI interaction is stale, already resolved, or not owned by this turn.");
  }
  const profile = await dependencies.agent.inspectAiProvider(projectId, workspaceId, "codex");
  if (profile.availability.state !== "available") {
    throw new AiSessionActionError("AI_PROFILE_UNAVAILABLE", "Codex is unavailable for this workspace.");
  }
  if (profile.profileId !== view.session.profileId || profile.profileRevision !== view.session.profileRevision) {
    throw new AiSessionActionError("AI_PROFILE_REVISION_CONFLICT", "This AI session is pinned to a different Codex profile revision.");
  }
  const capability = kind === "approval" ? profile.capabilities.approvals : profile.capabilities.structuredInput;
  if (!capability) {
    throw new AiSessionActionError("AI_CAPABILITY_UNSUPPORTED", `Codex does not support ${kind === "approval" ? "approval" : "structured input"} responses for this profile.`);
  }
  return { view, turn, interaction, operationId: uuidv7(), binding: processBinding(projectId, view.session) };
}

function interactionRequestPayload(interaction: AiInteractionProjection, requestId: string): Record<string, unknown> {
  if (interaction.request === null || typeof interaction.request !== "object" || Array.isArray(interaction.request)) {
    throw interactionStateConflict("The retained AI interaction request is malformed.");
  }
  const request = interaction.request as Record<string, unknown>;
  if (request.requestId !== requestId) throw interactionStateConflict("The retained AI interaction request identity is invalid.");
  return request;
}

function interactionResponseOutcomeMayBeAmbiguous(error: unknown): boolean {
  return error instanceof AgentUnavailableError
    || error instanceof AgentResponseError && error.code === "AI_OUTBOX_UNAVAILABLE";
}

function validateStructuredInputAnswers(request: Record<string, unknown>, answers: unknown): AiStructuredInputAnswers {
  const questionsResult = aiStructuredInputQuestionsSchema.safeParse(request.questions);
  const answersResult = aiStructuredInputAnswersSchema.safeParse(answers);
  if (!questionsResult.success || !answersResult.success || questionsResult.data.length !== answersResult.data.length) {
    throw interactionStateConflict("Every structured-input question needs exactly one valid answer.");
  }
  const answersByQuestion = new Map(answersResult.data.map((answer) => [answer.questionId, answer]));
  for (const question of questionsResult.data) {
    const answer = answersByQuestion.get(question.questionId);
    if (answer === undefined) throw interactionStateConflict("Every structured-input question needs exactly one valid answer.");
    if (question.responseKind === "single-select") {
      if (answer.kind === "other") {
        if (!question.allowOther) throw interactionStateConflict("This structured-input question does not allow an Other answer.");
      } else if (answer.kind !== "selected" || !question.options.some((option) => option.optionId === answer.optionId)) {
        throw interactionStateConflict("A structured-input option does not belong to its question.");
      }
    } else if (answer.kind !== "text") {
      throw interactionStateConflict("A text structured-input question needs text.");
    }
  }
  return answersResult.data;
}

async function reconcileAmbiguousAiInteraction(input: {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly requestId: string;
  readonly kind: "approval" | "input";
  readonly view: AiSelectedSession;
  readonly dependencies: Dependencies;
}): Promise<"responded" | "pending" | "lost"> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  let synchronized = false;
  let exactPendingBinding = false;
  let responded = false;
  let providerRetired = false;
  try {
    for await (const frame of streamAiEvents(input.projectId, input.workspaceId, input.sessionId, input.view.session.lastSequence,
      input.dependencies, input.view, { signal: controller.signal })) {
      if ("frameType" in frame) {
        synchronized = frame.sessionId === input.sessionId
          && frame.processGeneration === input.view.session.processGeneration
          && frame.throughSequence >= input.view.session.lastSequence;
        exactPendingBinding = synchronized && frame.pendingInteractionIds.includes(input.requestId);
        if (synchronized && responded) return "responded";
        continue;
      }
      if (frame.sessionId !== input.sessionId || frame.turnId !== input.turnId) continue;
      if (input.kind === "approval" && frame.eventType === "turn.approval.responded" && frame.payload.requestId === input.requestId) responded = true;
      if (input.kind === "input" && frame.eventType === "turn.input.responded" && frame.payload.requestId === input.requestId) responded = true;
      if (frame.eventType === "turn.interaction.expired" && frame.payload.requestId === input.requestId) providerRetired = true;
      if (synchronized && responded) return "responded";
    }
  } catch {
    // A failed reconciliation cannot prove that the provider did not receive the response.
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  if (synchronized && responded) return "responded";
  if (synchronized && providerRetired) return "lost";
  if (synchronized && exactPendingBinding) return "pending";
  input.dependencies.database.retireAiInteraction({
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    requestId: input.requestId,
    state: "lost"
  });
  return "lost";
}

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
  if (initial.kind === "blocked-by-live-profile") {
    return { sessionId: created.id, operationId: null };
  }
  if (created.state !== "creating" || created.lastSequence !== 0 || created.processGeneration !== 1) {
    return { sessionId: created.id, operationId: null };
  }
  if (!initial.created && (created.profileKey !== profile.profileId || created.profileRevision !== profile.profileRevision)) {
    return { sessionId: created.id, operationId: null };
  }
  const active = initialSessionAttempts.get(created.id);
  if (active !== undefined) return await active;
  const attempt = (async (): Promise<{ sessionId: string; operationId?: string | null }> => {
    const startBinding = {
      projectId,
      workspaceId,
      aiSessionId: created.id,
      revisionId: created.revisionId,
      runtimePlanHash: created.runtimePlanHash,
      runtimeGeneration: created.runtimeGeneration,
      profileId: created.profileKey,
      profileRevision: created.profileRevision
    };
    const reconcile = async (): Promise<"empty" | "canonical" | "unavailable"> => {
      let sawCanonical = false;
      let synchronized = false;
      let throughSequence = 0;
      try {
        for await (const frame of dependencies.agent.streamAiEvents(created.id, 0)) {
          if ("frameType" in frame) {
            if (frame.sessionId !== created.id || frame.throughSequence !== throughSequence) return "unavailable";
            synchronized = true;
            break;
          }
          const result = dependencies.database.commitAiEvent({ projectId, workspaceId, event: frame });
          if (result !== "appended" && result !== "duplicate") return "unavailable";
          await dependencies.agent.acknowledgeAiEvents({
            projectId,
            workspaceId,
            aiSessionId: created.id,
            throughSequence: frame.sequence,
            throughEventId: frame.eventId
          });
          sawCanonical = true;
          throughSequence = frame.sequence;
        }
      } catch {
        return "unavailable";
      }
      if (!synchronized) return "unavailable";
      return sawCanonical ? "canonical" : "empty";
    };
    if (!initial.created) {
      const outcome = await reconcile();
      if (outcome !== "empty") return { sessionId: created.id };
      dependencies.database.prepareInitialAiSessionRetry({
        projectId,
        workspaceId,
        sessionId: created.id,
        profileId: profile.profileId,
        profileRevision: profile.profileRevision,
        revisionId: created.revisionId,
        runtimePlanHash: created.runtimePlanHash,
        runtimeGeneration: created.runtimeGeneration,
        expectedUpdatedAt: created.updatedAt,
        synchronizedEmpty: true
      });
    }
    const operationId = uuidv7();
    try {
      await dependencies.agent.startAiSession(operationId, startBinding);
      return { sessionId: created.id, operationId };
    } catch {
      const outcome = await reconcile();
      return outcome === "unavailable"
        ? { sessionId: created.id, operationId: null }
        : { sessionId: created.id };
    }
  })();
  initialSessionAttempts.set(created.id, attempt);
  try {
    return await attempt;
  } finally {
    if (initialSessionAttempts.get(created.id) === attempt) initialSessionAttempts.delete(created.id);
  }
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
    throw new AiSessionActionError("AI_PROFILE_REVISION_CONFLICT", "The stopped AI session no longer matches this Codex profile revision.");
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
  const operationId = uuidv7();
  const session = view.session;
  try {
    await dependencies.agent.sendAiTurn(operationId, { ...processBinding(projectId, session), turnId, content: { kind: "text", text } });
  } catch (error) {
    if (error instanceof AgentUnavailableError) throw new AiTurnOutcomeAmbiguousError(turnId);
    throw error;
  }
  try {
    dependencies.database.ensureAiTurnAccepted({
      projectId, workspaceId, sessionId, turnId,
      processGeneration: session.processGeneration,
      content: { kind: "text", text }
    });
  } catch (error) {
    aiSessionLogger.warn("ai.turn.acceptance_projection.ambiguous", "Agent accepted a turn whose local projection is unresolved", {
      projectId,
      workspaceId,
      aiSessionId: sessionId,
      turnId,
      errorCategory: error instanceof ProjectSetupConflictError ? "state-conflict" : "database-failure"
    });
    throw new AiTurnOutcomeAmbiguousError(turnId);
  }
  return { turnId, operationId };
}

export async function respondToAiApproval(
  projectId: string,
  workspaceId: string,
  sessionId: string,
  turnId: string,
  requestId: string,
  decision: AiApprovalDecision,
  dependencies: Dependencies
) {
  uuidV7Schema.parse(requestId);
  const prepared = await prepareAiInteraction(projectId, workspaceId, sessionId, turnId, requestId, "approval", dependencies);
  const request = interactionRequestPayload(prepared.interaction, requestId);
  const presentation = aiApprovalPresentationSchema.safeParse(request.presentation);
  const parsedDecision = aiApprovalDecisionSchema.safeParse(decision);
  if (!presentation.success || !parsedDecision.success) {
    throw interactionStateConflict("The retained approval request or decision is invalid.");
  }
  try {
    await dependencies.agent.respondToAiApproval(prepared.operationId, {
      ...prepared.binding,
      turnId,
      requestId,
      decision: parsedDecision.data
    });
  } catch (error) {
    if (!interactionResponseOutcomeMayBeAmbiguous(error)) throw error;
    const outcome = await reconcileAmbiguousAiInteraction({
      projectId, workspaceId, sessionId, turnId, requestId, kind: "approval", view: prepared.view, dependencies
    });
    if (outcome === "responded") return { operationId: prepared.operationId };
    throw interactionStateConflict(outcome === "pending"
      ? "The approval response is still being reconciled; it was not resent."
      : "The approval response could not be proven safe to complete and was retired.");
  }
  return { operationId: prepared.operationId };
}

export async function respondToAiStructuredInput(
  projectId: string,
  workspaceId: string,
  sessionId: string,
  turnId: string,
  requestId: string,
  answers: AiStructuredInputAnswers,
  dependencies: Dependencies
) {
  uuidV7Schema.parse(requestId);
  const prepared = await prepareAiInteraction(projectId, workspaceId, sessionId, turnId, requestId, "input", dependencies);
  const request = interactionRequestPayload(prepared.interaction, requestId);
  const validatedAnswers = validateStructuredInputAnswers(request, answers);
  try {
    await dependencies.agent.respondToAiStructuredInput(prepared.operationId, {
      ...prepared.binding,
      turnId,
      requestId,
      answers: validatedAnswers
    });
  } catch (error) {
    if (!interactionResponseOutcomeMayBeAmbiguous(error)) throw error;
    const outcome = await reconcileAmbiguousAiInteraction({
      projectId, workspaceId, sessionId, turnId, requestId, kind: "input", view: prepared.view, dependencies
    });
    if (outcome === "responded") return { operationId: prepared.operationId };
    throw interactionStateConflict(outcome === "pending"
      ? "The structured-input response is still being reconciled; it was not resent."
      : "The structured-input response could not be proven safe to complete and was retired.");
  }
  return { operationId: prepared.operationId };
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
  preflight?: AiEventStreamPreflight, options: { signal?: AbortSignal } = {}): AsyncGenerator<AiEventStreamFrame> {
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
  for await (const frame of dependencies.agent.streamAiEvents(view.session.id, view.session.lastSequence, options)) {
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
