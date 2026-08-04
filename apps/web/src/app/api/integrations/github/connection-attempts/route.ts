import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { assertCsrf, authenticateHeaders, AuthenticationError } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { createAgentClient } from "../../../../../server/agent-client.js";
import { getProjectDatabase } from "../../../../../server/database.js";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const config = readWebRuntimeConfig();
    const actor = await authenticateHeaders(request.headers, config.auth); assertCsrf(request, config.appOrigin);
    const app = await createAgentClient(config.agentSocketPath).inspectGithubApp();
    if (!app.configured || app.installationUrl === null) return NextResponse.json({ message: "GitHub App access is not configured." }, { status: 503 });
    const rawState = randomBytes(32).toString("base64url");
    const stateHash = createHash("sha256").update(rawState, "utf8").digest("hex");
    const attempt = getProjectDatabase(config.databasePath).createGithubConnectionAttempt({ actor: actor.identity, stateHash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
    const installation = new URL(app.installationUrl); installation.searchParams.set("state", rawState);
    return NextResponse.json({ connectionId: attempt.connectionId, installationUrl: installation.toString(), expiresAt: attempt.expiresAt },
      { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ message: "Authentication is required." }, { status: 403 });
    if (error instanceof Error && error.message === "CSRF_REJECTED") return NextResponse.json({ message: "Request origin could not be verified." }, { status: 403 });
    return NextResponse.json({ message: "GitHub connection could not be started safely." }, { status: 503 });
  }
}
