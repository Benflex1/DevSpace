import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { createCodexJsonlTransport, dockerMultiplexedFrame } from "./transport.js";

describe("Codex app-server transport", () => {
  test("decodes bounded Docker multiplexed JSONL across split frames", () => {
    const stream = new PassThrough();
    const messages: Record<string, unknown>[] = [];
    const onProtocolFailure = vi.fn();
    const transport = createCodexJsonlTransport({
      stream,
      onMessage: (message) => messages.push(message),
      onProtocolFailure
    });

    const frame = dockerMultiplexedFrame({ method: "item/agentMessage/delta", params: { delta: "é" } });
    transport.receiveDockerData(frame.subarray(0, 5));
    transport.receiveDockerData(frame.subarray(5));

    expect(messages).toEqual([{ method: "item/agentMessage/delta", params: { delta: "é" } }]);
    expect(onProtocolFailure).not.toHaveBeenCalled();
  });

  test("fails closed for malformed JSON and oversized frames", () => {
    const stream = new PassThrough();
    const onProtocolFailure = vi.fn();
    const transport = createCodexJsonlTransport({ stream, onMessage: () => undefined, onProtocolFailure, maxFramePayloadBytes: 32 });

    transport.receiveDockerData(dockerMultiplexedFrame(Buffer.from("{malformed\n", "utf8")));
    expect(onProtocolFailure).toHaveBeenCalledTimes(1);

    const second = createCodexJsonlTransport({ stream: new PassThrough(), onMessage: () => undefined, onProtocolFailure: vi.fn(), maxFramePayloadBytes: 32 });
    second.receiveDockerData(dockerMultiplexedFrame(Buffer.alloc(33)));
    expect(second.failed).toBe(true);
  });

  test("writes exactly one JSONL request to the attached stream", () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    const transport = createCodexJsonlTransport({ stream, onMessage: () => undefined, onProtocolFailure: () => undefined });

    transport.write({ id: 7, method: "initialized" });

    expect(Buffer.concat(chunks).toString("utf8")).toBe('{"id":7,"method":"initialized"}\n');
  });
});
