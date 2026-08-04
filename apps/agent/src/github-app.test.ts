import { generateKeyPairSync } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGithubAppAuthority, type GithubHttpRequest } from "./github-app.js";
import { durableJsonWriter, type AtomicJsonWriter } from "./private-state.js";

const roots: string[] = [];
const connectionId = "018f0d84-7b39-7cc3-9d4a-0675d9162a11";
async function bind(authority: Awaited<ReturnType<typeof createGithubAppAuthority>>, status: "connected" | "degraded" = "connected") {
  await authority.persistBindingForTest({ connectionId, installationId: "77", accountId: "9007199254740993", accountType: "Organization", accountLogin: "org", repositorySelection: "all", permissions: { metadata: "read" }, status, verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: status === "degraded" });
}
async function fixture() {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "devspace-github-")); roots.push(stateRoot);
  await chmod(stateRoot, 0o700);
  const appRoot = path.join(stateRoot, "github-app");
  await mkdir(appRoot, { mode: 0o700 });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(path.join(appRoot, "private-key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await writeFile(path.join(appRoot, "config.json"), JSON.stringify({ version: 1, appId: "123", expectedAccountId: "9007199254740993", expectedAccountType: "Organization", installationUrl: "https://github.com/apps/devspace-test/installations/new" }), { mode: 0o600 });
  return { stateRoot, appRoot };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("GitHub App authority", () => {
  it("verifies App and numeric account authority then retains the binding across restart", async () => {
    const { stateRoot } = await fixture();
    const calls: GithubHttpRequest[] = [];
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      calls.push(request);
      if (request.path === "/app") return { status: 200, body: { id: 123 } };
      return { status: 200, body: { id: 77, app_id: 123, repository_selection: "selected", suspended_at: null, account: { id: 9007199254740993n, login: "renamed-org", type: "Organization" }, permissions: { metadata: "read" } } };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:00:00.000Z") });
    const verified = await authority.verifyInstallation({ connectionId: "018f0d84-7b39-7cc3-9d4a-0675d9162a11", installationId: "77" });
    expect(verified.accountId).toBe("9007199254740993");
    expect(verified.accountLogin).toBe("renamed-org");
    expect(calls.map(({ path }) => path)).toEqual(["/app", "/app/installations/77"]);
    const restarted = await createGithubAppAuthority({ stateRoot, transport });
    expect((await restarted.inspectInstallation("018f0d84-7b39-7cc3-9d4a-0675d9162a11")).installationId).toBe("77");
  });

  it("fails closed for wrong app, account, type, or suspension", async () => {
    const variants = [
      { app_id: 999, account: { id: 9007199254740993n, login: "x", type: "Organization" }, suspended_at: null },
      { app_id: 123, account: { id: 4, login: "x", type: "Organization" }, suspended_at: null },
      { app_id: 123, account: { id: 9007199254740993n, login: "x", type: "User" }, suspended_at: null },
      { app_id: 123, account: { id: 9007199254740993n, login: "x", type: "Organization" }, suspended_at: "2026-08-04T00:00:00Z" }
    ];
    for (const variant of variants) {
      const { stateRoot } = await fixture();
      const authority = await createGithubAppAuthority({ stateRoot, transport: async ({ path }) => {
        await Promise.resolve();
        return path === "/app" ? { status: 200, body: { id: 123 } }
          : { status: 200, body: { id: 77, repository_selection: "all", permissions: {}, ...variant } };
      } });
      await expect(authority.verifyInstallation({ connectionId: "018f0d84-7b39-7cc3-9d4a-0675d9162a11", installationId: "77" })).rejects.toThrow("github-authority-invalid");
    }
  });

  it("rejects an installation without the minimum metadata permission", async () => {
    const { stateRoot } = await fixture();
    const authority = await createGithubAppAuthority({ stateRoot, transport: async ({ path }) => {
      await Promise.resolve();
      return path === "/app"
        ? { status: 200, body: { id: 123 } }
        : { status: 200, body: { id: 77, app_id: 123, repository_selection: "all", suspended_at: null, account: { id: 9007199254740993n, login: "org", type: "Organization" }, permissions: { issues: "read" } } };
    } });
    await expect(authority.verifyInstallation({ connectionId, installationId: "77" })).rejects.toThrow("github-authority-invalid");
  });

  it("rejects malformed upstream repository identities", async () => {
    const { stateRoot } = await fixture();
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      return request.path.endsWith("/access_tokens")
        ? { status: 201, body: { token: "malformed-repository-secret", expires_at: "2026-08-04T12:59:00.000Z" } }
        : request.path.startsWith("/installation/repositories?")
          ? { status: 200, body: { repositories: [{ id: 77, name: "repo", full_name: "other/repo", default_branch: "main", private: true, archived: false, disabled: false, owner: { login: "org/name" } }] } }
          : request.path === "/installation/token" ? { status: 204, body: {} } : { status: 500, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:00:00.000Z") });
    await bind(authority);
    await expect(authority.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-upstream-invalid");
  });

  it("settles a complete bounded GitHub rejection as a definitive no-token outcome", async () => {
    const { stateRoot, appRoot } = await fixture();
    let rejected = true;
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      if (request.path.endsWith("/access_tokens")) {
        if (rejected) return { status: 422, body: { message: "validation failed" } };
        return { status: 201, body: { token: "definitive-secret", expires_at: "2026-08-04T12:59:00.000Z" } };
      }
      if (request.path.startsWith("/installation/repositories?")) return { status: 200, body: { repositories: [] } };
      if (request.path === "/installation/token") return { status: 204, body: {} };
      return { status: 500, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:00:00.000Z") });
    await bind(authority);
    await expect(authority.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-mint-failed");
    await expect(readFile(path.join(appRoot, "token-leases", `${connectionId}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    rejected = false;
    await authority.listRepositories({ connectionId, pageSize: 20 });
  });

  it("rejects symlinked, multiply-linked, oversized, and malformed private files", async () => {
    const mutations = [
      async (appRoot: string) => { const key = path.join(appRoot, "private-key.pem"); await rename(key, `${key}.real`); await symlink(`${key}.real`, key); },
      async (appRoot: string) => { await link(path.join(appRoot, "private-key.pem"), path.join(appRoot, "private-key-copy.pem")); },
      async (appRoot: string) => { await writeFile(path.join(appRoot, "private-key.pem"), Buffer.alloc(70 * 1024, 1), { mode: 0o600 }); },
      async (appRoot: string) => { await writeFile(path.join(appRoot, "private-key.pem"), "not-a-private-key", { mode: 0o600 }); },
      async (appRoot: string) => { await writeFile(path.join(appRoot, "config.json"), "{}", { mode: 0o600 }); }
    ];
    for (const mutate of mutations) {
      const { stateRoot, appRoot } = await fixture(); await mutate(appRoot);
      await expect(createGithubAppAuthority({ stateRoot })).rejects.toThrow("github-private-state-invalid");
    }
  });

  it("preserves primary listing success when revocation fails and blocks minting through restart until expiry", async () => {
    const { stateRoot, appRoot } = await fixture();
    let mints = 0;
    const mintBodies: unknown[] = [];
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      if (request.path.endsWith("/access_tokens")) { mints++; mintBodies.push(request.body); return { status: 201, body: { token: "installation-secret", expires_at: mints === 1 ? "2026-08-04T13:00:00.000Z" : "2026-08-04T14:00:00.000Z" } }; }
      if (request.path.startsWith("/installation/repositories?")) return { status: 200, body: { total_count: 1, repositories: [{ id: 99, name: "private", full_name: "renamed-org/private", html_url: "https://github.com/renamed-org/private", default_branch: "main", private: true, archived: false, disabled: false, owner: { login: "renamed-org" } }] } };
      if (request.path === "/installation/token") return { status: 503, body: {} };
      return { status: 500, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:00:00.000Z") });
    await authority.persistBindingForTest({ connectionId: "018f0d84-7b39-7cc3-9d4a-0675d9162a11", installationId: "77", accountId: "9007199254740993", accountType: "Organization", accountLogin: "renamed-org", repositorySelection: "all", permissions: { metadata: "read" }, status: "connected", verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: false });
    const page = await authority.listRepositories({ connectionId: "018f0d84-7b39-7cc3-9d4a-0675d9162a11", pageSize: 20 });
    expect(page.cleanupDegraded).toBe(true);
    expect(mintBodies[0]).toEqual({ permissions: { metadata: "read" } });
    expect(JSON.stringify(mintBodies[0])).not.toContain("contents");
    expect(page.repositories[0]?.cleanHttpsUrl).toBe("https://github.com/renamed-org/private.git");
    expect(JSON.stringify(page)).not.toContain("installation-secret");
    const lease = await readFile(path.join(appRoot, "token-leases", "018f0d84-7b39-7cc3-9d4a-0675d9162a11.json"), "utf8");
    expect(lease).not.toContain("installation-secret");
    const restarted = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:30:00.000Z") });
    await expect(restarted.listRepositories({ connectionId: "018f0d84-7b39-7cc3-9d4a-0675d9162a11", pageSize: 20 })).rejects.toThrow("github-token-lease-active");
    expect(mints).toBe(1);
    const expired = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T13:00:01.000Z") });
    await expired.listRepositories({ connectionId: "018f0d84-7b39-7cc3-9d4a-0675d9162a11", pageSize: 20 });
    expect(mints).toBe(2);
  });

  it("keeps a truthful primary failure separate from uncertain revocation cleanup", async () => {
    const { stateRoot, appRoot } = await fixture(); const secret = "never-project-this-token";
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      return request.path.endsWith("/access_tokens")
        ? { status: 201, body: { token: secret, expires_at: "2026-08-04T13:00:00.000Z" } }
        : request.path.startsWith("/installation/repositories?") ? { status: 502, body: { message: secret } }
        : { status: 503, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:00:00.000Z") });
    await authority.persistBindingForTest({ connectionId: "018f0d84-7b39-7cc3-9d4a-0675d9162a11", installationId: "77", accountId: "9007199254740993", accountType: "Organization", accountLogin: "org", repositorySelection: "all", permissions: { metadata: "read" }, status: "connected", verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: false });
    const error = await authority.listRepositories({ connectionId: "018f0d84-7b39-7cc3-9d4a-0675d9162a11", pageSize: 20 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe("github-upstream-invalid");
    expect((error as Error).message).not.toContain(secret);
    expect(await readFile(path.join(appRoot, "token-leases", "018f0d84-7b39-7cc3-9d4a-0675d9162a11.json"), "utf8")).not.toContain(secret);
    const restarted = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:30:00.000Z") });
    await expect(restarted.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-lease-active");
  });

  it("retains a conservative mint block when the mint transport becomes uncertain", async () => {
    const { stateRoot, appRoot } = await fixture();
    const connectionId = "018f0d84-7b39-7cc3-9d4a-0675d9162a11";
    let phase: "uncertain" | "recovered" = "uncertain";
    let mints = 0;
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      if (request.path.endsWith("/access_tokens")) {
        mints++;
        if (phase === "uncertain") throw new Error("socket-reset-after-submit");
        return { status: 201, body: { token: "recovered-secret", expires_at: "2026-08-04T14:00:00.000Z" } };
      }
      if (request.path === "/installation/token") return { status: 204, body: {} };
      if (request.path.startsWith("/installation/repositories?")) return { status: 200, body: { repositories: [] } };
      return { status: 500, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:00:00.000Z") });
    await authority.persistBindingForTest({ connectionId, installationId: "77", accountId: "9007199254740993", accountType: "Organization", accountLogin: "org", repositorySelection: "all", permissions: { metadata: "read" }, status: "connected", verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: false });
    await expect(authority.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-mint-failed");
    expect(await readFile(path.join(appRoot, "token-leases", `${connectionId}.json`), "utf8")).not.toContain("recovered-secret");
    const restarted = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:30:00.000Z") });
    await expect(restarted.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-lease-active");
    expect(mints).toBe(1);
    phase = "recovered";
    const expired = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T13:11:00.000Z") });
    await expired.listRepositories({ connectionId, pageSize: 20 });
    expect(mints).toBe(2);
  });

  it.each([
    ["missing expiry", { token: "missing-expiry-secret" }],
    ["malformed expiry", { token: "malformed-expiry-secret", expires_at: "not-a-timestamp" }],
    ["malformed response", "not-an-object"],
    ["oversized response", { oversized: "x".repeat(512 * 1024 + 1) }]
  ])("treats %s mint responses as uncertain and never persists authority", async (_label, body) => {
    const { stateRoot, appRoot } = await fixture();
    const connectionId = "018f0d84-7b39-7cc3-9d4a-0675d9162a11";
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      if (request.path.endsWith("/access_tokens")) return { status: 201, body };
      if (request.path === "/installation/token") return { status: 503, body: {} };
      return { status: 500, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:00:00.000Z") });
    await authority.persistBindingForTest({ connectionId, installationId: "77", accountId: "9007199254740993", accountType: "Organization", accountLogin: "org", repositorySelection: "all", permissions: { metadata: "read" }, status: "connected", verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: false });
    await expect(authority.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-mint-failed");
    const leaseText = await readFile(path.join(appRoot, "token-leases", `${connectionId}.json`), "utf8");
    expect(leaseText).not.toContain("secret");
    const restarted = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:30:00.000Z") });
    await expect(restarted.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-lease-active");
  });

  it("preserves a successful page when degraded lease persistence fails", async () => {
    const { stateRoot, appRoot } = await fixture();
    const writer: AtomicJsonWriter = {
      async write(filePath, value) {
        if (typeof value === "object" && value !== null && (value as { phase?: unknown }).phase === "cleanup-degraded") throw new Error("lease-write-failed");
        await durableJsonWriter.write(filePath, value);
      }
    };
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      return request.path.endsWith("/access_tokens")
        ? { status: 201, body: { token: "lease-failure-secret", expires_at: "2026-08-04T13:00:00.000Z" } }
        : request.path.startsWith("/installation/repositories?")
          ? { status: 200, body: { repositories: [] } }
          : request.path === "/installation/token" ? { status: 503, body: {} } : { status: 500, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, writer, now: () => new Date("2026-08-04T12:00:00.000Z") });
    await bind(authority);
    const page = await authority.listRepositories({ connectionId, pageSize: 20 });
    expect(page.cleanupDegraded).toBe(true);
    expect((await authority.inspectInstallation(connectionId)).status).toBe("degraded");
    expect(await readFile(path.join(appRoot, "token-leases", `${connectionId}.json`), "utf8")).toContain('"phase":"active"');
    const restarted = await createGithubAppAuthority({ stateRoot, transport, writer, now: () => new Date("2026-08-04T12:30:00.000Z") });
    await expect(restarted.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-lease-active");
  });

  it("preserves a successful page when degraded binding persistence fails", async () => {
    const { stateRoot, appRoot } = await fixture();
    const writer: AtomicJsonWriter = {
      async write(filePath, value) {
        if (typeof value === "object" && value !== null && (value as { status?: unknown }).status === "degraded") throw new Error("binding-write-failed");
        await durableJsonWriter.write(filePath, value);
      }
    };
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      return request.path.endsWith("/access_tokens")
        ? { status: 201, body: { token: "binding-failure-secret", expires_at: "2026-08-04T13:00:00.000Z" } }
        : request.path.startsWith("/installation/repositories?") ? { status: 200, body: { repositories: [] } }
          : request.path === "/installation/token" ? { status: 503, body: {} } : { status: 500, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, writer, now: () => new Date("2026-08-04T12:00:00.000Z") });
    await bind(authority);
    expect((await authority.listRepositories({ connectionId, pageSize: 20 })).cleanupDegraded).toBe(true);
    expect((await authority.inspectInstallation(connectionId)).status).toBe("connected");
    expect(await readFile(path.join(appRoot, "token-leases", `${connectionId}.json`), "utf8")).toContain('"phase":"cleanup-degraded"');
    const restarted = await createGithubAppAuthority({ stateRoot, transport, writer, now: () => new Date("2026-08-04T12:30:00.000Z") });
    await expect(restarted.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-lease-active");
  });

  it("keeps the guard and degraded binding when revocation succeeds but lease removal fails", async () => {
    const { stateRoot, appRoot } = await fixture();
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      return request.path.endsWith("/access_tokens")
        ? { status: 201, body: { token: "unlink-failure-secret", expires_at: "2026-08-04T13:00:00.000Z" } }
        : request.path.startsWith("/installation/repositories?") ? { status: 200, body: { repositories: [] } }
          : request.path === "/installation/token" ? { status: 204, body: {} } : { status: 500, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, removeLease: async () => { await Promise.resolve(); throw new Error("unlink-failed"); }, now: () => new Date("2026-08-04T12:00:00.000Z") });
    await bind(authority);
    expect((await authority.listRepositories({ connectionId, pageSize: 20 })).cleanupDegraded).toBe(true);
    expect((await authority.inspectInstallation(connectionId)).status).toBe("degraded");
    expect(await readFile(path.join(appRoot, "token-leases", `${connectionId}.json`), "utf8")).not.toContain("unlink-failure-secret");
    const restarted = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:30:00.000Z") });
    await expect(restarted.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-lease-active");
  });

  it("recovers degraded binding only after expiry, successful listing, revocation, and settlement", async () => {
    const { stateRoot } = await fixture();
    let revoke = false;
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      return request.path.endsWith("/access_tokens")
        ? { status: 201, body: { token: revoke ? "recovery-secret" : "initial-secret", expires_at: revoke ? "2026-08-04T14:00:00.000Z" : "2026-08-04T13:00:00.000Z" } }
        : request.path.startsWith("/installation/repositories?") ? { status: 200, body: { repositories: [] } }
          : request.path === "/installation/token" ? (revoke ? { status: 204, body: {} } : { status: 503, body: {} }) : { status: 500, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:00:00.000Z") });
    await bind(authority);
    expect((await authority.listRepositories({ connectionId, pageSize: 20 })).cleanupDegraded).toBe(true);
    const blocked = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:30:00.000Z") });
    await expect(blocked.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-lease-active");
    revoke = true;
    const recovered = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T13:01:00.000Z") });
    expect((await recovered.listRepositories({ connectionId, pageSize: 20 })).cleanupDegraded).toBe(false);
    expect((await recovered.inspectInstallation(connectionId)).status).toBe("connected");
  });

  it("does not restore connected status when recovery binding settlement fails", async () => {
    const { stateRoot } = await fixture();
    let failConnected = false;
    const writer: AtomicJsonWriter = {
      async write(filePath, value) {
        if (failConnected && typeof value === "object" && value !== null && (value as { status?: unknown }).status === "connected") throw new Error("recovery-binding-write-failed");
        await durableJsonWriter.write(filePath, value);
      }
    };
    let successful = false;
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      return request.path.endsWith("/access_tokens")
        ? { status: 201, body: { token: successful ? "recovery-secret" : "initial-secret", expires_at: successful ? "2026-08-04T14:00:00.000Z" : "2026-08-04T13:00:00.000Z" } }
        : request.path.startsWith("/installation/repositories?") ? { status: 200, body: { repositories: [] } }
          : request.path === "/installation/token" ? (successful ? { status: 204, body: {} } : { status: 503, body: {} }) : { status: 500, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, writer, now: () => new Date("2026-08-04T12:00:00.000Z") });
    await bind(authority);
    await authority.listRepositories({ connectionId, pageSize: 20 });
    successful = true;
    failConnected = true;
    const recovered = await createGithubAppAuthority({ stateRoot, transport, writer, now: () => new Date("2026-08-04T13:01:00.000Z") });
    expect((await recovered.listRepositories({ connectionId, pageSize: 20 })).cleanupDegraded).toBe(true);
    expect((await recovered.inspectInstallation(connectionId)).status).toBe("degraded");
  });

  it("parses the exact bytes from the validated descriptor and rejects metadata mutation", async () => {
    const { stateRoot } = await fixture();
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      return request.path === "/app"
        ? { status: 200, body: { id: 123 } }
        : { status: 200, body: { id: 77, app_id: 123, repository_selection: "all", suspended_at: null, account: { id: 9007199254740993n, login: "org", type: "Organization" }, permissions: { metadata: "read" } } };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:00:00.000Z") });
    await authority.verifyInstallation({ connectionId, installationId: "77" });
    await expect(createGithubAppAuthority({ stateRoot, privateReadAfterRead: async (filePath) => {
      if (filePath.endsWith(`${connectionId}.json`)) await chmod(filePath, 0o644);
    } })).rejects.toThrow("github-private-state-invalid");
  });
});
