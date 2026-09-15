import { uuidV7Schema, aiAfterSequenceSchema, AI_EVENT_NDJSON_CONTENT_TYPE } from "@devspace/contracts";
import { createAgentClient } from "../../../../../../server/agent-client.js";
import { AuthenticationError, authenticateHeaders } from "../../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../../server/config.js";
import { getProjectDatabase } from "../../../../../../server/database.js";
import { preflightAiEventStream, streamAiEvents, toAiActionError } from "../../../../../../server/ai-sessions.js";

const TEMPORARY_STREAM_MESSAGE = "The live AI connection is temporarily unavailable. Committed history is preserved.";
const UNEXPECTED_STREAM_MESSAGE = "The AI event stream ended unexpectedly. Committed history is preserved.";
// A replay/control frame is useful preflight evidence when it is immediately
// available, but an idle live session must not hold the HTTP response open.
const STREAM_PREFLIGHT_TIMEOUT_MS = 0;

type StreamErrorLike = Error & {
  code?: unknown;
  retryable?: unknown;
  failureCategory?: unknown;
};

function streamErrorLike(error: unknown): StreamErrorLike | null {
  return error instanceof Error ? error : null;
}

function isTemporaryStreamFailure(error: unknown): boolean {
  const candidate = streamErrorLike(error);
  if (candidate === null) return false;
  return candidate.code === "AI_OUTBOX_UNAVAILABLE"
    || candidate.code === "AGENT_UNAVAILABLE"
    || candidate.code === "AGENT_REQUEST_TIMEOUT";
}

function streamFailureControl(error: unknown): { frameType: "stream.unavailable" | "stream.failed"; message: string } {
  return isTemporaryStreamFailure(error)
    ? { frameType: "stream.unavailable", message: TEMPORARY_STREAM_MESSAGE }
    : { frameType: "stream.failed", message: UNEXPECTED_STREAM_MESSAGE };
}

function preflightStreamFailureResponse(error: unknown): Response {
  if (isTemporaryStreamFailure(error)) return new Response(TEMPORARY_STREAM_MESSAGE, { status: 503 });
  const code = streamErrorLike(error)?.code;
  if (code === "AI_EVENT_GAP") return new Response("The requested AI event history is no longer retained.", { status: 409 });
  return new Response(UNEXPECTED_STREAM_MESSAGE, { status: 500 });
}

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
    const firstFramePromise = iterator.next();
    let preflightResult: { kind: "frame"; frame: IteratorResult<unknown> } | { kind: "error"; error: unknown } | { kind: "timeout" };
    let preflightTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      preflightResult = await Promise.race([
        firstFramePromise.then(
          (frame) => ({ kind: "frame" as const, frame }),
          (error: unknown) => ({ kind: "error" as const, error })
        ),
        new Promise<{ kind: "timeout" }>((resolve) => {
          preflightTimer = setTimeout(() => resolve({ kind: "timeout" }), STREAM_PREFLIGHT_TIMEOUT_MS);
        })
      ]);
    } finally {
      if (preflightTimer !== undefined) clearTimeout(preflightTimer);
    }
    if (preflightResult.kind === "error") {
      const error = preflightResult.error;
      if (downstreamCancellation.signal.aborted) {
        await returnIterator();
        removeRequestAbortListener();
        return new Response(null, { status: 204 });
      }
      await returnIterator();
      removeRequestAbortListener();
      return preflightStreamFailureResponse(error);
    }
    if (downstreamCancellation.signal.aborted) {
      await returnIterator();
      removeRequestAbortListener();
      return new Response(null, { status: 204 });
    }
    if (preflightResult.kind === "frame" && preflightResult.frame.done) {
      await returnIterator();
      removeRequestAbortListener();
      return new Response(TEMPORARY_STREAM_MESSAGE, { status: 503 });
    }
    let pendingFrame: IteratorResult<unknown> | Promise<IteratorResult<unknown>> | null = preflightResult.kind === "frame"
      ? preflightResult.frame : firstFramePromise;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await (pendingFrame ?? iterator.next());
          pendingFrame = null;
          if (downstreamCancellation.signal.aborted) {
            if (!browserCancelled) controller.close();
            return;
          }
          if (next.done) {
            removeRequestAbortListener();
            controller.close();
          } else controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
        } catch (error) {
          if (downstreamCancellation.signal.aborted) return;
          removeRequestAbortListener();
          if (browserCancelled) return;
          try { controller.enqueue(encoder.encode(`${JSON.stringify(streamFailureControl(error))}\n`)); } catch { /* the body may already be closed */ }
          try { controller.close(); } catch { /* the body may already be closed */ }
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
