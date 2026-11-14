import { NextResponse } from "next/server";
import { uuidV7Schema } from "@devspace/contracts";
import { AgentResponseError, AgentUnavailableError, createAgentClient } from "../../../../../../../server/agent-client.js";
import { AuthenticationError, authenticateHeaders } from "../../../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../../../server/config.js";
import { getProjectDatabase, ProjectSetupConflictError } from "../../../../../../../server/database.js";
import { readNativeCodexHistory } from "../../../../../../../server/harness-sessions.js";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request, context: { params: Promise<{ projectId: string; sessionId: string }> }) {
  try {
    const config = readWebRuntimeConfig();
    const actor = await authenticateHeaders(request.headers, config.auth);
    const { projectId, sessionId } = await context.params;
    const query = new URL(request.url).searchParams;
    const workspaceValues = query.getAll("workspaceId");
    const cursorValues = query.getAll("cursor");
    if (!uuidV7Schema.safeParse(projectId).success || !uuidV7Schema.safeParse(sessionId).success
      || workspaceValues.length !== 1 || !uuidV7Schema.safeParse(workspaceValues[0]).success
      || cursorValues.length > 1 || [...query.keys()].some((key) => key !== "workspaceId" && key !== "cursor")
      || (cursorValues[0]?.length ?? 0) > 2048) {
      return json({ message: "The Codex history request is invalid." }, 422);
    }
    const database = getProjectDatabase(config.databasePath);
    const agent = createAgentClient(config.agentSocketPath);
    const page = await readNativeCodexHistory({
      projectId, actor: actor.identity, workspaceId: workspaceValues[0]!, sessionId, cursor: cursorValues[0] ?? null
    }, { database, agent });
    return json(page);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof ProjectSetupConflictError) return json({ message: "The Codex history session is unavailable." }, 404);
    if (error instanceof AgentResponseError) {
      const status = error.code === "HISTORY_CURSOR_INVALID" ? 422
        : error.code === "HISTORY_UNAVAILABLE" ? 503 : 409;
      return json({ message: error.message, code: error.code }, status);
    }
    if (error instanceof AgentUnavailableError) return json({ message: "Codex history is temporarily unavailable." }, 503);
    return json({ message: "Codex history could not be read safely." }, 500);
  }
}
