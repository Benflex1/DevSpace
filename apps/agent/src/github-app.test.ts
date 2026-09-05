import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
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
function streamedResponse(chunks: Uint8Array[], status: number, headers: Record<string, string> = {}) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk !== undefined) controller.enqueue(chunk);
    },
    cancel() { cancelled = true; }
  });
  return { response: { status, headers: new Headers(headers), body } as Response, wasCancelled: () => cancelled };
}
async function withFetch<T>(fetchImpl: typeof fetch, action: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await action(); } finally { globalThis.fetch = original; }
}
function fetchInputUrl(input: unknown): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  throw new TypeError("unexpected fetch input");
}
function gzipJson(response: ServerResponse, body: unknown, status: number): { encodedLength: number; decodedLength: number } {
  const decoded = Buffer.from(JSON.stringify(body));
  const encoded = gzipSync(decoded);
  response.writeHead(status, { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(encoded.byteLength) });
  response.end(encoded);
  return { encodedLength: encoded.byteLength, decodedLength: decoded.byteLength };
}
async function withLocalGithubFetch<T>(handler: (request: IncomingMessage, response: ServerResponse) => void, action: (origin: string) => Promise<T>): Promise<T> {
  const server = createServer((request, response) => { request.resume(); handler(request, response); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("local server address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  const actualFetch = originalFetch;
  globalThis.fetch = (input, init) => {
    const target = fetchInputUrl(input);
    return actualFetch(`${origin}${target.pathname}${target.search}`, init);
  };
  try {
    return await action(origin);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
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

  it("live-refreshes an existing binding instead of trusting its retained snapshot", async () => {
    const { stateRoot } = await fixture();
    const calls: GithubHttpRequest[] = [];
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      calls.push(request);
      if (request.path === "/app") return { status: 200, body: { id: 123 } };
      return { status: 200, body: { id: 77, app_id: 123, repository_selection: "selected", suspended_at: null,
        account: { id: 9007199254740993n, login: "renamed-org", type: "Organization" }, permissions: { metadata: "read" } } };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:00:00.000Z") });
    await bind(authority);
    const refreshed = await authority.refreshInstallation({ connectionId });
    expect(refreshed.accountLogin).toBe("renamed-org");
    expect(refreshed.repositorySelection).toBe("selected");
    expect(calls.map(({ path }) => path)).toEqual(["/app", "/app/installations/77"]);
  });

  it("keeps a connection listable but refuses exact private resolution without Contents read", async () => {
    const { stateRoot } = await fixture();
    const calls: GithubHttpRequest[] = [];
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      calls.push(request);
      if (request.path === "/app") return { status: 200, body: { id: 123 } };
      if (request.path === "/app/installations/77") return { status: 200, body: { id: 77, app_id: 123, repository_selection: "selected", suspended_at: null,
        account: { id: 9007199254740993n, login: "org", type: "Organization" }, permissions: { metadata: "read" } } };
      return { status: 500, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport });
    await bind(authority);
    await expect(authority.withExactRepositoryToken({ connectionId, repositoryId: "9007199254740993" }, () => Promise.resolve(undefined)))
      .rejects.toThrow("github-contents-permission-required");
    expect(calls.map(({ path }) => path)).toEqual(["/app", "/app/installations/77"]);
  });

  it("refuses private Git when the retained Contents snapshot is stale", async () => {
    const { stateRoot } = await fixture();
    const calls: GithubHttpRequest[] = [];
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      calls.push(request);
      if (request.path === "/app") return { status: 200, body: { id: 123 } };
      if (request.path === "/app/installations/77") return { status: 200, body: { id: 77, app_id: 123, repository_selection: "selected", suspended_at: null,
        account: { id: 9007199254740993n, login: "org", type: "Organization" }, permissions: { metadata: "read" } } };
      return { status: 500, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport });
    await authority.persistBindingForTest({ connectionId, installationId: "77", accountId: "9007199254740993", accountType: "Organization",
      accountLogin: "org", repositorySelection: "selected", permissions: { metadata: "read", contents: "read" }, status: "connected",
      verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: false });
    await expect(authority.withExactRepositoryToken({ connectionId, repositoryId: "9007199254740993" }, () => Promise.resolve(undefined)))
      .rejects.toThrow("github-contents-permission-required");
    expect(calls.map(({ path }) => path)).toEqual(["/app", "/app/installations/77"]);
  });

  it("mints one exact read token with a lossless raw numeric repository id", async () => {
    const { stateRoot } = await fixture();
    const observed: { body: string; token?: string; repositoryId?: string } = { body: "" };
    await withFetch(async (input, init) => {
      await Promise.resolve();
      const pathname = fetchInputUrl(input).pathname;
      if (pathname === "/app") return new Response('{"id":123}', { status: 200 });
      if (pathname === "/app/installations/77") return new Response('{"id":77,"app_id":123,"repository_selection":"selected","suspended_at":null,"account":{"id":9007199254740993,"login":"org","type":"Organization"},"permissions":{"metadata":"read","contents":"write"}}', { status: 200 });
      if (pathname === "/app/installations/77/access_tokens") {
        observed.body = typeof init?.body === "string" ? init.body : "";
        return new Response('{"token":"private-canary","expires_at":"2026-08-04T13:00:00.000Z","permissions":{"contents":"read"},"repository_selection":"selected","repositories":[{"id":9007199254740993,"owner":{"login":"org"},"name":"private-repo","full_name":"org/private-repo","default_branch":"main","private":true,"archived":false,"disabled":false,"permissions":{"admin":false,"push":false,"pull":true}}]}', { status: 201 });
      }
      if (pathname === "/installation/token") return new Response(null, { status: 204 });
      throw new Error(`unexpected path ${pathname}`);
    }, async () => {
      const authority = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:00:00.000Z") });
      await bind(authority);
      const result = await authority.withExactRepositoryToken({ connectionId, repositoryId: "9007199254740993" }, async (token, repository) => {
        await Promise.resolve();
        observed.token = token;
        observed.repositoryId = repository.repositoryId;
        return repository.cleanHttpsUrl;
      });
      expect(result.value).toBe("https://github.com/org/private-repo.git");
    });
    expect(observed.body).toBe('{"repository_ids":[9007199254740993],"permissions":{"contents":"read"}}');
    expect(observed.token).toBe("private-canary");
    expect(observed.repositoryId).toBe("9007199254740993");
  });

  it.each([
    ["missing repository authority", '{"token":"private-canary","expires_at":"2026-08-04T13:00:00.000Z","permissions":{"contents":"read"},"repository_selection":"selected","repositories":[]}'],
    ["foreign repository authority", '{"token":"private-canary","expires_at":"2026-08-04T13:00:00.000Z","permissions":{"contents":"read"},"repository_selection":"selected","repositories":[{"id":4,"owner":{"login":"org"},"name":"foreign","full_name":"org/foreign","default_branch":"main","private":true,"archived":false,"disabled":false,"permissions":{"admin":false,"push":false,"pull":true}}]}'],
    ["ambiguous repository authority", '{"token":"private-canary","expires_at":"2026-08-04T13:00:00.000Z","permissions":{"contents":"read"},"repository_selection":"selected","repositories":[{"id":9007199254740993,"owner":{"login":"org"},"name":"private-repo","full_name":"org/private-repo","default_branch":"main","private":true,"archived":false,"disabled":false,"permissions":{"admin":false,"push":false,"pull":true}},{"id":9007199254740993,"owner":{"login":"org"},"name":"private-repo","full_name":"org/private-repo","default_branch":"main","private":true,"archived":false,"disabled":false,"permissions":{"admin":false,"push":false,"pull":true}}]}']
  ])("rejects %s from an exact token response", async (_label, tokenResponse) => {
    const { stateRoot } = await fixture();
    await withFetch(async (input) => {
      await Promise.resolve();
      const pathname = fetchInputUrl(input).pathname;
      if (pathname === "/app") return new Response('{"id":123}', { status: 200 });
      if (pathname === "/app/installations/77") return new Response('{"id":77,"app_id":123,"repository_selection":"selected","suspended_at":null,"account":{"id":9007199254740993,"login":"org","type":"Organization"},"permissions":{"metadata":"read","contents":"read"}}', { status: 200 });
      if (pathname === "/app/installations/77/access_tokens") return new Response(tokenResponse, { status: 201 });
      if (pathname === "/installation/token") return new Response(null, { status: 204 });
      throw new Error(`unexpected path ${pathname}`);
    }, async () => {
      const authority = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:00:00.000Z") });
      await bind(authority);
      await expect(authority.withExactRepositoryToken({ connectionId, repositoryId: "9007199254740993" }, () => Promise.resolve(undefined)))
        .rejects.toThrow("github-repository-not-authorized");
    });
  });

  it("rejects a removed or unselected repository before Git token delivery", async () => {
    const { stateRoot } = await fixture();
    const calls: GithubHttpRequest[] = [];
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      calls.push(request);
      if (request.path === "/app") return { status: 200, body: { id: 123 } };
      if (request.path === "/app/installations/77") return { status: 200, body: { id: 77, app_id: 123, repository_selection: "selected", suspended_at: null,
        account: { id: 9007199254740993n, login: "org", type: "Organization" }, permissions: { metadata: "read", contents: "read" } } };
      if (request.path.endsWith("/access_tokens")) return { status: 201, body: { token: "metadata-canary", expires_at: "2026-08-04T13:00:00.000Z" } };
      if (request.path.startsWith("/installation/repositories?")) return { status: 200, body: { repositories: [] } };
      if (request.path === "/installation/token") return { status: 204, body: {} };
      return { status: 500, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:00:00.000Z") });
    await bind(authority);
    await expect(authority.resolveRepository({ connectionId, repositoryId: "9007199254740993" }))
      .rejects.toThrow("github-repository-not-authorized");
    const mint = calls.find(({ path }) => path.endsWith("/access_tokens"));
    expect(mint?.body).toEqual({ permissions: { metadata: "read" } });
  });

  it("resolves an immutable repository ID across bounded installation-repository pages", async () => {
    const { stateRoot } = await fixture();
    const targetId = "9007199254740993";
    const pageOne = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, owner: { login: "org" }, name: `repo-${index + 1}`,
      full_name: `org/repo-${index + 1}`, default_branch: "main", private: true, archived: false, disabled: false }));
    const calls: string[] = [];
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve(); calls.push(request.path);
      if (request.path === "/app") return { status: 200, body: { id: 123 } };
      if (request.path === "/app/installations/77") return { status: 200, body: { id: 77, app_id: 123, repository_selection: "selected", suspended_at: null,
        account: { id: 9007199254740993n, login: "org", type: "Organization" }, permissions: { metadata: "read", contents: "read" } } };
      if (request.path.endsWith("/access_tokens")) return { status: 201, body: { token: "metadata-canary", expires_at: "2026-08-04T13:00:00.000Z" } };
      if (request.path.endsWith("page=1")) return { status: 200, body: { repositories: pageOne } };
      if (request.path.endsWith("page=2")) return { status: 200, body: { repositories: [{ id: 9007199254740993n, owner: { login: "org" }, name: "renamed-repo",
        full_name: "org/renamed-repo", default_branch: "main", private: true, archived: false, disabled: false }] } };
      if (request.path === "/installation/token") return { status: 204, body: {} };
      return { status: 500, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:00:00.000Z") });
    await bind(authority);
    const resolved = await authority.resolveRepository({ connectionId, repositoryId: targetId });
    expect(resolved.repository.repositoryId).toBe(targetId);
    expect(resolved.repository.cleanHttpsUrl).toBe("https://github.com/org/renamed-repo.git");
    expect(calls).toContain("/installation/repositories?per_page=100&page=2");
  });

  it("classifies an exact-token selection rejection as repository-not-authorized", async () => {
    const { stateRoot } = await fixture();
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      return request.path === "/app"
        ? { status: 200, body: { id: 123 } }
        : request.path === "/app/installations/77"
          ? { status: 200, body: { id: 77, app_id: 123, repository_selection: "selected", suspended_at: null,
            account: { id: 9007199254740993n, login: "org", type: "Organization" }, permissions: { metadata: "read", contents: "read" } } }
          : request.path.endsWith("/access_tokens")
            ? { status: 422, body: { message: "repository is not selected" } }
            : { status: 500, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport });
    await bind(authority);
    await expect(authority.withExactRepositoryToken({ connectionId, repositoryId: "9007199254740993" }, () => Promise.resolve(undefined)))
      .rejects.toThrow("github-repository-not-authorized");
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
      await expect(authority.verifyInstallation({ connectionId: "018f0d84-7b39-7cc3-9d4a-0675d9162a11", installationId: "77" }))
        .rejects.toThrow(variant.suspended_at === null ? "github-authority-invalid" : "github-installation-unavailable");
    }
  });

  it("reports a removed installation as unavailable during live refresh", async () => {
    const { stateRoot } = await fixture();
    const authority = await createGithubAppAuthority({ stateRoot, transport: async ({ path }) => {
      await Promise.resolve();
      return path === "/app"
        ? { status: 200, body: { id: 123 } }
        : { status: 404, body: { message: "Not Found" } };
    } });
    await bind(authority);
    await expect(authority.refreshInstallation({ connectionId })).rejects.toThrow("github-installation-unavailable");
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

  it("rejects private records whose filename identity differs from the embedded connection", async () => {
    const { stateRoot, appRoot } = await fixture();
    const foreignConnectionId = "018f0d84-7b39-7cc3-9d4a-0675d9162a12";
    const binding = { version: 1, connectionId, installationId: "77", accountId: "9007199254740993", accountType: "Organization", accountLogin: "org", repositorySelection: "all", permissions: { metadata: "read" }, status: "connected", verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: false };
    await mkdir(path.join(appRoot, "installations"), { mode: 0o700, recursive: true });
    await writeFile(path.join(appRoot, "installations", `${foreignConnectionId}.json`), JSON.stringify(binding), { mode: 0o600 });
    await expect(createGithubAppAuthority({ stateRoot })).rejects.toThrow("github-private-state-invalid");
  });

  it("rejects a token lease whose filename identity differs from its embedded connection at startup", async () => {
    const { stateRoot, appRoot } = await fixture();
    const foreignConnectionId = "018f0d84-7b39-7cc3-9d4a-0675d9162a12";
    await mkdir(path.join(appRoot, "token-leases"), { mode: 0o700, recursive: true });
    await writeFile(path.join(appRoot, "token-leases", `${connectionId}.json`), JSON.stringify({ version: 1, connectionId: foreignConnectionId, operationId: "018f0d84-7b39-7cc3-9d4a-0675d9162a13", expiresAt: "2026-08-04T13:00:00.000Z", phase: "active", createdAt: "2026-08-04T12:00:00.000Z" }), { mode: 0o600 });
    await expect(createGithubAppAuthority({ stateRoot })).rejects.toThrow("github-private-state-invalid");
  });

  it("rejects a 36-character non-UUIDv7 private filename at startup", async () => {
    const { stateRoot, appRoot } = await fixture();
    const malformedConnectionId = "018f0d84-7b39-4cc3-9d4a-0675d9162a11";
    const binding = { version: 1, connectionId, installationId: "77", accountId: "9007199254740993", accountType: "Organization", accountLogin: "org", repositorySelection: "all", permissions: { metadata: "read" }, status: "connected", verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: false };
    await mkdir(path.join(appRoot, "installations"), { mode: 0o700, recursive: true });
    await writeFile(path.join(appRoot, "installations", `${malformedConnectionId}.json`), JSON.stringify(binding), { mode: 0o600 });
    await expect(createGithubAppAuthority({ stateRoot })).rejects.toThrow("github-private-state-invalid");
  });

  it("fails runtime inspection closed when a binding is replaced with a foreign record", async () => {
    const { stateRoot, appRoot } = await fixture();
    const authority = await createGithubAppAuthority({ stateRoot });
    const foreignConnectionId = "018f0d84-7b39-7cc3-9d4a-0675d9162a12";
    const binding = { version: 1, connectionId: foreignConnectionId, installationId: "77", accountId: "9007199254740993", accountType: "Organization", accountLogin: "org", repositorySelection: "all", permissions: { metadata: "read" }, status: "connected", verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: false };
    await mkdir(path.join(appRoot, "installations"), { mode: 0o700, recursive: true });
    await writeFile(path.join(appRoot, "installations", `${connectionId}.json`), JSON.stringify(binding), { mode: 0o600 });
    await expect(authority.inspectInstallation(connectionId)).rejects.toThrow("github-private-state-invalid");
  });

  it("rejects a foreign binding before repository listing can make a GitHub request", async () => {
    const { stateRoot, appRoot } = await fixture();
    const calls: GithubHttpRequest[] = [];
    const authority = await createGithubAppAuthority({ stateRoot, transport: (request) => { calls.push(request); return Promise.resolve({ status: 500, body: {} }); } });
    const foreignConnectionId = "018f0d84-7b39-7cc3-9d4a-0675d9162a12";
    const binding = { version: 1, connectionId: foreignConnectionId, installationId: "77", accountId: "9007199254740993", accountType: "Organization", accountLogin: "org", repositorySelection: "all", permissions: { metadata: "read" }, status: "connected", verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: false };
    await mkdir(path.join(appRoot, "installations"), { mode: 0o700, recursive: true });
    await writeFile(path.join(appRoot, "installations", `${connectionId}.json`), JSON.stringify(binding), { mode: 0o600 });
    await expect(authority.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-private-state-invalid");
    expect(calls).toHaveLength(0);
  });

  it("rejects a foreign lease before repository listing can make a GitHub request", async () => {
    const { stateRoot, appRoot } = await fixture();
    const calls: GithubHttpRequest[] = [];
    const authority = await createGithubAppAuthority({ stateRoot, transport: (request) => { calls.push(request); return Promise.resolve({ status: 500, body: {} }); } });
    await bind(authority);
    const foreignConnectionId = "018f0d84-7b39-7cc3-9d4a-0675d9162a12";
    await mkdir(path.join(appRoot, "token-leases"), { mode: 0o700, recursive: true });
    await writeFile(path.join(appRoot, "token-leases", `${connectionId}.json`), JSON.stringify({ version: 1, connectionId: foreignConnectionId, operationId: "018f0d84-7b39-7cc3-9d4a-0675d9162a13", expiresAt: "2026-08-04T13:00:00.000Z", phase: "active", createdAt: "2026-08-04T12:00:00.000Z" }), { mode: 0o600 });
    await expect(authority.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-private-state-invalid");
    expect(calls).toHaveLength(0);
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
    const inspection = await authority.inspectInstallation(connectionId);
    expect(inspection.status).toBe("degraded");
    expect(inspection.cleanupDegraded).toBe(true);
    expect(await readFile(path.join(appRoot, "token-leases", `${connectionId}.json`), "utf8")).toContain('"phase":"cleanup-degraded"');
    const restarted = await createGithubAppAuthority({ stateRoot, transport, writer, now: () => new Date("2026-08-04T12:30:00.000Z") });
    const restartedInspection = await restarted.inspectInstallation(connectionId);
    expect(restartedInspection.status).toBe("degraded");
    expect(restartedInspection.cleanupDegraded).toBe(true);
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
    expect((await recovered.inspectInstallation(connectionId)).status).toBe("degraded");
    expect((await recovered.listRepositories({ connectionId, pageSize: 20 })).cleanupDegraded).toBe(false);
    expect((await recovered.inspectInstallation(connectionId)).status).toBe("connected");
  });

  it("does not project a safely owned in-process lease as permanent degraded health", async () => {
    const { stateRoot } = await fixture();
    let releaseListing!: () => void;
    let markListingStarted!: () => void;
    const listingStarted = new Promise<void>((resolve) => { markListingStarted = resolve; });
    const listingHeld = new Promise<void>((resolve) => { releaseListing = resolve; });
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      if (request.path.endsWith("/access_tokens")) return { status: 201, body: { token: "owned-operation-secret", expires_at: "2026-08-04T13:00:00.000Z" } };
      if (request.path.startsWith("/installation/repositories?")) {
        markListingStarted();
        await listingHeld;
        return { status: 200, body: { repositories: [] } };
      }
      if (request.path === "/installation/token") return { status: 204, body: {} };
      return { status: 500, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, now: () => new Date("2026-08-04T12:00:00.000Z") });
    await bind(authority);
    const listing = authority.listRepositories({ connectionId, pageSize: 20 });
    await listingStarted;
    expect((await authority.inspectInstallation(connectionId)).status).toBe("connected");
    releaseListing();
    await listing;
  });

  it("rejects an oversized Content-Length before retaining the mint response and cancels it", async () => {
    const { stateRoot } = await fixture();
    const oversized = streamedResponse([Buffer.from('{"token":"bounded-secret"}')], 201, { "content-length": String(512 * 1024 + 1) });
    const fetchImpl: typeof fetch = () => Promise.resolve(oversized.response);
    await withFetch(fetchImpl, async () => {
      const authority = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:00:00.000Z") });
      await bind(authority);
      await expect(authority.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-mint-failed");
      expect(await readFile(path.join(stateRoot, "github-app", "token-leases", `${connectionId}.json`), "utf8")).not.toContain("bounded-secret");
      const restarted = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:30:00.000Z") });
      await expect(restarted.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-lease-active");
    });
    expect(oversized.wasCancelled()).toBe(true);
  });

  it("rejects malformed or conflicting Content-Length conservatively", async () => {
    const { stateRoot } = await fixture();
    const malformed = streamedResponse([Buffer.from('{"token":"header-secret"}')], 201, { "content-length": "10, 10" });
    await withFetch(() => Promise.resolve(malformed.response), async () => {
      const authority = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:00:00.000Z") });
      await bind(authority);
      await expect(authority.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-mint-failed");
    });
    expect(malformed.wasCancelled()).toBe(true);
  });

  it("cancels a chunked mint response when cumulative bytes cross the bound", async () => {
    const { stateRoot } = await fixture();
    const oversized = streamedResponse([Buffer.alloc(512 * 1024 - 1, 0x20), Buffer.from("xx")], 201);
    await withFetch(() => Promise.resolve(oversized.response), async () => {
      const authority = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:00:00.000Z") });
      await bind(authority);
      await expect(authority.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-mint-failed");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(oversized.wasCancelled()).toBe(true);
  });

  it("accepts an exact byte-limit repository response", async () => {
    const { stateRoot } = await fixture();
    const repositoryJson = JSON.stringify({ repositories: [] });
    const exact = `${repositoryJson}${" ".repeat(512 * 1024 - Buffer.byteLength(repositoryJson))}`;
    const fetchImpl: typeof fetch = async (input) => {
      await Promise.resolve();
      const pathname = fetchInputUrl(input).pathname;
      if (pathname.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "exact-limit-secret", expires_at: "2026-08-04T13:00:00.000Z" }), { status: 201 });
      if (pathname === "/installation/repositories") return new Response(exact, { status: 200, headers: { "content-length": String(Buffer.byteLength(exact)) } });
      if (pathname === "/installation/token") return new Response(null, { status: 204 });
      return new Response("", { status: 500 });
    };
    await withFetch(fetchImpl, async () => {
      const authority = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:00:00.000Z") });
      await bind(authority);
      await expect(authority.listRepositories({ connectionId, pageSize: 20 })).resolves.toMatchObject({ repositories: [], cleanupDegraded: false });
    });
  });

  it("accepts a gzip repository response whose decoded length differs from encoded Content-Length", async () => {
    const { stateRoot } = await fixture();
    const requests: Array<{ path: string; acceptEncoding: string | undefined }> = [];
    let lengths: { encodedLength: number; decodedLength: number } | undefined;
    await withLocalGithubFetch((request, response) => {
      const requestPath = request.url ?? "";
      requests.push({ path: requestPath, acceptEncoding: request.headers["accept-encoding"] });
      if (requestPath.endsWith("/access_tokens")) {
        const body = Buffer.from(JSON.stringify({ token: "gzip-repository-secret", expires_at: "2026-08-04T13:00:00.000Z" }));
        response.writeHead(201, { "content-type": "application/json", "content-length": String(body.byteLength) });
        response.end(body);
      } else if (requestPath.startsWith("/installation/repositories?")) {
        lengths = gzipJson(response, { repositories: [] }, 200);
      } else {
        response.writeHead(204);
        response.end();
      }
    }, async () => {
      const authority = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:00:00.000Z") });
      await bind(authority);
      await expect(authority.listRepositories({ connectionId, pageSize: 20 })).resolves.toMatchObject({ repositories: [], cleanupDegraded: false });
    });
    expect(lengths).toBeDefined();
    expect(lengths?.decodedLength).not.toBe(lengths?.encodedLength);
    expect(requests.map(({ path }) => path)).toEqual(["/app/installations/77/access_tokens", expect.stringContaining("/installation/repositories?"), "/installation/token"]);
    expect(requests.every(({ acceptEncoding }) => acceptEncoding === "identity")).toBe(true);
  });

  it("completes a fully compressed mint, repository listing, and revocation flow", async () => {
    const { stateRoot } = await fixture();
    const requests: Array<{ path: string; acceptEncoding: string | undefined }> = [];
    await withLocalGithubFetch((request, response) => {
      const requestPath = request.url ?? "";
      requests.push({ path: requestPath, acceptEncoding: request.headers["accept-encoding"] });
      if (requestPath.endsWith("/access_tokens")) gzipJson(response, { token: "gzip-flow-secret", expires_at: "2026-08-04T13:00:00.000Z" }, 201);
      else if (requestPath.startsWith("/installation/repositories?")) gzipJson(response, { repositories: [] }, 200);
      else { response.writeHead(204); response.end(); }
    }, async () => {
      const authority = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:00:00.000Z") });
      await bind(authority);
      await expect(authority.listRepositories({ connectionId, pageSize: 20 })).resolves.toMatchObject({ repositories: [], cleanupDegraded: false });
    });
    expect(requests.map(({ path }) => path)).toEqual(["/app/installations/77/access_tokens", expect.stringContaining("/installation/repositories?"), "/installation/token"]);
    expect(requests.every(({ acceptEncoding }) => acceptEncoding === "identity")).toBe(true);
  });

  it("rejects a compressed decoded response beyond the bound without persisting a token", async () => {
    const { stateRoot } = await fixture();
    let lengths: { encodedLength: number; decodedLength: number } | undefined;
    await withLocalGithubFetch((request, response) => {
      if ((request.url ?? "").endsWith("/access_tokens")) {
        lengths = gzipJson(response, { token: "compressed-oversize-secret", oversized: "x".repeat(512 * 1024 + 1) }, 201);
      } else {
        response.writeHead(500);
        response.end();
      }
    }, async () => {
      const authority = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:00:00.000Z") });
      await bind(authority);
      await expect(authority.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-mint-failed");
      expect(await readFile(path.join(stateRoot, "github-app", "token-leases", `${connectionId}.json`), "utf8")).not.toContain("compressed-oversize-secret");
    });
    expect(lengths?.encodedLength).toBeLessThan(512 * 1024);
    expect(lengths?.decodedLength).toBeGreaterThan(512 * 1024);
  });

  it("retains the uncertain mint guard after a malformed gzip response and restart", async () => {
    const { stateRoot } = await fixture();
    let mintRequests = 0;
    await withLocalGithubFetch((request, response) => {
      if ((request.url ?? "").endsWith("/access_tokens")) {
        mintRequests += 1;
        const malformed = Buffer.from("not-a-gzip-stream");
        response.writeHead(201, { "content-type": "application/json", "content-encoding": "GZip", "content-length": String(malformed.byteLength) });
        response.end(malformed);
      } else {
        response.writeHead(500);
        response.end();
      }
    }, async () => {
      const authority = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:00:00.000Z") });
      await bind(authority);
      await expect(authority.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-mint-failed");
      const restarted = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:30:00.000Z") });
      await expect(restarted.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-lease-active");
    });
    expect(mintRequests).toBe(1);
    expect(await readFile(path.join(stateRoot, "github-app", "token-leases", `${connectionId}.json`), "utf8")).not.toContain("not-a-gzip-stream");
  });

  it("retains identity Content-Length mismatch detection through the local HTTP server", async () => {
    const { stateRoot } = await fixture();
    await withLocalGithubFetch((request, response) => {
      if ((request.url ?? "").endsWith("/access_tokens")) {
        const body = Buffer.from(JSON.stringify({ token: "identity-mismatch-secret", expires_at: "2026-08-04T13:00:00.000Z" }));
        response.writeHead(201, { "content-type": "application/json", "content-length": String(body.byteLength + 1), connection: "close" });
        response.end(body);
      } else {
        response.writeHead(500);
        response.end();
      }
    }, async () => {
      const authority = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:00:00.000Z") });
      await bind(authority);
      await expect(authority.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-mint-failed");
    });
    expect(await readFile(path.join(stateRoot, "github-app", "token-leases", `${connectionId}.json`), "utf8")).not.toContain("identity-mismatch-secret");
  });

  it("counts multibyte chunks by bytes and cancels before crossing the limit", async () => {
    const { stateRoot } = await fixture();
    const oversized = streamedResponse([Buffer.alloc(512 * 1024 - 1, 0x20), Buffer.from("😀")], 201);
    await withFetch(() => Promise.resolve(oversized.response), async () => {
      const authority = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:00:00.000Z") });
      await bind(authority);
      await expect(authority.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-mint-failed");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(oversized.wasCancelled()).toBe(true);
  });

  it("treats a truncated response as an uncertain mint and keeps the restart guard", async () => {
    const { stateRoot } = await fixture();
    const tokenBody = Buffer.from(JSON.stringify({ token: "truncated-secret", expires_at: "2026-08-04T13:00:00.000Z" }));
    const truncated = new Response(tokenBody, { status: 201, headers: { "content-length": String(tokenBody.byteLength + 10) } });
    await withFetch(async (input) => {
      await Promise.resolve();
      return fetchInputUrl(input).pathname.endsWith("/access_tokens") ? truncated : new Response("", { status: 500 });
    }, async () => {
      const authority = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:00:00.000Z") });
      await bind(authority);
      await expect(authority.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-mint-failed");
      expect(await readFile(path.join(stateRoot, "github-app", "token-leases", `${connectionId}.json`), "utf8")).not.toContain("truncated-secret");
      const restarted = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:30:00.000Z") });
      await expect(restarted.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-lease-active");
    });
  });

  it("rejects malformed UTF-8 in a mint response before using the candidate token", async () => {
    const { stateRoot } = await fixture();
    const malformed = new Response(Buffer.concat([Buffer.from('{"token":"secret-'), Buffer.from([0xff]), Buffer.from('","expires_at":"2026-08-04T13:00:00.000Z"}')]), { status: 201 });
    const paths: string[] = [];
    await withFetch(async (input) => {
      await Promise.resolve();
      const pathname = fetchInputUrl(input).pathname;
      paths.push(pathname);
      return pathname.endsWith("/access_tokens") ? malformed : new Response("", { status: 500 });
    }, async () => {
      const authority = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:00:00.000Z") });
      await bind(authority);
      await expect(authority.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-token-mint-failed");
    });
    expect(paths).toEqual(["/app/installations/77/access_tokens"]);
  });

  it("rejects malformed JSON from the production mint reader without exposing response content", async () => {
    const { stateRoot } = await fixture();
    const secret = "response-secret-must-not-escape";
    const malformed = new Response(`{"token":"${secret}`, { status: 201 });
    await withFetch(async () => {
      await Promise.resolve();
      return malformed;
    }, async () => {
      const authority = await createGithubAppAuthority({ stateRoot, now: () => new Date("2026-08-04T12:00:00.000Z") });
      await bind(authority);
      const error = await authority.listRepositories({ connectionId, pageSize: 20 }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("github-token-mint-failed");
      expect((error as Error).message).not.toContain(secret);
      expect(await readFile(path.join(stateRoot, "github-app", "token-leases", `${connectionId}.json`), "utf8")).not.toContain(secret);
    });
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
    const restartedAfterFailure = await createGithubAppAuthority({ stateRoot, transport, writer, now: () => new Date("2026-08-04T13:30:00.000Z") });
    expect((await restartedAfterFailure.inspectInstallation(connectionId)).status).toBe("degraded");
  });

  it("keeps a recovered connection degraded across restart when the recovery listing fails", async () => {
    const { stateRoot } = await fixture();
    let recovery = false;
    const writer: AtomicJsonWriter = {
      async write(filePath, value) {
        if (typeof value === "object" && value !== null && (value as { status?: unknown }).status === "degraded") throw new Error("degraded-binding-write-failed");
        await durableJsonWriter.write(filePath, value);
      }
    };
    const transport = async (request: GithubHttpRequest) => {
      await Promise.resolve();
      if (request.path.endsWith("/access_tokens")) return { status: 201, body: { token: "recovery-failure-secret", expires_at: recovery ? "2026-08-04T14:00:00.000Z" : "2026-08-04T13:00:00.000Z" } };
      if (request.path.startsWith("/installation/repositories?")) return recovery ? { status: 502, body: {} } : { status: 200, body: { repositories: [] } };
      if (request.path === "/installation/token") return recovery ? { status: 204, body: {} } : { status: 503, body: {} };
      return { status: 500, body: {} };
    };
    const authority = await createGithubAppAuthority({ stateRoot, transport, writer, now: () => new Date("2026-08-04T12:00:00.000Z") });
    await bind(authority);
    await authority.listRepositories({ connectionId, pageSize: 20 });
    recovery = true;
    const recovered = await createGithubAppAuthority({ stateRoot, transport, writer, now: () => new Date("2026-08-04T13:01:00.000Z") });
    await expect(recovered.listRepositories({ connectionId, pageSize: 20 })).rejects.toThrow("github-upstream-invalid");
    expect((await recovered.inspectInstallation(connectionId)).status).toBe("degraded");
    const restarted = await createGithubAppAuthority({ stateRoot, transport, writer, now: () => new Date("2026-08-04T13:30:00.000Z") });
    expect((await restarted.inspectInstallation(connectionId)).status).toBe("degraded");
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
