import type { Duplex } from "node:stream";
import { DockerEngineClient, type DockerExecInspection } from "../src/docker-runtime.js";
import {
  collectCodexNativeOtelSpanObservations,
  type CodexNativeOtelSpanObservation
} from "./codex-native-remote-code-mode-evidence.js";

export const CODEX_NATIVE_OTEL_COLLECTOR_MARKER = "devspace-codex-native-otel-collector" as const;
export const CODEX_NATIVE_OTEL_TRACE_EXPORTER_ENDPOINT = "http://127.0.0.1:43180/v1/traces" as const;
const READY_MARKER = "DEVSPACE_CODEX_OTEL_READY" as const;
const DEFAULT_PORT = 43180;
const MAX_LINE_BYTES = 1_048_576;
const MAX_BATCHES = 128;

function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("codex-native-otel-collector-port");
}

/**
 * This process is deliberately self-contained and verifier-only. It accepts
 * OTLP/HTTP JSON on control-container loopback, filters to the four exact
 * native span names/attributes needed by the proof, and emits only the
 * bounded filtered OTLP shape over its Docker exec stdout.
 */
function collectorScript(port: number): string {
  return `const http=require("node:http");
const port=${String(port)};
const maxBody=524288;
const maxSpans=128;
const names=new Set(["code_mode.grpc.execute","code_mode.grpc.callback","code_mode.broker.invoke_tool","codex.exec_server.process"]);
const allowed={"code_mode.grpc.execute":new Set(["execution.id","call_id"]),"code_mode.grpc.callback":new Set(["session.id","execution.id","cell.id","invocation.id"]),"code_mode.broker.invoke_tool":new Set(["cell.id","runtime_tool_call_id","tool_name"]),"codex.exec_server.process":new Set(["process.id","result"])};
const scalar=(value)=>{if(!value||typeof value!=="object")return null;if(typeof value.stringValue==="string"&&value.stringValue.length<=256)return value.stringValue;if(typeof value.intValue==="number"&&Number.isSafeInteger(value.intValue))return value.intValue;if(typeof value.intValue==="string"&&/^-?[0-9]+$/.test(value.intValue)&&Number.isSafeInteger(Number(value.intValue)))return Number(value.intValue);return typeof value.boolValue==="boolean"?value.boolValue:null;};
const status=(value)=>value&&typeof value.code==="string"?value.code:"STATUS_CODE_UNSET";
const hex16=(value)=>typeof value==="string"&&/^[0-9a-f]{16}$/.test(value)?value:null;
const nano=(value)=>typeof value==="string"&&/^[0-9]{1,32}$/.test(value)?value:typeof value==="number"&&Number.isSafeInteger(value)&&value>=0?String(value):null;
const serviceName=(resource)=>{const attrs=resource&&resource.resource&&Array.isArray(resource.resource.attributes)?resource.resource.attributes:[];for(const item of attrs){if(!item||item.key!=="service.name")continue;const value=scalar(item.value);if(typeof value==="string")return value;}return null;};
const project=(root)=>{const result=[];for(const resource of Array.isArray(root&&root.resourceSpans)?root.resourceSpans:[]){const service=serviceName(resource);for(const scope of Array.isArray(resource&&resource.scopeSpans)?resource.scopeSpans:[]){for(const raw of Array.isArray(scope&&scope.spans)?scope.spans:[]){if(result.length>=maxSpans||!raw||typeof raw.name!=="string"||!names.has(raw.name)||typeof raw.traceId!=="string"||!/^[0-9a-f]{32}$/.test(raw.traceId))continue;const attrs=[];for(const item of Array.isArray(raw.attributes)?raw.attributes:[]){if(!item||typeof item.key!=="string"||!allowed[raw.name].has(item.key))continue;const value=scalar(item.value);if(value!==null)attrs.push({key:item.key,value:typeof value==="string"?{stringValue:value}:typeof value==="number"?{intValue:value}:{boolValue:value}});}const span={name:raw.name,traceId:raw.traceId,status:{code:status(raw.status)},attributes:attrs};const spanId=hex16(raw.spanId);if(spanId)span.spanId=spanId;const parent=hex16(raw.parentSpanId);if(parent)span.parentSpanId=parent;const started=nano(raw.startTimeUnixNano);if(started)span.startTimeUnixNano=started;if(service)span.serviceName=service;result.push(span);}}}return {resourceSpans:[{scopeSpans:[{spans:result}]}]};};
const server=http.createServer((request,response)=>{if(request.method!=="POST"||request.url!=="/v1/traces"){response.statusCode=404;response.end();return;}const chunks=[];let size=0;request.on("data",chunk=>{size+=chunk.length;if(size<=maxBody)chunks.push(chunk);else request.destroy();});request.on("end",()=>{if(size>maxBody){response.statusCode=413;response.end();return;}try{const body=project(JSON.parse(Buffer.concat(chunks).toString("utf8")));process.stdout.write(JSON.stringify(body)+"\\n");response.statusCode=200;response.end();}catch{response.statusCode=400;response.end();}});});
server.listen(port,"127.0.0.1",()=>process.stdout.write("${READY_MARKER}\\n"));`;
}

export function createCodexNativeOtelCollectorCommand(port = DEFAULT_PORT): readonly ["node", "-e", string, string] {
  assertPort(port);
  return ["node", "-e", collectorScript(port), CODEX_NATIVE_OTEL_COLLECTOR_MARKER];
}

export interface CodexNativeOtelCollectorOutputParser {
  readonly batches: readonly string[];
  readonly ready: Promise<void>;
  readonly done: Promise<void>;
  readonly takeBatches: () => string[];
}

export function createCodexNativeOtelCollectorOutputParser(stream: Duplex): CodexNativeOtelCollectorOutputParser {
  const batches: string[] = [];
  let error: Error | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  let doneResolve: (() => void) | null = null;
  let doneReject: ((error: Error) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const done = new Promise<void>((resolve, reject) => {
    doneResolve = resolve;
    doneReject = reject;
  });
  let framed = Buffer.alloc(0);
  let lines = "";
  let settled = false;

  const fail = (reason: string): void => {
    if (settled || error !== null) return;
    error = new Error(reason);
    settled = true;
    readyReject?.(error);
    doneReject?.(error);
  };
  const finish = (): void => {
    if (settled) return;
    if (lines.trim() !== "") {
      fail("codex-native-otel-collector-output");
      return;
    }
    if (readyResolve !== null) {
      fail("codex-native-otel-collector-output");
      return;
    }
    settled = true;
    doneResolve?.();
  };
  const consumeLine = (line: string): void => {
    if (line === READY_MARKER) {
      readyResolve?.();
      readyResolve = null;
      return;
    }
    if (line.length === 0) return;
    if (batches.length >= MAX_BATCHES || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      fail("codex-native-otel-collector-output");
      return;
    }
    try {
      JSON.parse(line);
    } catch {
      fail("codex-native-otel-collector-output");
      return;
    }
    batches.push(line);
  };
  const consumePayload = (payload: Buffer): void => {
    lines += payload.toString("utf8");
    if (Buffer.byteLength(lines, "utf8") > MAX_LINE_BYTES) {
      fail("codex-native-otel-collector-output");
      return;
    }
    for (;;) {
      const newline = lines.indexOf("\n");
      if (newline < 0) return;
      const line = lines.slice(0, newline).replace(/\r$/u, "");
      lines = lines.slice(newline + 1);
      consumeLine(line);
      if (error !== null) return;
    }
  };
  const consumeFrames = (chunk: Buffer): void => {
    framed = Buffer.concat([framed, chunk]);
    while (framed.length >= 8) {
      const length = framed.readUInt32BE(4);
      if (length > MAX_LINE_BYTES) return fail("codex-native-otel-collector-output");
      if (framed.length < 8 + length) return;
      const streamType = framed[0];
      const payload = framed.subarray(8, 8 + length);
      framed = framed.subarray(8 + length);
      if (streamType === 1) consumePayload(payload);
      if (error !== null) return;
    }
  };
  stream.on("data", (chunk: Buffer) => consumeFrames(Buffer.from(chunk)));
  stream.once("error", () => fail("codex-native-otel-collector-output"));
  stream.once("end", finish);
  stream.once("close", finish);

  return {
    get batches() { return [...batches]; },
    ready,
    done,
    takeBatches: () => batches.splice(0, batches.length)
  };
}

function inspectCollector(inspection: DockerExecInspection, execId: string, containerId: string): number {
  if (inspection.ID !== execId || inspection.ContainerID !== containerId
    || !inspection.Running || inspection.ExitCode !== null
    || inspection.Pid === undefined || !Number.isSafeInteger(inspection.Pid) || inspection.Pid < 1) {
    throw new Error("codex-native-otel-collector-process");
  }
  return inspection.Pid;
}

export interface CodexNativeOtelCollectorHandle {
  readonly execId: string;
  readonly serverPid: number;
  readonly stream: Duplex;
  readonly takeObservations: () => CodexNativeOtelSpanObservation[];
  readonly close: () => void;
}

export async function startCodexNativeOtelCollector(input: {
  readonly docker: DockerEngineClient;
  readonly containerId: string;
  readonly port?: number;
  readonly startupDeadlineMs?: number;
}): Promise<CodexNativeOtelCollectorHandle> {
  const port = input.port ?? DEFAULT_PORT;
  assertPort(port);
  const execId = await input.docker.createExec(input.containerId, {
    command: createCodexNativeOtelCollectorCommand(port),
    workingDirectory: "/",
    environment: {},
    attachStdin: false,
    tty: false
  });
  const stream = await input.docker.startExecAttached(execId, false);
  const parser = createCodexNativeOtelCollectorOutputParser(stream);
  let outputError: Error | null = null;
  void parser.done.catch((error: unknown) => {
    outputError = error instanceof Error ? error : new Error("codex-native-otel-collector-output");
  });
  const deadline = Date.now() + (input.startupDeadlineMs ?? 5_000);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    parser.ready,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("codex-native-otel-collector-startup-timeout")), Math.max(1, deadline - Date.now()));
    })
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
  const inspection = await input.docker.inspectExec(execId);
  const serverPid = inspectCollector(inspection, execId, input.containerId);
  return {
    execId,
    serverPid,
    stream,
    takeObservations: () => {
      if (outputError !== null) throw outputError;
      return parser.takeBatches().flatMap((batch) => collectCodexNativeOtelSpanObservations(JSON.parse(batch)));
    },
    close: () => stream.destroy()
  };
}

export async function drainCodexNativeOtelObservations(input: {
  readonly takeObservations: () => CodexNativeOtelSpanObservation[];
  readonly isComplete: (spans: readonly CodexNativeOtelSpanObservation[]) => boolean;
  readonly deadlineMs: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): Promise<CodexNativeOtelSpanObservation[]> {
  const pollIntervalMs = input.pollIntervalMs ?? 100;
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1 || input.deadlineMs > 60_000
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 5_000) {
    throw new Error("codex-native-otel-drain-options");
  }
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + input.deadlineMs;
  for (;;) {
    const observations = input.takeObservations();
    if (input.isComplete(observations)) return observations;
    const remaining = deadline - now();
    if (remaining <= 0) return observations;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}
