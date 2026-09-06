import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, expect, test } from "vitest";
import { uuidV7Schema, utcTimestampMsSchema } from "@devspace/contracts";
import { DuplicateProjectSlugError, ProjectSetupConflictError, openProjectDatabase } from "./server/database.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const ids = [
  "018f0f00-0000-7000-8000-000000000001",
  "018f0f00-0000-7000-8000-000000000002",
  "018f0f00-0000-7000-8000-000000000003",
  "018f0f00-0000-7000-8000-000000000004"
];

test("persists canonical registering projects and a redacted audit event across database reload", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-web-db-")); directories.push(directory);
  const databasePath = path.join(directory, "devspace.sqlite");
  let idIndex = 0;
  const database = openProjectDatabase(databasePath, {
    now: () => new Date("2026-07-17T12:34:56.789Z"), createId: () => ids[idIndex++]!
  });
  const created = database.createProject({
    name: "Rocket", slug: "rocket", repositoryUrl: "https://example.com/rocket.git", defaultBranch: "main", actor: "owner@example.com"
  });
  expect(uuidV7Schema.parse(created.id)).toBe(created.id);
  expect(utcTimestampMsSchema.parse(created.createdAt)).toBe("2026-07-17T12:34:56.789Z");
  expect(created.state).toBe("registering");
  const audit = database.listAuditEvents();
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ actor: "owner@example.com", eventType: "project.registered", resourceType: "project", resourceId: created.id, operationId: null });
  expect(JSON.parse(audit[0]!.metadataJson)).toEqual({ sourceKind: "remote" });
  database.close();
  const rawDatabase = new BetterSqlite3(databasePath, { readonly: true });
  expect(rawDatabase.prepare("select repository_store_path, automatic_fetch_policy, active_config_revision_id, primary_workspace_id, row_version from projects where id = ?").get(created.id)).toEqual({
    repository_store_path: `/srv/devspace/projects/${created.id}/repository.git`,
    automatic_fetch_policy: "manual",
    active_config_revision_id: null,
    primary_workspace_id: null,
    row_version: 1
  });
  rawDatabase.close();
  const reopened = openProjectDatabase(databasePath);
  expect(reopened.listProjects()).toEqual([created]);
  reopened.close();
});

test("reports duplicate slugs without exposing SQLite errors", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-web-db-")); directories.push(directory);
  let idIndex = 0;
  const database = openProjectDatabase(path.join(directory, "devspace.sqlite"), { createId: () => ids[idIndex++]! });
  const input = { name: "Rocket", slug: "rocket", repositoryUrl: "https://example.com/rocket.git", defaultBranch: "main", actor: "owner@example.com" };
  database.createProject(input);
  expect(() => database.createProject({ ...input, name: "Other" })).toThrow(DuplicateProjectSlugError);
  expect(database.listProjects()).toHaveLength(1);
  expect(database.listAuditEvents()).toHaveLength(1);
  database.close();
});

test("atomically persists immutable GitHub source metadata and proves actor ownership", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-web-db-")); directories.push(directory);
  let idIndex = 0;
  const database = openProjectDatabase(path.join(directory, "devspace.sqlite"), { createId: () => ids[idIndex++]! });
  const attempt = database.createGithubConnectionAttempt({ actor: "owner@example.com", stateHash: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" });
  database.claimGithubConnectionAttempt({ actor: "owner@example.com", stateHash: "a".repeat(64), installationId: "9007199254740993" });
  database.connectGithubInstallation({ actor: "owner@example.com", connectionId: attempt.connectionId, installationId: "9007199254740993",
    accountId: "99", accountType: "Organization", accountLogin: "owner-org", repositorySelection: "selected",
    permissions: { metadata: "read", contents: "read" }, status: "connected", verifiedAt: "2026-07-17T12:34:56.789Z" });
  const project = database.createProject({ name: "Private", slug: "private", repositoryUrl: "https://github.com/owner/private.git",
    defaultBranch: "release", actor: "owner@example.com", githubSource: {
      connectionId: attempt.connectionId,
      repository: { repositoryId: "9007199254740993", ownerLogin: "owner", name: "private", fullName: "owner/private",
        cleanHttpsUrl: "https://github.com/owner/private.git", defaultBranch: "main", private: true, archived: false, disabled: false },
      verifiedAt: "2026-07-17T12:34:56.789Z", metadataUpdatedAt: "2026-07-17T12:34:56.789Z"
    } });
  expect(database.getProjectGithubSource(project.id)).toMatchObject({ connectionId: attempt.connectionId, repositoryId: "9007199254740993",
    defaultBranch: "main", private: true });
  expect(database.getProjectSourceLocator(project.id)).toEqual({ kind: "github-app", connectionId: attempt.connectionId, repositoryId: "9007199254740993" });
  expect(() => database.assertGithubConnectionOwned("other@example.com", attempt.connectionId)).toThrow(ProjectSetupConflictError);
  const raw = new BetterSqlite3(path.join(directory, "devspace.sqlite"), { readonly: true });
  const sourceRows = raw.prepare("select * from project_github_sources").all() as unknown;
  const typedSourceRows = sourceRows as readonly Record<string, unknown>[];
  expect(typedSourceRows.some((row) => Object.hasOwn(row, "token"))).toBe(false);
  raw.close();
  database.close();
});

test("rolls project creation back when the transactional audit insert fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-web-db-")); directories.push(directory);
  let idIndex = 0;
  const database = openProjectDatabase(path.join(directory, "devspace.sqlite"), {
    createId: () => ids[idIndex++]!, beforeAuditInsert: () => { throw new Error("forced audit failure"); }
  });
  expect(() => database.createProject({
    name: "Rocket", slug: "rocket", repositoryUrl: "https://example.com/rocket.git", defaultBranch: "main", actor: "owner@example.com"
  })).toThrow("forced audit failure");
  expect(database.listProjects()).toEqual([]);
  expect(database.listAuditEvents()).toEqual([]);
  database.close();
});

test("does not mislabel a non-slug uniqueness violation as a duplicate slug", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-web-db-")); directories.push(directory);
  let createCalls = 0;
  const database = openProjectDatabase(path.join(directory, "devspace.sqlite"), {
    createId: () => createCalls++ % 2 === 0 ? ids[0]! : ids[1]!
  });
  const input = { name: "Rocket", slug: "rocket", repositoryUrl: "https://example.com/rocket.git", defaultBranch: "main", actor: "owner@example.com" };
  database.createProject(input);
  try {
    database.createProject({ ...input, slug: "other" });
    throw new Error("Expected a project ID uniqueness violation.");
  } catch (error) {
    expect(error).not.toBeInstanceOf(DuplicateProjectSlugError);
    expect((error as { code?: string }).code).toBe("SQLITE_CONSTRAINT_UNIQUE");
  }
  expect(database.listProjects()).toHaveLength(1);
  expect(database.listAuditEvents()).toHaveLength(1);
  database.close();
});

test("reads dashboard summaries separately and resolves only the exact managed project", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-web-db-")); directories.push(directory);
  const database = openProjectDatabase(path.join(directory, "devspace.sqlite"), { createId: () => ids[0]! });
  const created = database.createProject({ name: "Rocket", slug: "rocket", repositoryUrl: "https://example.com/rocket.git", defaultBranch: "main", actor: "actor" });
  expect(database.listProjectSummaries()).toEqual([expect.objectContaining({ id: created.id, name: "Rocket", primaryWorkspace: null, runtime: null })]);
  expect(database.getManagedProject(created.id)).toMatchObject({ id: created.id, state: "registering", tasks: [], taskRuns: [], terminals: [] });
  expect(database.getManagedProject("018f0f00-0000-7000-8000-ffffffffffff")).toBeUndefined();
  database.close();
});
