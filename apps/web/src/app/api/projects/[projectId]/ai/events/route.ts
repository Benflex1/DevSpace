import { uuidV7Schema, aiAfterSequenceSchema, AI_EVENT_NDJSON_CONTENT_TYPE } from "@devspace/contracts";
import { createAgentClient } from "../../../../../../server/agent-client.js";
import { AuthenticationError, authenticateHeaders } from "../../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../../server/config.js";
import { getProjectDatabase } from "../../../../../../server/database.js";
import { preflightAiEventStream, streamAiEvents, toAiActionError } from "../../../../../../server/ai-sessions.js";

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const config = readWebRuntimeConfig(); await authenticateHeaders(request.headers, config.auth); const { projectId } = await context.params;
    const query = new URL(request.url).searchParams; const workspaceId = query.get("workspaceId"); const sessionId = query.get("sessionId"); const afterSequence = Number(query.get("afterSequence"));
    if (workspaceId === null || sessionId === null || !uuidV7Schema.safeParse(workspaceId).success || !uuidV7Schema.safeParse(sessionId).success || !aiAfterSequenceSchema.safeParse(afterSequence).success) return new Response("The AI stream cursor is invalid.", { status: 422 });
    const dependencies = { database: getProjectDatabase(config.databasePath), agent: createAgentClient(config.agentSocketPath) };
    const preflight = preflightAiEventStream(projectId, workspaceId, sessionId, afterSequence, dependencies);
    const downstreamCancellation = new AbortController();
    const iterator = streamAiEvents(projectId, workspaceId, sessionId, afterSequence, dependencies, preflight,
      { signal: downstreamCancellation.signal })[Symbol.asyncIterator]();
    const encoder = new TextEncoder();
    let browserCancelled = false;
    let iteratorCleanup: Promise<IteratorResult<unknown> | void> | null = null;
    let requestAbortListening = false;
    const removeRequestAbortListener = (): void => {
      if (!requestAbortListening) return;
      requestAbortListening = false;
      request.signal.removeEventListener("abort", onRequestAbort);
    };
    const returnIterator = (): Promise<IteratorResult<unknown> | void> => {
      iteratorCleanup ??= Promise.resolve(iterator.return?.(undefined)).catch(() => undefined);
      return iteratorCleanup;
    };
    const abortDownstream = (): void => {
      if (!downstreamCancellation.signal.aborted) downstreamCancellation.abort();
    };
    const onRequestAbort = (): void => {
      abortDownstream();
      void returnIterator().finally(removeRequestAbortListener).catch(() => undefined);
    };
    if (request.signal.aborted) abortDownstream();
    else {
      requestAbortListening = true;
      request.signal.addEventListener("abort", onRequestAbort, { once: true });
    }
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (downstreamCancellation.signal.aborted) {
            if (!browserCancelled) controller.close();
            return;
          }
          if (next.done) {
            removeRequestAbortListener();
            controller.close();
          } else controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
        } catch {
          if (downstreamCancellation.signal.aborted) return;
          removeRequestAbortListener();
          controller.error(new Error("AI event stream unavailable."));
        }
      },
      async cancel() {
        browserCancelled = true;
        abortDownstream();
        await returnIterator();
        removeRequestAbortListener();
      }
    });
    if (request.signal.aborted && !browserCancelled) {
      void returnIterator().finally(removeRequestAbortListener).catch(() => undefined);
    }
    return new Response(stream, { status: 200, headers: { "content-type": AI_EVENT_NDJSON_CONTENT_TYPE, "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthenticationError) return new Response("Authentication is required.", { status: 403 });
    const safe = toAiActionError(error); return new Response(safe.message, { status: 409 });
  }
}
