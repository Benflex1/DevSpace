import * as z from "zod";

export type CodexNativeRemoteCodeModeModel = "gpt-6-astra" | "gpt-5.6-luna";

const boundedIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const traceIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
const modelSchema = z.enum(["gpt-6-astra", "gpt-5.6-luna"]);

const toolModeEvidenceSchema = z.union([
  z.strictObject({ kind: z.literal("protocol"), value: z.literal("CodeModeOnly") }),
  z.strictObject({
    kind: z.literal("pinned-model-metadata-plus-runtime"),
    model: modelSchema,
    remoteCodeModeObserved: z.literal(true)
  })
]);

const codeModeTimingSchema = z.strictObject({
  threadId: boundedIdSchema,
  turnId: boundedIdSchema,
  callId: boundedIdSchema,
  cellId: boundedIdSchema,
  toolName: z.literal("exec"),
  cwd: z.literal("/workspace"),
  hostCompleted: z.literal(true),
  aborted: z.literal(false)
});

const remoteProviderSchema = z.strictObject({
  provider: z.literal("remote-grpc"),
  sessionId: boundedIdSchema,
  executionId: boundedIdSchema,
  callId: boundedIdSchema,
  cellId: boundedIdSchema,
  invocationId: boundedIdSchema,
  traceId: traceIdSchema,
  callbackCompleted: z.literal(true)
}).nullable();

const nestedToolSchema = z.strictObject({
  cellId: boundedIdSchema,
  runtimeToolCallId: boundedIdSchema,
  toolName: z.literal("exec"),
  traceId: traceIdSchema,
  dispatchCompleted: z.literal(true)
}).nullable();

const execProcessSchema = z.strictObject({
  traceId: traceIdSchema,
  processId: boundedIdSchema,
  executorContainerId: boundedIdSchema,
  cwd: z.literal("/workspace"),
  exitCode: z.literal(0),
  closed: z.literal(true),
  failed: z.literal(false)
}).nullable();

const evidenceSchema = z.strictObject({
  model: modelSchema,
  toolModeEvidence: toolModeEvidenceSchema,
  threadId: boundedIdSchema,
  turnId: boundedIdSchema,
  grpcExecutionId: boundedIdSchema,
  codeModeHostContainerId: boundedIdSchema,
  execServerContainerId: boundedIdSchema,
  codeModeTiming: codeModeTimingSchema.nullable(),
  remoteProvider: remoteProviderSchema,
  nestedTool: nestedToolSchema,
  execProcess: execProcessSchema,
  turnCompleted: z.literal(true),
  controlProjectProcessCount: z.literal(0),
  executorProjectProcessCount: z.number().int().min(1).max(4096),
  executorHasNativeHome: z.literal(false),
  executorHasCredentials: z.literal(false)
});

export type CodexNativeRemoteCodeModeToolModeEvidence =
  | { readonly kind: "protocol"; readonly value: "CodeModeOnly" }
  | {
    readonly kind: "pinned-model-metadata-plus-runtime";
    readonly model: CodexNativeRemoteCodeModeModel;
    readonly remoteCodeModeObserved: true;
  };

export interface CodexNativeRemoteCodeModeTimingEvidence {
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly cellId: string;
  readonly toolName: "exec";
  readonly cwd: string;
  readonly hostCompleted: boolean;
  readonly aborted: boolean;
}

export interface CodexNativeRemoteCodeModeProviderEvidence {
  readonly provider: "remote-grpc";
  readonly sessionId: string;
  readonly executionId: string;
  readonly callId: string;
  readonly cellId: string;
  readonly invocationId: string;
  readonly traceId: string;
  readonly callbackCompleted: boolean;
}

export interface CodexNativeRemoteCodeModeNestedToolEvidence {
  readonly cellId: string;
  readonly runtimeToolCallId: string;
  readonly toolName: "exec";
  readonly traceId: string;
  readonly dispatchCompleted: boolean;
}

export interface CodexNativeRemoteCodeModeExecProcessEvidence {
  readonly traceId: string;
  readonly processId: string;
  readonly executorContainerId: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly closed: boolean;
  readonly failed: boolean;
}

export interface CodexNativeRemoteCodeModeEvidenceInput {
  readonly model: CodexNativeRemoteCodeModeModel;
  readonly toolModeEvidence: CodexNativeRemoteCodeModeToolModeEvidence;
  readonly threadId: string;
  readonly turnId: string;
  readonly grpcExecutionId: string;
  readonly codeModeHostContainerId: string;
  readonly execServerContainerId: string;
  readonly codeModeTiming: CodexNativeRemoteCodeModeTimingEvidence | null;
  readonly remoteProvider: CodexNativeRemoteCodeModeProviderEvidence | null;
  readonly nestedTool: CodexNativeRemoteCodeModeNestedToolEvidence | null;
  readonly execProcess: CodexNativeRemoteCodeModeExecProcessEvidence | null;
  readonly turnCompleted: boolean;
  readonly controlProjectProcessCount: number;
  readonly executorProjectProcessCount: number;
  readonly executorHasNativeHome: boolean;
  readonly executorHasCredentials: boolean;
}

export interface CodexNativeRemoteCodeModeEvidence {
  readonly model: CodexNativeRemoteCodeModeModel;
  readonly toolModeEvidence: CodexNativeRemoteCodeModeToolModeEvidence;
  readonly threadId: string;
  readonly turnId: string;
  readonly grpcExecutionId: string;
  readonly codeModeHostContainerId: string;
  readonly execServerContainerId: string;
  readonly codeModeTiming: CodexNativeRemoteCodeModeTimingEvidence;
  readonly remoteProvider: CodexNativeRemoteCodeModeProviderEvidence;
  readonly nestedTool: CodexNativeRemoteCodeModeNestedToolEvidence;
  readonly execProcess: CodexNativeRemoteCodeModeExecProcessEvidence;
  readonly turnCompleted: true;
  readonly controlProjectProcessCount: 0;
  readonly executorProjectProcessCount: number;
  readonly executorHasNativeHome: false;
  readonly executorHasCredentials: false;
}

export interface CodexNativeOtelSpanObservation {
  readonly name: "code_mode.grpc.execute" | "code_mode.grpc.callback" | "code_mode.broker.invoke_tool" | "codex.exec_server.process";
  readonly traceId: string;
  readonly status: "ok" | "error" | "unset";
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface CodexNativeExecProcessRuntimeObservation {
  readonly executorContainerId: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly closed: boolean;
  readonly failed: boolean;
}

export interface CodexNativeRemoteCodeModeOtelProjectionInput {
  readonly model: CodexNativeRemoteCodeModeModel;
  readonly toolModeEvidence: CodexNativeRemoteCodeModeToolModeEvidence;
  readonly threadId: string;
  readonly turnId: string;
  readonly codeModeHostContainerId: string;
  readonly execServerContainerId: string;
  readonly codeModeTiming: CodexNativeRemoteCodeModeTimingEvidence;
  readonly spans: readonly CodexNativeOtelSpanObservation[];
  readonly execProcess: CodexNativeExecProcessRuntimeObservation;
  readonly turnCompleted: boolean;
  readonly controlProjectProcessCount: number;
  readonly executorProjectProcessCount: number;
  readonly executorHasNativeHome: boolean;
  readonly executorHasCredentials: boolean;
}

export type CodexNativeRemoteCodeModeCorrelationEvaluation =
  | {
    readonly readiness: "MODEL_CORRELATION_OBSERVER_READY";
    readonly evidence: CodexNativeRemoteCodeModeEvidence;
  }
  | {
    readonly readiness: "BLOCKED/INCOMPLETE";
    readonly reason: string;
  };

const SPAN_NAMES = new Set<CodexNativeOtelSpanObservation["name"]>([
  "code_mode.grpc.execute",
  "code_mode.grpc.callback",
  "code_mode.broker.invoke_tool",
  "codex.exec_server.process"
]);

function blocked(reason: string): CodexNativeRemoteCodeModeCorrelationEvaluation {
  return { readiness: "BLOCKED/INCOMPLETE", reason };
}

function boundedString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    ? value
    : null;
}

function traceId(value: unknown): string | null {
  return typeof value === "string" && traceIdSchema.safeParse(value).success ? value : null;
}

function attribute(span: CodexNativeOtelSpanObservation, key: string): string | number | boolean | null {
  const value = span.attributes[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

function requiredAttribute(span: CodexNativeOtelSpanObservation, key: string): string | null {
  return boundedString(attribute(span, key));
}

function oneSpan(
  spans: readonly CodexNativeOtelSpanObservation[],
  name: CodexNativeOtelSpanObservation["name"]
): CodexNativeOtelSpanObservation | null {
  const matches = spans.filter((span) => span.name === name);
  const match = matches[0];
  return matches.length === 1 && match !== undefined && match.status !== "error" && traceId(match.traceId) !== null ? match : null;
}

const SPAN_ATTRIBUTES: Readonly<Record<CodexNativeOtelSpanObservation["name"], ReadonlySet<string>>> = {
  "code_mode.grpc.execute": new Set(["execution.id", "call_id"]),
  "code_mode.grpc.callback": new Set(["session.id", "execution.id", "cell.id", "invocation.id"]),
  "code_mode.broker.invoke_tool": new Set(["cell.id", "runtime_tool_call_id", "tool_name"]),
  "codex.exec_server.process": new Set(["process.id", "result"])
};

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function scalarAttribute(value: unknown): string | number | boolean | null {
  const record = recordOf(value);
  if (record === null) return null;
  const stringValue = record.stringValue;
  if (typeof stringValue === "string" && stringValue.length <= 256) return stringValue;
  const intValue = record.intValue;
  if ((typeof intValue === "number" && Number.isSafeInteger(intValue))
    || (typeof intValue === "string" && /^-?[0-9]+$/u.test(intValue) && Number.isSafeInteger(Number(intValue)))) {
    return Number(intValue);
  }
  const boolValue = record.boolValue;
  return typeof boolValue === "boolean" ? boolValue : null;
}

function spanStatus(value: unknown): "ok" | "error" | "unset" {
  const record = recordOf(value);
  const code = record?.code;
  if (code === "STATUS_CODE_OK" || code === 1 || code === "1") return "ok";
  if (code === "STATUS_CODE_ERROR" || code === 2 || code === "2") return "error";
  return "unset";
}

/**
 * Projects an OTLP/HTTP JSON batch into the small span shape used by the
 * evaluator. Unknown resource, span, and attribute data is discarded in
 * memory; raw OTLP is never part of the returned evidence.
 */
export function collectCodexNativeOtelSpanObservations(input: unknown): CodexNativeOtelSpanObservation[] {
  const root = recordOf(input);
  const resourceSpans = root?.resourceSpans;
  if (!Array.isArray(resourceSpans)) return [];
  const observations: CodexNativeOtelSpanObservation[] = [];
  for (const resourceSpan of resourceSpans) {
    const scopes = recordOf(resourceSpan)?.scopeSpans;
    if (!Array.isArray(scopes)) continue;
    for (const scope of scopes) {
      const spans = recordOf(scope)?.spans;
      if (!Array.isArray(spans)) continue;
      for (const rawSpan of spans) {
        const span = recordOf(rawSpan);
        const name = span?.name;
        const trace = traceId(span?.traceId);
        if (typeof name !== "string" || !SPAN_NAMES.has(name as CodexNativeOtelSpanObservation["name"]) || trace === null) continue;
        const typedName = name as CodexNativeOtelSpanObservation["name"];
        const allowed = SPAN_ATTRIBUTES[typedName];
        const attributes: Record<string, string | number | boolean> = {};
        const rawAttributes = span?.attributes;
        if (Array.isArray(rawAttributes)) {
          for (const rawAttribute of rawAttributes) {
            const attributeRecord = recordOf(rawAttribute);
            if (attributeRecord === null) continue;
            const key = attributeRecord?.key;
            if (typeof key !== "string" || !allowed.has(key)) continue;
            const value = scalarAttribute(attributeRecord.value);
            if (value !== null) attributes[key] = value;
          }
        }
        observations.push({ name: typedName, traceId: trace, status: spanStatus(span?.status), attributes });
        if (observations.length >= 128) return observations;
      }
    }
  }
  return observations;
}

function projectSpanEvidence(
  input: CodexNativeRemoteCodeModeOtelProjectionInput
): CodexNativeRemoteCodeModeEvidenceInput | null {
  const executeSpan = oneSpan(input.spans, "code_mode.grpc.execute");
  const callbackSpan = oneSpan(input.spans, "code_mode.grpc.callback");
  const brokerSpan = oneSpan(input.spans, "code_mode.broker.invoke_tool");
  const processSpan = oneSpan(input.spans, "codex.exec_server.process");
  if (executeSpan === null || callbackSpan === null || brokerSpan === null || processSpan === null) return null;

  const executeId = requiredAttribute(executeSpan, "execution.id");
  const executeCallId = requiredAttribute(executeSpan, "call_id");
  const sessionId = requiredAttribute(callbackSpan, "session.id");
  const callbackExecutionId = requiredAttribute(callbackSpan, "execution.id");
  const callbackCellId = requiredAttribute(callbackSpan, "cell.id");
  const invocationId = requiredAttribute(callbackSpan, "invocation.id");
  const brokerCellId = requiredAttribute(brokerSpan, "cell.id");
  const runtimeToolCallId = requiredAttribute(brokerSpan, "runtime_tool_call_id");
  const toolName = requiredAttribute(brokerSpan, "tool_name");
  const processId = requiredAttribute(processSpan, "process.id");
  const processResult = requiredAttribute(processSpan, "result");
  const executeTraceId = traceId(executeSpan.traceId);
  const callbackTraceId = traceId(callbackSpan.traceId);
  const brokerTraceId = traceId(brokerSpan.traceId);
  const processTraceId = traceId(processSpan.traceId);
  if (executeId === null || executeCallId === null || sessionId === null || callbackExecutionId === null
    || callbackCellId === null || invocationId === null || brokerCellId === null || runtimeToolCallId === null
    || toolName === null || processId === null || processResult !== "success" || executeTraceId === null || callbackTraceId === null
    || brokerTraceId === null || processTraceId === null || toolName !== "exec"
    || callbackExecutionId !== executeId || executeTraceId !== callbackTraceId) return null;

  return {
    model: input.model,
    toolModeEvidence: input.toolModeEvidence,
    threadId: input.threadId,
    turnId: input.turnId,
    grpcExecutionId: executeId,
    codeModeHostContainerId: input.codeModeHostContainerId,
    execServerContainerId: input.execServerContainerId,
    codeModeTiming: input.codeModeTiming,
    remoteProvider: {
      provider: "remote-grpc",
      sessionId,
      executionId: callbackExecutionId,
      callId: executeCallId,
      cellId: callbackCellId,
      invocationId,
      traceId: callbackTraceId,
      callbackCompleted: true
    },
    nestedTool: {
      cellId: brokerCellId,
      runtimeToolCallId,
      toolName: "exec",
      traceId: brokerTraceId,
      dispatchCompleted: true
    },
    execProcess: {
      traceId: processTraceId,
      processId,
      executorContainerId: input.execProcess.executorContainerId,
      cwd: input.execProcess.cwd,
      exitCode: input.execProcess.exitCode,
      closed: input.execProcess.closed,
      failed: input.execProcess.failed
    },
    turnCompleted: input.turnCompleted,
    controlProjectProcessCount: input.controlProjectProcessCount,
    executorProjectProcessCount: input.executorProjectProcessCount,
    executorHasNativeHome: input.executorHasNativeHome,
    executorHasCredentials: input.executorHasCredentials
  };
}

export function evaluateCodexNativeRemoteCodeModeEvidence(input: unknown): CodexNativeRemoteCodeModeCorrelationEvaluation {
  const parsed = evidenceSchema.safeParse(input);
  if (!parsed.success) return blocked("codex-native-code-mode-correlation-invalid");
  const evidence = parsed.data;
  const timing = evidence.codeModeTiming;
  const provider = evidence.remoteProvider;
  const nested = evidence.nestedTool;
  const process = evidence.execProcess;
  if (timing === null) return blocked("codex-native-code-mode-timing-unobserved");
  if (provider === null) return blocked("codex-native-code-mode-remote-provider-unobserved");
  if (nested === null) return blocked("codex-native-code-mode-nested-callback-unobserved");
  if (process === null) return blocked("codex-native-code-mode-remote-process-unobserved");
  if (evidence.toolModeEvidence.kind === "pinned-model-metadata-plus-runtime"
    && evidence.toolModeEvidence.model !== evidence.model) {
    return blocked("codex-native-code-mode-model-evidence-mismatch");
  }
  if (timing.threadId !== evidence.threadId || timing.turnId !== evidence.turnId
    || timing.callId !== provider.callId || timing.cellId !== provider.cellId
    || evidence.grpcExecutionId !== provider.executionId || provider.executionId.length === 0
    || provider.cellId !== nested.cellId
    || provider.traceId !== nested.traceId || provider.traceId !== process.traceId
    || evidence.codeModeHostContainerId !== evidence.execServerContainerId
    || process.executorContainerId !== evidence.codeModeHostContainerId) {
    return blocked("codex-native-code-mode-correlation-mismatch");
  }
  if (timing.toolName !== "exec" || timing.cwd !== "/workspace" || !timing.hostCompleted || timing.aborted
    || nested.toolName !== "exec" || !nested.dispatchCompleted
    || process.cwd !== "/workspace" || process.exitCode !== 0 || !process.closed || process.failed) {
    return blocked("codex-native-code-mode-execution-incomplete");
  }
  if (evidence.turnCompleted !== true || evidence.controlProjectProcessCount !== 0
    || evidence.executorProjectProcessCount < 1 || evidence.executorHasNativeHome !== false
    || evidence.executorHasCredentials !== false) {
    return blocked("codex-native-code-mode-boundary-unproven");
  }
  const completeEvidence: CodexNativeRemoteCodeModeEvidence = {
    ...evidence,
    codeModeTiming: timing,
    remoteProvider: provider,
    nestedTool: nested,
    execProcess: process
  };
  return { readiness: "MODEL_CORRELATION_OBSERVER_READY", evidence: completeEvidence };
}

export function projectCodexNativeRemoteCodeModeEvidence(
  input: CodexNativeRemoteCodeModeOtelProjectionInput
): CodexNativeRemoteCodeModeCorrelationEvaluation {
  if (input.spans.length > 128 || input.spans.some((span) => !SPAN_NAMES.has(span.name))) {
    return blocked("codex-native-code-mode-otel-span-boundary");
  }
  const projectedEvidence = projectSpanEvidence(input);
  if (projectedEvidence === null) return blocked("codex-native-code-mode-otel-correlation-unobserved");
  return evaluateCodexNativeRemoteCodeModeEvidence(projectedEvidence);
}
