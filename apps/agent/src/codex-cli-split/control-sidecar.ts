import path from "node:path";
import {
  DockerEngineClient,
  type DockerCodexSplitBindMount,
  type DockerCodexSplitControlEgressAttachment,
  type DockerCodexSplitExecutionAttachment,
  type DockerContainerInspection
} from "../docker-runtime.js";
import { assertCodexArtifactCompatibleWithImage, type CodexSplitArtifactBinding } from "./artifact.js";
import {
  assertCodexSplitContainerNetworks,
  buildCodexSplitNetworkAttachments,
  type CodexSplitNetworkBinding
} from "./network.js";
import type { CodexNativeHomeBinding } from "./native-home.js";
import type { CodexRemoteOnlyConfiguration } from "./remote-policy.js";

const CONTROL_ROLE = "codex-control" as const;
const CONTROL_ENTRYPOINT = ["/bin/sh", "-c"] as const;
const CONTROL_COMMAND = ["exec sleep 2147483647"] as const;
const CONTROL_TMPFS = { "/tmp": "rw,nosuid,nodev,noexec,size=64m" } as const;
const CONTROL_RESOURCES = { cpuMillicores: 1_000, memoryBytes: 512 * 1024 * 1024, pidLimit: 256 } as const;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface CodexControlSidecarPolicy {
  readonly imageReference: string;
  readonly home: CodexNativeHomeBinding;
  readonly artifact: CodexSplitArtifactBinding;
  readonly remote: CodexRemoteOnlyConfiguration;
  readonly network: CodexSplitNetworkBinding;
  readonly mounts: readonly DockerCodexSplitBindMount[];
  readonly networkAttachments: readonly [
    DockerCodexSplitExecutionAttachment,
    DockerCodexSplitControlEgressAttachment
  ];
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: "/workspace";
  readonly physicalWorkspaceMounts: readonly [];
  readonly physicalGitMounts: readonly [];
  readonly forwardingDisabled: true;
  readonly proxyProcesses: readonly [];
  readonly containerUser: string;
  readonly tmpfs: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly resources: typeof CONTROL_RESOURCES;
}

export interface CodexControlSidecarBinding {
  readonly policy: CodexControlSidecarPolicy;
  readonly containerId: string;
  readonly containerName: string;
  readonly imageId: string;
}

function absolutePath(value: string, code: string): string {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(code);
  return path.resolve(value);
}

function safeImageReference(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/u.test(value)) throw new Error("codex-control-image-reference-invalid");
  return value;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertNotWithinHome(home: CodexNativeHomeBinding, source: string, code: string): void {
  if (pathIsWithin(home.homePath, source)) throw new Error(code);
}

function assertArtifactBinding(input: CodexSplitArtifactBinding, home: CodexNativeHomeBinding): void {
  if (input.packageVersion !== "0.153.4"
    || !/^[0-9a-f]{64}$/u.test(input.closureDigest)
    || input.mountTarget !== "/opt/devspace/codex"
    || input.launcherPath !== "/opt/devspace/codex-launcher/codex"
    || !path.isAbsolute(input.staged.stagingRoot)
    || !path.isAbsolute(input.launcherSourceRoot)
    || input.staged.stagingRoot === home.homePath
    || input.entrypointPath !== path.posix.join(input.mountTarget, input.staged.artifact.entrypoint.relativePath)
    || path.resolve(input.launcherSourcePath) !== path.resolve(path.join(input.launcherSourceRoot, "codex"))) {
    throw new Error("codex-control-artifact-policy");
  }
  assertNotWithinHome(home, input.staged.stagingRoot, "codex-control-artifact-home-overlap");
  assertNotWithinHome(home, input.launcherSourceRoot, "codex-control-artifact-home-overlap");
}

function assertNetworkBinding(network: CodexSplitNetworkBinding): void {
  if (network.execution.internal !== true || network.execution.defaultRoute !== false
    || network.execution.publishedPorts.length !== 0
    || network.controlEgress.internal !== false || network.controlEgress.defaultRoute !== true
    || network.controlEgress.executorAttached !== false || network.controlEgress.defaultBridgeUsed !== false
    || network.controlEgress.publishedPorts.length !== 0
    || network.execution.workspaceId !== network.controlEgress.workspaceId
    || network.execution.generation !== network.controlEgress.generation
    || network.execution.name === network.controlEgress.name
    || network.execution.name === "bridge" || network.controlEgress.name === "bridge") {
    throw new Error("codex-control-network-policy");
  }
}

function assertRemotePolicy(input: {
  readonly home: CodexNativeHomeBinding;
  readonly remote: CodexRemoteOnlyConfiguration;
  readonly network: CodexSplitNetworkBinding;
}): void {
  const { home, remote, network } = input;
  const expectedEndpoint = `ws://codex-executor:${remote.endpoint.endpointPort}`;
  if (remote.endpoint.endpointUrl !== expectedEndpoint
    || remote.endpoint.endpointHost !== "codex-executor"
    || remote.endpoint.workspaceId !== network.execution.workspaceId
    || remote.endpoint.generation !== network.execution.generation
    || remote.endpoint.executionNetworkId !== network.execution.id
    || remote.environment.CODEX_HOME !== home.mountTarget
    || remote.environment.HOME !== home.mountTarget
    || remote.environment.CODEX_EXEC_SERVER_URL !== expectedEndpoint) {
    throw new Error("codex-control-endpoint-policy");
  }
  if (remote.endpoint.security === "unproven"
    || (remote.endpoint.security === "private-network-only" && remote.endpoint.authenticationEvidence !== "absent")
    || (remote.endpoint.security === "protocol-authenticated" && remote.endpoint.authenticationEvidence !== "verified")) {
    throw new Error("codex-control-transport-policy");
  }
  if (remote.logicalCwd !== "/workspace"
    || remote.workspaceRoots.length !== 1 || remote.workspaceRoots[0] !== "/workspace"
  ) {
    throw new Error("codex-control-working-directory");
  }
  if (remote.environmentId !== "remote"
    || remote.localEnvironmentAvailable !== false || remote.unifiedExecRequired !== true
    || remote.managedPolicy.mechanism !== "0.153.4-managed-requirements"
    || remote.managedPolicy.projectLayerOverrideProof !== "cannot-override"
    || remote.managedPolicy.mountTarget !== "/etc/codex/requirements.toml"
    || !path.isAbsolute(remote.managedPolicy.requirementsPath)
    || remote.managedPolicy.environment.CODEX_HOME !== remote.environment.CODEX_HOME
    || remote.managedPolicy.environment.HOME !== remote.environment.HOME
    || remote.managedPolicy.environment.CODEX_EXEC_SERVER_URL !== remote.environment.CODEX_EXEC_SERVER_URL
    || remote.launchArguments.length !== 2 || remote.launchArguments[0] !== "-c" || remote.launchArguments[1] !== "notify=[]"
    || Object.keys(remote.environment).some((name) => !["CODEX_HOME", "HOME", "CODEX_EXEC_SERVER_URL"].includes(name))) {
    throw new Error("codex-control-remote-policy");
  }
  if (path.resolve(remote.managedPolicy.requirementsPath) === path.resolve(home.homePath)
    || pathIsWithin(home.homePath, remote.managedPolicy.requirementsPath)) {
    throw new Error("codex-control-policy-home-overlap");
  }
}

function mount(source: string, target: string, readOnly: boolean): DockerCodexSplitBindMount {
  return {
    Type: "bind", Source: absolutePath(source, "codex-control-mount-source-invalid"),
    Target: absolutePath(target, "codex-control-mount-target-invalid"), ReadOnly: readOnly,
    BindOptions: { Propagation: "rprivate" }
  };
}

function labelsFor(policy: {
  readonly network: CodexSplitNetworkBinding;
  readonly artifact: CodexSplitArtifactBinding;
}): Readonly<Record<string, string>> {
  return {
    "devspace.managed": "true",
    "devspace.codex-split": "true",
    "devspace.workspace-id": policy.network.execution.workspaceId,
    "devspace.runtime-generation": String(policy.network.execution.generation),
    "devspace.resource-role": CONTROL_ROLE,
    "devspace.codex-artifact-closure": policy.artifact.closureDigest
  };
}

export async function buildCodexControlSidecarPolicy(input: {
  readonly imageReference: string;
  readonly home: CodexNativeHomeBinding;
  readonly artifact: CodexSplitArtifactBinding;
  readonly remote: CodexRemoteOnlyConfiguration;
  readonly network: CodexSplitNetworkBinding;
}): Promise<CodexControlSidecarPolicy> {
  await Promise.resolve();
  const imageReference = safeImageReference(input.imageReference);
  if (input.home.mountTarget !== "/codex-home" || !path.isAbsolute(input.home.homePath) || input.home.homePath.includes("\0")) {
    throw new Error("codex-control-home-policy");
  }
  assertArtifactBinding(input.artifact, input.home);
  assertNetworkBinding(input.network);
  assertRemotePolicy({ home: input.home, remote: input.remote, network: input.network });
  const networkAttachments = buildCodexSplitNetworkAttachments({ role: "control", network: input.network });
  assertCodexSplitContainerNetworks({ role: "control", networks: networkAttachments, expected: input.network });
  const policyFile = absolutePath(input.remote.managedPolicy.requirementsPath, "codex-control-policy-path-invalid");
  assertNotWithinHome(input.home, policyFile, "codex-control-policy-home-overlap");
  const mounts = [
    mount(input.home.homePath, "/codex-home", false),
    mount(input.artifact.staged.stagingRoot, "/opt/devspace/codex", true),
    mount(input.artifact.launcherSourceRoot, "/opt/devspace/codex-launcher", true),
    mount(policyFile, "/etc/codex/requirements.toml", true)
  ] as const satisfies readonly DockerCodexSplitBindMount[];
  return Promise.resolve({
    imageReference,
    home: input.home,
    artifact: input.artifact,
    remote: input.remote,
    network: input.network,
    mounts,
    networkAttachments,
    environment: { ...input.remote.environment },
    workingDirectory: "/workspace",
    physicalWorkspaceMounts: [],
    physicalGitMounts: [],
    forwardingDisabled: true,
    proxyProcesses: [],
    containerUser: `${input.home.ownerUid}:${input.home.ownerGid}`,
    tmpfs: { ...CONTROL_TMPFS },
    labels: labelsFor({ network: input.network, artifact: input.artifact }),
    resources: CONTROL_RESOURCES
  });
}

function managedEnvironmentMatches(
  observed: readonly string[] | null | undefined,
  expected: Readonly<Record<string, string>>
): boolean {
  const values = new Map<string, string[]>();
  for (const entry of observed ?? []) {
    const separator = entry.indexOf("=");
    if (separator < 1) return false;
    const name = entry.slice(0, separator);
    const entries = values.get(name) ?? [];
    entries.push(entry.slice(separator + 1));
    values.set(name, entries);
  }
  return Object.entries(expected).every(([name, value]) => {
    const entries = values.get(name);
    return entries?.length === 1 && entries[0] === value;
  });
}

function hasCredentialEnvironment(environment: readonly string[] | null | undefined): boolean {
  return (environment ?? []).some((entry) => /^(?:CODEX_API_KEY|CODEX_ACCESS_TOKEN|CODEX_AUTH_TOKEN|CODEX_REFRESH_TOKEN|OPENAI_API_KEY|OPENAI_ACCESS_TOKEN|OPENAI_AUTH_TOKEN|OPENAI_REFRESH_TOKEN)=/iu.test(entry));
}

function labelsEqual(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  return JSON.stringify(Object.entries(left).sort(([a], [b]) => a.localeCompare(b)))
    === JSON.stringify(Object.entries(right).sort(([a], [b]) => a.localeCompare(b)));
}

function mountKey(mount: { readonly Type: string; readonly Source: string; readonly Destination: string; readonly RW: boolean; readonly Propagation: string }): string {
  return JSON.stringify([mount.Type, path.resolve(mount.Source), path.resolve(mount.Destination), mount.RW, mount.Propagation]);
}

function assertForwardingInspection(container: DockerContainerInspection): void {
  const sysctls = container.HostConfig.Sysctls ?? {};
  if (sysctls["net.ipv4.ip_forward"] !== "0"
    || (sysctls["net.ipv6.conf.all.forwarding"] !== undefined && sysctls["net.ipv6.conf.all.forwarding"] !== "0")) {
    throw new Error("codex-control-forwarding-policy");
  }
}

async function controlStartupStage<T>(stage: string, operation: () => T | PromiseLike<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(stage, { cause: error });
  }
}

export async function createCodexControlSidecar(input: {
  readonly docker: DockerEngineClient;
  readonly policy: CodexControlSidecarPolicy;
  readonly name: string;
}): Promise<CodexControlSidecarBinding> {
  let containerId: string | undefined;
  try {
    await controlStartupStage("codex-control-image-resolution", () => input.docker.ensureImage(input.policy.imageReference));
    const image = await controlStartupStage("codex-control-image-inspection", async () => {
      const inspected = await input.docker.inspectImage(input.policy.imageReference);
      if (!IMAGE_ID_PATTERN.test(inspected.Id) || inspected.Os !== "linux") throw new Error("codex-control-image-invalid");
      return inspected;
    });
    await controlStartupStage("codex-control-artifact-compatibility", () => {
      assertCodexArtifactCompatibleWithImage({ artifact: input.policy.artifact, image });
    });
    containerId = await controlStartupStage("codex-control-container-create", () => input.docker.createCodexSplitContainer(input.name, {
      role: "control",
      imageId: image.Id,
      imageReference: input.policy.imageReference,
      entrypoint: CONTROL_ENTRYPOINT,
      command: CONTROL_COMMAND,
      workingDirectory: input.policy.workingDirectory,
      user: input.policy.containerUser,
      environment: input.policy.environment,
      mounts: input.policy.mounts,
      tmpfs: input.policy.tmpfs,
      networks: input.policy.networkAttachments,
      sysctls: { "net.ipv4.ip_forward": "0", "net.ipv6.conf.all.forwarding": "0" },
      labels: input.policy.labels,
      cpuMillicores: input.policy.resources.cpuMillicores,
      memoryBytes: input.policy.resources.memoryBytes,
      pidLimit: input.policy.resources.pidLimit,
      readOnlyRootfs: false
    }));
    await controlStartupStage("codex-control-container-start", () => input.docker.startContainer(containerId!));
    const binding: CodexControlSidecarBinding = {
      policy: input.policy, containerId, containerName: input.name, imageId: image.Id
    };
    const inspection = await controlStartupStage("codex-control-container-inspection", () => input.docker.inspectContainer(containerId!));
    await controlStartupStage("codex-control-inspection-policy", () => assertCodexControlSidecarInspection({ container: inspection, binding }));
    return binding;
  } catch (error) {
    if (containerId !== undefined) await input.docker.removeContainer(containerId).catch(() => undefined);
    throw new Error("codex-control-start-failed", { cause: error });
  }
}

export function assertCodexControlSidecarInspection(input: {
  readonly container: DockerContainerInspection;
  readonly binding: CodexControlSidecarBinding;
}): void {
  const { container, binding } = input;
  const policy = binding.policy;
  const networks = container.NetworkSettings.Networks ?? {};
  const networkNames = Object.keys(networks);
  const expectedAttachments = buildCodexSplitNetworkAttachments({ role: "control", network: policy.network });
  assertCodexSplitContainerNetworks({
    role: "control",
    networks: expectedAttachments,
    expected: policy.network
  });
  const expectedMounts = new Set(policy.mounts.map((entry) => mountKey({
    Type: entry.Type, Source: entry.Source, Destination: entry.Target, RW: !entry.ReadOnly,
    Propagation: entry.BindOptions.Propagation
  })));
  const observedMounts = new Set(container.Mounts.map(mountKey));
  if (container.Id !== binding.containerId || container.Name.replace(/^\//u, "") !== binding.containerName
    || container.Image !== binding.imageId || container.Config.Image !== policy.imageReference
    || !container.State.Running || container.Config.WorkingDir !== policy.workingDirectory
    || (container.Config.User ?? "") !== policy.containerUser || !labelsEqual(container.Config.Labels, policy.labels)
    || networkNames.length !== 2 || networkNames[0] !== policy.network.execution.name
    || networkNames[1] !== policy.network.controlEgress.name
    || networks[policy.network.execution.name]?.NetworkID !== policy.network.execution.id
    || networks[policy.network.controlEgress.name]?.NetworkID !== policy.network.controlEgress.id
    || container.HostConfig.NetworkMode !== policy.network.execution.name
    || container.HostConfig.Privileged || container.HostConfig.PublishAllPorts
    || container.HostConfig.PidMode !== "" || container.HostConfig.IpcMode !== "private"
    || container.HostConfig.UTSMode !== "" || container.HostConfig.UsernsMode !== ""
    || container.HostConfig.CgroupnsMode !== "private" || container.HostConfig.AutoRemove
    || container.HostConfig.ReadonlyRootfs
    || container.HostConfig.RestartPolicy.Name !== "no" || container.HostConfig.RestartPolicy.MaximumRetryCount !== 0
    || Object.keys(container.HostConfig.PortBindings ?? {}).length !== 0
    || (container.HostConfig.Binds ?? []).length !== 0
    || (container.HostConfig.Devices ?? []).length !== 0 || (container.HostConfig.CapAdd ?? []).length !== 0
    || JSON.stringify([...(container.HostConfig.CapDrop ?? [])].sort()) !== JSON.stringify(["ALL"])
    || JSON.stringify([...(container.HostConfig.SecurityOpt ?? [])].sort()) !== JSON.stringify(["no-new-privileges:true"])
    || container.HostConfig.NanoCpus !== policy.resources.cpuMillicores * 1_000_000
    || container.HostConfig.Memory !== policy.resources.memoryBytes
    || container.HostConfig.PidsLimit !== policy.resources.pidLimit
    || JSON.stringify(container.HostConfig.Tmpfs ?? {}) !== JSON.stringify(policy.tmpfs)
    || !managedEnvironmentMatches(container.Config.Env, policy.environment)
    || hasCredentialEnvironment(container.Config.Env)
    || expectedMounts.size !== observedMounts.size || [...expectedMounts].some((entry) => !observedMounts.has(entry))) {
    throw new Error("codex-control-inspection-policy");
  }
  assertForwardingInspection(container);
  if (Object.keys(container.HostConfig.Sysctls ?? {}).some((name) => ![
    "net.ipv4.ip_forward", "net.ipv6.conf.all.forwarding"
  ].includes(name))) {
    throw new Error("codex-control-forwarding-policy");
  }
  if (container.Config.Entrypoint !== undefined
    && JSON.stringify(container.Config.Entrypoint) !== JSON.stringify([...CONTROL_ENTRYPOINT])) {
    throw new Error("codex-control-entrypoint-policy");
  }
  if (container.Config.Cmd !== undefined && JSON.stringify(container.Config.Cmd) !== JSON.stringify([...CONTROL_COMMAND])) {
    throw new Error("codex-control-command-policy");
  }
  if (policy.mounts.some((entry) => entry.Target === "/workspace" || entry.Target === "/codex-home/**")) {
    throw new Error("codex-control-project-mount-policy");
  }
}
