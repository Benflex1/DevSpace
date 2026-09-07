import { NextResponse } from "next/server";
import { AgentResponseError, AgentUnavailableError, createAgentClient } from "../../../../../server/agent-client.js";
import { AuthenticationError, assertCsrf, authenticateHeaders } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { ProjectSetupConflictError, getProjectDatabase } from "../../../../../server/database.js";
import { readBoundedJsonBody } from "../../../../../server/request-body.js";
import {
  confirmProjectPush,
  getLatestProjectPushStatus,
  prepareProjectPush,
  ProjectPushError,
  projectPushActionSchema
} from "../../../../../server/project-push.js";
import { normalizeUserFacingFailure } from "../../../../../server/user-facing-failure.js";

export const dynamic = "force-dynamic";
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

function pushStatus(code: string): number {
  if (code === "PUSH_INTENT_NOT_FOUND") return 404;
  if (code === "GITHUB_CONTENTS_WRITE_PERMISSION_REQUIRED") return 403;
  if (code === "GITHUB_PUSH_INTENT_STALE" || code === "GITHUB_PUSH_NON_FAST_FORWARD" || code === "GITHUB_CONNECTION_DISABLED"
    || code === "GITHUB_AUTHORITY_GENERATION_STALE" || code === "PUSH_UNSUPPORTED") return 409;
  return 503;
}

function failureResponse(error: unknown, projectId: string, fallbackMessage: string): NextResponse {
  if (error instanceof ProjectPushError) {
    return json(normalizeUserFacingFailure(error, {
      fallbackMessage, event: "web.project_push.failed", logMessage: "User-facing repository push failed", context: { projectId }
    }), pushStatus(error.code));
  }
  if (error instanceof AgentResponseError || error instanceof AgentUnavailableError) {
    return json(normalizeUserFacingFailure(error, {
      fallbackMessage, event: "web.project_push.failed", logMessage: "User-facing repository push failed", context: { projectId }
    }), 503);
  }
  return json({ message: fallbackMessage }, 500);
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let projectId: string | undefined;
  try {
    const config = readWebRuntimeConfig();
    const actor = await authenticateHeaders(request.headers, config.auth);
    ({ projectId } = await context.params);
    const database = getProjectDatabase(config.databasePath);
    return json({ push: getLatestProjectPushStatus(projectId, actor.identity, database) }, 200);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, 409);
    if (error instanceof ProjectPushError) return failureResponse(error, projectId ?? "unknown", "Push status could not be read safely.");
    return json({ message: "Push status could not be read safely." }, 500);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let projectId: string | undefined;
  try {
    const config = readWebRuntimeConfig();
    const actor = await authenticateHeaders(request.headers, config.auth);
    assertCsrf(request, config.appOrigin);
    ({ projectId } = await context.params);
    let body: unknown;
    try { body = await readBoundedJsonBody(request); } catch { return json({ message: "Push action is invalid." }, 400); }
    const action = projectPushActionSchema.safeParse(body);
    if (!action.success) return json({ message: "Push action is invalid." }, 400);
    const dependencies = { database: getProjectDatabase(config.databasePath), agent: createAgentClient(config.agentSocketPath) };
    const result = action.data.action === "prepare"
      ? await prepareProjectPush(projectId, actor.identity, dependencies)
      : await confirmProjectPush(projectId, actor.identity, action.data.operationId, dependencies);
    return json(result, 200);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, 409);
    if (error instanceof ProjectPushError) return failureResponse(error, projectId ?? "unknown", "Repository push failed safely.");
    if (error instanceof Error && error.message === "CSRF_REJECTED") return json({ message: "Request origin could not be verified." }, 403);
    return json({ message: "Repository push failed safely." }, 500);
  }
}
