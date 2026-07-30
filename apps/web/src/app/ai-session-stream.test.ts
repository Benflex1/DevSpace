import { describe, expect, test, vi } from "vitest";
import { consumeAiEventStream, type BrowserAiEvent } from "./ai-session-stream.js";

const event = (sequence: number, eventType = "turn.started"): BrowserAiEvent => ({
  schemaVersion: "devspace.ai-event/v1",
  eventId: `event-${sequence}`,
  sessionId: "session-a",
  turnId: "turn-a",
  sequence,
  observedAt: "2026-07-30T00:00:00.000Z",
  profile: { profileId: "codex", profileRevision: "revision", provider: "codex" },
  processGeneration: 1,
  eventType,
  payload: {}
});

function response(frames: BrowserAiEvent[]): Response {
  return new Response(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" }
  });
}

describe("bounded browser AI event continuation", () => {
  test("reconnects from the exact last applied sequence after a capped response", async () => {
    const firstBatch = Array.from({ length: 512 }, (_, index) => event(index + 1));
    const second = event(513, "turn.quiesced");
    const cursors: number[] = [];
    const applied: number[] = [];
    const terminal = { value: false };
    const controller = new AbortController();

    await consumeAiEventStream({
      initialSequence: 0,
      sessionId: "session-a",
      signal: controller.signal,
      open: (afterSequence) => {
        cursors.push(afterSequence);
        return Promise.resolve(cursors.length === 1 ? response(firstBatch) : response([second]));
      },
      apply: (frame) => { applied.push(frame.sequence); if (frame.eventType === "turn.quiesced") terminal.value = true; },
      isTerminal: () => terminal.value,
      sleep: () => { controller.abort(); return Promise.resolve(); }
    });

    expect(cursors).toEqual([0, 512]);
    expect(applied).toHaveLength(513);
    expect(applied).toEqual(Array.from({ length: 513 }, (_, index) => index + 1));
  });

  test("does not continue after a terminal session event", async () => {
    const open = vi.fn(() => Promise.resolve(response([event(1, "session.stopped")])));
    const controller = new AbortController();
    let terminal = false;

    await consumeAiEventStream({
      initialSequence: 0,
      sessionId: "session-a",
      signal: controller.signal,
      open,
      apply: (frame) => { terminal = frame.eventType === "session.stopped"; },
      isTerminal: () => terminal,
      sleep: () => Promise.reject(new Error("sleep should not be called"))
    });

    expect(open).toHaveBeenCalledTimes(1);
  });

  test("backs off repeated zero-progress EOFs and stops when aborted", async () => {
    const controller = new AbortController();
    const open = vi.fn(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start: (stream) => stream.close() }), { status: 200 })));
    const delays: number[] = [];

    await consumeAiEventStream({
      initialSequence: 8,
      sessionId: "session-a",
      signal: controller.signal,
      open,
      apply: () => undefined,
      isTerminal: () => false,
      sleep: (delay) => {
        delays.push(delay);
        if (delays.length === 4) controller.abort();
        return Promise.resolve();
      }
    });

    expect(delays).toEqual([100, 200, 400, 800]);
    expect(open).toHaveBeenCalledTimes(4);
  });

  test("abort prevents stale continuation after session replacement", async () => {
    const controller = new AbortController();
    const open = vi.fn(() => Promise.resolve(response([event(1)])));
    const applied: number[] = [];

    await consumeAiEventStream({
      initialSequence: 0,
      sessionId: "session-a",
      signal: controller.signal,
      open,
      apply: (frame) => { applied.push(frame.sequence); controller.abort(); },
      isTerminal: () => false,
      sleep: () => Promise.resolve()
    });

    expect(applied).toEqual([1]);
    expect(open).toHaveBeenCalledTimes(1);
  });

  test("rejects a canonical event from a different selected session", async () => {
    const controller = new AbortController();
    const applied: number[] = [];
    await expect(consumeAiEventStream({
      initialSequence: 0,
      sessionId: "session-a",
      signal: controller.signal,
      open: () => Promise.resolve(response([{ ...event(1), sessionId: "session-b" }])),
      apply: (frame) => applied.push(frame.sequence),
      isTerminal: () => false,
      sleep: () => { controller.abort(); return Promise.resolve(); }
    })).rejects.toThrow("session identity changed");
    expect(applied).toEqual([]);
  });
});
