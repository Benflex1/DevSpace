import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { createWorkspaceDataSchema } from "@devspace/contracts";
import { canonicalizeProjectOptionsV1, hashProjectOptionsV1, parseProjectOptionsV1 } from "@devspace/project-options";
import { ManagedWorkspaces, runGit, type GitRunner } from "./managed-workspaces.js";

const exec = promisify(execFile);
const projectId = "018f0f00-0000-7000-8000-000000000101";
const revisionId = "018f0f00-0000-7000-8000-000000000102";
const workspaceId = "018f0f00-0000-7000-8000-000000000103";
const storeOperation = "018f0f00-0000-7000-8000-000000000104";
const workspaceOperation = "018f0f00-0000-7000-8000-000000000105";
const sourceUrl = "https://example.com/workspace-files.git";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(): Promise<{ managed: ManagedWorkspaces; worktree: string; outside: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-workspace-files-test-"));
  directories.push(root);
  const source = path.join(root, "source");
  await exec("/usr/bin/git", ["init", "-b", "main", source]);
  await exec("/usr/bin/git", ["-C", source, "config", "user.name", "DevSpace Test"]);
  await exec("/usr/bin/git", ["-C", source, "config", "user.email", "devspace@example.invalid"]);
  await mkdir(path.join(source, "src", "nested"), { recursive: true });
  await mkdir(path.join(source, ".github"), { recursive: true });
  await writeFile(path.join(source, "README.md"), "# DevSpace\n", "utf8");
  await writeFile(path.join(source, "src", "z.ts"), "export const z = 1;\n", "utf8");
  await writeFile(path.join(source, "src", "A.ts"), "export const a = 1;\n", "utf8");
  await writeFile(path.join(source, "src", "nested", "file.txt"), "nested\n", "utf8");
  await writeFile(path.join(source, ".github", "workflow.yml"), "name: test\n", "utf8");
  await exec("/usr/bin/git", ["-C", source, "add", "."]);
  await exec("/usr/bin/git", ["-C", source, "commit", "-m", "fixture"]);

  const roots = {
    projects: path.join(root, "managed", "projects"),
    workspaces: path.join(root, "managed", "workspaces"),
    state: path.join(root, "managed", "state")
  };
  await Promise.all(Object.values(roots).map((directory) => mkdir(directory, { recursive: true })));
  const git: GitRunner = async (args) => await runGit([
    "-c", `url.${source}.insteadOf=${sourceUrl}`, "-c", "protocol.file.allow=always", ...args
  ]);
  const managed = new ManagedWorkspaces(roots, git);
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
  const outside = path.join(root, "outside.txt");
  await writeFile(outside, "outside\n", "utf8");
  return { managed, worktree: managed.worktreePath(workspaceId), outside };
}

test("lists the workspace root lazily with stable directories-first ordering and no .git", async () => {
  const { managed } = await setup();
  await expect(managed.listWorkspaceDirectory(projectId, workspaceId, "")).resolves.toEqual({ path: "", entries: [
    { path: ".github", name: ".github", kind: "directory" },
    { path: "src", name: "src", kind: "directory" },
    { path: "README.md", name: "README.md", kind: "file", size: 11 }
  ] });
  await expect(managed.listWorkspaceDirectory(projectId, workspaceId, "src")).resolves.toEqual({ path: "src", entries: [
    { path: "src/nested", name: "nested", kind: "directory" },
    { path: "src/A.ts", name: "A.ts", kind: "file", size: 20 },
    { path: "src/z.ts", name: "z.ts", kind: "file", size: 20 }
  ] });
});

test.each(["../README.md", "/etc/passwd", "C:/etc/passwd", "src/../../README.md", "src\\..\\README.md", "bad\u0000name"])(
  "rejects workspace path escape or malformed path %s",
  async (filePath) => {
    const { managed } = await setup();
    await expect(managed.readWorkspaceFile(projectId, workspaceId, filePath)).rejects.toMatchObject({
      failure: { code: "WORKSPACE_PATH_INVALID" }
    });
  }
);

test("rejects .git as an exact component while keeping .github visible", async () => {
  const { managed } = await setup();
  await expect(managed.readWorkspaceFile(projectId, workspaceId, ".git/config")).rejects.toMatchObject({
    failure: { code: "WORKSPACE_PATH_INVALID" }
  });
  await expect(managed.listWorkspaceDirectory(projectId, workspaceId, ".github")).resolves.toMatchObject({ entries: [{ name: "workflow.yml" }] });
});

test("hides and denies access to the workspace-local Git administration directory", async () => {
  const { managed } = await setup();
  const rootListing = await managed.listWorkspaceDirectory(projectId, workspaceId, "");
  expect(rootListing.entries.some((entry) => entry.name === ".devspace-git")).toBe(false);
  await expect(managed.readWorkspaceFile(projectId, workspaceId, ".devspace-git/config")).rejects.toMatchObject({
    failure: { code: "WORKSPACE_PATH_INVALID" }
  });
  await expect(managed.saveWorkspaceFile(projectId, workspaceId, ".devspace-git/config", "overwrite", "0".repeat(64))).rejects.toMatchObject({
    failure: { code: "WORKSPACE_PATH_INVALID" }
  });
  await expect(managed.listWorkspaceDirectory(projectId, workspaceId, ".devspace-git")).rejects.toMatchObject({
    failure: { code: "WORKSPACE_PATH_INVALID" }
  });
});

test("reads strict UTF-8 text with a SHA-256 revision", async () => {
  const { managed } = await setup();
  const result = await managed.readWorkspaceFile(projectId, workspaceId, "README.md");
  expect(result).toMatchObject({ path: "README.md", content: "# DevSpace\n", size: 11 });
  expect(result.revision).toMatch(/^[0-9a-f]{64}$/u);
});

test("rejects binary and oversized files without returning corrupted text", async () => {
  const { managed, worktree } = await setup();
  await writeFile(path.join(worktree, "binary.dat"), Buffer.from([0, 1, 2, 255]));
  await writeFile(path.join(worktree, "large.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, 97));
  await expect(managed.readWorkspaceFile(projectId, workspaceId, "binary.dat")).rejects.toMatchObject({
    failure: { code: "WORKSPACE_FILE_UNSUPPORTED" }
  });
  await expect(managed.readWorkspaceFile(projectId, workspaceId, "large.txt")).rejects.toMatchObject({
    failure: { code: "WORKSPACE_FILE_TOO_LARGE" }
  });
});

test("saves only when the expected byte revision is current", async () => {
  const { managed, worktree } = await setup();
  const original = await managed.readWorkspaceFile(projectId, workspaceId, "README.md");
  const saved = await managed.saveWorkspaceFile(projectId, workspaceId, "README.md", "updated\n", original.revision);
  expect(saved.path).toBe("README.md");
  expect(saved.revision).toMatch(/^[0-9a-f]{64}$/u);
  await expect(readFile(path.join(worktree, "README.md"), "utf8")).resolves.toBe("updated\n");
  await writeFile(path.join(worktree, "README.md"), "changed externally\n", "utf8");
  await expect(managed.saveWorkspaceFile(projectId, workspaceId, "README.md", "must not win\n", original.revision)).rejects.toMatchObject({
    failure: { code: "WORKSPACE_FILE_CHANGED" }
  });
  await expect(readFile(path.join(worktree, "README.md"), "utf8")).resolves.toBe("changed externally\n");
});

test("rejects symlink reads and writes without mutating the outside target", async () => {
  const { managed, worktree, outside } = await setup();
  await symlink(outside, path.join(worktree, "escape.txt"));
  await expect(managed.readWorkspaceFile(projectId, workspaceId, "escape.txt")).rejects.toMatchObject({
    failure: { code: "WORKSPACE_PATH_INVALID" }
  });
  await expect(managed.saveWorkspaceFile(projectId, workspaceId, "escape.txt", "overwritten\n", "0".repeat(64))).rejects.toMatchObject({
    failure: { code: "WORKSPACE_PATH_INVALID" }
  });
  await expect(readFile(outside, "utf8")).resolves.toBe("outside\n");
});
