import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { agentApiV1EndpointByOperation, sourceInspectionDataSchema } from "@devspace/contracts";
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
const headers = {
  "X-DevSpace-Protocol-Version": "1",
  "X-DevSpace-Request-Id": id,
  "X-DevSpace-Sent-At": now.toISOString(),
  "content-type": "application/json; charset=utf-8"
};

test("serves health and source inspection through the executable Agent contracts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-test-")); temporaryDirectories.push(directory);
  const socketPath = path.join(directory, "agent.sock");
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

test("rejects missing protocol headers and malformed source envelopes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-test-")); temporaryDirectories.push(directory);
  const socketPath = path.join(directory, "agent.sock");
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
