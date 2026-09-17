import { unlink } from "node:fs/promises";
import path from "node:path";
import { uuidV7Schema } from "@devspace/contracts";
import {
  assertContained,
  durableJsonWriter,
  establishPinnedDirectory,
  identitiesEqual,
  PrivateStateCorruptionError,
  readRegularFileNoFollow,
  type AtomicJsonWriter
} from "../private-state.js";
import {
  DockerEngineClient,
  DockerEngineError,
  type DockerContainerInspection,
  type DockerNetworkInspection
} from "../docker-runtime.js";
import type { ManagedWorkspaces, WorkspaceExecutionContext } from "../managed-workspaces.js";
import { probeAdmittedCodexVersion } from "./compatibility.js";
import {
  assertCodexSplitArtifactCapabilities,
  prepareCodexSplitArtifact,
  type CodexSplitArtifactBinding
} from "./artifact.js";
import {
  buildCodexProjectExecutorPolicy,
  createCodexProjectExecutor,
  type CodexProjectExecutorBinding,
  assertCodexProjectExecutorInspection
} from "./project-executor.js";
import {
  createCodexSplitNetwork,
  assertCodexSplitNetworkInspection,
  type CodexSplitNetworkBinding
} from "./network.js";
import {
  assertCodexExecServerReady,
  startCodexExecServer,
  type CodexExecServerHandle
} from "./exec-server.js";
import {
  assertCodexCodeModeHostReady,
  buildCodexCodeModeHostPolicy,
  reattachCodexCodeModeHost,
  startCodexCodeModeHost,
  type CodexCodeModeHostHandle
} from "./code-mode-host.js";
import {
  createCodexSplitTransportBinding,
  type CodexSplitTransportBinding
} from "./transport.js";
import {
  buildRemoteOnlyConfiguration,
  prepareCodexManagedPolicy,
  type CodexRemoteOnlyConfiguration
} from "./remote-policy.js";
import {
  buildCodexControlSidecarPolicy,
  createCodexControlSidecar,
  assertCodexControlSidecarInspection,
  type CodexControlSidecarBinding,
  type CodexControlSidecarPolicy
} from "./control-sidecar.js";
import {
  assertCodexNativeAppServerReady,
  buildCodexNativeAppServerPolicy,
  reattachCodexNativeAppServer,
  startCodexNativeAppServer,
  type CodexNativeAppServerHandle
} from "./native-app-server.js";
import {
  nativeCodexHomePath,
  ensureNativeCodexHome,
  type CodexNativeHomeBinding,
  type WorkspaceGitAdministrationBinding
} from "./native-home.js";
import {
  startNativeCodexPty,
  type NativeCodexPty
} from "./native-pty.js";
import {
  discoverNativeSession,
  snapshotNativeSessionState,
  type NativeSessionSnapshot
} from "./session-provenance.js";
import {
  assertCodexSplitHomeIdentity,
  assertCodexSplitSessionConcurrency,
  codexSplitRuntimeRecordSchema,
  parseCodexSplitRuntimeRecord,
  parseCodexSplitRuntimeResourceReference,
  type CodexSplitRuntimeRecord,
  type CodexSplitRuntimeResourceReference,
  type CodexSplitSessionRecord
} from "./runtime-record.js";

const EXEC_SERVER_PORT = 4545;
const CONTROL_ROLE = "codex-control";
const EXECUTOR_ROLE = "codex-split-executor";

export interface CodexSplitRuntimeAssembly {
  readonly home: CodexNativeHomeBinding;
  readonly artifact: CodexSplitArtifactBinding;
  readonly network: CodexSplitNetworkBinding;
  readonly executor: CodexProjectExecutorBinding;
  readonly transport: CodexSplitTransportBinding;
  readonly server: CodexExecServerHandle;
  readonly codeModeHost: CodexCodeModeHostHandle;
  readonly appServer: CodexNativeAppServerHandle;
  readonly remote: CodexRemoteOnlyConfiguration;
  readonly control: CodexControlSidecarBinding;
}

export interface CodexSplitRuntimeAssemblyInput {
  readonly context: WorkspaceExecutionContext;
  readonly git: WorkspaceGitAdministrationBinding;
  readonly stateRoot: string;
  readonly controlImageReference: string;
  readonly codexExecutablePath: string;
}

export interface CodexSplitRuntimePtyInput {
  readonly control: CodexControlSidecarBinding;
  readonly resumeSessionId: string | null;
  readonly columns: number;
  readonly rows: number;
}

/**
 * These hooks are deliberately limited to the two external edges that make
 * lifecycle tests deterministic. Production uses the concrete split policy
 * functions below; no hook can request a local process or a workspace mount in
 * the control sidecar.
 */
export interface CodexSplitRuntimeDependencies {
  readonly buildAssembly?: (input: CodexSplitRuntimeAssemblyInput & { readonly docker: DockerEngineClient }) => Promise<CodexSplitRuntimeAssembly>;
  readonly reattachAssembly?: (input: {
    readonly docker: DockerEngineClient;
    readonly record: CodexSplitRuntimeRecord;
    readonly context: WorkspaceExecutionContext;
    readonly git: WorkspaceGitAdministrationBinding;
    readonly stateRoot: string;
    readonly controlImageReference: string;
    readonly codexExecutablePath: string;
  }) => Promise<CodexSplitRuntimeAssembly>;
  readonly startPty?: (input: CodexSplitRuntimePtyInput & { readonly docker: DockerEngineClient }) => Promise<NativeCodexPty>;
  readonly now?: () => string;
  readonly writer?: AtomicJsonWriter;
}

function splitResourceName(workspaceId: string, generation: number, role: "control" | "executor"): string {
  const opaque = uuidV7Schema.parse(workspaceId).replaceAll("-", "");
  return `devspace-codex-${opaque}-g${generation}-${role}`;
}

function splitStateRoot(stateRoot: string): string {
  const root = pathAbsolute(stateRoot, "codex-split-state-root-invalid");
  return assertContained(root, path.join(root, "codex-split"));
}

function pathAbsolute(value: string, errorCode: string): string {
  if (!value.startsWith("/") || value.includes("\0")) throw new Error(errorCode);
  return path.resolve(value);
}

function recordPath(stateRoot: string, workspaceId: string): string {
  const root = splitStateRoot(stateRoot);
  return assertContained(root, path.join(root, `${uuidV7Schema.parse(workspaceId)}.json`));
}

function networkLabels(context: WorkspaceExecutionContext): Record<string, string> {
  return {
    "devspace.project-id": context.projectId,
    "devspace.revision-id": context.revisionId,
    "devspace.revision-hash": context.revisionHash,
    "devspace.runtime-plan-hash": context.runtimePlanHash
  };
}

async function buildDefaultAssembly(input: CodexSplitRuntimeAssemblyInput & { readonly docker: DockerEngineClient }): Promise<CodexSplitRuntimeAssembly> {
  await probeAdmittedCodexVersion({ executablePath: input.codexExecutablePath });
  const ownerUid = process.getuid?.();
  const ownerGid = process.getgid?.();
  if (ownerUid === undefined || ownerGid === undefined) throw new Error("codex-split-agent-owner-unavailable");
  const home = await ensureNativeCodexHome({
    homePath: nativeCodexHomePath(input.stateRoot), ownerUid, ownerGid
  });
  const artifact = await prepareCodexSplitArtifact({ configuredPath: input.codexExecutablePath, stateRoot: input.stateRoot });
  const network = await createCodexSplitNetwork({
    docker: input.docker, workspaceId: input.context.workspaceId, generation: input.context.generation,
    labels: networkLabels(input.context)
  });
  let executor: CodexProjectExecutorBinding | null = null;
  let control: CodexControlSidecarBinding | null = null;
  try {
    const executorPolicy = await buildCodexProjectExecutorPolicy({
      docker: input.docker, context: input.context, git: input.git, network, artifact, imagePort: EXEC_SERVER_PORT
    });
    executor = await createCodexProjectExecutor({
      docker: input.docker, policy: executorPolicy,
      name: splitResourceName(input.context.workspaceId, input.context.generation, "executor")
    });
    const executorImage = await input.docker.inspectImage(executorPolicy.imageId);
    const capabilities = assertCodexSplitArtifactCapabilities({ artifact, image: executorImage });
    const transport = createCodexSplitTransportBinding({
      executor, network, protocolAuthenticationVerified: false, privateNetworkIsolationVerified: true,
      admittedVersion: "0.153.4"
    });
    const server = await startCodexExecServer({ docker: input.docker, executor, transport });
    await assertCodexExecServerReady({ docker: input.docker, handle: server });
    const codeModeHostPolicy = buildCodexCodeModeHostPolicy({ executor, artifact: capabilities });
    const codeModeHost = await startCodexCodeModeHost({ docker: input.docker, policy: codeModeHostPolicy });
    await assertCodexCodeModeHostReady({ docker: input.docker, handle: codeModeHost, policy: codeModeHostPolicy });
    const managedPolicy = await prepareCodexManagedPolicy({
      stateRoot: input.stateRoot, home, endpoint: transport, admittedVersion: "0.153.4"
    });
    const remote = buildRemoteOnlyConfiguration({
      home, endpoint: transport, policy: managedPolicy, codeModeHostUrl: codeModeHost.endpoint.url
    });
    const controlPolicy = await buildCodexControlSidecarPolicy({
      imageReference: input.controlImageReference, home, artifact, remote, network
    });
    control = await createCodexControlSidecar({
      docker: input.docker, policy: controlPolicy,
      name: splitResourceName(input.context.workspaceId, input.context.generation, "control")
    });
    const appServerControl = { ...control.policy, containerId: control.containerId } as CodexControlSidecarPolicy;
    const appServerPolicy = buildCodexNativeAppServerPolicy({
      control: appServerControl, artifact: capabilities, codeModeHost: codeModeHost.endpoint
    });
    const appServer = await startCodexNativeAppServer({ docker: input.docker, policy: appServerPolicy });
    await assertCodexNativeAppServerReady({ docker: input.docker, handle: appServer, policy: appServerPolicy });
    return { home, artifact, network, executor, transport, server, codeModeHost, appServer, remote, control };
  } catch (error) {
    if (control !== null) await input.docker.removeContainer(control.containerId).catch(() => undefined);
    if (executor !== null) await input.docker.removeContainer(executor.containerId).catch(() => undefined);
    await input.docker.removeNetwork(network.controlEgress.id).catch(() => undefined);
    await input.docker.removeNetwork(network.execution.id).catch(() => undefined);
    throw error;
  }
}

export function recordFromAssembly(input: {
  readonly context: WorkspaceExecutionContext;
  readonly git: WorkspaceGitAdministrationBinding;
  readonly assembly: CodexSplitRuntimeAssembly;
  readonly sessions: readonly CodexSplitSessionRecord[];
}): CodexSplitRuntimeRecord {
  return parseCodexSplitRuntimeRecord({
    version: 2,
    projectId: input.context.projectId,
    workspaceId: input.context.workspaceId,
    revisionId: input.context.revisionId,
    runtimePlanHash: input.context.runtimePlanHash,
    generation: input.context.generation,
    networks: {
      execution: {
        id: input.assembly.network.execution.id, name: input.assembly.network.execution.name,
        role: "execution", internal: true, defaultRoute: false
      },
      controlEgress: {
        id: input.assembly.network.controlEgress.id, name: input.assembly.network.controlEgress.name,
        role: "control-egress", internal: false, defaultRoute: true
      }
    },
    artifact: {
      packageVersion: input.assembly.artifact.packageVersion,
      closureDigest: input.assembly.artifact.closureDigest,
      nativeCliPath: input.assembly.artifact.entrypointPath,
      execServerCapability: "codex-0.153.4-exec-server",
      appServerCapability: "codex-0.153.4-app-server",
      codeModeHostCapability: "codex-0.153.4-code-mode-host"
    },
    executor: {
      id: input.assembly.executor.containerId,
      imageId: input.assembly.executor.policy.imageId,
      imageReference: input.assembly.executor.policy.imageReference,
      imageArchitecture: input.assembly.executor.policy.imageArchitecture,
      worktreeIdentity: input.git.worktreeIdentity,
      repositoryIdentity: input.git.repositoryIdentity,
      administrationIdentity: input.git.administrationIdentity,
      endpointUrl: input.assembly.transport.endpointUrl,
      transportSecurity: input.assembly.transport.security
    },
    execServer: {
      executorContainerId: input.assembly.server.executorContainerId,
      execId: input.assembly.server.execId,
      endpointUrl: input.assembly.server.endpoint.endpointUrl,
      serverPid: input.assembly.server.serverPid,
      transportSecurity: input.assembly.transport.security
    },
    codeModeHost: {
      executorContainerId: input.assembly.codeModeHost.executorContainerId,
      execId: input.assembly.codeModeHost.execId,
      serverPid: input.assembly.codeModeHost.serverPid,
      host: input.assembly.codeModeHost.endpoint.host,
      port: input.assembly.codeModeHost.endpoint.port,
      url: input.assembly.codeModeHost.endpoint.url,
      listenUrl: input.assembly.codeModeHost.endpoint.listenUrl,
      networkId: input.assembly.codeModeHost.endpoint.networkId,
      transportSecurity: input.assembly.codeModeHost.transportSecurity
    },
    control: {
      id: input.assembly.control.containerId,
      homeBinding: "owner-default",
      homeIdentity: input.assembly.home.identity,
      appServer: {
        controlContainerId: input.assembly.appServer.controlContainerId,
        execId: input.assembly.appServer.execId,
        serverPid: input.assembly.appServer.serverPid,
        socketPath: input.assembly.appServer.socketPath,
        socketIdentity: input.assembly.appServer.socketIdentity,
        homeIdentity: input.assembly.home.identity,
        codeModeHostUrl: input.assembly.appServer.codeModeHostUrl,
        transportSecurity: input.assembly.appServer.transportSecurity
      }
    },
    sessions: [...input.sessions]
  });
}

function contextMatchesRecord(context: WorkspaceExecutionContext, record: CodexSplitRuntimeRecord): boolean {
  return context.projectId === record.projectId && context.workspaceId === record.workspaceId
    && context.revisionId === record.revisionId && context.runtimePlanHash === record.runtimePlanHash
    && context.generation === record.generation;
}

function assertNetworkResource(
  inspection: DockerNetworkInspection,
  expected: {
    readonly id: string;
    readonly name: string;
    readonly role: "execution" | "control-egress";
    readonly projectId: string;
    readonly workspaceId: string;
    readonly generation: number;
  }
): void {
  if (inspection.Id !== expected.id || inspection.Name !== expected.name
    || inspection.Labels["devspace.managed"] !== "true"
    || inspection.Labels["devspace.codex-split"] !== "true"
    || inspection.Labels["devspace.project-id"] !== expected.projectId
    || inspection.Labels["devspace.workspace-id"] !== expected.workspaceId
    || inspection.Labels["devspace.runtime-generation"] !== String(expected.generation)
    || inspection.Labels["devspace.resource-role"] !== expected.role
    || inspection.Name === "bridge"
    || inspection.Internal !== (expected.role === "execution")) {
    throw new Error("codex-split-runtime-network-ownership");
  }
}

function assertContainerResource(
  inspection: DockerContainerInspection,
  expected: {
    readonly id: string;
    readonly name: string;
    readonly role: typeof CONTROL_ROLE | typeof EXECUTOR_ROLE;
    readonly workspaceId: string;
    readonly generation: number;
  }
): void {
  if (inspection.Id !== expected.id || inspection.Config.Labels["devspace.managed"] !== "true"
    || inspection.Config.Labels["devspace.codex-split"] !== "true"
    || inspection.Config.Labels["devspace.workspace-id"] !== expected.workspaceId
    || inspection.Config.Labels["devspace.runtime-generation"] !== String(expected.generation)
    || inspection.Config.Labels["devspace.resource-role"] !== expected.role
    || inspection.Name.replace(/^\//u, "") !== expected.name) {
    throw new Error("codex-split-runtime-container-ownership");
  }
}

function assertNetworkMembers(
  inspection: DockerNetworkInspection,
  expected: readonly { readonly id: string; readonly name: string }[]
): void {
  const members = Object.entries(inspection.Containers ?? {});
  if (members.length !== expected.length || expected.some((member) => {
    const observed = members.find(([id]) => id === member.id)?.[1];
    return observed?.Name !== `/${member.name}` && observed?.Name !== member.name;
  })) {
    throw new Error("codex-split-runtime-network-members");
  }
}

async function inspectAssemblyResources(input: {
  readonly docker: DockerEngineClient;
  readonly assembly: CodexSplitRuntimeAssembly;
}): Promise<void> {
  const [execution, controlEgress, executor, control] = await Promise.all([
    input.docker.inspectNetwork(input.assembly.network.execution.id),
    input.docker.inspectNetwork(input.assembly.network.controlEgress.id),
    input.docker.inspectContainer(input.assembly.executor.containerId),
    input.docker.inspectContainer(input.assembly.control.containerId)
  ]);
  assertNetworkResource(execution, {
    ...input.assembly.network.execution, role: "execution", projectId: input.assembly.executor.policy.projectId
  });
  assertNetworkResource(controlEgress, {
    ...input.assembly.network.controlEgress, role: "control-egress", projectId: input.assembly.executor.policy.projectId
  });
  assertNetworkMembers(execution, [
    { id: input.assembly.executor.containerId, name: input.assembly.executor.containerName },
    { id: input.assembly.control.containerId, name: input.assembly.control.containerName }
  ]);
  assertNetworkMembers(controlEgress, [{ id: input.assembly.control.containerId, name: input.assembly.control.containerName }]);
  assertContainerResource(executor, {
    id: input.assembly.executor.containerId, name: input.assembly.executor.containerName, role: EXECUTOR_ROLE,
    workspaceId: input.assembly.executor.policy.workspaceId, generation: input.assembly.executor.policy.generation
  });
  assertContainerResource(control, {
    id: input.assembly.control.containerId, name: input.assembly.control.containerName, role: CONTROL_ROLE,
    workspaceId: input.assembly.network.execution.workspaceId, generation: input.assembly.network.execution.generation
  });
  const executorNetworks = executor.NetworkSettings.Networks ?? {};
  const controlNetworks = control.NetworkSettings.Networks ?? {};
  if (Object.keys(executorNetworks).length !== 1
    || executorNetworks[input.assembly.network.execution.name]?.NetworkID !== input.assembly.network.execution.id
    || Object.keys(controlNetworks).length !== 2
    || controlNetworks[input.assembly.network.execution.name]?.NetworkID !== input.assembly.network.execution.id
    || controlNetworks[input.assembly.network.controlEgress.name]?.NetworkID !== input.assembly.network.controlEgress.id) {
    throw new Error("codex-split-runtime-network-attachment");
  }
}

function hasDockerNotFoundCause(error: unknown): boolean {
  if (error instanceof DockerEngineError) return error.statusCode === 404;
  if (!(error instanceof Error)) return false;
  const cause = (error as Error & { readonly cause?: unknown }).cause;
  return cause !== undefined && hasDockerNotFoundCause(cause);
}

async function inspectOptional<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DockerEngineError && error.statusCode === 404) return null;
    throw error;
  }
}

async function removeOptional(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof DockerEngineError && error.statusCode === 404)) throw error;
  }
}

async function discardStaleRuntimeResources(input: {
  readonly docker: DockerEngineClient;
  readonly record: CodexSplitRuntimeResourceReference;
}): Promise<void> {
  const { record, docker } = input;
  const executorName = splitResourceName(record.workspaceId, record.generation, "executor");
  const controlName = splitResourceName(record.workspaceId, record.generation, "control");
  const [execution, controlEgress, executor, control] = await Promise.all([
    inspectOptional(() => docker.inspectNetwork(record.networks.execution.id)),
    inspectOptional(() => docker.inspectNetwork(record.networks.controlEgress.id)),
    inspectOptional(() => docker.inspectContainer(record.executor.id)),
    inspectOptional(() => docker.inspectContainer(record.control.id))
  ]);

  if (execution !== null) {
    assertNetworkResource(execution, {
      ...record.networks.execution, role: "execution", projectId: record.projectId,
      workspaceId: record.workspaceId, generation: record.generation
    });
  }
  if (controlEgress !== null) {
    assertNetworkResource(controlEgress, {
      ...record.networks.controlEgress, role: "control-egress", projectId: record.projectId,
      workspaceId: record.workspaceId, generation: record.generation
    });
  }
  if (executor !== null) {
    assertContainerResource(executor, {
      id: record.executor.id, name: executorName, role: EXECUTOR_ROLE,
      workspaceId: record.workspaceId, generation: record.generation
    });
  }
  if (control !== null) {
    assertContainerResource(control, {
      id: record.control.id, name: controlName, role: CONTROL_ROLE,
      workspaceId: record.workspaceId, generation: record.generation
    });
  }

  const executionMembers = [
    executor === null ? null : { id: record.executor.id, name: executorName },
    control === null ? null : { id: record.control.id, name: controlName }
  ].filter((member): member is { readonly id: string; readonly name: string } => member !== null);
  const egressMembers = control === null ? [] : [{ id: record.control.id, name: controlName }];
  if (execution !== null) assertNetworkMembers(execution, executionMembers);
  if (controlEgress !== null) assertNetworkMembers(controlEgress, egressMembers);

  if (executor !== null) await removeOptional(() => docker.removeContainer(record.executor.id));
  if (control !== null) await removeOptional(() => docker.removeContainer(record.control.id));
  if (controlEgress !== null) await removeOptional(() => docker.removeNetwork(record.networks.controlEgress.id));
  if (execution !== null) await removeOptional(() => docker.removeNetwork(record.networks.execution.id));
}

function isLive(state: CodexSplitSessionRecord["state"]): boolean {
  return state === "starting" || state === "live";
}

export class CodexSplitRuntime {
  private readonly runtimeStateRoot: string;
  private readonly assemblies = new Map<string, CodexSplitRuntimeAssembly>();
  private initialized = false;
  private readonly buildAssembly: (input: CodexSplitRuntimeAssemblyInput & { readonly docker: DockerEngineClient }) => Promise<CodexSplitRuntimeAssembly>;
  private readonly reattachAssembly: (input: {
    readonly docker: DockerEngineClient;
    readonly record: CodexSplitRuntimeRecord;
    readonly context: WorkspaceExecutionContext;
    readonly git: WorkspaceGitAdministrationBinding;
    readonly stateRoot: string;
    readonly controlImageReference: string;
    readonly codexExecutablePath: string;
  }) => Promise<CodexSplitRuntimeAssembly>;
  private readonly startPty: (input: CodexSplitRuntimePtyInput & { readonly docker: DockerEngineClient }) => Promise<NativeCodexPty>;
  private readonly now: () => string;
  private readonly writer: AtomicJsonWriter;

  constructor(input: {
    readonly managed: ManagedWorkspaces;
    readonly docker: DockerEngineClient;
    readonly stateRoot: string;
    readonly controlImageReference: string;
    readonly codexExecutablePath: string;
  }, dependencies: CodexSplitRuntimeDependencies = {}) {
    this.managed = input.managed;
    this.docker = input.docker;
    this.stateRoot = pathAbsolute(input.stateRoot, "codex-split-state-root-invalid");
    this.runtimeStateRoot = splitStateRoot(this.stateRoot);
    this.controlImageReference = input.controlImageReference;
    this.codexExecutablePath = input.codexExecutablePath;
    this.buildAssembly = dependencies.buildAssembly ?? buildDefaultAssembly;
    this.reattachAssembly = dependencies.reattachAssembly ?? buildDefaultReattachedAssembly;
    this.startPty = dependencies.startPty ?? (async (ptyInput) => await startNativeCodexPty({
      docker: ptyInput.docker,
      control: ptyInput.control,
      executablePath: "/opt/devspace/codex-launcher/codex",
      resumeSessionId: ptyInput.resumeSessionId,
      environment: ptyInput.control.policy.environment,
      columns: ptyInput.columns,
      rows: ptyInput.rows
    }));
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.writer = dependencies.writer ?? durableJsonWriter;
  }

  private readonly managed: ManagedWorkspaces;
  private readonly docker: DockerEngineClient;
  private readonly stateRoot: string;
  private readonly controlImageReference: string;
  private readonly codexExecutablePath: string;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await establishPinnedDirectory(this.runtimeStateRoot);
    this.initialized = true;
  }

  private async load(workspaceId: string, expectedContext?: WorkspaceExecutionContext): Promise<CodexSplitRuntimeRecord | null> {
    const filePath = recordPath(this.stateRoot, workspaceId);
    let parsed: unknown;
    try {
      const file = await readRegularFileNoFollow(filePath, 2 * 1024 * 1024);
      try {
        parsed = JSON.parse(file.bytes.toString("utf8")) as unknown;
      } catch {
        throw new PrivateStateCorruptionError(filePath, "invalid JSON");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return parseCodexSplitRuntimeRecord(parsed);
    } catch (error) {
      if (!(error instanceof Error) || error.message === "codex-split-session-live" || expectedContext === undefined) throw error;
      let reference: CodexSplitRuntimeResourceReference;
      try {
        reference = parseCodexSplitRuntimeResourceReference(parsed);
      } catch {
        throw error;
      }
      if (reference.projectId !== expectedContext.projectId || reference.workspaceId !== expectedContext.workspaceId
        || reference.generation !== expectedContext.generation) {
        throw new Error("codex-split-runtime-authority", { cause: error });
      }
      await discardStaleRuntimeResources({ docker: this.docker, record: reference });
      await unlink(filePath).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
      return null;
    }
  }

  private async save(record: CodexSplitRuntimeRecord): Promise<void> {
    await this.writer.write(recordPath(this.stateRoot, record.workspaceId), codexSplitRuntimeRecordSchema.parse(record));
  }

  private async authoritativeContext(projectId: string, workspaceId: string): Promise<{
    readonly context: WorkspaceExecutionContext;
    readonly git: WorkspaceGitAdministrationBinding;
  }> {
    await this.docker.assertRootlessAvailable();
    const context = await this.managed.executionContext(projectId, workspaceId);
    const git = await this.managed.codexExecutorGitBinding(projectId, workspaceId);
    return { context, git };
  }

  private async assemblyFor(
    context: WorkspaceExecutionContext,
    git: WorkspaceGitAdministrationBinding,
    existing: CodexSplitRuntimeRecord | null
  ): Promise<CodexSplitRuntimeAssembly> {
    const key = context.workspaceId;
    const retained = this.assemblies.get(key);
    if (retained !== undefined) return retained;
    if (existing !== null) {
      try {
        const reattached = await this.reattachAssembly({
          docker: this.docker, record: existing, context, git, stateRoot: this.stateRoot,
          controlImageReference: this.controlImageReference, codexExecutablePath: this.codexExecutablePath
        });
        this.assemblies.set(key, reattached);
        return reattached;
      } catch (error) {
        if (!hasDockerNotFoundCause(error)) throw error;
        await discardStaleRuntimeResources({ docker: this.docker, record: existing });
        await unlink(recordPath(this.stateRoot, existing.workspaceId)).catch((unlinkError: NodeJS.ErrnoException) => {
          if (unlinkError.code !== "ENOENT") throw unlinkError;
        });
        const rebuilt = await this.buildAssembly({
          docker: this.docker, context, git, stateRoot: this.stateRoot,
          controlImageReference: this.controlImageReference, codexExecutablePath: this.codexExecutablePath
        });
        this.assemblies.set(key, rebuilt);
        return rebuilt;
      }
    }
    const created = await this.buildAssembly({
      docker: this.docker, context, git, stateRoot: this.stateRoot,
      controlImageReference: this.controlImageReference, codexExecutablePath: this.codexExecutablePath
    });
    this.assemblies.set(key, created);
    return created;
  }

  async ensure(input: { readonly projectId: string; readonly workspaceId: string }): Promise<CodexSplitRuntimeRecord> {
    uuidV7Schema.parse(input.projectId);
    uuidV7Schema.parse(input.workspaceId);
    const { context, git } = await this.authoritativeContext(input.projectId, input.workspaceId);
    await this.initialize();
    const existing = await this.load(input.workspaceId, context);
    if (existing !== null && !contextMatchesRecord(context, existing)) throw new Error("codex-split-runtime-authority");
    if (existing !== null && existing.sessions.some((session) => session.state === "ambiguous")) {
      throw new Error("codex-split-runtime-ambiguous");
    }
    const assembly = await this.assemblyFor(context, git, existing);
    const record = recordFromAssembly({ context, git, assembly, sessions: existing?.sessions ?? [] });
    await this.save(record);
    return record;
  }

  private async currentAssembly(input: { readonly projectId: string; readonly workspaceId: string }): Promise<{
    readonly context: WorkspaceExecutionContext;
    readonly assembly: CodexSplitRuntimeAssembly;
    readonly record: CodexSplitRuntimeRecord;
  }> {
    const { context, git } = await this.authoritativeContext(input.projectId, input.workspaceId);
    await this.initialize();
    const record = await this.load(input.workspaceId, context);
    if (record === null || !contextMatchesRecord(context, record)) throw new Error("codex-split-runtime-authority");
    if (record.sessions.some((session) => session.state === "ambiguous")) throw new Error("codex-split-runtime-ambiguous");
    const assembly = await this.assemblyFor(context, git, record);
    return { context, assembly, record };
  }

  private async markSession(input: {
    readonly workspaceId: string;
    readonly nativeSessionId: string;
    readonly execId: string;
    readonly state: "live" | "stopped" | "ambiguous";
    readonly homeIdentity: CodexNativeHomeBinding["identity"];
    readonly startedAt: string;
    readonly stoppedAt: string | null;
  }): Promise<void> {
    const record = await this.load(input.workspaceId);
    if (record === null) return;
    const sessions = record.sessions.filter((session) => session.nativeSessionId !== input.nativeSessionId);
    const next = parseCodexSplitRuntimeRecord({
      ...record,
      sessions: [...sessions, {
        nativeSessionId: input.nativeSessionId, controlContainerId: record.control.id, controlExecId: input.execId,
        homeIdentity: input.homeIdentity, state: input.state, startedAt: input.startedAt, stoppedAt: input.stoppedAt
      }]
    });
    await this.save(next);
  }

  private observeResumeExit(input: {
    readonly workspaceId: string;
    readonly nativeSessionId: string;
    readonly execId: string;
    readonly homeIdentity: CodexNativeHomeBinding["identity"];
    readonly startedAt: string;
    readonly stream: NativeCodexPty["stream"];
  }): void {
    let completed = false;
    const finish = async (state: "stopped" | "ambiguous"): Promise<void> => {
      if (completed) return;
      completed = true;
      await this.markSession({
        workspaceId: input.workspaceId, nativeSessionId: input.nativeSessionId, execId: input.execId,
        state, homeIdentity: input.homeIdentity, startedAt: input.startedAt,
        stoppedAt: this.now()
      });
    };
    input.stream.once("end", () => { void finish("stopped").catch(() => undefined); });
    input.stream.once("close", () => { void finish("stopped").catch(() => undefined); });
    input.stream.once("error", () => { void finish("ambiguous").catch(() => undefined); });
  }

  async startNewSession(input: {
    readonly projectId: string;
    readonly workspaceId: string;
    readonly columns: number;
    readonly rows: number;
  }): Promise<NativeCodexPty> {
    const { assembly } = await this.currentAssembly(input);
    const before = await snapshotNativeSessionState({ home: assembly.home });
    const startedAt = this.now();
    const pty = await this.startPty({ docker: this.docker, control: assembly.control, resumeSessionId: null, columns: input.columns, rows: input.rows });
    this.observeNewSessionExit({ workspaceId: input.workspaceId, assembly, before, startedAt, pty });
    return pty;
  }

  private observeNewSessionExit(input: {
    readonly workspaceId: string;
    readonly assembly: CodexSplitRuntimeAssembly;
    readonly before: NativeSessionSnapshot;
    readonly startedAt: string;
    readonly pty: NativeCodexPty;
  }): void {
    let completed = false;
    const finish = async (): Promise<void> => {
      if (completed) return;
      completed = true;
      try {
        const after = await snapshotNativeSessionState({ home: input.assembly.home });
        const provenance = await discoverNativeSession({ before: input.before, after, home: input.assembly.home });
        await this.markSession({
          workspaceId: input.workspaceId, nativeSessionId: provenance.nativeSessionId, execId: input.pty.execId,
          state: "stopped", homeIdentity: provenance.homeIdentity, startedAt: input.startedAt, stoppedAt: this.now()
        });
      } catch {
        // A normal exit without exactly one provider-owned new ID is left
        // unbound. It is never guessed and never turned into a resumable ID.
      }
    };
    input.pty.stream.once("end", () => { void finish().catch(() => undefined); });
    input.pty.stream.once("close", () => { void finish().catch(() => undefined); });
  }

  async startResume(input: {
    readonly projectId: string;
    readonly workspaceId: string;
    readonly nativeSessionId: string;
    readonly columns: number;
    readonly rows: number;
  }): Promise<NativeCodexPty> {
    uuidV7Schema.parse(input.nativeSessionId);
    const { assembly, record } = await this.currentAssembly(input);
    assertCodexSplitSessionConcurrency(record, input.nativeSessionId);
    const knownSession = record.sessions.find((session) => session.nativeSessionId === input.nativeSessionId);
    if (knownSession !== undefined) assertCodexSplitHomeIdentity(knownSession.homeIdentity, assembly.home.identity);
    const startedAt = this.now();
    const pty = await this.startPty({
      docker: this.docker, control: assembly.control, resumeSessionId: input.nativeSessionId,
      columns: input.columns, rows: input.rows
    });
    await this.markSession({
      workspaceId: input.workspaceId, nativeSessionId: input.nativeSessionId, execId: pty.execId,
      state: "live", homeIdentity: assembly.home.identity, startedAt, stoppedAt: null
    });
    this.observeResumeExit({
      workspaceId: input.workspaceId, nativeSessionId: input.nativeSessionId, execId: pty.execId,
      homeIdentity: assembly.home.identity, startedAt, stream: pty.stream
    });
    return pty;
  }

  async stop(input: { readonly projectId: string; readonly workspaceId: string }): Promise<void> {
    const { assembly } = await this.currentAssembly(input);
    await inspectAssemblyResources({ docker: this.docker, assembly });
    await this.docker.stopContainer(assembly.control.containerId);
    await this.docker.stopContainer(assembly.executor.containerId);
    await this.docker.removeContainer(assembly.control.containerId);
    await this.docker.removeContainer(assembly.executor.containerId);
    await this.docker.removeNetwork(assembly.network.controlEgress.id);
    await this.docker.removeNetwork(assembly.network.execution.id);
    await unlink(recordPath(this.stateRoot, input.workspaceId));
    this.assemblies.delete(input.workspaceId);
  }

  async reconcileAfterAgentRestart(input: { readonly projectId: string; readonly workspaceId: string }): Promise<CodexSplitRuntimeRecord> {
    const { context, git } = await this.authoritativeContext(input.projectId, input.workspaceId);
    await this.initialize();
    const record = await this.load(input.workspaceId, context);
    if (record === null || !contextMatchesRecord(context, record)) throw new Error("codex-split-runtime-authority");
    try {
      const assembly = await this.reattachAssembly({
        docker: this.docker, record, context, git, stateRoot: this.stateRoot,
        controlImageReference: this.controlImageReference, codexExecutablePath: this.codexExecutablePath
      });
      await inspectAssemblyResources({ docker: this.docker, assembly });
      this.assemblies.set(input.workspaceId, assembly);
      return record;
    } catch (error) {
      const ambiguous = parseCodexSplitRuntimeRecord({
        ...record,
        sessions: record.sessions.map((session) => isLive(session.state)
          ? { ...session, state: "ambiguous", stoppedAt: this.now() }
          : session)
      });
      await this.save(ambiguous);
      this.assemblies.delete(input.workspaceId);
      throw new Error("codex-split-runtime-reconcile-ambiguous", { cause: error });
    }
  }
}

async function buildDefaultReattachedAssembly(input: {
  readonly docker: DockerEngineClient;
  readonly record: CodexSplitRuntimeRecord;
  readonly context: WorkspaceExecutionContext;
  readonly git: WorkspaceGitAdministrationBinding;
  readonly stateRoot: string;
  readonly controlImageReference: string;
  readonly codexExecutablePath: string;
}): Promise<CodexSplitRuntimeAssembly> {
  const version = await probeAdmittedCodexVersion({ executablePath: input.codexExecutablePath });
  if (version.version !== "0.153.4") throw new Error("codex-split-restart-version");
  const ownerUid = process.getuid?.();
  const ownerGid = process.getgid?.();
  if (ownerUid === undefined || ownerGid === undefined) throw new Error("codex-split-agent-owner-unavailable");
  const home = await ensureNativeCodexHome({ homePath: nativeCodexHomePath(input.stateRoot), ownerUid, ownerGid });
  assertCodexSplitHomeIdentity(input.record.control.homeIdentity, home.identity);
  const existingExecutorInspection = await input.docker.inspectContainer(input.record.executor.id);
  const artifactMounts = existingExecutorInspection.Mounts.filter((mount) =>
    mount.Type === "bind" && mount.Destination === "/opt/devspace/codex" && !mount.RW);
  if (artifactMounts.length !== 1) throw new Error("codex-executor-artifact-mount");
  const artifact = await prepareCodexSplitArtifact({
    configuredPath: input.codexExecutablePath,
    stateRoot: input.stateRoot,
    existingStagingRoot: artifactMounts[0]!.Source
  });
  const network: CodexSplitNetworkBinding = {
    execution: {
      ...input.record.networks.execution, workspaceId: input.context.workspaceId, generation: input.context.generation,
      controlAlias: "codex-control", executorAlias: "codex-executor", publishedPorts: []
    },
    controlEgress: {
      ...input.record.networks.controlEgress, workspaceId: input.context.workspaceId, generation: input.context.generation,
      controlAlias: "codex-control", executorAttached: false, publishedPorts: [], defaultBridgeUsed: false
    }
  };
  const [executionInspection, egressInspection] = await Promise.all([
    input.docker.inspectNetwork(network.execution.id), input.docker.inspectNetwork(network.controlEgress.id)
  ]);
  assertCodexSplitNetworkInspection({ execution: executionInspection, controlEgress: egressInspection }, network);
  const executorPolicy = await buildCodexProjectExecutorPolicy({
    docker: input.docker, context: input.context, git: input.git, network, artifact, imagePort: EXEC_SERVER_PORT
  });
  const executor: CodexProjectExecutorBinding = {
    policy: executorPolicy,
    containerId: input.record.executor.id,
    containerName: splitResourceName(input.context.workspaceId, input.context.generation, "executor"),
    endpointHost: "codex-executor",
    endpointPort: EXEC_SERVER_PORT,
    controlEgressAttached: false
  };
  const executorInspection = await input.docker.inspectContainer(executor.containerId);
  const executorImage = await input.docker.inspectImage(executorInspection.Image ?? executorPolicy.imageId);
  assertCodexProjectExecutorInspection({ container: executorInspection, image: executorImage, binding: executor });
  const capabilities = assertCodexSplitArtifactCapabilities({ artifact, image: executorImage });
  if (input.record.artifact.closureDigest !== capabilities.closureDigest
    || input.record.artifact.nativeCliPath !== capabilities.nativeCliPath
    || input.record.artifact.execServerCapability !== capabilities.execServerCapability
    || input.record.artifact.appServerCapability !== capabilities.appServerCapability
    || input.record.artifact.codeModeHostCapability !== capabilities.codeModeHostCapability
    || input.record.executor.imageId !== executorPolicy.imageId
    || input.record.executor.imageReference !== executorPolicy.imageReference
    || input.record.executor.imageArchitecture !== executorPolicy.imageArchitecture
    || !identitiesEqual(input.record.executor.worktreeIdentity, input.git.worktreeIdentity)
    || !identitiesEqual(input.record.executor.repositoryIdentity, input.git.repositoryIdentity)
    || !identitiesEqual(input.record.executor.administrationIdentity, input.git.administrationIdentity)) {
    throw new Error("codex-split-runtime-authority");
  }
  if (input.record.executor.transportSecurity !== "private-network-only"
    || input.record.execServer.transportSecurity !== input.record.executor.transportSecurity
    || input.record.execServer.endpointUrl !== input.record.executor.endpointUrl
    || input.record.execServer.executorContainerId !== executor.containerId) {
    throw new Error("codex-split-restart-transport-unavailable");
  }
  const transport = createCodexSplitTransportBinding({
    executor, network, protocolAuthenticationVerified: false, privateNetworkIsolationVerified: true,
    admittedVersion: version.version
  });
  const server: CodexExecServerHandle = {
    executorContainerId: input.record.execServer.executorContainerId,
    execId: input.record.execServer.execId,
    endpoint: transport,
    serverPid: input.record.execServer.serverPid
  };
  await assertCodexExecServerReady({ docker: input.docker, handle: server });
  const codeModeHostPolicy = buildCodexCodeModeHostPolicy({ executor, artifact: capabilities });
  const codeModeHost: CodexCodeModeHostHandle = {
    executorContainerId: input.record.codeModeHost.executorContainerId,
    execId: input.record.codeModeHost.execId,
    endpoint: codeModeHostPolicy.endpoint,
    serverPid: input.record.codeModeHost.serverPid,
    transportSecurity: input.record.codeModeHost.transportSecurity
  };
  if (input.record.codeModeHost.host !== codeModeHost.endpoint.host
    || input.record.codeModeHost.port !== codeModeHost.endpoint.port
    || input.record.codeModeHost.url !== codeModeHost.endpoint.url
    || input.record.codeModeHost.listenUrl !== codeModeHost.endpoint.listenUrl
    || input.record.codeModeHost.networkId !== codeModeHost.endpoint.networkId) {
    throw new Error("codex-split-runtime-authority");
  }
  await reattachCodexCodeModeHost({ docker: input.docker, handle: codeModeHost, policy: codeModeHostPolicy });
  const managedPolicy = await prepareCodexManagedPolicy({ stateRoot: input.stateRoot, home, endpoint: transport, admittedVersion: version.version });
  const remote = buildRemoteOnlyConfiguration({
    home, endpoint: transport, policy: managedPolicy, codeModeHostUrl: codeModeHost.endpoint.url
  });
  const controlPolicy = await buildCodexControlSidecarPolicy({
    imageReference: input.controlImageReference, home, artifact, remote, network
  });
  const controlImage = await input.docker.inspectImage(input.controlImageReference);
  const control: CodexControlSidecarBinding = {
    policy: controlPolicy,
    containerId: input.record.control.id,
    containerName: splitResourceName(input.context.workspaceId, input.context.generation, "control"),
    imageId: controlImage.Id
  };
  const controlInspection = await input.docker.inspectContainer(control.containerId);
  assertCodexControlSidecarInspection({ container: controlInspection, binding: control });
  const appServer = {
    controlContainerId: input.record.control.appServer.controlContainerId,
    execId: input.record.control.appServer.execId,
    serverPid: input.record.control.appServer.serverPid,
    socketPath: input.record.control.appServer.socketPath,
    socketIdentity: input.record.control.appServer.socketIdentity,
    homeIdentity: `${home.identity.device}:${home.identity.inode}`,
    codeModeHostUrl: input.record.control.appServer.codeModeHostUrl,
    transportSecurity: input.record.control.appServer.transportSecurity
  } satisfies CodexNativeAppServerHandle;
  const appServerControl = { ...control.policy, containerId: control.containerId } as CodexControlSidecarPolicy;
  const appServerPolicy = buildCodexNativeAppServerPolicy({
    control: appServerControl, artifact: capabilities, codeModeHost: codeModeHost.endpoint
  });
  if (appServer.controlContainerId !== control.containerId
    || appServer.homeIdentity !== appServerPolicy.homeIdentity
    || appServer.codeModeHostUrl !== appServerPolicy.codeModeHostUrl
    || appServer.socketPath !== appServerPolicy.socketPath) {
    throw new Error("codex-split-runtime-authority");
  }
  await reattachCodexNativeAppServer({ docker: input.docker, handle: appServer, policy: appServerPolicy });
  await assertCodexNativeAppServerReady({ docker: input.docker, handle: appServer, policy: appServerPolicy });
  return { home, artifact, network, executor, transport, server, codeModeHost, appServer, remote, control };
}
