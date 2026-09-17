import type { Duplex } from "node:stream";
import { DockerEngineClient, type DockerExecInspection } from "../docker-runtime.js";
import {
  type CodexProjectExecutorBinding
} from "./project-executor.js";
import type { CodexSplitArtifactCapabilities } from "./artifact.js";

const READY_DEADLINE_MS = 10_000;
const READY_POLL_INTERVAL_MS = 50;
const CODE_MODE_HOST_NAME = "codex-code-mode-host" as const;
const CODE_MODE_HOST_LISTEN_HOST = "0.0.0.0" as const;

export interface CodexCodeModeHostEndpoint {
  readonly host: "codex-code-mode-host";
  readonly port: number;
  readonly url: string;
  readonly listenUrl: string;
  readonly networkId: string;
}

export interface CodexCodeModeHostPolicy {
  readonly executorContainerId: string;
  readonly executionNetworkId: string;
  readonly artifact: CodexSplitArtifactCapabilities;
  readonly endpoint: CodexCodeModeHostEndpoint;
  readonly command: readonly [string, "--listen", string];
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: "/workspace";
  readonly credentialsPresent: false;
  readonly controlEgressAttached: false;
}

export interface CodexCodeModeHostHandle {
  readonly executorContainerId: string;
  readonly execId: string;
  readonly endpoint: CodexCodeModeHostEndpoint;
  readonly serverPid: number;
  readonly transportSecurity: "protocol-authenticated" | "private-network-only";
}

interface TimingOptions {
  readonly deadlineMs: number;
  readonly pollIntervalMs: number;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

function stageError(reason: string, cause?: unknown): Error {
  return cause === undefined ? new Error(reason) : new Error(reason, { cause });
}

function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("codex-code-mode-host-port");
}

function assertEndpoint(endpoint: CodexCodeModeHostEndpoint, expectedNetworkId: string, expectedPort: number): void {
  assertPort(endpoint.port);
  if (endpoint.host !== CODE_MODE_HOST_NAME
    || endpoint.port !== expectedPort
    || endpoint.networkId !== expectedNetworkId
    || endpoint.url !== `http://${CODE_MODE_HOST_NAME}:${endpoint.port}`
    || endpoint.listenUrl !== `grpc://${CODE_MODE_HOST_LISTEN_HOST}:${endpoint.port}`) {
    throw new Error("codex-code-mode-host-network");
  }
}

function assertArtifact(artifact: CodexSplitArtifactCapabilities): void {
  if (artifact.execServerCapability !== "codex-0.153.4-exec-server"
    || artifact.appServerCapability !== "codex-0.153.4-app-server"
    || artifact.codeModeHostCapability !== "codex-0.153.4-code-mode-host"
    || artifact.codeModeHostPath !== "/opt/devspace/codex/bin/codex-code-mode-host"
    || artifact.nativeCliPath !== "/opt/devspace/codex/bin/codex"
    || !/^[0-9a-f]{64}$/u.test(artifact.closureDigest)) {
    throw new Error("codex-code-mode-host-helper");
  }
}

function assertEnvironment(environment: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name) || value.includes("\0")
      || name === "CODEX_HOME" || name === "HOME" || name.startsWith("OPENAI_")
      || name.startsWith("CODEX_") || name.includes("TOKEN") || name.includes("KEY")) {
      throw new Error("codex-code-mode-host-credentials");
    }
  }
}

function assertPolicy(policy: CodexCodeModeHostPolicy): void {
  assertArtifact(policy.artifact);
  if (policy.executorContainerId.length === 0
    || policy.executionNetworkId.length === 0
    || policy.workingDirectory !== "/workspace"
    || policy.command.length !== 3
    || policy.command[0] !== policy.artifact.codeModeHostPath
    || policy.command[1] !== "--listen"
    || policy.command[2] !== policy.endpoint.listenUrl) {
    throw new Error("codex-code-mode-host-policy");
  }
  if (policy.credentialsPresent !== false) throw new Error("codex-code-mode-host-credentials");
  if (policy.controlEgressAttached !== false) throw new Error("codex-code-mode-host-network");
  assertEndpoint(policy.endpoint, policy.executionNetworkId, policy.endpoint.port);
  assertEnvironment(policy.environment);
}

export function buildCodexCodeModeHostPolicy(input: {
  readonly executor: Pick<CodexProjectExecutorBinding, "containerId" | "policy">;
  readonly artifact: CodexSplitArtifactCapabilities;
  readonly port?: number;
}): CodexCodeModeHostPolicy {
  const port = input.port ?? input.executor.policy.codeModeHostPort;
  assertPort(port);
  if (port === input.executor.policy.endpointPort) throw new Error("codex-code-mode-host-port");
  assertArtifact(input.artifact);
  const endpoint: CodexCodeModeHostEndpoint = {
    host: CODE_MODE_HOST_NAME,
    port,
    url: `http://${CODE_MODE_HOST_NAME}:${port}`,
    listenUrl: `grpc://${CODE_MODE_HOST_LISTEN_HOST}:${port}`,
    networkId: input.executor.policy.executionNetwork.id
  };
  const result: CodexCodeModeHostPolicy = {
    executorContainerId: input.executor.containerId,
    executionNetworkId: input.executor.policy.executionNetwork.id,
    artifact: input.artifact,
    endpoint,
    command: [input.artifact.codeModeHostPath, "--listen", endpoint.listenUrl],
    environment: {},
    workingDirectory: "/workspace",
    credentialsPresent: false,
    controlEgressAttached: false
  };
  assertPolicy(result);
  return result;
}

function discardStream(stream: Duplex): void {
  stream.on("error", () => undefined);
  stream.resume();
}

function assertHostInspection(
  inspection: DockerExecInspection,
  policy: CodexCodeModeHostPolicy,
  execId: string,
  expectedPid?: number
): number {
  if (inspection.ID !== execId || inspection.ContainerID !== policy.executorContainerId) {
    throw new Error("codex-code-mode-host-process");
  }
  if (!inspection.Running || inspection.ExitCode !== null
    || inspection.Pid === undefined || !Number.isSafeInteger(inspection.Pid) || inspection.Pid < 1
    || (expectedPid !== undefined && inspection.Pid !== expectedPid)) {
    if (!inspection.Running && inspection.ExitCode !== null) {
      throw new Error("codex-code-mode-host-exited-before-ready");
    }
    throw new Error("codex-code-mode-host-process");
  }
  return inspection.Pid;
}

function timing(input: {
  readonly deadlineMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): TimingOptions {
  const deadlineMs = input.deadlineMs ?? READY_DEADLINE_MS;
  const pollIntervalMs = input.pollIntervalMs ?? READY_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 5_000) {
    throw new Error("codex-code-mode-host-readiness-options");
  }
  return {
    deadlineMs,
    pollIntervalMs,
    now: input.now ?? Date.now,
    sleep: input.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  };
}

function readinessProbe(port: number): readonly string[] {
  return [
    "/bin/sh", "-c",
    "if command -v curl >/dev/null 2>&1; then exec curl --fail --silent --show-error --http2-prior-knowledge "
      + "-H 'content-type: application/grpc' -H 'te: trailers' --data-binary "
      + "$(printf '\\000\\000\\000\\000\\000') http://127.0.0.1:$1/grpc.health.v1.Health/Check >/dev/null; "
      + "else exit 127; fi",
    "devspace-codex-code-mode-ready", String(port)
  ];
}

function assertProbeInspection(inspection: DockerExecInspection, executorContainerId: string, probeId: string): void {
  if (inspection.ID !== probeId || inspection.ContainerID !== executorContainerId
    || (inspection.Running && inspection.ExitCode !== null)
    || (!inspection.Running && inspection.ExitCode === null)) {
    throw new Error("codex-code-mode-host-probe");
  }
}

async function assertHandle(input: {
  readonly docker: DockerEngineClient;
  readonly handle: CodexCodeModeHostHandle;
  readonly policy: CodexCodeModeHostPolicy;
}): Promise<DockerExecInspection> {
  assertPolicy(input.policy);
  if (input.handle.executorContainerId !== input.policy.executorContainerId
    || input.handle.endpoint.host !== input.policy.endpoint.host
    || input.handle.endpoint.port !== input.policy.endpoint.port
    || input.handle.endpoint.url !== input.policy.endpoint.url
    || input.handle.endpoint.listenUrl !== input.policy.endpoint.listenUrl
    || input.handle.endpoint.networkId !== input.policy.endpoint.networkId
    || input.handle.transportSecurity === "protocol-authenticated") {
    throw new Error("codex-code-mode-host-identity");
  }
  let inspection: DockerExecInspection;
  try {
    inspection = await input.docker.inspectExec(input.handle.execId);
  } catch (error) {
    throw stageError("codex-code-mode-host-process", error);
  }
  assertHostInspection(inspection, input.policy, input.handle.execId, input.handle.serverPid);
  return inspection;
}

export async function startCodexCodeModeHost(input: {
  readonly docker: DockerEngineClient;
  readonly policy: CodexCodeModeHostPolicy;
}): Promise<CodexCodeModeHostHandle> {
  assertPolicy(input.policy);
  let execId: string;
  try {
    execId = await input.docker.createExec(input.policy.executorContainerId, {
      command: input.policy.command,
      workingDirectory: input.policy.workingDirectory,
      environment: input.policy.environment,
      attachStdin: false,
      tty: false
    });
  } catch (error) {
    throw stageError("codex-code-mode-host-exec-create", error);
  }
  let stream: Duplex;
  try {
    stream = await input.docker.startExecAttached(execId, false);
    discardStream(stream);
  } catch (error) {
    throw stageError("codex-code-mode-host-attach", error);
  }
  try {
    const inspection = await input.docker.inspectExec(execId);
    const serverPid = assertHostInspection(inspection, input.policy, execId);
    return {
      executorContainerId: input.policy.executorContainerId,
      execId,
      endpoint: input.policy.endpoint,
      serverPid,
      transportSecurity: "private-network-only"
    };
  } catch (error) {
    if (error instanceof Error && ["codex-code-mode-host-process", "codex-code-mode-host-exited-before-ready"].includes(error.message)) {
      throw error;
    }
    throw stageError("codex-code-mode-host-process", error);
  }
}

async function runReadyProbeAttempt(input: {
  readonly docker: DockerEngineClient;
  readonly handle: CodexCodeModeHostHandle;
  readonly timing: TimingOptions;
  readonly deadline: number;
}): Promise<boolean> {
  let probeId: string;
  try {
    probeId = await input.docker.createExec(input.handle.executorContainerId, {
      command: readinessProbe(input.handle.endpoint.port), workingDirectory: "/", environment: {}, attachStdin: false, tty: false
    });
  } catch (error) {
    throw stageError("codex-code-mode-host-probe", error);
  }
  let stream: Duplex | undefined;
  try {
    stream = await input.docker.startExecAttached(probeId, false);
    discardStream(stream);
    for (;;) {
      let inspection: DockerExecInspection;
      try {
        inspection = await input.docker.inspectExec(probeId);
      } catch (error) {
        throw stageError("codex-code-mode-host-probe", error);
      }
      assertProbeInspection(inspection, input.handle.executorContainerId, probeId);
      if (!inspection.Running) return inspection.ExitCode === 0;
      const remaining = input.deadline - input.timing.now();
      if (remaining <= 0) return false;
      await input.timing.sleep(Math.min(input.timing.pollIntervalMs, remaining));
    }
  } finally {
    stream?.destroy();
  }
}

export async function probeCodexCodeModeHostReady(input: {
  readonly docker: DockerEngineClient;
  readonly handle: CodexCodeModeHostHandle;
  readonly deadlineMs: number;
  readonly pollIntervalMs: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const options = timing(input);
  const policy = {
    executorContainerId: input.handle.executorContainerId,
    executionNetworkId: input.handle.endpoint.networkId,
    artifact: {
      nativeCliPath: "/opt/devspace/codex/bin/codex",
      execServerCapability: "codex-0.153.4-exec-server" as const,
      appServerCapability: "codex-0.153.4-app-server" as const,
      codeModeHostPath: "/opt/devspace/codex/bin/codex-code-mode-host",
      codeModeHostCapability: "codex-0.153.4-code-mode-host" as const,
      closureDigest: "0".repeat(64)
    },
    endpoint: input.handle.endpoint,
    command: ["/opt/devspace/codex/bin/codex-code-mode-host", "--listen", input.handle.endpoint.listenUrl] as const,
    environment: {},
    workingDirectory: "/workspace" as const,
    credentialsPresent: false as const,
    controlEgressAttached: false as const
  } satisfies CodexCodeModeHostPolicy;
  if (input.handle.transportSecurity !== "private-network-only") throw new Error("codex-code-mode-host-transport");
  assertEndpoint(input.handle.endpoint, input.handle.endpoint.networkId, input.handle.endpoint.port);
  const deadline = options.now() + options.deadlineMs;
  for (;;) {
    let inspection: DockerExecInspection;
    try {
      inspection = await input.docker.inspectExec(input.handle.execId);
    } catch (error) {
      throw stageError("codex-code-mode-host-process", error);
    }
    assertHostInspection(inspection, policy, input.handle.execId, input.handle.serverPid);
    if (await runReadyProbeAttempt({ docker: input.docker, handle: input.handle, timing: options, deadline })) return;
    const remaining = deadline - options.now();
    if (remaining <= 0) break;
    await options.sleep(Math.min(options.pollIntervalMs, remaining));
  }
  throw new Error("codex-code-mode-host-not-ready");
}

export async function assertCodexCodeModeHostReady(input: {
  readonly docker: DockerEngineClient;
  readonly handle: CodexCodeModeHostHandle;
  readonly policy: CodexCodeModeHostPolicy;
}): Promise<void> {
  await assertHandle(input);
  await probeCodexCodeModeHostReady({
    docker: input.docker,
    handle: input.handle,
    deadlineMs: READY_DEADLINE_MS,
    pollIntervalMs: READY_POLL_INTERVAL_MS
  });
}

export async function reattachCodexCodeModeHost(input: {
  readonly docker: DockerEngineClient;
  readonly handle: CodexCodeModeHostHandle;
  readonly policy: CodexCodeModeHostPolicy;
}): Promise<void> {
  await assertCodexCodeModeHostReady(input);
}
