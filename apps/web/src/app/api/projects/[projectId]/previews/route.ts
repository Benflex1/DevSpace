import { NextResponse } from "next/server";
import { AuthenticationError, assertCsrf, authenticateHeaders } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { ProjectSetupConflictError, getProjectDatabase } from "../../../../../server/database.js";
import { AgentResponseError, createAgentClient } from "../../../../../server/agent-client.js";
import { PreviewOrchestrationError, reconcileWorkspacePreviews, reloadPreview } from "../../../../../server/preview-orchestration.js";
import { RequestBodyMalformedError, RequestBodyTooLargeError, readBoundedJsonBody } from "../../../../../server/request-body.js";

export const dynamic = "force-dynamic";
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const config = readWebRuntimeConfig();
    const actor = await authenticateHeaders(request.headers, config.auth);
    const { projectId } = await context.params;
    const database = getProjectDatabase(config.databasePath);
    const previews = await reconcileWorkspacePreviews(projectId, actor.identity, "observe", {
      database, agent: createAgentClient(config.agentSocketPath), previewBaseRegistry: config.previewBaseRegistry
    });
    return json({ previews }, 200);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof ProjectSetupConflictError || error instanceof PreviewOrchestrationError) return json({ message: error.message }, 404);
    return json({ message: "Preview state is temporarily unavailable." }, 503);
  }
}
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const config = readWebRuntimeConfig();
    const actor = await authenticateHeaders(request.headers, config.auth);
    assertCsrf(request, config.appOrigin);
    const body = await readBoundedJsonBody(request);
    if (body === null || typeof body !== "object" || Array.isArray(body)) return json({ message: "Choose a preview action." }, 422);
    const record = body as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || record.action !== "reload" || typeof record.previewId !== "string") {
      return json({ message: "Choose a valid preview action." }, 422);
    }
    const { projectId } = await context.params;
    const database = getProjectDatabase(config.databasePath);
    const previews = await reloadPreview(projectId, record.previewId, actor.identity, {
      database, agent: createAgentClient(config.agentSocketPath), previewBaseRegistry: config.previewBaseRegistry
    });
    return json({ previews }, 200);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof Error && error.message === "CSRF_REJECTED") return json({ message: "Request origin could not be verified." }, 403);
    if (error instanceof RequestBodyTooLargeError) return json({ message: error.message }, 413);
    if (error instanceof RequestBodyMalformedError) return json({ message: "Request body must be valid JSON." }, 400);
    if (error instanceof ProjectSetupConflictError || error instanceof PreviewOrchestrationError || error instanceof AgentResponseError) {
      return json({ message: error.message, code: error instanceof AgentResponseError ? error.code : error instanceof PreviewOrchestrationError ? error.code : "PREVIEW_ACTION_NOT_AUTHORIZED" }, 409);
    }
    return json({ message: "The preview action failed safely." }, 503);
  }
}
