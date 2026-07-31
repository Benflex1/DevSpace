import { describe, expect, test, vi } from "vitest";
import { consumeAiEventStream, type BrowserAiEvent } from "./ai-session-stream.js";
import { aiSessionMutationControls } from "./ai-session-restart.js";
import { createAiSessionStopCoordinator } from "./ai-session-stop.js";

const sessionId = "018f0f00-0000-7000-8000-000000000103";
const workspaceId = "018f0f00-0000-7000-8000-000000000102";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function event(sequence: number, eventType: BrowserAiEvent["eventType"]): BrowserAiEvent {
  return {
    schemaVersion: "devspace.ai-event/v1",
    eventId: `event-${sequence}`,
    sessionId,
    turnId: null,
    sequence,
    observedAt: "2026-07-31T00:00:00.000Z",
    profile: { profileId: "codex", profileRevision: "revision", provider: "codex" },
    processGeneration: 1,
    eventType,
    payload: { reason: "user-request" }
  };
}

describe("browser Stop canonical convergence", () => {
  test("keeps the canonical stream alive while delayed Stop finalization commits and acknowledges terminal events", async () => {
    const stopRequest = deferred<void>();
    const streamReady = deferred<void>();
    const finalFrames = deferred<string>();
    const commits: number[] = [];
    const acknowledgements: Array<{ sequence: number; eventId: string }> = [];
    const staleLoads = vi.fn(() => Promise.resolve());
    let browserState = "active";
    const streamController = new AbortController();
    const eventBody = new ReadableStream<Uint8Array>({
      start(controller) {
        streamReady.resolve();
        void finalFrames.promise.then((frames) => {
          controller.enqueue(new TextEncoder().encode(frames));
          controller.close();
        }).catch(() => undefined);
      }
    });
    const coordinator = createAiSessionStopCoordinator({
      workspaceId,
      post: () => stopRequest.promise,
      reconcile: staleLoads,
      isStreamUnavailable: () => false,
      setPending: vi.fn()
    });

    const stream = consumeAiEventStream({
      initialSequence: 10,
      sessionId,
      signal: streamController.signal,
      open: (afterSequence) => {
        expect(afterSequence).toBe(10);
        return new Response(eventBody, { status: 200, headers: { "content-type": "application/x-ndjson" } });
      },
      apply: (canonical) => {
        commits.push(canonical.sequence);
        acknowledgements.push({ sequence: canonical.sequence, eventId: canonical.eventId });
        if (canonical.eventType === "session.stopped") browserState = "stopped";
      },
      isTerminal: () => browserState === "stopped"
    });

    await streamReady.promise;
    const stop = coordinator.stop(sessionId);
    await Promise.resolve();
    expect(streamController.signal.aborted).toBe(false);
    expect(staleLoads).not.toHaveBeenCalled();
    finalFrames.resolve(`${[event(11, "session.stopping"), event(12, "session.stopped")].map((frame) => JSON.stringify(frame)).join("\n")}\n`);
    await stream;
    expect(commits).toEqual([11, 12]);
    expect(acknowledgements).toEqual([
      { sequence: 11, eventId: "event-11" },
      { sequence: 12, eventId: "event-12" }
    ]);
    expect(browserState).toBe("stopped");
    expect(aiSessionMutationControls("stopped", false, false, 12).showRestart).toBe(true);
    stopRequest.resolve();
    expect(await stop).toBe(true);
    expect(staleLoads).not.toHaveBeenCalled();
  });

  test("does not project stopped or reconcile stale history when Stop is rejected", async () => {
    const staleLoads = vi.fn(() => Promise.resolve());
    const coordinator = createAiSessionStopCoordinator({
      workspaceId,
      post: () => Promise.reject(new Error("stop rejected")),
      reconcile: staleLoads,
      isStreamUnavailable: () => false,
      setPending: vi.fn()
    });

    expect(await coordinator.stop(sessionId)).toBe(false);
    expect(staleLoads).not.toHaveBeenCalled();
    expect(aiSessionMutationControls("active", false, false, 10).showRestart).toBe(false);
  });

  test("restarts canonical replay only when the live stream was already unavailable", async () => {
    const order: string[] = [];
    const reconcile = vi.fn(() => { order.push("reconcile"); });
    const coordinator = createAiSessionStopCoordinator({
      workspaceId,
      post: () => { order.push("post"); return Promise.resolve(); },
      isStreamUnavailable: () => true,
      reconcile,
      setPending: vi.fn()
    });

    expect(await coordinator.stop(sessionId)).toBe(true);
    expect(order).toEqual(["post", "reconcile"]);
    expect(reconcile).toHaveBeenCalledOnce();
  });
});
