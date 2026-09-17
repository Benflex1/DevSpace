import { unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  DockerEngineClient,
  type DockerExecInspection
} from "../docker-runtime.js";
import {
  assertContained,
  establishPinnedDirectory,
  identitiesEqual,
  lstatIdentity,
  type FileIdentity
} from "../private-state.js";
import type { CodexControlSidecarPolicy } from "./control-sidecar.js";
import type { CodexSplitArtifactCapabilities } from "./artifact.js";
import type { CodexCodeModeHostEndpoint } from "./code-mode-host.js";

export const APP_SERVER_CONTROL_SOCKET_PATH = "/codex-home/app-server-control/app-server-control.sock" as const;
const APP_SERVER_SOCKET_RELATIVE_PATH = "app-server-control/app-server-control.sock" as const;
const APP_SERVER_READY_DEADLINE_MS = 10_000;
const APP_SERVER_READY_POLL_INTERVAL_MS = 50;
const APP_SERVER_EXECUTABLE_PATH = "/opt/devspace/codex-launcher/codex" as const;

export interface CodexNativeAppServerPolicy {
  readonly controlContainerId: string;
  readonly controlHomePath: string;
  readonly executablePath: string;
  readonly command: readonly [string, "app-server", "--listen", "unix://", "--code-mode-host", string];
  readonly socketPath: typeof APP_SERVER_CONTROL_SOCKET_PATH;
  readonly codeModeHostUrl: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: "/workspace";
  readonly homeIdentity: string;
  readonly projectMounts: readonly [];
  readonly gitMounts: readonly [];
}

export interface CodexNativeAppServerHandle {
  readonly controlContainerId: string;
  readonly execId: string;
  readonly serverPid: number;
  readonly socketPath: typeof APP_SERVER_CONTROL_SOCKET_PATH;
  readonly socketIdentity: FileIdentity;
  readonly homeIdentity: string;
  readonly codeModeHostUrl: string;
  readonly transportSecurity: "protocol-authenticated" | "private-network-only";
}

interface TimingOptions {
  readonly deadlineMs: number;
  readonly pollIntervalMs: number;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

function homeIdentity(identity: FileIdentity): string {
  return `${identity.device}:${identity.inode}`;
}

export function nativeAppServerAgentSocketPath(homePath: string): string {
  if (!path.isAbsolute(homePath) || homePath.includes("\0")) throw new Error("codex-app-server-home-path");
  return assertContained(homePath, path.join(homePath, APP_SERVER_SOCKET_RELATIVE_PATH));
}

function assertCodeModeHostEndpoint(endpoint: CodexCodeModeHostEndpoint, expectedUrl: string): void {
  if (endpoint.host !== "codex-code-mode-host"
    || endpoint.url !== expectedUrl
    || endpoint.listenUrl !== `grpc://0.0.0.0:${endpoint.port}`
    || !Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
    throw new Error("codex-app-server-code-mode-host");
  }
}

function assertPolicy(policy: CodexNativeAppServerPolicy): void {
  if (policy.controlContainerId.length === 0
    || policy.controlHomePath.length === 0
    || !path.isAbsolute(policy.controlHomePath)
    || policy.executablePath !== APP_SERVER_EXECUTABLE_PATH
    || policy.socketPath !== APP_SERVER_CONTROL_SOCKET_PATH
    || policy.workingDirectory !== "/workspace"
    || policy.projectMounts.length !== 0
    || policy.gitMounts.length !== 0
    || !/^[0-9]+:[0-9]+$/u.test(policy.homeIdentity)
    || policy.command.length !== 6
    || policy.command[0] !== policy.executablePath
    || policy.command[1] !== "app-server"
    || policy.command[2] !== "--listen"
    || policy.command[3] !== "unix://"
    || policy.command[4] !== "--code-mode-host"
    || policy.command[5] !== policy.codeModeHostUrl) {
    throw new Error("codex-app-server-policy");
  }
  let parsed: URL;
  try { parsed = new URL(policy.codeModeHostUrl); }
  catch { throw new Error("codex-app-server-code-mode-host"); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "codex-code-mode-host" || !parsed.port
    || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("codex-app-server-code-mode-host");
  }
}

export function buildCodexNativeAppServerPolicy(input: {
  readonly control: CodexControlSidecarPolicy;
  readonly artifact: CodexSplitArtifactCapabilities;
  readonly codeModeHost: CodexCodeModeHostEndpoint;
}): CodexNativeAppServerPolicy {
  const controlWithContainer = input.control as CodexControlSidecarPolicy & { readonly containerId?: string };
  const controlContainerId = controlWithContainer.containerId ?? "";
  const expectedUrl = input.codeModeHost.url;
  if (input.artifact.appServerCapability !== "codex-0.153.4-app-server"
    || input.artifact.nativeCliPath !== "/opt/devspace/codex/bin/codex"
    || input.control.remote.codeMode.enabled !== true
    || input.control.remote.codeMode.hostEnabled !== true
    || input.control.remote.codeMode.disableInProcessFallback !== true
    || input.control.remote.codeMode.remoteHostUrl !== expectedUrl
    || input.control.forwardingDisabled !== true
    || input.control.proxyProcesses.length !== 0
    || input.control.physicalWorkspaceMounts.length !== 0
    || input.control.physicalGitMounts.length !== 0) {
    throw new Error("codex-app-server-code-mode-host");
  }
  assertCodeModeHostEndpoint(input.codeModeHost, expectedUrl);
  const result: CodexNativeAppServerPolicy = {
    controlContainerId,
    controlHomePath: input.control.home.homePath,
    executablePath: APP_SERVER_EXECUTABLE_PATH,
    command: [APP_SERVER_EXECUTABLE_PATH, "app-server", "--listen", "unix://", "--code-mode-host", expectedUrl],
    socketPath: APP_SERVER_CONTROL_SOCKET_PATH,
    codeModeHostUrl: expectedUrl,
    environment: { ...input.control.environment },
    workingDirectory: "/workspace",
    homeIdentity: homeIdentity(input.control.home.identity),
    projectMounts: [],
    gitMounts: []
  };
  assertPolicy(result);
  return result;
}

function timing(input: {
  readonly deadlineMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): TimingOptions {
  const deadlineMs = input.deadlineMs ?? APP_SERVER_READY_DEADLINE_MS;
  const pollIntervalMs = input.pollIntervalMs ?? APP_SERVER_READY_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 5_000) {
    throw new Error("codex-app-server-readiness-options");
  }
  return {
    deadlineMs,
    pollIntervalMs,
    now: input.now ?? Date.now,
    sleep: input.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  };
}

async function socketProbe(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT" || error.code === "EPIPE") finish(false);
      else if (!settled) { settled = true; socket.destroy(); reject(error); }
    });
  });
}

async function prepareSocket(policy: CodexNativeAppServerPolicy): Promise<void> {
  const parent = path.dirname(nativeAppServerAgentSocketPath(policy.controlHomePath));
  await establishPinnedDirectory(parent);
  const observed = await lstatIdentity(nativeAppServerAgentSocketPath(policy.controlHomePath));
  if (observed === null) return;
  if (observed.stats.isSymbolicLink() || !observed.stats.isSocket()) throw new Error("codex-app-server-socket-foreign");
  if (await socketProbe(nativeAppServerAgentSocketPath(policy.controlHomePath))) {
    throw new Error("codex-app-server-socket-foreign");
  }
  await unlink(nativeAppServerAgentSocketPath(policy.controlHomePath));
}

function discardStream(stream: Duplex): void {
  stream.on("error", () => undefined);
  stream.resume();
}

function assertServerInspection(inspection: DockerExecInspection, policy: CodexNativeAppServerPolicy, execId: string, expectedPid?: number): number {
  if (inspection.ID !== execId || inspection.ContainerID !== policy.controlContainerId) throw new Error("codex-app-server-process");
  if (!inspection.Running || inspection.ExitCode !== null
    || inspection.Pid === undefined || !Number.isSafeInteger(inspection.Pid) || inspection.Pid < 1
    || (expectedPid !== undefined && inspection.Pid !== expectedPid)) {
    throw new Error("codex-app-server-process");
  }
  return inspection.Pid;
}

async function waitForSocket(input: {
  readonly policy: CodexNativeAppServerPolicy;
  readonly deadline: number;
  readonly timing: TimingOptions;
}): Promise<{ readonly identity: FileIdentity }> {
  const socketPath = nativeAppServerAgentSocketPath(input.policy.controlHomePath);
  for (;;) {
    const observed = await lstatIdentity(socketPath);
    if (observed !== null && observed.stats.isSocket() && !observed.stats.isSymbolicLink()) return { identity: observed.identity };
    const remaining = input.deadline - input.timing.now();
    if (remaining <= 0) throw new Error("codex-app-server-socket-not-ready");
    await input.timing.sleep(Math.min(input.timing.pollIntervalMs, remaining));
  }
}

async function assertHome(policy: CodexNativeAppServerPolicy): Promise<void> {
  const observed = await lstatIdentity(policy.controlHomePath);
  if (observed === null || !observed.stats.isDirectory() || observed.stats.isSymbolicLink()
    || homeIdentity(observed.identity) !== policy.homeIdentity) throw new Error("codex-app-server-home-identity");
}

async function assertSocket(input: {
  readonly policy: CodexNativeAppServerPolicy;
  readonly handle: CodexNativeAppServerHandle;
}): Promise<void> {
  const observed = await lstatIdentity(nativeAppServerAgentSocketPath(input.policy.controlHomePath));
  if (observed === null || observed.stats.isSymbolicLink() || !observed.stats.isSocket()
    || !identitiesEqual(observed.identity, input.handle.socketIdentity)) throw new Error("codex-app-server-socket-identity");
}

export async function startCodexNativeAppServer(input: {
  readonly docker: DockerEngineClient;
  readonly policy: CodexNativeAppServerPolicy;
  readonly deadlineMs?: number;
  readonly pollIntervalMs?: number;
}): Promise<CodexNativeAppServerHandle> {
  assertPolicy(input.policy);
  await assertHome(input.policy);
  await prepareSocket(input.policy);
  const options = timing(input);
  let execId: string;
  try {
    execId = await input.docker.createExec(input.policy.controlContainerId, {
      command: input.policy.command,
      workingDirectory: input.policy.workingDirectory,
      environment: input.policy.environment,
      attachStdin: false,
      tty: false
    });
  } catch (error) {
    throw new Error("codex-app-server-exec-create", { cause: error });
  }
  let stream: Duplex;
  try {
    stream = await input.docker.startExecAttached(execId, false);
    discardStream(stream);
  } catch (error) {
    throw new Error("codex-app-server-attach", { cause: error });
  }
  const deadline = options.now() + options.deadlineMs;
  try {
    const initial = await input.docker.inspectExec(execId);
    const serverPid = assertServerInspection(initial, input.policy, execId);
    const socket = await waitForSocket({ policy: input.policy, deadline, timing: options });
    return {
      controlContainerId: input.policy.controlContainerId,
      execId,
      serverPid,
      socketPath: input.policy.socketPath,
      socketIdentity: socket.identity,
      homeIdentity: input.policy.homeIdentity,
      codeModeHostUrl: input.policy.codeModeHostUrl,
      transportSecurity: "private-network-only"
    };
  } catch (error) {
    if (error instanceof Error && ["codex-app-server-process", "codex-app-server-socket-not-ready"].includes(error.message)) throw error;
    throw new Error("codex-app-server-process", { cause: error });
  }
}

export async function assertCodexNativeAppServerReady(input: {
  readonly docker: DockerEngineClient;
  readonly handle: CodexNativeAppServerHandle;
  readonly policy: CodexNativeAppServerPolicy;
}): Promise<void> {
  assertPolicy(input.policy);
  if (input.handle.controlContainerId !== input.policy.controlContainerId
    || input.handle.socketPath !== input.policy.socketPath
    || input.handle.homeIdentity !== input.policy.homeIdentity
    || input.handle.codeModeHostUrl !== input.policy.codeModeHostUrl
    || input.handle.transportSecurity !== "private-network-only") throw new Error("codex-app-server-identity");
  await assertHome(input.policy);
  const inspection = await input.docker.inspectExec(input.handle.execId);
  assertServerInspection(inspection, input.policy, input.handle.execId, input.handle.serverPid);
  await assertSocket({ policy: input.policy, handle: input.handle });
}

export async function reattachCodexNativeAppServer(input: {
  readonly docker: DockerEngineClient;
  readonly handle: CodexNativeAppServerHandle;
  readonly policy: CodexNativeAppServerPolicy;
}): Promise<void> {
  await assertCodexNativeAppServerReady(input);
}
