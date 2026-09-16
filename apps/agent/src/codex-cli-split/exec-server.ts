import type { Duplex } from "node:stream";
import {
  DockerEngineClient,
  type DockerExecInspection
} from "../docker-runtime.js";
import { codexCommand } from "./artifact.js";
import type { CodexProjectExecutorBinding } from "./project-executor.js";
import type { CodexSplitTransportBinding } from "./transport.js";

function readyProbe(port: number): readonly string[] {
  return [
    "/bin/sh", "-c",
    "if command -v curl >/dev/null 2>&1; then exec curl --fail --silent --show-error http://127.0.0.1:$1/readyz; "
      + "elif command -v wget >/dev/null 2>&1; then exec wget --quiet --output-document=- http://127.0.0.1:$1/readyz; "
      + "else exit 127; fi",
    "devspace-codex-readyz", String(port)
  ];
}

export interface CodexExecServerHandle {
  readonly executorContainerId: string;
  readonly execId: string;
  readonly endpoint: CodexSplitTransportBinding;
  readonly serverPid: number;
}

function listenUrl(endpoint: CodexSplitTransportBinding): string {
  return `ws://0.0.0.0:${endpoint.endpointPort}`;
}

function assertServerEndpoint(executor: CodexProjectExecutorBinding, transport: CodexSplitTransportBinding): void {
  if (transport.endpointHost !== "codex-executor"
    || transport.endpointUrl !== `ws://codex-executor:${executor.endpointPort}`
    || transport.endpointPort !== executor.endpointPort) {
    throw new Error("codex-exec-server-endpoint");
  }
}

function assertServerNetwork(executor: CodexProjectExecutorBinding, transport: CodexSplitTransportBinding): void {
  if (transport.executionNetworkId !== executor.policy.executionNetwork.id
    || transport.workspaceId !== executor.policy.workspaceId
    || transport.generation !== executor.policy.generation
    || executor.controlEgressAttached) {
    throw new Error("codex-exec-server-network");
  }
}

function assertServerInspection(
  inspection: DockerExecInspection,
  executor: CodexProjectExecutorBinding,
  execId: string,
  expectedPid?: number
): number {
  if (inspection.ID !== execId || inspection.ContainerID !== executor.containerId || !inspection.Running
    || inspection.ExitCode !== null || inspection.Pid === undefined || !Number.isSafeInteger(inspection.Pid) || inspection.Pid < 1
    || (expectedPid !== undefined && inspection.Pid !== expectedPid)) {
    throw new Error("codex-exec-server-process");
  }
  return inspection.Pid;
}

function discardStream(stream: Duplex): void {
  stream.on("error", () => undefined);
  stream.resume();
}

export async function startCodexExecServer(input: {
  readonly docker: DockerEngineClient;
  readonly executor: CodexProjectExecutorBinding;
  readonly transport: CodexSplitTransportBinding;
}): Promise<CodexExecServerHandle> {
  assertServerEndpoint(input.executor, input.transport);
  assertServerNetwork(input.executor, input.transport);
  const command = codexCommand(input.executor.policy.artifact, ["exec-server", "--listen", listenUrl(input.transport)]);
  const execId = await input.docker.createExec(input.executor.containerId, {
    command, workingDirectory: input.executor.policy.workingDirectory, environment: {}, attachStdin: false, tty: false
  });
  let stream: Duplex;
  try {
    stream = await input.docker.startExecAttached(execId, false);
    discardStream(stream);
    const inspection = await input.docker.inspectExec(execId);
    const serverPid = assertServerInspection(inspection, input.executor, execId);
    return { executorContainerId: input.executor.containerId, execId, endpoint: input.transport, serverPid };
  } catch (error) {
    throw new Error("codex-exec-server-process", { cause: error });
  }
}

function processServerPid(input: {
  readonly titles: readonly string[];
  readonly processes: readonly (readonly string[])[];
}): number {
  const pidIndex = input.titles.findIndex((title) => title.toLowerCase() === "pid");
  const argsIndex = input.titles.findIndex((title) => ["args", "cmd", "command"].includes(title.toLowerCase()));
  if (pidIndex < 0 || argsIndex < 0) throw new Error("codex-exec-server-process");
  const candidates = input.processes.filter((row) => (row[argsIndex] ?? "").includes("exec-server"));
  if (candidates.length !== 1) throw new Error("codex-exec-server-process");
  const pid = Number(candidates[0]![pidIndex]);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("codex-exec-server-process");
  return pid;
}

async function runReadyProbe(input: {
  readonly docker: DockerEngineClient;
  readonly executor: CodexProjectExecutorBinding;
  readonly transport: CodexSplitTransportBinding;
}): Promise<void> {
  const probeId = await input.docker.createExec(input.executor.containerId, {
    command: readyProbe(input.transport.endpointPort), workingDirectory: "/", environment: {}, attachStdin: false, tty: false
  });
  const stream = await input.docker.startExecAttached(probeId, false);
  discardStream(stream);
  const inspection = await input.docker.inspectExec(probeId).catch((error) => {
    stream.destroy();
    throw new Error("codex-exec-server-not-ready", { cause: error });
  });
  stream.destroy();
  if (inspection.ID !== probeId || inspection.ContainerID !== input.executor.containerId
    || inspection.Running || inspection.ExitCode !== 0) {
    throw new Error("codex-exec-server-not-ready");
  }
}

/** Revalidates an existing executor-side server after Agent restart without creating a second server. */
export async function probeCodexExecServerReady(input: {
  readonly docker: DockerEngineClient;
  readonly executor: CodexProjectExecutorBinding;
  readonly transport: CodexSplitTransportBinding;
}): Promise<number> {
  assertServerEndpoint(input.executor, input.transport);
  assertServerNetwork(input.executor, input.transport);
  const processes = await input.docker.topContainer(input.executor.containerId, "pid,args");
  const serverPid = processServerPid(processes);
  await runReadyProbe(input);
  return serverPid;
}

export async function assertCodexExecServerReady(input: {
  readonly docker: DockerEngineClient;
  readonly handle: CodexExecServerHandle;
}): Promise<void> {
  const serverInspection = await input.docker.inspectExec(input.handle.execId);
  assertServerInspection(serverInspection, {
    containerId: input.handle.executorContainerId,
    policy: { workingDirectory: "/workspace" }
  } as CodexProjectExecutorBinding, input.handle.execId, input.handle.serverPid);
  await runReadyProbe({
    docker: input.docker,
    executor: {
      containerId: input.handle.executorContainerId,
      policy: { workingDirectory: "/workspace", endpointPort: input.handle.endpoint.endpointPort,
        workspaceId: input.handle.endpoint.workspaceId, generation: input.handle.endpoint.generation,
        executionNetwork: { id: input.handle.endpoint.executionNetworkId } }
    } as CodexProjectExecutorBinding,
    transport: input.handle.endpoint
  });
}

export async function stopCodexExecServer(input: {
  readonly docker: DockerEngineClient;
  readonly handle: CodexExecServerHandle;
}): Promise<void> {
  const inspection = await input.docker.inspectExec(input.handle.execId).catch(() => null);
  if (inspection !== null && inspection.ContainerID !== input.handle.executorContainerId) {
    throw new Error("codex-exec-server-identity");
  }
  await input.docker.stopContainer(input.handle.executorContainerId);
}
