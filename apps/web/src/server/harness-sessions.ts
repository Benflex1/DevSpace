import { customHarnessDefinitionSchema, uuidV7Schema } from "@devspace/contracts";
import type { FullAgentClient } from "./agent-client.js";
import type { ProjectDatabase } from "./database.js";
import { listCustomHarnessDefinitions } from "./harness-definitions.js";

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
  const terminal = dependencies.database.prepareHarnessTerminal(projectId);
  void actor;
  const definition = harnessId === "codex"
    ? undefined
    : listCustomHarnessDefinitions(dependencies.database).find((item) => item.id === harnessId);
  if (harnessId !== "codex" && definition === undefined) {
    throw new Error("The custom harness definition was not found.");
  }
  await dependencies.agent.startNativeHarness({
    projectId,
    workspaceId,
    sessionId: session.id,
    harnessId,
    processId: terminal.terminalId,
    terminalId: terminal.terminalId,
    processGeneration: 1,
    ...(definition === undefined ? {} : { definition: customHarnessDefinitionSchema.parse(definition) })
  });
  dependencies.database.bindNativeHarnessTerminal({
    sessionId: session.id, terminalId: terminal.terminalId, processId: terminal.terminalId
  });
  return { sessionId: session.id, terminalId: terminal.terminalId, workspaceId, harnessId };
}

export async function resumeNativeHarnessSession(
  projectId: string,
  actor: string,
  workspaceId: string,
  sessionId: string,
  dependencies: { database: ProjectDatabase; agent: FullAgentClient }
) {
  const terminal = dependencies.database.prepareHarnessTerminal(projectId);
  void actor;
  await dependencies.agent.resumeNativeHarness({
    projectId,
    workspaceId,
    sessionId,
    processId: terminal.terminalId,
    terminalId: terminal.terminalId,
    processGeneration: 2
  });
  dependencies.database.bindNativeHarnessTerminal({
    sessionId, terminalId: terminal.terminalId, processId: terminal.terminalId
  });
  return { sessionId, terminalId: terminal.terminalId, workspaceId };
}
