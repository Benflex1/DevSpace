import { customHarnessDefinitionSchema, uuidV7Schema } from "@devspace/contracts";
import { AgentResponseError, AgentUnavailableError, type FullAgentClient } from "./agent-client.js";
import { ProjectSetupConflictError, type ProjectDatabase } from "./database.js";
import { listCustomHarnessDefinitions } from "./harness-definitions.js";

function leaveAdmissionOpen(error: unknown): boolean {
  return error instanceof AgentUnavailableError
    || (error instanceof AgentResponseError && (error.code === "HARNESS_ADMISSION_UNCERTAIN" || error.retryable));
}

export function parseHarnessAction(input: unknown):
  | { action: "create-native"; workspaceId: string; harnessId: string }
  | { action: "resume"; workspaceId: string; sessionId: string }
  | { action: "retry-native"; workspaceId: string; sessionId: string; processGeneration: number }
  | { action: "save-definition"; definition: unknown }
  | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (value.nativeSessionId !== undefined || value.command !== undefined || value.env !== undefined || value.hostPath !== undefined) {
    return null;
  }
  if (value.action === "save-definition" && Object.keys(value).length === 2) {
    return { action: "save-definition", definition: value.definition };
  }
  if (typeof value.workspaceId !== "string" || !uuidV7Schema.safeParse(value.workspaceId).success) return null;
  if (value.action === "create-native" && typeof value.harnessId === "string" && Object.keys(value).length === 3) {
    return { action: "create-native", workspaceId: value.workspaceId, harnessId: value.harnessId };
  }
  if (value.action === "retry-native" && typeof value.sessionId === "string"
    && typeof value.processGeneration === "number" && Number.isSafeInteger(value.processGeneration) && value.processGeneration > 0
    && Object.keys(value).length === 4
    && uuidV7Schema.safeParse(value.sessionId).success) {
    return { action: "retry-native", workspaceId: value.workspaceId, sessionId: value.sessionId, processGeneration: value.processGeneration };
  }
  if (value.action === "resume" && typeof value.sessionId === "string" && Object.keys(value).length === 3
    && uuidV7Schema.safeParse(value.sessionId).success) {
    return { action: "resume", workspaceId: value.workspaceId, sessionId: value.sessionId };
  }
  return null;
}

export async function createNativeHarnessSession(
  projectId: string,
  actor: string,
  workspaceId: string,
  harnessId: string,
  dependencies: { database: ProjectDatabase; agent: FullAgentClient }
) {
  const session = dependencies.database.createNativeHarnessSession({ projectId, workspaceId, harnessId });
  const terminal = session.terminalSessionId !== null
    ? { terminalId: session.terminalSessionId, workspaceId }
    : dependencies.database.prepareHarnessTerminal(projectId);
  if (session.terminalSessionId === null) {
    dependencies.database.assignHarnessTerminal({
      sessionId: session.id, terminalId: terminal.terminalId, processId: terminal.terminalId
    });
  }
  void actor;
  const definition = harnessId === "codex"
    ? undefined
    : listCustomHarnessDefinitions(dependencies.database).find((item) => item.id === harnessId);
  if (harnessId !== "codex" && definition === undefined) {
    dependencies.database.failNativeHarnessSession(session.id);
    throw new ProjectSetupConflictError("The custom harness definition was not found.");
  }
  let settled: boolean;
  try {
    const started = await dependencies.agent.startNativeHarness({
      projectId,
      workspaceId,
      sessionId: session.id,
      harnessId,
      processId: terminal.terminalId,
      terminalId: terminal.terminalId,
      processGeneration: session.processGeneration,
      ...(definition === undefined ? {} : { definition: customHarnessDefinitionSchema.parse(definition) })
    });
    settled = started.settled;
  } catch (error) {
    if (!leaveAdmissionOpen(error)) dependencies.database.failNativeHarnessSession(session.id);
    throw error;
  }
  if (settled) dependencies.database.completeNativeHarnessAdmission(session.id);
  else dependencies.database.activateNativeHarnessSession(session.id);
  return { sessionId: session.id, terminalId: terminal.terminalId, workspaceId, harnessId };
}

export async function retryNativeHarnessSession(
  projectId: string,
  actor: string,
  workspaceId: string,
  sessionId: string,
  expectedGeneration: number,
  dependencies: { database: ProjectDatabase; agent: FullAgentClient }
) {
  void actor;
  const context = dependencies.database.getRuntimeContext(projectId);
  if (context.workspace.id !== workspaceId) throw new ProjectSetupConflictError("The AI session workspace is not owned by this project.");
  const session = dependencies.database.listNativeHarnessSessions(workspaceId).find((row) => row.id === sessionId);
  if (session === undefined || session.runtimeKind !== "native-pty" || session.harnessId === null) {
    throw new ProjectSetupConflictError("The native harness session is not available.");
  }
  if (session.processGeneration !== expectedGeneration) {
    throw new ProjectSetupConflictError("The native harness generation has changed. Refresh the session list before retrying.");
  }
  if ((session.state !== "creating" && session.state !== "active")
    || session.terminalSessionId === null || session.processId === null) {
    throw new ProjectSetupConflictError("The native harness admission is no longer retryable.");
  }
  const definition = session.harnessId === "codex"
    ? undefined
    : listCustomHarnessDefinitions(dependencies.database).find((item) => item.id === session.harnessId);
  if (session.harnessId !== "codex" && definition === undefined) {
    throw new ProjectSetupConflictError("The custom harness definition was not found.");
  }
  let settled: boolean;
  try {
    const retried = await dependencies.agent.startNativeHarness({
      projectId,
      workspaceId,
      sessionId,
      harnessId: session.harnessId,
      processId: session.processId,
      terminalId: session.terminalSessionId,
      processGeneration: session.processGeneration,
      ...(definition === undefined ? {} : { definition: customHarnessDefinitionSchema.parse(definition) })
    });
    settled = retried.settled;
  } catch (error) {
    if (!leaveAdmissionOpen(error)) dependencies.database.failNativeHarnessSession(sessionId);
    throw error;
  }
  if (settled) dependencies.database.completeNativeHarnessAdmission(sessionId);
  else dependencies.database.activateNativeHarnessSession(sessionId);
  return { sessionId, terminalId: session.terminalSessionId, workspaceId, harnessId: session.harnessId };
}

type NativeHarnessSessionRow = ReturnType<ProjectDatabase["listNativeHarnessSessions"]>[number];
type CustomHarnessDefinition = ReturnType<typeof listCustomHarnessDefinitions>[number];

async function inspectAndReconcileNativeHarnessSession(
  workspaceId: string,
  sessionId: string,
  dependencies: { database: ProjectDatabase; agent: Pick<FullAgentClient, "inspectNativeHarness"> },
  definitions: readonly CustomHarnessDefinition[]
): Promise<{
  session: NativeHarnessSessionRow | null;
  definition: CustomHarnessDefinition | undefined;
  definitionMissing: boolean;
  agentState: "admitting" | "live" | "stopped" | "lost" | null;
  authoritative: boolean;
  resume: boolean;
  admissionStatus?: "preparing" | "admitting" | "admitted" | "uncertain" | "unknown";
}> {
  const findSession = () => dependencies.database.listNativeHarnessSessions(workspaceId).find((row) => row.id === sessionId) ?? null;
  const initial = findSession();
  if (initial === null) {
    return { session: null, definition: undefined, definitionMissing: false, agentState: null, authoritative: false, resume: false };
  }
  const isCustom = initial.harnessId !== null && initial.harnessId !== "codex";
  const definition = isCustom ? definitions.find((item) => item.id === initial.harnessId) : undefined;
  if (isCustom && definition === undefined) {
    return { session: initial, definition: undefined, definitionMissing: true, agentState: null, authoritative: false, resume: false };
  }
  if (initial.harnessId === null || (initial.processId === null && initial.state === "creating")) {
    return {
      session: initial, definition, definitionMissing: false, agentState: null, authoritative: false, resume: false,
      ...(initial.state === "creating" ? { admissionStatus: "preparing" as const } : {})
    };
  }

  let observation: Awaited<ReturnType<FullAgentClient["inspectNativeHarness"]>>;
  try {
    observation = await dependencies.agent.inspectNativeHarness({
      sessionId: initial.id,
      workspaceId: initial.workspaceId,
      harnessId: initial.harnessId,
      ...(initial.processId === null ? {} : { processId: initial.processId }),
      processGeneration: initial.processGeneration,
      ...(definition === undefined ? {} : { definition })
    });
  } catch {
    return {
      session: findSession() ?? initial, definition, definitionMissing: false, agentState: null, authoritative: false, resume: false,
      ...(initial.state === "creating" ? { admissionStatus: "unknown" as const } : {})
    };
  }
  if (observation.processGeneration !== initial.processGeneration) {
    return {
      session: findSession() ?? initial, definition, definitionMissing: false, agentState: observation.state,
      authoritative: false, resume: false,
      ...(initial.state === "creating" ? { admissionStatus: "unknown" as const } : {})
    };
  }
  if (observation.state === "admitting") {
    return {
      session: findSession() ?? initial, definition, definitionMissing: false, agentState: "admitting",
      authoritative: true, resume: false, admissionStatus: "admitting"
    };
  }

  const reconciled = dependencies.database.reconcileNativeHarnessObservation({
    sessionId: initial.id,
    expectedGeneration: initial.processGeneration,
    agentState: observation.state
  });
  if (reconciled.status !== "matched" || reconciled.session === null || reconciled.session.runtimeKind !== "native-pty") {
    return {
      session: findSession(), definition, definitionMissing: false, agentState: observation.state,
      authoritative: false, resume: false,
      ...(initial.state === "creating" ? { admissionStatus: "unknown" as const } : {})
    };
  }
  const authoritative = reconciled.session.processGeneration === observation.processGeneration;
  let projected = reconciled.session;
  let admissionStatus: "admitted" | "uncertain" | "unknown" | undefined;
  if (observation.state === "live") {
    if (observation.admission === "started") {
      admissionStatus = "admitted";
      if (projected.state === "creating") {
        dependencies.database.activateNativeHarnessSession(projected.id);
        projected = findSession() ?? projected;
      }
    } else if (observation.admission === "uncertain") {
      admissionStatus = "uncertain";
    } else if (projected.state === "creating") {
      admissionStatus = "unknown";
    }
  }
  return {
    session: projected,
    definition,
    definitionMissing: false,
    agentState: observation.state,
    authoritative,
    resume: authoritative && observation.state !== "live" && observation.resume,
    ...(admissionStatus === undefined ? {} : { admissionStatus })
  };
}

export async function resumeNativeHarnessSession(
  projectId: string,
  actor: string,
  workspaceId: string,
  sessionId: string,
  dependencies: { database: ProjectDatabase; agent: FullAgentClient }
) {
  void actor;
  const definitions = listCustomHarnessDefinitions(dependencies.database);
  const inspection = await inspectAndReconcileNativeHarnessSession(workspaceId, sessionId, dependencies, definitions);
  if (inspection.session === null) throw new ProjectSetupConflictError("The native harness session is not available.");
  if (inspection.definitionMissing) {
    throw new ProjectSetupConflictError("The custom harness definition was not found.");
  }
  if (!inspection.authoritative) throw new ProjectSetupConflictError("The native harness state could not be verified.");
  const existing = inspection.session;
  const definition = inspection.definition;
  let generation = existing.processGeneration;
  let terminalId = existing.terminalSessionId;
  let claimed = false;
  const previousState = existing.state === "lost" ? "lost" as const : "stopped" as const;
  if (existing.state === "stopped" || existing.state === "lost") {
    if (!inspection.resume) throw new ProjectSetupConflictError("The native harness session is not resumable.");
    generation = dependencies.database.claimHarnessResumeGeneration(sessionId, existing.processGeneration);
    claimed = true;
    const terminal = dependencies.database.prepareHarnessTerminal(projectId);
    dependencies.database.assignHarnessTerminal({ sessionId, terminalId: terminal.terminalId, processId: terminal.terminalId });
    terminalId = terminal.terminalId;
  } else if (existing.state === "active") {
    throw new ProjectSetupConflictError("The native harness session is still live.");
  } else if (existing.state !== "creating" || inspection.agentState !== "live" || terminalId === null || existing.processId === null) {
    throw new ProjectSetupConflictError("The native harness session cannot be resumed from this state.");
  }
  let settled: boolean;
  try {
    const resumed = await dependencies.agent.resumeNativeHarness({
      projectId,
      workspaceId,
      sessionId,
      processId: terminalId,
      terminalId,
      processGeneration: generation,
      ...(definition === undefined ? {} : { definition })
    });
    settled = resumed.settled;
  } catch (error) {
    if (!leaveAdmissionOpen(error) && claimed) {
      dependencies.database.rollbackHarnessResume({ sessionId, expectedGeneration: generation, restoreState: previousState });
    }
    throw error;
  }
  if (settled) dependencies.database.completeNativeHarnessAdmission(sessionId);
  else dependencies.database.activateNativeHarnessSession(sessionId);
  return { sessionId, terminalId, workspaceId };
}

export async function listProjectedHarnessSessions(
  workspaceId: string,
  dependencies: { database: ProjectDatabase; agent: Pick<FullAgentClient, "inspectNativeHarness"> }
) {
  const definitions = listCustomHarnessDefinitions(dependencies.database);
  const sessions = [];
  for (const row of dependencies.database.listNativeHarnessSessions(workspaceId)) {
    const inspection = await inspectAndReconcileNativeHarnessSession(workspaceId, row.id, dependencies, definitions);
    const session = inspection.session;
    if (session === null) continue;
    sessions.push({
      id: session.id,
      harnessId: session.harnessId,
      state: session.state,
      terminalSessionId: session.terminalSessionId,
      processId: session.processId,
      title: session.title,
      processGeneration: session.processGeneration,
      resume: inspection.resume,
      ...(inspection.admissionStatus === undefined ? {} : { admissionStatus: inspection.admissionStatus })
    });
  }
  return sessions;
}
