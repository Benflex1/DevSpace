import { NextResponse } from "next/server";
import { githubContinuationSchema } from "@devspace/contracts";
import { authenticateHeaders, AuthenticationError } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { createAgentClient } from "../../../../../server/agent-client.js";
import { getProjectDatabase } from "../../../../../server/database.js";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const config = readWebRuntimeConfig(); const actor = await authenticateHeaders(request.headers, config.auth);
    const url = new URL(request.url); const pageSize = Number(url.searchParams.get("pageSize") ?? "25");
    const continuation = url.searchParams.get("continuation") ?? undefined;
    if ([...url.searchParams.keys()].some((key) => key !== "pageSize" && key !== "continuation")
      || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
      || (continuation !== undefined && !githubContinuationSchema.safeParse(continuation).success)) {
      return NextResponse.json({ message: "Repository pagination is invalid." }, { status: 400 });
    }
    const state = getProjectDatabase(config.databasePath).getGithubConnectionState(actor.identity);
    if (state?.connection === undefined || state.connection === null || state.connection.status === "failed") {
      return NextResponse.json({ message: "A verified GitHub connection is required." }, { status: 409 });
    }
    const page = await createAgentClient(config.agentSocketPath).listGithubRepositories(state.connection.connectionId, pageSize, continuation);
    return NextResponse.json(page, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ message: "Authentication is required." }, { status: 403 });
    return NextResponse.json({ message: "Authorized repositories could not be listed safely." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
