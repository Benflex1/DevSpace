import { NextResponse } from "next/server";
import { authenticateHeaders, AuthenticationError } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { createAgentClient } from "../../../../../server/agent-client.js";
import { getProjectDatabase } from "../../../../../server/database.js";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const config = readWebRuntimeConfig(); const actor = await authenticateHeaders(request.headers, config.auth);
    const database = getProjectDatabase(config.databasePath);
    const state = database.getGithubConnectionState(actor.identity);
    if (state?.connection !== undefined && state?.connection !== null) {
      database.assertGithubConnectionOwned(actor.identity, state.connection.connectionId);
      const inspected = await createAgentClient(config.agentSocketPath).inspectGithubInstallation(state.connection.connectionId);
      return NextResponse.json(inspected, { headers: { "cache-control": "no-store" } });
    }
    const app = await createAgentClient(config.agentSocketPath).inspectGithubApp();
    const status = state?.attempt.status === "claimed" ? "pending" : state?.attempt.status;
    return NextResponse.json({ status: app.configured ? status ?? "disconnected" : "unconfigured",
      connectionId: state?.attempt.connectionId ?? null, expiresAt: state?.attempt.expiresAt ?? null }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ message: "Authentication is required." }, { status: 403 });
    return NextResponse.json({ status: "failed" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
