import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import {
  assertContained,
  identitiesEqual,
  identityOf,
  type FileIdentity
} from "../src/private-state.js";
import type { CodexNativeHomeBinding } from "../src/codex-cli-split/native-home.js";
import type {
  CodexSplitModelCompatibilityProof,
  CodexSplitToolModeEvidence
} from "../src/codex-cli-split/feasibility-result.js";

const LOGICAL_SOCKET_PATH = "/codex-home/app-server-control/app-server-control.sock" as const;
const SOCKET_RELATIVE_PATH = "app-server-control/app-server-control.sock" as const;
const MAX_PROTOCOL_MESSAGE_BYTES = 512 * 1024;
const PINNED_CODE_MODE_MODEL = "gpt-6-astra" as const;

export interface CodexNativeAppServerProbeSocket {
  readonly logicalPath: typeof LOGICAL_SOCKET_PATH;
  readonly agentSocketPath: string;
  readonly homeIdentity: CodexNativeHomeBinding["identity"];
  readonly socketIdentity: FileIdentity;
}

function probeSocketPath(homePath: string): string {
  if (!path.isAbsolute(homePath) || homePath.includes("\0")) throw new Error("codex-model-probe-home-path");
  return assertContained(homePath, path.join(homePath, SOCKET_RELATIVE_PATH));
}

function observeSocketPath(socketPath: string): FileIdentity {
  let observed: ReturnType<typeof lstatSync>;
  try {
    observed = lstatSync(socketPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("codex-model-probe-socket-missing", { cause: error });
    throw new Error("codex-model-probe-socket-state", { cause: error });
  }
  if (observed.isSymbolicLink() || !observed.isSocket()) throw new Error("codex-model-probe-socket-foreign");
  return identityOf(observed);
}

function assertOwnedSocketPath(home: CodexNativeHomeBinding, socketPath: string): void {
  const expected = probeSocketPath(home.homePath);
  if (socketPath !== expected || realpathSync(home.homePath) !== home.homePath) {
    throw new Error("codex-model-probe-socket-path");
  }
  const currentHome = lstatSync(home.homePath, { bigint: true });
  if (currentHome.isSymbolicLink() || !currentHome.isDirectory() || !identitiesEqual(identityOf(currentHome), home.identity)) {
    throw new Error("codex-model-probe-home-identity");
  }
  let parent: ReturnType<typeof lstatSync>;
  try {
    parent = lstatSync(path.dirname(socketPath), { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("codex-model-probe-socket-missing", { cause: error });
    throw new Error("codex-model-probe-socket-state", { cause: error });
  }
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error("codex-model-probe-socket-path");
}

export function buildCodexNativeAppServerProbeSocket(home: CodexNativeHomeBinding): CodexNativeAppServerProbeSocket {
  const agentSocketPath = probeSocketPath(home.homePath);
  assertOwnedSocketPath(home, agentSocketPath);
  const socketIdentity = observeSocketPath(agentSocketPath);
  return {
    logicalPath: LOGICAL_SOCKET_PATH,
    agentSocketPath,
    homeIdentity: home.identity,
    socketIdentity
  };
}

export function assertCodexNativeAppServerProbeSocket(input: {
  readonly home: CodexNativeHomeBinding;
  readonly socket: CodexNativeAppServerProbeSocket;
  readonly expectedHomeIdentity: CodexNativeHomeBinding["identity"];
  readonly expectedSocketIdentity: CodexNativeAppServerProbeSocket["socketIdentity"];
}): void {
  const expectedPath = probeSocketPath(input.home.homePath);
  if (input.socket.logicalPath !== LOGICAL_SOCKET_PATH
    || input.socket.agentSocketPath !== expectedPath
    || !identitiesEqual(input.socket.homeIdentity, input.expectedHomeIdentity)
    || !identitiesEqual(input.socket.homeIdentity, input.home.identity)
    || !identitiesEqual(input.socket.socketIdentity, input.expectedSocketIdentity)) {
    throw new Error("codex-model-probe-socket-identity");
  }
  assertOwnedSocketPath(input.home, input.socket.agentSocketPath);
  const current = observeSocketPath(input.socket.agentSocketPath);
  if (!identitiesEqual(current, input.socket.socketIdentity)) throw new Error("codex-model-probe-socket-identity");
}

export interface CodexNativeAppServerModelProbeInput {
  readonly socket: CodexNativeAppServerProbeSocket;
  readonly model: typeof PINNED_CODE_MODE_MODEL;
  readonly logicalCwd: "/workspace";
  readonly operation: "pwd" | "git-status" | "read-acceptance-file" | "write-remove-acceptance-file";
  readonly timeoutMs: number;
}

export interface CodexNativeAppServerModelProbeEvidence {
  readonly provenance: "real-native-app-server";
  readonly model: typeof PINNED_CODE_MODE_MODEL;
  readonly toolModeEvidence: CodexSplitToolModeEvidence;
  readonly remoteCodeModeObserved: true;
  readonly codeModeProvider: "remote-grpc";
  readonly codeModeHostContainerId: string;
  readonly execServerContainerId: string;
  readonly logicalCwd: "/workspace";
  readonly controlProjectProcessCount: 0;
  readonly executorProjectProcessCount: number;
  readonly codeModeHostProcessObserved: true;
  readonly execServerProcessObserved: true;
  readonly nestedProjectExecObserved: true;
  readonly operationCompleted: true;
  readonly executorHasNativeHome: false;
  readonly approval: "not-requested" | "required-stop";
}

export interface CodexNativeAppServerProbeConnection {
  readonly send: (request: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly receive: () => Promise<Readonly<Record<string, unknown>>>;
  readonly close: () => Promise<void>;
}

export interface CodexNativeAppServerModelProbeDependencies {
  readonly connect: (socketPath: string) => Promise<CodexNativeAppServerProbeConnection>;
  readonly inspectControl: () => Promise<{
    readonly projectProcessCount: number;
    readonly appServerProcessCount: number;
  }>;
  readonly inspectExecutor: () => Promise<{
    readonly projectProcessCount: number;
    readonly codeModeHostProcessCount: number;
    readonly execServerProcessCount: number;
    readonly hasNativeHome: false;
    readonly codeModeHostContainerId?: string;
    readonly execServerContainerId?: string;
  }>;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

type ProbeMessage = Readonly<Record<string, unknown>>;
type ExecutorObservation = Awaited<ReturnType<CodexNativeAppServerModelProbeDependencies["inspectExecutor"]>>;

function safeString(value: unknown, reason: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0")) throw new Error(reason);
  return value;
}

function responseId(message: ProbeMessage): string | number | null {
  const value = message.id;
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)) ? value : null;
}

function paramsOf(message: ProbeMessage): ProbeMessage {
  const params = message.params;
  return params !== null && typeof params === "object" && !Array.isArray(params) ? params as ProbeMessage : {};
}

function itemOf(message: ProbeMessage): ProbeMessage | null {
  const item = paramsOf(message).item;
  return item !== null && typeof item === "object" && !Array.isArray(item) ? item as ProbeMessage : null;
}

function errorReason(message: ProbeMessage): string | null {
  const error = message.error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) return null;
  const code = (error as ProbeMessage).code;
  return typeof code === "string" ? "codex-model-probe-protocol-error" : "codex-model-probe-protocol-error";
}

function directToolMode(message: ProbeMessage): "CodeModeOnly" | null {
  const params = paramsOf(message);
  const candidate = params.selectedToolMode ?? params.toolMode;
  if (candidate === undefined) return null;
  if (candidate !== "CodeModeOnly") throw new Error("codex-model-probe-tool-mode");
  return "CodeModeOnly";
}

function operationPrompt(operation: CodexNativeAppServerModelProbeInput["operation"]): string {
  switch (operation) {
    case "pwd": return "Run exactly one bounded project operation: execute pwd in the selected project environment. Do not run any other command, read credentials, or modify files.";
    case "git-status": return "Run exactly one bounded project operation: execute git status --short in the selected project environment. Do not run any other command, read credentials, or modify files.";
    case "read-acceptance-file": return "Run exactly one bounded project operation: read the harmless acceptance file in /workspace. Do not run any other command or access credentials.";
    case "write-remove-acceptance-file": return "Run exactly one bounded project operation: write and then remove the harmless acceptance file in /workspace. Do not run any other command or access credentials.";
  }
}

function isApprovalRequest(method: string): boolean {
  return method.includes("Approval") || method.includes("requestUserInput") || method.includes("elicitation");
}

interface RuntimeObservations {
  remoteEnvironment: boolean;
  codeModeCell: boolean;
  nestedExec: boolean;
  operationCompleted: boolean;
  selectedToolMode: "CodeModeOnly" | null;
  executorProjectProcessCount: number;
  codeModeHostProcessObserved: boolean;
  execServerProcessObserved: boolean;
}

async function observeRuntime(
  message: ProbeMessage,
  observations: RuntimeObservations,
  deps: CodexNativeAppServerModelProbeDependencies,
  deadline: number
): Promise<void> {
  const method = typeof message.method === "string" ? message.method : null;
  if (method === null) return;
  if (isApprovalRequest(method)) throw new Error("approval-required-for-model-compatibility-probe");
  if (method === "thread/environment/connected") observations.remoteEnvironment = true;
  const direct = directToolMode(message);
  if (direct !== null) observations.selectedToolMode = direct;
  const item = itemOf(message);
  if (item !== null) {
    if (item.type === "dynamicToolCall"
      || (item.type === "functionCallOutput" && item.name === "exec" && (item.namespace === null || item.namespace === undefined))) {
      observations.codeModeCell = true;
    }
    if (item.type === "commandExecution") {
      const cwd = item.cwd;
      const source = item.source;
      if (cwd === "/workspace" && (source === "unifiedExecStartup" || source === "unifiedExecInteraction")) {
        observations.nestedExec = true;
        if (item.status === "completed" && item.exitCode === 0) observations.operationCompleted = true;
      }
    }
  }
  const executor = await deps.inspectExecutor();
  if (executor.hasNativeHome !== false) throw new Error("codex-model-probe-executor-home");
  if (executor.codeModeHostProcessCount < 1) throw new Error("codex-model-probe-code-mode-host-process");
  if (executor.execServerProcessCount < 1) throw new Error("codex-model-probe-exec-server-process");
  observations.codeModeHostProcessObserved = true;
  observations.execServerProcessObserved = true;
  observations.executorProjectProcessCount = Math.max(observations.executorProjectProcessCount, executor.projectProcessCount);
  if (deps.now() > deadline) throw new Error("codex-model-probe-timeout");
}

async function receiveWithin(
  connection: CodexNativeAppServerProbeConnection,
  deadline: number,
  deps: CodexNativeAppServerModelProbeDependencies
): Promise<ProbeMessage> {
  const remaining = deadline - deps.now();
  if (remaining <= 0) throw new Error("codex-model-probe-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      connection.receive(),
      new Promise<ProbeMessage>((_, reject) => {
        timer = setTimeout(() => reject(new Error("codex-model-probe-timeout")), remaining);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function request(
  connection: CodexNativeAppServerProbeConnection,
  id: number,
  requestMessage: Readonly<Record<string, unknown>>,
  observations: RuntimeObservations,
  deadline: number,
  deps: CodexNativeAppServerModelProbeDependencies
): Promise<ProbeMessage> {
  await connection.send(requestMessage);
  for (;;) {
    const message = await receiveWithin(connection, deadline, deps);
    await observeRuntime(message, observations, deps, deadline);
    const observedId = responseId(message);
    if (observedId !== id) continue;
    const reason = errorReason(message);
    if (reason !== null) throw new Error(reason);
    return message;
  }
}

function threadIdFromResponse(message: ProbeMessage): string {
  const result = message.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new Error("codex-model-probe-thread-response");
  const thread = (result as ProbeMessage).thread;
  if (thread === null || typeof thread !== "object" || Array.isArray(thread)) throw new Error("codex-model-probe-thread-response");
  return safeString((thread as ProbeMessage).id, "codex-model-probe-thread-response");
}

export async function runCodexNativeAppServerModelProbe(
  input: CodexNativeAppServerModelProbeInput,
  deps: CodexNativeAppServerModelProbeDependencies
): Promise<CodexNativeAppServerModelProbeEvidence & CodexSplitModelCompatibilityProof> {
  if (input.model !== PINNED_CODE_MODE_MODEL) throw new Error("codex-model-probe-model");
  if (input.logicalCwd !== "/workspace") throw new Error("codex-model-probe-cwd");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120_000) {
    throw new Error("codex-model-probe-timeout");
  }
  const controlBefore = await deps.inspectControl();
  if (controlBefore.projectProcessCount !== 0) throw new Error("codex-model-probe-control-project-process");
  if (controlBefore.appServerProcessCount < 1) throw new Error("codex-model-probe-app-server-process");
  const executorBefore = await deps.inspectExecutor();
  if (executorBefore.hasNativeHome !== false) throw new Error("codex-model-probe-executor-home");
  if (executorBefore.codeModeHostProcessCount < 1) throw new Error("codex-model-probe-code-mode-host-process");
  if (executorBefore.execServerProcessCount < 1) throw new Error("codex-model-probe-exec-server-process");
  const deadline = deps.now() + input.timeoutMs;
  const observations: RuntimeObservations = {
    remoteEnvironment: false,
    codeModeCell: false,
    nestedExec: false,
    operationCompleted: false,
    selectedToolMode: null,
    executorProjectProcessCount: 0,
    codeModeHostProcessObserved: true,
    execServerProcessObserved: true
  };
  const connection = await deps.connect(input.socket.agentSocketPath);
  try {
    await request(connection, 1, {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "devspace-codex-split-model-probe", version: "0.0.0" },
        capabilities: { experimentalApi: false }
      }
    }, observations, deadline, deps);
    await connection.send({ method: "initialized", params: {} });
    const threadResponse = await request(connection, 2, {
      id: 2,
      method: "thread/start",
      params: { model: PINNED_CODE_MODE_MODEL, cwd: input.logicalCwd, ephemeral: true }
    }, observations, deadline, deps);
    const threadId = threadIdFromResponse(threadResponse);
    await request(connection, 3, {
      id: 3,
      method: "turn/start",
      params: {
        threadId,
        input: [{ type: "text", text: operationPrompt(input.operation) }],
        model: PINNED_CODE_MODE_MODEL,
        cwd: input.logicalCwd
      }
    }, observations, deadline, deps);
    for (;;) {
      const message = await receiveWithin(connection, deadline, deps);
      await observeRuntime(message, observations, deps, deadline);
      if (message.method === "turn/completed") {
        const params = paramsOf(message);
        const turn = params.turn;
        if (turn === null || typeof turn !== "object" || Array.isArray(turn) || (turn as ProbeMessage).status !== "completed") {
          throw new Error("codex-model-probe-turn-failed");
        }
        break;
      }
    }
  } finally {
    await connection.close().catch(() => undefined);
  }
  const controlAfter = await deps.inspectControl();
  const executorAfter = await deps.inspectExecutor();
  if (controlAfter.projectProcessCount !== 0) throw new Error("codex-model-probe-control-project-process");
  if (controlAfter.appServerProcessCount < 1) throw new Error("codex-model-probe-app-server-process");
  if (executorAfter.hasNativeHome !== false) throw new Error("codex-model-probe-executor-home");
  if (executorAfter.codeModeHostProcessCount < 1) throw new Error("codex-model-probe-code-mode-host-process");
  if (executorAfter.execServerProcessCount < 1) throw new Error("codex-model-probe-exec-server-process");
  observations.executorProjectProcessCount = Math.max(observations.executorProjectProcessCount, executorAfter.projectProcessCount);
  if (!observations.remoteEnvironment || !observations.codeModeCell) throw new Error("codex-model-probe-remote-code-mode-unobserved");
  if (!observations.nestedExec || !observations.operationCompleted) throw new Error("codex-model-probe-remote-exec-unobserved");
  if (observations.executorProjectProcessCount < 1) throw new Error("codex-model-probe-executor-project-process");
  const toolModeEvidence: CodexSplitToolModeEvidence = observations.selectedToolMode === "CodeModeOnly"
    ? { kind: "protocol", value: "CodeModeOnly" }
    : { kind: "pinned-model-metadata-plus-runtime", model: PINNED_CODE_MODE_MODEL, remoteCodeModeObserved: true };
  const executorObservation: ExecutorObservation = executorAfter;
  const codeModeHostContainerId = executorObservation.codeModeHostContainerId ?? "observed-executor";
  const execServerContainerId = executorObservation.execServerContainerId ?? "observed-executor";
  return {
    provenance: "real-native-app-server",
    model: PINNED_CODE_MODE_MODEL,
    toolModeEvidence,
    remoteCodeModeObserved: true,
    codeModeProvider: "remote-grpc",
    codeModeHostContainerId,
    execServerContainerId,
    logicalCwd: "/workspace",
    controlProjectProcessCount: 0,
    executorProjectProcessCount: observations.executorProjectProcessCount,
    codeModeHostProcessObserved: true,
    execServerProcessObserved: true,
    nestedProjectExecObserved: true,
    operationCompleted: true,
    executorHasNativeHome: false,
    approval: "not-requested"
  };
}

export function createCodexNativeAppServerProbeConnection(socketPath: string): Promise<CodexNativeAppServerProbeConnection> {
  if (!path.isAbsolute(socketPath) || socketPath.includes("\0")) return Promise.reject(new Error("codex-model-probe-socket-path"));
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws+unix://${socketPath}:/`, { perMessageDeflate: false, maxPayload: MAX_PROTOCOL_MESSAGE_BYTES });
    const messages: ProbeMessage[] = [];
    const waiters: Array<{ readonly resolve: (message: ProbeMessage) => void; readonly reject: (error: Error) => void }> = [];
    let closed = false;
    let failure: Error | null = null;
    const rejectAll = (error: Error): void => {
      failure = error;
      while (waiters.length > 0) waiters.shift()!.reject(error);
    };
    socket.once("error", (error) => {
      const safe = new Error("codex-model-probe-socket-transport", { cause: error });
      if (!closed) rejectAll(safe);
      reject(safe);
    });
    socket.once("open", () => {
      resolve({
        send(request): Promise<void> {
          if (closed || failure !== null || socket.readyState !== WebSocket.OPEN) throw new Error("codex-model-probe-socket-closed");
          socket.send(JSON.stringify(request));
          return Promise.resolve();
        },
        async receive(): Promise<ProbeMessage> {
          if (messages.length > 0) return messages.shift()!;
          if (failure !== null) throw failure;
          if (closed) throw new Error("codex-model-probe-socket-closed");
          return await new Promise<ProbeMessage>((receiveResolve, receiveReject) => waiters.push({ resolve: receiveResolve, reject: receiveReject }));
        },
        close(): Promise<void> {
          closed = true;
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
          return Promise.resolve();
        }
      });
    });
    socket.on("message", (data) => {
      let parsed: unknown;
      const text = typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8");
      try { parsed = JSON.parse(text); }
      catch (error) { rejectAll(new Error("codex-model-probe-protocol-invalid", { cause: error })); return; }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        rejectAll(new Error("codex-model-probe-protocol-invalid"));
        return;
      }
      const message = parsed as ProbeMessage;
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter.resolve(message);
      else messages.push(message);
    });
    socket.once("close", () => {
      closed = true;
      if (failure === null) rejectAll(new Error("codex-model-probe-socket-closed"));
    });
  });
}
