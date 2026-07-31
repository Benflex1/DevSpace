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
  test("keeps the canonical stream alive while delayed Stop finalization projects terminal events", async () => {
    const stopRequest = deferred<void>();
    const streamReady = deferred<void>();
    const finalFrames = deferred<string>();
    // This browser-level seam records projection/ack callbacks; route/server tests cover the real SQLite/Agent transaction.
    const projectedSequences: number[] = [];
    const acknowledgedFrames: Array<{ sequence: number; eventId: string }> = [];
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
      isTerminalObserved: () => browserState === "stopped",
      setPending: vi.fn()
    });

    const stream = consumeAiEventStream({
      initialSequence: 10,
      sessionId,
      signal: streamController.signal,
      open: (afterSequence) => {
        expect(afterSequence).toBe(10);
        return Promise.resolve(new Response(eventBody, { status: 200, headers: { "content-type": "application/x-ndjson" } }));
      },
      apply: (canonical) => {
        projectedSequences.push(canonical.sequence);
        acknowledgedFrames.push({ sequence: canonical.sequence, eventId: canonical.eventId });
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
    expect(projectedSequences).toEqual([11, 12]);
    expect(acknowledgedFrames).toEqual([
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
      isTerminalObserved: () => false,
      setPending: vi.fn()
    });

    expect(await coordinator.stop(sessionId)).toBe(false);
    expect(staleLoads).not.toHaveBeenCalled();
    expect(aiSessionMutationControls("active", false, false, 10).showRestart).toBe(false);
  });

  test("uses live terminal projection after stream loss during a pending Stop", async () => {
    const stopRequest = deferred<void>();
    // The old coordinator captured this render's false status and could not observe the later update.
    const capturedReconnecting = false;
    const streamStatus = { reconnecting: capturedReconnecting };
    const legacyStreamStatus = { isStreamUnavailable: () => capturedReconnecting };
    let terminalObserved = false;
    const projectedSequences: number[] = [];
    const acknowledgedFrames: Array<{ sequence: number; eventId: string }> = [];
    const reconcile = vi.fn(async () => {
      await consumeAiEventStream({
        initialSequence: 10,
        sessionId,
        signal: new AbortController().signal,
        open: () => Promise.resolve(new Response(`${[event(11, "session.stopping"), event(12, "session.stopped")].map((frame) => JSON.stringify(frame)).join("\n")}\n`, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" }
        })),
        apply: (canonical) => {
          projectedSequences.push(canonical.sequence);
          acknowledgedFrames.push({ sequence: canonical.sequence, eventId: canonical.eventId });
          if (canonical.eventType === "session.stopped") terminalObserved = true;
        },
        isTerminal: () => terminalObserved
      });
    });
    const coordinator = createAiSessionStopCoordinator({
      workspaceId,
      post: () => stopRequest.promise,
      isTerminalObserved: () => terminalObserved,
      reconcile,
      setPending: vi.fn(),
      ...legacyStreamStatus
    });

    const stop = coordinator.stop(sessionId);
    await Promise.resolve();
    streamStatus.reconnecting = true;
    expect(await coordinator.stop(sessionId)).toBe(false);
    expect(streamStatus.reconnecting).toBe(true);
    stopRequest.resolve();
    expect(await stop).toBe(true);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(projectedSequences).toEqual([11, 12]);
    expect(acknowledgedFrames).toEqual([
      { sequence: 11, eventId: "event-11" },
      { sequence: 12, eventId: "event-12" }
    ]);
    expect(terminalObserved).toBe(true);
    expect(aiSessionMutationControls("stopped", false, false, 12).showRestart).toBe(true);
  });
});
