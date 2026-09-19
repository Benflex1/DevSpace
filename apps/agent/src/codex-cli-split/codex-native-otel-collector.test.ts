import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DockerEngineClient, type DockerExecInspection } from "../docker-runtime.js";
import { collectCodexNativeOtelSpanObservations } from "../../test/codex-native-remote-code-mode-evidence.js";
import {
  CODEX_NATIVE_OTEL_COLLECTOR_MARKER,
  createCodexNativeOtelCollectorCommand,
  createCodexNativeOtelCollectorOutputParser,
  drainCodexNativeOtelObservations,
  startCodexNativeOtelCollector
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

  it("binds only to container loopback and can observe a native exec-server process span", async () => {
    const command = createCodexNativeOtelCollectorCommand(43180);
    expect(command[2]).toContain('listen(port,"127.0.0.1"');
    expect(command[2]).not.toContain("0.0.0.0");
    const output = new PassThrough();
    const parser = createCodexNativeOtelCollectorOutputParser(output);
    const batch = JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex-exec-server" } }] },
        scopeSpans: [{ spans: [{
          name: "codex.exec_server.process",
          traceId: "0123456789abcdef0123456789abcdef",
          spanId: "abcdef0123456789",
          parentSpanId: "0123456789abcdef",
          startTimeUnixNano: "100",
          status: { code: "STATUS_CODE_OK" },
          attributes: [
            { key: "process.id", value: { stringValue: "process-1" } },
            { key: "result", value: { stringValue: "success" } }
          ]
        }] }]
      }]
    });
    const readyBody = Buffer.from("DEVSPACE_CODEX_OTEL_READY\n");
    const body = Buffer.from(`${batch}\n`);
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
    expect(collectCodexNativeOtelSpanObservations(JSON.parse(parser.batches[0]!))).toEqual([
      expect.objectContaining({
        name: "codex.exec_server.process",
        traceId: "0123456789abcdef0123456789abcdef",
        attributes: { "process.id": "process-1", result: "success" }
      })
    ]);
  });

  it("launches the verifier collector in the executor container without publishing a port", async () => {
    const calls: unknown[] = [];
    const stream = new PassThrough();
    const docker = new class extends DockerEngineClient {
      constructor() { super("/fixture.sock"); }
      override createExec(containerId: string, input: unknown): Promise<string> {
        calls.push({ containerId, input });
        return Promise.resolve("collector-exec");
      }
      override startExecAttached(): Promise<PassThrough> {
        const readyBody = Buffer.from("DEVSPACE_CODEX_OTEL_READY\n");
        const readyFrame = Buffer.alloc(8 + readyBody.length);
        readyFrame[0] = 1;
        readyFrame.writeUInt32BE(readyBody.length, 4);
        readyBody.copy(readyFrame, 8);
        queueMicrotask(() => stream.write(readyFrame));
        return Promise.resolve(stream);
      }
      override inspectExec(): Promise<DockerExecInspection> {
        return Promise.resolve({
          ID: "collector-exec", Running: true, ExitCode: null, ContainerID: "executor-id", Pid: 77
        } as DockerExecInspection);
      }
    }();
    const handle = await startCodexNativeOtelCollector({ docker, containerId: "executor-id" });
    expect(handle).toMatchObject({ execId: "collector-exec", serverPid: 77 });
    expect(calls).toEqual([expect.objectContaining({ containerId: "executor-id" })]);
    expect(JSON.stringify(calls)).not.toContain("HostPort");
    expect(JSON.stringify(calls)).not.toContain("0.0.0.0");
    handle.close();
  });

  it("waits through a bounded drain before cleanup so a delayed native batch is observed", async () => {
    const observed: string[] = [];
    let now = 0;
    const takeObservations = () => {
      if (now >= 20 && observed.length === 0) {
        observed.push("codex.exec_server.process");
      }
      return observed.map((name) => ({
        name: name as "codex.exec_server.process",
        traceId: "0123456789abcdef0123456789abcdef",
        status: "ok" as const,
        attributes: { "process.id": "process-1", result: "success" }
      }));
    };
    const spans = await drainCodexNativeOtelObservations({
      takeObservations,
      isComplete: (current) => current.some((span) => span.name === "codex.exec_server.process"),
      deadlineMs: 50,
      pollIntervalMs: 5,
      now: () => now,
      sleep: (milliseconds) => {
        now += milliseconds;
        return Promise.resolve();
      }
    });
    expect(spans.some((span) => span.name === "codex.exec_server.process")).toBe(true);
    expect(now).toBeGreaterThanOrEqual(20);
    expect(now).toBeLessThanOrEqual(50);
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
