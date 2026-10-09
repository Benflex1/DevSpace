import http from "node:http";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  AI_EVENT_NDJSON_CONTENT_TYPE,
  AI_MAX_STRUCTURED_INPUT_QUESTIONS,
  AI_USER_CONTENT_MAX_BYTES
} from "@devspace/contracts";
import { AgentResponseError, createAgentClient, AgentUnavailableError } from "./agent-client.js";
import { createAiStreamAdmission } from "./ai-stream-admission.js";
import { createLogger } from "@devspace/diagnostics";
import { normalizeUserFacingFailure } from "./user-facing-failure.js";

const id = "018f0f00-0000-7000-8000-000000000001";
const timestamp = "2026-07-17T00:00:00.000Z";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function listen(handler: http.RequestListener): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-client-test-")); directories.push(directory);
  const socketPath = path.join(directory, "agent.sock");
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, close: async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    await unlink(socketPath).catch(() => undefined);
  } };
}

const streamSessionId = "018f0f00-0000-7000-8000-000000000010";
const synchronizedFrame = {
  schemaVersion: "devspace.ai-stream/v1",
  frameType: "stream.synchronized",
  sessionId: streamSessionId,
  throughSequence: 0,
  processGeneration: 1,
  pendingInteractionIds: []
} as const;

const additionalStreamSessionIds = [
  streamSessionId,
  "018f0f00-0000-7000-8000-000000000011",
  "018f0f00-0000-7000-8000-000000000012",
  "018f0f00-0000-7000-8000-000000000013",
  "018f0f00-0000-7000-8000-000000000014"
] as const;

async function collectStream(socketPath: string): Promise<unknown[]> {
  const frames: unknown[] = [];
  for await (const frame of createAgentClient(socketPath, { createId: () => id, now: () => new Date(timestamp) })
    .streamAiEvents(streamSessionId, 0)) frames.push(frame);
  return frames;
}

function streamService(write: (response: http.ServerResponse) => void): Promise<{ socketPath: string; close: () => Promise<void> }> {
  return listen((_request, response) => {
    response.writeHead(200, { "content-type": AI_EVENT_NDJSON_CONTENT_TYPE });
    write(response);
  });
}

async function openStream(
  socketPath: string,
  sessionId: string,
  options: Parameters<typeof createAgentClient>[1] = {}
): Promise<AsyncIterator<unknown>> {
  const iterator = createAgentClient(socketPath, options).streamAiEvents(sessionId, 0)[Symbol.asyncIterator]();
  await expect(iterator.next()).resolves.toMatchObject({
    done: false,
    value: { frameType: "stream.synchronized", sessionId }
  });
  return iterator;
}

test("shares the four-stream global admission limit across Agent client instances and opens no fifth request", async () => {
  let opened = 0;
  const service = await listen((request, response) => {
    opened += 1;
    const match = /^\/v1\/ai-sessions\/([^/]+)\/events/u.exec(request.url ?? "");
    expect(match).not.toBeNull();
    const sessionId = match![1]!;
    response.writeHead(200, { "content-type": AI_EVENT_NDJSON_CONTENT_TYPE });
    response.write(`${JSON.stringify({ ...synchronizedFrame, sessionId })}\n`);
  });
  const iterators: AsyncIterator<unknown>[] = [];
  try {
    for (const sessionId of additionalStreamSessionIds.slice(0, 4)) {
      iterators.push(await openStream(service.socketPath, sessionId));
    }
    const denied = createAgentClient(service.socketPath)
      .streamAiEvents(additionalStreamSessionIds[4], 0)[Symbol.asyncIterator]();
    iterators.push(denied);
    await expect(denied.next()).rejects.toMatchObject({
        name: "AgentUnavailableError",
        failureCategory: "dependency-unavailable"
      });
    expect(opened).toBe(4);
  } finally {
    await Promise.all(iterators.map(async (iterator) => { await iterator.return?.(); }));
    await service.close();
  }
});

test("admits only two Web Agent streams for one AI session and releases both slots on cancellation", async () => {
  let opened = 0;
  const service = await listen((_request, response) => {
    opened += 1;
    response.writeHead(200, { "content-type": AI_EVENT_NDJSON_CONTENT_TYPE });
    response.write(`${JSON.stringify(synchronizedFrame)}\n`);
  });
  const first = await openStream(service.socketPath, streamSessionId);
  const second = await openStream(service.socketPath, streamSessionId);
  try {
    const denied = createAgentClient(service.socketPath).streamAiEvents(streamSessionId, 0)[Symbol.asyncIterator]();
    await expect(denied.next()).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(opened).toBe(2);
  } finally {
    await first.return?.();
    await second.return?.();
  }
  const replacement = await openStream(service.socketPath, streamSessionId);
  await replacement.return?.();
  expect(opened).toBe(3);
  await service.close();
});

test("allocates no maximum-sized parser buffer for an empty or small AI event stream", async () => {
  const allocationSizes: number[] = [];
  const original = Buffer.allocUnsafe.bind(Buffer);
  const spy = vi.spyOn(Buffer, "allocUnsafe").mockImplementation((size) => {
    allocationSizes.push(size);
    return original(size);
  });
  try {
    const empty = await streamService((response) => response.end());
    try { await expect(collectStream(empty.socketPath)).resolves.toEqual([]); }
    finally { await empty.close(); }
    const small = await streamService((response) => response.end(`${JSON.stringify(synchronizedFrame)}\n`));
    try { await expect(collectStream(small.socketPath)).resolves.toEqual([synchronizedFrame]); }
    finally { await small.close(); }
  } finally {
    spy.mockRestore();
  }
  const maximumCanonicalFrameBytes =
    AI_MAX_STRUCTURED_INPUT_QUESTIONS * AI_USER_CONTENT_MAX_BYTES * 6 + 256 * 1024;
  expect(allocationSizes).not.toContain(maximumCanonicalFrameBytes);
  expect(Math.max(0, ...allocationSizes)).toBeLessThanOrEqual(64 * 1024);
});

test("one-byte socket chunking retains at most one parser slab for a small frame", async () => {
  const event = {
    schemaVersion: "devspace.ai-event/v1",
    eventId: "018f0f00-0000-7000-8000-000000000020",
    sessionId: streamSessionId,
    turnId: "018f0f00-0000-7000-8000-000000000021",
    sequence: 1,
    observedAt: timestamp,
    profile: { profileId: "codex", profileRevision: `sha256-ai-profile-v1:${"a".repeat(64)}`, provider: "codex" },
    processGeneration: 1,
    eventType: "turn.output.delta",
    payload: { stream: "assistant", text: "x".repeat(4_096) }
  } as const;
  const encoded = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
  const service = await streamService((response) => {
    for (let index = 0; index < encoded.length; index += 1) response.write(encoded.subarray(index, index + 1));
    response.end();
  });
  const original = Buffer.allocUnsafe.bind(Buffer);
  let parserSlabs = 0;
  const spy = vi.spyOn(Buffer, "allocUnsafe").mockImplementation((size) => {
    if (size === 64 * 1024) parserSlabs += 1;
    return original(size);
  });
  try { await expect(collectStream(service.socketPath)).resolves.toEqual([event]); }
  finally { spy.mockRestore(); await service.close(); }
  expect(parserSlabs).toBe(1);
});

test("accepts a legal near-maximum escaped structured-answer frame", async () => {
  const answerText = "\u0001".repeat(AI_USER_CONTENT_MAX_BYTES);
  const event = {
    schemaVersion: "devspace.ai-event/v1",
    eventId: "018f0f00-0000-7000-8000-000000000020",
    sessionId: streamSessionId,
    turnId: "018f0f00-0000-7000-8000-000000000021",
    sequence: 1,
    observedAt: timestamp,
    profile: { profileId: "codex", profileRevision: `sha256-ai-profile-v1:${"a".repeat(64)}`, provider: "codex" },
    processGeneration: 1,
    eventType: "turn.input.responded",
    payload: {
      requestId: "018f0f00-0000-7000-8000-000000000022",
      answers: Array.from({ length: AI_MAX_STRUCTURED_INPUT_QUESTIONS }, (_, index) => ({
        questionId: `question-${index}`,
        kind: "text" as const,
        text: answerText
      }))
    }
  } as const;
  const encoded = Buffer.from(JSON.stringify(event), "utf8");
  const maximumCanonicalFrameBytes =
    AI_MAX_STRUCTURED_INPUT_QUESTIONS * AI_USER_CONTENT_MAX_BYTES * 6 + 256 * 1024;
  expect(encoded.length).toBeGreaterThan(maximumCanonicalFrameBytes - 512 * 1024);
  expect(encoded.length).toBeLessThanOrEqual(maximumCanonicalFrameBytes);
  const service = await streamService((response) => response.end(Buffer.concat([encoded, Buffer.from("\n")])));
  try { await expect(collectStream(service.socketPath)).resolves.toEqual([event]); }
  finally { await service.close(); }
}, 30_000);

test("releases admission when setup throws before a request exists", async () => {
  const admission = createAiStreamAdmission({ globalLimit: 1, perSessionLimit: 1 });
  const failed = createAgentClient("/not-opened.sock", {
    aiStreamAdmission: admission,
    createId: () => { throw new Error("setup-failure"); }
  }).streamAiEvents(streamSessionId, 0)[Symbol.asyncIterator]();
  await expect(failed.next()).rejects.toThrow("setup-failure");

  const service = await streamService((response) => response.end(`${JSON.stringify(synchronizedFrame)}\n`));
  try {
    const replacement = createAgentClient(service.socketPath, { aiStreamAdmission: admission })
      .streamAiEvents(streamSessionId, 0)[Symbol.asyncIterator]();
    await expect(replacement.next()).resolves.toEqual({ done: false, value: synchronizedFrame });
    await replacement.return?.(undefined);
  } finally { await service.close(); }
});

test("parses one or multiple canonical NDJSON frames from arbitrary socket chunks", async () => {
  const encoded = Buffer.from(`${JSON.stringify(synchronizedFrame)}\n`, "utf8");
  const cases = [
    [encoded],
    [Buffer.concat([encoded, encoded])],
    [encoded.subarray(0, 1), encoded.subarray(1, encoded.length - 1), encoded.subarray(encoded.length - 1)]
  ];
  for (const chunks of cases) {
    const service = await streamService((response) => {
      for (const chunk of chunks) response.write(chunk);
      response.end();
    });
    try {
      await expect(collectStream(service.socketPath)).resolves.toEqual(
        chunks.length === 1 && chunks[0]!.length === encoded.length * 2
          ? [synchronizedFrame, synchronizedFrame]
          : [synchronizedFrame]
      );
    } finally { await service.close(); }
  }
});

test("decodes a multibyte UTF-8 scalar split across socket chunks", async () => {
  const event = {
    schemaVersion: "devspace.ai-event/v1",
    eventId: "018f0f00-0000-7000-8000-000000000020",
    sessionId: streamSessionId,
    turnId: "018f0f00-0000-7000-8000-000000000021",
    sequence: 1,
    observedAt: timestamp,
    profile: { profileId: "codex", profileRevision: `sha256-ai-profile-v1:${"a".repeat(64)}`, provider: "codex" },
    processGeneration: 1,
    eventType: "turn.output.delta",
    payload: { stream: "assistant", text: "é" }
  } as const;
  const encoded = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
  const scalar = encoded.indexOf(0xc3);
  const service = await streamService((response) => {
    response.write(encoded.subarray(0, scalar + 1));
    response.end(encoded.subarray(scalar + 1));
  });
  try {
    await expect(collectStream(service.socketPath)).resolves.toEqual([event]);
  } finally { await service.close(); }
});

test.each([
  ["invalid UTF-8", Buffer.from([0xc3, 0x28, 0x0a])],
  ["malformed JSON", Buffer.from("{private-prompt}\n", "utf8")],
  ["schema-invalid JSON", Buffer.from(`${JSON.stringify({ private: "private-prompt" })}\n`, "utf8")],
  ["partial final JSON", Buffer.from("{\"private\":\"private-prompt\"", "utf8")],
  ["valid frame then partial final frame", Buffer.concat([
    Buffer.from(`${JSON.stringify(synchronizedFrame)}\n`, "utf8"),
    Buffer.from("{\"private\":\"private-prompt\"", "utf8")
  ])]
])("rejects %s as one bounded private protocol failure", async (_label, bytes) => {
  const service = await streamService((response) => response.end(bytes));
  try {
    const error = await collectStream(service.socketPath).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentUnavailableError);
    expect(error).toMatchObject({ code: "INVALID_RESPONSE_CONTRACT", failureCategory: "protocol-failure" });
    expect(JSON.stringify(error)).not.toContain("private-prompt");
  } finally { await service.close(); }
});

test.each(["terminated", "unterminated"] as const)("rejects an oversized %s NDJSON line", async (kind) => {
  const maximumCanonicalFrameBytes =
    AI_MAX_STRUCTURED_INPUT_QUESTIONS * AI_USER_CONTENT_MAX_BYTES * 6 + 256 * 1024;
  const bytes = Buffer.alloc(maximumCanonicalFrameBytes + 1, 0x61);
  const service = await streamService((response) => response.end(kind === "terminated" ? Buffer.concat([bytes, Buffer.from("\n")]) : bytes));
  try {
    await expect(collectStream(service.socketPath)).rejects.toMatchObject({
      code: "INVALID_RESPONSE_CONTRACT",
      failureCategory: "protocol-failure"
    });
  } finally { await service.close(); }
});

test("accepts an empty stream and cancellation destroys the underlying socket", async () => {
  const empty = await streamService((response) => response.end());
  try {
    await expect(collectStream(empty.socketPath)).resolves.toEqual([]);
  } finally { await empty.close(); }

  let closed = false;
  const hanging = await listen((request, response) => {
    request.once("close", () => { closed = true; });
    response.writeHead(200, { "content-type": AI_EVENT_NDJSON_CONTENT_TYPE });
    response.write(`${JSON.stringify(synchronizedFrame)}\n`);
  });
  const iterator = createAgentClient(hanging.socketPath).streamAiEvents(streamSessionId, 0)[Symbol.asyncIterator]();
  await expect(iterator.next()).resolves.toEqual({ done: false, value: synchronizedFrame });
  await iterator.return?.(undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(closed).toBe(true);
  await hanging.close();
});

test("aborting an idle established stream settles its pending read and promptly destroys the exact request and response", async () => {
  let agentConnectionClosed = false;
  const hanging = await listen((request, response) => {
    request.once("close", () => { agentConnectionClosed = true; });
    response.writeHead(200, { "content-type": AI_EVENT_NDJSON_CONTENT_TYPE });
    response.write(`${JSON.stringify(synchronizedFrame)}\n`);
  });
  const requestSpy = vi.spyOn(http, "request");
  const abortController = new AbortController();
  const iterator = createAgentClient(hanging.socketPath)
    .streamAiEvents(streamSessionId, 0, { signal: abortController.signal })[Symbol.asyncIterator]();
  try {
    await expect(iterator.next()).resolves.toEqual({ done: false, value: synchronizedFrame });
    const activeRequest = requestSpy.mock.results.at(-1)?.value as http.ClientRequest;
    const activeResponse = (activeRequest as http.ClientRequest & { res?: http.IncomingMessage }).res!;
    const pending = iterator.next();

    abortController.abort();

    await expect(Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error("pending-read-did-not-settle")), 100))
    ])).resolves.toEqual({ done: true, value: undefined });
    await vi.waitFor(() => {
      expect(activeRequest.destroyed).toBe(true);
      expect(activeResponse.destroyed).toBe(true);
      expect(agentConnectionClosed).toBe(true);
    }, { timeout: 100 });
  } finally {
    requestSpy.mockRestore();
    await iterator.return?.(undefined);
    await hanging.close();
  }
});

test.each([
  ["global", 4, 4, additionalStreamSessionIds.slice(0, 4), additionalStreamSessionIds[4]],
  ["per-session", 4, 2, [streamSessionId, streamSessionId], streamSessionId]
] as const)("recovers %s admission after aborting one idle established stream", async (
  _scope,
  globalLimit,
  perSessionLimit,
  sessionIds,
  replacementSessionId
) => {
  const admission = createAiStreamAdmission({ globalLimit, perSessionLimit });
  let opened = 0;
  const service = await listen((request, response) => {
    opened += 1;
    const sessionId = /^\/v1\/ai-sessions\/([^/]+)\/events/u.exec(request.url ?? "")?.[1];
    response.writeHead(200, { "content-type": AI_EVENT_NDJSON_CONTENT_TYPE });
    response.write(`${JSON.stringify({ ...synchronizedFrame, sessionId })}\n`);
  });
  const active: Array<{ abort: AbortController; iterator: AsyncIterator<unknown>; pending: Promise<IteratorResult<unknown>> }> = [];
  try {
    for (const sessionId of sessionIds) {
      const abort = new AbortController();
      const iterator = createAgentClient(service.socketPath, { aiStreamAdmission: admission })
        .streamAiEvents(sessionId, 0, { signal: abort.signal })[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { frameType: "stream.synchronized", sessionId }
      });
      active.push({ abort, iterator, pending: iterator.next() });
    }
    const denied = createAgentClient(service.socketPath, { aiStreamAdmission: admission })
      .streamAiEvents(replacementSessionId, 0)[Symbol.asyncIterator]();
    await expect(denied.next()).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(opened).toBe(sessionIds.length);

    active[0]!.abort.abort();
    await expect(active[0]!.pending).resolves.toEqual({ done: true, value: undefined });

    const replacement = createAgentClient(service.socketPath, { aiStreamAdmission: admission })
      .streamAiEvents(replacementSessionId, 0)[Symbol.asyncIterator]();
    await expect(Promise.race([
      replacement.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("admission-was-not-released")), 100))
    ])).resolves.toMatchObject({ done: false, value: { frameType: "stream.synchronized" } });
    await replacement.return?.(undefined);
  } finally {
    for (const entry of active) {
      entry.abort.abort();
      await entry.pending.catch(() => undefined);
      await entry.iterator.return?.(undefined);
    }
    await service.close();
  }
});

test("releases stream admission and generator cleanup exactly once when abort races iterator return", async () => {
  let acquireCount = 0;
  let releaseCount = 0;
  const admission = {
    tryAcquire: () => {
      acquireCount += 1;
      return () => { releaseCount += 1; };
    }
  };
  const service = await streamService((response) => response.write(`${JSON.stringify(synchronizedFrame)}\n`));
  const abort = new AbortController();
  const addListenerSpy = vi.spyOn(abort.signal, "addEventListener");
  const removeListenerSpy = vi.spyOn(abort.signal, "removeEventListener");
  const iterator = createAgentClient(service.socketPath, { aiStreamAdmission: admission })
    .streamAiEvents(streamSessionId, 0, { signal: abort.signal })[Symbol.asyncIterator]();
  try {
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    const pending = iterator.next();
    abort.abort();
    const returned = iterator.return?.(undefined);
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await expect(returned).resolves.toMatchObject({ done: true });
    await expect(iterator.return?.(undefined)).resolves.toMatchObject({ done: true });
    expect({ acquireCount, releaseCount }).toEqual({ acquireCount: 1, releaseCount: 1 });
    expect(addListenerSpy).toHaveBeenCalledTimes(1);
    expect(removeListenerSpy).toHaveBeenCalledTimes(1);
  } finally {
    addListenerSpy.mockRestore();
    removeListenerSpy.mockRestore();
    await service.close();
  }
});

test.each([
  ["a newly arriving valid frame", (response: http.ServerResponse) => {
    response.write(`${JSON.stringify(synchronizedFrame)}\n`);
  }],
  ["parser failure", (response: http.ServerResponse) => {
    response.write("{private-prompt}\n");
  }],
  ["Agent response close", (response: http.ServerResponse) => {
    response.end("{\"partial\":");
  }]
])("consumer cancellation racing %s produces no public protocol error", async (_label, finishRace) => {
  let race: (() => void) | undefined;
  const service = await listen((_request, response) => {
    response.writeHead(200, { "content-type": AI_EVENT_NDJSON_CONTENT_TYPE });
    response.write(`${JSON.stringify(synchronizedFrame)}\n`);
    race = () => finishRace(response);
  });
  const abort = new AbortController();
  const iterator = createAgentClient(service.socketPath)
    .streamAiEvents(streamSessionId, 0, { signal: abort.signal })[Symbol.asyncIterator]();
  try {
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    const pending = iterator.next();
    race!();
    abort.abort();
    const result = await pending;
    expect(result.done === true || result.value === (synchronizedFrame as unknown)).toBe(true);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  } finally {
    abort.abort();
    await iterator.return?.(undefined);
    await service.close();
  }
});

test("consumer cancellation racing the observation timeout remains normal private control flow", async () => {
  const service = await listen(() => undefined);
  const abort = new AbortController();
  const iterator = createAgentClient(service.socketPath, { observationTimeoutMs: 50 })
    .streamAiEvents(streamSessionId, 0, { signal: abort.signal })[Symbol.asyncIterator]();
  const pending = iterator.next();
  setTimeout(() => abort.abort(), 40);
  try {
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  } finally {
    await iterator.return?.(undefined);
    await service.close();
  }
});

test("an already-aborted stream opens no Agent request and retains no Web admission", async () => {
  const admission = createAiStreamAdmission({ globalLimit: 1, perSessionLimit: 1 });
  const requestSpy = vi.spyOn(http, "request");
  const aborted = new AbortController();
  aborted.abort();
  const listenerSpy = vi.spyOn(aborted.signal, "addEventListener");
  const allocationSpy = vi.spyOn(Buffer, "allocUnsafe");
  const canceled = createAgentClient("/must-not-open.sock", { aiStreamAdmission: admission })
    .streamAiEvents(streamSessionId, 0, { signal: aborted.signal })[Symbol.asyncIterator]();
  await expect(canceled.next()).resolves.toEqual({ done: true, value: undefined });
  expect(requestSpy).not.toHaveBeenCalled();
  expect(listenerSpy).not.toHaveBeenCalled();
  expect(allocationSpy).not.toHaveBeenCalled();
  listenerSpy.mockRestore();
  allocationSpy.mockRestore();

  const service = await streamService((response) => response.end(`${JSON.stringify(synchronizedFrame)}\n`));
  try {
    const replacement = createAgentClient(service.socketPath, { aiStreamAdmission: admission })
      .streamAiEvents(streamSessionId, 0)[Symbol.asyncIterator]();
    await expect(replacement.next()).resolves.toEqual({ done: false, value: synchronizedFrame });
    await replacement.return?.(undefined);
  } finally {
    requestSpy.mockRestore();
    await service.close();
  }
});

test.each([
  ["connect establishment", false, Buffer.alloc(0)],
  ["headers before a complete frame", true, Buffer.alloc(0)],
  ["a retained partial frame", true, Buffer.from("{\"schemaVersion\":\"devspace.ai-stream/v1\"", "utf8")]
])("consumer cancellation during %s is normal and releases admission exactly once", async (_label, sendHeaders, bytes) => {
  const admission = createAiStreamAdmission({ globalLimit: 1, perSessionLimit: 1 });
  let opened = 0;
  const service = await listen((_request, response) => {
    opened += 1;
    if (sendHeaders) {
      response.writeHead(200, { "content-type": AI_EVENT_NDJSON_CONTENT_TYPE });
      response.flushHeaders();
      if (bytes.length > 0) response.write(bytes);
    }
  });
  const abortController = new AbortController();
  const iterator = createAgentClient(service.socketPath, {
    aiStreamAdmission: admission,
    observationTimeoutMs: 5_000
  }).streamAiEvents(streamSessionId, 0, { signal: abortController.signal })[Symbol.asyncIterator]();
  const pending = iterator.next();
  await vi.waitFor(() => expect(opened).toBe(1));
  abortController.abort();
  await expect(pending).resolves.toEqual({ done: true, value: undefined });
  await expect(iterator.return?.(undefined)).resolves.toMatchObject({ done: true });

  const replacementService = await streamService((response) => response.end(`${JSON.stringify(synchronizedFrame)}\n`));
  try {
    const replacement = createAgentClient(replacementService.socketPath, { aiStreamAdmission: admission })
      .streamAiEvents(streamSessionId, 0)[Symbol.asyncIterator]();
    await expect(replacement.next()).resolves.toEqual({ done: false, value: synchronizedFrame });
    await replacement.return?.(undefined);
  } finally {
    await replacementService.close();
    await service.close();
  }
});

test("constructs protocol headers and parses valid success envelopes", async () => {
  const service = await listen((request, response) => {
    expect(request.headers["x-devspace-protocol-version"]).toBe("1");
    expect(request.headers["x-devspace-request-id"]).toBe(id);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ meta: { protocolVersion: 1, requestId: id, respondedAt: timestamp }, data: { status: "ok" } }));
  });
  try {
    const client = createAgentClient(service.socketPath, { createId: () => id, now: () => new Date(timestamp) });
    await expect(client.health()).resolves.toEqual({ status: "ok" });
  } finally { await service.close(); }
});

test("native harness inspection returns only bounded lifecycle state, capability, and generation", async () => {
  const service = await listen((request, response) => {
    expect(request.url).toBe("/v1/harness-sessions/inspect");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      meta: { protocolVersion: 1, requestId: id, respondedAt: timestamp },
      data: { state: "lost", resume: true, processGeneration: 2, nativeSessionId: "private-provider-id" }
    }));
  });
  try {
    await expect(createAgentClient(service.socketPath, { createId: () => id, now: () => new Date(timestamp) })
      .inspectNativeHarness({ sessionId: id }))
      .resolves.toEqual({ state: "lost", resume: true, processGeneration: 2 });
  } finally { await service.close(); }
});

test("native harness Agent request logs correlate safe IDs and classify uncertain admission", async () => {
  const lines: string[] = [];
  let requestId: string | undefined;
  const sessionId = "018f0f00-0000-7000-8000-000000000020";
  const workspaceId = "018f0f00-0000-7000-8000-000000000021";
  const terminalId = "018f0f00-0000-7000-8000-000000000022";
  const service = await listen((request, response) => {
    requestId = request.headers["x-devspace-request-id"] as string;
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ meta: { protocolVersion: 1, requestId, respondedAt: timestamp }, error: {
      code: "HARNESS_ADMISSION_UNCERTAIN", message: "retry the same process", retryable: true, details: {}
    } }));
  });
  try {
    const client = createAgentClient(service.socketPath, {
      logger: createLogger({ component: "web", subsystem: "agent-client", sink: (line) => lines.push(line) })
    });
    await expect(client.startNativeHarness({
      projectId: id, workspaceId, sessionId, harnessId: "codex", processId: terminalId, terminalId,
      processGeneration: 1, definition: { environment: { TOKEN: "must-not-appear-in-timing" } }
    })).rejects.toMatchObject({ code: "HARNESS_ADMISSION_UNCERTAIN" });
  } finally { await service.close(); }

  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({
      event: "web.harness.agent_request.failed", requestId, sessionId, workspaceId, terminalId,
      processGeneration: 1, phase: "agent-request", outcome: "uncertain",
      errorCode: "HARNESS_ADMISSION_UNCERTAIN", durationMs: expect.any(Number)
    })
  ]));
  expect(lines.join("\n")).not.toContain("must-not-appear-in-timing");
});

test("allows Codex profile discovery to complete beyond the general observation timeout", async () => {
  const profile = {
    profileId: "codex",
    profileRevision: `sha256-ai-profile-v1:${"a".repeat(64)}`,
    provider: "codex",
    displayName: "Codex",
    capabilities: {
      inspect: true, start: true, resume: true, sendTurn: true, interrupt: true,
      approvals: true, structuredInput: true, stop: true, streamEvents: true
    },
    availability: { state: "available" }
  } as const;
  const service = await listen((_request, response) => {
    setTimeout(() => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ meta: { protocolVersion: 1, requestId: id, respondedAt: timestamp }, data: profile }));
    }, 5_200);
  });
  try {
    await expect(createAgentClient(service.socketPath).inspectAiProvider(id, streamSessionId, "codex")).resolves.toEqual(profile);
  } finally { await service.close(); }
}, 15_000);

test("gives real AI startup a bounded window beyond the general mutation timeout", async () => {
  const service = await listen((_request, response) => {
    setTimeout(() => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ meta: { protocolVersion: 1, requestId: id, respondedAt: timestamp }, data: { operationId: id } }));
    }, 50);
  });
  try {
    await expect(createAgentClient(service.socketPath, { timeoutMs: 10, createId: () => id, now: () => new Date(timestamp) }).startAiSession(id, {
      projectId: id,
      workspaceId: streamSessionId,
      aiSessionId: "018f0f00-0000-7000-8000-000000000011",
      revisionId: "018f0f00-0000-7000-8000-000000000012",
      runtimePlanHash: `sha256-jcs-v1:${"a".repeat(64)}`,
      runtimeGeneration: 1,
      profileId: "codex",
      profileRevision: `sha256-ai-profile-v1:${"b".repeat(64)}`
    })).resolves.toEqual({ operationId: id });
  } finally { await service.close(); }
}, 15_000);

test("keeps an established AI event stream alive through the observation timeout", async () => {
  const sessionId = "018f0f00-0000-7000-8000-000000000010";
    const frame = { schemaVersion: "devspace.ai-stream/v1", frameType: "stream.synchronized", sessionId, throughSequence: 0,
      processGeneration: 1, pendingInteractionIds: [] } as const;
  const service = await listen((_request, response) => {
    response.writeHead(200, { "content-type": AI_EVENT_NDJSON_CONTENT_TYPE });
    response.flushHeaders();
    setTimeout(() => response.end(`${JSON.stringify(frame)}\n`), 6_000);
  });
  const iterator = createAgentClient(service.socketPath, { observationTimeoutMs: 50, createId: () => id, now: () => new Date(timestamp) })
    .streamAiEvents(sessionId, 0)[Symbol.asyncIterator]();
  let settled = false;
  let received: IteratorResult<unknown> | undefined;
  let failure: unknown;
  const next = iterator.next().then((value) => { settled = true; received = value; }, (error: unknown) => { settled = true; failure = error; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    await next;
    expect(failure).toBeUndefined();
    expect(received).toEqual({ done: false, value: frame });
  } finally {
    await iterator.return?.(undefined);
    await service.close();
  }
}, 10_000);

test("bounds AI event stream establishment when response headers never arrive", async () => {
  const service = await listen(() => undefined);
  const iterator = createAgentClient(service.socketPath, { observationTimeoutMs: 50, createId: () => id, now: () => new Date(timestamp) })
    .streamAiEvents("018f0f00-0000-7000-8000-000000000011", 0)[Symbol.asyncIterator]();
  try {
    await expect(iterator.next()).rejects.toMatchObject({ code: "AGENT_REQUEST_TIMEOUT" });
  } finally {
    await iterator.return?.(undefined);
    await service.close();
  }
});

test("rejects malformed envelopes and unavailable sockets without exposing internals", async () => {
  const service = await listen((_request, response) => { response.end("{\"not\":\"an-envelope\"}"); });
  try {
    await expect(createAgentClient(service.socketPath, { createId: () => id, now: () => new Date(timestamp) }).health())
      .rejects.toBeInstanceOf(AgentUnavailableError);
  } finally { await service.close(); }
  await expect(createAgentClient(path.join(tmpdir(), `missing-${id}.sock`), { timeoutMs: 50 }).health())
    .rejects.toBeInstanceOf(AgentUnavailableError);
});

test("preserves only validated safe Agent error metadata including its incident ID", async () => {
  const incidentId = "018f0f00-0000-7000-8000-000000000099";
  const service = await listen((_request, response) => {
    response.statusCode = 500;
    response.end(JSON.stringify({
      meta: { protocolVersion: 1, requestId: id, respondedAt: timestamp },
      error: {
        code: "AGENT_INTERNAL_ERROR",
        message: "The Agent operation failed safely.",
        retryable: true,
        details: { incidentId }
      }
    }));
  });
  try {
    const error = await createAgentClient(service.socketPath, { createId: () => id, now: () => new Date(timestamp) })
      .health().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentResponseError);
    expect(error).toMatchObject({
      code: "AGENT_INTERNAL_ERROR",
      message: "The Agent operation failed safely.",
      retryable: true,
      failureCategory: "internal-failure",
      incidentId
    });
    expect(error).not.toHaveProperty("details");
  } finally { await service.close(); }
});

test("keeps strict endpoint error parsing when Agent details contain an unknown field", async () => {
  const service = await listen((_request, response) => {
    response.statusCode = 500;
    response.end(JSON.stringify({
      meta: { protocolVersion: 1, requestId: id, respondedAt: timestamp },
      error: {
        code: "AGENT_INTERNAL_ERROR",
        message: "safe",
        retryable: true,
        details: { incidentId: "018f0f00-0000-7000-8000-000000000099", token: "must-not-survive" }
      }
    }));
  });
  try {
    const error = await createAgentClient(service.socketPath, { createId: () => id, now: () => new Date(timestamp) })
      .health().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INVALID_RESPONSE_CONTRACT", failureCategory: "protocol-failure" });
    expect(JSON.stringify(error)).not.toContain("must-not-survive");
  } finally { await service.close(); }
});

test("emits one terminal diagnostic for a preview transport failure", async () => {
  const logs: string[] = [];
  const client = createAgentClient(path.join(tmpdir(), `missing-preview-${id}.sock`), {
    timeoutMs: 50, createId: () => id, logger: createLogger({ component: "web", subsystem: "agent-client", environment: { DEVSPACE_LOG_LEVEL: "debug" }, sink: (line) => logs.push(line) })
  });
  await expect(client.inspectPreview(id, "018f0f00-0000-7000-8000-000000000002", "018f0f00-0000-7000-8000-000000000003", "018f0f00-0000-7000-8000-000000000004"))
    .rejects.toBeInstanceOf(AgentUnavailableError);
  const records = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(records.map((record) => record.event)).toEqual(["web.agent_request.started", "web.agent_request.failed"]);
  expect(records[1]).toMatchObject({ requestId: id, operationName: "preview.inspect", projectId: id,
    workspaceId: "018f0f00-0000-7000-8000-000000000002", previewId: "018f0f00-0000-7000-8000-000000000004",
    errorCategory: "agent-transport", errorCode: "AGENT_UNAVAILABLE" });
});

test("emits one terminal diagnostic for a malformed preview response", async () => {
  const service = await listen((_request, response) => { response.end("not-json"); });
  const logs: string[] = [];
  try {
    const client = createAgentClient(service.socketPath, {
      createId: () => id, now: () => new Date(timestamp), logger: createLogger({ component: "web", subsystem: "agent-client", environment: { DEVSPACE_LOG_LEVEL: "debug" }, sink: (line) => logs.push(line) })
    });
    await expect(client.inspectPreview(id, "018f0f00-0000-7000-8000-000000000002", "018f0f00-0000-7000-8000-000000000003", "018f0f00-0000-7000-8000-000000000004"))
      .rejects.toBeInstanceOf(AgentUnavailableError);
  } finally { await service.close(); }
  const records = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(records.map((record) => record.event)).toEqual(["web.agent_request.started", "web.agent_request.failed"]);
  expect(records[1]).toMatchObject({ requestId: id, operationName: "preview.inspect", errorCategory: "agent-protocol", errorCode: "MALFORMED_RESPONSE" });
});

test("defers a surfaced preview timeout to one fully correlated boundary incident", async () => {
  const service = await listen(() => undefined);
  const logs: string[] = [];
  const incidentId = "018f0f00-0000-7000-8000-000000000099";
  const operationId = "018f0f00-0000-7000-8000-000000000005";
  const logger = createLogger({
    component: "web", subsystem: "preview-test", environment: { DEVSPACE_LOG_LEVEL: "debug" },
    sink: (line) => logs.push(line)
  });
  try {
    const client = createAgentClient(service.socketPath, {
      timeoutMs: 20, createId: () => id, now: () => new Date(timestamp), logger,
      previewFailureDiagnostics: "deferred"
    });
    const error = await client.inspectPreview(
      id,
      "018f0f00-0000-7000-8000-000000000002",
      "018f0f00-0000-7000-8000-000000000003",
      "018f0f00-0000-7000-8000-000000000004",
      operationId
    ).catch((caught: unknown) => caught);
    const projection = normalizeUserFacingFailure(error, {
      fallbackMessage: "The preview action failed safely.",
      event: "web.preview_action.failed",
      logMessage: "User-facing preview action failed",
      logger,
      createIncidentId: () => incidentId
    });
    expect(projection).toMatchObject({ incidentId, failureCategory: "transport-failure" });
  } finally { await service.close(); }
  const terminal = logs.map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.level === "warn" || record.level === "error");
  expect(terminal).toHaveLength(1);
  expect(terminal[0]).toMatchObject({
    level: "error", event: "web.preview_action.failed", incidentId, requestId: id, operationId, projectId: id,
    workspaceId: "018f0f00-0000-7000-8000-000000000002",
    previewId: "018f0f00-0000-7000-8000-000000000004"
  });
});

test("defers an Agent-provided preview incident and preserves its identity at the boundary", async () => {
  const incidentId = "018f0f00-0000-7000-8000-000000000099";
  const service = await listen((_request, response) => {
    response.statusCode = 500;
    response.end(JSON.stringify({
      meta: { protocolVersion: 1, requestId: id, respondedAt: timestamp },
      error: {
        code: "AGENT_INTERNAL_ERROR",
        message: "private-preview-worker-label",
        retryable: true,
        details: { incidentId }
      }
    }));
  });
  const logs: string[] = [];
  const logger = createLogger({
    component: "web", subsystem: "preview-test", environment: { DEVSPACE_LOG_LEVEL: "debug" },
    sink: (line) => logs.push(line)
  });
  try {
    const client = createAgentClient(service.socketPath, {
      createId: () => id, now: () => new Date(timestamp), logger, previewFailureDiagnostics: "deferred"
    });
    const error = await client.inspectPreview(
      id,
      "018f0f00-0000-7000-8000-000000000002",
      "018f0f00-0000-7000-8000-000000000003",
      "018f0f00-0000-7000-8000-000000000004"
    ).catch((caught: unknown) => caught);
    const projection = normalizeUserFacingFailure(error, {
      fallbackMessage: "The preview action failed safely.",
      event: "web.preview_action.failed",
      logMessage: "User-facing preview action failed",
      logger,
      createIncidentId: () => {
        throw new Error("must preserve Agent incident");
      }
    });
    expect(projection).toMatchObject({
      message: "The DevSpace Agent encountered an unexpected error.",
      incidentId
    });
  } finally { await service.close(); }
  const terminal = logs.map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.level === "warn" || record.level === "error");
  expect(terminal).toHaveLength(1);
  expect(terminal[0]).toMatchObject({ event: "web.preview_action.failed", incidentId, requestId: id });
  expect(JSON.stringify({ logs })).not.toContain("private-preview-worker-label");
});

test("sends the canonical typed preview activation fields and parses the mutation receipt", async () => {
  let requestBody = "";
  let operationHeader: string | undefined;
  const service = await listen((request, response) => {
    const header = request.headers["x-devspace-operation-id"];
    operationHeader = Array.isArray(header) ? header[0] : header;
    request.on("data", (chunk: Buffer) => { requestBody += chunk.toString("utf8"); });
    request.on("end", () => {
      response.statusCode = 202;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ meta: { protocolVersion: 1, requestId: id, respondedAt: timestamp }, data: { operationId: id } }));
    });
  });
  try {
    const client = createAgentClient(service.socketPath, { createId: () => id, now: () => new Date(timestamp) });
    await expect(client.activatePreview(id, {
      projectId: id, workspaceId: "018f0f00-0000-7000-8000-000000000002", revisionId: "018f0f00-0000-7000-8000-000000000003",
      previewId: "018f0f00-0000-7000-8000-000000000004", previewKey: "web", hostname: "alpha-primary-web-018f0f00.preview.example.com",
      projectSlug: "alpha", workspaceSlug: "primary"
    })).resolves.toEqual({ operationId: id });
    expect(operationHeader).toBe(id);
    expect(requestBody).toContain('"hostname":"alpha-primary-web-018f0f00.preview.example.com"');
    expect(requestBody).toContain('"projectSlug":"alpha"');
    expect(requestBody).toContain('"workspaceSlug":"primary"');
  } finally { await service.close(); }
});

test("sends bounded AI approval and structured-input responses through the existing Agent operations", async () => {
  const seen: Array<{ path: string; body: string }> = [];
  const service = await listen((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      seen.push({ path: request.url ?? "", body });
      response.statusCode = 202;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ meta: { protocolVersion: 1, requestId: id, respondedAt: timestamp }, data: { operationId: id } }));
    });
  });
  try {
    const client = createAgentClient(service.socketPath, { createId: () => id, now: () => new Date(timestamp) });
    const binding = {
      projectId: id,
      workspaceId: "018f0f00-0000-7000-8000-000000000002",
      aiSessionId: "018f0f00-0000-7000-8000-000000000003",
      profileId: "codex",
      profileRevision: `sha256-ai-profile-v1:${"a".repeat(64)}`,
      processGeneration: 1,
      turnId: "018f0f00-0000-7000-8000-000000000004",
      requestId: "018f0f00-0000-7000-8000-000000000005"
    };
    await expect(client.respondToAiApproval(id, { ...binding, decision: "approve-once" })).resolves.toEqual({ operationId: id });
    await expect(client.respondToAiStructuredInput(id, { ...binding, answers: [
      { questionId: "question-1", kind: "selected", optionId: "option-1" }
    ] })).resolves.toEqual({ operationId: id });
    expect(seen.map((entry) => entry.path)).toEqual([
      "/v1/ai-sessions/respond-approval", "/v1/ai-sessions/respond-input"
    ]);
    expect(seen[0]?.body).toContain('"decision":"approve-once"');
    expect(seen[1]?.body).toContain('"questionId":"question-1"');
  } finally { await service.close(); }
});

test("sends typed workspace file list, read, and save requests", async () => {
  const seen: { path: string; body: string }[] = [];
  const service = await listen((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      seen.push({ path: request.url ?? "", body });
      const data = request.url?.endsWith("/list")
        ? { path: "", entries: [] }
        : request.url?.endsWith("/read")
          ? { path: "README.md", content: "hello\n", revision: "a".repeat(64), size: 6 }
          : { path: "README.md", revision: "b".repeat(64) };
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ meta: { protocolVersion: 1, requestId: id, respondedAt: timestamp }, data }));
    });
  });
  try {
    const client = createAgentClient(service.socketPath, { createId: () => id, now: () => new Date(timestamp) });
    await expect(client.listWorkspaceDirectory(id, "018f0f00-0000-7000-8000-000000000002", "")).resolves.toEqual({ path: "", entries: [] });
    await expect(client.readWorkspaceFile(id, "018f0f00-0000-7000-8000-000000000002", "README.md")).resolves.toMatchObject({ content: "hello\n" });
    await expect(client.saveWorkspaceFile(id, "018f0f00-0000-7000-8000-000000000002", "README.md", "updated\n", "a".repeat(64))).resolves.toEqual({
      path: "README.md", revision: "b".repeat(64)
    });
    expect(seen.map((entry) => entry.path)).toEqual([
      "/v1/workspaces/files/list", "/v1/workspaces/files/read", "/v1/workspaces/files/save"
    ]);
    expect(seen[2]?.body).toContain('"expectedRevision":"' + "a".repeat(64) + '"');
  } finally { await service.close(); }
});
