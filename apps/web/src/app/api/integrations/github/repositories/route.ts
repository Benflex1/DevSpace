import { NextResponse } from "next/server";
import { githubContinuationSchema } from "@devspace/contracts";
import { AgentResponseError, AgentUnavailableError, createAgentClient } from "../../../../../server/agent-client.js";
import { authenticateHeaders, AuthenticationError } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { getProjectDatabase } from "../../../../../server/database.js";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  let authorityContext: { connectionId: string; lifecycleGeneration: number } | undefined;
  let actorIdentity: string | undefined;
  try {
    const config = readWebRuntimeConfig(); const actor = await authenticateHeaders(request.headers, config.auth);
    actorIdentity = actor.identity;
    const url = new URL(request.url); const pageSize = Number(url.searchParams.get("pageSize") ?? "25");
    const continuation = url.searchParams.get("continuation") ?? undefined;
    if ([...url.searchParams.keys()].some((key) => key !== "pageSize" && key !== "continuation")
      || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
      || (continuation !== undefined && !githubContinuationSchema.safeParse(continuation).success)) {
      return NextResponse.json({ message: "Repository pagination is invalid." }, { status: 400 });
    }
    const database = getProjectDatabase(config.databasePath);
    const state = database.getGithubConnectionState(actor.identity);
    if (state?.connection === undefined || state.connection === null || state.connection.status === "failed") {
      return NextResponse.json({ message: "A verified GitHub connection is required." }, { status: 409 });
    }
    database.assertGithubConnectionOwned(actor.identity, state.connection.connectionId);
    const authority = database.getGithubAuthorityContext(actor.identity, state.connection.connectionId);
    if (!authority.admitted) return NextResponse.json({ message: "Reconnect the GitHub connection before listing private repositories." }, { status: 409 });
    authorityContext = { connectionId: authority.connectionId, lifecycleGeneration: authority.lifecycleGeneration };
    const page = await createAgentClient(config.agentSocketPath).listGithubRepositories(
      state.connection.connectionId, pageSize, continuation, authority.lifecycleGeneration
    );
    return NextResponse.json(page, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ message: "Authentication is required." }, { status: 403 });
    if (error instanceof AgentResponseError && authorityContext !== undefined) {
      const lifecycleState: "installation-removed" | "installation-suspended" | "permission-required" | "repository-access-unavailable" | "transient-error" | undefined = error.code === "GITHUB_INSTALLATION_REMOVED" ? "installation-removed"
        : error.code === "GITHUB_INSTALLATION_SUSPENDED" ? "installation-suspended"
        : error.code === "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE" ? "repository-access-unavailable"
        : error.code === "GITHUB_AUTHORITY_INVALID" && error.message.includes("permission") ? "permission-required"
        : error.code === "GITHUB_UPSTREAM_TRANSIENT" ? "transient-error" : undefined;
      if (lifecycleState !== undefined) {
        try { getProjectDatabase(readWebRuntimeConfig().databasePath).recordGithubAuthorityFailure({
          actor: actorIdentity!,
          ...authorityContext, failureCode: error.code, lifecycleState
        }); } catch { /* a newer lifecycle generation owns the state */ }
      }
      const status = error.code === "GITHUB_INSTALLATION_REMOVED" ? 410
        : error.code === "GITHUB_AUTHORITY_INVALID" ? 422
        : error.code === "GITHUB_INSTALLATION_SUSPENDED" || error.code === "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE" ? 403 : 503;
      return NextResponse.json({ message: status === 503 ? "GitHub is temporarily unavailable. Try again." : "GitHub repository access is no longer available." }, { status });
    }
    if (error instanceof AgentUnavailableError) return NextResponse.json({ message: "The DevSpace Agent is unavailable." }, { status: 503 });
    return NextResponse.json({ message: "Authorized repositories could not be listed safely." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
