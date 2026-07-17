import {
  canonicalizeProjectOptionsV1, canonicalizeRuntimePlanV1, compileRuntimePlanV1,
  hashProjectOptionsV1, hashRuntimePlanV1, parseProjectOptionsV1, parseRuntimePlanV1
} from "@devspace/project-options";
import { AgentResponseError, type WorkspaceAgentClient } from "./agent-client.js";
import type { ProjectDatabase } from "./database.js";

export class WorkspaceRuntimeExecutionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WorkspaceRuntimeExecutionError"; }
}

async function pollMutation(input: {
  database: ProjectDatabase; agent: WorkspaceAgentClient; operationId: string;
  execute: () => Promise<void>; deadline: number; now: () => number; sleep: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  await input.execute();
  let delay = 25;
  while (input.now() < input.deadline) {
    const observation = (await input.agent.snapshot()).operationObservations.find((item) => item.operationId === input.operationId);
    if (observation?.state === "succeeded") return;
    if (observation?.state === "failed") throw new WorkspaceRuntimeExecutionError(observation.failure.code, observation.failure.message);
    const remaining = input.deadline - input.now();
    if (remaining <= 0) break;
    await input.sleep(Math.min(delay, remaining));
    delay = Math.min(Math.ceil(delay * 1.7), 1_000);
  }
  throw new WorkspaceRuntimeExecutionError("RUNTIME_ACTION_IN_PROGRESS", "The runtime action is still running safely. Retry to continue observing it.");
}

export async function mutatePrimaryWorkspaceRuntime(action: "start" | "stop", projectId: string, actor: string, dependencies: {
  readonly database: ProjectDatabase; readonly agent: WorkspaceAgentClient; readonly orchestrationTimeoutMs?: number;
  readonly nowMonotonic?: () => number; readonly sleep?: (milliseconds: number) => Promise<void>;
}) {
  const context = dependencies.database.getRuntimeContext(projectId);
  let options: ReturnType<typeof parseProjectOptionsV1>;
  try {
    options = parseProjectOptionsV1(JSON.parse(context.revision.configurationJson));
    if (canonicalizeProjectOptionsV1(options) !== context.revision.configurationJson
      || hashProjectOptionsV1(options) !== context.revision.configurationHash) throw new Error("configuration-revision-mismatch");
  } catch {
    throw new WorkspaceRuntimeExecutionError("CONFIGURATION_INVALID", "The immutable Project Options revision is invalid.");
  }
  let plan;
  try { plan = compileRuntimePlanV1(options); }
  catch (error) {
    throw new WorkspaceRuntimeExecutionError("RUNTIME_PLAN_UNSUPPORTED", error instanceof Error ? error.message : "This configuration is not executable yet.");
  }
  const canonicalPlan = canonicalizeRuntimePlanV1(plan);
  const planHash = hashRuntimePlanV1(plan);
  if (context.revision.compiledRuntimePlanJson !== null || context.revision.runtimePlanHash !== null) {
    try {
      const retained = parseRuntimePlanV1(JSON.parse(context.revision.compiledRuntimePlanJson ?? "null"));
      if (canonicalizeRuntimePlanV1(retained) !== canonicalPlan || hashRuntimePlanV1(retained) !== planHash
        || context.revision.runtimePlanHash !== planHash) throw new Error("derived-plan-mismatch");
    } catch { throw new WorkspaceRuntimeExecutionError("RUNTIME_PLAN_INVALID", "The retained runtime plan is inconsistent."); }
  } else {
    dependencies.database.storeRuntimePlanPair({ projectId, revisionId: context.revision.id, canonicalJson: canonicalPlan, hash: planHash });
  }
  const now = dependencies.nowMonotonic ?? (() => Date.now());
  const sleep = dependencies.sleep ?? (async (milliseconds: number) => await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + (dependencies.orchestrationTimeoutMs ?? 120_000);
  const registration = dependencies.database.getOrCreateOperation({ projectId, actor,
    operationName: "configuration-runtime-plan.register", resourceType: "configuration-revision", resourceId: context.revision.id });
  if (registration.state !== "succeeded") {
    try {
      await pollMutation({ database: dependencies.database, agent: dependencies.agent, operationId: registration.operationId,
        execute: async () => await dependencies.agent.registerRuntimePlan(registration.operationId, {
          projectId, revisionId: context.revision.id, revisionHash: context.revision.configurationHash,
          runtimePlan: { format: "devspace.runtime-plan/v1", hash: planHash, canonicalJson: canonicalPlan }
        }), deadline, now, sleep });
      dependencies.database.finishOperation(registration.operationId, { state: "succeeded" });
    } catch (error) {
      const failure = error instanceof WorkspaceRuntimeExecutionError ? error
        : error instanceof AgentResponseError ? new WorkspaceRuntimeExecutionError(error.code, error.message)
        : new WorkspaceRuntimeExecutionError("AGENT_UNAVAILABLE", "The DevSpace Agent is unavailable.");
      dependencies.database.finishOperation(registration.operationId, { state: "failed", code: failure.code, message: failure.message });
      throw failure;
    }
  }
  const operation = dependencies.database.prepareRuntimeMutation({ projectId, workspaceId: context.workspace.id, actor, action,
    runtimePlanHash: planHash, imageReference: plan.developmentContainer.source.imageReference });
  if (operation.state === "succeeded") return await dependencies.agent.inspectWorkspace(projectId, context.workspace.id);
  try {
    await pollMutation({ database: dependencies.database, agent: dependencies.agent, operationId: operation.operationId,
      execute: async () => action === "start"
        ? await dependencies.agent.startWorkspace(operation.operationId, projectId, context.workspace.id)
        : await dependencies.agent.stopWorkspace(operation.operationId, projectId, context.workspace.id),
      deadline, now, sleep });
    const observed = await dependencies.agent.inspectWorkspace(projectId, context.workspace.id);
    const expected = action === "start" ? "running" : "stopped";
    if (observed.observedState !== expected || observed.runtimeStack.observedState !== expected) {
      throw new WorkspaceRuntimeExecutionError("WORKSPACE_STATE_CONFLICT", "The Agent did not observe the requested runtime state.");
    }
    dependencies.database.finishRuntimeMutation({ operationId: operation.operationId, projectId, workspaceId: context.workspace.id,
      outcome: { state: "succeeded", observed: expected } });
    return observed;
  } catch (error) {
    const failure = error instanceof WorkspaceRuntimeExecutionError ? error
      : error instanceof AgentResponseError ? new WorkspaceRuntimeExecutionError(error.code, error.message)
      : new WorkspaceRuntimeExecutionError("AGENT_UNAVAILABLE", "The DevSpace Agent is unavailable.");
    dependencies.database.finishRuntimeMutation({ operationId: operation.operationId, projectId, workspaceId: context.workspace.id,
      outcome: { state: "failed", code: failure.code, message: failure.message } });
    throw failure;
  }
}
