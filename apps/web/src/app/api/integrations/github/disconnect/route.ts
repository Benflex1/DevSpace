import { NextResponse } from "next/server";
import { githubConnectionIdSchema } from "@devspace/contracts";
import { AgentResponseError, AgentUnavailableError, createAgentClient } from "../../../../../server/agent-client.js";
import { assertCsrf, authenticateHeaders, AuthenticationError } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { getProjectDatabase, ProjectSetupConflictError } from "../../../../../server/database.js";

export const dynamic = "force-dynamic";
function parseRequest(value: unknown): { connectionId: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, "connectionId")) return null;
  const connectionId = githubConnectionIdSchema.safeParse(record.connectionId);
  return connectionId.success ? { connectionId: connectionId.data } : null;
}

export async function POST(request: Request) {
  let fenced: { connectionId: string; lifecycleGeneration: number } | undefined;
  try {
    const config = readWebRuntimeConfig();
    const actor = await authenticateHeaders(request.headers, config.auth);
    assertCsrf(request, config.appOrigin);
    let body: { connectionId: string } | null;
    try { body = parseRequest(await request.json()); }
    catch { return NextResponse.json({ message: "The disconnect request is invalid." }, { status: 400 }); }
    if (body === null) return NextResponse.json({ message: "The disconnect request is invalid." }, { status: 400 });

    const database = getProjectDatabase(config.databasePath);
    const started = database.beginGithubDisconnect({ actor: actor.identity, connectionId: body.connectionId });
    fenced = { connectionId: body.connectionId, lifecycleGeneration: started.lifecycleGeneration };
    if (started.lifecycleState === "disconnected") {
      return NextResponse.json({ connectionId: started.connectionId, lifecycleGeneration: started.lifecycleGeneration,
        status: started.lifecycleState, cleanupState: started.cleanupState }, { headers: { "cache-control": "no-store" } });
    }
    const result = await createAgentClient(config.agentSocketPath).disconnectGithubInstallation(
      body.connectionId, started.lifecycleGeneration
    );
    const completed = database.completeGithubDisconnect({ actor: actor.identity, connectionId: body.connectionId,
      lifecycleGeneration: started.lifecycleGeneration, cleanupState: result.cleanupState });
    const responseBody = { connectionId: completed.connectionId, lifecycleGeneration: completed.lifecycleGeneration,
      status: completed.lifecycleState, cleanupState: completed.cleanupState };
    return NextResponse.json(responseBody, { status: completed.lifecycleState === "disconnected" ? 200 : 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ message: "Authentication is required." }, { status: 403 });
    if (error instanceof ProjectSetupConflictError) return NextResponse.json({ message: "The GitHub connection is not available to this actor." }, { status: 403 });
    if (error instanceof Error && error.message === "CSRF_REJECTED") return NextResponse.json({ message: "Request origin could not be verified." }, { status: 403 });
    if (error instanceof AgentResponseError && fenced !== undefined) {
      const status = error.code === "GITHUB_TOKEN_LEASE_ACTIVE" ? 409
        : error.code === "GITHUB_AUTHORITY_GENERATION_STALE" ? 409 : 503;
      return NextResponse.json({ connectionId: fenced.connectionId, lifecycleGeneration: fenced.lifecycleGeneration,
        status: "disconnect-pending", cleanupState: "pending", message: status === 409
          ? "GitHub token cleanup is still settling; disconnect remains pending." : "Disconnect is pending while the Agent is unavailable." },
      { status, headers: { "cache-control": "no-store" } });
    }
    if (error instanceof AgentUnavailableError && fenced !== undefined) {
      return NextResponse.json({ connectionId: fenced.connectionId, lifecycleGeneration: fenced.lifecycleGeneration,
        status: "disconnect-pending", cleanupState: "pending", message: "Disconnect is pending while the Agent is unavailable." },
      { status: 503, headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json({ message: "GitHub disconnect could not be completed safely." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
