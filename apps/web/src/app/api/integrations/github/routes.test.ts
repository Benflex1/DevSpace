import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockAgentResponseError extends Error {
    readonly code = "AGENT_ERROR";
    constructor() { super("agent-error"); this.name = "AgentResponseError"; }
  }
  class MockAgentUnavailableError extends Error {
    readonly code = "AGENT_UNAVAILABLE";
    constructor() { super("agent-unavailable"); this.name = "AgentUnavailableError"; }
  }
  return {
    inspectApp: vi.fn(), verify: vi.fn(), inspect: vi.fn(), refresh: vi.fn(), list: vi.fn(),
    disconnect: vi.fn(), prepareReconnect: vi.fn(), MockAgentResponseError, MockAgentUnavailableError
  };
});
vi.mock("../../../../server/agent-client.js", () => ({
  AgentResponseError: mocks.MockAgentResponseError,
  AgentUnavailableError: mocks.MockAgentUnavailableError,
  createAgentClient: () => ({
    inspectGithubApp: mocks.inspectApp, verifyGithubInstallation: mocks.verify,
    inspectGithubInstallation: mocks.inspect, refreshGithubInstallation: mocks.refresh, listGithubRepositories: mocks.list,
    disconnectGithubInstallation: mocks.disconnect, prepareGithubReconnect: mocks.prepareReconnect
  })
}));

import { POST as begin } from "./connection-attempts/route.js";
import { GET as setup } from "./setup/route.js";
import { GET as connection } from "./connection/route.js";
import { GET as repositories } from "./repositories/route.js";
import { POST as refresh } from "./refresh/route.js";
import { POST as disconnect } from "./disconnect/route.js";
import { POST as reconnect } from "./reconnect/route.js";
import { AgentUnavailableError } from "../../../../server/agent-client.js";
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

async function createDisconnectPendingConnection(): Promise<string> {
  const started = await begin(new Request("http://localhost:3000/api/integrations/github/connection-attempts", { method: "POST",
    headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1" } }));
  const body = await started.json() as { connectionId: string; installationUrl: string };
  const state = new URL(body.installationUrl).searchParams.get("state");
  if (state === null) throw new Error("test state missing");
  mocks.verify.mockResolvedValue({ connectionId: body.connectionId, installationId: "77", accountId: "99", accountType: "Organization",
    accountLogin: "owner-org", repositorySelection: "selected", permissions: { metadata: "read" }, status: "connected",
    verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: false });
  await setup(new Request(`http://localhost:3000/api/integrations/github/setup?state=${state}&installation_id=77&setup_action=install`));
  mocks.disconnect.mockResolvedValue({ connectionId: body.connectionId, lifecycleGeneration: 2,
    lifecycleState: "disconnect-pending", cleanupState: "pending", installationId: "77" });
  const response = await disconnect(new Request("http://localhost:3000/api/integrations/github/disconnect", {
    method: "POST", headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1", "content-type": "application/json" },
    body: JSON.stringify({ connectionId: body.connectionId })
  }));
  expect(response.status).toBe(202);
  expect(getProjectDatabase(process.env.DEVSPACE_DATABASE_PATH!).getGithubConnectionState("local-dev@example.invalid")?.connection)
    .toMatchObject({ lifecycleGeneration: 2, lifecycleState: "disconnect-pending", cleanupState: "pending" });
  return body.connectionId;
}

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
    expect(refreshed.status).toBe(200); expect(mocks.refresh).toHaveBeenCalledWith(startBody.connectionId, 1);
    expect((await connection(new Request("http://localhost:3000/api/integrations/github/connection"))).status).toBe(200);
    const listed = await repositories(new Request("http://localhost:3000/api/integrations/github/repositories?pageSize=25"));
    expect(listed.status).toBe(200); expect(mocks.list).toHaveBeenCalledWith(startBody.connectionId, 25, undefined, 1);
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

  it("requires CSRF for disconnect and reconnect", async () => {
    const headers = { "content-type": "application/json", origin: "http://attacker.invalid" };
    const disconnected = await disconnect(new Request("http://localhost:3000/api/integrations/github/disconnect", {
      method: "POST", headers, body: JSON.stringify({ connectionId: "018f0f00-0000-7000-8000-000000000099" })
    }));
    const reconnected = await reconnect(new Request("http://localhost:3000/api/integrations/github/reconnect", {
      method: "POST", headers, body: JSON.stringify({ connectionId: "018f0f00-0000-7000-8000-000000000099" })
    }));
    expect(disconnected.status).toBe(403); expect(reconnected.status).toBe(403);
    expect(mocks.disconnect).not.toHaveBeenCalled(); expect(mocks.prepareReconnect).not.toHaveBeenCalled();
  });

  it("fences disconnect before Agent cleanup and retains the connection identity", async () => {
    const started = await begin(new Request("http://localhost:3000/api/integrations/github/connection-attempts", { method: "POST",
      headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1" } }));
    const body = await started.json() as { connectionId: string; installationUrl: string };
    const state = new URL(body.installationUrl).searchParams.get("state");
    if (state === null) throw new Error("test state missing");
    const verified = { connectionId: body.connectionId, installationId: "77", accountId: "99", accountType: "Organization",
      accountLogin: "owner-org", repositorySelection: "selected", permissions: { metadata: "read" }, status: "connected",
      verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: false } as const;
    mocks.verify.mockResolvedValue(verified);
    await setup(new Request(`http://localhost:3000/api/integrations/github/setup?state=${state}&installation_id=77&setup_action=install`));
    mocks.disconnect.mockResolvedValue({ connectionId: body.connectionId, lifecycleGeneration: 2,
      lifecycleState: "disconnected", cleanupState: "settled", installationId: null });
    const response = await disconnect(new Request("http://localhost:3000/api/integrations/github/disconnect", {
      method: "POST", headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1", "content-type": "application/json" },
      body: JSON.stringify({ connectionId: body.connectionId })
    }));
    expect(response.status).toBe(200);
    expect(mocks.disconnect).toHaveBeenCalledWith(body.connectionId, 2);
    expect(getProjectDatabase(process.env.DEVSPACE_DATABASE_PATH!).getGithubConnectionState("local-dev@example.invalid")?.connection)
      .toMatchObject({ connectionId: body.connectionId, lifecycleGeneration: 2, lifecycleState: "disconnected", cleanupState: "settled" });
    const visible = await connection(new Request("http://localhost:3000/api/integrations/github/connection"));
    expect(visible.status).toBe(200);
    expect(await visible.json()).toMatchObject({ connectionId: body.connectionId, status: "disconnected" });
  });

  it("reconnects through a pending setup attempt while retaining the same connection ID", async () => {
    const started = await begin(new Request("http://localhost:3000/api/integrations/github/connection-attempts", { method: "POST",
      headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1" } }));
    const body = await started.json() as { connectionId: string; installationUrl: string };
    const state = new URL(body.installationUrl).searchParams.get("state");
    if (state === null) throw new Error("test state missing");
    const verified = { connectionId: body.connectionId, installationId: "77", accountId: "99", accountType: "Organization",
      accountLogin: "owner-org", repositorySelection: "selected", permissions: { metadata: "read" }, status: "connected",
      verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: false } as const;
    mocks.verify.mockResolvedValue(verified);
    await setup(new Request(`http://localhost:3000/api/integrations/github/setup?state=${state}&installation_id=77&setup_action=install`));
    mocks.prepareReconnect.mockResolvedValue({ connectionId: body.connectionId, lifecycleGeneration: 2,
      lifecycleState: "reconnect-pending", cleanupState: "settled", installationId: "77" });
    const response = await reconnect(new Request("http://localhost:3000/api/integrations/github/reconnect", {
      method: "POST", headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1", "content-type": "application/json" },
      body: JSON.stringify({ connectionId: body.connectionId })
    }));
    expect(response.status).toBe(201);
    expect(mocks.prepareReconnect).toHaveBeenCalledWith(body.connectionId, 2);
    expect(await response.json()).toMatchObject({ connectionId: body.connectionId, lifecycleGeneration: 2, status: "reconnect-pending" });
    const visible = await connection(new Request("http://localhost:3000/api/integrations/github/connection"));
    expect(await visible.json()).toMatchObject({ connectionId: body.connectionId, status: "reconnect-pending" });
  });

  it("reports Agent-unavailable cleanup as pending after the durable Web fence", async () => {
    const started = await begin(new Request("http://localhost:3000/api/integrations/github/connection-attempts", { method: "POST",
      headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1" } }));
    const body = await started.json() as { connectionId: string; installationUrl: string };
    const state = new URL(body.installationUrl).searchParams.get("state");
    if (state === null) throw new Error("test state missing");
    mocks.verify.mockResolvedValue({ connectionId: body.connectionId, installationId: "77", accountId: "99", accountType: "Organization",
      accountLogin: "owner-org", repositorySelection: "selected", permissions: { metadata: "read" }, status: "connected",
      verifiedAt: "2026-08-04T12:00:00.000Z", cleanupDegraded: false });
    await setup(new Request(`http://localhost:3000/api/integrations/github/setup?state=${state}&installation_id=77&setup_action=install`));
    mocks.disconnect.mockRejectedValue(new AgentUnavailableError());
    const response = await disconnect(new Request("http://localhost:3000/api/integrations/github/disconnect", {
      method: "POST", headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1", "content-type": "application/json" },
      body: JSON.stringify({ connectionId: body.connectionId })
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ connectionId: body.connectionId, status: "disconnect-pending", cleanupState: "pending" });
    expect(getProjectDatabase(process.env.DEVSPACE_DATABASE_PATH!).getGithubConnectionState("local-dev@example.invalid")?.connection)
      .toMatchObject({ lifecycleGeneration: 2, lifecycleState: "disconnect-pending", cleanupState: "pending" });
  });

  it("completes a pending Web disconnect from the exact settled Agent lifecycle", async () => {
    const connectionId = await createDisconnectPendingConnection();
    mocks.disconnect.mockResolvedValue({ connectionId, lifecycleGeneration: 2, lifecycleState: "disconnected",
      cleanupState: "settled", installationId: "77" });

    const response = await connection(new Request("http://localhost:3000/api/integrations/github/connection"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connectionId, lifecycleGeneration: 2, status: "disconnected", cleanupState: "settled" });
    expect(getProjectDatabase(process.env.DEVSPACE_DATABASE_PATH!).getGithubConnectionState("local-dev@example.invalid")?.connection)
      .toMatchObject({ lifecycleGeneration: 2, lifecycleState: "disconnected", cleanupState: "settled" });
    expect(mocks.disconnect).toHaveBeenLastCalledWith(connectionId, 2);
  });

  it.each([
    ["wrong Agent connection identity", (_connectionId: string) => ({ connectionId: "018f0f00-0000-7000-8000-000000000099",
      lifecycleGeneration: 2, lifecycleState: "disconnected", cleanupState: "settled", installationId: "77" })],
    ["stale Agent generation", (connectionId: string) => ({ connectionId, lifecycleGeneration: 1,
      lifecycleState: "disconnected", cleanupState: "settled", installationId: "77" })],
    ["cleanup that remains pending", (connectionId: string) => ({ connectionId, lifecycleGeneration: 2,
      lifecycleState: "disconnect-pending", cleanupState: "pending", installationId: "77" })],
    ["cleanup that is degraded", (connectionId: string) => ({ connectionId, lifecycleGeneration: 2,
      lifecycleState: "disconnected", cleanupState: "degraded", installationId: "77" })],
    ["an ambiguous response without identity", (_connectionId: string) => ({ lifecycleState: "disconnected", cleanupState: "settled" })]
  ] as const)("keeps the Web disconnect fence after %s", async (_label, makeResponse) => {
    const connectionId = await createDisconnectPendingConnection();
    mocks.disconnect.mockResolvedValue(makeResponse(connectionId));

    const response = await connection(new Request("http://localhost:3000/api/integrations/github/connection"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "disconnect-pending", lifecycleGeneration: 2, cleanupState: "pending" });
    expect(getProjectDatabase(process.env.DEVSPACE_DATABASE_PATH!).getGithubConnectionState("local-dev@example.invalid")?.connection)
      .toMatchObject({ lifecycleGeneration: 2, lifecycleState: "disconnect-pending", cleanupState: "pending" });
  });

  it("keeps the Web disconnect fence when the Agent is unavailable during GET reconciliation", async () => {
    await createDisconnectPendingConnection();
    mocks.disconnect.mockRejectedValue(new AgentUnavailableError());

    const response = await connection(new Request("http://localhost:3000/api/integrations/github/connection"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "disconnect-pending", lifecycleGeneration: 2, cleanupState: "pending" });
    expect(getProjectDatabase(process.env.DEVSPACE_DATABASE_PATH!).getGithubConnectionState("local-dev@example.invalid")?.connection)
      .toMatchObject({ lifecycleGeneration: 2, lifecycleState: "disconnect-pending", cleanupState: "pending" });
  });
});
