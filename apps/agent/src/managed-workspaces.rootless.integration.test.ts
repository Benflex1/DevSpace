import { request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { v7 as uuidv7 } from "uuid";
import { afterEach, expect, test } from "vitest";
import { createWorkspaceDataSchema } from "@devspace/contracts";
import {
  canonicalizeProjectOptionsV1, canonicalizeRuntimePlanV1, compileRuntimePlanV1,
  hashProjectOptionsV1, hashRuntimePlanV1, parseProjectOptionsV1
} from "@devspace/project-options";
import { DockerEngineClient, type DockerContainerInspection, type DockerNetworkInspection } from "./docker-runtime.js";
import { ManagedWorkspaces, runGit, type GitRunner } from "./managed-workspaces.js";
import { PreviewRuntimeManager } from "./preview-runtime.js";
import { durableJsonWriter } from "./private-state.js";
import { WorkspaceRuntimeManager } from "./workspace-runtime.js";

const execFileAsync = promisify(execFile);
const dockerSocketPath = process.env.DEVSPACE_TEST_DOCKER_SOCKET_PATH;
const gitImage = process.env.DEVSPACE_TEST_GIT_IMAGE || "mcr.microsoft.com/devcontainers/base:ubuntu-24.04";
let activeFixture: { root: string; engine: DockerEngineClient; projectId: string; workspaceIds: string[]; operationIds: string[] } | null = null;

async function hostGit(repositoryPath: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("/usr/bin/git", ["-C", repositoryPath, ...args], { encoding: "utf8" });
  return result.stdout.trimEnd();
}

function decodeDockerFrames(input: Buffer): { readonly stdout: string; readonly stderr: string } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  while (offset < input.length) {
    if (input.length - offset < 8) throw new Error("rootless-git-test-docker-frame-truncated");
    const stream = input[offset]!;
    const length = input.readUInt32BE(offset + 4);
    const end = offset + 8 + length;
    if ((stream !== 1 && stream !== 2) || end > input.length) throw new Error("rootless-git-test-docker-frame-invalid");
    (stream === 1 ? stdout : stderr).push(input.subarray(offset + 8, end));
    offset = end;
  }
  return { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

async function containerCommand(engine: DockerEngineClient, containerId: string, command: readonly string[]) {
  const execId = await engine.createExec(containerId, {
    command, workingDirectory: "/workspace", environment: {}, attachStdin: false, tty: false
  });
  const stream = await engine.startExecAttached(execId, false);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const output = decodeDockerFrames(Buffer.concat(chunks));
  const inspection = await engine.inspectExec(execId);
  if (inspection.Running || inspection.ExitCode === null) throw new Error("rootless-git-test-exec-did-not-finish");
  return { ...output, exitCode: inspection.ExitCode };
}

async function containerCommandOkay(engine: DockerEngineClient, containerId: string, command: readonly string[]): Promise<string> {
  const result = await containerCommand(engine, containerId, command);
  if (result.exitCode !== 0) {
    throw new Error(`rootless-git-test-command-failed:${command[0] ?? "unknown"}:${result.exitCode}:${result.stderr.slice(0, 240)}`);
  }
  return result.stdout;
}

function recordLabelsMatch(labels: Record<string, string>, input: {
  readonly projectId: string; readonly workspaceId: string; readonly operationIds: readonly string[]; readonly role: string;
}): boolean {
  return labels["devspace.managed"] === "true"
    && labels["devspace.project-id"] === input.projectId
    && labels["devspace.workspace-id"] === input.workspaceId
    && labels["devspace.resource-role"] === input.role
    && input.operationIds.includes(labels["devspace.creation-operation-id"] ?? "");
}

async function removeOwnedNetwork(socketPath: string, networkId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest({ socketPath, method: "DELETE", path: `/networks/${encodeURIComponent(networkId)}` }, (response) => {
      response.resume();
      response.once("end", () => {
        if (response.statusCode === 204 || response.statusCode === 404) resolve();
        else reject(new Error(`rootless-git-test-network-cleanup-failed:${response.statusCode ?? 0}`));
      });
    });
    request.once("error", reject);
    request.end();
  });
}

async function cleanupOwnedRuntime(fixture: NonNullable<typeof activeFixture>): Promise<void> {
  const runtimeDirectory = path.join(fixture.root, "managed/state/ownership/runtimes");
  const creationDirectory = path.join(fixture.root, "managed/state/runtime-creations");
  const containerIds = new Set<string>();
  const networkIds = new Set<string>();
  for (const file of [path.join(runtimeDirectory, `${fixture.workspaceIds[0]}.json`),
    path.join(creationDirectory, `${fixture.workspaceIds[0]}.json`)]) {
    let record: Record<string, unknown>;
    try { record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const container = record.developmentContainer;
    if (typeof container === "object" && container !== null && "id" in container
      && typeof container.id === "string") containerIds.add(container.id);
    if (typeof record.containerId === "string") containerIds.add(record.containerId);
    const network = record.network;
    if (typeof network === "object" && network !== null && "id" in network
      && typeof network.id === "string") networkIds.add(network.id);
    if (typeof record.networkId === "string") networkIds.add(record.networkId);
  }
  const workspaceId = fixture.workspaceIds[0];
  if (workspaceId === undefined) return;
  for (const id of containerIds) {
    let inspected: DockerContainerInspection;
    try { inspected = await fixture.engine.inspectContainer(id); }
    catch (error) {
      if (error instanceof Error && "statusCode" in error && error.statusCode === 404) continue;
      throw error;
    }
    if (!recordLabelsMatch(inspected.Config.Labels, {
      projectId: fixture.projectId, workspaceId, operationIds: fixture.operationIds, role: "development-container"
    })) throw new Error("rootless-git-test-container-ownership-mismatch");
    if (inspected.State.Running) await fixture.engine.stopContainer(id);
    await fixture.engine.removeContainer(id);
  }
  for (const id of networkIds) {
    let inspected: DockerNetworkInspection;
    try { inspected = await fixture.engine.inspectNetwork(id); }
    catch (error) {
      if (error instanceof Error && "statusCode" in error && error.statusCode === 404) continue;
      throw error;
    }
    if (!recordLabelsMatch(inspected.Labels, {
      projectId: fixture.projectId, workspaceId, operationIds: fixture.operationIds, role: "network"
    })) throw new Error("rootless-git-test-network-ownership-mismatch");
    await removeOwnedNetwork(fixture.engine.socketPath, id);
  }
}

async function failedStartDiagnostics(fixture: NonNullable<typeof activeFixture>): Promise<string> {
  const runtimeDirectory = path.join(fixture.root, "managed/state/ownership/runtimes");
  const creationDirectory = path.join(fixture.root, "managed/state/runtime-creations");
  const workspaceId = fixture.workspaceIds[0];
  if (workspaceId === undefined) return "No primary workspace ID was recorded.";
  for (const file of [path.join(runtimeDirectory, `${workspaceId}.json`), path.join(creationDirectory, `${workspaceId}.json`)]) {
    let record: Record<string, unknown>;
    try { record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const candidate = record.developmentContainer;
    const containerId = typeof candidate === "object" && candidate !== null && "id" in candidate
      && typeof candidate.id === "string" ? candidate.id : typeof record.containerId === "string" ? record.containerId : null;
    if (containerId === null) continue;
    try {
      const container = await fixture.engine.inspectContainer(containerId);
      return JSON.stringify({ id: container.Id, name: container.Name, state: container.State,
        labels: container.Config.Labels, workingDirectory: container.Config.WorkingDir,
        hostConfig: container.HostConfig, networks: container.NetworkSettings.Networks,
        mounts: container.Mounts.map(({ Type, Source, Destination, RW, Propagation }) => ({ Type, Source, Destination, RW, Propagation })) }, null, 2);
    } catch (error) {
      return `Container ${containerId} could not be inspected after failed start: ${error instanceof Error ? error.message : "unknown error"}`;
    }
  }
  return "No created development container was recorded before the failed start.";
}

afterEach(async () => {
  if (activeFixture === null) return;
  const fixture = activeFixture;
  await cleanupOwnedRuntime(fixture);
  await rm(fixture.root, { recursive: true, force: true });
  activeFixture = null;
});

test.skipIf(dockerSocketPath === undefined)("real managed containers provide isolated, persistent workspace Git repositories", async () => {
  if (dockerSocketPath === undefined) throw new Error("DEVSPACE_TEST_DOCKER_SOCKET_PATH is required; no Docker socket fallback is permitted.");
  const engine = new DockerEngineClient(dockerSocketPath);
  await engine.assertRootlessAvailable();

  const root = await mkdtemp(path.join(tmpdir(), "devspace-rootless-git-integration-"));
  const projectId = uuidv7();
  const workspaceId = uuidv7();
  const peerWorkspaceId = uuidv7();
  const revisionId = uuidv7();
  const operationIds = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()];
  const [storeOperation, workspaceOperation, startOperation, peerWorkspaceOperation, restartOperation] = operationIds;
  if (storeOperation === undefined || workspaceOperation === undefined || startOperation === undefined
    || peerWorkspaceOperation === undefined || restartOperation === undefined) {
    throw new Error("rootless-git-test-operation-id-generation-failed");
  }
  activeFixture = { root, engine, projectId, workspaceIds: [workspaceId, peerWorkspaceId], operationIds };

  const source = path.join(root, "source");
  const roots = {
    projects: path.join(root, "managed/projects"),
    workspaces: path.join(root, "managed/workspaces"),
    state: path.join(root, "managed/state")
  };
  await mkdir(source, { recursive: true });
  await Promise.all(Object.values(roots).map(async (directory) => await mkdir(directory, { recursive: true })));
  await execFileAsync("/usr/bin/git", ["init", "--initial-branch=main", source], { encoding: "utf8" });
  await hostGit(source, ["config", "user.name", "DevSpace Rootless Integration"]);
  await hostGit(source, ["config", "user.email", "devspace-rootless@example.invalid"]);
  await writeFile(path.join(source, "README.md"), "Managed container Git integration fixture.\n", "utf8");
  await hostGit(source, ["add", "README.md"]);
  await hostGit(source, ["commit", "-m", "Initial integration fixture"]);
  const sourceCommit = await hostGit(source, ["rev-parse", "HEAD"]);
  const sourceUrl = `https://example.invalid/devspace-rootless-${projectId}.git`;
  const git: GitRunner = async (args) => await runGit([
    "-c", `url.${source}.insteadOf=${sourceUrl}`, "-c", "protocol.file.allow=always", ...args
  ]);

  const options = parseProjectOptionsV1({ schemaVersion: 1, developmentEnvironment: {
    source: { kind: "image", imageReference: gitImage }, containerUser: "0:0"
  } });
  const plan = compileRuntimePlanV1(options);
  const revisionHash = hashProjectOptionsV1(options);
  const runtimePlanHash = hashRuntimePlanV1(plan);
  const runtimePolicy = {
    cpuMillicores: 2_000, memoryBytes: 2 * 1024 * 1024 * 1024, pidLimit: 256,
    stabilizationDurationMs: 100, stabilizationIntervalMs: 50, stabilizationTimeoutMs: 30_000
  };
  const runtime = new WorkspaceRuntimeManager(roots.state, engine, runtimePolicy);
  const preview = new PreviewRuntimeManager(roots.state, engine, runtime);
  const managed = new ManagedWorkspaces(roots, git, durableJsonWriter, runtime, preview);
  await managed.initialize();

  await managed.registerRevision({ projectId, revisionId, configuration: {
    format: "devspace.project-options/v1", hash: revisionHash, canonicalJson: canonicalizeProjectOptionsV1(options)
  } });
  await managed.registerRuntimePlan({ projectId, revisionId, revisionHash,
    runtimePlan: { format: plan.format, hash: runtimePlanHash, canonicalJson: canonicalizeRuntimePlanV1(plan) } });
  await managed.createManagedStore({ projectId, source: { kind: "remote", url: sourceUrl } }, storeOperation);
  await managed.fetch(projectId);
  const workspace = createWorkspaceDataSchema.parse({
    projectId, workspaceId, projectSlug: "rootless-git", workspaceSlug: "primary", kind: "primary",
    revision: { revisionId, revisionHash }, branchName: "main", baseRef: { kind: "branch", branchName: "main" }
  });
  await managed.createWorkspace(workspace, workspaceOperation);
  await managed.createWorkspace({ ...workspace, workspaceId: peerWorkspaceId, workspaceSlug: "peer", kind: "isolated" }, peerWorkspaceOperation);
  const worktreePath = managed.worktreePath(workspaceId);
  const peerWorktreePath = managed.worktreePath(peerWorkspaceId);

  try { await managed.startWorkspace(projectId, workspaceId, startOperation); }
  catch (error) {
    const diagnostics = await failedStartDiagnostics(activeFixture);
    throw new Error(`Managed container start failed: ${error instanceof Error ? error.message : "unknown error"}\n${diagnostics}`, { cause: error });
  }
  const execution = await managed.executionContext(projectId, workspaceId);
  const containerId = execution.ownership.developmentContainer.id;
  const container = await engine.inspectContainer(containerId);
  expect(container.State.Running).toBe(true);
  expect(container.Mounts.map((mount) => mount.Destination).sort()).toEqual(["/opt/devspace/harness-home", "/workspace"]);
  expect(container.Mounts.map((mount) => path.resolve(mount.Source)).sort()).toEqual([
    path.resolve(runtime.harnessSlotHostPath(workspaceId)), path.resolve(worktreePath)
  ].sort());
  expect(container.Mounts.some((mount) => mount.Source.includes("docker.sock") || mount.Destination.includes("docker.sock"))).toBe(false);
  expect(container.Mounts.some((mount) => [roots.projects, roots.workspaces, roots.state].some((rootPath) =>
    path.resolve(mount.Source) === path.resolve(rootPath)))).toBe(false);
  const containerEnvironment = await containerCommandOkay(engine, containerId, ["sh", "-c", "env"]);
  const credentialEnvironmentNames = containerEnvironment.split(/\r?\n/u).filter(Boolean).map((entry) => entry.slice(0, entry.indexOf("=")))
    .filter((name) => /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|GITHUB|ACTIONS|DOCKER_HOST|DOCKER_CONFIG|GIT_ASKPASS)/iu.test(name));
  expect(credentialEnvironmentNames).toEqual([]);

  expect(await containerCommandOkay(engine, containerId, ["git", "rev-parse", "--show-toplevel"])).toBe("/workspace\n");
  expect(await containerCommandOkay(engine, containerId, ["git", "status", "--short", "--branch"])).toBe("## main\n");
  expect(await containerCommandOkay(engine, containerId, ["git", "status", "--short", "--untracked-files=all"])).toBe("");
  expect(await containerCommandOkay(engine, containerId, ["git", "add", "-n", "-A"])).toBe("");
  expect(await containerCommandOkay(engine, containerId, ["git", "ls-files", ".devspace-git"])).toBe("");
  expect(await containerCommandOkay(engine, containerId, ["git", "branch", "--show-current"])).toBe("main\n");
  expect(await containerCommandOkay(engine, containerId, ["git", "log", "-1", "--format=%H%n%s"]))
    .toBe(`${sourceCommit}\nInitial integration fixture\n`);
  expect(await containerCommandOkay(engine, containerId, ["git", "rev-parse", "--absolute-git-dir"]))
    .toBe("/workspace/.devspace-git\n");
  expect(await containerCommandOkay(engine, containerId, ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]))
    .toBe("/workspace/.devspace-git\n");
  expect(await containerCommandOkay(engine, containerId, ["git", "rev-parse", "--git-path", "objects"]))
    .toBe("/workspace/.devspace-git/objects\n");
  expect(await containerCommandOkay(engine, containerId, ["git", "rev-parse", "--git-path", "index"]))
    .toBe("/workspace/.devspace-git/index\n");
  const localConfig = await containerCommandOkay(engine, containerId, ["git", "config", "--local", "--list"]);
  expect(localConfig).toContain(`remote.origin.url=${sourceUrl}\n`);
  expect(localConfig).not.toMatch(/^core\.(?:worktree|objectdirectory|alternateRefsCommand)=/mu);
  expect(localConfig).not.toContain(root);
  expect((await containerCommand(engine, containerId, ["sh", "-c", "test ! -e /workspace/.devspace-git/objects/info/alternates"])).exitCode).toBe(0);

  await containerCommandOkay(engine, containerId, ["git", "config", "user.name", "DevSpace Container Test"]);
  await containerCommandOkay(engine, containerId, ["git", "config", "user.email", "container@example.invalid"]);
  await containerCommandOkay(engine, containerId, ["sh", "-c", "printf '%s\\n' 'written and staged in the managed container' > container-change.txt"]);
  expect(await containerCommandOkay(engine, containerId, ["git", "status", "--short", "--untracked-files=all"]))
    .toBe("?? container-change.txt\n");
  expect(await containerCommandOkay(engine, containerId, ["git", "add", "-n", "-A"]))
    .toBe("add 'container-change.txt'\n");
  expect(await containerCommandOkay(engine, containerId, ["git", "ls-files", ".devspace-git"])).toBe("");
  await containerCommandOkay(engine, containerId, ["git", "add", "container-change.txt"]);
  expect(await containerCommandOkay(engine, containerId, ["git", "status", "--short", "--branch"]))
    .toBe("## main\nA  container-change.txt\n");
  await expect(managed.inspectGit(projectId, workspaceId)).resolves.toMatchObject({ branchName: "main", headCommit: sourceCommit, dirty: true });
  await containerCommandOkay(engine, containerId, ["git", "commit", "-m", "Commit from managed container"]);
  const containerCommit = (await containerCommandOkay(engine, containerId, ["git", "rev-parse", "HEAD"])).trim();
  await containerCommandOkay(engine, containerId, ["git", "switch", "-c", "container-feature"]);
  await expect(managed.inspectGit(projectId, workspaceId)).resolves.toMatchObject({
    branchName: "container-feature", headCommit: containerCommit, dirty: false
  });

  await hostGit(peerWorktreePath, ["config", "user.name", "Peer Workspace Test"]);
  await hostGit(peerWorktreePath, ["config", "user.email", "peer@example.invalid"]);
  await writeFile(path.join(peerWorktreePath, "peer-only.txt"), "private peer commit\n", "utf8");
  await hostGit(peerWorktreePath, ["add", "peer-only.txt"]);
  await hostGit(peerWorktreePath, ["commit", "-m", "Peer-only local commit"]);
  const peerCommit = await hostGit(peerWorktreePath, ["rev-parse", "HEAD"]);
  expect((await containerCommand(engine, containerId, ["git", "cat-file", "-e", `${peerCommit}^{commit}`])).exitCode).not.toBe(0);
  expect(await containerCommandOkay(engine, containerId, ["git", "config", "--local", "--get", "remote.origin.url"])).toBe(`${sourceUrl}\n`);
  expect((await containerCommand(engine, containerId, ["git", "config", "--local", "--no-includes", "--get-regexp",
    "^(credential\\.|http\\..*extraheader)"])).exitCode).toBe(1);

  await managed.stopWorkspace(projectId, workspaceId);
  await managed.startWorkspace(projectId, workspaceId, restartOperation);
  const restarted = await managed.executionContext(projectId, workspaceId);
  expect(restarted.ownership.developmentContainer.id).toBe(containerId);
  expect(await containerCommandOkay(engine, containerId, ["git", "status", "--short", "--branch"])).toBe("## container-feature\n");
  expect(await containerCommandOkay(engine, containerId, ["git", "log", "-1", "--format=%H"]))
    .toBe(`${containerCommit}\n`);
  await expect(managed.inspectGit(projectId, workspaceId)).resolves.toMatchObject({
    branchName: "container-feature", headCommit: containerCommit, dirty: false
  });
}, 300_000);
