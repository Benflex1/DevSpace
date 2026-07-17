import { NextResponse } from "next/server";
import { createAgentClient } from "../../../../../server/agent-client.js";
import { AuthenticationError, assertCsrf, authenticateHeaders } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { ProjectSetupConflictError, getProjectDatabase } from "../../../../../server/database.js";
import { RequestBodyMalformedError, RequestBodyTooLargeError, readBoundedJsonBody } from "../../../../../server/request-body.js";
import { WorkspaceRuntimeExecutionError, mutatePrimaryWorkspaceRuntime } from "../../../../../server/workspace-runtime.js";

export const dynamic = "force-dynamic";
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const config = readWebRuntimeConfig();
    const actor = await authenticateHeaders(request.headers, config.auth);
    assertCsrf(request, config.appOrigin);
    const body = await readBoundedJsonBody(request);
    if (body === null || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || !("action" in body)
      || (body.action !== "start" && body.action !== "stop")) return json({ message: "Choose a valid runtime action." }, 422);
    const { projectId } = await context.params;
    const observed = await mutatePrimaryWorkspaceRuntime(body.action, projectId, actor.identity, {
      agent: createAgentClient(config.agentSocketPath), database: getProjectDatabase(config.databasePath)
    });
    return json({ workspaceState: observed.observedState, runtimeState: observed.runtimeStack.observedState }, 200);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, 409);
    if (error instanceof WorkspaceRuntimeExecutionError) return json({ message: error.message, code: error.code },
      error.code === "RUNTIME_ACTION_IN_PROGRESS" ? 202 : error.code === "RUNTIME_PLAN_UNSUPPORTED" ? 422 : 503);
    if (error instanceof RequestBodyTooLargeError) return json({ message: error.message }, 413);
    if (error instanceof RequestBodyMalformedError) return json({ message: "Request body must be valid JSON." }, 400);
    if (error instanceof Error && error.message === "CSRF_REJECTED") return json({ message: "Request origin could not be verified." }, 403);
    return json({ message: "The runtime action failed safely." }, 500);
  }
}
