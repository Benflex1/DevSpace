import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { createWorkspaceDataSchema } from "@devspace/contracts";
import { canonicalizeProjectOptionsV1, hashProjectOptionsV1, parseProjectOptionsV1 } from "@devspace/project-options";
import { AgentEventLog } from "./event-log.js";
import { ManagedWorkspaces, runGit, type GitRunner } from "./managed-workspaces.js";
import { OperationExecutor } from "./operation-executor.js";
import { OperationJournal } from "./operation-journal.js";

const exec = promisify(execFile);
const projectId = "018f0f00-0000-7000-8000-000000000101";
const revisionId = "018f0f00-0000-7000-8000-000000000102";
const workspaceId = "018f0f00-0000-7000-8000-000000000103";
const storeOperation = "018f0f00-0000-7000-8000-000000000104";
const workspaceOperation = "018f0f00-0000-7000-8000-000000000105";
const stageOperation = "018f0f00-0000-7000-8000-000000000106";
const unstageOperation = "018f0f00-0000-7000-8000-000000000107";
const commitOperation = "018f0f00-0000-7000-8000-000000000108";
const agentBootId = "018f0f00-0000-7000-8000-000000000109";
const timestamp = "2026-07-17T12:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function git(worktree: string, args: readonly string[]): Promise<string> {
  return (await exec("/usr/bin/git", ["-C", worktree, ...args])).stdout.trim();
}

type Fixture = {
  readonly root: string;
  readonly roots: { projects: string; workspaces: string; state: string };
  readonly journalRoot: string;
  readonly git: GitRunner;
  readonly managed: ManagedWorkspaces;
  readonly worktree: string;
};

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-git-restart-regression-"));
  roots.push(root);
  const source = path.join(root, "source");
  await exec("/usr/bin/git", ["init", "-b", "main", source]);
  await exec("/usr/bin/git", ["-C", source, "config", "user.name", "DevSpace Test"]);
  await exec("/usr/bin/git", ["-C", source, "config", "user.email", "devspace@example.invalid"]);
  await writeFile(path.join(source, "README.md"), "fixture\n", "utf8");
  await exec("/usr/bin/git", ["-C", source, "add", "."]);
  await exec("/usr/bin/git", ["-C", source, "commit", "-m", "fixture"]);

  const managedRoots = {
    projects: path.join(root, "managed", "projects"),
    workspaces: path.join(root, "managed", "workspaces"),
    state: path.join(root, "managed", "state")
  };
  await Promise.all(Object.values(managedRoots).map(async (directory) => await mkdir(directory, { recursive: true })));
  const sourceUrl = "https://example.com/git-restart-regression.git";
  const gitRunner: GitRunner = async (args) => await runGit([
    "-c", `url.${source}.insteadOf=${sourceUrl}`, "-c", "protocol.file.allow=always", ...args
  ]);
  const managed = new ManagedWorkspaces(managedRoots, gitRunner);
  await managed.initialize();
  const options = parseProjectOptionsV1({
    schemaVersion: 1,
    developmentEnvironment: { source: { kind: "image", imageReference: "node:24-bookworm" } }
  });
  const hash = hashProjectOptionsV1(options);
  await managed.registerRevision({
    projectId, revisionId,
    configuration: { format: "devspace.project-options/v1", hash, canonicalJson: canonicalizeProjectOptionsV1(options) }
  });
  await managed.createManagedStore({ projectId, source: { kind: "remote", url: sourceUrl } }, storeOperation);
  await managed.fetch(projectId);
  const workspace = createWorkspaceDataSchema.parse({
    projectId, workspaceId, projectSlug: "project", workspaceSlug: "primary", kind: "primary",
    revision: { revisionId, revisionHash: hash }, branchName: "main", baseRef: { kind: "branch", branchName: "main" }
  });
  await managed.createWorkspace(workspace, workspaceOperation);
  const journalRoot = path.join(managedRoots.state, "operations");
  await mkdir(journalRoot, { recursive: true });
  return { root, roots: managedRoots, journalRoot, git: gitRunner, managed, worktree: managed.worktreePath(workspaceId) };
}

async function executeUntilPostSuccessSettlementFailure(
  fixtureValue: Fixture,
  operationId: string,
  operationName: "project.git.stage" | "project.git.unstage" | "project.git.commit",
  request: unknown
): Promise<OperationJournal> {
  const journal = new OperationJournal(fixtureValue.journalRoot, () => new Date(timestamp));
  await journal.initialize();
  const events = new AgentEventLog(agentBootId, () => new Date(timestamp));
  const executor = new OperationExecutor(journal, fixtureValue.managed, events);
  await executor.initialize();
  vi.spyOn(journal, "succeed").mockRejectedValue(new Error("forced-post-success-settlement-failure"));
  const accepted = await journal.accept(operationId, operationName, request);
  executor.schedule(accepted);
  await executor.drain();
  expect(journal.get(operationId)).toMatchObject({ state: "running", failure: null });
  return journal;
}

test("an interrupted-running Stage is terminalized and cannot stage newer worktree contents after restart", async () => {
  const value = await fixture();
  await writeFile(path.join(value.worktree, "README.md"), "stage A\n", "utf8");
  const request = { projectId, workspaceId, path: "README.md" };
  await executeUntilPostSuccessSettlementFailure(value, stageOperation, "project.git.stage", request);
  expect(await git(value.worktree, ["show", ":README.md"])).toBe("stage A");

  await writeFile(path.join(value.worktree, "README.md"), "stage B\n", "utf8");
  const restartedJournal = new OperationJournal(value.journalRoot, () => new Date(timestamp));
  await restartedJournal.initialize();
  const restartedManaged = new ManagedWorkspaces(value.roots, value.git);
  await restartedManaged.initialize();
  const stageWorkspaceFile = vi.spyOn(restartedManaged, "stageWorkspaceFile");
  const restartedExecutor = new OperationExecutor(restartedJournal, restartedManaged,
    new AgentEventLog(agentBootId, () => new Date(timestamp)));
  await restartedExecutor.initialize();
  restartedExecutor.resumeAccepted();
  await restartedExecutor.drain();

  expect(stageWorkspaceFile).not.toHaveBeenCalled();
  expect(await git(value.worktree, ["show", ":README.md"])).toBe("stage A");
  expect(await readFile(path.join(value.worktree, "README.md"), "utf8")).toBe("stage B\n");
  expect(await git(value.worktree, ["diff", "--cached", "--name-only"])).toBe("README.md");
  expect(restartedJournal.get(stageOperation)).toMatchObject({
    state: "failed", failure: { code: "GIT_MUTATION_OUTCOME_UNCERTAIN", retryable: false }
  });
  expect(restartedJournal.resumable()).toEqual([]);
});

test("an interrupted-running Unstage is terminalized and cannot undo newer staging intent after restart", async () => {
  const value = await fixture();
  await writeFile(path.join(value.worktree, "README.md"), "unstage A\n", "utf8");
  await value.managed.stageWorkspaceFile(projectId, workspaceId, "README.md");
  const request = { projectId, workspaceId, path: "README.md" };
  await executeUntilPostSuccessSettlementFailure(value, unstageOperation, "project.git.unstage", request);
  expect(await git(value.worktree, ["show", ":README.md"])).toBe("fixture");

  await writeFile(path.join(value.worktree, "README.md"), "unstage B\n", "utf8");
  await value.managed.stageWorkspaceFile(projectId, workspaceId, "README.md");
  const restartedJournal = new OperationJournal(value.journalRoot, () => new Date(timestamp));
  await restartedJournal.initialize();
  const restartedManaged = new ManagedWorkspaces(value.roots, value.git);
  await restartedManaged.initialize();
  const unstageWorkspaceFile = vi.spyOn(restartedManaged, "unstageWorkspaceFile");
  const restartedExecutor = new OperationExecutor(restartedJournal, restartedManaged,
    new AgentEventLog(agentBootId, () => new Date(timestamp)));
  await restartedExecutor.initialize();
  restartedExecutor.resumeAccepted();
  await restartedExecutor.drain();

  expect(unstageWorkspaceFile).not.toHaveBeenCalled();
  expect(await git(value.worktree, ["show", ":README.md"])).toBe("unstage B");
  expect(await git(value.worktree, ["diff", "--cached", "--name-only"])).toBe("README.md");
  expect(restartedJournal.get(unstageOperation)).toMatchObject({
    state: "failed", failure: { code: "GIT_MUTATION_OUTCOME_UNCERTAIN", retryable: false }
  });
  expect(restartedJournal.resumable()).toEqual([]);
});

test("an interrupted-running Commit cannot consume newly staged changes with the old commit intent after restart", async () => {
  const value = await fixture();
  await writeFile(path.join(value.worktree, "README.md"), "commit A\n", "utf8");
  await value.managed.stageWorkspaceFile(projectId, workspaceId, "README.md");
  const request = {
    projectId, workspaceId, message: "old commit intent", userName: "DevSpace Test", userEmail: "devspace@example.invalid"
  };
  await executeUntilPostSuccessSettlementFailure(value, commitOperation, "project.git.commit", request);
  const commitAOid = await git(value.worktree, ["rev-parse", "HEAD"]);
  expect(commitAOid).toMatch(/^[0-9a-f]{40}$/u);
  expect(await git(value.worktree, ["log", "-1", "--format=%s"])).toBe("old commit intent");

  await writeFile(path.join(value.worktree, "README.md"), "commit B\n", "utf8");
  await value.managed.stageWorkspaceFile(projectId, workspaceId, "README.md");
  const restartedJournal = new OperationJournal(value.journalRoot, () => new Date(timestamp));
  await restartedJournal.initialize();
  const restartedManaged = new ManagedWorkspaces(value.roots, value.git);
  await restartedManaged.initialize();
  const commitWorkspace = vi.spyOn(restartedManaged, "commitWorkspace");
  const restartedExecutor = new OperationExecutor(restartedJournal, restartedManaged,
    new AgentEventLog(agentBootId, () => new Date(timestamp)));
  await restartedExecutor.initialize();
  restartedExecutor.resumeAccepted();
  await restartedExecutor.drain();

  expect(commitWorkspace).not.toHaveBeenCalled();
  expect(await git(value.worktree, ["rev-parse", "HEAD"])).toBe(commitAOid);
  expect(await git(value.worktree, ["log", "-1", "--format=%s"])).toBe("old commit intent");
  expect((await git(value.worktree, ["log", "--format=%s"])).split("\n").filter((message) => message === "old commit intent")).toHaveLength(1);
  expect(await git(value.worktree, ["show", ":README.md"])).toBe("commit B");
  expect(await git(value.worktree, ["diff", "--cached", "--name-only"])).toBe("README.md");
  expect(restartedJournal.get(commitOperation)).toMatchObject({
    state: "failed", failure: { code: "GIT_MUTATION_OUTCOME_UNCERTAIN", retryable: false }
  });
  expect(restartedJournal.resumable()).toEqual([]);
});
