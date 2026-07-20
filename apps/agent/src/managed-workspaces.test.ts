import { execFile, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { createWorkspaceDataSchema } from "@devspace/contracts";
import {
  canonicalizeProjectOptionsV1, canonicalizeRuntimePlanV1, compileRuntimePlanV1, hashProjectOptionsV1, hashRuntimePlanV1,
  parseProjectOptionsV1
} from "@devspace/project-options";
import { AgentExecutionError, ManagedWorkspaces, runGit, type GitRunner } from "./managed-workspaces.js";
import { DockerEngineClient } from "./docker-runtime.js";
import { PreviewRuntimeManager } from "./preview-runtime.js";
import { WorkspaceRuntimeManager } from "./workspace-runtime.js";
import { durableJsonWriter, type AtomicJsonWriter } from "./private-state.js";

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

test("creates, owns, revalidates, and reloads a real store and worktree", async () => {
  const h = await harness();
  await h.register(); await h.createStore(); await h.managed.fetch(projectId);
  await h.managed.createWorkspace(h.workspace, workspaceOperation);
  await h.createStore("018f0f00-0000-7000-8000-000000000020");
  await h.managed.createWorkspace(h.workspace, "018f0f00-0000-7000-8000-000000000021");
  await expect(h.managed.inspectWorkspace(projectId, workspaceId)).resolves.toMatchObject({ observedState: "stopped", dirty: false });
  const restarted = new ManagedWorkspaces(h.roots, async (args) => await runGit([
    "-c", `url.${h.source}.insteadOf=${sourceUrl}`, "-c", "protocol.file.allow=always", ...args
  ]));
  await restarted.initialize();
  await expect(restarted.inspectGit(projectId, null)).resolves.toMatchObject({ workspaceId: null });
  await expect(restarted.inspectGit(projectId, workspaceId)).resolves.toMatchObject({ branchName: "main", headCommit: h.firstCommit, dirty: false });
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
  const managed = new ManagedWorkspaces(h.roots, h.git, durableJsonWriter, runtime, preview);
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
