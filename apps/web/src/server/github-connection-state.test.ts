import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openProjectDatabase, ProjectSetupConflictError } from "./database.js";

describe("GitHub connection state", () => {
  it("persists only a state hash and atomically resumes an exact duplicate claim", () => {
    const raw = "one-time-state-secret";
    const stateHash = createHash("sha256").update(raw).digest("hex");
    const database = openProjectDatabase(":memory:", { now: () => new Date("2026-08-04T12:00:00.000Z"),
      createId: () => "018f0d84-7b39-7cc3-9d4a-0675d9162a11" });
    const attempt = database.createGithubConnectionAttempt({ actor: "owner@example.test", stateHash, expiresAt: "2026-08-04T12:10:00.000Z" });
    expect(JSON.stringify(attempt)).not.toContain(raw);
    const first = database.claimGithubConnectionAttempt({ actor: "owner@example.test", stateHash, installationId: "9007199254740993" });
    const duplicate = database.claimGithubConnectionAttempt({ actor: "owner@example.test", stateHash, installationId: "9007199254740993" });
    expect(duplicate).toEqual(first);
    expect(() => database.claimGithubConnectionAttempt({ actor: "owner@example.test", stateHash, installationId: "7" })).toThrow("GITHUB_INSTALLATION_CONFLICT");
    expect(() => database.claimGithubConnectionAttempt({ actor: "foreign@example.test", stateHash, installationId: "9007199254740993" })).toThrow("GITHUB_STATE_INVALID");
    database.close();
  });

  it("rejects expired state", () => {
    const database = openProjectDatabase(":memory:", { now: () => new Date("2026-08-04T12:10:00.000Z"),
      createId: () => "018f0d84-7b39-7cc3-9d4a-0675d9162a11" });
    database.createGithubConnectionAttempt({ actor: "owner", stateHash: "a".repeat(64), expiresAt: "2026-08-04T12:09:59.000Z" });
    expect(() => database.claimGithubConnectionAttempt({ actor: "owner", stateHash: "a".repeat(64), installationId: "1" })).toThrow("GITHUB_STATE_EXPIRED");
    database.close();
  });

  it("serializes concurrent callback claims through the compare-and-swap row version", async () => {
    const database = openProjectDatabase(":memory:", { now: () => new Date("2026-08-04T12:00:00.000Z"),
      createId: () => "018f0d84-7b39-7cc3-9d4a-0675d9162a11" });
    const stateHash = "b".repeat(64);
    database.createGithubConnectionAttempt({ actor: "owner", stateHash, expiresAt: "2026-08-04T12:10:00.000Z" });
    const claims = await Promise.all([
      Promise.resolve().then(() => database.claimGithubConnectionAttempt({ actor: "owner", stateHash, installationId: "77" })),
      Promise.resolve().then(() => database.claimGithubConnectionAttempt({ actor: "owner", stateHash, installationId: "77" }))
    ]);
    expect(claims[0]?.status).toBe("claimed");
    expect(claims[1]?.status).toBe("claimed");
    expect(claims[0]?.rowVersion).toBe(claims[1]?.rowVersion);
    database.close();
  });

  it("proves the retained connection belongs to the actor at persisted private-source lookup", () => {
    const database = openProjectDatabase(":memory:", { now: () => new Date("2026-08-04T12:00:00.000Z") });
    const attempt = database.createGithubConnectionAttempt({ actor: "owner", stateHash: "c".repeat(64), expiresAt: "2026-08-04T12:10:00.000Z" });
    database.claimGithubConnectionAttempt({ actor: "owner", stateHash: "c".repeat(64), installationId: "77" });
    database.connectGithubInstallation({ actor: "owner", connectionId: attempt.connectionId, installationId: "77", accountId: "99",
      accountType: "Organization", accountLogin: "org", repositorySelection: "selected", permissions: { metadata: "read", contents: "read" },
      status: "connected", verifiedAt: "2026-08-04T12:00:00.000Z" });
    const project = database.createProject({ name: "Private", slug: "private", repositoryUrl: "https://github.com/org/private.git", defaultBranch: "feature", actor: "owner",
      githubSource: { connectionId: attempt.connectionId, repository: { repositoryId: "9007199254740993", ownerLogin: "org", name: "private", fullName: "org/private",
        cleanHttpsUrl: "https://github.com/org/private.git", defaultBranch: "main", private: true, archived: false, disabled: false },
        verifiedAt: "2026-08-04T12:00:00.000Z", metadataUpdatedAt: "2026-08-04T12:00:00.000Z" } });
    expect(database.getProjectSourceLocator(project.id, "owner")).toEqual({ kind: "github-app", connectionId: attempt.connectionId, repositoryId: "9007199254740993" });
    const refreshed = database.refreshProjectGithubSource({ projectId: project.id, actor: "owner", connectionId: attempt.connectionId,
      repository: { repositoryId: "9007199254740993", ownerLogin: "org", name: "renamed", fullName: "org/renamed",
        cleanHttpsUrl: "https://github.com/org/renamed.git", defaultBranch: "trunk", private: true, archived: false, disabled: false },
      verifiedAt: "2026-08-04T12:01:00.000Z", metadataUpdatedAt: "2026-08-04T12:01:00.000Z" });
    expect(refreshed).toMatchObject({ repositoryId: "9007199254740993", name: "renamed", defaultBranch: "trunk", rowVersion: 2 });
    expect(database.listProjects()[0]).toMatchObject({ repositoryUrl: "https://github.com/org/renamed.git", defaultBranch: "feature" });
    expect(() => database.getProjectSourceLocator(project.id, "foreign")).toThrow(ProjectSetupConflictError);
    expect(() => database.assertGithubConnectionOwned("foreign", attempt.connectionId)).toThrow(ProjectSetupConflictError);
    database.close();
  });

  it("keeps a retained connection visible beside a newer initial setup attempt", () => {
    let nextId = 0;
    const ids = [
      "018f0d84-7b39-7cc3-9d4a-0675d9162a11",
      "018f0d84-7b39-7cc3-9d4a-0675d9162a12"
    ];
    const database = openProjectDatabase(":memory:", { now: () => new Date("2026-08-04T12:00:00.000Z"),
      createId: () => ids[nextId++] ?? "018f0d84-7b39-7cc3-9d4a-0675d9162a13" });
    const retained = database.createGithubConnectionAttempt({ actor: "owner", stateHash: "c".repeat(64), expiresAt: "2026-08-04T12:10:00.000Z" });
    database.claimGithubConnectionAttempt({ actor: "owner", stateHash: "c".repeat(64), installationId: "77" });
    database.connectGithubInstallation({ actor: "owner", connectionId: retained.connectionId, installationId: "77", accountId: "99",
      accountType: "Organization", accountLogin: "org", repositorySelection: "all", permissions: { metadata: "read" },
      status: "connected", verifiedAt: "2026-08-04T12:00:00.000Z" });
    const pending = database.createGithubConnectionAttempt({ actor: "owner", stateHash: "e".repeat(64), expiresAt: "2026-08-04T12:10:00.000Z" });
    const state = database.getGithubConnectionState("owner");
    expect(state).toMatchObject({
      connection: { connectionId: retained.connectionId, lifecycleState: "enabled" },
      pendingAttempt: { connectionId: pending.connectionId, status: "pending" }
    });
    expect(state?.connection?.connectionId).not.toBe(pending.connectionId);
    database.close();
  });

  it("advances a durable generation, keeps the retained connection visible, and isolates reauthorization", () => {
    let nextId = 0;
    const ids = [
      "018f0d84-7b39-7cc3-9d4a-0675d9162a11",
      "018f0d84-7b39-7cc3-9d4a-0675d9162a12"
    ];
    const database = openProjectDatabase(":memory:", { now: () => new Date("2026-08-04T12:00:00.000Z"),
      createId: () => ids[nextId++] ?? "018f0d84-7b39-7cc3-9d4a-0675d9162a13" });
    const initial = database.createGithubConnectionAttempt({ actor: "owner", stateHash: "d".repeat(64), expiresAt: "2026-08-04T12:10:00.000Z" });
    database.claimGithubConnectionAttempt({ actor: "owner", stateHash: "d".repeat(64), installationId: "77" });
    database.connectGithubInstallation({ actor: "owner", connectionId: initial.connectionId, installationId: "77", accountId: "99",
      accountType: "Organization", accountLogin: "org", repositorySelection: "selected", permissions: { metadata: "read", contents: "read" },
      status: "connected", verifiedAt: "2026-08-04T12:00:00.000Z" });

    const fenced = database.beginGithubDisconnect({ actor: "owner", connectionId: initial.connectionId });
    expect(fenced.lifecycleGeneration).toBe(2);
    expect(fenced.lifecycleState).toBe("disconnect-pending");
    expect(database.getGithubAuthorityContext("owner", initial.connectionId)).toMatchObject({
      connectionId: initial.connectionId, lifecycleGeneration: 2, lifecycleState: "disconnect-pending", admitted: false
    });

    const reconnect = database.createGithubConnectionAttempt({ actor: "owner", connectionId: initial.connectionId,
      stateHash: "e".repeat(64), expiresAt: "2026-08-04T12:10:00.000Z" });
    expect(reconnect.connectionId).toBe(initial.connectionId);
    expect(reconnect.lifecycleGeneration).toBe(3);
    expect(database.getGithubConnectionState("owner")).toMatchObject({
      connection: { connectionId: initial.connectionId, installationId: "77", lifecycleGeneration: 3 },
      pendingAttempt: { connectionId: initial.connectionId, targetGeneration: 3 }
    });
    const retry = database.createGithubConnectionAttempt({ actor: "owner", connectionId: initial.connectionId,
      stateHash: "f".repeat(64), expiresAt: "2026-08-04T12:10:00.000Z" });
    expect("attemptId" in retry && "attemptId" in reconnect).toBe(true);
    if ("attemptId" in retry && "attemptId" in reconnect) {
      expect(retry.attemptId).toBe(reconnect.attemptId);
    }
    expect(retry.lifecycleGeneration).toBe(3);
    expect(() => database.beginGithubDisconnect({ actor: "foreign", connectionId: initial.connectionId })).toThrow(ProjectSetupConflictError);
    database.close();
  });
});
