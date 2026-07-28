import { uuidV7Schema, aiAfterSequenceSchema, AI_EVENT_NDJSON_CONTENT_TYPE } from "@devspace/contracts";
import { createAgentClient } from "../../../../../../server/agent-client.js";
import { AuthenticationError, authenticateHeaders } from "../../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../../server/config.js";
import { getProjectDatabase } from "../../../../../../server/database.js";
import { streamAiEvents, toAiActionError } from "../../../../../../server/ai-sessions.js";

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const config = readWebRuntimeConfig(); await authenticateHeaders(request.headers, config.auth); const { projectId } = await context.params;
    const query = new URL(request.url).searchParams; const workspaceId = query.get("workspaceId"); const sessionId = query.get("sessionId"); const afterSequence = Number(query.get("afterSequence"));
    if (workspaceId === null || sessionId === null || !uuidV7Schema.safeParse(workspaceId).success || !uuidV7Schema.safeParse(sessionId).success || !aiAfterSequenceSchema.safeParse(afterSequence).success) return new Response("The AI stream cursor is invalid.", { status: 422 });
    const iterator = streamAiEvents(projectId, workspaceId, sessionId, afterSequence,
      { database: getProjectDatabase(config.databasePath), agent: createAgentClient(config.agentSocketPath) })[Symbol.asyncIterator]();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close(); else controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
        } catch { controller.error(new Error("AI event stream unavailable.")); }
      },
      async cancel() { await iterator.return?.(undefined); }
    });
    return new Response(stream, { status: 200, headers: { "content-type": AI_EVENT_NDJSON_CONTENT_TYPE, "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthenticationError) return new Response("Authentication is required.", { status: 403 });
    const safe = toAiActionError(error); return new Response(safe.message, { status: 409 });
  }
}
