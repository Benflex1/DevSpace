import { NextResponse } from "next/server";
import { createAgentClient } from "../../../../../server/agent-client.js";
import { AuthenticationError, assertCsrf, authenticateHeaders } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { ProjectSetupConflictError, getProjectDatabase } from "../../../../../server/database.js";
import { loadProjectWorkspaceData } from "../../../../../server/project-workspace.js";
import { RequestBodyMalformedError, RequestBodyTooLargeError, readBoundedJsonBody } from "../../../../../server/request-body.js";
import { WorkspaceRuntimeExecutionError, mutatePrimaryWorkspaceRuntime } from "../../../../../server/workspace-runtime.js";
import { normalizeUserFacingFailure } from "../../../../../server/user-facing-failure.js";

export const dynamic = "force-dynamic";
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const config = readWebRuntimeConfig();
    await authenticateHeaders(request.headers, config.auth);
    const { projectId } = await context.params;
    const data = await loadProjectWorkspaceData(projectId);
    if (data === null) return json({ message: "Project workspace was not found." }, 404);
    const activeAction = data.runtimeOperation?.activeAction ?? null;
    const inspection = data.runtimeOperation?.inspection ?? data.live?.workspace ?? null;
    const configurationApply = data.runtimeOperation?.configurationApply ?? null;
    const runtimeState = configurationApply !== null ? "applying" : activeAction === "start" ? "starting" : activeAction === "stop" ? "stopping"
      : inspection?.runtimeStack.observedState ?? data.project.runtime?.observedState ?? "absent";
    return json({ runtimeState, runtimeAvailable: data.runtimeAvailability === "available", activeAction,
      canStart: data.runtimeOperation?.canStart === true, canStop: data.runtimeOperation?.canStop === true,
      configurationApply }, 200);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    return json({ message: "Fresh runtime authorization could not be obtained." }, 503);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let projectId: string | undefined;
  try {
    const config = readWebRuntimeConfig();
    const actor = await authenticateHeaders(request.headers, config.auth);
    assertCsrf(request, config.appOrigin);
    const body = await readBoundedJsonBody(request);
    if (body === null || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || !("action" in body)
      || (body.action !== "start" && body.action !== "stop")) return json({ message: "Choose a valid runtime action." }, 422);
    ({ projectId } = await context.params);
    const observed = await mutatePrimaryWorkspaceRuntime(body.action, projectId, actor.identity, {
      agent: createAgentClient(config.agentSocketPath), database: getProjectDatabase(config.databasePath), previewBaseRegistry: config.previewBaseRegistry
    });
    return json({ workspaceState: observed.observedState, runtimeState: observed.runtimeStack.observedState }, 200);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, 409);
    if (error instanceof WorkspaceRuntimeExecutionError) {
      const failure = normalizeUserFacingFailure(error, {
        fallbackMessage: "The runtime action failed safely.", event: "web.runtime_action.failed",
        logMessage: "User-facing runtime action failed", context: { ...(projectId === undefined ? {} : { projectId }) }
      });
      return json(failure,
      error.code === "RUNTIME_ACTION_IN_PROGRESS" ? 202
        : error.code === "RUNTIME_ACTION_NOT_AUTHORIZED" && error.failureCategory === "state-conflict" ? 409
        : error.code === "RUNTIME_PLAN_UNSUPPORTED" ? 422 : 503);
    }
    if (error instanceof RequestBodyTooLargeError) return json({ message: error.message }, 413);
    if (error instanceof RequestBodyMalformedError) return json({ message: "Request body must be valid JSON." }, 400);
    if (error instanceof Error && error.message === "CSRF_REJECTED") return json({ message: "Request origin could not be verified." }, 403);
    return json(normalizeUserFacingFailure(error, {
      fallbackMessage: "The runtime action failed safely.", event: "web.runtime_action.failed",
      logMessage: "User-facing runtime action failed", context: { ...(projectId === undefined ? {} : { projectId }) }
    }), 500);
  }
}
