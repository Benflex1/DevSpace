import http from "node:http";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createAgentClient, AgentUnavailableError } from "./agent-client.js";
import { createLogger } from "@devspace/diagnostics";

const id = "018f0f00-0000-7000-8000-000000000001";
const timestamp = "2026-07-17T00:00:00.000Z";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function listen(handler: http.RequestListener): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-client-test-")); directories.push(directory);
  const socketPath = path.join(directory, "agent.sock");
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, close: async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    await unlink(socketPath).catch(() => undefined);
  } };
}

test("constructs protocol headers and parses valid success envelopes", async () => {
  const service = await listen((request, response) => {
    expect(request.headers["x-devspace-protocol-version"]).toBe("1");
    expect(request.headers["x-devspace-request-id"]).toBe(id);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ meta: { protocolVersion: 1, requestId: id, respondedAt: timestamp }, data: { status: "ok" } }));
  });
  try {
    const client = createAgentClient(service.socketPath, { createId: () => id, now: () => new Date(timestamp) });
    await expect(client.health()).resolves.toEqual({ status: "ok" });
  } finally { await service.close(); }
});

test("rejects malformed envelopes and unavailable sockets without exposing internals", async () => {
  const service = await listen((_request, response) => { response.end("{\"not\":\"an-envelope\"}"); });
  try {
    await expect(createAgentClient(service.socketPath, { createId: () => id, now: () => new Date(timestamp) }).health())
      .rejects.toBeInstanceOf(AgentUnavailableError);
  } finally { await service.close(); }
  await expect(createAgentClient(path.join(tmpdir(), `missing-${id}.sock`), { timeoutMs: 50 }).health())
    .rejects.toBeInstanceOf(AgentUnavailableError);
});

test("emits one terminal diagnostic for a preview transport failure", async () => {
  const logs: string[] = [];
  const client = createAgentClient(path.join(tmpdir(), `missing-preview-${id}.sock`), {
    timeoutMs: 50, createId: () => id, logger: createLogger({ component: "web", subsystem: "agent-client", sink: (line) => logs.push(line) })
  });
  await expect(client.inspectPreview(id, "018f0f00-0000-7000-8000-000000000002", "018f0f00-0000-7000-8000-000000000003", "018f0f00-0000-7000-8000-000000000004"))
    .rejects.toBeInstanceOf(AgentUnavailableError);
  const records = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(records.map((record) => record.event)).toEqual(["web.agent_request.started", "web.agent_request.failed"]);
  expect(records[1]).toMatchObject({ requestId: id, operationName: "preview.inspect", projectId: id,
    workspaceId: "018f0f00-0000-7000-8000-000000000002", previewId: "018f0f00-0000-7000-8000-000000000004",
    errorCategory: "agent-transport", errorCode: "AGENT_UNAVAILABLE" });
});

test("emits one terminal diagnostic for a malformed preview response", async () => {
  const service = await listen((_request, response) => { response.end("not-json"); });
  const logs: string[] = [];
  try {
    const client = createAgentClient(service.socketPath, {
      createId: () => id, now: () => new Date(timestamp), logger: createLogger({ component: "web", subsystem: "agent-client", sink: (line) => logs.push(line) })
    });
    await expect(client.inspectPreview(id, "018f0f00-0000-7000-8000-000000000002", "018f0f00-0000-7000-8000-000000000003", "018f0f00-0000-7000-8000-000000000004"))
      .rejects.toBeInstanceOf(AgentUnavailableError);
  } finally { await service.close(); }
  const records = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(records.map((record) => record.event)).toEqual(["web.agent_request.started", "web.agent_request.failed"]);
  expect(records[1]).toMatchObject({ requestId: id, operationName: "preview.inspect", errorCategory: "agent-protocol", errorCode: "MALFORMED_RESPONSE" });
});

test("sends the canonical typed preview activation fields and parses the mutation receipt", async () => {
  let requestBody = "";
  let operationHeader: string | undefined;
  const service = await listen((request, response) => {
    const header = request.headers["x-devspace-operation-id"];
    operationHeader = Array.isArray(header) ? header[0] : header;
    request.on("data", (chunk: Buffer) => { requestBody += chunk.toString("utf8"); });
    request.on("end", () => {
      response.statusCode = 202;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ meta: { protocolVersion: 1, requestId: id, respondedAt: timestamp }, data: { operationId: id } }));
    });
  });
  try {
    const client = createAgentClient(service.socketPath, { createId: () => id, now: () => new Date(timestamp) });
    await expect(client.activatePreview(id, {
      projectId: id, workspaceId: "018f0f00-0000-7000-8000-000000000002", revisionId: "018f0f00-0000-7000-8000-000000000003",
      previewId: "018f0f00-0000-7000-8000-000000000004", previewKey: "web", hostname: "alpha-primary-web-018f0f00.preview.example.com",
      projectSlug: "alpha", workspaceSlug: "primary"
    })).resolves.toEqual({ operationId: id });
    expect(operationHeader).toBe(id);
    expect(requestBody).toContain('"hostname":"alpha-primary-web-018f0f00.preview.example.com"');
    expect(requestBody).toContain('"projectSlug":"alpha"');
    expect(requestBody).toContain('"workspaceSlug":"primary"');
  } finally { await service.close(); }
});
