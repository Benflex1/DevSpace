import { readRegularFileNoFollow, assertContained, identitiesEqual, lstatIdentity } from "../private-state.js";
import path from "node:path";
import {
  DockerEngineClient,
  parseImagePath,
  type DockerCodexSplitBindMount,
  type DockerCodexSplitExecutionAttachment,
  type DockerContainerInspection,
  type DockerImageInspection
} from "../docker-runtime.js";
import { compileRuntimePlanV1 } from "@devspace/project-options";
import type { WorkspaceExecutionContext } from "../managed-workspaces.js";
import type { WorkspaceGitAdministrationBinding } from "./native-home.js";
import {
  assertCodexArtifactCompatibleWithImage,
  type CodexSplitArtifactBinding
} from "./artifact.js";
import {
  assertCodexSplitContainerNetworks,
  buildCodexSplitNetworkAttachments,
  type CodexSplitExecutionNetworkBinding,
  type CodexSplitNetworkBinding
} from "./network.js";

const EXECUTOR_HOME = "/tmp/devspace-codex-home";
const EXECUTOR_TMP = "/tmp";
const EXECUTOR_TMPFS = "rw,nosuid,nodev,noexec,size=64m";
const EXECUTOR_COMMAND = ["exec sleep 2147483647"] as const;
const CODEX_EXECUTOR_ROLE = "codex-split-executor" as const;
const FORBIDDEN_ENVIRONMENT_NAMES = new Set([
  "CODEX_HOME", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_AUTH_TOKEN", "CODEX_REFRESH_TOKEN",
  "OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN", "OPENAI_AUTH_TOKEN", "OPENAI_REFRESH_TOKEN"
]);

export interface CodexProjectExecutorPolicy {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly revisionHash: string;
  readonly runtimePlanHash: string;
  readonly generation: number;
  readonly imageId: string;
  readonly imageReference: string;
  readonly imageArchitecture: string;
  readonly worktreePath: string;
  readonly repositoryPath: string;
  readonly administrationPath: string;
  readonly mounts: readonly DockerCodexSplitBindMount[];
  readonly executionNetwork: CodexSplitExecutionNetworkBinding;
  readonly networkAttachments: readonly [DockerCodexSplitExecutionAttachment];
  readonly artifact: CodexSplitArtifactBinding;
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: "/workspace";
  readonly containerUser: string;
  readonly tmpfs: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly resources: Readonly<{
    readonly cpuMillicores: number;
    readonly memoryBytes: number;
    readonly pidLimit: number;
  }>;
  readonly endpointPort: number;
  readonly controlEgressAttached: false;
}

export interface CodexProjectExecutorBinding {
  readonly policy: CodexProjectExecutorPolicy;
  readonly containerId: string;
  readonly containerName: string;
  readonly endpointHost: "codex-executor";
  readonly endpointPort: number;
  readonly controlEgressAttached: false;
}

interface ProjectImageEvidence {
  readonly container: DockerContainerInspection;
  readonly image: DockerImageInspection;
}

function sortedEntries(input: Readonly<Record<string, string>>): readonly (readonly [string, string])[] {
  return Object.entries(input).sort(([left], [right]) => left.localeCompare(right));
}

function labelsEqual(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  return JSON.stringify(sortedEntries(left)) === JSON.stringify(sortedEntries(right));
}

function safeEnvironmentName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/u.test(name) && !FORBIDDEN_ENVIRONMENT_NAMES.has(name);
}

function environmentName(entry: string, error: string): string {
  const separator = entry.indexOf("=");
  if (separator < 1) throw new Error(error);
  const name = entry.slice(0, separator);
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) throw new Error(error);
  return name;
}

function assertNoForbiddenEnvironment(environment: readonly string[] | null | undefined, error: string): void {
  for (const entry of environment ?? []) {
    const name = environmentName(entry, error);
    if (FORBIDDEN_ENVIRONMENT_NAMES.has(name)) throw new Error("codex-executor-credential-environment");
  }
}

function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("codex-executor-endpoint-port-invalid");
}

async function assertExactDirectory(pathValue: string, expectedIdentity: { readonly device: string; readonly inode: string }, error: string): Promise<void> {
  const observed = await lstatIdentity(pathValue);
  if (observed === null || !observed.stats.isDirectory() || observed.stats.isSymbolicLink()
    || !identitiesEqual(observed.identity, expectedIdentity)) {
    throw new Error(error);
  }
}

async function assertExactGitBinding(context: WorkspaceExecutionContext, git: WorkspaceGitAdministrationBinding): Promise<void> {
  if (git.projectId !== context.projectId || git.workspaceId !== context.workspaceId
    || pathResolve(git.worktreePath) !== pathResolve(context.ownership.worktreePath)
    || pathResolve(git.worktreePath) !== git.worktreePath
    || pathResolve(git.repositoryPath) !== git.repositoryPath
    || pathResolve(git.administrationPath) !== git.administrationPath) {
    throw new Error("codex-executor-workspace-binding");
  }
  await assertExactDirectory(git.worktreePath, git.worktreeIdentity, "codex-executor-worktree-identity");
  await assertExactDirectory(git.repositoryPath, git.repositoryIdentity, "codex-executor-repository-identity");
  await assertExactDirectory(git.administrationPath, git.administrationIdentity, "codex-executor-administration-identity");
  assertContained(path.join(git.repositoryPath, "worktrees"), git.administrationPath);
  const gitFile = await readRegularFileNoFollow(path.join(git.worktreePath, ".git"), 4 * 1024);
  const expected = `gitdir: ${git.administrationPath}`;
  if (gitFile.bytes.toString("utf8").trim() !== expected) throw new Error("codex-executor-git-pointer");
}

function pathResolve(value: string): string {
  return path.resolve(value);
}

async function inspectExactProjectImage(input: {
  readonly docker: DockerEngineClient;
  readonly context: WorkspaceExecutionContext;
  readonly imageReference: string;
}): Promise<ProjectImageEvidence> {
  const container = await input.docker.inspectContainer(input.context.ownership.developmentContainer.id);
  const ownership = input.context.ownership.developmentContainer;
  if (container.Id !== ownership.id || container.Name.replace(/^\//u, "") !== ownership.name
    || !labelsEqual(container.Config.Labels, ownership.labels) || !container.State.Running
    || container.Config.Image !== input.imageReference || container.Image === undefined
    || !/^sha256:[0-9a-f]{64}$/u.test(container.Image)) {
    throw new Error("codex-executor-image-runtime");
  }
  const image = await input.docker.inspectImage(container.Image);
  if (image.Id !== container.Image || !/^sha256:[0-9a-f]{64}$/u.test(image.Id)) {
    throw new Error("codex-executor-image");
  }
  assertNoForbiddenEnvironment(image.Config.Env, "codex-executor-image-environment-invalid");
  parseImagePath(image.Config.Env);
  return { container, image };
}

function bindMount(source: string, target: string, readOnly: boolean): DockerCodexSplitBindMount {
  return {
    Type: "bind", Source: path.resolve(source), Target: path.resolve(target), ReadOnly: readOnly,
    BindOptions: { Propagation: "rprivate" }
  };
}

function assertProjectEnvironment(environment: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(environment)) {
    if (!safeEnvironmentName(name) || value.includes("\0") || [...value].some((character) => (character.codePointAt(0) ?? 0) < 32)) {
      if (FORBIDDEN_ENVIRONMENT_NAMES.has(name)) throw new Error("codex-executor-credential-environment");
      throw new Error("codex-executor-environment-invalid");
    }
  }
}

function executorLabels(context: WorkspaceExecutionContext, artifact: CodexSplitArtifactBinding): Readonly<Record<string, string>> {
  return {
    "devspace.managed": "true",
    "devspace.codex-split": "true",
    "devspace.project-id": context.projectId,
    "devspace.workspace-id": context.workspaceId,
    "devspace.revision-id": context.revisionId,
    "devspace.revision-hash": context.revisionHash,
    "devspace.runtime-plan-hash": context.runtimePlanHash,
    "devspace.runtime-generation": String(context.generation),
    "devspace.resource-role": CODEX_EXECUTOR_ROLE,
    "devspace.codex-artifact-closure": artifact.closureDigest
  };
}

export async function buildCodexProjectExecutorPolicy(input: {
  readonly docker: DockerEngineClient;
  readonly context: WorkspaceExecutionContext;
  readonly git: WorkspaceGitAdministrationBinding;
  readonly network: CodexSplitNetworkBinding;
  readonly artifact: CodexSplitArtifactBinding;
  readonly imagePort: number;
}): Promise<CodexProjectExecutorPolicy> {
  assertPort(input.imagePort);
  const runtimePlan = compileRuntimePlanV1(input.context.options);
  const source = runtimePlan.developmentContainer.source;
  if (source.kind !== "image") throw new Error("codex-executor-source-not-image");
  if (runtimePlan.developmentContainer.workingDirectory !== "/workspace") {
    throw new Error("codex-executor-working-directory");
  }
  if (input.context.generation !== input.context.ownership.generation
    || input.context.revisionHash !== input.context.ownership.revisionHash
    || input.context.runtimePlanHash !== input.context.ownership.runtimePlanHash
    || input.context.projectId !== input.context.ownership.projectId
    || input.context.workspaceId !== input.context.ownership.workspaceId) {
    throw new Error("codex-executor-ownership-binding");
  }
  await assertExactGitBinding(input.context, input.git);
  const evidence = await inspectExactProjectImage({ docker: input.docker, context: input.context, imageReference: source.imageReference });
  assertCodexArtifactCompatibleWithImage({ artifact: input.artifact, image: evidence.image });
  const networkAttachments = buildCodexSplitNetworkAttachments({ role: "executor", network: input.network });
  assertCodexSplitContainerNetworks({ role: "executor", networks: networkAttachments, expected: input.network });

  const imagePath = parseImagePath(evidence.image.Config.Env);
  const projectEnvironment = runtimePlan.developmentContainer.environment;
  assertProjectEnvironment(projectEnvironment);
  if (Object.keys(projectEnvironment).some((name) => FORBIDDEN_ENVIRONMENT_NAMES.has(name))) {
    throw new Error("codex-executor-credential-environment");
  }
  const environment = {
    ...projectEnvironment,
    PATH: imagePath,
    HOME: EXECUTOR_HOME,
    TMPDIR: EXECUTOR_TMP
  };
  assertProjectEnvironment(environment);
  const mounts = [
    bindMount(input.git.worktreePath, "/workspace", false),
    bindMount(input.git.repositoryPath, input.git.repositoryPath, false),
    bindMount(input.git.administrationPath, input.git.administrationPath, false),
    bindMount(input.artifact.staged.stagingRoot, input.artifact.mountTarget, true),
    bindMount(input.artifact.launcherSourceRoot, "/opt/devspace/codex-launcher", true)
  ] as const;
  const labels = executorLabels(input.context, input.artifact);
  const resources = input.context.ownership.resources;
  return {
    projectId: input.context.projectId,
    workspaceId: input.context.workspaceId,
    revisionId: input.context.revisionId,
    revisionHash: input.context.revisionHash,
    runtimePlanHash: input.context.runtimePlanHash,
    generation: input.context.generation,
    imageId: evidence.image.Id,
    imageReference: source.imageReference,
    imageArchitecture: evidence.image.Architecture,
    worktreePath: input.git.worktreePath,
    repositoryPath: input.git.repositoryPath,
    administrationPath: input.git.administrationPath,
    mounts,
    executionNetwork: input.network.execution,
    networkAttachments,
    artifact: input.artifact,
    environment,
    workingDirectory: "/workspace",
    containerUser: runtimePlan.developmentContainer.containerUser ?? "",
    tmpfs: { "/tmp": EXECUTOR_TMPFS },
    labels,
    resources,
    endpointPort: input.imagePort,
    controlEgressAttached: false
  };
}

export async function createCodexProjectExecutor(input: {
  readonly docker: DockerEngineClient;
  readonly policy: CodexProjectExecutorPolicy;
  readonly name: string;
}): Promise<CodexProjectExecutorBinding> {
  let containerId: string | undefined;
  try {
    containerId = await input.docker.createCodexSplitContainer(input.name, {
      role: "executor",
      imageId: input.policy.imageId,
      entrypoint: ["/bin/sh", "-c"],
      command: EXECUTOR_COMMAND,
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
    });
    await input.docker.startContainer(containerId);
  } catch (error) {
    if (containerId !== undefined) await input.docker.removeContainer(containerId).catch(() => undefined);
    throw new Error("codex-executor-start-failed", { cause: error });
  }
  return {
    policy: input.policy,
    containerId,
    containerName: input.name,
    endpointHost: "codex-executor",
    endpointPort: input.policy.endpointPort,
    controlEgressAttached: false
  };
}

function normalizedSecurityOptions(options: readonly string[] | null): readonly string[] {
  return [...(options ?? [])].map((option) => option.replace(/^no-new-privileges[=:]true$/u, "no-new-privileges:true")).sort();
}

function mountKey(mount: { readonly Type: string; readonly Source: string; readonly Destination: string; readonly RW: boolean; readonly Propagation: string }): string {
  return JSON.stringify([mount.Type, path.resolve(mount.Source), path.resolve(mount.Destination), mount.RW, mount.Propagation]);
}

export function assertCodexProjectExecutorInspection(input: {
  readonly container: DockerContainerInspection;
  readonly image: DockerImageInspection;
  readonly binding: CodexProjectExecutorBinding;
}): void {
  const { container, image, binding } = input;
  const policy = binding.policy;
  const networks = container.NetworkSettings.Networks ?? {};
  const networkNames = Object.keys(networks);
  const expectedMounts = new Set(policy.mounts.map((mount) => mountKey({
    Type: mount.Type, Source: mount.Source, Destination: mount.Target, RW: !mount.ReadOnly,
    Propagation: mount.BindOptions.Propagation
  })));
  const observedMounts = new Set(container.Mounts.map(mountKey));
  assertNoForbiddenEnvironment(container.Config.Env, "codex-executor-container-environment-invalid");
  if (container.Id !== binding.containerId || container.Name.replace(/^\//u, "") !== binding.containerName
    || !container.State.Running || container.Image !== policy.imageId || image.Id !== policy.imageId
    || container.Config.Image !== policy.imageReference || container.Config.WorkingDir !== policy.workingDirectory
    || (container.Config.User ?? "") !== policy.containerUser || !labelsEqual(container.Config.Labels, policy.labels)
    || networkNames.length !== 1 || networkNames[0] !== policy.executionNetwork.name
    || networks[policy.executionNetwork.name]?.NetworkID !== policy.executionNetwork.id
    || container.HostConfig.NetworkMode !== policy.executionNetwork.name
    || container.HostConfig.Privileged || container.HostConfig.PublishAllPorts
    || container.HostConfig.PidMode !== "" || container.HostConfig.IpcMode !== "private"
    || container.HostConfig.UTSMode !== "" || container.HostConfig.UsernsMode !== ""
    || container.HostConfig.CgroupnsMode !== "private" || container.HostConfig.AutoRemove
    || container.HostConfig.ReadonlyRootfs || container.HostConfig.RestartPolicy.Name !== "no"
    || container.HostConfig.RestartPolicy.MaximumRetryCount !== 0
    || Object.keys(container.HostConfig.PortBindings ?? {}).length !== 0
    || (container.HostConfig.Devices ?? []).length !== 0 || (container.HostConfig.CapAdd ?? []).length !== 0
    || JSON.stringify([...(container.HostConfig.CapDrop ?? [])].sort()) !== JSON.stringify(["ALL"])
    || JSON.stringify(normalizedSecurityOptions(container.HostConfig.SecurityOpt)) !== JSON.stringify(["no-new-privileges:true"])
    || container.HostConfig.NanoCpus !== policy.resources.cpuMillicores * 1_000_000
    || container.HostConfig.Memory !== policy.resources.memoryBytes
    || container.HostConfig.PidsLimit !== policy.resources.pidLimit
    || JSON.stringify(container.HostConfig.Tmpfs ?? {}) !== JSON.stringify(policy.tmpfs)
    || expectedMounts.size !== observedMounts.size || [...expectedMounts].some((mount) => !observedMounts.has(mount))
    || binding.controlEgressAttached !== false) {
    throw new Error("codex-executor-inspection-policy");
  }
  if (container.Config.Entrypoint !== undefined
    && JSON.stringify(container.Config.Entrypoint) !== JSON.stringify(["/bin/sh", "-c"])) {
    throw new Error("codex-executor-entrypoint-policy");
  }
  if (container.Config.Cmd !== undefined && JSON.stringify(container.Config.Cmd) !== JSON.stringify([...EXECUTOR_COMMAND])) {
    throw new Error("codex-executor-command-policy");
  }
}
