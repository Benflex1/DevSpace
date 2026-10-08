import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { createWorkspaceDataSchema } from "@devspace/contracts";
import { canonicalizeProjectOptionsV1, hashProjectOptionsV1, parseProjectOptionsV1 } from "@devspace/project-options";
import { AgentExecutionError, ManagedWorkspaces, runGit, type GitRunner } from "./managed-workspaces.js";

const exec = promisify(execFile);
const projectId = "018f0f00-0000-7000-8000-000000000101";
const revisionId = "018f0f00-0000-7000-8000-000000000102";
const workspaceId = "018f0f00-0000-7000-8000-000000000103";
const storeOperation = "018f0f00-0000-7000-8000-000000000104";
const workspaceOperation = "018f0f00-0000-7000-8000-000000000105";
const sourceUrl = "https://example.com/git-changes.git";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

async function git(source: string, args: readonly string[]): Promise<string> {
  return (await exec("/usr/bin/git", ["-C", source, ...args])).stdout.trim();
}

async function setup(): Promise<{ managed: ManagedWorkspaces; worktree: string; firstCommit: string; canary: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-git-changes-test-"));
  directories.push(root);
  const source = path.join(root, "source");
  await exec("/usr/bin/git", ["init", "-b", "main", source]);
  await exec("/usr/bin/git", ["-C", source, "config", "user.name", "DevSpace Test"]);
  await exec("/usr/bin/git", ["-C", source, "config", "user.email", "devspace@example.invalid"]);
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(path.join(source, "README.md"), "first\n", "utf8");
  await writeFile(path.join(source, "delete.txt"), "delete me\n", "utf8");
  await writeFile(path.join(source, "rename-old.txt"), "rename me\n", "utf8");
  await writeFile(path.join(source, "staged.txt"), "staged\n", "utf8");
  await writeFile(path.join(source, "both.txt"), "both\n", "utf8");
  await writeFile(path.join(source, "src/nested.txt"), "nested\n", "utf8");
  await exec("/usr/bin/git", ["-C", source, "add", "."]);
  await exec("/usr/bin/git", ["-C", source, "commit", "-m", "fixture"]);
  const firstCommit = await git(source, ["rev-parse", "HEAD"]);

  const roots = {
    projects: path.join(root, "managed", "projects"),
    workspaces: path.join(root, "managed", "workspaces"),
    state: path.join(root, "managed", "state")
  };
  await Promise.all(Object.values(roots).map(async (directory) => await mkdir(directory, { recursive: true })));
  const gitRunner: GitRunner = async (args) => await runGit([
    "-c", `url.${source}.insteadOf=${sourceUrl}`, "-c", "protocol.file.allow=always", ...args
  ]);
  const managed = new ManagedWorkspaces(roots, gitRunner);
  await managed.initialize();
  const options = parseProjectOptionsV1({
    schemaVersion: 1,
    developmentEnvironment: { source: { kind: "image", imageReference: "node:24-bookworm" } }
  });
  const hash = hashProjectOptionsV1(options);
  await managed.registerRevision({
    projectId,
    revisionId,
    configuration: { format: "devspace.project-options/v1", hash, canonicalJson: canonicalizeProjectOptionsV1(options) }
  });
  await managed.createManagedStore({ projectId, source: { kind: "remote", url: sourceUrl } }, storeOperation);
  await managed.fetch(projectId);
  const workspace = createWorkspaceDataSchema.parse({
    projectId, workspaceId, projectSlug: "project", workspaceSlug: "primary", kind: "primary",
    revision: { revisionId, revisionHash: hash }, branchName: "main", baseRef: { kind: "branch", branchName: "main" }
  });
  await managed.createWorkspace(workspace, workspaceOperation);
  const canary = path.join(root, "host-canary");
  return { managed, worktree: managed.worktreePath(workspaceId), firstCommit, canary };
}

function failureCode(error: unknown): string | undefined {
  return error instanceof AgentExecutionError ? error.failure.code : undefined;
}

test("reports clean and mixed porcelain-v2 workspace status deterministically", async () => {
  const { managed, worktree, firstCommit } = await setup();
  const clean = await managed.inspectGit(projectId, workspaceId);
  expect(clean).toMatchObject({ branchName: "main", headCommit: firstCommit, dirty: false, aheadCount: 0, behindCount: 0, files: [] });

  await writeFile(path.join(worktree, "README.md"), "changed\n", "utf8");
  await writeFile(path.join(worktree, "added.txt"), "added\n", "utf8");
  await unlink(path.join(worktree, "delete.txt"));
  await git(worktree, ["mv", "rename-old.txt", "rename-new.txt"]);
  await writeFile(path.join(worktree, "staged.txt"), "staged changed\n", "utf8");
  await git(worktree, ["add", "--", "staged.txt"]);
  await writeFile(path.join(worktree, "both.txt"), "both staged\n", "utf8");
  await git(worktree, ["add", "--", "both.txt"]);
  await writeFile(path.join(worktree, "both.txt"), "both staged and unstaged\n", "utf8");

  const status = await managed.inspectGit(projectId, workspaceId);
  expect(status.dirty).toBe(true);
  expect(status.files.map((entry) => entry.path)).toEqual([...status.files].map((entry) => entry.path).sort());
  expect(status.files).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "README.md", stagedState: "unchanged", unstagedState: "modified", untracked: false, classification: "modified" }),
    expect.objectContaining({ path: "added.txt", stagedState: "unchanged", unstagedState: "untracked", untracked: true, classification: "added" }),
    expect.objectContaining({ path: "delete.txt", stagedState: "unchanged", unstagedState: "deleted", untracked: false, classification: "deleted" }),
    expect.objectContaining({ path: "rename-new.txt", oldPath: "rename-old.txt", classification: "renamed" }),
    expect.objectContaining({ path: "staged.txt", stagedState: "modified", unstagedState: "unchanged", untracked: false }),
    expect.objectContaining({ path: "both.txt", stagedState: "modified", unstagedState: "modified", untracked: false })
  ]));
  expect(JSON.stringify(status).length).toBeLessThan(512 * 1024);
});

test("stages additions, modifications, and deletions without running repository clean filters", async () => {
  const { managed, worktree, canary } = await setup();
  const filter = path.join(path.dirname(canary), "clean-filter.sh");
  await writeFile(filter, `#!/bin/sh\nprintf filtered > ${JSON.stringify(canary)}\ncat\n`, "utf8");
  await chmod(filter, 0o755);
  await git(worktree, ["config", "filter.hostile.clean", `${filter} %f`]);
  await git(worktree, ["config", "filter.hostile.required", "true"]);
  await writeFile(path.join(worktree, ".gitattributes"), "README.md filter=hostile\n", "utf8");
  await writeFile(path.join(worktree, "README.md"), "staged safely\n", "utf8");
  await writeFile(path.join(worktree, "new.txt"), "new\n", "utf8");
  await unlink(path.join(worktree, "delete.txt"));

  await managed.stageWorkspaceFile(projectId, workspaceId, "README.md");
  await managed.stageWorkspaceFile(projectId, workspaceId, "new.txt");
  await managed.stageWorkspaceFile(projectId, workspaceId, "delete.txt");
  const status = await managed.inspectGit(projectId, workspaceId);
  expect(status.files).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "README.md", stagedState: "modified" }),
    expect.objectContaining({ path: "new.txt", stagedState: "added", untracked: false }),
    expect.objectContaining({ path: "delete.txt", stagedState: "deleted" })
  ]));
  await expect(readFile(canary, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("unstages a staged modification and staged addition while preserving worktree content", async () => {
  const { managed, worktree } = await setup();
  await writeFile(path.join(worktree, "README.md"), "updated\n", "utf8");
  await writeFile(path.join(worktree, "new.txt"), "new\n", "utf8");
  await managed.stageWorkspaceFile(projectId, workspaceId, "README.md");
  await managed.stageWorkspaceFile(projectId, workspaceId, "new.txt");
  await managed.unstageWorkspaceFile(projectId, workspaceId, "README.md");
  await managed.unstageWorkspaceFile(projectId, workspaceId, "new.txt");
  const status = await managed.inspectGit(projectId, workspaceId);
  expect(status.files).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "README.md", stagedState: "unchanged", unstagedState: "modified" }),
    expect.objectContaining({ path: "new.txt", stagedState: "unchanged", unstagedState: "untracked", untracked: true })
  ]));
  await expect(readFile(path.join(worktree, "README.md"), "utf8")).resolves.toBe("updated\n");
});

test("returns bounded text diffs for staged, unstaged, and untracked files", async () => {
  const { managed, worktree } = await setup();
  await writeFile(path.join(worktree, "README.md"), "unstaged\n", "utf8");
  await expect(managed.diffGit(projectId, workspaceId, "README.md", "unstaged")).resolves.toMatchObject({
    available: true, oldContent: "first\n", newContent: "unstaged\n", path: "README.md"
  });
  await managed.stageWorkspaceFile(projectId, workspaceId, "README.md");
  await expect(managed.diffGit(projectId, workspaceId, "README.md", "staged")).resolves.toMatchObject({
    available: true, oldContent: "first\n", newContent: "unstaged\n", path: "README.md"
  });
  await writeFile(path.join(worktree, "untracked.txt"), "added\n", "utf8");
  await expect(managed.diffGit(projectId, workspaceId, "untracked.txt", "unstaged")).resolves.toMatchObject({
    available: true, oldContent: "", newContent: "added\n", path: "untracked.txt"
  });
});

test("rejects binary and oversized diffs without invoking configured diff helpers", async () => {
  const { managed, worktree, canary } = await setup();
  const helper = path.join(path.dirname(canary), "diff-helper.sh");
  await writeFile(helper, `#!/bin/sh\nprintf helper-ran > ${JSON.stringify(canary)}\n`, "utf8");
  await chmod(helper, 0o755);
  await git(worktree, ["config", "diff.external", helper]);
  await git(worktree, ["config", "diff.readable.textconv", helper]);
  await writeFile(path.join(worktree, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(worktree, "large.txt"), Buffer.alloc(300 * 1024, 97));
  await writeFile(path.join(worktree, "README.md"), "changed\n", "utf8");

  await expect(managed.diffGit(projectId, workspaceId, "binary.dat", "unstaged")).resolves.toMatchObject({ available: false, reason: "binary" });
  await expect(managed.diffGit(projectId, workspaceId, "large.txt", "unstaged")).resolves.toMatchObject({ available: false, reason: "too-large" });
  await expect(managed.diffGit(projectId, workspaceId, "README.md", "unstaged")).resolves.toMatchObject({ available: true });
  await expect(readFile(canary, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("confines Git mutations to the managed workspace and rejects invalid paths", async () => {
  const { managed, worktree } = await setup();
  await expect(managed.stageWorkspaceFile(projectId, workspaceId, "../outside.txt")).rejects.toMatchObject({ failure: { code: "WORKSPACE_PATH_INVALID" } });
  await expect(managed.stageWorkspaceFile(projectId, workspaceId, "/tmp/outside.txt")).rejects.toMatchObject({ failure: { code: "WORKSPACE_PATH_INVALID" } });
  await expect(managed.stageWorkspaceFile(projectId, workspaceId, ".git/config")).rejects.toMatchObject({ failure: { code: "WORKSPACE_PATH_INVALID" } });
  await expect(managed.stageWorkspaceFile(projectId, workspaceId, ".devspace-git/config")).rejects.toMatchObject({ failure: { code: "WORKSPACE_PATH_INVALID" } });
  await expect(managed.unstageWorkspaceFile(projectId, workspaceId, ".devspace-git/config")).rejects.toMatchObject({ failure: { code: "WORKSPACE_PATH_INVALID" } });
  await expect(managed.diffGit(projectId, workspaceId, ".devspace-git/config", "unstaged")).rejects.toMatchObject({ failure: { code: "WORKSPACE_PATH_INVALID" } });
  await writeFile(path.join(worktree, "README.md"), "changed\n", "utf8");
  await managed.stageWorkspaceFile(projectId, workspaceId, "README.md");
  expect(failureCode(await managed.inspectGit(projectId, workspaceId))).toBeUndefined();
});

test("commits only the staged index with explicit identity and suppresses hooks and signing", async () => {
  const { managed, worktree, firstCommit, canary } = await setup();
  const hook = path.join(path.dirname(canary), "hook.sh");
  await writeFile(hook, `#!/bin/sh\nprintf hook-ran > ${JSON.stringify(canary)}\n`, "utf8");
  await chmod(hook, 0o755);
  await git(worktree, ["config", "core.hooksPath", path.dirname(hook)]);
  await git(worktree, ["config", "commit.gpgSign", "true"]);
  await git(worktree, ["config", "gpg.program", hook]);
  await writeFile(path.join(worktree, "README.md"), "staged commit\n", "utf8");
  await writeFile(path.join(worktree, "src/nested.txt"), "unstaged remains\n", "utf8");
  await managed.stageWorkspaceFile(projectId, workspaceId, "README.md");

  await expect(managed.commitWorkspace(projectId, workspaceId, "Commit staged file", "Explicit Name", "explicit@example.invalid"))
    .resolves.toMatch(/^[0-9a-f]{40}$/u);
  const status = await managed.inspectGit(projectId, workspaceId);
  expect(status.headCommit).not.toBe(firstCommit);
  expect(status.files).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "src/nested.txt", stagedState: "unchanged", unstagedState: "modified" })
  ]));
  expect(status.files.find((entry) => entry.path === "README.md")).toBeUndefined();
  await expect(git(worktree, ["log", "-1", "--format=%s"])).resolves.toBe("Commit staged file");
  await expect(git(worktree, ["log", "-1", "--format=%an <%ae>"])).resolves.toBe("Explicit Name <explicit@example.invalid>");
  await expect(readFile(canary, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("rejects empty commits and whitespace-only messages", async () => {
  const { managed, worktree } = await setup();
  await expect(managed.commitWorkspace(projectId, workspaceId, " ", "Name", "name@example.invalid")).rejects.toMatchObject({ failure: { code: "GIT_COMMIT_MESSAGE_INVALID" } });
  await expect(managed.commitWorkspace(projectId, workspaceId, "No staged changes", "Name", "name@example.invalid")).rejects.toMatchObject({ failure: { code: "GIT_NOTHING_TO_COMMIT" } });
  await writeFile(path.join(worktree, "README.md"), "changed\n", "utf8");
  await expect(managed.commitWorkspace(projectId, workspaceId, "Still no staged changes", "Name", "name@example.invalid")).rejects.toMatchObject({ failure: { code: "GIT_NOTHING_TO_COMMIT" } });
});
