import { execFile, spawnSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { createWorkspaceDataSchema, gitBranchNameSchema } from "@devspace/contracts";
import { createLogger } from "@devspace/diagnostics";
import {
  canonicalizeProjectOptionsV1, canonicalizeRuntimePlanV1, compileRuntimePlanV1, hashProjectOptionsV1, hashRuntimePlanV1,
  parseProjectOptionsV1
} from "@devspace/project-options";
import { AgentExecutionError, ManagedWorkspaces, runGit, type GitRunner } from "./managed-workspaces.js";
import { createGithubAskpassBroker } from "./github-askpass.js";
import type { GithubAppAuthority } from "./github-app.js";
import { DockerEngineClient } from "./docker-runtime.js";
import { PreviewRuntimeManager } from "./preview-runtime.js";
import { WorkspaceRuntimeError, WorkspaceRuntimeManager } from "./workspace-runtime.js";
import { PrivateStateCorruptionError, durableJsonWriter, identityOf, type AtomicJsonWriter } from "./private-state.js";

const exec = promisify(execFile);
const projectId = "018f0f00-0000-7000-8000-000000000001";
const revisionId = "018f0f00-0000-7000-8000-000000000002";
const workspaceId = "018f0f00-0000-7000-8000-000000000003";
const storeOperation = "018f0f00-0000-7000-8000-000000000010";
const workspaceOperation = "018f0f00-0000-7000-8000-000000000011";
const sourceUrl = "https://example.com/repository.git";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

class UnexpectedRuntimeStart extends WorkspaceRuntimeManager {
  override start(..._args: Parameters<WorkspaceRuntimeManager["start"]>): Promise<never> {
    return Promise.reject(new Error("unexpected-runtime-start"));
  }
}

class NoopPreviewRuntime extends PreviewRuntimeManager {
  override reserveWorkspaceLeases(..._args: Parameters<PreviewRuntimeManager["reserveWorkspaceLeases"]>): Promise<[]> {
    return Promise.resolve([]);
  }
  override releaseOperationLeases(..._args: Parameters<PreviewRuntimeManager["releaseOperationLeases"]>): Promise<void> {
    return Promise.resolve();
  }
}

class RunningRuntime extends WorkspaceRuntimeManager {
  override inspect(..._args: Parameters<WorkspaceRuntimeManager["inspect"]>): Promise<{
    observedState: "absent" | "starting" | "running" | "stopping" | "stopped" | "failed" | "lost";
    serviceState: "absent" | "starting" | "running" | "stopping" | "stopped" | "failed" | "lost";
    errorCode: string | null;
    containerIdentity: string | null;
  }> {
    return Promise.resolve({ observedState: "running", serviceState: "running", errorCode: null, containerIdentity: "fixture" });
  }
}

class RejectingStopRuntime extends WorkspaceRuntimeManager {
  stopCalled = false;
  override stop(..._args: Parameters<WorkspaceRuntimeManager["stop"]>): Promise<never> {
    this.stopCalled = true;
    return Promise.reject(new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "fixture Docker ownership mismatch"));
  }
}

class StoppedFailingStartRuntime extends WorkspaceRuntimeManager {
  startedWorktreePath: string | null = null;
  override inspect(..._args: Parameters<WorkspaceRuntimeManager["inspect"]>): Promise<{
    observedState: "absent" | "starting" | "running" | "stopping" | "stopped" | "failed" | "lost";
    serviceState: "absent" | "starting" | "running" | "stopping" | "stopped" | "failed" | "lost";
    errorCode: string | null;
    containerIdentity: string | null;
  }> {
    return Promise.resolve({ observedState: "stopped", serviceState: "stopped", errorCode: null, containerIdentity: "fixture-stopped" });
  }
  override start(...args: Parameters<WorkspaceRuntimeManager["start"]>): Promise<never> {
    this.startedWorktreePath = args[2];
    return Promise.reject(new Error("fixture-stop-after-git-migration"));
  }
}

class FailingLegacyInspectionRuntime extends StoppedFailingStartRuntime {
  override inspect(..._args: Parameters<WorkspaceRuntimeManager["inspect"]>): Promise<never> {
    return Promise.reject(new TypeError("token=fixture-only; path=/fixture-only"));
  }
}

class FailingRuntimeInspection extends WorkspaceRuntimeManager {
  readonly inspectedAssociations: Parameters<WorkspaceRuntimeManager["inspect"]>[0][] = [];
  override inspect(...args: Parameters<WorkspaceRuntimeManager["inspect"]>): Promise<never> {
    this.inspectedAssociations.push(args[0]);
    return Promise.reject(new TypeError("runtime inspection failed"));
  }
}

async function commit(source: string, content: string): Promise<string> {
  await writeFile(path.join(source, "README.md"), content, "utf8");
  await exec("/usr/bin/git", ["-C", source, "add", "README.md"]);
  await exec("/usr/bin/git", ["-C", source, "commit", "-m", content.trim()]);
  return (await exec("/usr/bin/git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
}

async function harness(writer: AtomicJsonWriter = durableJsonWriter, wrap?: (base: GitRunner) => GitRunner) {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-managed-test-")); directories.push(root);
  const source = path.join(root, "source");
  await exec("/usr/bin/git", ["init", "-b", "main", source]);
  await exec("/usr/bin/git", ["-C", source, "config", "user.name", "DevSpace Test"]);
  await exec("/usr/bin/git", ["-C", source, "config", "user.email", "devspace@example.invalid"]);
  const firstCommit = await commit(source, "first\n");
  const roots = { projects: path.join(root, "managed/projects"), workspaces: path.join(root, "managed/workspaces"), state: path.join(root, "managed/state") };
  await Promise.all(Object.values(roots).map(async (directory) => await mkdir(directory, { recursive: true })));
  const base: GitRunner = async (args) => await runGit([
    "-c", `url.${source}.insteadOf=${sourceUrl}`, "-c", "protocol.file.allow=always", ...args
  ]);
  const git = wrap?.(base) ?? base;
  const managed = new ManagedWorkspaces(roots, git, writer);
  await managed.initialize();
  const options = parseProjectOptionsV1({ schemaVersion: 1, developmentEnvironment: { source: { kind: "image", imageReference: "node:24-bookworm" } } });
  const hash = hashProjectOptionsV1(options);
  const workspace = createWorkspaceDataSchema.parse({
    projectId, workspaceId, projectSlug: "project", workspaceSlug: "primary", kind: "primary", revision: { revisionId, revisionHash: hash },
    branchName: "main", baseRef: { kind: "branch", branchName: "main" }
  });
  const register = async () => await managed.registerRevision({ projectId, revisionId, configuration: {
    format: "devspace.project-options/v1", hash, canonicalJson: canonicalizeProjectOptionsV1(options)
  } });
  const createStore = async (operationId = storeOperation) => await managed.createManagedStore({ projectId, source: { kind: "remote", url: sourceUrl } }, operationId);
  return { root, source, roots, managed, git, workspace, firstCommit, register, createStore };
}

async function makeLegacyDirtyWorkspace(h: Awaited<ReturnType<typeof harness>>) {
  await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  const repository = h.managed.repositoryPath(projectId);
  const worktreePath = h.managed.worktreePath(workspaceId);
  const parentPath = path.dirname(worktreePath);
  await mkdir(parentPath, { mode: 0o700 });
  await h.git(["--git-dir", repository, "update-ref", "refs/heads/main", h.firstCommit]);
  await h.git(["--git-dir", repository, "worktree", "add", "--", worktreePath, "main"]);
  await h.git(["-C", worktreePath, "config", "user.name", "Legacy Workspace Owner"]);
  await h.git(["-C", worktreePath, "config", "user.email", "legacy@example.invalid"]);
  await writeFile(path.join(worktreePath, "local-commit.txt"), "unpublished local commit\n", "utf8");
  await h.git(["-C", worktreePath, "add", "local-commit.txt"]);
  await h.git(["-C", worktreePath, "commit", "-m", "Unpublished workspace commit"]);
  const localCommit = (await h.git(["-C", worktreePath, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(path.join(worktreePath, "staged.txt"), "staged version\n", "utf8");
  await h.git(["-C", worktreePath, "add", "staged.txt"]);
  await writeFile(path.join(worktreePath, "staged.txt"), "staged and unstaged version\n", "utf8");
  await writeFile(path.join(worktreePath, "README.md"), "unstaged README change\n", "utf8");
  await writeFile(path.join(worktreePath, "untracked.txt"), "untracked content\n", "utf8");
  const status = (await h.git(["-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all"])).stdout;
  const oldGitPointer = await readFile(path.join(worktreePath, ".git"), "utf8");
  const adminPath = oldGitPointer.trim().slice("gitdir: ".length);
  const storeRecord = await readJson<StoreOwnershipTestRecord>(path.join(h.roots.state, "ownership/projects", `${projectId}.json`));
  const ownership = {
    version: 1, projectId, workspaceId, projectSlug: h.workspace.projectSlug, workspaceSlug: h.workspace.workspaceSlug,
    kind: h.workspace.kind, worktreePath, identity: identityOf(await lstat(worktreePath, { bigint: true })),
    parentPath, parentIdentity: identityOf(await lstat(parentPath, { bigint: true })),
    store: { repositoryPath: repository, identity: storeRecord.identity },
    revision: h.workspace.revision, branchName: "main", baseRef: { kind: "branch", branchName: "main" }, creationCommit: h.firstCommit
  };
  await writeJson(path.join(h.roots.state, "ownership/workspaces", `${workspaceId}.json`), ownership);
  return { worktreePath, repository, localCommit, status, oldGitPointer, adminPath };
}

async function migrationManager(h: Awaited<ReturnType<typeof harness>>, writer: AtomicJsonWriter = durableJsonWriter,
  runtimeOverride?: WorkspaceRuntimeManager, logger?: ReturnType<typeof createLogger>, git: GitRunner = h.git) {
  const options = parseProjectOptionsV1({ schemaVersion: 1,
    developmentEnvironment: { source: { kind: "image", imageReference: "node:24-bookworm" } } });
  const plan = compileRuntimePlanV1(options);
  const engine = new DockerEngineClient(path.join(h.root, "fixture-docker.sock"));
  const policy = { cpuMillicores: 2_000, memoryBytes: 1024 * 1024 * 1024, pidLimit: 256,
    stabilizationDurationMs: 20, stabilizationIntervalMs: 10, stabilizationTimeoutMs: 50 };
  const runtime = runtimeOverride ?? new StoppedFailingStartRuntime(h.roots.state, engine, policy);
  const preview = new NoopPreviewRuntime(h.roots.state, engine, runtime);
  const managed = new ManagedWorkspaces(h.roots, git, writer, runtime, preview,
    undefined, undefined, undefined, undefined, logger);
  await managed.initialize();
  await managed.registerRuntimePlan({ projectId, revisionId, revisionHash: hashProjectOptionsV1(options),
    runtimePlan: { format: plan.format, hash: hashRuntimePlanV1(plan), canonicalJson: canonicalizeRuntimePlanV1(plan) } });
  return managed;
}

test("keeps configured GitHub authority outside general Agent health until private Git needs askpass", async () => {
  const h = await harness();
  const broker = createGithubAskpassBroker({ runtimeBases: [path.join(h.root, "unavailable-runtime")] });
  const managed = new ManagedWorkspaces(h.roots, h.git, durableJsonWriter, undefined, undefined, undefined, undefined, undefined, broker);
  managed.setGithubAuthority({} as GithubAppAuthority);
  await managed.initialize();
  expect(managed.isHealthy).toBe(true);
  expect(broker.socketPath).toBeNull();
  await expect(managed.inspectSource({ kind: "github-app", connectionId: "018f0d84-7b39-7cc3-9d4a-0675d9162a11", repositoryId: "9007199254740993" }))
    .rejects.toMatchObject({ failure: { code: "SOURCE_UNAVAILABLE" } });
  expect(managed.isHealthy).toBe(true);
  await managed.shutdown();
});

function differentDevice(device: string): string { return device === "44" ? "45" : "44"; }

type JsonRecord = Record<string, unknown>;
type IdentityRecord = { device: string; inode: string };
type StoreOwnershipTestRecord = JsonRecord & { identity: IdentityRecord; repositoryPath: string };
type WorkspaceOwnershipTestRecord = JsonRecord & {
  identity: IdentityRecord; parentIdentity: IdentityRecord; branchName: string;
  store: { identity: IdentityRecord };
};

async function readJson<T extends JsonRecord>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: JsonRecord): Promise<void> {
  await writeFile(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

test("creates, owns, revalidates, and reloads a real store and worktree", async () => {
  const h = await harness();
  await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  const productionManaged = new ManagedWorkspaces(h.roots, runGit);
  await productionManaged.initialize();
  await productionManaged.createWorkspace(h.workspace, workspaceOperation);
  await h.createStore("018f0f00-0000-7000-8000-000000000020");
  await productionManaged.createWorkspace(h.workspace, "018f0f00-0000-7000-8000-000000000021");
  await expect(productionManaged.inspectWorkspace(projectId, workspaceId)).resolves.toMatchObject({ observedState: "stopped", dirty: false });
  const owner = await readJson<WorkspaceOwnershipTestRecord>(path.join(h.roots.state, "ownership/workspaces", `${workspaceId}.json`));
  expect(owner.version).toBe(2);
  await expect(readFile(path.join(productionManaged.worktreePath(workspaceId), ".git"), "utf8"))
    .resolves.toBe("gitdir: .devspace-git\n");
  await expect(exec("/usr/bin/git", ["-C", productionManaged.worktreePath(workspaceId), "rev-parse", "HEAD"]))
    .resolves.toMatchObject({ stdout: `${h.firstCommit}\n` });
  await expect(exec("/usr/bin/git", ["-C", productionManaged.worktreePath(workspaceId), "rev-parse", "refs/remotes/origin/main"]))
    .resolves.toMatchObject({ stdout: `${h.firstCommit}\n` });
  await expect(lstat(path.join(productionManaged.worktreePath(workspaceId), ".devspace-git", "objects", "info", "alternates")))
    .rejects.toMatchObject({ code: "ENOENT" });
  const restarted = new ManagedWorkspaces(h.roots, runGit);
  await restarted.initialize();
  await expect(restarted.inspectGit(projectId, null)).resolves.toMatchObject({ workspaceId: null });
  await expect(restarted.inspectGit(projectId, workspaceId)).resolves.toMatchObject({ branchName: "main", headCommit: h.firstCommit, dirty: false });
});

test("runtime-only workspace inspection avoids Git status and keeps ownership validation", async () => {
  const h = await harness();
  await h.register(); await h.createStore(); await h.managed.fetch(projectId); await h.managed.createWorkspace(h.workspace, workspaceOperation);
  const statusFailingGit: GitRunner = async (args) => {
    if (args.includes("status")) throw new Error("Git status failed");
    return await h.git(args);
  };
  const managed = new ManagedWorkspaces(h.roots, statusFailingGit);
  await managed.initialize();

  await expect(managed.inspectWorkspace(projectId, workspaceId)).rejects.toMatchObject({ failure: { code: "GIT_OPERATION_FAILED" } });
  await expect(managed.inspectWorkspaceRuntime(projectId, workspaceId))
    .resolves.toEqual({ desiredState: "absent", observedState: "absent" });
  await expect(managed.inspectWorkspaceRuntime("018f0f00-0000-7000-8000-000000000099", workspaceId))
    .rejects.toMatchObject({ failure: { code: "WORKSPACE_STATE_CONFLICT" } });
});

test("runtime-only workspace inspection still blocks on runtime inspection failure", async () => {
  const h = await harness();
  await h.register(); await h.createStore(); await h.managed.fetch(projectId); await h.managed.createWorkspace(h.workspace, workspaceOperation);
  const engine = new DockerEngineClient(path.join(h.root, "fixture-docker.sock"));
  const policy = { cpuMillicores: 2_000, memoryBytes: 1024 * 1024 * 1024, pidLimit: 256,
    stabilizationDurationMs: 20, stabilizationIntervalMs: 10, stabilizationTimeoutMs: 50 };
  const runtime = new FailingRuntimeInspection(h.roots.state, engine, policy);
  const managed = await migrationManager(h, durableJsonWriter, runtime);

  await expect(managed.inspectWorkspaceRuntime(projectId, workspaceId)).rejects.toBeInstanceOf(TypeError);
  expect(runtime.inspectedAssociations).toHaveLength(1);
  expect(runtime.inspectedAssociations[0]).toMatchObject({ projectId, workspaceId, revisionId, generation: 1 });
});

test("keeps each workspace Git repository container-local and visible to Agent inspection", async () => {
  const h = await harness();
  await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  const managed = new ManagedWorkspaces(h.roots, runGit);
  await managed.initialize();
  const secondWorkspaceId = "018f0f00-0000-7000-8000-000000000099";
  await managed.createWorkspace(h.workspace, workspaceOperation);
  await managed.createWorkspace({ ...h.workspace, workspaceId: secondWorkspaceId, workspaceSlug: "second", kind: "isolated",
    branchName: gitBranchNameSchema.parse("peer") }, "018f0f00-0000-7000-8000-000000000012");
  const firstPath = h.managed.worktreePath(workspaceId);
  const secondPath = h.managed.worktreePath(secondWorkspaceId);

  await expect(readFile(path.join(firstPath, ".git"), "utf8")).resolves.toBe("gitdir: .devspace-git\n");
  await expect(exec("/usr/bin/git", ["-C", firstPath, "rev-parse", "--show-toplevel"]))
    .resolves.toMatchObject({ stdout: `${firstPath}\n` });
  await expect(exec("/usr/bin/git", ["-C", firstPath, "rev-parse", "--path-format=absolute", "--git-common-dir"]))
    .resolves.toMatchObject({ stdout: `${firstPath}/.devspace-git\n` });
  await expect(exec("/usr/bin/git", ["-C", firstPath, "status", "--short", "--branch"]))
    .resolves.toMatchObject({ stdout: "## main\n" });

  const exclude = await readFile(path.join(firstPath, ".devspace-git", "info", "exclude"), "utf8");
  expect(exclude.split(/\r?\n/u)).toContain("/.devspace-git/");
  await writeFile(path.join(firstPath, "ordinary-untracked.txt"), "ordinary workspace content\n", "utf8");
  const metadataCheck = {
    status: (await exec("/usr/bin/git", ["-C", firstPath, "status", "--short", "--untracked-files=all"])).stdout,
    addDryRun: (await exec("/usr/bin/git", ["-C", firstPath, "add", "-n", "-A"])).stdout,
    trackedMetadata: (await exec("/usr/bin/git", ["-C", firstPath, "ls-files", ".devspace-git"])).stdout,
    topLevel: (await exec("/usr/bin/git", ["-C", firstPath, "rev-parse", "--show-toplevel"])).stdout,
    gitDirectory: (await exec("/usr/bin/git", ["-C", firstPath, "rev-parse", "--absolute-git-dir"])).stdout
  };
  expect(metadataCheck).toEqual({
    status: "?? ordinary-untracked.txt\n",
    addDryRun: "add 'ordinary-untracked.txt'\n",
    trackedMetadata: "",
    topLevel: `${firstPath}\n`,
    gitDirectory: `${firstPath}/.devspace-git\n`
  });
  await exec("/usr/bin/git", ["-C", firstPath, "add", "-A"]);
  await expect(exec("/usr/bin/git", ["-C", firstPath, "ls-files", ".devspace-git"]))
    .resolves.toMatchObject({ stdout: "" });
  await expect(exec("/usr/bin/git", ["-C", firstPath, "ls-files", "ordinary-untracked.txt"]))
    .resolves.toMatchObject({ stdout: "ordinary-untracked.txt\n" });
  await exec("/usr/bin/git", ["-C", firstPath, "reset", "--", "ordinary-untracked.txt"]);
  await unlink(path.join(firstPath, "ordinary-untracked.txt"));

  const localConfig = (await exec("/usr/bin/git", ["-C", firstPath, "config", "--local", "--list"])).stdout;
  expect(localConfig).toContain(`remote.origin.url=${sourceUrl}\n`);
  expect(localConfig).not.toMatch(/^core\.(?:worktree|objectdirectory|alternateRefsCommand)=/mu);
  expect(localConfig).not.toContain(h.root);
  await expect(lstat(path.join(firstPath, ".devspace-git", "objects", "info", "alternates")))
    .rejects.toMatchObject({ code: "ENOENT" });
  await expect(exec("/usr/bin/git", ["-C", firstPath, "rev-parse", "--git-path", "objects"]))
    .resolves.toMatchObject({ stdout: `${firstPath}/.devspace-git/objects\n` });
  await expect(exec("/usr/bin/git", ["-C", firstPath, "rev-parse", "--git-path", "index"]))
    .resolves.toMatchObject({ stdout: `${firstPath}/.devspace-git/index\n` });
  const relocatedPath = path.join(h.root, "relocated-at-workspace");
  await cp(firstPath, relocatedPath, { recursive: true });
  await expect(exec("/usr/bin/git", ["-C", relocatedPath, "rev-parse", "--show-toplevel"]))
    .resolves.toMatchObject({ stdout: `${relocatedPath}\n` });
  await expect(exec("/usr/bin/git", ["-C", relocatedPath, "rev-parse", "--absolute-git-dir"]))
    .resolves.toMatchObject({ stdout: `${relocatedPath}/.devspace-git\n` });
  await expect(exec("/usr/bin/git", ["-C", relocatedPath, "status", "--short", "--untracked-files=all"]))
    .resolves.toMatchObject({ stdout: "" });

  await exec("/usr/bin/git", ["-C", firstPath, "config", "user.name", "Container Git Test"]);
  await exec("/usr/bin/git", ["-C", firstPath, "config", "user.email", "container@example.invalid"]);
  await writeFile(path.join(firstPath, "container-commit.txt"), "committed from workspace Git\n", "utf8");
  await exec("/usr/bin/git", ["-C", firstPath, "add", "container-commit.txt"]);
  await exec("/usr/bin/git", ["-C", firstPath, "commit", "-m", "Commit from workspace Git"]);
  const localCommit = (await exec("/usr/bin/git", ["-C", firstPath, "rev-parse", "HEAD"])).stdout.trim();
  await expect(managed.inspectGit(projectId, workspaceId)).resolves.toMatchObject({ headCommit: localCommit, dirty: false });

  await exec("/usr/bin/git", ["-C", firstPath, "switch", "-c", "local-only"]);
  await expect(managed.inspectGit(projectId, workspaceId)).resolves.toMatchObject({ branchName: "local-only", headCommit: localCommit });
  const fetchedCommit = await commit(h.source, "remote fetch update\n");
  await h.managed.fetch(projectId);
  await expect(exec("/usr/bin/git", ["-C", firstPath, "rev-parse", "refs/remotes/origin/main"]))
    .resolves.toMatchObject({ stdout: `${fetchedCommit}\n` });
  await expect(exec("/usr/bin/git", ["-C", firstPath, "rev-parse", "refs/heads/main"]))
    .resolves.toMatchObject({ stdout: `${localCommit}\n` });
  await expect(exec("/usr/bin/git", ["-C", firstPath, "rev-parse", "refs/heads/local-only"]))
    .resolves.toMatchObject({ stdout: `${localCommit}\n` });
  await expect(managed.inspectGit(projectId, workspaceId)).resolves.toMatchObject({ branchName: "local-only", headCommit: localCommit });
  await expect(exec("/usr/bin/git", ["-C", secondPath, "show-ref", "--verify", "refs/heads/local-only"])).rejects.toBeDefined();
  await expect(exec("/usr/bin/git", ["-C", secondPath, "cat-file", "-e", `${localCommit}^{commit}`])).rejects.toBeDefined();
});

test("the protected production Git runner rejects unrelated local file transport", async () => {
  const h = await harness();
  await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  const target = path.join(h.root, "unrelated-target.git");
  await exec("/usr/bin/git", ["init", "--bare", target]);

  await expect(runGit(["--git-dir", target, "fetch", "--no-tags", h.managed.repositoryPath(projectId), "refs/remotes/origin/main"]))
    .rejects.toThrow("git-command-failed");
  await expect(exec("/usr/bin/git", ["--git-dir", target, "show-ref", "--verify", "refs/remotes/origin/main"]))
    .rejects.toBeDefined();
});

test("migrates a stopped legacy workspace without losing local commits or index state", async () => {
  const h = await harness();
  const legacy = await makeLegacyDirtyWorkspace(h);
  const options = parseProjectOptionsV1({ schemaVersion: 1,
    developmentEnvironment: { source: { kind: "image", imageReference: "node:24-bookworm" } } });
  const plan = compileRuntimePlanV1(options);
  await h.managed.registerRuntimePlan({ projectId, revisionId, revisionHash: hashProjectOptionsV1(options),
    runtimePlan: { format: plan.format, hash: hashRuntimePlanV1(plan), canonicalJson: canonicalizeRuntimePlanV1(plan) } });
  const engine = new DockerEngineClient(path.join(h.root, "fixture-docker.sock"));
  const policy = { cpuMillicores: 2_000, memoryBytes: 1024 * 1024 * 1024, pidLimit: 256,
    stabilizationDurationMs: 20, stabilizationIntervalMs: 10, stabilizationTimeoutMs: 50 };
  const runtime = new StoppedFailingStartRuntime(h.roots.state, engine, policy);
  const preview = new NoopPreviewRuntime(h.roots.state, engine, runtime);
  const logLines: string[] = [];
  const logger = createLogger({ component: "agent", subsystem: "test", sink: (line) => logLines.push(line) });
  const managed = new ManagedWorkspaces(h.roots, runGit, durableJsonWriter, runtime, preview,
    undefined, undefined, undefined, undefined, logger);
  await managed.initialize();

  await expect(managed.startWorkspace(projectId, workspaceId, "018f0f00-0000-7000-8000-000000000013"))
    .rejects.toMatchObject({ failure: { code: "AGENT_INTERNAL_ERROR" } });
  expect(logLines.map((line) => JSON.parse(line) as Record<string, unknown>)
    .some((record) => record.event === "agent.workspace.start.phase_failed" && record.phase === "runtime-startup")).toBe(true);

  const metadataPath = path.join(legacy.worktreePath, ".devspace-git");
  await expect(readFile(path.join(legacy.worktreePath, ".git"), "utf8")).resolves.toBe("gitdir: .devspace-git\n");
  await expect(exec("/usr/bin/git", ["-C", legacy.worktreePath, "rev-parse", "--show-toplevel"]))
    .resolves.toMatchObject({ stdout: `${legacy.worktreePath}\n` });
  await expect(exec("/usr/bin/git", ["-C", legacy.worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"]))
    .resolves.toMatchObject({ stdout: `${metadataPath}\n` });
  await expect(readFile(path.join(metadataPath, "info", "exclude"), "utf8"))
    .resolves.toContain("/.devspace-git/");
  const migratedAddDryRun = (await exec("/usr/bin/git", ["-C", legacy.worktreePath, "add", "-n", "-A"])).stdout;
  expect(migratedAddDryRun).not.toContain(".devspace-git");
  await expect(exec("/usr/bin/git", ["-C", legacy.worktreePath, "ls-files", ".devspace-git"]))
    .resolves.toMatchObject({ stdout: "" });
  await expect(exec("/usr/bin/git", ["-C", legacy.worktreePath, "status", "--porcelain=v1", "--untracked-files=all"]))
    .resolves.toMatchObject({ stdout: legacy.status });
  await expect(exec("/usr/bin/git", ["-C", legacy.worktreePath, "rev-parse", "HEAD"]))
    .resolves.toMatchObject({ stdout: `${legacy.localCommit}\n` });
  await expect(exec("/usr/bin/git", ["-C", legacy.worktreePath, "rev-parse", "refs/remotes/origin/main"]))
    .resolves.toMatchObject({ stdout: `${h.firstCommit}\n` });
  await expect(exec("/usr/bin/git", ["-C", legacy.worktreePath, "show", ":staged.txt"]))
    .resolves.toMatchObject({ stdout: "staged version\n" });
  await expect(readFile(path.join(legacy.worktreePath, "staged.txt"), "utf8")).resolves.toBe("staged and unstaged version\n");
  await expect(readFile(path.join(legacy.worktreePath, "README.md"), "utf8")).resolves.toBe("unstaged README change\n");
  await expect(readFile(path.join(legacy.worktreePath, "untracked.txt"), "utf8")).resolves.toBe("untracked content\n");
  await expect(managed.inspectGit(projectId, workspaceId)).resolves.toMatchObject({
    branchName: "main", headCommit: legacy.localCommit, dirty: true, identity: { name: "Legacy Workspace Owner", email: "legacy@example.invalid" }
  });
  const owner = await readJson<WorkspaceOwnershipTestRecord>(path.join(h.roots.state, "ownership/workspaces", `${workspaceId}.json`));
  expect(owner.version).toBe(2);
  await expect(lstat(path.join(metadataPath, "objects", "info", "alternates"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(legacy.adminPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(runtime.startedWorktreePath).toBe(legacy.worktreePath);
});

test("identifies an unexpected runtime inspection failure before legacy Git migration", async () => {
  const h = await harness();
  const legacy = await makeLegacyDirtyWorkspace(h);
  const runtime = new FailingLegacyInspectionRuntime(h.roots.state,
    new DockerEngineClient(path.join(h.root, "fixture-docker.sock")), {
      cpuMillicores: 2_000, memoryBytes: 1024 * 1024 * 1024, pidLimit: 256,
      stabilizationDurationMs: 20, stabilizationIntervalMs: 10, stabilizationTimeoutMs: 50
    });
  const logLines: string[] = [];
  const logger = createLogger({ component: "agent", subsystem: "test", sink: (line) => logLines.push(line) });
  const managed = await migrationManager(h, durableJsonWriter, runtime, logger);

  await expect(managed.startWorkspace(projectId, workspaceId, "018f0f00-0000-7000-8000-000000000017"))
    .rejects.toMatchObject({ failure: { code: "AGENT_INTERNAL_ERROR" } });
  const runtimeFailure = logLines.map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((record) => record.event === "agent.workspace.start.phase_failed");
  expect(runtimeFailure).toMatchObject({ phase: "runtime-inspection", errorClass: "TypeError", outcome: "failure" });
  expect(logLines.join("\n")).not.toContain("fixture-only");
  await expect(readFile(path.join(legacy.worktreePath, ".git"), "utf8")).resolves.toBe(legacy.oldGitPointer);
  await expect(lstat(path.join(legacy.worktreePath, ".devspace-git"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(legacy.adminPath)).resolves.toBeTruthy();
});

test("a failed legacy workspace migration leaves its original Git state recoverable", async () => {
  const h = await harness();
  const legacy = await makeLegacyDirtyWorkspace(h);
  const options = parseProjectOptionsV1({ schemaVersion: 1,
    developmentEnvironment: { source: { kind: "image", imageReference: "node:24-bookworm" } } });
  const plan = compileRuntimePlanV1(options);
  await h.managed.registerRuntimePlan({ projectId, revisionId, revisionHash: hashProjectOptionsV1(options),
    runtimePlan: { format: plan.format, hash: hashRuntimePlanV1(plan), canonicalJson: canonicalizeRuntimePlanV1(plan) } });
  const failingGit: GitRunner = async (args) => {
    if (args.includes("apply")) throw new TypeError("token=fixture-only; path=/fixture-only");
    return await runGit(args);
  };
  const engine = new DockerEngineClient(path.join(h.root, "fixture-docker.sock"));
  const policy = { cpuMillicores: 2_000, memoryBytes: 1024 * 1024 * 1024, pidLimit: 256,
    stabilizationDurationMs: 20, stabilizationIntervalMs: 10, stabilizationTimeoutMs: 50 };
  const runtime = new StoppedFailingStartRuntime(h.roots.state, engine, policy);
  const preview = new NoopPreviewRuntime(h.roots.state, engine, runtime);
  const logLines: string[] = [];
  const logger = createLogger({ component: "agent", subsystem: "test", sink: (line) => logLines.push(line) });
  const managed = new ManagedWorkspaces(h.roots, failingGit, durableJsonWriter, runtime, preview,
    undefined, undefined, undefined, undefined, logger);
  await managed.initialize();

  await expect(managed.startWorkspace(projectId, workspaceId, "018f0f00-0000-7000-8000-000000000014"))
    .rejects.toThrow("token=fixture-only; path=/fixture-only");
  const migrationFailure = logLines.map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((record) => record.event === "agent.workspace.start.phase_failed");
  expect(migrationFailure).toMatchObject({ phase: "git-migration-stage-index", errorClass: "TypeError", outcome: "failure" });
  const migrationRecovery = logLines.map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((record) => record.event === "agent.workspace.git_migration.recovered");
  expect(migrationRecovery).toMatchObject({ phase: "git-migration-recovery", outcome: "success" });
  expect(logLines.join("\n")).not.toContain("fixture-only");
  await expect(readFile(path.join(legacy.worktreePath, ".git"), "utf8")).resolves.toBe(legacy.oldGitPointer);
  await expect(exec("/usr/bin/git", ["-C", legacy.worktreePath, "status", "--porcelain=v1", "--untracked-files=all"]))
    .resolves.toMatchObject({ stdout: legacy.status });
  await expect(exec("/usr/bin/git", ["-C", legacy.worktreePath, "rev-parse", "HEAD"]))
    .resolves.toMatchObject({ stdout: `${legacy.localCommit}\n` });
  await expect(lstat(path.join(legacy.worktreePath, ".devspace-git"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(path.join(path.dirname(legacy.worktreePath), ".git-migration-018f0f00-0000-7000-8000-000000000014")))
    .rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(path.join(h.roots.state, "git-migrations", `${workspaceId}.json`)))
    .rejects.toMatchObject({ code: "ENOENT" });
  await expect(managed.inspectGit(projectId, workspaceId)).resolves.toMatchObject({ headCommit: legacy.localCommit, dirty: true });
  expect(runtime.startedWorktreePath).toBeNull();
});

test("a failure immediately before the Git pointer switch retains legacy administration", async () => {
  const h = await harness();
  const legacy = await makeLegacyDirtyWorkspace(h);
  let failPreparedWrite = true;
  const writer: AtomicJsonWriter = { async write(file, value) {
    await durableJsonWriter.write(file, value);
    const record = value as { phase?: string; metadataPath?: unknown; gitAdministration?: unknown };
    if (failPreparedWrite && record.phase === "prepared" && record.metadataPath !== undefined
      && record.gitAdministration !== undefined) {
      failPreparedWrite = false;
      throw new Error("simulated-interruption-before-git-pointer-switch");
    }
  } };
  const managed = await migrationManager(h, writer, undefined, undefined, runGit);

  await expect(managed.startWorkspace(projectId, workspaceId, "018f0f00-0000-7000-8000-000000000015"))
    .rejects.toThrow("simulated-interruption-before-git-pointer-switch");

  await expect(readFile(path.join(legacy.worktreePath, ".git"), "utf8")).resolves.toBe(legacy.oldGitPointer);
  await expect(lstat(legacy.adminPath)).resolves.toBeTruthy();
  await expect(lstat(path.join(legacy.worktreePath, ".devspace-git"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(exec("/usr/bin/git", ["-C", legacy.worktreePath, "status", "--porcelain=v1", "--untracked-files=all"]))
    .resolves.toMatchObject({ stdout: legacy.status });
  await expect(exec("/usr/bin/git", ["-C", legacy.worktreePath, "rev-parse", "HEAD"]))
    .resolves.toMatchObject({ stdout: `${legacy.localCommit}\n` });
});

test("a restart immediately after the Git pointer switch recovers before pruning legacy administration", async () => {
  const h = await harness();
  const legacy = await makeLegacyDirtyWorkspace(h);
  const writer: AtomicJsonWriter = { async write(file, value) {
    const record = value as { phase?: string; metadataPath?: unknown; gitAdministration?: unknown };
    if (record.phase === "installed" && record.metadataPath !== undefined && record.gitAdministration !== undefined) {
      throw new Error("simulated-interruption-after-git-pointer-switch");
    }
    await durableJsonWriter.write(file, value);
  } };
  const managed = await migrationManager(h, writer, undefined, undefined, runGit);

  await expect(managed.startWorkspace(projectId, workspaceId, "018f0f00-0000-7000-8000-000000000016"))
    .rejects.toThrow("simulated-interruption-after-git-pointer-switch");

  const metadataPath = path.join(legacy.worktreePath, ".devspace-git");
  await expect(readFile(path.join(legacy.worktreePath, ".git"), "utf8")).resolves.toBe("gitdir: .devspace-git\n");
  await expect(lstat(legacy.adminPath)).resolves.toBeTruthy();
  await expect(exec("/usr/bin/git", ["-C", legacy.worktreePath, "rev-parse", "HEAD"]))
    .resolves.toMatchObject({ stdout: `${legacy.localCommit}\n` });
  await expect(exec("/usr/bin/git", ["-C", legacy.worktreePath, "show", ":staged.txt"]))
    .resolves.toMatchObject({ stdout: "staged version\n" });
  await expect(exec("/usr/bin/git", ["-C", legacy.worktreePath, "status", "--porcelain=v1", "--untracked-files=all"]))
    .resolves.toMatchObject({ stdout: legacy.status });

  const restarted = new ManagedWorkspaces(h.roots, runGit);
  await restarted.initialize();
  await expect(restarted.inspectGit(projectId, workspaceId)).resolves.toMatchObject({
    branchName: "main", headCommit: legacy.localCommit, dirty: true
  });
  await expect(lstat(legacy.adminPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(path.join(metadataPath, "info", "exclude"), "utf8")).resolves.toContain("/.devspace-git/");
});

test("isolates a recoverable workspace Git observation failure during snapshots", async () => {
  const h = await harness();
  await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  const failedWorkspaceId = "018f0f00-0000-7000-8000-000000000099";
  await h.managed.createWorkspace(h.workspace, workspaceOperation);
  await h.managed.createWorkspace({ ...h.workspace, workspaceId: failedWorkspaceId, workspaceSlug: "oversized", branchName: gitBranchNameSchema.parse("oversized") },
    "018f0f00-0000-7000-8000-000000000012");
  class DegradedManagedWorkspaces extends ManagedWorkspaces {
    override async inspectGit(project: string, workspace: string | null) {
      if (workspace === failedWorkspaceId) {
        throw new AgentExecutionError({ code: "GIT_OPERATION_FAILED", message: "status output exceeded the observation bound.", retryable: false, details: { action: "inspect" } });
      }
      return await super.inspectGit(project, workspace);
    }
  }
  const managed = new DegradedManagedWorkspaces(h.roots, h.git);
  await managed.initialize();

  const resources = await managed.snapshotResources();
  const projectResource = resources.find((resource) => resource.type === "project" && resource.projectId === projectId);
  expect(projectResource?.type).toBe("project");
  if (projectResource?.type !== "project") throw new Error("project resource missing");
  expect(projectResource.gitInspections).toEqual(expect.arrayContaining([
    expect.objectContaining({ scope: { kind: "workspace", workspaceId } })
  ]));
  expect(projectResource.gitInspections).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ scope: { kind: "workspace", workspaceId: failedWorkspaceId } })
  ]));
  expect(resources.some((resource) => resource.type === "workspace" && resource.observation.workspaceId === failedWorkspaceId)).toBe(false);
});

test("propagates private-state corruption instead of swallowing it during snapshots", async () => {
  const h = await harness();
  await h.register(); await h.createStore(); await h.managed.fetch(projectId); await h.managed.createWorkspace(h.workspace, workspaceOperation);
  const managed = new ManagedWorkspaces(h.roots, h.git);
  await managed.initialize();
  const ownershipPath = path.join(h.roots.state, "ownership/workspaces", `${workspaceId}.json`);
  const saved = await readJson<WorkspaceOwnershipTestRecord>(ownershipPath);
  await writeJson(ownershipPath, { ...saved, projectId: "not-a-uuid" });

  await expect(managed.snapshotResources()).rejects.toBeInstanceOf(PrivateStateCorruptionError);
  expect(managed.isHealthy).toBe(false);
});

test("rebinds finalized store ownership after a device-only change and persists the live identity", async () => {
  const h = await harness(); await h.createStore();
  const repository = h.managed.repositoryPath(projectId);
  const current = identityOf(await lstat(repository, { bigint: true }));
  const recordPath = path.join(h.roots.state, "ownership/projects", `${projectId}.json`);
  const record = await readJson<StoreOwnershipTestRecord>(recordPath);
  const previousDevice = differentDevice(current.device);
  record.identity = { device: previousDevice, inode: current.inode };
  await writeJson(recordPath, record);

  const restarted = new ManagedWorkspaces(h.roots, h.git); await restarted.initialize();
  await expect(restarted.inspectGit(projectId, null)).resolves.toMatchObject({ projectId, workspaceId: null });
  await expect(readJson(recordPath)).resolves.toMatchObject({ identity: current });
});

test("completes an interrupted exact origin transition after restart", async () => {
  const h = await harness(); await h.createStore();
  const recordPath = path.join(h.roots.state, "ownership/projects", `${projectId}.json`);
  const record = await readJson<StoreOwnershipTestRecord & { git: { bare: true; originUrl: string; commonDirectoryPath: string } }>(recordPath);
  const renamedOrigin = "https://example.com/renamed-repository.git";
  await writeJson(recordPath, { ...record, version: 2, git: { ...record.git, pendingOriginUrl: renamedOrigin } });

  const restarted = new ManagedWorkspaces(h.roots, h.git); await restarted.initialize();
  await expect(restarted.inspectGit(projectId, null)).resolves.toMatchObject({ projectId, workspaceId: null });
  await expect(readJson(recordPath)).resolves.toMatchObject({
    version: 2, git: { originUrl: renamedOrigin, pendingOriginUrl: null }
  });
  await expect(h.git(["--git-dir", h.managed.repositoryPath(projectId), "config", "--get", "remote.origin.url"]))
    .resolves.toMatchObject({ stdout: `${renamedOrigin}\n` });
});

test("rejects a third origin during an interrupted exact origin transition", async () => {
  const h = await harness(); await h.createStore();
  const recordPath = path.join(h.roots.state, "ownership/projects", `${projectId}.json`);
  const record = await readJson<StoreOwnershipTestRecord & { git: { bare: true; originUrl: string; commonDirectoryPath: string } }>(recordPath);
  const pendingOrigin = "https://example.com/renamed-repository.git";
  const foreignOrigin = "https://example.com/foreign-repository.git";
  await writeJson(recordPath, { ...record, version: 2, git: { ...record.git, pendingOriginUrl: pendingOrigin } });
  await h.git(["--git-dir", h.managed.repositoryPath(projectId), "config", "remote.origin.url", foreignOrigin]);

  const restarted = new ManagedWorkspaces(h.roots, h.git); await restarted.initialize();
  await expect(restarted.inspectGit(projectId, null)).rejects.toMatchObject({ failure: { code: "RESOURCE_STATE_CONFLICT" } });
});

test("rebinds finalized workspace ownership and workspace inspection after a coherent device-only change", async () => {
  const h = await harness(); await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  await h.managed.createWorkspace(h.workspace, workspaceOperation);
  const repository = h.managed.repositoryPath(projectId);
  const worktree = h.managed.worktreePath(workspaceId);
  const parent = path.dirname(worktree);
  const storeIdentity = identityOf(await lstat(repository, { bigint: true }));
  const parentIdentity = identityOf(await lstat(parent, { bigint: true }));
  const worktreeIdentity = identityOf(await lstat(worktree, { bigint: true }));
  const previousDevice = differentDevice(storeIdentity.device);
  const storePath = path.join(h.roots.state, "ownership/projects", `${projectId}.json`);
  const workspacePath = path.join(h.roots.state, "ownership/workspaces", `${workspaceId}.json`);
  const storeRecord = await readJson<StoreOwnershipTestRecord>(storePath);
  const workspaceRecord = await readJson<WorkspaceOwnershipTestRecord>(workspacePath);
  storeRecord.identity = { device: previousDevice, inode: storeIdentity.inode };
  workspaceRecord.identity = { device: previousDevice, inode: worktreeIdentity.inode };
  workspaceRecord.parentIdentity = { device: previousDevice, inode: parentIdentity.inode };
  workspaceRecord.store.identity = { device: previousDevice, inode: storeIdentity.inode };
  await writeJson(storePath, storeRecord); await writeJson(workspacePath, workspaceRecord);

  const options = parseProjectOptionsV1({ schemaVersion: 1,
    developmentEnvironment: { source: { kind: "image", imageReference: "node:24-bookworm" } } });
  const plan = compileRuntimePlanV1(options);
  await h.managed.registerRuntimePlan({ projectId, revisionId, revisionHash: hashProjectOptionsV1(options),
    runtimePlan: { format: plan.format, hash: hashRuntimePlanV1(plan), canonicalJson: canonicalizeRuntimePlanV1(plan) } });
  const engine = new DockerEngineClient(path.join(h.root, "fixture-docker.sock"));
  const policy = { cpuMillicores: 2_000, memoryBytes: 1024 * 1024 * 1024, pidLimit: 256,
    stabilizationDurationMs: 20, stabilizationIntervalMs: 10, stabilizationTimeoutMs: 50 };
  const runtime = new RunningRuntime(h.roots.state, engine, policy);
  const preview = new NoopPreviewRuntime(h.roots.state, engine, runtime);
  const restarted = new ManagedWorkspaces(h.roots, h.git, durableJsonWriter, runtime, preview); await restarted.initialize();
  await expect(restarted.inspectWorkspace(projectId, workspaceId)).resolves.toMatchObject({ observedState: "running" });
  await expect(readJson(storePath)).resolves.toMatchObject({ identity: storeIdentity });
  await expect(readJson(workspacePath)).resolves.toMatchObject({
    identity: worktreeIdentity, parentIdentity, store: { identity: storeIdentity }
  });

  const rejectingRuntime = new RejectingStopRuntime(h.roots.state, engine, policy);
  const rejectingPreview = new NoopPreviewRuntime(h.roots.state, engine, rejectingRuntime);
  const stopManaged = new ManagedWorkspaces(h.roots, h.git, durableJsonWriter, rejectingRuntime, rejectingPreview);
  await stopManaged.initialize();
  await expect(stopManaged.stopWorkspace(projectId, workspaceId)).rejects.toMatchObject({
    failure: { code: "WORKSPACE_STATE_CONFLICT" }
  });
  expect(rejectingRuntime.stopCalled).toBe(true);
});

test("finalized store ownership remains fail-closed for inode, path, and symlink changes", async () => {
  const h = await harness(); await h.createStore();
  const repository = h.managed.repositoryPath(projectId);
  const recordPath = path.join(h.roots.state, "ownership/projects", `${projectId}.json`);
  const saved = await readJson<StoreOwnershipTestRecord>(recordPath);
  const current = identityOf(await lstat(repository, { bigint: true }));

  const inodeChanged = { ...saved, identity: { device: differentDevice(current.device), inode: `${BigInt(current.inode) + 1n}` } };
  await writeJson(recordPath, inodeChanged);
  const inodeRestart = new ManagedWorkspaces(h.roots, h.git); await inodeRestart.initialize();
  await expect(inodeRestart.inspectGit(projectId, null)).rejects.toMatchObject({ failure: { code: "RESOURCE_STATE_CONFLICT" } });

  await writeJson(recordPath, { ...saved, repositoryPath: `${repository}.other` });
  const pathRestart = new ManagedWorkspaces(h.roots, h.git); await pathRestart.initialize();
  await expect(pathRestart.inspectGit(projectId, null)).rejects.toMatchObject({ failure: { code: "RESOURCE_STATE_CONFLICT" } });

  await writeJson(recordPath, saved);
  const moved = `${repository}.owned-old`; await rename(repository, moved); await symlink(h.source, repository);
  const symlinkRestart = new ManagedWorkspaces(h.roots, h.git); await symlinkRestart.initialize();
  await expect(symlinkRestart.inspectGit(projectId, null)).rejects.toMatchObject({ failure: { code: "RESOURCE_STATE_CONFLICT" } });
});

test("finalized workspace ownership remains fail-closed for Git, branch, and store-binding changes", async () => {
  const h = await harness(); await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  await h.managed.createWorkspace(h.workspace, workspaceOperation);
  const workspacePath = path.join(h.roots.state, "ownership/workspaces", `${workspaceId}.json`);
  const saved = await readJson<WorkspaceOwnershipTestRecord>(workspacePath);

  await writeJson(workspacePath, { ...saved, branchName: "other" });
  const branchRestart = new ManagedWorkspaces(h.roots, h.git); await branchRestart.initialize();
  await expect(branchRestart.inspectGit(projectId, workspaceId)).rejects.toMatchObject({ failure: { code: "WORKSPACE_STATE_CONFLICT" } });

  await writeJson(workspacePath, saved);
  await writeFile(path.join(h.managed.worktreePath(workspaceId), ".git"), "gitdir: /tmp/unrelated-gitdir\n", "utf8");
  const gitRestart = new ManagedWorkspaces(h.roots, h.git); await gitRestart.initialize();
  await expect(gitRestart.inspectGit(projectId, workspaceId)).rejects.toMatchObject({ failure: { code: "WORKSPACE_STATE_CONFLICT" } });

  await writeJson(workspacePath, { ...saved, store: { ...saved.store, identity: { ...saved.store.identity, inode: `${BigInt(saved.store.identity.inode) + 1n}` } } });
  const storeRestart = new ManagedWorkspaces(h.roots, h.git); await storeRestart.initialize();
  await expect(storeRestart.inspectGit(projectId, workspaceId)).rejects.toMatchObject({ failure: { code: "WORKSPACE_STATE_CONFLICT" } });
});

test("live quarantine continues to reject a device-only identity change", async () => {
  const h = await harness();
  const source = path.join(h.roots.projects, "live-cleanup");
  const quarantine = path.join(h.roots.projects, ".cleanup", "live-cleanup-quarantine");
  await mkdir(source);
  const observed = await lstat(source, { bigint: true });
  const expected = { device: differentDevice(observed.dev.toString()), inode: observed.ino.toString() };
  const privateManaged = h.managed as unknown as {
    quarantineAndRemove(source: string, identity: typeof expected, quarantine: string): Promise<void>;
  };
  await expect(privateManaged.quarantineAndRemove(source, expected, quarantine)).rejects.toThrow(/cleanup identity changed/u);
  await expect(lstat(source)).resolves.toBeTruthy();
  await expect(lstat(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["file", "directory", "bare", "non-bare", "symlink", "fifo"])("rejects an unowned existing %s at the managed-store path", async (kind) => {
  const h = await harness();
  const repository = h.managed.repositoryPath(projectId);
  await mkdir(path.dirname(repository), { recursive: true });
  if (kind === "file") await writeFile(repository, "sentinel", "utf8");
  else if (kind === "directory") await mkdir(repository);
  else if (kind === "bare") await exec("/usr/bin/git", ["init", "--bare", repository]);
  else if (kind === "non-bare") await exec("/usr/bin/git", ["init", repository]);
  else if (kind === "symlink") await symlink(h.source, repository);
  else {
    const result = spawnSync("/usr/bin/mkfifo", [repository]);
    if (result.status !== 0) throw new Error("mkfifo failed");
  }
  const before = await lstat(repository);
  await expect(h.createStore()).rejects.toMatchObject({ failure: { code: "RESOURCE_STATE_CONFLICT" } });
  const after = await lstat(repository);
  expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
});

test("missing ownership, source mismatch, and replaced store identities fail closed", async () => {
  const h = await harness(); await h.createStore();
  const record = path.join(h.roots.state, "ownership/projects", `${projectId}.json`);
  const saved = await readFile(record, "utf8");
  await unlink(record);
  await expect(h.createStore("018f0f00-0000-7000-8000-000000000020")).rejects.toMatchObject({ failure: { code: "RESOURCE_STATE_CONFLICT" } });
  await writeFile(record, saved, { mode: 0o600 });
  await expect(h.managed.createManagedStore({ projectId, source: { kind: "remote", url: "https://example.com/other.git" } }, "018f0f00-0000-7000-8000-000000000021"))
    .rejects.toMatchObject({ failure: { code: "RESOURCE_STATE_CONFLICT" } });
  const repository = h.managed.repositoryPath(projectId);
  await rename(repository, `${repository}.owned-old`);
  await exec("/usr/bin/git", ["init", "--bare", repository]);
  await expect(h.managed.fetch(projectId)).rejects.toMatchObject({ failure: { code: "RESOURCE_STATE_CONFLICT" } });
});

test("preview inspection contains context ownership conflicts and preserves public missing-preview failures", async () => {
  const h = await harness();
  await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  await h.managed.createWorkspace(h.workspace, workspaceOperation);
  const options = parseProjectOptionsV1({ schemaVersion: 1,
    developmentEnvironment: { source: { kind: "image", imageReference: "node:24-bookworm" } } });
  const plan = compileRuntimePlanV1(options);
  const revisionHash = hashProjectOptionsV1(options);
  await h.managed.registerRuntimePlan({ projectId, revisionId, revisionHash,
    runtimePlan: { format: plan.format, hash: hashRuntimePlanV1(plan), canonicalJson: canonicalizeRuntimePlanV1(plan) } });

  const storeOwnership = path.join(h.roots.state, "ownership/projects", `${projectId}.json`);
  const savedStoreOwnership = await readFile(storeOwnership, "utf8");
  await unlink(storeOwnership);
  const contained = await h.managed.inspectPreview({ projectId, workspaceId, revisionId,
    previewId: "018f0f00-0000-7000-8000-000000000004" }).catch((error: unknown) => error);
  expect(contained).toBeInstanceOf(AgentExecutionError);
  if (!(contained instanceof AgentExecutionError)) throw new Error("preview inspection did not fail");
  expect(contained.failure.code).toBe("AGENT_INTERNAL_ERROR");
  const details = contained.failure.details as { readonly incidentId?: unknown };
  expect(typeof details.incidentId).toBe("string");

  await writeFile(storeOwnership, savedStoreOwnership, { mode: 0o600 });
  await expect(h.managed.inspectPreview({ projectId, workspaceId, revisionId,
    previewId: "018f0f00-0000-7000-8000-000000000004" })).rejects.toMatchObject({
      failure: { code: "RESOURCE_NOT_FOUND", details: { resource: { type: "preview" } } }
    });
});

test("runtime private-state corruption degrades the manager and opaque IDs cannot escape roots", async () => {
  const h = await harness(); await h.createStore();
  await writeFile(path.join(h.roots.state, "ownership/projects", `${projectId}.json`), "{}\n", "utf8");
  await expect(h.managed.inspectGit(projectId, null)).rejects.toThrow(/corrupt/u);
  expect(h.managed.isHealthy).toBe(false);
  expect(() => h.managed.repositoryPath("../outside")).toThrow();
});

test("replacing a managed root with a symlink fails closed before filesystem work", async () => {
  const h = await harness();
  const original = `${h.roots.projects}.original`;
  const outside = path.join(h.root, "outside-projects");
  await mkdir(outside);
  await rename(h.roots.projects, original);
  await symlink(outside, h.roots.projects);
  await expect(h.createStore()).rejects.toThrow(/replaced/u);
  expect(h.managed.isHealthy).toBe(false);
  expect(await readdir(outside)).toEqual([]);
});

test("an initially symlinked managed root performs zero writes in its target", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-root-establish-test-")); directories.push(root);
  const target = path.join(root, "external"); await mkdir(target);
  await writeFile(path.join(target, "sentinel"), "unchanged", "utf8");
  const projects = path.join(root, "projects"); await symlink(target, projects);
  const managed = new ManagedWorkspaces({ projects, workspaces: path.join(root, "workspaces"), state: path.join(root, "state") });
  const before = await readdir(target);
  await managed.initialize();
  expect(managed.isHealthy).toBe(false);
  expect(await readdir(target)).toEqual(before);
  expect(await readFile(path.join(target, "sentinel"), "utf8")).toBe("unchanged");
});

test.each(["file", "fifo"])("an initially unsupported managed root %s performs zero child writes", async (kind) => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-root-establish-test-")); directories.push(root);
  const projects = path.join(root, "projects");
  if (kind === "file") await writeFile(projects, "sentinel", "utf8");
  else if (spawnSync("/usr/bin/mkfifo", [projects]).status !== 0) throw new Error("mkfifo failed");
  const managed = new ManagedWorkspaces({ projects, workspaces: path.join(root, "workspaces"), state: path.join(root, "state") });
  await managed.initialize();
  expect(managed.isHealthy).toBe(false);
  const entry = await lstat(projects);
  expect(kind === "file" ? entry.isFile() : entry.isFIFO()).toBe(true);
});

test("valid configured roots initialize and remain identity-pinned", async () => {
  const h = await harness();
  expect(h.managed.isHealthy).toBe(true);
  await expect(readdir(path.join(h.roots.projects, ".staging"))).resolves.toEqual([]);
  await expect(readdir(path.join(h.roots.state, "executions"))).resolves.toEqual([]);
});

test.each(["projects", "workspaces", "state"])("a missing configured %s root is never created", async (missing) => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-missing-root-test-")); directories.push(root);
  const roots = { projects: path.join(root, "projects"), workspaces: path.join(root, "workspaces"), state: path.join(root, "state") };
  await Promise.all(Object.entries(roots).filter(([name]) => name !== missing)
    .map(async ([, directory]) => await mkdir(directory)));
  const managed = new ManagedWorkspaces(roots);
  await managed.initialize();
  expect(managed.isHealthy).toBe(false);
  await expect(lstat(roots[missing as keyof typeof roots])).rejects.toMatchObject({ code: "ENOENT" });
  for (const [name, directory] of Object.entries(roots)) {
    if (name !== missing) expect(await readdir(directory)).toEqual([]);
  }
});

test("new workspaces resolve the latest fetched commit while owned dirty retries preserve user state", async () => {
  const h = await harness(); await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  const secondCommit = await commit(h.source, "second\n");
  await h.managed.fetch(projectId);
  await h.managed.createWorkspace(h.workspace, workspaceOperation);
  await expect(h.managed.inspectGit(projectId, workspaceId)).resolves.toMatchObject({ headCommit: secondCommit, dirty: false });
  await writeFile(path.join(h.managed.worktreePath(workspaceId), "README.md"), "user change\n", "utf8");
  await h.managed.createWorkspace(h.workspace, "018f0f00-0000-7000-8000-000000000022");
  await expect(h.managed.inspectGit(projectId, workspaceId)).resolves.toMatchObject({ headCommit: secondCommit, dirty: true });
  expect(await readFile(path.join(h.managed.worktreePath(workspaceId), "README.md"), "utf8")).toBe("user change\n");
});

test("reports an unexpected runtime-start exception as an Agent internal error", async () => {
  const h = await harness(); await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  await h.managed.createWorkspace(h.workspace, workspaceOperation);
  const options = parseProjectOptionsV1({ schemaVersion: 1,
    developmentEnvironment: { source: { kind: "image", imageReference: "node:24-bookworm" } } });
  const plan = compileRuntimePlanV1(options);
  const revisionHash = hashProjectOptionsV1(options);
  await h.managed.registerRuntimePlan({ projectId, revisionId, revisionHash,
    runtimePlan: { format: plan.format, hash: hashRuntimePlanV1(plan), canonicalJson: canonicalizeRuntimePlanV1(plan) } });
  const engine = new DockerEngineClient(path.join(h.root, "fixture-docker.sock"));
  const policy = { cpuMillicores: 2_000, memoryBytes: 1024 * 1024 * 1024, pidLimit: 256,
    stabilizationDurationMs: 20, stabilizationIntervalMs: 10, stabilizationTimeoutMs: 50 };
  const runtime = new UnexpectedRuntimeStart(h.roots.state, engine, policy);
  const preview = new NoopPreviewRuntime(h.roots.state, engine, runtime);
  const logLines: string[] = [];
  const logger = createLogger({ component: "agent", subsystem: "test", sink: (line) => logLines.push(line) });
  const managed = new ManagedWorkspaces(h.roots, h.git, durableJsonWriter, runtime, preview,
    undefined, undefined, undefined, undefined, logger);
  await managed.initialize();

  let failure: AgentExecutionError | null = null;
  try {
    await managed.startWorkspace(projectId, workspaceId, "018f0f00-0000-7000-8000-000000000012");
  } catch (error) {
    if (error instanceof AgentExecutionError) failure = error;
    else throw error;
  }
  expect(failure).not.toBeNull();
  if (failure === null) throw new Error("runtime failure was not reported");
  expect(failure.failure.code).toBe("AGENT_INTERNAL_ERROR");
  const details = failure.failure.details;
  if (!("incidentId" in details)) throw new Error("Agent internal error did not include an incident ID");
  expect(typeof details.incidentId).toBe("string");
  const startFailure = logLines.map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((record) => record.event === "agent.workspace.start.phase_failed");
  expect(startFailure).toMatchObject({ phase: "runtime-startup", errorClass: "Error", outcome: "failure" });
  expect(logLines.join("\n")).not.toContain("unexpected-runtime-start");
});

test.each(["directory", "worktree", "symlink"])("rejects an unowned existing workspace %s", async (kind) => {
  const h = await harness(); await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  const worktree = h.managed.worktreePath(workspaceId);
  await mkdir(path.dirname(worktree), { recursive: true });
  if (kind === "directory") await mkdir(worktree);
  else if (kind === "symlink") await symlink(h.source, worktree);
  else await runGit(["--git-dir", h.managed.repositoryPath(projectId), "worktree", "add", "--", worktree, "main"]);
  const before = await lstat(worktree);
  await expect(h.managed.createWorkspace(h.workspace, workspaceOperation)).rejects.toMatchObject({ failure: { code: "WORKSPACE_STATE_CONFLICT" } });
  const after = await lstat(worktree);
  expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
});

test("workspace ownership removal, replacement, revision mismatch, and missing registration fail closed", async () => {
  const h = await harness(); await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  const missingRevision = { ...h.workspace, revision: { ...h.workspace.revision, revisionId: "018f0f00-0000-7000-8000-000000000099" } };
  await expect(h.managed.createWorkspace(missingRevision, workspaceOperation)).rejects.toMatchObject({ failure: { code: "CONFIGURATION_NOT_REGISTERED" } });
  await h.managed.createWorkspace(h.workspace, workspaceOperation);
  const record = path.join(h.roots.state, "ownership/workspaces", `${workspaceId}.json`);
  const saved = await readFile(record, "utf8");
  await unlink(record);
  await expect(h.managed.createWorkspace(h.workspace, "018f0f00-0000-7000-8000-000000000020")).rejects.toMatchObject({ failure: { code: "WORKSPACE_STATE_CONFLICT" } });
  await writeFile(record, saved, { mode: 0o600 });
  const worktree = h.managed.worktreePath(workspaceId);
  await rename(worktree, `${worktree}.owned-old`); await mkdir(worktree);
  await expect(h.managed.inspectWorkspace(projectId, workspaceId)).rejects.toMatchObject({ failure: { code: "WORKSPACE_STATE_CONFLICT" } });
});

test("every managed Git command carries hook and submodule protections", async () => {
  const h = await harness();
  await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  const sentinel = path.join(h.root, "hook-ran");
  const hook = path.join(h.managed.repositoryPath(projectId), "hooks", "post-checkout");
  await writeFile(hook, `#!/bin/sh\nprintf unsafe > ${sentinel}\n`, "utf8"); await chmod(hook, 0o700);
  await runGit(["--git-dir", h.managed.repositoryPath(projectId), "config", "core.hooksPath", "hooks"]);
  await h.managed.createWorkspace(h.workspace, workspaceOperation);
  expect(await lstat(sentinel).then(() => true).catch(() => false)).toBe(false);
});

test("a crash after Git worktree registration recovers the exact operation-owned partial resource", async () => {
  let failOnce = true;
  const writer: AtomicJsonWriter = { async write(file, value) {
    if (failOnce && (value as { resourceType?: string; phase?: string }).resourceType === "workspace"
      && (value as { phase?: string }).phase === "worktree-created") { failOnce = false; throw new Error("simulated-crash"); }
    await durableJsonWriter.write(file, value);
  } };
  const h = await harness(writer); await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  await expect(h.managed.createWorkspace(h.workspace, workspaceOperation)).rejects.toThrow("simulated-crash");
  expect((await lstat(h.managed.worktreePath(workspaceId))).isDirectory()).toBe(true);
  await h.managed.createWorkspace(h.workspace, workspaceOperation);
  await expect(h.managed.inspectWorkspace(projectId, workspaceId)).resolves.toMatchObject({ observedState: "stopped" });
});

test("a partial worktree with durable exact Git administration identity is safely recovered", async () => {
  let failPartialWrite = true;
  const writer: AtomicJsonWriter = { async write(file, value) {
    await durableJsonWriter.write(file, value);
    if (failPartialWrite && (value as { resourceType?: string; phase?: string }).resourceType === "workspace"
      && (value as { phase?: string }).phase === "worktree-partial") {
      failPartialWrite = false; throw new Error("simulated-crash-after-partial-marker");
    }
  } };
  let failAfterAdd = true;
  const h = await harness(writer, (base) => async (args) => {
    const result = await base(args);
    if (failAfterAdd && args.includes("worktree") && args.includes("add")) {
      failAfterAdd = false; throw new Error("simulated-post-registration-failure");
    }
    return result;
  });
  await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  await expect(h.managed.createWorkspace(h.workspace, workspaceOperation))
    .rejects.toThrow("simulated-crash-after-partial-marker");
  const saved = JSON.parse(await readFile(path.join(h.roots.state, "creations", `${workspaceOperation}.json`), "utf8")) as {
    phase: string; gitAdministration: unknown;
  };
  expect(saved.phase).toBe("worktree-partial");
  expect(saved.gitAdministration).not.toBeNull();
  expect(typeof (saved.gitAdministration as { path: unknown }).path).toBe("string");
  expect(typeof (saved.gitAdministration as { identity: unknown }).identity).toBe("object");
  const restarted = new ManagedWorkspaces(h.roots, h.git); await restarted.initialize();
  await restarted.createWorkspace(h.workspace, workspaceOperation);
  await expect(restarted.inspectWorkspace(projectId, workspaceId)).resolves.toMatchObject({ observedState: "stopped" });
});

test("a published store with a failed ownership write is recovered only through its durable creation identity", async () => {
  let failOnce = true;
  const writer: AtomicJsonWriter = { async write(file, value) {
    if (failOnce && (value as { git?: { bare?: boolean } }).git?.bare === true) { failOnce = false; throw new Error("ownership-disk-failure"); }
    await durableJsonWriter.write(file, value);
  } };
  const h = await harness(writer);
  await expect(h.createStore()).rejects.toThrow("ownership-disk-failure");
  expect((await lstat(h.managed.repositoryPath(projectId))).isDirectory()).toBe(true);
  await h.createStore(storeOperation);
  await expect(h.managed.inspectGit(projectId, null)).resolves.toMatchObject({ projectId, workspaceId: null });
  expect(await readdir(path.join(h.roots.state, "creations"))).toEqual([]);
});

test("cleanup never deletes unrelated contents from an operation-owned workspace parent", async () => {
  let parent = "";
  const h = await harness(durableJsonWriter, (base) => async (args) => {
    if (args.includes("add") && args.includes("worktree")) {
      parent = path.dirname(args.at(-2)!);
      await writeFile(path.join(parent, "unrelated"), "preserve", "utf8");
      throw new Error("forced-worktree-failure");
    }
    return await base(args);
  });
  await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  await expect(h.managed.createWorkspace(h.workspace, workspaceOperation)).rejects.toMatchObject({ failure: { code: "WORKSPACE_STATE_CONFLICT" } });
  expect(await readFile(path.join(parent, "unrelated"), "utf8")).toBe("preserve");
});

test.each(["external", "wrong-project-stage", "wrong-operation-stage", "wrong-final-project"])(
  "semantically invalid store creation path %s degrades state without touching its nominated directory", async (variant) => {
    const h = await harness();
    const otherProject = "018f0f00-0000-7000-8000-000000000099";
    const otherOperation = "018f0f00-0000-7000-8000-000000000098";
    const expectedStaging = path.join(h.roots.projects, ".staging", `${projectId}-${storeOperation}-store`);
    const stagingPath = variant === "external" ? path.join(h.root, "unrelated")
      : variant === "wrong-project-stage" ? path.join(h.roots.projects, ".staging", `${otherProject}-${storeOperation}-store`)
      : variant === "wrong-operation-stage" ? path.join(h.roots.projects, ".staging", `${projectId}-${otherOperation}-store`)
      : expectedStaging;
    await mkdir(stagingPath, { recursive: true }); await writeFile(path.join(stagingPath, "sentinel"), "unchanged", "utf8");
    const details = await lstat(stagingPath);
    const finalRepositoryPath = variant === "wrong-final-project"
      ? path.join(h.roots.projects, otherProject, "repository.git") : h.managed.repositoryPath(projectId);
    await writeFile(path.join(h.roots.state, "creations", `${storeOperation}.json`), `${JSON.stringify({
      version: 1, resourceType: "store", operationId: storeOperation, projectId,
      source: { kind: "remote", url: sourceUrl }, stagingPath, finalRepositoryPath,
      stagingIdentity: { device: String(details.dev), inode: String(details.ino) },
      repositoryIdentity: null, phase: "staging-created"
    })}\n`, "utf8");
    const restarted = new ManagedWorkspaces(h.roots, h.git); await restarted.initialize();
    expect(restarted.isHealthy).toBe(false);
    expect(await readFile(path.join(stagingPath, "sentinel"), "utf8")).toBe("unchanged");
  }
);

test("impossible store creation phase identities are rejected", async () => {
  const h = await harness();
  const stagingPath = path.join(h.roots.projects, ".staging", `${projectId}-${storeOperation}-store`);
  await mkdir(stagingPath); const details = await lstat(stagingPath);
  await writeFile(path.join(h.roots.state, "creations", `${storeOperation}.json`), `${JSON.stringify({
    version: 1, resourceType: "store", operationId: storeOperation, projectId,
    source: { kind: "remote", url: sourceUrl }, stagingPath, finalRepositoryPath: h.managed.repositoryPath(projectId),
    stagingIdentity: { device: String(details.dev), inode: String(details.ino) },
    repositoryIdentity: { device: String(details.dev), inode: String(details.ino) }, phase: "staging-created"
  })}\n`, "utf8");
  const restarted = new ManagedWorkspaces(h.roots, h.git); await restarted.initialize();
  expect(restarted.isHealthy).toBe(false);
});

test("a valid creation record must still bind to the exact durable journal operation", async () => {
  const h = await harness();
  const stagingPath = path.join(h.roots.projects, ".staging", `${projectId}-${storeOperation}-store`);
  await mkdir(stagingPath); const details = await lstat(stagingPath);
  await writeFile(path.join(h.roots.state, "creations", `${storeOperation}.json`), `${JSON.stringify({
    version: 1, resourceType: "store", operationId: storeOperation, projectId,
    source: { kind: "remote", url: sourceUrl }, stagingPath, finalRepositoryPath: h.managed.repositoryPath(projectId),
    stagingIdentity: { device: String(details.dev), inode: String(details.ino) }, repositoryIdentity: null, phase: "staging-created"
  })}\n`, "utf8");
  const restarted = new ManagedWorkspaces(h.roots, h.git); await restarted.initialize();
  expect(restarted.isHealthy).toBe(true);
  await expect(restarted.validateCreationJournalBindings(() => undefined)).rejects.toThrow(/corrupt/u);
  expect(restarted.isHealthy).toBe(false);
});

test("a workspace creation record cannot nominate an unrelated cleanup parent", async () => {
  const h = await harness(); await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  const externalParent = path.join(h.root, "unrelated-workspace"); await mkdir(externalParent);
  await writeFile(path.join(externalParent, "sentinel"), "unchanged", "utf8");
  const parent = await lstat(externalParent);
  const storeRecord = JSON.parse(await readFile(path.join(h.roots.state, "ownership/projects", `${projectId}.json`), "utf8")) as {
    repositoryPath: string; identity: { device: string; inode: string };
  };
  await writeFile(path.join(h.roots.state, "creations", `${workspaceOperation}.json`), `${JSON.stringify({
    version: 1, resourceType: "workspace", operationId: workspaceOperation, request: h.workspace,
    parentPath: externalParent, worktreePath: path.join(externalParent, "source"),
    parentIdentity: { device: String(parent.dev), inode: String(parent.ino) },
    store: { repositoryPath: storeRecord.repositoryPath, identity: storeRecord.identity },
    worktreeIdentity: null, intendedCommit: h.firstCommit, gitAdministration: null, phase: "parent-created"
  })}\n`, "utf8");
  const restarted = new ManagedWorkspaces(h.roots, h.git); await restarted.initialize();
  expect(restarted.isHealthy).toBe(false);
  expect(await readFile(path.join(externalParent, "sentinel"), "utf8")).toBe("unchanged");
});

test("worktree administration without an exact durable identity is never removed", async () => {
  const h = await harness(); await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  const parentPath = path.dirname(h.managed.worktreePath(workspaceId));
  const worktreePath = h.managed.worktreePath(workspaceId);
  await mkdir(parentPath);
  await runGit(["--git-dir", h.managed.repositoryPath(projectId), "worktree", "add", "--", worktreePath, "main"]);
  const parent = await lstat(parentPath); const worktree = await lstat(worktreePath);
  const gitFile = (await readFile(path.join(worktreePath, ".git"), "utf8")).trim();
  const administrationPath = path.resolve(gitFile.slice("gitdir: ".length));
  const administration = await lstat(administrationPath);
  const storeRecord = JSON.parse(await readFile(path.join(h.roots.state, "ownership/projects", `${projectId}.json`), "utf8")) as {
    repositoryPath: string; identity: { device: string; inode: string };
  };
  await writeFile(path.join(h.roots.state, "creations", `${workspaceOperation}.json`), `${JSON.stringify({
    version: 1, resourceType: "workspace", operationId: workspaceOperation, request: h.workspace,
    parentPath, worktreePath, parentIdentity: { device: String(parent.dev), inode: String(parent.ino) },
    store: { repositoryPath: storeRecord.repositoryPath, identity: storeRecord.identity },
    worktreeIdentity: { device: String(worktree.dev), inode: String(worktree.ino) }, intendedCommit: h.firstCommit,
    gitAdministration: null, phase: "worktree-partial"
  })}\n`, "utf8");
  const restarted = new ManagedWorkspaces(h.roots, h.git); await restarted.initialize();
  expect(restarted.isHealthy).toBe(false);
  const after = await lstat(administrationPath);
  expect([after.dev, after.ino]).toEqual([administration.dev, administration.ino]);
  expect(await readFile(path.join(administrationPath, "gitdir"), "utf8")).toContain(path.join(worktreePath, ".git"));
});
