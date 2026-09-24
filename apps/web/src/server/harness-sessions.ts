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

export async function resumeNativeHarnessSession(
  projectId: string,
  actor: string,
  workspaceId: string,
  sessionId: string,
  dependencies: { database: ProjectDatabase; agent: FullAgentClient }
) {
  void actor;
  const existing = dependencies.database.listNativeHarnessSessions(workspaceId).find((row) => row.id === sessionId);
  if (existing === undefined) throw new ProjectSetupConflictError("The native harness session is not available.");
  const definition = existing.harnessId !== null && existing.harnessId !== "codex"
    ? listCustomHarnessDefinitions(dependencies.database).find((item) => item.id === existing.harnessId)
    : undefined;
  if (existing.harnessId !== null && existing.harnessId !== "codex" && definition === undefined) {
    throw new ProjectSetupConflictError("The custom harness definition was not found.");
  }
  let generation = existing.processGeneration;
  let terminalId = existing.terminalSessionId;
  let claimed = false;
  const previousState = existing.state === "lost" ? "lost" as const : "stopped" as const;
  if (existing.state === "creating" && terminalId !== null && existing.processId !== null) {
    generation = existing.processGeneration;
  } else if (existing.state === "creating") {
    const terminal = dependencies.database.prepareHarnessTerminal(projectId);
    dependencies.database.assignHarnessTerminal({ sessionId, terminalId: terminal.terminalId, processId: terminal.terminalId });
    terminalId = terminal.terminalId;
  } else if (existing.state === "stopped" || existing.state === "lost") {
    generation = dependencies.database.claimHarnessResumeGeneration(sessionId);
    claimed = true;
    const terminal = dependencies.database.prepareHarnessTerminal(projectId);
    dependencies.database.assignHarnessTerminal({ sessionId, terminalId: terminal.terminalId, processId: terminal.terminalId });
    terminalId = terminal.terminalId;
  } else {
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
    let resume: boolean;
    try {
      const definition = row.harnessId !== null && row.harnessId !== "codex"
        ? definitions.find((item) => item.id === row.harnessId)
        : undefined;
      const capability = await dependencies.agent.inspectNativeHarness({
        sessionId: row.id,
        ...(definition === undefined ? {} : { definition })
      });
      resume = capability.resume === true;
    } catch {
      resume = false;
    }
    sessions.push({
      id: row.id,
      harnessId: row.harnessId,
      state: row.state,
      terminalSessionId: row.terminalSessionId,
      processId: row.processId,
      title: row.title,
      resume
    });
  }
  return sessions;
}
