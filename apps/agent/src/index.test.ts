import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { agentApiV1EndpointByOperation, sourceInspectionDataSchema } from "@devspace/contracts";
import type { PreviewGatewayAdapterContract } from "@devspace/gateway-caddy";
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

test("serves health and source inspection through the executable Agent contracts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-test-")); temporaryDirectories.push(directory);
  const socketPath = path.join(directory, "agent.sock");
  await provisionDefaultRoots(socketPath);
  const server = createAgentServer({ socketPath, now: () => now, createId: () => id, gitInspector: {
    inspect: () => Promise.resolve(sourceInspectionDataSchema.parse({ sourceKind: "remote", isGitRepository: true, defaultBranch: "main", headCommit: "0123456789abcdef0123456789abcdef01234567" }))
  } });
  await server.start();
  try {
    const health = await request(socketPath, { method: "GET", path: "/v1/health", headers });
    expect(health.status).toBe(200);
    expect(agentApiV1EndpointByOperation["agent.health.get"].successBodySchema.parse(health.body).data).toEqual({ status: "ok" });
    const body = JSON.stringify({ data: { source: { kind: "remote", url: "https://example.com/repo.git" } } });
    const inspected = await request(socketPath, { method: "POST", path: "/v1/projects/inspect-source", headers: {
      ...headers, "content-length": String(Buffer.byteLength(body))
    }, body });
    expect(inspected.status).toBe(200);
    expect(agentApiV1EndpointByOperation["project.source.inspect"].successBodySchema.parse(inspected.body).data.defaultBranch).toBe("main");
  } finally { await server.stop(); }
});

test("successful startup preview reconciliation leaves Agent health healthy", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-preview-startup-")); temporaryDirectories.push(directory);
  const socketPath = path.join(directory, "agent.sock");
  const fixture = await provisionDurableInactivePreview(socketPath);
  let reconciliationCalls = 0;
  const server = createAgentServer({ socketPath, managedRoots: fixture.roots, now: () => now, createId: () => id,
    previewGateway: startupPreviewGateway(async () => { reconciliationCalls += 1; }) });
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
    previewGateway: startupPreviewGateway(async () => {
      reconciliationCalls += 1;
      if (unavailable) throw new Error("gateway-unavailable");
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

test("parses only HEAD, its symref branch, and its commit from bounded Git output", () => {
  expect(parseLsRemoteOutput("ref: refs/heads/main\tHEAD\n0123456789abcdef0123456789abcdef01234567\tHEAD\nabc\trefs/heads/ignored\n")).toEqual({
    sourceKind: "remote", isGitRepository: true, defaultBranch: "main", headCommit: "0123456789abcdef0123456789abcdef01234567"
  });
  expect(parseLsRemoteOutput("")).toEqual({ sourceKind: "remote", isGitRepository: true, defaultBranch: null, headCommit: null });
});
