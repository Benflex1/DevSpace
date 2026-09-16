import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import {
  assertCodexExecServerReady,
  startCodexExecServer,
  stopCodexExecServer,
  type CodexExecServerHandle
} from "./exec-server.js";
import type { CodexProjectExecutorBinding } from "./project-executor.js";
import type { CodexSplitTransportBinding } from "./transport.js";
import { DockerEngineClient, type DockerExecInspection } from "../docker-runtime.js";

const executionNetwork = {
  role: "execution" as const, workspaceId: "018f0f00-0000-7000-8000-000000000002", generation: 1,
  id: "execution-id", name: "execution-network", controlAlias: "codex-control" as const,
  executorAlias: "codex-executor" as const, internal: true as const, defaultRoute: false as const, publishedPorts: [] as const
};

const executor = {
  containerId: "executor-id", containerName: "codex-executor", endpointHost: "codex-executor" as const,
  endpointPort: 4545, controlEgressAttached: false as const,
  policy: {
    artifact: { launcherPath: "/opt/devspace/codex-launcher/codex" },
    executionNetwork,
    workspaceId: executionNetwork.workspaceId, generation: 1, workingDirectory: "/workspace"
  }
} as unknown as CodexProjectExecutorBinding;

const transport: CodexSplitTransportBinding = {
  endpointUrl: "ws://codex-executor:4545", endpointHost: "codex-executor", endpointPort: 4545,
  security: "private-network-only", authenticationEvidence: "absent", credential: null,
  workspaceId: executionNetwork.workspaceId, generation: 1, executionNetworkId: executionNetwork.id
};

function inspection(overrides: Partial<DockerExecInspection> = {}): DockerExecInspection {
  return { ID: "server-exec", Running: true, ExitCode: null, ContainerID: "executor-id", Pid: 123, ...overrides };
}

function dockerFixture(options: {
  readonly serverInspection?: DockerExecInspection;
  readonly readinessInspection?: DockerExecInspection;
} = {}): { readonly docker: DockerEngineClient; readonly calls: unknown[] } {
  const calls: unknown[] = [];
  let execCount = 0;
  const docker = new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override createExec(_containerId: string, input: unknown): Promise<string> {
      calls.push(input);
      execCount += 1;
      return Promise.resolve(execCount === 1 ? "server-exec" : "ready-exec");
    }
    override startExecAttached(): Promise<PassThrough> { return Promise.resolve(new PassThrough()); }
    override inspectExec(execId: string): Promise<DockerExecInspection> {
      return Promise.resolve(execId === "server-exec" ? (options.serverInspection ?? inspection()) : (options.readinessInspection ?? inspection({ ID: "ready-exec", Running: false, ExitCode: 0, Pid: 0 })));
    }
    override stopContainer(id: string): Promise<void> { calls.push(id); return Promise.resolve(); }
  }();
  return { docker, calls };
}

test("starts the verified exec-server only inside the executor", async () => {
  const fixture = dockerFixture();
  const handle = await startCodexExecServer({ docker: fixture.docker, executor, transport });
  expect(handle).toMatchObject({ executorContainerId: "executor-id", execId: "server-exec", serverPid: 123 });
  expect(fixture.calls[0]).toEqual({
    command: ["/opt/devspace/codex-launcher/codex", "exec-server", "--listen", "ws://0.0.0.0:4545"],
    workingDirectory: "/workspace", environment: {}, attachStdin: false, tty: false
  });
});

test("requires an executing server with a stable PID and rejects a stale process", async () => {
  const fixture = dockerFixture({ serverInspection: inspection({ Pid: 0 }) });
  await expect(startCodexExecServer({ docker: fixture.docker, executor, transport })).rejects.toThrow("codex-exec-server-process");
});

test("checks the executor-local readyz endpoint and fails on a non-ready probe", async () => {
  const fixture = dockerFixture({ readinessInspection: inspection({ ID: "ready-exec", Running: false, ExitCode: 7, Pid: 0 }) });
  const handle = await startCodexExecServer({ docker: fixture.docker, executor, transport });
  await expect(assertCodexExecServerReady({ docker: fixture.docker, handle })).rejects.toThrow("codex-exec-server-not-ready");
  const readinessCall = fixture.calls[1] as { readonly command: readonly string[]; readonly workingDirectory: string };
  expect(readinessCall).toMatchObject({ workingDirectory: "/" });
  expect(readinessCall.command[0]).toBe("/bin/sh");
  expect(readinessCall.command[2]).toContain("/readyz");
});

test("rejects an endpoint with the wrong executor identity or control-egress network", async () => {
  await expect(startCodexExecServer({
    docker: dockerFixture().docker, executor,
    transport: { ...transport, endpointUrl: "ws://wrong-host:4545" }
  })).rejects.toThrow("codex-exec-server-endpoint");
  await expect(startCodexExecServer({
    docker: dockerFixture().docker, executor,
    transport: { ...transport, executionNetworkId: "control-egress-id" }
  })).rejects.toThrow("codex-exec-server-network");
});

test("stops only the executor container that owns the server", async () => {
  const fixture = dockerFixture();
  const handle: CodexExecServerHandle = { executorContainerId: "executor-id", execId: "server-exec", endpoint: transport, serverPid: 123 };
  await stopCodexExecServer({ docker: fixture.docker, handle });
  expect(fixture.calls).toEqual(["executor-id"]);
});
