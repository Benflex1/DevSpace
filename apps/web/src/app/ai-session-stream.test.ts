import { describe, expect, test, vi } from "vitest";
import { consumeAiEventStream, sleepWithAbort, type BrowserAiEvent } from "./ai-session-stream.js";

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

function controlResponse(frameType: "stream.unavailable" | "stream.failed", message: string): Response {
  return new Response(`${JSON.stringify({ frameType, message })}\n`, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" }
  });
}

function unavailableResponse(): Response {
  return new Response("The live AI connection is temporarily unavailable.", { status: 503 });
}

function eventAndControlResponse(frame: BrowserAiEvent, message: string): Response {
  return new Response(`${JSON.stringify(frame)}\n${JSON.stringify({ frameType: "stream.unavailable", message })}\n`, {
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

  test("does not let a trailing failure control override a terminal session event", async () => {
    let terminal = false;
    await consumeAiEventStream({
      initialSequence: 0,
      sessionId: "session-a",
      signal: new AbortController().signal,
      open: () => Promise.resolve(new Response(`${JSON.stringify(event(1, "session.stopped"))}\n${JSON.stringify({ frameType: "stream.failed", message: "unexpected" })}\n`, { status: 200 })),
      apply: (frame) => { terminal = frame.eventType === "session.stopped"; },
      isTerminal: () => terminal,
      sleep: () => Promise.reject(new Error("sleep should not be called"))
    });
    expect(terminal).toBe(true);
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

  test("bounds unexpected clean EOFs and reports a failed, non-terminal disconnect", async () => {
    const open = vi.fn(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start: (stream) => stream.close() }), { status: 200 })));
    const statuses: string[] = [];

    await expect(consumeAiEventStream({
      initialSequence: 8,
      sessionId: "session-a",
      signal: new AbortController().signal,
      open,
      apply: () => undefined,
      isTerminal: () => false,
      onStatus: (status) => { statuses.push(status); },
      sleep: () => Promise.resolve()
    })).rejects.toMatchObject({ kind: "failed", message: "The AI event stream ended unexpectedly. Committed history is preserved." });

    expect(open).toHaveBeenCalledTimes(7);
    expect(statuses.at(-1)).toBe("failed");
  });

  test("bounds temporary unavailable reconnects and surfaces the last safe message", async () => {
    const controller = new AbortController();
    const open = vi.fn(() => Promise.resolve(controlResponse("stream.unavailable", "Start the workspace runtime before reconnecting.")));
    const delays: number[] = [];
    const statuses: string[] = [];

    await expect(consumeAiEventStream({
      initialSequence: 8,
      sessionId: "session-a",
      signal: controller.signal,
      open,
      apply: () => undefined,
      isTerminal: () => false,
      onStatus: (status) => { statuses.push(status); },
      sleep: (delay) => { delays.push(delay); return Promise.resolve(); }
    })).rejects.toThrow("Start the workspace runtime before reconnecting.");

    expect(open).toHaveBeenCalledTimes(7);
    expect(delays).toEqual([100, 200, 400, 800, 1_600, 3_000]);
    expect(statuses.at(-1)).toBe("unavailable");
  });

  test("bounds repeated unavailable responses before HTTP stream commitment", async () => {
    const open = vi.fn(() => Promise.resolve(unavailableResponse()));
    const delays: number[] = [];
    const statuses: string[] = [];

    await expect(consumeAiEventStream({
      initialSequence: 8,
      sessionId: "session-a",
      signal: new AbortController().signal,
      open,
      apply: () => undefined,
      isTerminal: () => false,
      onStatus: (status) => { statuses.push(status); },
      sleep: (delay) => { delays.push(delay); return Promise.resolve(); }
    })).rejects.toMatchObject({ kind: "unavailable" });

    expect(open).toHaveBeenCalledTimes(7);
    expect(delays).toEqual([100, 200, 400, 800, 1_600, 3_000]);
    expect(statuses.at(-1)).toBe("unavailable");
  });

  test("does not reset the temporary-outage bound just because a stale frame was applied", async () => {
    const controller = new AbortController();
    const open = vi.fn()
      .mockResolvedValueOnce(eventAndControlResponse(event(9), "Runtime is unavailable."))
      .mockImplementation(() => Promise.resolve(controlResponse("stream.unavailable", "Runtime is unavailable.")));
    const delays: number[] = [];

    await expect(consumeAiEventStream({
      initialSequence: 8,
      sessionId: "session-a",
      signal: controller.signal,
      open,
      apply: () => undefined,
      isTerminal: () => false,
      sleep: (delay) => { delays.push(delay); return Promise.resolve(); }
    })).rejects.toThrow("Runtime is unavailable.");

    expect(open).toHaveBeenCalledTimes(7);
    expect(delays).toEqual([100, 200, 400, 800, 1_600, 3_000]);
  });

  test("does not treat an unexpected stream failure control as successful completion", async () => {
    const controller = new AbortController();
    const open = vi.fn(() => Promise.resolve(controlResponse("stream.failed", "The AI stream ended unexpectedly.")));
    const statuses: string[] = [];

    await expect(consumeAiEventStream({
      initialSequence: 8,
      sessionId: "session-a",
      signal: controller.signal,
      open,
      apply: () => undefined,
      isTerminal: () => false,
      onStatus: (status) => { statuses.push(status); },
      sleep: () => Promise.reject(new Error("sleep should not be called"))
    })).rejects.toThrow("The AI stream ended unexpectedly.");

    expect(open).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["connected", "failed"]);
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
      apply: (frame) => { applied.push(frame.sequence); },
      isTerminal: () => false,
      sleep: () => { controller.abort(); return Promise.resolve(); }
    })).rejects.toThrow("session identity changed");
    expect(applied).toEqual([]);
  });

  test("ignores only an exact duplicate sequence and event identity across continuation", async () => {
    const controller = new AbortController();
    const applied: number[] = [];
    const first = event(1);
    const second = event(2, "session.stopped");

    await consumeAiEventStream({
      initialSequence: 0,
      sessionId: "session-a",
      signal: controller.signal,
      open: vi.fn()
        .mockResolvedValueOnce(response([first]))
        .mockResolvedValueOnce(response([first, second])),
      apply: (frame) => { applied.push(frame.sequence); },
      isTerminal: () => applied.includes(2),
      sleep: () => Promise.resolve()
    });

    expect(applied).toEqual([1, 2]);
  });

  test.each([
    ["same sequence with another event ID", [event(1), { ...event(1), eventId: "conflict" }], "conflicting event identity"],
    ["a lower sequence", [event(1)], "out-of-order"],
    ["a sequence gap", [event(2)], "contiguous"]
  ])("fails closed for %s", async (_label, frames, message) => {
    const controller = new AbortController();
    const applied: number[] = [];
    await expect(consumeAiEventStream({
      initialSequence: _label === "a lower sequence" ? 2 : 0,
      sessionId: "session-a",
      signal: controller.signal,
      open: () => Promise.resolve(response(frames)),
      apply: (frame) => { applied.push(frame.sequence); },
      isTerminal: () => false
    })).rejects.toThrow(message);
    expect(applied).toEqual(_label === "same sequence with another event ID" ? [1] : []);
  });

  test("does not advance the cursor when apply fails", async () => {
    const controller = new AbortController();
    const open = vi.fn(() => Promise.resolve(response([event(1)])));
    await expect(consumeAiEventStream({
      initialSequence: 0,
      sessionId: "session-a",
      signal: controller.signal,
      open,
      apply: () => { throw new Error("apply failed"); },
      isTerminal: () => false
    })).rejects.toThrow("apply failed");
    expect(open).toHaveBeenCalledWith(0, expect.any(AbortSignal));
  });

  test("cancels the active reader when parsing fails", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode("not-json\n")); },
      cancel() { cancelled = true; }
    });
    const controller = new AbortController();
    await expect(consumeAiEventStream({
      initialSequence: 0,
      sessionId: "session-a",
      signal: controller.signal,
      open: () => Promise.resolve(new Response(body, { status: 200 })),
      apply: () => undefined,
      isTerminal: () => false
    })).rejects.toThrow();
    expect(cancelled).toBe(true);
  });

  test("removes the default sleep abort listener after normal completion", async () => {
    const controller = new AbortController();
    await sleepWithAbort(0, controller.signal);
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });
});
