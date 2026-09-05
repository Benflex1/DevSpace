import { NextResponse } from "next/server";
import { AgentResponseError, AgentUnavailableError, createAgentClient } from "../../../../../server/agent-client.js";
import { assertCsrf, authenticateHeaders, AuthenticationError } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { getProjectDatabase, ProjectSetupConflictError } from "../../../../../server/database.js";
import { normalizeUserFacingFailure } from "../../../../../server/user-facing-failure.js";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const config = readWebRuntimeConfig();
    const actor = await authenticateHeaders(request.headers, config.auth);
    assertCsrf(request, config.appOrigin);
    const database = getProjectDatabase(config.databasePath);
    const state = database.getGithubConnectionState(actor.identity);
    if (state?.connection === undefined || state.connection === null) {
      return NextResponse.json({ message: "A retained GitHub connection is required." }, { status: 409 });
    }
    database.assertGithubConnectionOwned(actor.identity, state.connection.connectionId);
    const refreshed = await createAgentClient(config.agentSocketPath).refreshGithubInstallation(state.connection.connectionId);
    database.connectGithubInstallation({ actor: actor.identity, ...refreshed });
    return NextResponse.json(refreshed, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ message: "Authentication is required." }, { status: 403 });
    if (error instanceof ProjectSetupConflictError) return NextResponse.json({ message: "The GitHub connection is not available to this actor." }, { status: 403 });
    if (error instanceof AgentResponseError || error instanceof AgentUnavailableError) {
      return NextResponse.json(normalizeUserFacingFailure(error, {
        fallbackMessage: "GitHub access could not be refreshed safely.",
        event: "web.github_access.refresh_failed",
        logMessage: "GitHub access refresh failed"
      }), { status: 503, headers: { "cache-control": "no-store" } });
    }
    if (error instanceof Error && error.message === "CSRF_REJECTED") return NextResponse.json({ message: "Request origin could not be verified." }, { status: 403 });
    return NextResponse.json({ message: "GitHub access could not be refreshed safely." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
