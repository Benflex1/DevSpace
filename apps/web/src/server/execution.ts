import { AgentResponseError, AgentUnavailableError, type FullAgentClient } from "./agent-client.js";
import type { ProjectDatabase } from "./database.js";

export class ExecutionMutationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ExecutionMutationError"; }
}

async function requireAgentRuntime(agent: FullAgentClient): Promise<void> {
  try {
    const health = await agent.health();
    const runtime = await agent.runtimeStatus();
    if (health.status !== "ok" || runtime.rootlessRuntime !== "available" || runtime.operationJournal !== "available") {
      throw new Error("agent-runtime-unavailable");
    }
  } catch {
    throw new ExecutionMutationError("AGENT_UNAVAILABLE", "The DevSpace Agent and its required runtime are unavailable.");
  }
}

async function observeOperation(operationId: string, dependencies: {
  database: ProjectDatabase; agent: FullAgentClient; timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (dependencies.timeoutMs ?? 10_000);
  let delay = 25;
  while (Date.now() < deadline) {
    const snapshot = await dependencies.agent.snapshot();
    dependencies.database.applyExecutionSnapshot(snapshot);
    const observation = snapshot.operationObservations.find((item) => item.operationId === operationId);
    if (observation?.state === "succeeded") return;
    if (observation?.state === "failed") throw new ExecutionMutationError(observation.failure.code, observation.failure.message);
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(Math.ceil(delay * 1.7), 500);
  }
  throw new ExecutionMutationError("EXECUTION_ACTION_IN_PROGRESS", "The execution action is still in progress.");
}

export async function openTerminal(projectId: string, actor: string, dependencies: {
  database: ProjectDatabase; agent: FullAgentClient; timeoutMs?: number;
}): Promise<{ terminalId: string; workspaceId: string }> {
  await requireAgentRuntime(dependencies.agent);
  const intent = dependencies.database.prepareTerminalCreate(projectId, actor);
  try {
    await dependencies.agent.createTerminal(intent.operation.operationId, projectId, intent.workspaceId, intent.terminalId);
    await observeOperation(intent.operation.operationId, dependencies);
    return { terminalId: intent.terminalId, workspaceId: intent.workspaceId };
  } catch (error) {
    if (error instanceof AgentResponseError) {
      dependencies.database.failTerminalCreate({ operationId: intent.operation.operationId, terminalId: intent.terminalId,
        code: error.code, message: error.message });
      throw new ExecutionMutationError(error.code, error.message);
    }
    if (error instanceof ExecutionMutationError && error.code !== "EXECUTION_ACTION_IN_PROGRESS") {
      dependencies.database.failTerminalCreate({ operationId: intent.operation.operationId, terminalId: intent.terminalId,
        code: error.code, message: error.message });
      throw error;
    }
    if (error instanceof AgentUnavailableError) {
      throw new ExecutionMutationError("EXECUTION_ACTION_IN_PROGRESS", "The terminal creation outcome is not yet confirmed.");
    }
    throw error;
  }
}

export async function closeTerminal(projectId: string, terminalId: string, actor: string, dependencies: {
  database: ProjectDatabase; agent: FullAgentClient; timeoutMs?: number;
}): Promise<void> {
  await requireAgentRuntime(dependencies.agent);
  const intent = dependencies.database.prepareTerminalClose(projectId, terminalId, actor);
  await dependencies.agent.closeTerminal(intent.operation.operationId, projectId, intent.workspaceId, terminalId);
  await observeOperation(intent.operation.operationId, dependencies);
}

export async function runTask(projectId: string, taskKey: string, actor: string, dependencies: {
  database: ProjectDatabase; agent: FullAgentClient; timeoutMs?: number;
}): Promise<{ taskRunId: string; processId: string }> {
  await requireAgentRuntime(dependencies.agent);
  const intent = dependencies.database.prepareTaskStart(projectId, taskKey, actor);
  await dependencies.agent.startTask(intent.operation.operationId, { projectId, workspaceId: intent.workspaceId,
    taskRunId: intent.taskRunId, processId: intent.processId, taskKey });
  await observeOperation(intent.operation.operationId, dependencies);
  return { taskRunId: intent.taskRunId, processId: intent.processId };
}

export async function stopTaskProcess(projectId: string, processId: string, actor: string, dependencies: {
  database: ProjectDatabase; agent: FullAgentClient; timeoutMs?: number;
}): Promise<void> {
  await requireAgentRuntime(dependencies.agent);
  const intent = dependencies.database.prepareProcessStop(projectId, processId, actor);
  await dependencies.agent.stopProcess(intent.operation.operationId, projectId, intent.workspaceId, processId);
  await observeOperation(intent.operation.operationId, dependencies);
}

export async function reconcileExecutions(dependencies: { database: ProjectDatabase; agent: FullAgentClient }): Promise<void> {
  dependencies.database.applyExecutionSnapshot(await dependencies.agent.snapshot());
}
