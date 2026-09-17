import { randomBytes } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import type { Duplex } from "node:stream";
import { v7 as uuidv7 } from "uuid";
import { uuidV7Schema } from "@devspace/contracts";
import {
  createLogger,
  redactSensitiveText,
  type StructuredLogger
} from "@devspace/diagnostics";
import {
  compileRuntimePlanV1,
  type RuntimePlanV1
} from "@devspace/project-options";
import {
  assertContained,
  identitiesEqual,
  lstatIdentity,
  readRegularFileNoFollow,
  type FileIdentity
} from "../private-state.js";
import {
  DockerEngineClient,
  type DockerContainerInspection,
  type DockerNetworkInspection,
  type DockerProcessTable
} from "../docker-runtime.js";
import { ManagedWorkspaces, type ManagedWorkspaceRoots, type WorkspaceExecutionContext } from "../managed-workspaces.js";
import { probeAdmittedCodexVersion } from "./compatibility.js";
import { ensureNativeCodexHome, nativeCodexHomePath, type CodexNativeHomeBinding } from "./native-home.js";
import { CodexSplitRuntime } from "./split-runtime.js";
import {
  createCodexSplitTransportBinding,
  type CodexSplitTransportBinding,
  type CodexSplitTransportExecutor
} from "./transport.js";
import { buildCodexSplitNetworkAttachments, type CodexSplitNetworkBinding } from "./network.js";
import {
  assertForbiddenProjectConfiguration,
  assertNativeHomeEnvironmentOverride,
  prepareCodexManagedPolicy,
  type CodexManagedPolicyBinding
} from "./remote-policy.js";
import { evaluateCodexSplitOutcome, type CodexSplitGateEvidence } from "./feasibility-result.js";
import type { CodexSplitRuntimeRecord } from "./runtime-record.js";
import type { NativeCodexPty } from "./native-pty.js";
import {
  discoverNativeSession,
  snapshotNativeSessionState,
  type NativeSessionProvenance,
  type NativeSessionSnapshot
} from "./session-provenance.js";

export const CODEX_SPLIT_VERIFY_ENV = [
  "DEVSPACE_TEST_DOCKER_SOCKET_PATH",
  "DEVSPACE_MANAGED_ROOT",
  "DEVSPACE_CODEX_EXECUTABLE_PATH",
  "DEVSPACE_CODEX_CONTROL_IMAGE_REFERENCE",
  "DEVSPACE_CODEX_VERIFY_PROJECT_ID",
  "DEVSPACE_CODEX_VERIFY_WORKSPACE_ID"
] as const;

export interface CodexSplitVerifyConfiguration {
  readonly dockerSocketPath: string;
  readonly managedRoot: string;
  readonly codexExecutablePath: string;
  readonly controlImageReference: string;
  readonly projectId: string;
  readonly workspaceId: string;
}

export interface CodexSplitOperator {
  printChecklist(text: string): void;
  attach(pty: NativeCodexPty): Promise<"exited" | "aborted">;
  confirmFinalResult(): Promise<"PASS" | "FAIL">;
}

export interface CodexSplitLiveEvidence extends CodexSplitGateEvidence {
  readonly runId: string;
  readonly processObservations: readonly {
    readonly role: "control" | "executor";
    readonly projectProcessCount: number;
  }[];
  readonly mountObservations: readonly {
    readonly role: "control" | "executor";
    readonly allowedMounts: boolean;
  }[];
  readonly networkObservations: readonly {
    readonly executionNetworkExpectedMembers: boolean;
    readonly controlEgressExpectedMembers: boolean;
    readonly controlCodexServiceReachableOnEgress: boolean;
    readonly executorEndpointReachableOnExecution: boolean;
    readonly executorEndpointReachableFromControlEgress: boolean;
    readonly executorInternetReachable: boolean;
    readonly executorControlEgressGatewayReachable: boolean;
    readonly executorControlEgressAddressReachable: boolean;
    readonly executorHostReachable: boolean;
    readonly executorUnrelatedServiceReachable: boolean;
    readonly controlForwardingDisabled: boolean;
    readonly controlRoutingCapabilitiesAbsent: boolean;
    readonly controlProxyProcessAbsent: boolean;
    readonly endpointPublished: boolean;
    readonly hostNetworkListener: boolean;
    readonly probeComplete: boolean;
    readonly securityViolation: boolean;
  }[];
}

export interface CodexSplitVerifierServices {
  readonly docker: DockerEngineClient;
  readonly managed: ManagedWorkspaces;
  readonly runtime: CodexSplitRuntime;
  readonly home: CodexNativeHomeBinding;
}

interface ProbeResult {
  readonly status: "pass" | "fail" | "unavailable";
  readonly exitCode: number | null;
}

interface ContainerCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

interface CanaryBinding {
  readonly path: string;
  readonly containerPath: string;
  readonly identity: FileIdentity;
}

function canaryBasename(canaryPath: string): string {
  const name = path.basename(canaryPath);
  if (!/^[A-Za-z0-9._-]+$/u.test(name)) throw new Error("codex-split-canary-name-invalid");
  return name;
}

interface ProcessObservation {
  readonly role: "control" | "executor";
  readonly projectProcessCount: number;
}

interface NetworkObservation {
  readonly executionNetworkExpectedMembers: boolean;
  readonly controlEgressExpectedMembers: boolean;
  readonly controlCodexServiceReachableOnEgress: boolean;
  readonly executorEndpointReachableOnExecution: boolean;
  readonly executorEndpointReachableFromControlEgress: boolean;
  readonly executorInternetReachable: boolean;
  readonly executorControlEgressGatewayReachable: boolean;
  readonly executorControlEgressAddressReachable: boolean;
  readonly executorHostReachable: boolean;
  readonly executorUnrelatedServiceReachable: boolean;
  readonly controlForwardingDisabled: boolean;
  readonly controlRoutingCapabilitiesAbsent: boolean;
  readonly controlProxyProcessAbsent: boolean;
  readonly endpointPublished: boolean;
  readonly hostNetworkListener: boolean;
  readonly probeComplete: boolean;
  readonly securityViolation: boolean;
}

const MAX_PROBE_OUTPUT_BYTES = 32 * 1024;
const PROBE_TIMEOUT_MS = 15_000;
const SESSION_DISCOVERY_ATTEMPTS = 20;
const SESSION_DISCOVERY_DELAY_MS = 250;
const CONTROL_ALLOWED_MOUNT_TARGETS = new Set([
  "/codex-home", "/opt/devspace/codex", "/opt/devspace/codex-launcher", "/etc/codex/requirements.toml"
]);
const EXECUTOR_ALLOWED_MOUNT_TARGETS = new Set([
  "/workspace", "/opt/devspace/codex", "/opt/devspace/codex-launcher"
]);
const CONTROL_PROXY_PATTERN = /(?:socat|iptables|nft|tinyproxy|squid|rinetd|portmap|redir)/iu;
const CODEX_UPSTREAM_TARGETS = [
  "https://api.openai.com/v1/models",
  "https://chatgpt.com/backend-api/codex"
] as const;

const VERIFY_ENV_REASON_NAMES: Readonly<Record<typeof CODEX_SPLIT_VERIFY_ENV[number], string>> = {
  DEVSPACE_TEST_DOCKER_SOCKET_PATH: "docker-socket",
  DEVSPACE_MANAGED_ROOT: "managed-root",
  DEVSPACE_CODEX_EXECUTABLE_PATH: "codex-executable-path",
  DEVSPACE_CODEX_CONTROL_IMAGE_REFERENCE: "control-image",
  DEVSPACE_CODEX_VERIFY_PROJECT_ID: "project-id",
  DEVSPACE_CODEX_VERIFY_WORKSPACE_ID: "workspace-id"
};

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: typeof CODEX_SPLIT_VERIFY_ENV[number]): string {
  const value = environment[name];
  if (value === undefined || value.trim() === "") throw new Error(`codex-split-verify-${VERIFY_ENV_REASON_NAMES[name]}-missing`);
  return value;
}

function absoluteEnvironmentPath(value: string, name: string): string {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(`codex-split-verify-${name}-path-invalid`);
  return path.resolve(value);
}

function explicitControlImage(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:=-]{0,255}@sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error("codex-split-verify-control-image-invalid");
  }
  return value;
}

function explicitUuid(value: string, name: "project-id" | "workspace-id"): string {
  try {
    return uuidV7Schema.parse(value);
  } catch {
    throw new Error(`codex-split-verify-${name}-invalid`);
  }
}

export function parseCodexSplitVerifyEnvironment(environment: NodeJS.ProcessEnv): CodexSplitVerifyConfiguration {
  const dockerSocketPath = absoluteEnvironmentPath(requiredEnvironment(environment, CODEX_SPLIT_VERIFY_ENV[0]), "docker-socket");
  if (dockerSocketPath === "/var/run/docker.sock" || dockerSocketPath === "/run/docker.sock") {
    throw new Error("codex-split-verify-docker-socket-host-path");
  }
  const managedRoot = absoluteEnvironmentPath(requiredEnvironment(environment, CODEX_SPLIT_VERIFY_ENV[1]), "managed-root");
  const codexExecutablePath = absoluteEnvironmentPath(requiredEnvironment(environment, CODEX_SPLIT_VERIFY_ENV[2]), "codex-executable-path");
  const controlImageReference = explicitControlImage(requiredEnvironment(environment, CODEX_SPLIT_VERIFY_ENV[3]));
  const projectId = explicitUuid(requiredEnvironment(environment, CODEX_SPLIT_VERIFY_ENV[4]), "project-id");
  const workspaceId = explicitUuid(requiredEnvironment(environment, CODEX_SPLIT_VERIFY_ENV[5]), "workspace-id");
  return { dockerSocketPath, managedRoot, codexExecutablePath, controlImageReference, projectId, workspaceId };
}

function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("codex-split-probe-argument-invalid");
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function unavailableProbe(): ProbeResult {
  return { status: "unavailable", exitCode: null };
}

function isIpv4Address(value: string | undefined): value is string {
  if (value === undefined) return false;
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/u.test(part) && Number(part) <= 255);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function decodeDockerMux(raw: Buffer): string {
  const output: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    if (offset + 8 > raw.length) throw new Error("codex-split-probe-output-invalid");
    const stream = raw[offset];
    const size = raw.readUInt32BE(offset + 4);
    if ((stream !== 1 && stream !== 2) || offset + 8 + size > raw.length) throw new Error("codex-split-probe-output-invalid");
    if (stream === 1) output.push(raw.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(output).toString("utf8");
}

async function boundedStreamOutput(stream: Duplex): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      stream.removeListener("close", onClose);
      stream.removeListener("end", onClose);
      if (error === undefined) resolve(Buffer.concat(chunks));
      else reject(error);
    };
    const onData = (chunk: Buffer): void => {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_PROBE_OUTPUT_BYTES) {
        stream.destroy();
        finish(new Error("codex-split-probe-output-too-large"));
      } else chunks.push(bytes);
    };
    const onError = (): void => finish(new Error("codex-split-probe-stream"));
    const onClose = (): void => finish();
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("close", onClose);
    stream.once("end", onClose);
    stream.resume();
  });
}

async function runContainerCommand(input: {
  readonly docker: DockerEngineClient;
  readonly containerId: string;
  readonly command: readonly string[];
}): Promise<ContainerCommandResult> {
  const execId = await input.docker.createExec(input.containerId, {
    command: input.command, workingDirectory: "/", environment: {}, attachStdin: false, tty: false
  });
  const stream = await input.docker.startExecAttached(execId, false);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = boundedStreamOutput(stream);
    const deadline = new Promise<Buffer>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("codex-split-probe-timeout")), PROBE_TIMEOUT_MS);
    });
    const raw = await Promise.race([output, deadline]);
    const inspection = await input.docker.inspectExec(execId);
    if (inspection.Running || inspection.ExitCode === null) throw new Error("codex-split-probe-process");
    return { exitCode: inspection.ExitCode, stdout: decodeDockerMux(raw) };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    stream.destroy();
  }
}

async function runShellProbe(docker: DockerEngineClient, containerId: string, script: string): Promise<ProbeResult> {
  try {
    const result = await runContainerCommand({ docker, containerId, command: ["/bin/sh", "-c", script] });
    if (result.exitCode === 0) return { status: "pass", exitCode: result.exitCode };
    if (result.exitCode === 125) return { status: "unavailable", exitCode: result.exitCode };
    return { status: "fail", exitCode: result.exitCode };
  } catch {
    return { status: "unavailable", exitCode: null };
  }
}

async function runReachabilityProbe(input: {
  readonly docker: DockerEngineClient;
  readonly containerId: string;
  readonly target: string;
  readonly interfaceAddress?: string | undefined;
  readonly expectedReachable: boolean;
}): Promise<ProbeResult> {
  const interfaceOption = input.interfaceAddress === undefined ? "" : ` --interface ${shellQuote(input.interfaceAddress)}`;
  const url = shellQuote(input.target);
  const script = `if ! command -v curl >/dev/null 2>&1; then exit 125; fi; `
    + `curl --silent --show-error --output /dev/null --connect-timeout 4 --max-time 8${interfaceOption} ${url}`;
  try {
    const result = await runContainerCommand({ docker: input.docker, containerId: input.containerId, command: ["/bin/sh", "-c", script] });
    const reachable = result.exitCode === 0;
    if (input.expectedReachable) return reachable ? { status: "pass", exitCode: result.exitCode } : { status: "unavailable", exitCode: result.exitCode };
    return reachable ? { status: "fail", exitCode: result.exitCode } : result.exitCode === 125
      ? { status: "unavailable", exitCode: result.exitCode }
      : { status: "pass", exitCode: result.exitCode };
  } catch {
    return { status: "unavailable", exitCode: null };
  }
}

async function runReachabilityProbes(input: {
  readonly docker: DockerEngineClient;
  readonly containerId: string;
  readonly targets: readonly string[];
  readonly interfaceAddress?: string | undefined;
  readonly expectedReachable: boolean;
}): Promise<ProbeResult> {
  const results = await Promise.all(input.targets.map((target) => runReachabilityProbe({
    docker: input.docker,
    containerId: input.containerId,
    target,
    interfaceAddress: input.interfaceAddress,
    expectedReachable: input.expectedReachable
  })));
  if (input.expectedReachable) {
    if (results.some((result) => result.status === "pass")) return { status: "pass", exitCode: 0 };
    return unavailableProbe();
  }
  if (results.some((result) => result.status === "fail")) return { status: "fail", exitCode: 0 };
  if (results.every((result) => result.status === "pass")) return { status: "pass", exitCode: 1 };
  return unavailableProbe();
}

function containerNames(inspection: DockerNetworkInspection): ReadonlyMap<string, string> {
  return new Map(Object.entries(inspection.Containers ?? {}).map(([id, entry]) => [id, entry.Name?.replace(/^\//u, "") ?? ""]));
}

function exactNetworkMembers(
  inspection: DockerNetworkInspection,
  expected: readonly { readonly id: string; readonly name: string }[]
): boolean {
  const actual = containerNames(inspection);
  if (actual.size !== expected.length) return false;
  return expected.every((member) => actual.get(member.id) === member.name);
}

function mountTargets(inspection: DockerContainerInspection): Set<string> {
  return new Set(inspection.Mounts.map((mount) => mount.Destination));
}

function pathsOverlap(left: string, right: string): boolean {
  const first = path.resolve(left);
  const second = path.resolve(right);
  const firstRelative = path.relative(first, second);
  const secondRelative = path.relative(second, first);
  const contained = (relative: string): boolean => relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  return contained(firstRelative) || contained(secondRelative);
}

function hasSocketMount(inspection: DockerContainerInspection): boolean {
  return inspection.Mounts.some((mount) => mount.Source.includes("docker.sock")
    || mount.Destination.includes("docker.sock") || mount.Destination.includes("agent.sock"));
}

function hasRequiredEnvironment(inspection: DockerContainerInspection, expected: Readonly<Record<string, string>>): boolean {
  const observed = new Map<string, string[]>();
  for (const entry of inspection.Config.Env ?? []) {
    const separator = entry.indexOf("=");
    if (separator < 1) return false;
    const name = entry.slice(0, separator);
    const values = observed.get(name) ?? [];
    values.push(entry.slice(separator + 1));
    observed.set(name, values);
  }
  return Object.entries(expected).every(([name, value]) => {
    const values = observed.get(name);
    return values?.length === 1 && values[0] === value;
  });
}

function hasCredentialEnvironment(inspection: DockerContainerInspection): boolean {
  return (inspection.Config.Env ?? []).some((entry) => /^(?:CODEX_API_KEY|CODEX_ACCESS_TOKEN|CODEX_AUTH_TOKEN|CODEX_REFRESH_TOKEN|OPENAI_API_KEY|OPENAI_ACCESS_TOKEN|OPENAI_AUTH_TOKEN|OPENAI_REFRESH_TOKEN)=/iu.test(entry));
}

function allowedControlMounts(inspection: DockerContainerInspection, home: CodexNativeHomeBinding): boolean {
  const targets = mountTargets(inspection);
  const homeMount = inspection.Mounts.find((mount) => mount.Destination === home.mountTarget);
  return targets.size === CONTROL_ALLOWED_MOUNT_TARGETS.size
    && [...targets].every((target) => CONTROL_ALLOWED_MOUNT_TARGETS.has(target))
    && homeMount?.Source === path.resolve(home.homePath) && homeMount.RW
    && inspection.Mounts.every((mount) => mount.Destination !== "/workspace")
    && !hasSocketMount(inspection);
}

function allowedExecutorMounts(
  inspection: DockerContainerInspection,
  context: WorkspaceExecutionContext,
  git: { readonly worktreePath: string; readonly repositoryPath: string; readonly administrationPath: string }
): boolean {
  const targets = mountTargets(inspection);
  const allowed = new Set([...EXECUTOR_ALLOWED_MOUNT_TARGETS, git.repositoryPath, git.administrationPath]);
  const workspace = inspection.Mounts.find((mount) => mount.Destination === "/workspace");
  const repository = inspection.Mounts.find((mount) => mount.Destination === git.repositoryPath);
  const administration = inspection.Mounts.find((mount) => mount.Destination === git.administrationPath);
  return targets.size === allowed.size
    && [...targets].every((target) => allowed.has(target))
    && workspace?.Source === path.resolve(git.worktreePath) && workspace.RW
    && repository?.Source === path.resolve(git.repositoryPath)
    && administration?.Source === path.resolve(git.administrationPath)
    && inspection.Mounts.every((mount) => !mount.Source.includes("codex-home") && mount.Destination !== "/codex-home")
    && !hasSocketMount(inspection)
    && context.ownership.worktreePath === git.worktreePath;
}

function hardenedContainer(inspection: DockerContainerInspection, expectedNetworkCount: number): boolean {
  const host = inspection.HostConfig;
  return inspection.State.Running
    && host.Privileged === false
    && host.PidMode !== "host"
    && host.NetworkMode !== "host"
    && host.NetworkMode !== "container"
    && host.IpcMode === "private"
    && host.UTSMode === ""
    && host.UsernsMode === ""
    && host.CgroupnsMode === "private"
    && host.PublishAllPorts === false
    && host.CapAdd?.length === 0
    && JSON.stringify([...(host.CapDrop ?? [])].sort()) === JSON.stringify(["ALL"])
    && JSON.stringify([...(host.SecurityOpt ?? [])].sort()) === JSON.stringify(["no-new-privileges:true"])
    && Object.keys(host.PortBindings ?? {}).length === 0
    && (inspection.NetworkSettings.Networks !== null
      && Object.keys(inspection.NetworkSettings.Networks ?? {}).length === expectedNetworkCount);
}

function projectProcessCount(processes: DockerProcessTable, role: "control" | "executor"): number {
  const commandIndex = processes.titles.findIndex((title) => ["args", "cmd", "command"].includes(title.toLowerCase()));
  if (commandIndex < 0) return 0;
  const projectPattern = /(?:^|[\s/])(?:git|node|npm|pnpm|python(?:\d+(?:\.\d+)?)?|pytest|make|cargo|go|bash|zsh|fish|sh)(?:$|[\s/])/iu;
  return processes.processes.filter((process) => {
    const command = process[commandIndex] ?? "";
    return projectPattern.test(command) || command.includes("/workspace")
      || (role === "control" && command.includes("/workspace"));
  }).length;
}

async function observeProcesses(docker: DockerEngineClient, record: CodexSplitRuntimeRecord): Promise<readonly ProcessObservation[]> {
  const observations: ProcessObservation[] = [];
  for (const [role, id] of [["control", record.control.id], ["executor", record.executor.id]] as const) {
    try {
      const table = await docker.topContainer(id, "pid,args");
      observations.push({ role, projectProcessCount: projectProcessCount(table, role) });
    } catch {
      observations.push({ role, projectProcessCount: 0 });
    }
  }
  return observations;
}

async function observeDuringAttach(input: {
  readonly docker: DockerEngineClient;
  readonly record: CodexSplitRuntimeRecord;
  readonly operator: CodexSplitOperator;
  readonly pty: NativeCodexPty;
}): Promise<{ readonly result: "exited" | "aborted"; readonly observations: readonly ProcessObservation[] }> {
  const observations: ProcessObservation[] = [];
  let running = true;
  const poll = (async (): Promise<void> => {
    while (running) {
      observations.push(...await observeProcesses(input.docker, input.record));
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  })();
  try {
    const result = await input.operator.attach(input.pty);
    return { result, observations };
  } finally {
    running = false;
    await poll;
  }
}

export function endpointFromRecord(record: CodexSplitRuntimeRecord): CodexSplitTransportBinding {
  const port = Number(record.executor.endpointUrl.slice(record.executor.endpointUrl.lastIndexOf(":") + 1));
  if (record.executor.transportSecurity !== "private-network-only") {
    throw new Error("codex-split-runtime-transport-state");
  }
  const network: CodexSplitNetworkBinding = {
    execution: { ...record.networks.execution, workspaceId: record.workspaceId, generation: record.generation,
      controlAlias: "codex-control", executorAlias: "codex-executor", publishedPorts: [] },
    controlEgress: { ...record.networks.controlEgress, workspaceId: record.workspaceId, generation: record.generation,
      controlAlias: "codex-control", executorAttached: false, publishedPorts: [], defaultBridgeUsed: false }
  };
  const executor: CodexSplitTransportExecutor = {
    endpointHost: "codex-executor", endpointPort: port, controlEgressAttached: false,
    policy: {
      workspaceId: record.workspaceId,
      generation: record.generation,
      executionNetwork: network.execution,
      networkAttachments: buildCodexSplitNetworkAttachments({ role: "executor", network })
    }
  };
  return createCodexSplitTransportBinding({
    executor, network,
    protocolAuthenticationVerified: false,
    privateNetworkIsolationVerified: true,
    admittedVersion: "0.153.4",
    credential: null
  });
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  const entry = await lstatIdentity(filePath);
  if (entry === null) return null;
  if (!entry.stats.isFile() || entry.stats.isSymbolicLink()) throw new Error("codex-split-config-file-invalid");
  const read = await readRegularFileNoFollow(filePath, 64 * 1024);
  return read.bytes.toString("utf8");
}

async function assertConfigurationMatrix(input: {
  readonly home: CodexNativeHomeBinding;
  readonly context: WorkspaceExecutionContext;
  readonly endpoint: CodexSplitTransportBinding;
  readonly stateRoot: string;
}): Promise<{ readonly passed: boolean; readonly policy: CodexManagedPolicyBinding }> {
  const policy = await prepareCodexManagedPolicy({ stateRoot: input.stateRoot, home: input.home, endpoint: input.endpoint, admittedVersion: "0.153.4" });
  const homeConfig = await readOptionalFile(path.join(input.home.homePath, "config.toml"));
  const environmentToml = await readOptionalFile(path.join(input.home.homePath, "environments.toml"));
  assertNativeHomeEnvironmentOverride({ homeConfig, environmentToml, endpoint: input.endpoint });
  const projectConfig = await readOptionalFile(path.join(input.context.ownership.worktreePath, ".codex", "config.toml"));
  assertForbiddenProjectConfiguration({ projectConfig: projectConfig ?? "", policy });
  return { passed: true, policy };
}

async function createCanary(home: CodexNativeHomeBinding, runId: string): Promise<CanaryBinding> {
  const name = `.devspace-codex-canary-${runId}`;
  const canaryPath = assertContained(home.homePath, path.join(home.homePath, name));
  const value = randomBytes(32).toString("hex");
  const descriptor = await open(canaryPath, "wx", 0o600);
  try {
    await descriptor.writeFile(value, "utf8");
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  const observed = await lstatIdentity(canaryPath);
  if (observed === null || !observed.stats.isFile() || observed.stats.isSymbolicLink()) throw new Error("codex-split-canary-create");
  return { path: canaryPath, containerPath: `/codex-home/${name}`, identity: observed.identity };
}

async function verifyCanaryIsolation(input: {
  readonly docker: DockerEngineClient;
  readonly executorId: string;
  readonly canary: CanaryBinding;
  readonly runId: string;
}): Promise<ProbeResult> {
  const link = `/workspace/.devspace-codex-canary-link-${input.runId}`;
  const canary = shellQuote(input.canary.containerPath);
  const basename = canaryBasename(input.canary.path);
  const quotedLink = shellQuote(link);
  const script = [
    "set -eu",
    `rm -f -- ${quotedLink}`,
    `test ! -r ${canary}`,
    `test ! -r ${shellQuote(`/workspace/../codex-home/${basename}`)}`,
    `ln -s -- ${canary} ${quotedLink}`,
    `test ! -r ${quotedLink}`,
    `test ! -r ${shellQuote(`/proc/1/root${input.canary.containerPath}`)}`,
    `test ! -r ${shellQuote(`/proc/1/environ`)}`,
    `! (command -v find >/dev/null 2>&1 && find / -xdev -type f -name ${shellQuote(basename)} -print -quit | grep -q .)`,
    `! (command -v find >/dev/null 2>&1 && find / -xdev -path ${shellQuote(`*/${basename}`)} -print -quit | grep -q .)`,
    `! (command -v env >/dev/null 2>&1 && env | grep -q 'CODEX_HOME=')`,
    `! (command -v tr >/dev/null 2>&1 && tr '\\0' '\\n' </proc/1/environ | grep -q 'CODEX_HOME=')`,
    `test ! -r ${shellQuote(`/opt/codex-home/${basename}`)}`,
    `test ! -r ${shellQuote(`/home/codex/${basename}`)}`,
    `rm -f -- ${quotedLink}`
  ].join("; ");
  return await runShellProbe(input.docker, input.executorId, script);
}

function controlForwardingDisabled(control: DockerContainerInspection): boolean {
  const sysctls = control.HostConfig.Sysctls ?? {};
  return control.HostConfig.Privileged === false
    && control.HostConfig.CapAdd?.length === 0
    && JSON.stringify([...(control.HostConfig.CapDrop ?? [])].sort()) === JSON.stringify(["ALL"])
    && sysctls["net.ipv4.ip_forward"] === "0"
    && (sysctls["net.ipv6.conf.all.forwarding"] === undefined || sysctls["net.ipv6.conf.all.forwarding"] === "0");
}

export function hasNoExternalDefaultRoute(routeOutput: string, executionGateway: string | undefined): boolean {
  const defaultRoutes = routeOutput.split(/\r?\n/u).filter((line) => /^\s*default(?:\s|$)/u.test(line));
  if (defaultRoutes.length === 0) return true;
  if (!isIpv4Address(executionGateway)) return false;
  const expectedRoute = new RegExp(`^\\s*default\\s+via\\s+${escapeRegExp(executionGateway)}(?:\\s|$)`, "u");
  return defaultRoutes.every((line) => expectedRoute.test(line));
}

async function controlDefaultRouteProof(docker: DockerEngineClient, control: DockerContainerInspection, egressGateway: string | undefined): Promise<ProbeResult> {
  if (!isIpv4Address(egressGateway)) return unavailableProbe();
  const result = await runContainerCommand({ docker, containerId: control.Id, command: ["/bin/sh", "-c", "if ! command -v ip >/dev/null 2>&1; then exit 125; fi; ip route"] }).catch(() => null);
  if (result === null || result.exitCode === 125) return unavailableProbe();
  if (result.exitCode !== 0) return { status: "unavailable", exitCode: result.exitCode };
  const expectedRoute = result.stdout.split("\n").some((line) => new RegExp(`^default\\s+via\\s+${escapeRegExp(egressGateway)}\\b`, "u").test(line));
  return { status: expectedRoute ? "pass" : "fail", exitCode: result.exitCode };
}

async function executorExternalRouteAbsent(
  docker: DockerEngineClient,
  executorId: string,
  executionGateway: string | undefined
): Promise<ProbeResult> {
  try {
    const result = await runContainerCommand({
      docker,
      containerId: executorId,
      command: ["/bin/sh", "-c", "if ! command -v ip >/dev/null 2>&1; then exit 125; fi; ip route"]
    });
    if (result.exitCode === 125) return { status: "unavailable", exitCode: result.exitCode };
    if (result.exitCode !== 0) return { status: "unavailable", exitCode: result.exitCode };
    return {
      status: hasNoExternalDefaultRoute(result.stdout, executionGateway) ? "pass" : "fail",
      exitCode: result.exitCode
    };
  } catch {
    return { status: "unavailable", exitCode: null };
  }
}

async function collectNetworkEvidence(input: {
  readonly docker: DockerEngineClient;
  readonly record: CodexSplitRuntimeRecord;
  readonly control: DockerContainerInspection;
  readonly executor: DockerContainerInspection;
}): Promise<NetworkObservation> {
  const execution = await input.docker.inspectNetwork(input.record.networks.execution.id).catch(() => null);
  const controlEgress = await input.docker.inspectNetwork(input.record.networks.controlEgress.id).catch(() => null);
  const controlNetworks = input.control.NetworkSettings.Networks ?? {};
  const controlExecution = controlNetworks[input.record.networks.execution.name];
  const controlEgressAddress = controlNetworks[input.record.networks.controlEgress.name];
  const executorNetworks = input.executor.NetworkSettings.Networks ?? {};
  const executorExecution = executorNetworks[input.record.networks.execution.name];
  const executionMembers = execution !== null && exactNetworkMembers(execution, [
    { id: input.record.control.id, name: input.control.Name.replace(/^\//u, "") },
    { id: input.record.executor.id, name: input.executor.Name.replace(/^\//u, "") }
  ]);
  const egressMembers = controlEgress !== null && exactNetworkMembers(controlEgress, [
    { id: input.record.control.id, name: input.control.Name.replace(/^\//u, "") }
  ]);
  const controlHasOnlyExpectedAttachments = Object.keys(controlNetworks).length === 2
    && controlExecution?.NetworkID === input.record.networks.execution.id
    && controlEgressAddress?.NetworkID === input.record.networks.controlEgress.id;
  const executorHasOnlyExecutionAttachment = Object.keys(executorNetworks).length === 1
    && executorExecution?.NetworkID === input.record.networks.execution.id;
  const executionPolicy = execution !== null
    && execution.Name !== "bridge" && execution.Driver === "bridge" && execution.Internal === true
    && execution.Attachable === false && execution.Ingress === false && execution.EnableIPv6 === false;
  const controlEgressPolicy = controlEgress !== null
    && controlEgress.Name !== "bridge" && controlEgress.Driver === "bridge" && controlEgress.Internal === false
    && controlEgress.Attachable === false && controlEgress.Ingress === false && controlEgress.EnableIPv6 === false;
  const executionExpected = executionMembers && executionPolicy && controlHasOnlyExpectedAttachments && executorHasOnlyExecutionAttachment;
  const egressExpected = egressMembers && controlEgressPolicy && controlHasOnlyExpectedAttachments && !Object.prototype.hasOwnProperty.call(
    controlEgress?.Containers ?? {}, input.record.executor.id
  );
  const endpointPort = Number(input.record.executor.endpointUrl.slice(input.record.executor.endpointUrl.lastIndexOf(":") + 1));
  const endpointTarget = `http://codex-executor:${endpointPort}/readyz`;
  const controlEndpoint = isIpv4Address(controlExecution?.IPAddress)
    ? await runReachabilityProbe({
      docker: input.docker, containerId: input.control.Id, target: endpointTarget,
      interfaceAddress: controlExecution.IPAddress, expectedReachable: true
    })
    : unavailableProbe();
  const controlEgressEndpoint = isIpv4Address(controlEgressAddress?.IPAddress)
    ? await runReachabilityProbe({
      docker: input.docker, containerId: input.control.Id, target: endpointTarget,
      interfaceAddress: controlEgressAddress.IPAddress, expectedReachable: false
    })
    : unavailableProbe();
  const model = isIpv4Address(controlEgressAddress?.IPAddress)
    ? await runReachabilityProbes({
      docker: input.docker, containerId: input.control.Id, targets: CODEX_UPSTREAM_TARGETS,
      interfaceAddress: controlEgressAddress.IPAddress, expectedReachable: true
    })
    : unavailableProbe();
  const egressGateway = controlEgressAddress?.Gateway;
  const executorInternet = await runReachabilityProbes({
    docker: input.docker, containerId: input.executor.Id, targets: CODEX_UPSTREAM_TARGETS, expectedReachable: false
  });
  const executorEgressGateway = isIpv4Address(egressGateway)
    ? await runReachabilityProbe({ docker: input.docker, containerId: input.executor.Id, target: `http://${egressGateway}:80`, expectedReachable: false })
    : unavailableProbe();
  const executorControlEgressAddress = isIpv4Address(controlEgressAddress?.IPAddress)
    ? await runReachabilityProbe({
      docker: input.docker, containerId: input.executor.Id, target: `http://${controlEgressAddress.IPAddress}:80`, expectedReachable: false
    })
    : unavailableProbe();
  const executorHost = await runReachabilityProbe({
    docker: input.docker, containerId: input.executor.Id, target: "http://host.docker.internal:80", expectedReachable: false
  });
  const executorUnrelated = await runReachabilityProbe({
    docker: input.docker, containerId: input.executor.Id, target: "http://devspace-unrelated-service:80", expectedReachable: false
  });
  const controlProcesses = await input.docker.topContainer(input.control.Id, "pid,args").catch(() => null);
  const controlProxyAbsent = controlProcesses !== null
    && !controlProcesses.processes.some((process) => process.some((field) => CONTROL_PROXY_PATTERN.test(field)));
  const noPublishedPorts = Object.keys(input.control.HostConfig.PortBindings ?? {}).length === 0
    && Object.keys(input.executor.HostConfig.PortBindings ?? {}).length === 0;
  const controlRoute = await controlDefaultRouteProof(input.docker, input.control, egressGateway);
  const executorNoExternalDefault = await executorExternalRouteAbsent(input.docker, input.executor.Id, executorExecution?.Gateway);
  const controlListener = await runShellProbe(input.docker, input.control.Id,
    "if command -v ss >/dev/null 2>&1; then ! ss -H -lnt | grep -q .; elif command -v netstat >/dev/null 2>&1; then ! netstat -lnt | tail -n +3 | grep -q .; else exit 125; fi");
  const probes = [
    controlEndpoint, controlEgressEndpoint, model, executorInternet, executorEgressGateway,
    executorControlEgressAddress, executorHost, executorUnrelated, controlRoute, executorNoExternalDefault, controlListener
  ];
  const probeComplete = execution !== null && controlEgress !== null && controlProcesses !== null
    && probes.every((probe) => probe.status !== "unavailable");
  const metadataSecurityViolation = execution !== null && controlEgress !== null
    && (!executionExpected || !egressExpected);
  const reachabilitySecurityViolation = controlEgressEndpoint.status === "fail"
    || executorInternet.status === "fail" || executorEgressGateway.status === "fail"
    || executorControlEgressAddress.status === "fail" || executorHost.status === "fail"
    || executorUnrelated.status === "fail" || controlRoute.status === "fail"
    || executorNoExternalDefault.status === "fail" || controlListener.status === "fail";
  const securityViolation = metadataSecurityViolation || reachabilitySecurityViolation
    || (controlProcesses !== null && !controlProxyAbsent)
    || !noPublishedPorts || input.control.HostConfig.NetworkMode === "host" || input.executor.HostConfig.NetworkMode === "host"
    || !hardenedContainer(input.control, 2) || !hardenedContainer(input.executor, 1);
  return {
    executionNetworkExpectedMembers: executionExpected,
    controlEgressExpectedMembers: egressExpected,
    controlCodexServiceReachableOnEgress: model.status === "pass",
    executorEndpointReachableOnExecution: controlEndpoint.status === "pass",
    executorEndpointReachableFromControlEgress: controlEgressEndpoint.status === "fail",
    executorInternetReachable: executorInternet.status === "fail",
    executorControlEgressGatewayReachable: executorEgressGateway.status === "fail",
    executorControlEgressAddressReachable: executorControlEgressAddress.status === "fail",
    executorHostReachable: executorHost.status === "fail",
    executorUnrelatedServiceReachable: executorUnrelated.status === "fail",
    controlForwardingDisabled: controlForwardingDisabled(input.control) && controlRoute.status === "pass" && executorNoExternalDefault.status === "pass",
    controlRoutingCapabilitiesAbsent: hardenedContainer(input.control, 2),
    controlProxyProcessAbsent: controlProxyAbsent,
    endpointPublished: !noPublishedPorts,
    hostNetworkListener: input.control.HostConfig.NetworkMode === "host" || input.executor.HostConfig.NetworkMode === "host",
    probeComplete,
    securityViolation
  };
}

export function buildCodexSplitManualChecklist(): string {
  return [
    "Codex split feasibility manual gate (this text is outside the TUI; no text is injected).",
    "A. Control plane: confirm the real native TUI starts, login/model access works, native approval is requested and selected, and native session state persists.",
    "B. Project executor: confirm the exact project image/worktree/Git state is used and no control-side project mount exists.",
    "C. From the native TUI, manually exercise pwd, git status --short, git diff --stat, git log -1 --oneline, available Node/Python/package scripts, a nested child, AGENTS.md, a file read/write, and apply_patch; observe the bounded result and do not print any canary contents.",
    "D. Confirm the executor cannot read the native-home canary by direct path, traversal, symlink, environment/proc inspection, alternate path, or enumeration; confirm no Internet, host, gateway, unrelated-service, or control-egress route.",
    "E. Exit the TUI normally. The Agent will passively identify the native session ID, then launch exactly: codex resume NATIVE_SESSION_ID. Confirm the resumed session has the same home, remote executor, logical /workspace, and no control-side project process.",
    "F. Confirm local environment, /shell, hooks/notify, local MCP/helper paths, unsafe plugin maintenance, program executors, shared daemon reuse, danger/full-access, sandbox bypass, and local fallback are rejected/disabled. A second distinct session may use the same workspace; duplicate live resume must be rejected.",
    "Use only the native TUI and normal human input. Do not paste this checklist into Codex, inject prompts/slash commands, or synthesize approvals. After all checks, exit normally and answer the final PASS/FAIL question outside the TUI."
  ].join("\n");
}

export function parseCodexSplitOperatorAnswer(input: string): "PASS" | "FAIL" {
  const answer = input.trim().toUpperCase();
  if (answer === "PASS" || answer === "FAIL") return answer;
  throw new Error("codex-split-operator-answer-invalid");
}

export interface CodexSplitDiagnostic {
  readonly phase: string;
  readonly reasonCode: string;
  readonly exceptionClass: string;
  readonly resourceRole: "control" | "executor" | "runtime" | "verifier";
  readonly stackContext: string;
}

function safeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "unexpected-failure";
  return /^[a-z0-9][a-z0-9./_-]{0,95}$/u.test(message) ? message : "unexpected-failure";
}

function safeCauseContext(error: unknown): readonly string[] {
  const lines: string[] = [];
  let current: unknown = error instanceof Error ? (error as Error & { readonly cause?: unknown }).cause : undefined;
  for (let depth = 1; depth <= 4 && current !== undefined; depth += 1) {
    lines.push(`CAUSE_${depth}: ${safeReason(current)}`);
    current = current instanceof Error ? (current as Error & { readonly cause?: unknown }).cause : undefined;
  }
  return lines;
}

export function formatCodexSplitDiagnostic(
  phase: string,
  error: unknown,
  resourceRole: CodexSplitDiagnostic["resourceRole"]
): CodexSplitDiagnostic {
  const exceptionClass = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(error.name) ? error.name : "Error";
  const stack = error instanceof Error ? error.stack ?? error.message : "unexpected-failure";
  const stackContext = [
    ...redactSensitiveText(stack)
      .split("\n")
      .slice(0, 8)
      .map((line) => line.replace(/\/(?:[^\s/]+\/){1,}[^\s]*/gu, "[PATH]")),
    ...safeCauseContext(error)
  ]
    .join("\n")
    .slice(0, 1024);
  return { phase: phase.slice(0, 64), reasonCode: safeReason(error), exceptionClass, resourceRole, stackContext };
}

function baseEvidence(runId: string, reason: string | null = "preflight-incomplete"): CodexSplitLiveEvidence {
  return {
    runId,
    admittedCodexVersion: "0.153.4",
    sections: { A: false, B: false, C: false, D: false, E: false, F: false },
    transportSecurity: "unproven",
    liveOperatorProof: false,
    physicalHomeSeparation: false,
    noLocalFallback: false,
    controlModelEgressProven: false,
    executorCannotReachControlEgressProven: false,
    controlRoutingDisabledProven: false,
    securityViolation: false,
    incompleteReason: reason,
    unsupportedReason: null,
    evidenceVersion: 1,
    processObservations: [],
    mountObservations: [],
    networkObservations: []
  };
}

function isSecurityReason(error: unknown): boolean {
  const reason = safeReason(error);
  if (reason === "codex-split-network-proof-incomplete"
    || reason === "codex-split-canary-proof-unavailable"
    || reason === "codex-split-probe-timeout"
    || reason === "codex-split-probe-stream"
    || reason === "codex-split-probe-process") return false;
  return /^(?:codex-policy-(?:binding-invalid|endpoint-invalid|missing-endpoint|stale-endpoint|legacy-notify|shell|command-hooks|unified-exec-disabled|danger-full-access|sandbox-bypass|local-mcp-stdio|local-http-helper|unsafe-plugin-maintenance|program-executor|shared-app-server-daemon|remote-local-fallback|local-environment)|codex-(?:control|executor|split)-(?:.*(?:inspection-policy|network-policy|network-ownership|network-members|network-attachment|network-role|mount-policy|home-identity|canary-identity-changed|transport-network|forwarding-policy|route-policy|fallback|sandbox|local|hook|mcp|plugin)))/iu.test(reason);
}

async function cleanupCanary(canary: CanaryBinding | null): Promise<void> {
  if (canary === null) return;
  const current = await lstatIdentity(canary.path);
  if (current === null) return;
  if (!identitiesEqual(current.identity, canary.identity)) throw new Error("codex-split-canary-identity-changed");
  await unlink(canary.path);
}

async function discoverNativeSessionEventually(input: {
  readonly before: NativeSessionSnapshot;
  readonly home: CodexNativeHomeBinding;
}): Promise<NativeSessionProvenance> {
  let lastCandidateError: Error | null = null;
  for (let attempt = 0; attempt < SESSION_DISCOVERY_ATTEMPTS; attempt += 1) {
    const after = await snapshotNativeSessionState({ home: input.home });
    try {
      return await discoverNativeSession({ before: input.before, after, home: input.home });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "codex-session-candidate-count") throw error;
      lastCandidateError = error;
      if (attempt + 1 < SESSION_DISCOVERY_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, SESSION_DISCOVERY_DELAY_MS));
      }
    }
  }
  throw lastCandidateError ?? new Error("codex-session-candidate-count");
}

async function createVerifierServices(configuration: CodexSplitVerifyConfiguration): Promise<CodexSplitVerifierServices> {
  const docker = new DockerEngineClient(configuration.dockerSocketPath);
  await docker.assertRootlessAvailable();
  const roots: ManagedWorkspaceRoots = {
    projects: path.join(configuration.managedRoot, "projects"),
    workspaces: path.join(configuration.managedRoot, "workspaces"),
    state: path.join(configuration.managedRoot, "state")
  };
  const managed = new ManagedWorkspaces(roots);
  await managed.initialize();
  const runtime = new CodexSplitRuntime({
    managed, docker, stateRoot: roots.state,
    controlImageReference: configuration.controlImageReference,
    codexExecutablePath: configuration.codexExecutablePath
  });
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error("codex-split-agent-owner-unavailable");
  const home = await ensureNativeCodexHome({ homePath: nativeCodexHomePath(roots.state), ownerUid: uid, ownerGid: gid });
  return { docker, managed, runtime, home };
}

async function runGateInternal(input: {
  readonly configuration: CodexSplitVerifyConfiguration;
  readonly operator: CodexSplitOperator;
  readonly services: CodexSplitVerifierServices;
  readonly runId: string;
}): Promise<{ readonly evidence: CodexSplitLiveEvidence; readonly ensured: boolean; readonly canary: CanaryBinding | null }> {
  const { configuration, operator, services, runId } = input;
  const { docker, managed, runtime, home } = services;
  let ensured = false;
  let canary: CanaryBinding | null = null;
  const initialProcesses: ProcessObservation[] = [];
  let record: CodexSplitRuntimeRecord | null = null;
  let networkEvidence: NetworkObservation | null = null;
  let context: WorkspaceExecutionContext;
  let git: Awaited<ReturnType<ManagedWorkspaces["codexExecutorGitBinding"]>>;
  try {
    await probeAdmittedCodexVersion({ executablePath: configuration.codexExecutablePath });
    record = await runtime.ensure({ projectId: configuration.projectId, workspaceId: configuration.workspaceId });
    ensured = true;
    context = await managed.executionContext(configuration.projectId, configuration.workspaceId);
    git = await managed.codexExecutorGitBinding(configuration.projectId, configuration.workspaceId);
    canary = await createCanary(home, runId);
    const [control, executor] = await Promise.all([docker.inspectContainer(record.control.id), docker.inspectContainer(record.executor.id)]);
    const imagePlan: RuntimePlanV1 = compileRuntimePlanV1(context.options);
    const expectedImage = imagePlan.developmentContainer.source.kind === "image" ? imagePlan.developmentContainer.source.imageReference : null;
    const executorImageExact = expectedImage !== null && executor.Image === record.executor.imageId && executor.Config.Image === expectedImage;
    const physicalHomeSeparation = allowedControlMounts(control, home)
      && !control.Mounts.some((mount) => [git.worktreePath, git.repositoryPath, git.administrationPath]
        .some((projectPath) => pathsOverlap(mount.Source, projectPath)))
      && allowedExecutorMounts(executor, context, git)
      && !executor.Mounts.some((mount) => mount.Destination === home.mountTarget || pathsOverlap(mount.Source, home.homePath));
    const controlHardened = hardenedContainer(control, 2) && hasRequiredEnvironment(control, {
      CODEX_HOME: "/codex-home", HOME: "/codex-home", CODEX_EXEC_SERVER_URL: record.executor.endpointUrl
    }) && !hasCredentialEnvironment(control);
    const executorHardened = hardenedContainer(executor, 1) && !hasCredentialEnvironment(executor)
      && (executor.Config.Env ?? []).every((entry) => !entry.startsWith("CODEX_HOME="));
    const network = await collectNetworkEvidence({ docker, record, control, executor });
    networkEvidence = network;
    const processes = await observeProcesses(docker, record);
    initialProcesses.push(...processes);
    const staticConfig = await assertConfigurationMatrix({ home, context, endpoint: endpointFromRecord(record), stateRoot: path.join(configuration.managedRoot, "state") });
    const canaryProbe = await verifyCanaryIsolation({ docker, executorId: record.executor.id, canary, runId });
    if (canaryProbe.status === "fail") {
      return {
        evidence: {
          ...baseEvidence(runId, null),
          transportSecurity: record.executor.transportSecurity,
          physicalHomeSeparation,
          noLocalFallback: false,
          securityViolation: true,
          mountObservations: [{ role: "control", allowedMounts: allowedControlMounts(control, home) }, { role: "executor", allowedMounts: allowedExecutorMounts(executor, context, git) }],
          processObservations: processes,
          networkObservations: [network]
        }, ensured, canary
      };
    }
    if (canaryProbe.status === "unavailable") throw new Error("codex-split-canary-proof-unavailable");
    if (!controlHardened || !executorHardened || !executorImageExact || !physicalHomeSeparation || !staticConfig.passed
      || network.endpointPublished || network.hostNetworkListener || network.securityViolation) {
      return {
        evidence: {
          ...baseEvidence(runId, null), transportSecurity: record.executor.transportSecurity,
          physicalHomeSeparation, securityViolation: true,
          mountObservations: [{ role: "control", allowedMounts: allowedControlMounts(control, home) }, { role: "executor", allowedMounts: allowedExecutorMounts(executor, context, git) }],
          processObservations: processes, networkObservations: [network]
        }, ensured, canary
      };
    }
    if (!network.probeComplete) {
      throw new Error("codex-split-network-proof-incomplete");
    }
    operator.printChecklist(buildCodexSplitManualChecklist());
    const before = await snapshotNativeSessionState({ home });
    const pty = await runtime.startNewSession({ projectId: configuration.projectId, workspaceId: configuration.workspaceId, columns: 120, rows: 40 });
    const first = await observeDuringAttach({ docker, record, operator, pty });
    if (first.result !== "exited") throw new Error("codex-split-operator-aborted");
    const provenance = await discoverNativeSessionEventually({ before, home });
    const resumePty = await runtime.startResume({ projectId: configuration.projectId, workspaceId: configuration.workspaceId,
      nativeSessionId: provenance.nativeSessionId, columns: 120, rows: 40 });
    const resumed = await observeDuringAttach({ docker, record, operator, pty: resumePty });
    if (resumed.result !== "exited") throw new Error("codex-split-operator-aborted");
    const currentHome = await lstatIdentity(home.homePath);
    if (currentHome === null || !identitiesEqual(currentHome.identity, home.identity)) throw new Error("codex-split-home-identity");
    const allProcesses = [...processes, ...first.observations, ...resumed.observations];
    const controlProjectProcess = allProcesses.some((observation) => observation.role === "control" && observation.projectProcessCount > 0);
    const executorProjectProcess = allProcesses.some((observation) => observation.role === "executor" && observation.projectProcessCount > 0);
    const negativePathsPassed = staticConfig.passed && canaryProbe.status === "pass" && !network.endpointPublished;
    const sections: CodexSplitGateEvidence["sections"] = {
      A: controlHardened && physicalHomeSeparation && network.controlCodexServiceReachableOnEgress && !controlProjectProcess,
      B: executorHardened && executorImageExact && physicalHomeSeparation && network.executionNetworkExpectedMembers,
      C: executorProjectProcess && !controlProjectProcess,
      D: network.executionNetworkExpectedMembers && network.controlEgressExpectedMembers
        && network.controlCodexServiceReachableOnEgress && network.executorEndpointReachableOnExecution
        && !network.executorEndpointReachableFromControlEgress && !network.executorInternetReachable
        && !network.executorControlEgressGatewayReachable && !network.executorControlEgressAddressReachable
        && !network.executorHostReachable
        && !network.executorUnrelatedServiceReachable && network.controlForwardingDisabled
        && network.controlRoutingCapabilitiesAbsent && network.controlProxyProcessAbsent && !network.endpointPublished
        && !network.hostNetworkListener && network.probeComplete,
      E: currentHome !== null && identitiesEqual(currentHome.identity, home.identity),
      F: negativePathsPassed
    };
    const preliminary: CodexSplitLiveEvidence = {
      runId, admittedCodexVersion: "0.153.4", sections, transportSecurity: record.executor.transportSecurity,
      liveOperatorProof: false, physicalHomeSeparation, noLocalFallback: negativePathsPassed,
      controlModelEgressProven: network.controlCodexServiceReachableOnEgress,
      executorCannotReachControlEgressProven: !network.executorInternetReachable && !network.executorControlEgressGatewayReachable
        && !network.executorControlEgressAddressReachable && !network.executorHostReachable
        && !network.executorUnrelatedServiceReachable,
      controlRoutingDisabledProven: network.controlForwardingDisabled && network.controlRoutingCapabilitiesAbsent
        && network.controlProxyProcessAbsent,
      securityViolation: false, incompleteReason: null, unsupportedReason: null, evidenceVersion: 1,
      processObservations: allProcesses,
      mountObservations: [{ role: "control", allowedMounts: allowedControlMounts(control, home) }, { role: "executor", allowedMounts: allowedExecutorMounts(executor, context, git) }],
      networkObservations: [network]
    };
    const manualResult = await operator.confirmFinalResult();
    const finalEvidence: CodexSplitLiveEvidence = { ...preliminary, liveOperatorProof: manualResult === "PASS", securityViolation: manualResult === "FAIL" };
    if (evaluateCodexSplitOutcome(finalEvidence) === "PASS" || evaluateCodexSplitOutcome(finalEvidence) === "PASS-WITH-TRANSPORT-BLOCK") {
      return { evidence: finalEvidence, ensured, canary };
    }
    return { evidence: finalEvidence, ensured, canary };
  } catch (error) {
    const diagnostic = formatCodexSplitDiagnostic("live-gate", error, "verifier");
    const logger: StructuredLogger = createLogger({ component: "agent", subsystem: "codex-split-verifier" });
    logger.error("codex.split.verifier.incomplete", "Codex split feasibility verifier stopped", {
      reason: diagnostic.reasonCode, errorCode: diagnostic.reasonCode
    });
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    const reason = safeReason(error);
    return {
      evidence: {
        ...baseEvidence(runId, reason === "codex-split-operator-aborted" ? "operator-aborted" : reason),
        ...(record === null ? {} : { transportSecurity: record.executor.transportSecurity }),
        securityViolation: isSecurityReason(error),
        processObservations: initialProcesses,
        networkObservations: networkEvidence === null ? [] : [networkEvidence]
      }, ensured, canary
    };
  }
}

export async function runCodexSplitFeasibilityGate(input: {
  readonly configuration: CodexSplitVerifyConfiguration;
  readonly operator: CodexSplitOperator;
  readonly services?: CodexSplitVerifierServices;
}): Promise<CodexSplitLiveEvidence> {
  const runId = uuidv7();
  let services: CodexSplitVerifierServices | undefined;
  let ensured = false;
  let canary: CanaryBinding | null = null;
  let evidence: CodexSplitLiveEvidence;
  try {
    services = input.services ?? await createVerifierServices(input.configuration);
    const result = await runGateInternal({ ...input, services, runId });
    evidence = result.evidence;
    ensured = result.ensured;
    canary = result.canary;
  } catch (error) {
    const diagnostic = formatCodexSplitDiagnostic("setup", error, "verifier");
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    evidence = { ...baseEvidence(runId, safeReason(error)), securityViolation: isSecurityReason(error) };
  }
  let cleanupFailed = false;
  if (canary !== null) {
    try { await cleanupCanary(canary); } catch { cleanupFailed = true; }
  }
  if (ensured && services !== undefined) {
    try {
      await services.runtime.stop({ projectId: input.configuration.projectId, workspaceId: input.configuration.workspaceId });
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed && !evidence.securityViolation) evidence = { ...evidence, incompleteReason: "cleanup-failed" };
  return evidence;
}

export function createCodexSplitTerminalOperator(): CodexSplitOperator {
  return {
    printChecklist(text: string): void { process.stderr.write(`${text}\n`); },
    attach(pty: NativeCodexPty): Promise<"exited" | "aborted"> {
      return new Promise((resolve) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        let finished = false;
        const onData = (chunk: Buffer): void => { stdout.write(chunk); };
        const cleanup = (): void => {
          stdin.off("data", inputListener);
          stdin.off("end", onInputEnd);
          stdin.off("close", onInputEnd);
          process.off("SIGINT", onSigint);
          pty.stream.off("data", onData);
          if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(false);
        };
        const finish = (result: "exited" | "aborted"): void => {
          if (finished) return;
          finished = true;
          cleanup();
          resolve(result);
        };
        const abort = (): void => {
          finish("aborted");
          pty.stream.destroy();
        };
        const onInputEnd = (): void => { abort(); };
        const onSigint = (): void => { abort(); };
        const inputListener = (chunk: Buffer): void => {
          if (chunk.includes(0x03)) {
            abort();
            return;
          }
          pty.stream.write(chunk);
        };
        stdin.on("data", inputListener);
        stdin.once("end", onInputEnd);
        stdin.once("close", onInputEnd);
        process.once("SIGINT", onSigint);
        pty.stream.on("data", onData);
        if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(true);
        pty.stream.once("close", () => finish("exited"));
        pty.stream.once("error", () => finish("aborted"));
      });
    },
    async confirmFinalResult(): Promise<"PASS" | "FAIL"> {
      return await new Promise<"PASS" | "FAIL">((resolve, reject) => {
        const stdin = process.stdin;
        let settled = false;
        const cleanup = (): void => {
          stdin.off("data", onData);
          stdin.off("end", onAbort);
          stdin.off("close", onAbort);
          stdin.off("error", onAbort);
          process.off("SIGINT", onSigint);
        };
        const finish = (result: "PASS" | "FAIL"): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };
        const abort = (reason: string): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(reason));
        };
        const onData = (chunk: Buffer): void => {
          const text = chunk.toString("utf8");
          if (text.includes("\u0003")) {
            abort("codex-split-operator-aborted");
            return;
          }
          try {
            finish(parseCodexSplitOperatorAnswer(text));
          } catch (error) {
            abort(error instanceof Error ? error.message : "codex-split-operator-answer-invalid");
          }
        };
        const onAbort = (): void => { abort("codex-split-operator-aborted"); };
        const onSigint = (): void => { abort("codex-split-operator-aborted"); };
        process.stderr.write("After every A-F check is complete, type PASS or FAIL (outside Codex): ");
        if (stdin.readableEnded || stdin.destroyed) {
          onAbort();
          return;
        }
        stdin.on("data", onData);
        stdin.once("end", onAbort);
        stdin.once("close", onAbort);
        stdin.once("error", onAbort);
        process.once("SIGINT", onSigint);
      });
    }
  };
}
