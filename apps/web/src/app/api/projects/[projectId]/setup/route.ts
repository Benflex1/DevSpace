import { NextResponse } from "next/server";
import { AgentResponseError, AgentUnavailableError, createAgentClient } from "../../../../../server/agent-client.js";
import { AuthenticationError, assertCsrf, authenticateHeaders } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { ProjectSetupConflictError, getProjectDatabase } from "../../../../../server/database.js";
import { RequestBodyMalformedError, RequestBodyTooLargeError, readBoundedJsonBody } from "../../../../../server/request-body.js";
import {
  WorkspaceSetupExecutionError, WorkspaceSetupValidationError, parseWorkspaceSetupInput, setupPrimaryWorkspace
} from "../../../../../server/workspace-setup.js";

export const dynamic = "force-dynamic";
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const config = readWebRuntimeConfig();
    const actor = await authenticateHeaders(request.headers, config.auth);
    assertCsrf(request, config.appOrigin);
    const input = parseWorkspaceSetupInput(await readBoundedJsonBody(request));
    const { projectId } = await context.params;
    const result = await setupPrimaryWorkspace(input, projectId, actor.identity, {
      agent: createAgentClient(config.agentSocketPath), database: getProjectDatabase(config.databasePath),
      previewBaseRegistry: config.previewBaseRegistry
    });
    return json(result, 200);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof WorkspaceSetupValidationError) return json({ message: error.message }, 422);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, 409);
    if (error instanceof WorkspaceSetupExecutionError) return json({ message: error.message, code: error.code }, error.code === "SETUP_IN_PROGRESS" ? 202 : 503);
    if (error instanceof AgentUnavailableError) return json({ message: "The DevSpace Agent is unavailable. Start it and retry setup." }, 503);
    if (error instanceof AgentResponseError) return json({ message: "The Agent rejected workspace setup.", code: error.code }, 503);
    if (error instanceof RequestBodyTooLargeError) return json({ message: error.message }, 413);
    if (error instanceof RequestBodyMalformedError) return json({ message: "Request body must be valid JSON." }, 400);
    if (error instanceof Error && error.message === "CSRF_REJECTED") return json({ message: "Request origin could not be verified." }, 403);
    return json({ message: "Workspace setup failed safely." }, 500);
  }
}
