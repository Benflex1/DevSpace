import { NextResponse } from "next/server";
import { uuidV7Schema } from "@devspace/contracts";
import { createAgentClient } from "../../../../../../server/agent-client.js";
import { AuthenticationError, authenticateHeaders } from "../../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../../server/config.js";
import { inspectAiProviderStatus, toAiActionError } from "../../../../../../server/ai-sessions.js";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const config = readWebRuntimeConfig();
    await authenticateHeaders(request.headers, config.auth);
    const { projectId } = await context.params;
    const workspaceId = new URL(request.url).searchParams.get("workspaceId");
    if (workspaceId === null || !uuidV7Schema.safeParse(workspaceId).success) {
      return json({ message: "The workspace identity is invalid." }, 422);
    }

    const profile = await inspectAiProviderStatus(projectId, workspaceId, createAgentClient(config.agentSocketPath));
    return json({ profile });
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    const safe = toAiActionError(error);
    return json({ message: safe.message, code: safe.code }, safe.code === "AI_PROFILE_UNAVAILABLE" ? 503 : 409);
  }
}
