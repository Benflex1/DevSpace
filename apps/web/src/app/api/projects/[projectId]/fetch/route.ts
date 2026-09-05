import { NextResponse } from "next/server";
import { AgentResponseError, AgentUnavailableError, createAgentClient } from "../../../../../server/agent-client.js";
import { AuthenticationError, assertCsrf, authenticateHeaders } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { ProjectSetupConflictError, getProjectDatabase } from "../../../../../server/database.js";
import { fetchProject, ProjectFetchError } from "../../../../../server/project-fetch.js";
import { normalizeUserFacingFailure } from "../../../../../server/user-facing-failure.js";

export const dynamic = "force-dynamic";
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let projectId: string | undefined;
  try {
    const config = readWebRuntimeConfig();
    const actor = await authenticateHeaders(request.headers, config.auth);
    assertCsrf(request, config.appOrigin);
    ({ projectId } = await context.params);
    const result = await fetchProject(projectId, actor.identity, {
      database: getProjectDatabase(config.databasePath), agent: createAgentClient(config.agentSocketPath)
    });
    return json(result, 200);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, 409);
    if (error instanceof ProjectFetchError) return json(normalizeUserFacingFailure(error, {
      fallbackMessage: "Repository fetch failed safely.", event: "web.project_fetch.failed",
      logMessage: "User-facing repository fetch failed", context: { ...(projectId === undefined ? {} : { projectId }) }
    }), error.code === "FETCH_IN_PROGRESS" ? 202 : 503);
    if (error instanceof AgentResponseError || error instanceof AgentUnavailableError) return json(normalizeUserFacingFailure(error, {
      fallbackMessage: "Repository fetch failed safely.", event: "web.project_fetch.failed",
      logMessage: "User-facing repository fetch failed", context: { ...(projectId === undefined ? {} : { projectId }) }
    }), 503);
    if (error instanceof Error && error.message === "CSRF_REJECTED") return json({ message: "Request origin could not be verified." }, 403);
    return json({ message: "Repository fetch failed safely." }, 500);
  }
}
