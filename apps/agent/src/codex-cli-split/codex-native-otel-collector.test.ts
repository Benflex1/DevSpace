import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CODEX_NATIVE_OTEL_COLLECTOR_MARKER,
  createCodexNativeOtelCollectorCommand,
  createCodexNativeOtelCollectorOutputParser
} from "../../test/codex-native-otel-collector.js";

describe("Codex native OTEL collector", () => {
  it("uses an explicitly identifiable verifier-only command", () => {
    const command = createCodexNativeOtelCollectorCommand(43180);
    expect(command[0]).toBe("node");
    expect(command.at(-1)).toBe(CODEX_NATIVE_OTEL_COLLECTOR_MARKER);
    expect(command.join(" ")).toContain("43180");
    expect(command.join(" ")).toContain(CODEX_NATIVE_OTEL_COLLECTOR_MARKER);
  });

  it("projects Docker non-TTY frames into bounded OTLP batches", async () => {
    const output = new PassThrough();
    const parser = createCodexNativeOtelCollectorOutputParser(output);
    const batch = JSON.stringify({
      resourceSpans: [{ scopeSpans: [{ spans: [{
        name: "code_mode.grpc.callback",
        traceId: "0123456789abcdef0123456789abcdef",
        status: { code: "STATUS_CODE_OK" },
        attributes: []
      }] }] }]
    });
    const readyBody = Buffer.from(`${"DEVSPACE_CODEX_OTEL_READY"}\n`);
    const body = Buffer.from(batch + "\n");
    const readyFrame = Buffer.alloc(8 + readyBody.length);
    readyFrame[0] = 1;
    readyFrame.writeUInt32BE(readyBody.length, 4);
    readyBody.copy(readyFrame, 8);
    const batchFrame = Buffer.alloc(8 + body.length);
    batchFrame[0] = 1;
    batchFrame.writeUInt32BE(body.length, 4);
    body.copy(batchFrame, 8);
    output.end(Buffer.concat([readyFrame, batchFrame]));
    await parser.done;
    expect(parser.batches).toEqual([batch]);
  });

  it("rejects an oversized collector line", async () => {
    const output = new PassThrough();
    const parser = createCodexNativeOtelCollectorOutputParser(output);
    void parser.ready.catch(() => undefined);
    const body = Buffer.from(`${"x".repeat(1_048_577)}\n`);
    const frame = Buffer.alloc(8 + body.length);
    frame[0] = 1;
    frame.writeUInt32BE(body.length, 4);
    body.copy(frame, 8);
    output.end(frame);
    await expect(parser.done).rejects.toThrow("codex-native-otel-collector-output");
  });
});
