import { createHash, randomBytes } from "node:crypto";
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
  try {
    const config = readWebRuntimeConfig();
    const actor = await authenticateHeaders(request.headers, config.auth);
    assertCsrf(request, config.appOrigin);
    let body: { connectionId: string } | null;
    try { body = parseRequest(await request.json()); }
    catch { return NextResponse.json({ message: "The reconnect request is invalid." }, { status: 400 }); }
    if (body === null) return NextResponse.json({ message: "The reconnect request is invalid." }, { status: 400 });

    const agent = createAgentClient(config.agentSocketPath);
    const app = await agent.inspectGithubApp();
    if (!app.configured || app.installationUrl === null) {
      return NextResponse.json({ message: "GitHub App access is not configured by the administrator." }, { status: 503 });
    }
    const rawState = randomBytes(32).toString("base64url");
    const stateHash = createHash("sha256").update(rawState, "utf8").digest("hex");
    const database = getProjectDatabase(config.databasePath);
    database.assertGithubConnectionOwned(actor.identity, body.connectionId);
    const attempt = database.createGithubConnectionAttempt({ actor: actor.identity, connectionId: body.connectionId, stateHash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
    const prepared = await agent.prepareGithubReconnect(attempt.connectionId, attempt.lifecycleGeneration);
    const installation = new URL(app.installationUrl);
    installation.searchParams.set("state", rawState);
    return NextResponse.json({ connectionId: attempt.connectionId, lifecycleGeneration: attempt.lifecycleGeneration,
      status: prepared.lifecycleState, installationUrl: installation.toString(), expiresAt: attempt.expiresAt },
    { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ message: "Authentication is required." }, { status: 403 });
    if (error instanceof ProjectSetupConflictError) return NextResponse.json({ message: "The GitHub connection is not available to this actor." }, { status: 403 });
    if (error instanceof Error && error.message === "CSRF_REJECTED") return NextResponse.json({ message: "Request origin could not be verified." }, { status: 403 });
    if (error instanceof AgentResponseError && error.code === "GITHUB_TOKEN_LEASE_ACTIVE") {
      return NextResponse.json({ status: "reconnect-pending", message: "GitHub token cleanup is still settling. Try reconnect again after it completes." }, { status: 409 });
    }
    if (error instanceof AgentResponseError || error instanceof AgentUnavailableError) {
      return NextResponse.json({ status: "reconnect-pending", message: "GitHub reconnect is pending while the Agent is unavailable." }, { status: 503 });
    }
    return NextResponse.json({ status: "reconnect-pending", message: "GitHub reconnect could not be started safely." }, { status: 503 });
  }
}
