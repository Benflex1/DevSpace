import { expect, it } from "vitest";
import {
  runCodexNativeAppServerModelProbe,
  type CodexNativeAppServerModelProbeDependencies,
  type CodexNativeAppServerProbeConnection
} from "../../test/codex-native-app-server-probe.js";
import type { CodexNativeRemoteCodeModeEvidenceInput } from "../../test/codex-native-remote-code-mode-evidence.js";

const socket = {
  logicalPath: "/codex-home/app-server-control/app-server-control.sock",
  agentSocketPath: "/agent-private/native-home/app-server-control/app-server-control.sock",
  homeIdentity: { device: "1", inode: "1" },
  socketIdentity: { device: "1", inode: "2" }
} as const;

const TRACE_ID = "0123456789abcdef0123456789abcdef";

function completeCorrelationEvidence(): CodexNativeRemoteCodeModeEvidenceInput {
  return {
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
      callId: "call-1",
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
      callId: "call-1",
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
    executorHasCredentials: false
  };
}

function connection(messages: readonly Readonly<Record<string, unknown>>[], sent: Readonly<Record<string, unknown>>[] = []): CodexNativeAppServerProbeConnection {
  const queue = [...messages];
  return {
    send: (request) => { sent.push(request); return Promise.resolve(); },
    receive: () => {
      const message = queue.shift();
      return message === undefined ? Promise.reject(new Error("probe-test-message-exhausted")) : Promise.resolve(message);
    },
    close: () => Promise.resolve()
  };
}

function dependencies(messages: readonly Readonly<Record<string, unknown>>[]): CodexNativeAppServerModelProbeDependencies {
  return {
    connect: () => Promise.resolve(connection(messages)),
    inspectControl: () => Promise.resolve({ projectProcessCount: 0, appServerProcessCount: 1 }),
    inspectExecutor: () => Promise.resolve({
      projectProcessCount: 1,
      codeModeHostProcessCount: 1,
      execServerProcessCount: 1,
      hasNativeHome: false as const,
      hasCredentials: false as const,
      codeModeHostContainerId: "executor-1",
      execServerContainerId: "executor-1"
    }),
    observeRemoteCodeModeEvidence: () => Promise.resolve(null),
    now: () => 0,
    sleep: () => Promise.resolve()
  };
}

function environmentStatusMessages(
  result: unknown,
  options: { readonly connected?: boolean; readonly narration?: boolean } = {}
): Readonly<Record<string, unknown>>[] {
  const messages: Readonly<Record<string, unknown>>[] = [
    { id: 1, result: { userAgent: "codex" } },
    { id: 2, result: { thread: { id: "thread-1" } } }
  ];
  if (options.connected === true) {
    messages.push({ method: "thread/environment/connected", params: { threadId: "thread-1", environmentId: "remote" } });
  }
  messages.push({ id: 3, result: { turn: { id: "turn-1" } } });
  if (options.narration === true) {
    messages.push({ method: "item/agentMessage/delta", params: { delta: "remote environment is ready" } });
  }
  messages.push(
    { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
    { id: 4, result }
  );
  return messages;
}

it("uses environment/status when the connected lifecycle notification is not replayed", async () => {
  const sent: Readonly<Record<string, unknown>>[] = [];
  const messages = [
    { id: 1, result: { userAgent: "codex" } },
    { id: 2, result: { thread: { id: "thread-1" } } },
    { id: 3, result: { turn: { id: "turn-1" } } },
    { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
    { id: 4, result: { status: "ready" } }
  ] as const;
  await expect(runCodexNativeAppServerModelProbe({
    socket,
    model: "gpt-5.6-luna",
    logicalCwd: "/workspace",
    operation: "pwd",
    timeoutMs: 100
  }, {
    ...dependencies(messages),
    connect: () => Promise.resolve(connection(messages, sent)),
    observeRemoteCodeModeEvidence: () => Promise.resolve(completeCorrelationEvidence())
  })).resolves.toMatchObject({ model: "gpt-5.6-luna" });
  expect(sent.filter((request) => request.method === "environment/status")).toEqual([
    { id: 4, method: "environment/status", params: { environmentId: "remote" } }
  ]);
});

it.each(["pending", "disconnected", "unknown"] as const)("blocks environment status %s", async (status) => {
  await expect(runCodexNativeAppServerModelProbe({
    socket, model: "gpt-5.6-luna", logicalCwd: "/workspace", operation: "pwd", timeoutMs: 100
  }, dependencies(environmentStatusMessages({ status })))).rejects.toThrow(
    `codex-model-probe-environment-status-${status}`
  );
});

it.each([
  ["missing status", {}],
  ["null result", null],
  ["invalid status", { status: "ready-ish" }],
  ["array result", []]
] as const)("blocks %s", async (_name, result) => {
  await expect(runCodexNativeAppServerModelProbe({
    socket, model: "gpt-5.6-luna", logicalCwd: "/workspace", operation: "pwd", timeoutMs: 100
  }, dependencies(environmentStatusMessages(result)))).rejects.toThrow(
    "codex-model-probe-environment-status-invalid"
  );
});

it("does not treat a connected notification as current ready state", async () => {
  await expect(runCodexNativeAppServerModelProbe({
    socket, model: "gpt-5.6-luna", logicalCwd: "/workspace", operation: "pwd", timeoutMs: 100
  }, dependencies(environmentStatusMessages({ status: "pending" }, { connected: true })))).rejects.toThrow(
    "codex-model-probe-environment-status-pending"
  );
});

it("does not treat model narration as environment state", async () => {
  await expect(runCodexNativeAppServerModelProbe({
    socket, model: "gpt-5.6-luna", logicalCwd: "/workspace", operation: "pwd", timeoutMs: 100
  }, dependencies(environmentStatusMessages({ status: "pending" }, { narration: true })))).rejects.toThrow(
    "codex-model-probe-environment-status-pending"
  );
});

it("requires native correlation evidence after a ready environment status", async () => {
  await expect(runCodexNativeAppServerModelProbe({
    socket, model: "gpt-5.6-luna", logicalCwd: "/workspace", operation: "pwd", timeoutMs: 100
  }, dependencies(environmentStatusMessages({ status: "ready" })))).rejects.toThrow(
    "codex-native-code-mode-correlation-invalid"
  );
});

it("does not accept an impossible v2 functionCall item as Code Mode evidence", async () => {
  await expect(runCodexNativeAppServerModelProbe({
    socket,
    model: "gpt-5.6-luna",
    logicalCwd: "/workspace",
    operation: "pwd",
    timeoutMs: 100
  }, dependencies([
    { id: 1, result: { userAgent: "codex" } },
    { id: 2, result: { thread: { id: "thread-1" } } },
    { method: "thread/environment/connected", params: { threadId: "thread-1", environmentId: "remote" } },
    { id: 3, result: { turn: { id: "turn-1" } } },
    { method: "item/started", params: { item: { id: "code-mode-1", type: "functionCall", name: "exec" } } },
    { method: "item/started", params: { item: { id: "command-1", type: "commandExecution", cwd: "/workspace", source: "unifiedExecStartup" } } },
    { method: "item/completed", params: { item: { id: "command-1", type: "commandExecution", cwd: "/workspace", source: "unifiedExecStartup", status: "completed", exitCode: 0 } } },
    { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
    { id: 4, result: { status: "ready" } }
  ]))).rejects.toThrow("codex-native-code-mode-correlation-invalid");
});

it("returns the bounded correlation proof without using app-server item shapes", async () => {
  const messages = [
    { id: 1, result: { userAgent: "codex" } },
    { id: 2, result: { thread: { id: "thread-1" } } },
    { method: "thread/environment/connected", params: { threadId: "thread-1", environmentId: "remote" } },
    { id: 3, result: { turn: { id: "turn-1" } } },
    { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
    { id: 4, result: { status: "ready" } }
  ] as const;
  const result = await runCodexNativeAppServerModelProbe({
    socket,
    model: "gpt-5.6-luna",
    logicalCwd: "/workspace",
    operation: "pwd",
    timeoutMs: 100
  }, {
    ...dependencies(messages),
    observeRemoteCodeModeEvidence: () => Promise.resolve(completeCorrelationEvidence())
  });
  expect(result.correlationEvidence.remoteProvider.provider).toBe("remote-grpc");
  expect(result.correlationEvidence.execProcess.cwd).toBe("/workspace");
  expect(result.executorHasCredentials).toBe(false);
});
