import { generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import * as z from "zod";
import {
  githubRepositoryResolveDataSchema,
  gitBranchNameSchema,
  createWorkspaceDataSchema,
  type GithubRepository,
  type GithubRepositoryResolveData,
  type SourceLocator
} from "@devspace/contracts";
import { canonicalizeProjectOptionsV1, hashProjectOptionsV1, parseProjectOptionsV1 } from "@devspace/project-options";
import { AgentExecutionError, ManagedWorkspaces, protectedGitInvocation, type GitRunner } from "./managed-workspaces.js";
import type { AskpassCapability, GithubAskpassBroker } from "./github-askpass.js";
import { createGithubAppAuthority, type GithubAppAuthority, type GithubHttpRequest } from "./github-app.js";
import { AgentEventLog } from "./event-log.js";
import { OperationExecutor } from "./operation-executor.js";
import { OperationJournal } from "./operation-journal.js";
import { ExternalExecutionFence, type ExternalExecutionResult } from "./external-execution.js";
import { GitInspectionUnavailableError } from "./git-inspector.js";

const processMocks = vi.hoisted(() => ({
  runBoundedProcess: vi.fn(),
  realRunBoundedProcess: undefined as typeof import("./git-inspector.js")["runBoundedProcess"] | undefined
}));
type GitInspectorModule = typeof import("./git-inspector.js");
vi.mock("./git-inspector.js", async (importOriginal) => {
  const original = Object.assign({}, await importOriginal()) as GitInspectorModule;
  processMocks.realRunBoundedProcess = original.runBoundedProcess;
  return { ...original, runBoundedProcess: processMocks.runBoundedProcess };
});

const exec = promisify(execFile);
const projectId = "018f0f00-0000-7000-8000-000000000101";
const connectionId = "018f0d84-7b39-7cc3-9d4a-0675d9162a11";
const repositoryId = "9007199254740993";
const workspaceId = "018f0f00-0000-7000-8000-000000000103";
const revisionId = "018f0f00-0000-7000-8000-000000000104";
const sourceUrl = "https://github.com/org/private-repo.git";
const pushBranch = gitBranchNameSchema.parse("feature/push");
const sourceLocator = { kind: "github-app", connectionId, repositoryId } as const satisfies SourceLocator;
const repository: GithubRepository = {
  repositoryId,
  ownerLogin: "org",
  name: "private-repo",
  fullName: "org/private-repo",
  cleanHttpsUrl: sourceUrl,
  defaultBranch: "main",
  private: true,
  archived: false,
  disabled: false
};

type AuthorityCall = { readonly method: "resolve" | "token" | "write"; readonly input: GithubRepositoryResolveData };
type AuthorityFaults = { readonly resolve?: Error; readonly token?: Error };
type HarnessRoots = { readonly projects: string; readonly workspaces: string; readonly state: string };
type GithubAuthorityFactory = (roots: HarnessRoots) => Promise<GithubAppAuthority>;

function createAuthority(calls: AuthorityCall[], faults: AuthorityFaults = {}): GithubAppAuthority {
  return {
    resolveRepository: (input: GithubRepositoryResolveData) => {
      const normalized = githubRepositoryResolveDataSchema.parse(input);
      calls.push({ method: "resolve", input: normalized });
      if (faults.resolve !== undefined) throw faults.resolve;
      return Promise.resolve({ repository, cleanupDegraded: false });
    },
    withExactRepositoryToken: async <T>(input: GithubRepositoryResolveData, operation: (token: string, repository: GithubRepository) => Promise<T>) => {
      const normalized = githubRepositoryResolveDataSchema.parse(input);
      calls.push({ method: "token", input: normalized });
      if (faults.token !== undefined) throw faults.token;
      return { value: await operation("in-memory-token", repository), cleanupDegraded: false };
    },
    withExactRepositoryWriteToken: async <T>(input: GithubRepositoryResolveData, operation: (token: string, repository: GithubRepository) => Promise<T>) => {
      const normalized = githubRepositoryResolveDataSchema.parse(input);
      calls.push({ method: "write", input: normalized });
      if (faults.token !== undefined) throw faults.token;
      return { value: await operation("in-memory-write-token", repository), cleanupDegraded: false };
    },
    acquireGithubLaunchFence: () => Promise.resolve(() => undefined)
  } as unknown as GithubAppAuthority;
}

async function createRealAuthority(roots: HarnessRoots, calls: GithubHttpRequest[]): Promise<GithubAppAuthority> {
  const appRoot = path.join(roots.state, "github-app");
  await mkdir(appRoot, { mode: 0o700 });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(path.join(appRoot, "private-key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await writeFile(path.join(appRoot, "config.json"), JSON.stringify({ version: 1, appId: "123", expectedAccountId: "9007199254740993",
    expectedAccountType: "Organization", installationUrl: "https://github.com/apps/devspace-test/installations/new" }), { mode: 0o600 });
  const transport = async (request: GithubHttpRequest) => {
    await Promise.resolve();
    calls.push(request);
    if (request.path === "/app") return { status: 200, body: { id: 123 } };
    if (request.path === "/app/installations/77") return { status: 200, body: { id: 77, app_id: 123, repository_selection: "selected", suspended_at: null,
      account: { id: 9007199254740993n, login: "org", type: "Organization" }, permissions: { metadata: "read", contents: "read" } } };
    if (request.path.endsWith("/access_tokens")) {
      const body = request.body as { readonly kind?: unknown } | undefined;
      if (body?.kind === "exact-repository-token") return { status: 201, body: { token: "exact-repository-token", expires_at: "2026-08-04T13:00:00.000Z",
        permissions: { contents: "read" }, repository_selection: "selected", repositories: [{ id: repositoryId, owner: { login: "org" }, name: "private-repo",
          full_name: "org/private-repo", default_branch: "main", private: true, archived: false, disabled: false }] } };
      return { status: 201, body: { token: "metadata-repository-token", expires_at: "2026-08-04T13:00:00.000Z" } };
    }
    if (request.path.startsWith("/installation/repositories?")) return { status: 200, body: { repositories: [{ id: repositoryId, owner: { login: "org" }, name: "private-repo",
      full_name: "org/private-repo", default_branch: "main", private: true, archived: false, disabled: false }] } };
    if (request.method === "DELETE" && request.path === "/installation/token") return { status: 204, body: {} };
    throw new Error(`unexpected GitHub transport path ${request.path}`);
  };
  const authority = await createGithubAppAuthority({ stateRoot: roots.state, transport, now: () => new Date("2026-08-04T12:00:00.000Z") });
  await authority.persistBindingForTest({ connectionId, installationId: "77", accountId: "9007199254740993", accountType: "Organization", accountLogin: "org",
    repositorySelection: "selected", permissions: { metadata: "read", contents: "read" }, status: "connected", verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: false });
  return authority;
}

const managedInstances: ManagedWorkspaces[] = [];
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(managedInstances.splice(0).map((managed) => managed.shutdown()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  processMocks.runBoundedProcess.mockReset();
  vi.restoreAllMocks();
});

async function createHarness(authority: GithubAppAuthority | GithubAuthorityFactory, ensureStarted: () => Promise<void> = () => Promise.resolve(), useProductionFence = false,
  pushFailure?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-managed-github-test-"));
  temporaryRoots.push(root);
  const source = path.join(root, "source");
  await exec("/usr/bin/git", ["init", "-b", "main", source]);
  await exec("/usr/bin/git", ["-C", source, "config", "user.name", "DevSpace Test"]);
  await exec("/usr/bin/git", ["-C", source, "config", "user.email", "devspace@example.invalid"]);
  await writeFile(path.join(source, "README.md"), "first\n", "utf8");
  await exec("/usr/bin/git", ["-C", source, "add", "README.md"]);
  await exec("/usr/bin/git", ["-C", source, "commit", "-m", "first"]);

  const roots = {
    projects: path.join(root, "managed/projects"),
    workspaces: path.join(root, "managed/workspaces"),
    state: path.join(root, "managed/state")
  };
  await Promise.all(Object.values(roots).map((directory) => mkdir(directory, { recursive: true })));
  const git: GitRunner = async (args) => {
    if (pushFailure !== undefined && args.includes("push")) throw new Error(pushFailure);
    const invocation = protectedGitInvocation([
      "-c", `url.${source}.insteadOf=${sourceUrl}`, "-c", "protocol.file.allow=always", ...args
    ]);
    const result = await exec("/usr/bin/git", invocation.args, { env: invocation.env });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };
  const broker: GithubAskpassBroker = {
    socketPath: null,
    runtimeDirectory: null,
    helperPath: "/bin/false",
    ensureStarted,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    register: (input): AskpassCapability => ({
      capability: "a".repeat(64),
      socketPath: "/tmp/devspace-test-askpass.sock",
      helperPath: "/bin/false",
      executionId: input.executionId,
      environment: {}
    }),
    settle: () => undefined
  };
  const managed = new ManagedWorkspaces(roots, useProductionFence ? undefined : git, undefined, undefined, undefined, undefined, undefined, undefined, broker);
  const resolvedAuthority = typeof authority === "function" ? await authority(roots) : authority;
  managed.setGithubAuthority(resolvedAuthority);
  await managed.initialize();
  managedInstances.push(managed);
  return { managed, source, roots, git, broker, authority: resolvedAuthority };
}

async function prepareWorkspace(h: Awaited<ReturnType<typeof createHarness>>, source: SourceLocator = sourceLocator) {
  await h.managed.createManagedStore({ projectId, source }, "018f0f00-0000-7000-8000-000000000105");
  await h.managed.fetch(projectId, "018f0f00-0000-7000-8000-000000000106", source);
  const options = parseProjectOptionsV1({ schemaVersion: 1,
    developmentEnvironment: { source: { kind: "image", imageReference: "node:24-bookworm" } } });
  const revisionHash = hashProjectOptionsV1(options);
  await h.managed.registerRevision({ projectId, revisionId, configuration: {
    format: "devspace.project-options/v1", hash: revisionHash, canonicalJson: canonicalizeProjectOptionsV1(options)
  }});
  const workspace = createWorkspaceDataSchema.parse({ projectId, workspaceId, projectSlug: "project", workspaceSlug: "workspace",
    kind: "isolated", revision: { revisionId, revisionHash }, branchName: "feature/push", baseRef: { kind: "branch", branchName: "main" } });
  await h.managed.createWorkspace(workspace, "018f0f00-0000-7000-8000-000000000107");
  await exec("/usr/bin/git", ["-C", h.managed.worktreePath(workspaceId), "config", "user.name", "DevSpace Test"]);
  await exec("/usr/bin/git", ["-C", h.managed.worktreePath(workspaceId), "config", "user.email", "devspace@example.invalid"]);
  return workspace;
}

function externalResult(stderr: string, overrides: Partial<ExternalExecutionResult> = {}): ExternalExecutionResult {
  return { stdout: "", stderr, code: 128, signal: null, timedOut: false, ...overrides };
}

test("adapts a normal GitHub SourceLocator at the private inspect authority boundary", async () => {
  const calls: AuthorityCall[] = [];
  const h = await createHarness(createAuthority(calls));
  processMocks.runBoundedProcess.mockResolvedValue({
    stdout: "ref: refs/heads/main\tHEAD\n0123456789012345678901234567890123456789\tHEAD\n",
    stderr: "",
    code: 0,
    signal: null
  });

  await expect(h.managed.inspectSource(sourceLocator)).resolves.toMatchObject({
    sourceKind: "github-app",
    repository,
    defaultBranch: "main"
  });
  expect(calls).toEqual([{ method: "token", input: { connectionId, repositoryId } }]);
});

test.each([
  ["remote transport", "fatal: unable to access 'https://github.com/org/private-repo.git/': Could not resolve host: github.com", "SOURCE_UNAVAILABLE"],
  ["local filesystem", "fatal: cannot create directory at 'repository.git': Permission denied", "AGENT_INTERNAL_ERROR"],
  ["unknown Git", "fatal: unexpected private Git failure", "AGENT_INTERNAL_ERROR"],
  ["authentication", "fatal: unable to access 'https://github.com/org/private-repo.git/': HTTP 401", "GITHUB_GIT_AUTHENTICATION_FAILED"]
] as const)("classifies private inspect %s from the production process result", async (_name, stderr, code) => {
  const h = await createHarness(createAuthority([]));
  const secret = "inspect-secret-bearing-stderr";
  processMocks.runBoundedProcess.mockResolvedValue({ stdout: "", stderr: `${stderr} ${secret}`, code: 128, signal: null });

  let failure: unknown;
  try { await h.managed.inspectSource(sourceLocator); }
  catch (error) { failure = error; }
  expect(failure).toMatchObject({ failure: { code } });
  expect(JSON.stringify(failure)).not.toContain(secret);
});

test.each([
  ["spawn", "AGENT_INTERNAL_ERROR"],
  ["process-management", "AGENT_INTERNAL_ERROR"],
  ["timeout", "SOURCE_UNAVAILABLE"]
] as const)("classifies private inspect %s execution failure safely", async (reason, code) => {
  const h = await createHarness(createAuthority([]));
  processMocks.runBoundedProcess.mockRejectedValue(new GitInspectionUnavailableError(reason));
  await expect(h.managed.inspectSource(sourceLocator)).rejects.toMatchObject({ failure: { code } });
});

test("adapts a normal GitHub SourceLocator through managed-store clone", async () => {
  const calls: AuthorityCall[] = [];
  const h = await createHarness(createAuthority(calls));

  await h.managed.createManagedStore({ projectId, source: sourceLocator }, "018f0f00-0000-7000-8000-000000000102");

  expect(calls).toEqual([
    { method: "resolve", input: { connectionId, repositoryId } },
    { method: "token", input: { connectionId, repositoryId } }
  ]);
  await expect(exec("/usr/bin/git", ["--git-dir", h.managed.repositoryPath(projectId), "config", "--get", "remote.origin.url"]))
    .resolves.toMatchObject({ stdout: `${sourceUrl}\n` });
});

test.each([
  ["remote transport", "fatal: unable to access 'https://github.com/org/private-repo.git/': Failed to connect to github.com port 443 after 1 ms: Couldn't connect to server", "SOURCE_UNAVAILABLE"],
  ["local filesystem", "fatal: cannot create directory at 'repository.git': Permission denied", "AGENT_INTERNAL_ERROR"],
  ["unknown Git", "fatal: unexpected private Git failure", "AGENT_INTERNAL_ERROR"],
  ["authentication", "fatal: Authentication failed for 'https://github.com/org/private-repo.git/'", "GITHUB_GIT_AUTHENTICATION_FAILED"]
] as const)("classifies production private clone %s conservatively", async (_name, stderr, code) => {
  const calls: AuthorityCall[] = [];
  const h = await createHarness(createAuthority(calls), () => Promise.resolve(), true);
  const secret = "clone-secret-bearing-stderr";
  vi.spyOn(ExternalExecutionFence.prototype, "runGit").mockResolvedValue(externalResult(`${stderr} ${secret}`));

  let failure: unknown;
  try { await h.managed.createManagedStore({ projectId, source: sourceLocator }, "018f0f00-0000-7000-8000-000000000120"); }
  catch (error) { failure = error; }
  expect(failure).toMatchObject({ failure: { code } });
  expect(JSON.stringify(failure)).not.toContain(secret);
  expect(calls).toContainEqual({ method: "token", input: { connectionId, repositoryId } });
});

test("composes a private managed-store clone through the real authority transaction and cleans up its token", async () => {
  const calls: GithubHttpRequest[] = [];
  const h = await createHarness((roots) => createRealAuthority(roots, calls));

  await h.managed.createManagedStore({ projectId, source: sourceLocator }, "018f0f00-0000-7000-8000-000000000105");

  const exactMints = calls.filter((request) => request.path.endsWith("/access_tokens")
    && (request.body as { readonly kind?: unknown } | undefined)?.kind === "exact-repository-token");
  expect(exactMints).toHaveLength(1);
  expect(exactMints[0]?.body).toEqual({ kind: "exact-repository-token", repositoryId });
  expect(calls.filter((request) => request.method === "DELETE" && request.path === "/installation/token")).toHaveLength(2);
  await expect(exec("/usr/bin/git", ["--git-dir", h.managed.repositoryPath(projectId), "config", "--get", "remote.origin.url"]))
    .resolves.toMatchObject({ stdout: `${sourceUrl}\n` });
});

test("adapts a normal GitHub SourceLocator through managed-store fetch", async () => {
  const calls: AuthorityCall[] = [];
  const h = await createHarness(createAuthority(calls));
  await h.managed.createManagedStore({ projectId, source: sourceLocator }, "018f0f00-0000-7000-8000-000000000103");
  calls.splice(0);

  await writeFile(path.join(h.source, "README.md"), "second\n", "utf8");
  await exec("/usr/bin/git", ["-C", h.source, "add", "README.md"]);
  await exec("/usr/bin/git", ["-C", h.source, "commit", "-m", "second"]);
  const secondCommit = (await exec("/usr/bin/git", ["-C", h.source, "rev-parse", "HEAD"])).stdout.trim();
  await h.managed.fetch(projectId, "018f0f00-0000-7000-8000-000000000104", sourceLocator);

  expect(calls).toEqual([{ method: "token", input: { connectionId, repositoryId } }]);
  await expect(exec("/usr/bin/git", ["--git-dir", h.managed.repositoryPath(projectId), "rev-parse", "refs/remotes/origin/main"]))
    .resolves.toMatchObject({ stdout: `${secondCommit}\n` });
});

test.each([
  ["remote transport", "fatal: unable to access 'https://github.com/org/private-repo.git/': The requested URL returned error: 503", "SOURCE_UNAVAILABLE"],
  ["local ref lock", "error: cannot lock ref 'refs/remotes/origin/main': is at old but expected new", "AGENT_INTERNAL_ERROR"],
  ["unknown Git", "fatal: unexpected private Git failure", "AGENT_INTERNAL_ERROR"],
  ["authentication", "fatal: unable to access 'https://github.com/org/private-repo.git/': HTTP 403", "GITHUB_GIT_AUTHENTICATION_FAILED"]
] as const)("classifies production private fetch %s conservatively", async (_name, stderr, code) => {
  const setupCalls: AuthorityCall[] = [];
  const h = await createHarness(createAuthority(setupCalls));
  await h.managed.createManagedStore({ projectId, source: sourceLocator }, "018f0f00-0000-7000-8000-000000000121");
  await h.managed.shutdown();

  const calls: AuthorityCall[] = [];
  if (processMocks.realRunBoundedProcess === undefined) throw new Error("real process runner was not installed");
  processMocks.runBoundedProcess.mockImplementation(processMocks.realRunBoundedProcess);
  const managed = new ManagedWorkspaces(h.roots, undefined, undefined, undefined, undefined, undefined, undefined, undefined, h.broker);
  managed.setGithubAuthority(createAuthority(calls));
  await managed.initialize();
  managedInstances.push(managed);
  const secret = "fetch-secret-bearing-stderr";
  vi.spyOn(ExternalExecutionFence.prototype, "runGit").mockResolvedValue(externalResult(`${stderr} ${secret}`));

  let failure: unknown;
  try { await managed.fetch(projectId, "018f0f00-0000-7000-8000-000000000122", sourceLocator); }
  catch (error) { failure = error; }
  expect(failure).toMatchObject({ failure: { code } });
  expect(JSON.stringify(failure)).not.toContain(secret);
  expect(calls).toContainEqual({ method: "token", input: { connectionId, repositoryId } });
});

test("composes a private fetch through the real transaction and reports success to OperationExecutor", async () => {
  const setupCalls: AuthorityCall[] = [];
  const h = await createHarness(createAuthority(setupCalls));
  await h.managed.createManagedStore({ projectId, source: sourceLocator }, "018f0f00-0000-7000-8000-000000000106");
  await h.managed.shutdown();

  const calls: GithubHttpRequest[] = [];
  const authority = await createRealAuthority(h.roots, calls);
  const managed = new ManagedWorkspaces(h.roots, h.git, undefined, undefined, undefined, undefined, undefined, undefined, h.broker);
  managed.setGithubAuthority(authority);
  await managed.initialize();
  managedInstances.push(managed);

  await writeFile(path.join(h.source, "README.md"), "second\n", "utf8");
  await exec("/usr/bin/git", ["-C", h.source, "add", "README.md"]);
  await exec("/usr/bin/git", ["-C", h.source, "commit", "-m", "second"]);
  const secondCommit = (await exec("/usr/bin/git", ["-C", h.source, "rev-parse", "HEAD"])).stdout.trim();

  const operationId = "018f0f00-0000-7000-8000-000000000107";
  const journalRoot = path.join(h.roots.state, "operations");
  await mkdir(journalRoot, { recursive: true });
  const journal = new OperationJournal(journalRoot, () => new Date("2026-08-04T12:00:00.000Z"));
  await journal.initialize();
  const events = new AgentEventLog("018f0f00-0000-7000-8000-000000000108", () => new Date("2026-08-04T12:00:00.000Z"));
  const failed = vi.spyOn(events, "failed");
  const succeeded = vi.spyOn(events, "succeeded");
  const executor = new OperationExecutor(journal, managed, events);
  await executor.initialize();
  const record = await journal.accept(operationId, "project.fetch", { projectId, source: sourceLocator });
  executor.schedule(record);
  await executor.drain();

  expect(journal.get(operationId)).toMatchObject({ state: "succeeded", failure: null });
  expect(failed).not.toHaveBeenCalled();
  expect(succeeded).toHaveBeenCalled();
  expect(calls.filter((request) => request.method === "DELETE" && request.path === "/installation/token")).toHaveLength(1);
  await expect(exec("/usr/bin/git", ["--git-dir", managed.repositoryPath(projectId), "rev-parse", "refs/remotes/origin/main"]))
    .resolves.toMatchObject({ stdout: `${secondCommit}\n` });
});

test("recovers a durable private Fetch and syncs remote refs without disturbing an existing workspace", async () => {
  const calls: GithubHttpRequest[] = [];
  const h = await createHarness((roots) => createRealAuthority(roots, calls));
  await prepareWorkspace(h);
  calls.splice(0);

  const worktree = h.managed.worktreePath(workspaceId);
  await expect(readFile(path.join(worktree, ".git"), "utf8")).resolves.toBe("gitdir: .devspace-git\n");
  await expect(exec("/usr/bin/git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"]))
    .resolves.toMatchObject({ stdout: `${worktree}/.devspace-git\n` });
  const initialWorkspaceRemoteCommit = (await exec("/usr/bin/git", ["-C", worktree, "rev-parse", "refs/remotes/origin/main"])).stdout.trim();
  await writeFile(path.join(worktree, "local-commit.txt"), "unpublished workspace commit\n", "utf8");
  await exec("/usr/bin/git", ["-C", worktree, "add", "local-commit.txt"]);
  await exec("/usr/bin/git", ["-C", worktree, "commit", "-m", "Unpublished workspace commit"]);
  const localCommit = (await exec("/usr/bin/git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
  const branchBefore = (await exec("/usr/bin/git", ["-C", worktree, "symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  expect(branchBefore).toBe(pushBranch);
  await writeFile(path.join(worktree, "staged.txt"), "staged value\n", "utf8");
  await exec("/usr/bin/git", ["-C", worktree, "add", "staged.txt"]);
  await writeFile(path.join(worktree, "staged.txt"), "staged and unstaged value\n", "utf8");
  await writeFile(path.join(worktree, "untracked.txt"), "untracked workspace content\n", "utf8");
  const dirtyStatusBefore = (await exec("/usr/bin/git", ["-C", worktree, "status", "--porcelain=v1", "--untracked-files=all"])).stdout;

  await writeFile(path.join(h.source, "README.md"), "post-validation-failure\n", "utf8");
  await exec("/usr/bin/git", ["-C", h.source, "add", "README.md"]);
  await exec("/usr/bin/git", ["-C", h.source, "commit", "-m", "post-validation-failure"]);
  const secondCommit = (await exec("/usr/bin/git", ["-C", h.source, "rev-parse", "HEAD"])).stdout.trim();

  const privateManaged = h.managed as unknown as {
    loadStoreOwnership: (projectId: string) => Promise<unknown>;
  };
  const originalLoadStoreOwnership = privateManaged.loadStoreOwnership.bind(h.managed);
  let failDuringFetch = false;
  let fetchOwnershipLoads = 0;
  vi.spyOn(privateManaged, "loadStoreOwnership").mockImplementation(async (id) => {
    if (failDuringFetch && ++fetchOwnershipLoads === 2) throw new Error("post-fetch-ownership-validation-failed");
    return await originalLoadStoreOwnership(id);
  });

  const journalRoot = path.join(h.roots.state, "operations");
  await mkdir(journalRoot, { recursive: true });
  const journal = new OperationJournal(journalRoot, () => new Date("2026-08-04T12:00:00.000Z"));
  await journal.initialize();
  const events = new AgentEventLog("018f0f00-0000-7000-8000-000000000115", () => new Date("2026-08-04T12:00:00.000Z"));
  const failed = vi.spyOn(events, "failed");
  const executor = new OperationExecutor(journal, h.managed, events);
  await executor.initialize();
  failDuringFetch = true;
  const operationId = "018f0f00-0000-7000-8000-000000000116";
  const accepted = await journal.accept(operationId, "project.fetch", { projectId, source: sourceLocator });

  executor.schedule(accepted);
  await executor.drain();

  expect(journal.get(operationId)).toMatchObject({ state: "running", failure: null });
  expect(failed).not.toHaveBeenCalled();
  expect(fetchOwnershipLoads).toBe(2);
  await expect(exec("/usr/bin/git", ["--git-dir", h.managed.repositoryPath(projectId), "rev-parse", "refs/remotes/origin/main"]))
    .resolves.toMatchObject({ stdout: `${secondCommit}\n` });
  await expect(exec("/usr/bin/git", ["-C", worktree, "rev-parse", "refs/remotes/origin/main"]))
    .resolves.toMatchObject({ stdout: `${initialWorkspaceRemoteCommit}\n` });
  expect((await readFile(path.join(h.managed.repositoryPath(projectId), "FETCH_HEAD"))).byteLength).toBeGreaterThan(0);

  await h.managed.shutdown();
  const workspaceSyncInvocations: ReturnType<typeof protectedGitInvocation>[] = [];
  const protectedRetryGit: GitRunner = async (args) => {
    const isFixtureOriginFetch = args.includes("fetch") && args.includes("origin");
    const isWorkspaceRemoteRefSync = args.includes("fetch") && args.includes("--no-write-fetch-head")
      && args.some((argument) => argument.startsWith("+refs/remotes/origin/*:"));
    // The fixture rewrites the authenticated HTTPS origin to a local source repository. Keep this
    // allowance on that one command; the workspace-to-Agent-store sync gets no runner-side override.
    const invocation = protectedGitInvocation([
      "-c", `url.${h.source}.insteadOf=${sourceUrl}`,
      ...(isFixtureOriginFetch ? ["-c", "protocol.file.allow=always"] : []),
      ...args
    ]);
    if (isWorkspaceRemoteRefSync) workspaceSyncInvocations.push(invocation);
    const result = await exec("/usr/bin/git", invocation.args, { env: invocation.env });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };
  const resumedManaged = new ManagedWorkspaces(h.roots, protectedRetryGit, undefined, undefined, undefined, undefined, undefined, undefined, h.broker);
  resumedManaged.setGithubAuthority(h.authority);
  await resumedManaged.initialize();
  managedInstances.push(resumedManaged);

  const resumedJournal = new OperationJournal(journalRoot, () => new Date("2026-08-04T12:00:00.000Z"));
  await resumedJournal.initialize();
  expect(resumedJournal.get(operationId)).toMatchObject({ state: "running", failure: null });
  const resumedEvents = new AgentEventLog("018f0f00-0000-7000-8000-000000000120", () => new Date("2026-08-04T12:00:00.000Z"));
  const succeeded = vi.spyOn(resumedEvents, "succeeded");
  const resumedExecutor = new OperationExecutor(resumedJournal, resumedManaged, resumedEvents);
  await resumedExecutor.initialize();
  resumedExecutor.resumeAccepted();
  await resumedExecutor.drain();

  expect(resumedJournal.get(operationId)).toMatchObject({ state: "succeeded", failure: null });
  expect(succeeded).toHaveBeenCalled();
  expect(workspaceSyncInvocations).toHaveLength(1);
  expect(workspaceSyncInvocations[0]?.args).toContain("protocol.allow=never");
  expect(workspaceSyncInvocations[0]?.args).toContain("protocol.file.allow=always");
  expect(workspaceSyncInvocations[0]?.env.GIT_CONFIG_NOSYSTEM).toBe("1");
  expect(workspaceSyncInvocations[0]?.env.GIT_CONFIG_COUNT).toBe("0");
  expect(JSON.stringify(workspaceSyncInvocations[0])).not.toContain("exact-repository-token");
  expect(calls.filter((request) => request.path.endsWith("/access_tokens")
    && (request.body as { readonly kind?: unknown } | undefined)?.kind === "exact-repository-token")).toHaveLength(2);
  await expect(exec("/usr/bin/git", ["-C", worktree, "rev-parse", "refs/remotes/origin/main"]))
    .resolves.toMatchObject({ stdout: `${secondCommit}\n` });
  await expect(exec("/usr/bin/git", ["-C", worktree, "rev-parse", "HEAD"]))
    .resolves.toMatchObject({ stdout: `${localCommit}\n` });
  await expect(exec("/usr/bin/git", ["-C", worktree, "symbolic-ref", "--quiet", "--short", "HEAD"]))
    .resolves.toMatchObject({ stdout: `${branchBefore}\n` });
  await expect(exec("/usr/bin/git", ["-C", worktree, "status", "--porcelain=v1", "--untracked-files=all"]))
    .resolves.toMatchObject({ stdout: dirtyStatusBefore });
  await expect(readFile(path.join(worktree, "staged.txt"), "utf8"))
    .resolves.toBe("staged and unstaged value\n");
  await expect(readFile(path.join(worktree, "untracked.txt"), "utf8"))
    .resolves.toBe("untracked workspace content\n");
  await expect(readFile(path.join(worktree, "local-commit.txt"), "utf8"))
    .resolves.toBe("unpublished workspace commit\n");
  expect(calls.filter((request) => request.method === "DELETE" && request.path === "/installation/token")).toHaveLength(2);
});

test("does not cross the completed boundary when a real Fetch runner fails after local updates", async () => {
  const calls: AuthorityCall[] = [];
  const h = await createHarness(createAuthority(calls));
  const remoteSource = { kind: "remote" as const, url: sourceUrl };
  await h.managed.createManagedStore({ projectId, source: remoteSource }, "018f0f00-0000-7000-8000-000000000117");

  await writeFile(path.join(h.source, "README.md"), "runner-failure\n", "utf8");
  await exec("/usr/bin/git", ["-C", h.source, "add", "README.md"]);
  await exec("/usr/bin/git", ["-C", h.source, "commit", "-m", "runner-failure"]);
  const secondCommit = (await exec("/usr/bin/git", ["-C", h.source, "rev-parse", "HEAD"])).stdout.trim();

  await h.managed.shutdown();
  const failingGit: GitRunner = async (args) => {
    const result = await h.git(args);
    if (args.includes("fetch")) throw new Error("simulated-git-nonzero-after-local-update");
    return result;
  };
  const managed = new ManagedWorkspaces(h.roots, failingGit, undefined, undefined, undefined, undefined, undefined, undefined, h.broker);
  await managed.initialize();
  managedInstances.push(managed);

  const journalRoot = path.join(h.roots.state, "operations");
  await mkdir(journalRoot, { recursive: true });
  const journal = new OperationJournal(journalRoot, () => new Date("2026-08-04T12:00:00.000Z"));
  await journal.initialize();
  const events = new AgentEventLog("018f0f00-0000-7000-8000-000000000118", () => new Date("2026-08-04T12:00:00.000Z"));
  const succeeded = vi.spyOn(events, "succeeded");
  const executor = new OperationExecutor(journal, managed, events);
  const operationId = "018f0f00-0000-7000-8000-000000000119";
  const accepted = await journal.accept(operationId, "project.fetch", { projectId, source: remoteSource });

  executor.schedule(accepted);
  await executor.drain();

  expect(journal.get(operationId)).toMatchObject({ state: "failed", failure: { code: "SOURCE_UNAVAILABLE" } });
  expect(succeeded).not.toHaveBeenCalled();
  await expect(exec("/usr/bin/git", ["--git-dir", managed.repositoryPath(projectId), "rev-parse", "refs/remotes/origin/main"]))
    .resolves.toMatchObject({ stdout: `${secondCommit}\n` });
  expect((await readFile(path.join(managed.repositoryPath(projectId), "FETCH_HEAD"))).byteLength).toBeGreaterThan(0);
});

test("pushes the captured local commit to the same-name remote branch with write authority", async () => {
  const calls: AuthorityCall[] = [];
  const h = await createHarness(createAuthority(calls));
  await prepareWorkspace(h);
  const worktree = h.managed.worktreePath(workspaceId);
  await writeFile(path.join(worktree, "README.md"), "private push\n", "utf8");
  await exec("/usr/bin/git", ["-C", worktree, "add", "README.md"]);
  await exec("/usr/bin/git", ["-C", worktree, "commit", "-m", "private push"]);
  const commitOid = (await exec("/usr/bin/git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
  calls.splice(0);

  await h.managed.push({ projectId, workspaceId, source: sourceLocator, branchName: pushBranch, commitOid, githubAuthorityGeneration: 1 },
    "018f0f00-0000-7000-8000-000000000108");

  expect(calls).toEqual([{ method: "write", input: { connectionId, repositoryId, lifecycleGeneration: 1 } }]);
  await expect(exec("/usr/bin/git", ["-C", h.source, "rev-parse", "refs/heads/feature/push"]))
    .resolves.toMatchObject({ stdout: `${commitOid}\n` });
});

test.each(["remote pushurl", "URL rewrite"] as const)("fails closed when repository-local %s configuration could change the push destination", async (kind) => {
  const calls: AuthorityCall[] = [];
  const h = await createHarness(createAuthority(calls));
  await prepareWorkspace(h);
  const worktree = h.managed.worktreePath(workspaceId);
  const configKey = kind === "remote pushurl" ? "remote.origin.pushurl" : `url.${h.source}.insteadof`;
  const configValue = kind === "remote pushurl" ? "https://github.com/other/remote.git" : sourceUrl;
  await h.git(["-C", worktree, "config", configKey, configValue]);
  const commitOid = (await exec("/usr/bin/git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();

  await expect(h.managed.push({ projectId, workspaceId, source: sourceLocator, branchName: pushBranch, commitOid, githubAuthorityGeneration: 1 },
    "018f0f00-0000-7000-8000-000000000113")).rejects.toMatchObject({ failure: { code: "AGENT_INTERNAL_ERROR" } });
  expect(calls.filter((call) => call.method === "write")).toHaveLength(1);
});

test("advances an existing same-name remote branch without changing its destination", async () => {
  const calls: AuthorityCall[] = [];
  const h = await createHarness(createAuthority(calls));
  await prepareWorkspace(h);
  const worktree = h.managed.worktreePath(workspaceId);
  await writeFile(path.join(worktree, "README.md"), "first push\n", "utf8");
  await exec("/usr/bin/git", ["-C", worktree, "add", "README.md"]);
  await exec("/usr/bin/git", ["-C", worktree, "commit", "-m", "first push"]);
  const firstCommit = (await exec("/usr/bin/git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
  await h.managed.push({ projectId, workspaceId, source: sourceLocator, branchName: pushBranch, commitOid: firstCommit, githubAuthorityGeneration: 1 },
    "018f0f00-0000-7000-8000-000000000110");

  await writeFile(path.join(worktree, "README.md"), "second push\n", "utf8");
  await exec("/usr/bin/git", ["-C", worktree, "add", "README.md"]);
  await exec("/usr/bin/git", ["-C", worktree, "commit", "-m", "second push"]);
  const secondCommit = (await exec("/usr/bin/git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
  await h.managed.push({ projectId, workspaceId, source: sourceLocator, branchName: pushBranch, commitOid: secondCommit, githubAuthorityGeneration: 1 },
    "018f0f00-0000-7000-8000-000000000111");

  expect(calls.filter((call) => call.method === "write")).toHaveLength(2);
  await expect(exec("/usr/bin/git", ["-C", h.source, "rev-parse", "refs/heads/feature/push"]))
    .resolves.toMatchObject({ stdout: `${secondCommit}\n` });
});

test.each([
  ["non-fast-forward", "! [rejected] feature/push -> feature/push (non-fast-forward)", "GITHUB_PUSH_NON_FAST_FORWARD"],
  ["ambiguous Git failure", "fatal: the remote closed the connection after launch", "GITHUB_PUSH_OUTCOME_UNCERTAIN"]
] as const)("preserves %s from the authenticated Git transaction", async (_name, pushFailure, code) => {
  const calls: AuthorityCall[] = [];
  const h = await createHarness(createAuthority(calls), () => Promise.resolve(), false, pushFailure);
  await prepareWorkspace(h);
  const worktree = h.managed.worktreePath(workspaceId);
  const commitOid = (await exec("/usr/bin/git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();

  await expect(h.managed.push({ projectId, workspaceId, source: sourceLocator, branchName: pushBranch, commitOid, githubAuthorityGeneration: 1 },
    "018f0f00-0000-7000-8000-000000000112")).rejects.toMatchObject({ failure: { code } });
});

test("rejects a push intent when the captured commit no longer matches the workspace", async () => {
  const calls: AuthorityCall[] = [];
  const h = await createHarness(createAuthority(calls));
  await prepareWorkspace(h);
  const worktree = h.managed.worktreePath(workspaceId);
  const capturedCommit = (await exec("/usr/bin/git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(path.join(worktree, "README.md"), "drifted\n", "utf8");
  await exec("/usr/bin/git", ["-C", worktree, "add", "README.md"]);
  await exec("/usr/bin/git", ["-C", worktree, "commit", "-m", "drifted"]);
  calls.splice(0);

  await expect(h.managed.push({ projectId, workspaceId, source: sourceLocator, branchName: pushBranch, commitOid: capturedCommit, githubAuthorityGeneration: 1 },
    "018f0f00-0000-7000-8000-000000000109")).rejects.toMatchObject({ failure: { code: "GITHUB_PUSH_INTENT_STALE" } });
  expect(calls).toEqual([]);
});

test("rejects a push intent when the local branch no longer matches the captured branch", async () => {
  const calls: AuthorityCall[] = [];
  const h = await createHarness(createAuthority(calls));
  await prepareWorkspace(h);
  const worktree = h.managed.worktreePath(workspaceId);
  const capturedCommit = (await exec("/usr/bin/git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
  await exec("/usr/bin/git", ["-C", worktree, "switch", "-c", "local-only"]);
  calls.splice(0);

  await expect(h.managed.push({ projectId, workspaceId, source: sourceLocator, branchName: pushBranch,
    commitOid: capturedCommit, githubAuthorityGeneration: 1 }, "018f0f00-0000-7000-8000-000000000117"))
    .rejects.toMatchObject({ failure: { code: "GITHUB_PUSH_INTENT_STALE" } });
  expect(calls).toEqual([]);
});

test("does not put Git trace or curl-verbose controls in the positive Git environment", () => {
  const environment = protectedGitInvocation(["version"]).env;
  for (const variable of ["GIT_TRACE", "GIT_TRACE_PACKET", "GIT_TRACE_PERFORMANCE", "GIT_TRACE_SETUP", "GIT_TRACE_CURL", "GIT_CURL_VERBOSE"]) {
    expect(environment).not.toHaveProperty(variable);
  }
});

test("classifies an unexpected private GitHub authority boundary failure as Agent internal", async () => {
  const calls: AuthorityCall[] = [];
  const h = await createHarness(createAuthority(calls, { token: new Error("authority-contract-violation") }));
  processMocks.runBoundedProcess.mockResolvedValue({ stdout: "", stderr: "", code: 0, signal: null });

  let failure: unknown;
  try { await h.managed.inspectSource(sourceLocator); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AgentExecutionError);
  if (!(failure instanceof AgentExecutionError)) throw new Error("authority failure was not classified");
  expect(failure.failure.code).toBe("AGENT_INTERNAL_ERROR");
  expect(typeof (failure.failure.details as { readonly incidentId?: unknown }).incidentId).toBe("string");
  expect(failure.internalReason).toBe("github-authority-programming-error");
});

test("classifies a strict private GitHub authority DTO failure separately from provider unavailability", async () => {
  const calls: AuthorityCall[] = [];
  const h = await createHarness(createAuthority(calls, { token: new z.ZodError([]) }));
  processMocks.runBoundedProcess.mockResolvedValue({ stdout: "", stderr: "", code: 0, signal: null });

  let failure: unknown;
  try { await h.managed.inspectSource(sourceLocator); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AgentExecutionError);
  if (!(failure instanceof AgentExecutionError)) throw new Error("authority failure was not classified");
  expect(failure.failure.code).toBe("AGENT_INTERNAL_ERROR");
  expect(typeof (failure.failure.details as { readonly incidentId?: unknown }).incidentId).toBe("string");
  expect(failure.internalReason).toBe("github-authority-contract-violation");
});

test("composes a local private callback failure as Agent internal while still revoking the token", async () => {
  const calls: GithubHttpRequest[] = [];
  const h = await createHarness((roots) => createRealAuthority(roots, calls));
  processMocks.runBoundedProcess.mockRejectedValue(new Error("private-writer-state-secret"));

  let failure: unknown;
  try { await h.managed.inspectSource(sourceLocator); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AgentExecutionError);
  if (!(failure instanceof AgentExecutionError)) throw new Error("local callback failure was not classified");
  expect(failure.failure.code).toBe("AGENT_INTERNAL_ERROR");
  expect(failure.internalReason).toBe("github-authority-programming-error");
  expect(JSON.stringify(failure.failure)).not.toContain("private-writer-state-secret");
  expect(calls.filter((request) => request.method === "DELETE" && request.path === "/installation/token")).toHaveLength(1);
});

test("preserves a typed private credential transport failure as source unavailable", async () => {
  const calls: GithubHttpRequest[] = [];
  let ensureCalls = 0;
  const h = await createHarness((roots) => createRealAuthority(roots, calls), () => {
    ensureCalls += 1;
    if (ensureCalls === 3) throw new Error("askpass-transport-secret");
    return Promise.resolve();
  });

  let failure: unknown;
  try { await h.managed.createManagedStore({ projectId, source: sourceLocator }, "018f0f00-0000-7000-8000-000000000109"); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AgentExecutionError);
  if (!(failure instanceof AgentExecutionError)) throw new Error("credential transport failure was not classified");
  expect(failure.failure.code).toBe("SOURCE_UNAVAILABLE");
  expect(failure.internalReason).toBeUndefined();
  expect(JSON.stringify(failure.failure)).not.toContain("askpass-transport-secret");
  expect(calls.filter((request) => request.method === "DELETE" && request.path === "/installation/token")).toHaveLength(2);
});
