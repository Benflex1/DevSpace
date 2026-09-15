import http, { type ClientRequest, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CanonicalAiEvent } from "@devspace/contracts";
import { createAgentServer, type AgentServer, type AgentServerOptions } from "./server.js";
import type { AiSessionRuntime } from "./ai-session-runtime.js";
import { AiOutboxError } from "./ai-session-outbox.js";

const timestamp = "2026-07-30T00:00:00.000Z";
const sessionIds = [
  "018f1f34-7000-7000-8000-000000000101",
  "018f1f34-7000-7000-8000-000000000102",
  "018f1f34-7000-7000-8000-000000000103",
  "018f1f34-7000-7000-8000-000000000104",
  "018f1f34-7000-7000-8000-000000000105"
] as const;
const roots: string[] = [];
const activeServers: AgentServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map(async (server) => { await server.stop(); }));
  await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }); }));
});

function event(sequence: number, sessionId = sessionIds[0], text = `event-${sequence}`): CanonicalAiEvent {
  return {
    schemaVersion: "devspace.ai-event/v1",
    eventId: `018f1f34-7000-7000-8000-${sequence.toString(16).padStart(12, "0")}`,
    sessionId,
    turnId: "018f1f34-7000-7000-8000-000000000201",
    sequence,
    observedAt: timestamp,
    profile: {
      profileId: "codex",
      profileRevision: `sha256-ai-profile-v1:${"a".repeat(64)}`,
      provider: "codex"
    },
    processGeneration: 1,
    eventType: "turn.output.completed",
    payload: { stream: "assistant", text }
  };
}

function createRuntime(initialEvents: CanonicalAiEvent[] = [], options: { synchronizedError?: Error } = {}) {
  const durable = [...initialEvents];
  const listeners = new Set<(value: CanonicalAiEvent) => void>();
  let unsubscribeCalls = 0;
  const replay = vi.fn(async (_sessionId: string, afterSequence: number) => {
    await Promise.resolve();
    return durable.filter((value) => value.sequence > afterSequence);
  });
  const subscribe = vi.fn(async (_sessionId: string, afterSequence: number, listener: (value: CanonicalAiEvent) => void) => {
    await Promise.resolve();
    for (const value of durable.filter((candidate) => candidate.sequence > afterSequence)) listener(value);
    listeners.add(listener);
    return () => {
      unsubscribeCalls += 1;
      listeners.delete(listener);
    };
  });
  const synchronized = vi.fn(() => options.synchronizedError === undefined
    ? Promise.resolve({ processGeneration: 1, pendingInteractionIds: [] as string[] })
    : Promise.reject(options.synchronizedError));
  const runtime = {
    inspect: vi.fn(), start: vi.fn(), sendTurn: vi.fn(), interrupt: vi.fn(), stop: vi.fn(),
    respondToAiApproval: vi.fn(), respondToAiStructuredInput: vi.fn(), synchronized,
    replay, subscribe, acknowledge: vi.fn(), collect: vi.fn()
  } as unknown as AiSessionRuntime;
  return {
    runtime,
    replay,
    subscribe,
    synchronized,
    append(value: CanonicalAiEvent) {
      durable.push(value);
      for (const listener of listeners) listener(value);
    },
    get unsubscribeCalls() { return unsubscribeCalls; }
  };
}

async function startServer(runtime: AiSessionRuntime, streamOptions: Partial<AgentServerOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "devspace-ai-stream-resources-"));
  roots.push(root);
  const socketPath = join(root, "agent.sock");
  const server = createAgentServer({
    socketPath,
    managedRoots: {
      projects: join(root, "projects"),
      workspaces: join(root, "workspaces"),
      state: join(root, "state")
    },
    aiRuntime: runtime,
    ...streamOptions
  });
  activeServers.push(server);
  await server.start();
  return { server, socketPath };
}

function openStream(socketPath: string, sessionId: string, afterSequence = 0): Promise<{
  request: ClientRequest;
  response: IncomingMessage;
}> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      method: "GET",
      path: `/v1/ai-sessions/${sessionId}/events?afterSequence=${afterSequence}`,
      headers: {
        "X-DevSpace-Protocol-Version": "1",
        "X-DevSpace-Request-Id": "018f1f34-7000-7000-8000-000000000301",
        "X-DevSpace-Sent-At": timestamp
      }
    }, (response) => resolve({ request, response }));
    request.once("error", reject);
    request.end();
  });
}

async function closeStream(stream: { request: ClientRequest; response: IncomingMessage }): Promise<void> {
  stream.response.destroy();
  stream.request.destroy();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition-timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function collectFramesUntil(
  response: IncomingMessage,
  complete: (frames: Array<Record<string, unknown>>) => boolean,
  timeoutMs = 5_000
): Promise<Array<Record<string, unknown>>> {
  return await new Promise((resolve, reject) => {
    const frames: Array<Record<string, unknown>> = [];
    let pending = "";
    const timer = setTimeout(() => reject(new Error("frame-timeout")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      response.off("data", onData);
      response.off("error", onError);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onData = (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        frames.push(JSON.parse(pending.slice(0, newline)) as Record<string, unknown>);
        pending = pending.slice(newline + 1);
        if (complete(frames)) {
          cleanup();
          resolve(frames);
          return;
        }
      }
    };
    response.on("data", onData);
    response.once("error", onError);
    response.resume();
  });
}

describe("Agent AI event stream resource bounds", () => {
  test("ends cleanly when the outbox becomes unavailable after HTTP 200", async () => {
    const harness = createRuntime([], { synchronizedError: new AiOutboxError("AI_OUTBOX_UNAVAILABLE") });
    const { socketPath } = await startServer(harness.runtime);
    const stream = await openStream(socketPath, sessionIds[0]);
    expect(stream.response.statusCode).toBe(200);
    const outcome = await new Promise<"end" | "error">((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stream-did-not-close")), 500);
      stream.response.once("end", () => { clearTimeout(timer); resolve("end"); });
      stream.response.once("error", () => { clearTimeout(timer); resolve("error"); });
      stream.response.resume();
    });
    expect(outcome).toBe("end");
  });

  test("admits four streams globally, denies the fifth before replay, and releases a closed slot", async () => {
    const harness = createRuntime();
    const { socketPath } = await startServer(harness.runtime);
    const streams: Array<{ request: ClientRequest; response: IncomingMessage }> = [];
    for (const sessionId of sessionIds.slice(0, 4)) streams.push(await openStream(socketPath, sessionId));
    const denied = await openStream(socketPath, sessionIds[4]);
    try {
      expect(denied.response.statusCode).toBe(503);
      expect(harness.replay).toHaveBeenCalledTimes(4);
      await closeStream(streams.pop()!);
      const replacement = await openStream(socketPath, sessionIds[4]);
      expect(replacement.response.statusCode).toBe(200);
      await closeStream(replacement);
    } finally {
      await closeStream(denied);
      await Promise.all(streams.map(closeStream));
    }
  });

  test("admits two streams per session, denies the third, and releases both slots exactly once", async () => {
    const harness = createRuntime();
    const { socketPath } = await startServer(harness.runtime);
    const first = await openStream(socketPath, sessionIds[0]);
    const second = await openStream(socketPath, sessionIds[0]);
    const denied = await openStream(socketPath, sessionIds[0]);
    try {
      expect(denied.response.statusCode).toBe(503);
      expect(harness.subscribe).toHaveBeenCalledTimes(2);
      await Promise.all([closeStream(first), closeStream(second)]);
      expect(harness.unsubscribeCalls).toBe(2);
      const replacement = await openStream(socketPath, sessionIds[0]);
      expect(replacement.response.statusCode).toBe(200);
      await closeStream(replacement);
    } finally {
      await Promise.all([closeStream(first), closeStream(second), closeStream(denied)]);
    }
  });

  test("stops replay when write backpressure persists and disconnects on the bounded timeout", async () => {
    const large = "x".repeat(1_048_000);
    const harness = createRuntime(Array.from({ length: 32 }, (_, index) => event(index + 1, sessionIds[0], large)));
    const { socketPath } = await startServer(harness.runtime, {
      aiStreamBackpressureTimeoutMs: 50,
      aiStreamPerSessionLimit: 1
    });
    const stream = await openStream(socketPath, sessionIds[0]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(harness.subscribe).not.toHaveBeenCalled();
      expect(harness.unsubscribeCalls).toBe(0);
      const replacement = await openStream(socketPath, sessionIds[0]);
      try { expect(replacement.response.statusCode).toBe(200); }
      finally { await closeStream(replacement); }
    } finally { await closeStream(stream); }
  });

  test("disconnects only a live subscriber whose 33rd queued event overflows the count bound", async () => {
    const harness = createRuntime();
    const { socketPath } = await startServer(harness.runtime);
    const stream = await openStream(socketPath, sessionIds[0]);
    await waitFor(() => harness.subscribe.mock.calls.length === 1);
    let closed = false;
    stream.response.once("close", () => { closed = true; });
    try {
      for (let sequence = 1; sequence <= 34; sequence += 1) harness.append(event(sequence));
      await waitFor(() => closed || stream.response.destroyed || harness.unsubscribeCalls === 1);
      expect(harness.unsubscribeCalls).toBe(1);
      expect(harness.replay).toHaveBeenCalledTimes(1);
    } finally { await closeStream(stream); }
  });

  test("disconnects a live subscriber before a queued byte limit can be exceeded", async () => {
    const harness = createRuntime();
    const { socketPath } = await startServer(harness.runtime, {
      aiStreamLiveQueueMaxBytes: 1_024
    });
    const stream = await openStream(socketPath, sessionIds[0]);
    await waitFor(() => harness.subscribe.mock.calls.length === 1);
    let closed = false;
    stream.response.once("close", () => { closed = true; });
    try {
      harness.append(event(1, sessionIds[0], "x".repeat(2_000)));
      await waitFor(() => closed);
      expect(harness.unsubscribeCalls).toBe(1);
    } finally { await closeStream(stream); }
  });

  test("pauses retained replay on write(false), drains in order, then catches up events appended while blocked", async () => {
    const large = "x".repeat(1_048_000);
    const replayed = Array.from({ length: 32 }, (_, index) => event(index + 1, sessionIds[0], large));
    const harness = createRuntime(replayed);
    const { socketPath } = await startServer(harness.runtime, { aiStreamBackpressureTimeoutMs: 5_000 });
    const stream = await openStream(socketPath, sessionIds[0]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(harness.subscribe).not.toHaveBeenCalled();
      const catchup = event(33, sessionIds[0], "catch-up-identity");
      harness.append(catchup);
      const frames = await collectFramesUntil(
        stream.response,
        (received) => received.some((frame) => frame.sequence === 33),
        10_000
      );
      const canonical = frames.filter((frame) => typeof frame.sequence === "number");
      expect(canonical.map((frame) => frame.sequence)).toEqual(Array.from({ length: 33 }, (_, index) => index + 1));
      expect(new Set(canonical.map((frame) => frame.eventId)).size).toBe(33);
      expect(canonical.at(-1)).toMatchObject({
        sequence: catchup.sequence,
        eventId: catchup.eventId,
        payload: catchup.payload
      });
      expect(harness.subscribe).toHaveBeenCalledWith(sessionIds[0], 32, expect.any(Function));
    } finally { await closeStream(stream); }
  }, 15_000);

  test("request close racing live overflow unsubscribes and releases admission exactly once", async () => {
    const harness = createRuntime();
    const { socketPath } = await startServer(harness.runtime, {
      aiStreamPerSessionLimit: 1
    });
    const stream = await openStream(socketPath, sessionIds[0]);
    await waitFor(() => harness.subscribe.mock.calls.length === 1);
    for (let sequence = 1; sequence <= 34; sequence += 1) harness.append(event(sequence));
    stream.request.destroy();
    stream.response.destroy();
    await waitFor(() => harness.unsubscribeCalls === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.unsubscribeCalls).toBe(1);
    const replacement = await openStream(socketPath, sessionIds[0], 34);
    try { expect(replacement.response.statusCode).toBe(200); }
    finally { await closeStream(replacement); }
  });

  test("slow-subscriber overflow preserves durable history and reconnect replays the complete suffix", async () => {
    const harness = createRuntime();
    const { socketPath } = await startServer(harness.runtime);
    const slow = await openStream(socketPath, sessionIds[0]);
    await waitFor(() => harness.subscribe.mock.calls.length === 1);
    for (let sequence = 1; sequence <= 34; sequence += 1) harness.append(event(sequence));
    await waitFor(() => harness.unsubscribeCalls === 1);
    await closeStream(slow);

    const reconnect = await openStream(socketPath, sessionIds[0], 0);
    try {
      const frames = await collectFramesUntil(
        reconnect.response,
        (received) => received.some((frame) =>
          frame.frameType === "stream.synchronized" && frame.throughSequence === 34)
      );
      const canonical = frames.filter((frame) => typeof frame.sequence === "number");
      expect(canonical.map((frame) => frame.sequence)).toEqual(Array.from({ length: 34 }, (_, index) => index + 1));
      expect(new Set(canonical.map((frame) => frame.eventId)).size).toBe(34);
      expect(harness.replay).toHaveBeenLastCalledWith(sessionIds[0], 0);
    } finally { await closeStream(reconnect); }
  });
});
