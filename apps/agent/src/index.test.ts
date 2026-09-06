import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { agentApiV1EndpointByOperation, f10AgentApiV1EndpointByOperation, githubAgentApiV1EndpointByOperation, sourceInspectionDataSchema, type AgentExecutionFailure } from "@devspace/contracts";
import { createLogger } from "@devspace/diagnostics";
import type { PreviewGatewayAdapterContract } from "@devspace/gateway-caddy";
import { AgentExecutionError, ManagedWorkspaces } from "./managed-workspaces.js";
import type { GithubAppAuthority } from "./github-app.js";
import type { PreviewInspectionResult } from "./preview-runtime.js";
import { createAgentServer } from "./server.js";
import { parseLsRemoteOutput } from "./git-inspector.js";

const id = "018f0f00-0000-7000-8000-000000000001";
const now = new Date("2026-07-17T12:00:00.000Z");
const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function request(socketPath: string, options: { method: string; path: string; headers?: Record<string, string>; body?: string }) {
  return await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const call = http.request({ socketPath, method: options.method, path: options.path, headers: options.headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    call.on("error", reject);
    if (options.body !== undefined) call.write(options.body);
    call.end();
  });
}
async function provisionDefaultRoots(socketPath: string): Promise<void> {
  const root = path.join(path.dirname(socketPath), ".devspace-managed");
  await Promise.all(["projects", "workspaces", "state/operations"]
    .map(async (relative) => await mkdir(path.join(root, relative), { recursive: true })));
}

function startupPreviewGateway(reconcileRoutes: () => Promise<void>): PreviewGatewayAdapterContract {
  return {
    probe: () => Promise.resolve({ kind: "infrastructure", message: "not used by inactive startup fixture" }),
    ensureRoute: () => Promise.resolve(),
    replaceRoute: () => Promise.resolve(),
    removeRoute: () => Promise.resolve(),
    inspectRoute: () => Promise.resolve({ present: false, status: "absent" }),
    reconcileRoutes
  };
}

async function provisionDurableInactivePreview(socketPath: string): Promise<{ readonly roots: {
  readonly projects: string; readonly workspaces: string; readonly state: string;
}; readonly statePath: string; readonly contents: string }> {
  await provisionDefaultRoots(socketPath);
  const root = path.join(path.dirname(socketPath), ".devspace-managed");
  const roots = { projects: path.join(root, "projects"), workspaces: path.join(root, "workspaces"), state: path.join(root, "state") } as const;
  const previewId = "018f0f00-0000-7000-8000-000000000010";
  const statePath = path.join(roots.state, "previews", `${previewId}.json`);
  await mkdir(path.dirname(statePath), { recursive: true });
  const contents = `${JSON.stringify({
    version: 1, previewId, projectId: "018f0f00-0000-7000-8000-000000000005", workspaceId: "018f0f00-0000-7000-8000-000000000009", previewKey: "web",
    revisionId: "018f0f00-0000-7000-8000-000000000006", revisionHash: `sha256-jcs-v1:${"1".repeat(64)}`, runtimePlanHash: `sha256-jcs-v1:${"2".repeat(64)}`,
    generation: 1, hostname: "project-workspace-web-018f0f00.preview.example.com", domainBaseId: "local", containerPort: 3000,
    healthPath: "/health", healthStatuses: [200], startupTimeoutSeconds: 1, webSocketForwarding: true,
    leaseId: "018f0f00-0000-7000-8000-000000000011", containerId: null, desiredState: "inactive", observedState: "inactive", routePresent: false,
    attempt: 0, nextAttemptAt: 0, lastStatusCode: null, lastError: null, operationId: null
  })}\n`;
  await writeFile(statePath, contents, "utf8");
  return { roots, statePath, contents };
}
const headers = {
  "X-DevSpace-Protocol-Version": "1",
  "X-DevSpace-Request-Id": id,
  "X-DevSpace-Sent-At": now.toISOString(),
  "content-type": "application/json; charset=utf-8"
};

class ThrowingPreviewManagedWorkspaces extends ManagedWorkspaces {
  constructor(roots: ConstructorParameters<typeof ManagedWorkspaces>[0], private readonly failure: AgentExecutionFailure) {
    super(roots);
  }

  override inspectPreview(..._args: Parameters<ManagedWorkspaces["inspectPreview"]>): Promise<never> {
    return Promise.reject(new AgentExecutionError(this.failure));
  }
}

class ReturningPreviewManagedWorkspaces extends ManagedWorkspaces {
  constructor(roots: ConstructorParameters<typeof ManagedWorkspaces>[0], private readonly observation: PreviewInspectionResult) {
    super(roots);
  }

  override inspectPreview(..._args: Parameters<ManagedWorkspaces["inspectPreview"]>): Promise<PreviewInspectionResult> {
    return Promise.resolve(this.observation);
  }
}

const previewInspectBody = JSON.stringify({ data: {
  projectId: "018f0f00-0000-7000-8000-000000000005",
  workspaceId: "018f0f00-0000-7000-8000-000000000009",
  revisionId: "018f0f00-0000-7000-8000-000000000006",
  previewId: "018f0f00-0000-7000-8000-000000000010"
} });

async function previewInspectRequest(socketPath: string) {
  return await request(socketPath, { method: "POST", path: "/v1/previews/inspect", headers: {
    ...headers, "content-length": String(Buffer.byteLength(previewInspectBody))
  }, body: previewInspectBody });
}

test("serves health and source inspection through the executable Agent contracts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-test-")); temporaryDirectories.push(directory);
  const socketPath = path.join(directory, "agent.sock");
  await provisionDefaultRoots(socketPath);
  const logs: string[] = [];
  const server = createAgentServer({ socketPath, now: () => now, createId: () => id,
    logger: createLogger({ component: "agent", subsystem: "test", sink: (line) => logs.push(line) }), gitInspector: {
    inspect: () => Promise.resolve(sourceInspectionDataSchema.parse({ sourceKind: "remote", isGitRepository: true, defaultBranch: "main", headCommit: "0123456789abcdef0123456789abcdef01234567" }))
  } });
  await server.start();
  try {
    const health = await request(socketPath, { method: "GET", path: "/v1/health", headers });
    expect(health.status).toBe(200);
    expect(agentApiV1EndpointByOperation["agent.health.get"].successBodySchema.parse(health.body).data).toEqual({ status: "ok" });
    expect(JSON.parse(logs.find((line) => line.includes("agent.health.evaluated"))!)).toMatchObject({
      event: "agent.health.evaluated", requestId: id,
      healthBreakdown: { "managed-workspace-layer": "healthy", "operation-journal": "healthy", "operation-executor": "healthy", "startup-preview-reconciliation": "healthy" }
    });
    const body = JSON.stringify({ data: { source: { kind: "remote", url: "https://example.com/repo.git" } } });
    const inspected = await request(socketPath, { method: "POST", path: "/v1/projects/inspect-source", headers: {
      ...headers, "content-length": String(Buffer.byteLength(body))
    }, body });
    expect(inspected.status).toBe(200);
    expect(agentApiV1EndpointByOperation["project.source.inspect"].successBodySchema.parse(inspected.body).data.defaultBranch).toBe("main");
  } finally { await server.stop(); }
});

test("contains leaked preview inspection failures and keeps the Agent healthy", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-preview-errors-")); temporaryDirectories.push(directory);
  const socketPath = path.join(directory, "agent.sock");
  await provisionDefaultRoots(socketPath);
  const roots = { projects: path.join(directory, ".devspace-managed/projects"),
    workspaces: path.join(directory, ".devspace-managed/workspaces"), state: path.join(directory, ".devspace-managed/state") };
  const projectId = "018f0f00-0000-7000-8000-000000000005";
  const server = createAgentServer({ socketPath, managedRoots: roots,
    managedWorkspaces: new ThrowingPreviewManagedWorkspaces(roots, {
      code: "RESOURCE_STATE_CONFLICT", message: "The managed store path is not provably owned by DevSpace.", retryable: false,
      details: { resource: { type: "project", id: projectId }, action: "create" }
    }), now: () => now, createId: () => id });
  await server.start();
  try {
    const inspected = await previewInspectRequest(socketPath);
    const endpoint = agentApiV1EndpointByOperation["preview.inspect"];
    expect(inspected.status).toBe(500);
    expect(endpoint.errorSchema.parse(inspected.body)).toMatchObject({ error: {
      code: "AGENT_INTERNAL_ERROR", details: { incidentId: id }
    } });
    await expect(request(socketPath, { method: "GET", path: "/v1/health", headers })).resolves.toMatchObject({
      status: 200, body: { data: { status: "ok" } }
    });
  } finally { await server.stop(); }
});

test("logs invalid preview error shapes safely and returns the route fallback", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-preview-error-log-")); temporaryDirectories.push(directory);
  const socketPath = path.join(directory, "agent.sock");
  await provisionDefaultRoots(socketPath);
  const roots = { projects: path.join(directory, ".devspace-managed/projects"),
    workspaces: path.join(directory, ".devspace-managed/workspaces"), state: path.join(directory, ".devspace-managed/state") };
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const server = createAgentServer({ socketPath, managedRoots: roots,
    managedWorkspaces: new ThrowingPreviewManagedWorkspaces(roots, {
      code: "RESOURCE_NOT_FOUND", message: "internal-secret-must-not-be-logged", retryable: false,
      details: { resource: { type: "project", id: "not-a-uuid" } }
    } as unknown as AgentExecutionFailure), now: () => now, createId: () => id });
  await server.start();
  try {
    const inspected = await previewInspectRequest(socketPath);
    const endpoint = agentApiV1EndpointByOperation["preview.inspect"];
    expect(endpoint.errorSchema.parse(inspected.body)).toMatchObject({ error: {
      code: "AGENT_INTERNAL_ERROR", details: { incidentId: id }
    } });
    const output = logged.mock.calls.map(([value]) => String(value)).join("\n");
    expect(output).toContain("agent.error_response_schema_mismatch");
    expect(output).toContain("RESOURCE_NOT_FOUND");
    expect(output).toContain("detailKeys");
    expect(output).not.toContain("internal-secret-must-not-be-logged");
  } finally {
    logged.mockRestore();
    await server.stop();
  }
});

test("logs a safe degraded preview cause once and suppresses unchanged repeats", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-preview-diagnostics-")); temporaryDirectories.push(directory);
  const socketPath = path.join(directory, "agent.sock");
  await provisionDefaultRoots(socketPath);
  const roots = { projects: path.join(directory, ".devspace-managed/projects"),
    workspaces: path.join(directory, ".devspace-managed/workspaces"), state: path.join(directory, ".devspace-managed/state") };
  const logs: string[] = [];
  const server = createAgentServer({ socketPath, managedRoots: roots,
    managedWorkspaces: new ReturningPreviewManagedWorkspaces(roots, {
      projectId: "018f0f00-0000-7000-8000-000000000005", workspaceId: "018f0f00-0000-7000-8000-000000000009",
      previewId: "018f0f00-0000-7000-8000-000000000010", previewKey: "web", desiredState: "active", observedState: "unhealthy",
      routePresent: false, hostname: "project-workspace-web-018f0f00-preview.preview.example.com", diagnosticCode: "HEALTH_STATUS_NOT_ACCEPTED"
    }), now: () => now, createId: () => id,
    logger: createLogger({ component: "agent", subsystem: "test", environment: {}, sink: (line) => logs.push(line) }) });
  await server.start();
  try {
    const inspected = await previewInspectRequest(socketPath);
    const endpoint = agentApiV1EndpointByOperation["preview.inspect"];
    expect(inspected.status).toBe(200);
    expect(endpoint.successBodySchema.parse(inspected.body).data).not.toHaveProperty("diagnosticCode");
    await previewInspectRequest(socketPath);
    const records = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    const degraded = records.filter((record) => record.event === "agent.preview.observation.degraded");
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatchObject({ level: "warn", errorCode: "HEALTH_STATUS_NOT_ACCEPTED", projectId: "018f0f00-0000-7000-8000-000000000005" });
  } finally { await server.stop(); }
});

test("keeps persisted degraded preview diagnostics out of snapshot and public inspection responses", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-snapshot-")); temporaryDirectories.push(directory);
  const socketPath = path.join(directory, "agent.sock");
  const fixture = await provisionDurableInactivePreview(socketPath);
  const base = JSON.parse(fixture.contents) as Record<string, unknown>;
  const degraded = [
    { previewId: "018f0f00-0000-7000-8000-000000000012", observedState: "unhealthy", lastError: "health-status-not-accepted" },
    { previewId: "018f0f00-0000-7000-8000-000000000013", observedState: "failed", lastError: "The private gateway probe is unavailable." },
    { previewId: "018f0f00-0000-7000-8000-000000000014", observedState: "lost", lastError: "exact-runtime-unavailable" }
  ] as const;
  for (const state of degraded) await writeFile(path.join(fixture.roots.state, "previews", `${state.previewId}.json`), `${JSON.stringify({
    ...base, ...state, desiredState: "active", routePresent: false, containerId: null
  })}\n`, "utf8");
  const server = createAgentServer({ socketPath, managedRoots: fixture.roots, now: () => now, createId: () => id });
  await server.start();
  try {
    const snapshot = await request(socketPath, { method: "GET", path: "/v1/snapshot", headers });
    const snapshotEndpoint = f10AgentApiV1EndpointByOperation["snapshot.get"];
    expect(snapshot.status).toBe(200);
    const resources = snapshotEndpoint.successBodySchema.parse(snapshot.body).data.resources
      .filter((resource) => resource.type === "preview");
    expect(resources).toHaveLength(4);
    for (const resource of resources) expect(resource.observation).not.toHaveProperty("diagnosticCode");
  } finally { await server.stop(); }
});

test("successful startup preview reconciliation leaves Agent health healthy", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-preview-startup-")); temporaryDirectories.push(directory);
  const socketPath = path.join(directory, "agent.sock");
  const fixture = await provisionDurableInactivePreview(socketPath);
  let reconciliationCalls = 0;
  const server = createAgentServer({ socketPath, managedRoots: fixture.roots, now: () => now, createId: () => id,
    previewGateway: startupPreviewGateway(() => { reconciliationCalls += 1; return Promise.resolve(); }) });
  await server.start();
  try {
    await expect(request(socketPath, { method: "GET", path: "/v1/health", headers })).resolves.toMatchObject({ body: { data: { status: "ok" } } });
    expect(reconciliationCalls).toBe(1);
    await expect(readFile(fixture.statePath, "utf8")).resolves.toBe(fixture.contents);
  } finally { await server.stop(); }
});

test("failed startup preview reconciliation degrades health, preserves state, and recovers on a later successful start", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-preview-startup-")); temporaryDirectories.push(directory);
  const socketPath = path.join(directory, "agent.sock");
  const fixture = await provisionDurableInactivePreview(socketPath);
  let unavailable = true;
  let reconciliationCalls = 0;
  const server = createAgentServer({ socketPath, managedRoots: fixture.roots, now: () => now, createId: () => id,
    previewGateway: startupPreviewGateway(() => {
      reconciliationCalls += 1;
      if (unavailable) return Promise.reject(new Error("gateway-unavailable"));
      return Promise.resolve();
    }) });
  await server.start();
  await expect(request(socketPath, { method: "GET", path: "/v1/health", headers })).resolves.toMatchObject({ body: { data: { status: "degraded" } } });
  await expect(readFile(fixture.statePath, "utf8")).resolves.toBe(fixture.contents);

  unavailable = false;
  await server.stop();
  await server.start();
  try {
    await expect(request(socketPath, { method: "GET", path: "/v1/health", headers })).resolves.toMatchObject({ body: { data: { status: "ok" } } });
    expect(reconciliationCalls).toBe(2);
    await expect(readFile(fixture.statePath, "utf8")).resolves.toBe(fixture.contents);
  } finally { await server.stop(); }
});

test("rejects missing protocol headers and malformed source envelopes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-test-")); temporaryDirectories.push(directory);
  const socketPath = path.join(directory, "agent.sock");
  await provisionDefaultRoots(socketPath);
  const server = createAgentServer({ socketPath, now: () => now, createId: () => id, gitInspector: { inspect: () => Promise.reject(new Error("must not run")) } });
  await server.start();
  try {
    expect((await request(socketPath, { method: "GET", path: "/v1/health" })).status).toBe(400);
    const malformed = await request(socketPath, { method: "POST", path: "/v1/projects/inspect-source", headers, body: "{}" });
    expect(malformed.status).toBe(400);
    expect((malformed.body as { error: { code: string } }).error.code).toBe("REQUEST_INVALID");
  } finally { await server.stop(); }
});

test.each(["github-upstream-invalid", "github-token-mint-failed", "github-operation-failed"] as const)(
  "retains %s as the direct GitHub upstream-unavailable route category", async (message) => {
    const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-github-route-")); temporaryDirectories.push(directory);
    const socketPath = path.join(directory, "agent.sock");
    await provisionDefaultRoots(socketPath);
    const githubAuthority = { listRepositories: () => Promise.reject(new Error(message)) } as unknown as GithubAppAuthority;
    const server = createAgentServer({ socketPath, githubAuthority, now: () => now, createId: () => id });
    await server.start();
    try {
      const body = JSON.stringify({ data: { connectionId: "018f0d84-7b39-7cc3-9d4a-0675d9162a11", pageSize: 20 } });
      const response = await request(socketPath, { method: "POST", path: githubAgentApiV1EndpointByOperation["github.repositories.list"].path, headers: {
        ...headers, "content-length": String(Buffer.byteLength(body))
      }, body });
      expect(response.status).toBe(503);
      expect(githubAgentApiV1EndpointByOperation["github.repositories.list"].errorSchema.parse(response.body)).toMatchObject({ error: {
        code: "GITHUB_AUTHORITY_INVALID", retryable: false, details: { reason: "upstream-unavailable" }
      } });
    } finally { await server.stop(); }
  }
);

test("returns direct GitHub local failures as Agent internal without exposing the failure message", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ds-gh-int-")); temporaryDirectories.push(directory);
  const socketPath = path.join(directory, "agent.sock");
  await provisionDefaultRoots(socketPath);
  const secret = "private-state-writer-secret";
  const githubAuthority = { listRepositories: () => Promise.reject(new Error(secret)) } as unknown as GithubAppAuthority;
  const server = createAgentServer({ socketPath, githubAuthority, now: () => now, createId: () => id });
  await server.start();
  try {
    const body = JSON.stringify({ data: { connectionId: "018f0d84-7b39-7cc3-9d4a-0675d9162a11", pageSize: 20 } });
    const response = await request(socketPath, { method: "POST", path: githubAgentApiV1EndpointByOperation["github.repositories.list"].path, headers: {
      ...headers, "content-length": String(Buffer.byteLength(body))
    }, body });
    expect(response.status).toBe(500);
    expect(githubAgentApiV1EndpointByOperation["github.repositories.list"].errorSchema.parse(response.body)).toMatchObject({ error: {
      code: "AGENT_INTERNAL_ERROR", retryable: true, details: { incidentId: id }
    } });
    expect(JSON.stringify(response.body)).not.toContain(secret);
  } finally { await server.stop(); }
});

test("parses only HEAD, its symref branch, and its commit from bounded Git output", () => {
  expect(parseLsRemoteOutput("ref: refs/heads/main\tHEAD\n0123456789abcdef0123456789abcdef01234567\tHEAD\nabc\trefs/heads/ignored\n")).toEqual({
    sourceKind: "remote", isGitRepository: true, defaultBranch: "main", headCommit: "0123456789abcdef0123456789abcdef01234567"
  });
  expect(parseLsRemoteOutput("")).toEqual({ sourceKind: "remote", isGitRepository: true, defaultBranch: null, headCommit: null });
});
