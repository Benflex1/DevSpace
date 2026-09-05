import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspectApp: vi.fn(), verify: vi.fn(), inspect: vi.fn(), refresh: vi.fn(), list: vi.fn()
}));
vi.mock("../../../../server/agent-client.js", () => ({ createAgentClient: () => ({
  inspectGithubApp: mocks.inspectApp, verifyGithubInstallation: mocks.verify,
  inspectGithubInstallation: mocks.inspect, refreshGithubInstallation: mocks.refresh, listGithubRepositories: mocks.list
}) }));

import { POST as begin } from "./connection-attempts/route.js";
import { GET as setup } from "./setup/route.js";
import { GET as connection } from "./connection/route.js";
import { GET as repositories } from "./repositories/route.js";
import { POST as refresh } from "./refresh/route.js";
import { getProjectDatabase } from "../../../../server/database.js";

const directories: string[] = [];
beforeEach(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-github-routes-")); directories.push(directory);
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("DEVSPACE_AUTH_MODE", "development");
  vi.stubEnv("DEVSPACE_APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("DEVSPACE_DATABASE_PATH", path.join(directory, "devspace.sqlite"));
  vi.stubEnv("DEVSPACE_AGENT_SOCKET_PATH", path.join(directory, "agent.sock"));
  mocks.inspectApp.mockResolvedValue({ configured: true, appId: "123", expectedAccountId: "99", expectedAccountType: "Organization", installationUrl: "https://github.com/apps/devspace/installations/new" });
});
afterEach(async () => { vi.clearAllMocks(); vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("GitHub Web routes", () => {
  it("initiates, verifies, projects identity, and lists without browser-supplied authority", async () => {
    const started = await begin(new Request("http://localhost:3000/api/integrations/github/connection-attempts", { method: "POST",
      headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1" } }));
    expect(started.status).toBe(201);
    const startBody = await started.json() as { connectionId: string; installationUrl: string };
    const rawState = new URL(startBody.installationUrl).searchParams.get("state"); expect(rawState).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const verified = { connectionId: startBody.connectionId, installationId: "77", accountId: "99", accountType: "Organization",
      accountLogin: "owner-org", repositorySelection: "selected", permissions: { metadata: "read" }, status: "connected",
      verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: false } as const;
    mocks.verify.mockResolvedValue(verified); mocks.inspect.mockResolvedValue(verified);
    mocks.list.mockResolvedValue({ repositories: [{ repositoryId: "88", ownerLogin: "owner-org", name: "private", fullName: "owner-org/private",
      cleanHttpsUrl: "https://github.com/owner-org/private.git", defaultBranch: "main", private: true, archived: false, disabled: false }], continuation: null, cleanupDegraded: false });
    const callback = await setup(new Request(`http://localhost:3000/api/integrations/github/setup?state=${rawState}&installation_id=77&setup_action=install`));
    expect(callback.status).toBe(303); expect(callback.headers.get("location")).toBe("http://localhost:3000/?github=connected");
    expect(mocks.verify).toHaveBeenCalledWith(startBody.connectionId, "77");
    mocks.refresh.mockResolvedValue({ ...verified, permissions: { metadata: "read", contents: "read" } });
    const refreshed = await refresh(new Request("http://localhost:3000/api/integrations/github/refresh", {
      method: "POST", headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1" }
    }));
    expect(refreshed.status).toBe(200); expect(mocks.refresh).toHaveBeenCalledWith(startBody.connectionId);
    expect((await connection(new Request("http://localhost:3000/api/integrations/github/connection"))).status).toBe(200);
    const listed = await repositories(new Request("http://localhost:3000/api/integrations/github/repositories?pageSize=25"));
    expect(listed.status).toBe(200); expect(mocks.list).toHaveBeenCalledWith(startBody.connectionId, 25, undefined);
    expect(JSON.stringify(await listed.json())).not.toContain("token");
  });

  it("rejects malformed and conflicting callback authority", async () => {
    const malformed = await setup(new Request("http://localhost:3000/api/integrations/github/setup?state=bad&installation_id=1&owner=attacker"));
    expect(malformed.headers.get("location")).toBe("http://localhost:3000/?github=failed");
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("projects an internally claimed attempt as public pending", async () => {
    const started = await begin(new Request("http://localhost:3000/api/integrations/github/connection-attempts", { method: "POST",
      headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1" } }));
    const body = await started.json() as { connectionId: string; expiresAt: string; installationUrl: string };
    const state = new URL(body.installationUrl).searchParams.get("state");
    if (state === null) throw new Error("test state missing");
    getProjectDatabase(process.env.DEVSPACE_DATABASE_PATH!).claimGithubConnectionAttempt({ actor: "local-dev@example.invalid",
      stateHash: createHash("sha256").update(state).digest("hex"), installationId: "77" });
    const response = await connection(new Request("http://localhost:3000/api/integrations/github/connection"));
    expect(response.status).toBe(200);
    const pendingBody = await response.json() as { status?: unknown };
    expect(pendingBody.status).toBe("pending");
  });

  it("reconciles an Agent binding after Web persistence fails and an exact callback retries", async () => {
    const started = await begin(new Request("http://localhost:3000/api/integrations/github/connection-attempts", { method: "POST",
      headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1" } }));
    const body = await started.json() as { connectionId: string; installationUrl: string };
    const state = new URL(body.installationUrl).searchParams.get("state");
    if (state === null) throw new Error("test state missing");
    const verified = { connectionId: body.connectionId, installationId: "77", accountId: "99", accountType: "Organization",
      accountLogin: "owner-org", repositorySelection: "selected", permissions: { metadata: "read" }, status: "connected",
      verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: false } as const;
    mocks.verify.mockResolvedValue(verified);
    const database = getProjectDatabase(process.env.DEVSPACE_DATABASE_PATH!);
    const connect = database.connectGithubInstallation.bind(database);
    let failOnce = true;
    vi.spyOn(database, "connectGithubInstallation").mockImplementation((input) => {
      if (failOnce) { failOnce = false; throw new Error("sqlite-write-failed"); }
      return connect(input);
    });
    const callbackUrl = `http://localhost:3000/api/integrations/github/setup?state=${state}&installation_id=77&setup_action=install`;
    expect((await setup(new Request(callbackUrl))).headers.get("location")).toBe("http://localhost:3000/?github=failed");
    expect((await setup(new Request(callbackUrl))).headers.get("location")).toBe("http://localhost:3000/?github=connected");
    expect(mocks.verify).toHaveBeenCalledTimes(2);
  });

  it("projects unconfigured, failed, and degraded statuses without exposing persistence states", async () => {
    mocks.inspectApp.mockResolvedValue({ configured: false, appId: null, expectedAccountId: null, expectedAccountType: null, installationUrl: null });
    const unconfigured = await connection(new Request("http://localhost:3000/api/integrations/github/connection"));
    const unconfiguredBody = await unconfigured.json() as { status?: unknown };
    expect(unconfiguredBody.status).toBe("unconfigured");
    mocks.inspectApp.mockRejectedValueOnce(new Error("agent-unavailable"));
    const failed = await connection(new Request("http://localhost:3000/api/integrations/github/connection"));
    expect(failed.status).toBe(503);
    const failedBody = await failed.json() as { status?: unknown };
    expect(failedBody.status).toBe("failed");

    mocks.inspectApp.mockResolvedValue({ configured: true, appId: "123", expectedAccountId: "99", expectedAccountType: "Organization", installationUrl: "https://github.com/apps/devspace/installations/new" });
    const started = await begin(new Request("http://localhost:3000/api/integrations/github/connection-attempts", { method: "POST",
      headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1" } }));
    const body = await started.json() as { connectionId: string; installationUrl: string };
    const state = new URL(body.installationUrl).searchParams.get("state");
    if (state === null) throw new Error("test state missing");
    const degraded = { connectionId: body.connectionId, installationId: "77", accountId: "99", accountType: "Organization",
      accountLogin: "owner-org", repositorySelection: "selected", permissions: { metadata: "read" }, status: "degraded",
      verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: true } as const;
    mocks.verify.mockResolvedValue(degraded); mocks.inspect.mockResolvedValue(degraded);
    const callback = await setup(new Request(`http://localhost:3000/api/integrations/github/setup?state=${state}&installation_id=77&setup_action=install`));
    expect(callback.headers.get("location")).toBe("http://localhost:3000/?github=degraded");
    const response = await connection(new Request("http://localhost:3000/api/integrations/github/connection"));
    expect(response.status).toBe(200);
    const degradedBody = await response.json() as { status?: unknown };
    expect(degradedBody.status).toBe("degraded");
  });
});
