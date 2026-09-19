import { describe, expect, it } from "vitest";
import {
  evaluateCodexNativeRemoteCodeModeEvidence,
  collectCodexNativeOtelSpanObservations,
  mergeCodexNativeOtelSpanSources,
  projectCodexNativeRemoteCodeModeEvidence,
  type CodexNativeRemoteCodeModeExecProcessEvidence,
  type CodexNativeRemoteCodeModeEvidenceInput,
  type CodexNativeRemoteCodeModeNestedToolEvidence,
  type CodexNativeRemoteCodeModeProviderEvidence,
  type CodexNativeRemoteCodeModeTimingEvidence,
  type CodexNativeOtelSpanObservation
} from "../../test/codex-native-remote-code-mode-evidence.js";

const TRACE_ID = "0123456789abcdef0123456789abcdef";

type EvidenceOverrides = Omit<Partial<CodexNativeRemoteCodeModeEvidenceInput>, "codeModeTiming" | "remoteProvider" | "nestedTool" | "execProcess">
  & {
    readonly codeModeTiming?: Partial<CodexNativeRemoteCodeModeTimingEvidence> | null;
    readonly remoteProvider?: Partial<CodexNativeRemoteCodeModeProviderEvidence> | null;
    readonly nestedTool?: Partial<CodexNativeRemoteCodeModeNestedToolEvidence> | null;
    readonly execProcess?: Partial<CodexNativeRemoteCodeModeExecProcessEvidence> | null;
  };

function mergeNullable<T extends object>(base: T, override: Partial<T> | null | undefined): T | null {
  if (override === null) return null;
  return override === undefined ? base : { ...base, ...override };
}

function evidence(overrides: EvidenceOverrides = {}): CodexNativeRemoteCodeModeEvidenceInput {
  const base = {
    model: "gpt-5.6-luna",
    toolModeEvidence: {
      kind: "pinned-model-metadata-plus-runtime",
      model: "gpt-5.6-luna",
      remoteCodeModeObserved: true
    },
    threadId: "thread-1",
    turnId: "turn-1",
    grpcExecutionId: "execution-1",
    codeModeHostContainerId: "executor-1",
    execServerContainerId: "executor-1",
    codeModeTiming: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-exec-1",
      cellId: "cell-1",
      toolName: "exec",
      cwd: "/workspace",
      hostCompleted: true,
      aborted: false
    },
    remoteProvider: {
      provider: "remote-grpc",
      sessionId: "session-1",
      executionId: "execution-1",
      callId: "call-exec-1",
      cellId: "cell-1",
      invocationId: "invocation-1",
      traceId: TRACE_ID,
      callbackCompleted: true
    },
    nestedTool: {
      cellId: "cell-1",
      runtimeToolCallId: "runtime-call-1",
      toolName: "exec",
      traceId: TRACE_ID,
      dispatchCompleted: true
    },
    execProcess: {
      traceId: TRACE_ID,
      processId: "process-1",
      executorContainerId: "executor-1",
      cwd: "/workspace",
      exitCode: 0,
      closed: true,
      failed: false
    },
    turnCompleted: true,
    controlProjectProcessCount: 0,
    executorProjectProcessCount: 1,
    executorHasNativeHome: false,
    executorHasCredentials: false,
  } satisfies CodexNativeRemoteCodeModeEvidenceInput;
  return {
    ...base,
    ...overrides,
    codeModeTiming: mergeNullable(base.codeModeTiming, overrides.codeModeTiming),
    remoteProvider: mergeNullable(base.remoteProvider, overrides.remoteProvider),
    nestedTool: mergeNullable(base.nestedTool, overrides.nestedTool),
    execProcess: mergeNullable(base.execProcess, overrides.execProcess)
  };
}

function expectBlocked(input: unknown): void {
  expect(evaluateCodexNativeRemoteCodeModeEvidence(input)).toMatchObject({
    readiness: "BLOCKED/INCOMPLETE"
  });
}

function expectProjectionBlocked(input: ReturnType<typeof projected>): void {
  expect(input).toMatchObject({ readiness: "BLOCKED/INCOMPLETE" });
}

function spans(overrides: Partial<Record<string, Partial<CodexNativeOtelSpanObservation>>> = {}): CodexNativeOtelSpanObservation[] {
  return [
    {
      name: "code_mode.grpc.execute",
      traceId: TRACE_ID,
      status: "ok",
      attributes: { "execution.id": "execution-1", call_id: "call-exec-1" },
      ...overrides["code_mode.grpc.execute"]
    },
    {
      name: "code_mode.grpc.callback",
      traceId: TRACE_ID,
      status: "ok",
      attributes: {
        "session.id": "session-1",
        "execution.id": "execution-1",
        "cell.id": "cell-1",
        "invocation.id": "invocation-1"
      },
      ...overrides["code_mode.grpc.callback"]
    },
    {
      name: "code_mode.broker.invoke_tool",
      traceId: TRACE_ID,
      status: "ok",
      attributes: {
        "cell.id": "cell-1",
        runtime_tool_call_id: "runtime-call-1",
        tool_name: "exec"
      },
      ...overrides["code_mode.broker.invoke_tool"]
    },
    {
      name: "codex.exec_server.process",
      traceId: TRACE_ID,
      status: "ok",
      attributes: { "process.id": "process-1", result: "success" },
      ...overrides["codex.exec_server.process"]
    }
  ];
}

function projected(overrides: Partial<Parameters<typeof projectCodexNativeRemoteCodeModeEvidence>[0]> = {}) {
  return projectCodexNativeRemoteCodeModeEvidence({
    model: "gpt-5.6-luna",
    toolModeEvidence: {
      kind: "pinned-model-metadata-plus-runtime",
      model: "gpt-5.6-luna",
      remoteCodeModeObserved: true
    },
    threadId: "thread-1",
    turnId: "turn-1",
    codeModeHostContainerId: "executor-1",
    execServerContainerId: "executor-1",
    codeModeTiming: evidence().codeModeTiming!,
    spans: spans(),
    execProcess: {
      executorContainerId: "executor-1",
      cwd: "/workspace",
      exitCode: 0,
      closed: true,
      failed: false
    },
    turnCompleted: true,
    controlProjectProcessCount: 0,
    executorProjectProcessCount: 1,
    executorHasNativeHome: false,
    executorHasCredentials: false,
    ...overrides
  });
}

describe("Codex native remote Code Mode evidence", () => {
  it("accepts one complete, correlated native proof bundle", () => {
    expect(evaluateCodexNativeRemoteCodeModeEvidence(evidence())).toMatchObject({
      readiness: "MODEL_CORRELATION_OBSERVER_READY"
    });
  });

  it.each([
    ["generic turn completion", { turnCompleted: false }],
    ["Code Mode timing alone", { remoteProvider: null, nestedTool: null, execProcess: null }],
    ["remote process alone", { codeModeTiming: null, remoteProvider: null, nestedTool: null }],
    ["missing remote provider", { remoteProvider: null }],
    ["missing nested callback", { nestedTool: null }],
    ["missing remote process", { execProcess: null }],
    ["missing workspace identity", { execProcess: { ...evidence().execProcess!, cwd: "/tmp" } }],
    ["unsuccessful process", { execProcess: { ...evidence().execProcess!, exitCode: 1 } }],
    ["failed process", { execProcess: { ...evidence().execProcess!, failed: true } }],
    ["unclosed process", { execProcess: { ...evidence().execProcess!, closed: false } }],
    ["control project process", { controlProjectProcessCount: 1 }],
    ["executor native home", { executorHasNativeHome: true }],
    ["executor credentials", { executorHasCredentials: true }],
    ["wrong executor", { execProcess: { ...evidence().execProcess!, executorContainerId: "other" } }]
  ] as const)("blocks incomplete proof: %s", (_name, override) => {
    expectBlocked(evidence(override));
  });

  it.each([
    ["cell IDs", { remoteProvider: { ...evidence().remoteProvider!, cellId: "other-cell" } }],
    ["execution IDs", { remoteProvider: { ...evidence().remoteProvider!, executionId: "other-execution" } }],
    ["trace IDs", { nestedTool: { ...evidence().nestedTool!, traceId: "fedcba9876543210fedcba9876543210" } }],
    ["thread IDs", { codeModeTiming: { ...evidence().codeModeTiming!, threadId: "other-thread" } }],
    ["turn IDs", { codeModeTiming: { ...evidence().codeModeTiming!, turnId: "other-turn" } }]
  ] as const)("blocks mismatched lineage: %s", (_name, override) => {
    expectBlocked(evidence(override));
  });

  it("blocks model narration and unknown raw evidence fields", () => {
    expectBlocked({ ...evidence(), modelNarration: "pwd completed" });
    expectBlocked({ ...evidence(), rawOtlp: { resource: "secret" } });
  });

  it("blocks malformed or oversized correlation identifiers", () => {
    expectBlocked(evidence({ turnId: "x".repeat(257) }));
    expectBlocked(evidence({ remoteProvider: { ...evidence().remoteProvider!, traceId: "not-a-trace" } }));
  });

  it("projects only the exact remote provider, broker, and exec-server spans", () => {
    expect(projected()).toMatchObject({ readiness: "MODEL_CORRELATION_OBSERVER_READY" });
    const ready = projected();
    if (ready.readiness === "MODEL_CORRELATION_OBSERVER_READY") {
      expect(ready.evidence).not.toHaveProperty("spans");
      expect(ready.evidence).not.toHaveProperty("attributes");
      expect(ready.evidence.execProcess.processId).toBe("process-1");
      expect(ready.evidence.remoteProvider.invocationId).toBe("invocation-1");
    }
  });

  it("accepts successful native spans whose OTLP status remains unset", () => {
    expect(projected({ spans: spans().map((span) => ({ ...span, status: "unset" })) })).toMatchObject({
      readiness: "MODEL_CORRELATION_OBSERVER_READY"
    });
  });

  it("projects a bounded OTLP batch in memory without retaining raw attributes", () => {
    const raw = {
      resourceSpans: [{ scopeSpans: [{ spans: spans().map((span) => ({
        name: span.name,
        traceId: span.traceId,
        status: { code: "STATUS_CODE_OK" },
        attributes: Object.entries(span.attributes).map(([key, value]) => ({
          key,
          value: typeof value === "string" ? { stringValue: value } : typeof value === "number" ? { intValue: value } : { boolValue: value }
        }))
      })) }] }],
      secret: "must-not-escape"
    };
    const observations = collectCodexNativeOtelSpanObservations(raw);
    const result = projected({ spans: observations });
    expect(result).toMatchObject({ readiness: "MODEL_CORRELATION_OBSERVER_READY" });
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
    expect(JSON.stringify(result)).not.toContain("attributes");
  });

  it.each([
    ["remote provider span", "code_mode.grpc.callback"],
    ["nested broker span", "code_mode.broker.invoke_tool"],
    ["remote process span", "codex.exec_server.process"]
  ] as const)("blocks when the %s is absent", (_name, spanName) => {
    expectProjectionBlocked(projected({ spans: spans().filter((span) => span.name !== spanName) }));
  });

  it("blocks a trace mismatch between the remote callback and exec process", () => {
    expectProjectionBlocked(projected({
      spans: spans({ "codex.exec_server.process": { traceId: "fedcba9876543210fedcba9876543210" } })
    }));
  });

  it("blocks a trace mismatch between the native gRPC execute and callback spans", () => {
    expectProjectionBlocked(projected({
      spans: spans({ "code_mode.grpc.callback": { traceId: "fedcba9876543210fedcba9876543210" } })
    }));
  });

  it("blocks an exec-server span whose native process result is not success", () => {
    expectProjectionBlocked(projected({
      spans: spans({ "codex.exec_server.process": { attributes: { "process.id": "process-1", result: "error" } } })
    }));
  });

  it("blocks a successful-looking generic command without the Code Mode lineage", () => {
    expectProjectionBlocked(projected({ spans: spans().filter((span) => span.name === "codex.exec_server.process") }));
  });

  it("preserves diagnostic telemetry metadata without requiring it for correlation", () => {
    const observations = collectCodexNativeOtelSpanObservations({
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex-exec-server" } }] },
        scopeSpans: [{ spans: [{
          name: "codex.exec_server.process",
          traceId: TRACE_ID,
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
    expect(observations).toEqual([expect.objectContaining({
      name: "codex.exec_server.process",
      traceId: TRACE_ID,
      spanId: "abcdef0123456789",
      parentSpanId: "0123456789abcdef",
      startTimeUnixNano: "100",
      serviceName: "codex-exec-server",
      attributes: { "process.id": "process-1", result: "success" }
    })]);
    expect(projected({ spans: spans() })).toMatchObject({ readiness: "MODEL_CORRELATION_OBSERVER_READY" });
  });

  it("merges CONTROL Code Mode spans with the EXECUTOR process span into one evidence set", () => {
    const control = spans().filter((span) => span.name !== "codex.exec_server.process");
    const executor = spans().filter((span) => span.name === "codex.exec_server.process");
    const merged = mergeCodexNativeOtelSpanSources({ control, executor });
    expect(merged).toMatchObject({ ok: true });
    if (merged.ok) {
      expect(projected({ spans: merged.spans })).toMatchObject({ readiness: "MODEL_CORRELATION_OBSERVER_READY" });
    }
  });

  it.each([
    ["missing executor process span", { control: spans().filter((span) => span.name !== "codex.exec_server.process"), executor: [] }],
    ["missing control callback span", {
      control: spans().filter((span) => span.name !== "code_mode.grpc.callback" && span.name !== "codex.exec_server.process"),
      executor: spans().filter((span) => span.name === "codex.exec_server.process")
    }],
    ["process span observed on CONTROL", { control: spans(), executor: [] }],
    ["code mode span observed on EXECUTOR", {
      control: spans().filter((span) => span.name !== "codex.exec_server.process"),
      executor: spans()
    }],
    ["duplicate executor process spans", {
      control: spans().filter((span) => span.name !== "codex.exec_server.process"),
      executor: [
        ...spans().filter((span) => span.name === "codex.exec_server.process"),
        ...spans().filter((span) => span.name === "codex.exec_server.process")
      ]
    }],
    ["mismatched process trace", {
      control: spans().filter((span) => span.name !== "codex.exec_server.process"),
      executor: spans({ "codex.exec_server.process": { traceId: "fedcba9876543210fedcba9876543210" } })
        .filter((span) => span.name === "codex.exec_server.process")
    }]
  ] as const)("rejects two-source merge: %s", (_name, sources) => {
    const merged = mergeCodexNativeOtelSpanSources(sources);
    if (merged.ok) {
      expectProjectionBlocked(projected({ spans: merged.spans }));
      return;
    }
    expect(merged).toMatchObject({ ok: false });
  });
});
