import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCodexNativeAppServerProbeSocket,
  buildCodexNativeAppServerProbeSocket,
  runCodexNativeAppServerModelProbe,
  type CodexNativeAppServerModelProbeDependencies,
  type CodexNativeAppServerProbeConnection
} from "./codex-native-app-server-probe.js";
import { ensureNativeCodexHome, type CodexNativeHomeBinding } from "../src/codex-cli-split/native-home.js";
import { lstatIdentity } from "../src/private-state.js";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function homeFixture(): Promise<CodexNativeHomeBinding> {
  const root = await mkdtemp(path.join(os.tmpdir(), "devspace-codex-model-probe-"));
  temporaryDirectories.push(root);
  return ensureNativeCodexHome({
    homePath: path.join(root, "native-home"),
    ownerUid: process.getuid?.() ?? 0,
    ownerGid: process.getgid?.() ?? 0
  });
}

async function socketFixture(home: CodexNativeHomeBinding): Promise<{ readonly socketPath: string; readonly close: () => Promise<void> }> {
  const socketPath = path.join(home.homePath, "app-server-control", "app-server-control.sock");
  await mkdir(path.dirname(socketPath), { mode: 0o700 });
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { socketPath, close: async () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function connection(messages: readonly Readonly<Record<string, unknown>>[]): CodexNativeAppServerProbeConnection {
  const queue = [...messages];
  return {
    send(): Promise<void> { return Promise.resolve(); },
    receive(): Promise<Readonly<Record<string, unknown>>> {
      const message = queue.shift();
      return message === undefined ? Promise.reject(new Error("probe-test-message-exhausted")) : Promise.resolve(message);
    },
    close(): Promise<void> { return Promise.resolve(); }
  };
}

function dependencies(messages: readonly Readonly<Record<string, unknown>>[], overrides: Partial<CodexNativeAppServerModelProbeDependencies> = {}): CodexNativeAppServerModelProbeDependencies {
  return {
    connect: () => Promise.resolve(connection(messages)),
    inspectControl: () => Promise.resolve({ projectProcessCount: 0, appServerProcessCount: 1 }),
    inspectExecutor: () => Promise.resolve({
      projectProcessCount: 1,
      codeModeHostProcessCount: 1,
      execServerProcessCount: 1,
      hasNativeHome: false
    }),
    now: () => 0,
    sleep: () => Promise.resolve(),
    ...overrides
  };
}

async function validSocket(): Promise<{ readonly home: CodexNativeHomeBinding; readonly socket: Awaited<ReturnType<typeof buildCodexNativeAppServerProbeSocket>> }> {
  const home = await homeFixture();
  await socketFixture(home);
  return { home, socket: buildCodexNativeAppServerProbeSocket(home) };
}

const protocolPreamble = [
  { id: 1, result: { userAgent: "codex" } },
  { id: 2, result: { thread: { id: "thread-1" } } },
  { method: "thread/environment/connected", params: { threadId: "thread-1", environmentId: "remote" } },
  { id: 3, result: { turn: { id: "turn-1" } } },
  { method: "item/started", params: { item: { id: "code-mode-1", type: "dynamicToolCall", namespace: "code_mode", tool: "execute", status: "inProgress", arguments: {} } } },
  { method: "item/started", params: { item: { id: "command-1", type: "commandExecution", command: "pwd", cwd: "/workspace", status: "inProgress", commandActions: [], source: "unifiedExecStartup" } } },
  { method: "item/completed", params: { item: { id: "command-1", type: "commandExecution", command: "pwd", cwd: "/workspace", status: "completed", exitCode: 0, commandActions: [], source: "unifiedExecStartup" } } },
  { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } }
];

const functionCallCodeModeProtocolPreamble = [
  { id: 1, result: { userAgent: "codex" } },
  { id: 2, result: { thread: { id: "thread-1" } } },
  { method: "thread/environment/connected", params: { threadId: "thread-1", environmentId: "remote" } },
  { id: 3, result: { turn: { id: "turn-1" } } },
  { method: "item/completed", params: { item: { id: "code-mode-1", type: "functionCallOutput", name: "exec", namespace: null, output: { type: "text", text: "bounded" } } } },
  { method: "item/started", params: { item: { id: "command-1", type: "commandExecution", command: "pwd", cwd: "/workspace", status: "inProgress", commandActions: [], source: "unifiedExecStartup" } } },
  { method: "item/completed", params: { item: { id: "command-1", type: "commandExecution", command: "pwd", cwd: "/workspace", status: "completed", exitCode: 0, commandActions: [], source: "unifiedExecStartup" } } },
  { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } }
];

const functionCallStartedCodeModeProtocolPreamble = [
  { id: 1, result: { userAgent: "codex" } },
  { id: 2, result: { thread: { id: "thread-1" } } },
  { method: "thread/environment/connected", params: { threadId: "thread-1", environmentId: "remote" } },
  { id: 3, result: { turn: { id: "turn-1" } } },
  { method: "item/started", params: { item: { id: "code-mode-1", type: "functionCall", name: "exec", arguments: "{}", status: "inProgress" } } },
  { method: "item/started", params: { item: { id: "command-1", type: "commandExecution", command: "pwd", cwd: "/workspace", status: "inProgress", commandActions: [], source: "unifiedExecStartup" } } },
  { method: "item/completed", params: { item: { id: "command-1", type: "commandExecution", command: "pwd", cwd: "/workspace", status: "completed", exitCode: 0, commandActions: [], source: "unifiedExecStartup" } } },
  { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } }
];

describe("Codex native app-server model probe", () => {
  it("maps the logical socket to the owned Agent-visible socket and inode", async () => {
    const { home, socket } = await validSocket();
    expect(socket.logicalPath).toBe("/codex-home/app-server-control/app-server-control.sock");
    expect(path.isAbsolute(socket.agentSocketPath)).toBe(true);
    expect(socket.agentSocketPath).toBe(path.join(home.homePath, "app-server-control/app-server-control.sock"));
    expect(socket.homeIdentity).toEqual(home.identity);
    expect(socket.socketIdentity).toEqual((await lstatIdentity(socket.agentSocketPath))!.identity);
    expect(() => assertCodexNativeAppServerProbeSocket({
      home, socket, expectedHomeIdentity: home.identity, expectedSocketIdentity: socket.socketIdentity
    })).not.toThrow();
  });

  it.each([
    ["host path outside owned home", (_home: CodexNativeHomeBinding, socket: Awaited<ReturnType<typeof buildCodexNativeAppServerProbeSocket>>) => ({ ...socket, agentSocketPath: "/tmp/foreign.sock" })],
    ["symlink/path substitution", (home: CodexNativeHomeBinding, socket: Awaited<ReturnType<typeof buildCodexNativeAppServerProbeSocket>>) => ({ ...socket, agentSocketPath: path.join(home.homePath, "app-server-control", "..", "app-server-control.sock") })],
    ["mismatched home identity", (_home: CodexNativeHomeBinding, socket: Awaited<ReturnType<typeof buildCodexNativeAppServerProbeSocket>>) => ({ ...socket, homeIdentity: { device: "999", inode: "999" } })],
    ["mismatched socket identity", (_home: CodexNativeHomeBinding, socket: Awaited<ReturnType<typeof buildCodexNativeAppServerProbeSocket>>) => ({ ...socket, socketIdentity: { device: "999", inode: "999" } })]
  ] as const)("rejects %s", async (_name, mutate) => {
    const { home, socket } = await validSocket();
    expect(() => assertCodexNativeAppServerProbeSocket({
      home, socket: mutate(home, socket), expectedHomeIdentity: home.identity, expectedSocketIdentity: socket.socketIdentity
    })).toThrow();
  });

  it("rejects a missing or stale socket", async () => {
    const home = await homeFixture();
    expect(() => buildCodexNativeAppServerProbeSocket(home)).toThrow("codex-model-probe-socket-missing");
  });

  it("rejects a non-Astra model before connecting", async () => {
    const { socket } = await validSocket();
    await expect(runCodexNativeAppServerModelProbe({
      socket, model: "gpt-5" as never, logicalCwd: "/workspace", operation: "pwd", timeoutMs: 100
    }, dependencies(protocolPreamble))).rejects.toThrow("codex-model-probe-model");
  });

  it("uses pinned-model-metadata-plus-runtime when the protocol has no ToolMode field", async () => {
    const { socket } = await validSocket();
    const result = await runCodexNativeAppServerModelProbe({
      socket, model: "gpt-6-astra", logicalCwd: "/workspace", operation: "pwd", timeoutMs: 100
    }, dependencies(protocolPreamble));
    expect(result.toolModeEvidence).toEqual({
      kind: "pinned-model-metadata-plus-runtime", model: "gpt-6-astra", remoteCodeModeObserved: true
    });
    expect(result.remoteCodeModeObserved).toBe(true);
    expect(result.nestedProjectExecObserved).toBe(true);
  });

  it("accepts the admitted Luna CodeModeOnly model identity", async () => {
    const { socket } = await validSocket();
    const result = await runCodexNativeAppServerModelProbe({
      socket, model: "gpt-5.6-luna", logicalCwd: "/workspace", operation: "pwd", timeoutMs: 100
    }, dependencies(functionCallCodeModeProtocolPreamble));
    expect(result.model).toBe("gpt-5.6-luna");
    expect(result.toolModeEvidence).toEqual({
      kind: "pinned-model-metadata-plus-runtime", model: "gpt-5.6-luna", remoteCodeModeObserved: true
    });
  });

  it("recognizes the native Code Mode exec function output without a ToolMode field", async () => {
    const { socket } = await validSocket();
    const result = await runCodexNativeAppServerModelProbe({
      socket, model: "gpt-6-astra", logicalCwd: "/workspace", operation: "pwd", timeoutMs: 100
    }, dependencies(functionCallCodeModeProtocolPreamble));
    expect(result.remoteCodeModeObserved).toBe(true);
  });

  it("recognizes the native Code Mode exec function call without a ToolMode field", async () => {
    const { socket } = await validSocket();
    const result = await runCodexNativeAppServerModelProbe({
      socket, model: "gpt-5.6-luna", logicalCwd: "/workspace", operation: "pwd", timeoutMs: 100
    }, dependencies(functionCallStartedCodeModeProtocolPreamble));
    expect(result.remoteCodeModeObserved).toBe(true);
  });

  it("stops without approving a server approval request", async () => {
    const { socket } = await validSocket();
    await expect(runCodexNativeAppServerModelProbe({
      socket, model: "gpt-6-astra", logicalCwd: "/workspace", operation: "pwd", timeoutMs: 100
    }, dependencies([
      { id: 1, result: {} },
      { id: 2, result: { thread: { id: "thread-1" } } },
      { id: 3, result: { turn: { id: "turn-1" } } },
      { id: "approval-1", method: "item/commandExecution/requestApproval", params: {} }
    ]))).rejects.toThrow("approval-required-for-model-compatibility-probe");
  });

  it("rejects incomplete executor evidence and control project processes", async () => {
    const { socket } = await validSocket();
    await expect(runCodexNativeAppServerModelProbe({
      socket, model: "gpt-6-astra", logicalCwd: "/workspace", operation: "pwd", timeoutMs: 100
    }, dependencies(protocolPreamble, {
      inspectControl: () => Promise.resolve({ projectProcessCount: 1, appServerProcessCount: 1 })
    }))).rejects.toThrow("codex-model-probe-control-project-process");
    await expect(runCodexNativeAppServerModelProbe({
      socket, model: "gpt-6-astra", logicalCwd: "/workspace", operation: "pwd", timeoutMs: 100
    }, dependencies(protocolPreamble, {
      inspectExecutor: () => Promise.resolve({ projectProcessCount: 0, codeModeHostProcessCount: 1, execServerProcessCount: 1, hasNativeHome: false })
    }))).rejects.toThrow("codex-model-probe-executor-project-process");
  });

  it("returns bounded proof fields without transcript, credentials, or approval decisions", async () => {
    const { socket } = await validSocket();
    const result = await runCodexNativeAppServerModelProbe({
      socket, model: "gpt-6-astra", logicalCwd: "/workspace", operation: "pwd", timeoutMs: 100
    }, dependencies(protocolPreamble));
    expect(JSON.stringify(result)).not.toContain("pwd\n");
    expect(JSON.stringify(result)).not.toContain("token");
    expect(JSON.stringify(result)).not.toContain("approvalId");
    expect(result).not.toHaveProperty("transcript");
    expect(result).not.toHaveProperty("modelOutput");
  });
});
