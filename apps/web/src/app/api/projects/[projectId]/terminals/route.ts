import { NextResponse } from "next/server";
import { createAgentClient } from "../../../../../server/agent-client.js";
import { AuthenticationError, assertCsrf, authenticateHeaders } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { ProjectSetupConflictError, getProjectDatabase } from "../../../../../server/database.js";
import { ExecutionMutationError, closeTerminal, openTerminal } from "../../../../../server/execution.js";
import { readBoundedJsonBody } from "../../../../../server/request-body.js";
import { normalizeUserFacingFailure } from "../../../../../server/user-facing-failure.js";

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let projectId: string | undefined;
  try {
    const config = readWebRuntimeConfig(); const actor = await authenticateHeaders(request.headers, config.auth);
    assertCsrf(request, config.appOrigin); const body = await readBoundedJsonBody(request);
    if (body === null || typeof body !== "object" || Array.isArray(body)) return json({ message: "Choose a terminal action." }, 422);
    const record = body as Record<string, unknown>; ({ projectId } = await context.params);
    const dependencies = { database: getProjectDatabase(config.databasePath), agent: createAgentClient(config.agentSocketPath) };
    if (record.action === "create" && Object.keys(record).length === 1) return json(await openTerminal(projectId, actor.identity, dependencies), 200);
    if (record.action === "close" && Object.keys(record).length === 2 && typeof record.terminalId === "string") {
      await closeTerminal(projectId, record.terminalId, actor.identity, dependencies); return json({ closed: true }, 200);
    }
    return json({ message: "Choose a valid terminal action." }, 422);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, 409);
    if (error instanceof ExecutionMutationError) return json(normalizeUserFacingFailure(error, {
      fallbackMessage: "The terminal action failed safely.", event: "web.terminal_action.failed",
      logMessage: "User-facing terminal action failed", context: { ...(projectId === undefined ? {} : { projectId }) }
    }),
      error.code === "EXECUTION_ACTION_IN_PROGRESS" ? 202 : error.code === "RESOURCE_STATE_CONFLICT" ? 409 : 503);
    if (error instanceof Error && error.message === "CSRF_REJECTED") return json({ message: "Request origin could not be verified." }, 403);
    return json(normalizeUserFacingFailure(error, {
      fallbackMessage: "The terminal action failed safely.", event: "web.terminal_action.failed",
      logMessage: "User-facing terminal action failed", context: { ...(projectId === undefined ? {} : { projectId }) }
    }), 500);
  }
}
