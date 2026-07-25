import { NextResponse } from "next/server";
import { createAgentClient } from "../../../../../server/agent-client.js";
import { AuthenticationError, assertCsrf, authenticateHeaders } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { ProjectSetupConflictError, getProjectDatabase } from "../../../../../server/database.js";
import { ExecutionMutationError, reconcileExecutions, runTask, stopTaskProcess } from "../../../../../server/execution.js";
import { readBoundedJsonBody } from "../../../../../server/request-body.js";
import { normalizeUserFacingFailure } from "../../../../../server/user-facing-failure.js";

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const config = readWebRuntimeConfig(); await authenticateHeaders(request.headers, config.auth);
    const database = getProjectDatabase(config.databasePath); await reconcileExecutions({ database, agent: createAgentClient(config.agentSocketPath) });
    const { projectId } = await context.params; const project = database.getManagedProject(projectId);
    if (project === undefined) return json({ message: "The project was not found." }, 404);
    return json({ tasks: project.tasks, taskRuns: project.taskRuns, terminals: project.terminals }, 200);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    return json({ message: "Execution state is temporarily unavailable." }, 503);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let projectId: string | undefined;
  try {
    const config = readWebRuntimeConfig(); const actor = await authenticateHeaders(request.headers, config.auth);
    assertCsrf(request, config.appOrigin); const body = await readBoundedJsonBody(request);
    if (body === null || typeof body !== "object" || Array.isArray(body)) return json({ message: "Choose a task action." }, 422);
    const record = body as Record<string, unknown>; ({ projectId } = await context.params);
    const dependencies = { database: getProjectDatabase(config.databasePath), agent: createAgentClient(config.agentSocketPath) };
    if (record.action === "run" && Object.keys(record).length === 2 && typeof record.taskKey === "string") {
      return json(await runTask(projectId, record.taskKey, actor.identity, dependencies), 200);
    }
    if (record.action === "stop" && Object.keys(record).length === 2 && typeof record.processId === "string") {
      await stopTaskProcess(projectId, record.processId, actor.identity, dependencies); return json({ stopped: true }, 200);
    }
    return json({ message: "Choose a valid task action." }, 422);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, 409);
    if (error instanceof ExecutionMutationError) return json(normalizeUserFacingFailure(error, {
      fallbackMessage: "The task action failed safely.", event: "web.task_action.failed",
      logMessage: "User-facing task action failed", context: { ...(projectId === undefined ? {} : { projectId }) }
    }),
      error.code === "EXECUTION_ACTION_IN_PROGRESS" ? 202 : error.code === "RESOURCE_STATE_CONFLICT" ? 409 : 503);
    if (error instanceof Error && error.message === "CSRF_REJECTED") return json({ message: "Request origin could not be verified." }, 403);
    return json(normalizeUserFacingFailure(error, {
      fallbackMessage: "The task action failed safely.", event: "web.task_action.failed",
      logMessage: "User-facing task action failed", context: { ...(projectId === undefined ? {} : { projectId }) }
    }), 500);
  }
}
