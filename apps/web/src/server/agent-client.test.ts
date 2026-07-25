import http from "node:http";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { AgentResponseError, createAgentClient, AgentUnavailableError } from "./agent-client.js";
import { createLogger } from "@devspace/diagnostics";
import { normalizeUserFacingFailure } from "./user-facing-failure.js";

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

test("preserves only validated safe Agent error metadata including its incident ID", async () => {
  const incidentId = "018f0f00-0000-7000-8000-000000000099";
  const service = await listen((_request, response) => {
    response.statusCode = 500;
    response.end(JSON.stringify({
      meta: { protocolVersion: 1, requestId: id, respondedAt: timestamp },
      error: {
        code: "AGENT_INTERNAL_ERROR",
        message: "The Agent operation failed safely.",
        retryable: true,
        details: { incidentId }
      }
    }));
  });
  try {
    const error = await createAgentClient(service.socketPath, { createId: () => id, now: () => new Date(timestamp) })
      .health().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentResponseError);
    expect(error).toMatchObject({
      code: "AGENT_INTERNAL_ERROR",
      message: "The Agent operation failed safely.",
      retryable: true,
      failureCategory: "internal-failure",
      incidentId
    });
    expect(error).not.toHaveProperty("details");
  } finally { await service.close(); }
});

test("keeps strict endpoint error parsing when Agent details contain an unknown field", async () => {
  const service = await listen((_request, response) => {
    response.statusCode = 500;
    response.end(JSON.stringify({
      meta: { protocolVersion: 1, requestId: id, respondedAt: timestamp },
      error: {
        code: "AGENT_INTERNAL_ERROR",
        message: "safe",
        retryable: true,
        details: { incidentId: "018f0f00-0000-7000-8000-000000000099", token: "must-not-survive" }
      }
    }));
  });
  try {
    const error = await createAgentClient(service.socketPath, { createId: () => id, now: () => new Date(timestamp) })
      .health().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INVALID_RESPONSE_CONTRACT", failureCategory: "protocol-failure" });
    expect(JSON.stringify(error)).not.toContain("must-not-survive");
  } finally { await service.close(); }
});

test("emits one terminal diagnostic for a preview transport failure", async () => {
  const logs: string[] = [];
  const client = createAgentClient(path.join(tmpdir(), `missing-preview-${id}.sock`), {
    timeoutMs: 50, createId: () => id, logger: createLogger({ component: "web", subsystem: "agent-client", environment: { DEVSPACE_LOG_LEVEL: "debug" }, sink: (line) => logs.push(line) })
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
      createId: () => id, now: () => new Date(timestamp), logger: createLogger({ component: "web", subsystem: "agent-client", environment: { DEVSPACE_LOG_LEVEL: "debug" }, sink: (line) => logs.push(line) })
    });
    await expect(client.inspectPreview(id, "018f0f00-0000-7000-8000-000000000002", "018f0f00-0000-7000-8000-000000000003", "018f0f00-0000-7000-8000-000000000004"))
      .rejects.toBeInstanceOf(AgentUnavailableError);
  } finally { await service.close(); }
  const records = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(records.map((record) => record.event)).toEqual(["web.agent_request.started", "web.agent_request.failed"]);
  expect(records[1]).toMatchObject({ requestId: id, operationName: "preview.inspect", errorCategory: "agent-protocol", errorCode: "MALFORMED_RESPONSE" });
});

test("defers a surfaced preview timeout to one fully correlated boundary incident", async () => {
  const service = await listen(() => undefined);
  const logs: string[] = [];
  const incidentId = "018f0f00-0000-7000-8000-000000000099";
  const operationId = "018f0f00-0000-7000-8000-000000000005";
  const logger = createLogger({
    component: "web", subsystem: "preview-test", environment: { DEVSPACE_LOG_LEVEL: "debug" },
    sink: (line) => logs.push(line)
  });
  try {
    const client = createAgentClient(service.socketPath, {
      timeoutMs: 20, createId: () => id, now: () => new Date(timestamp), logger,
      previewFailureDiagnostics: "deferred"
    });
    const error = await client.inspectPreview(
      id,
      "018f0f00-0000-7000-8000-000000000002",
      "018f0f00-0000-7000-8000-000000000003",
      "018f0f00-0000-7000-8000-000000000004",
      operationId
    ).catch((caught: unknown) => caught);
    const projection = normalizeUserFacingFailure(error, {
      fallbackMessage: "The preview action failed safely.",
      event: "web.preview_action.failed",
      logMessage: "User-facing preview action failed",
      logger,
      createIncidentId: () => incidentId
    });
    expect(projection).toMatchObject({ incidentId, failureCategory: "transport-failure" });
  } finally { await service.close(); }
  const terminal = logs.map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.level === "warn" || record.level === "error");
  expect(terminal).toHaveLength(1);
  expect(terminal[0]).toMatchObject({
    level: "error", event: "web.preview_action.failed", incidentId, requestId: id, operationId, projectId: id,
    workspaceId: "018f0f00-0000-7000-8000-000000000002",
    previewId: "018f0f00-0000-7000-8000-000000000004"
  });
});

test("defers an Agent-provided preview incident and preserves its identity at the boundary", async () => {
  const incidentId = "018f0f00-0000-7000-8000-000000000099";
  const service = await listen((_request, response) => {
    response.statusCode = 500;
    response.end(JSON.stringify({
      meta: { protocolVersion: 1, requestId: id, respondedAt: timestamp },
      error: {
        code: "AGENT_INTERNAL_ERROR",
        message: "private-preview-worker-label",
        retryable: true,
        details: { incidentId }
      }
    }));
  });
  const logs: string[] = [];
  const logger = createLogger({
    component: "web", subsystem: "preview-test", environment: { DEVSPACE_LOG_LEVEL: "debug" },
    sink: (line) => logs.push(line)
  });
  try {
    const client = createAgentClient(service.socketPath, {
      createId: () => id, now: () => new Date(timestamp), logger, previewFailureDiagnostics: "deferred"
    });
    const error = await client.inspectPreview(
      id,
      "018f0f00-0000-7000-8000-000000000002",
      "018f0f00-0000-7000-8000-000000000003",
      "018f0f00-0000-7000-8000-000000000004"
    ).catch((caught: unknown) => caught);
    const projection = normalizeUserFacingFailure(error, {
      fallbackMessage: "The preview action failed safely.",
      event: "web.preview_action.failed",
      logMessage: "User-facing preview action failed",
      logger,
      createIncidentId: () => {
        throw new Error("must preserve Agent incident");
      }
    });
    expect(projection).toMatchObject({
      message: "The DevSpace Agent encountered an unexpected error.",
      incidentId
    });
  } finally { await service.close(); }
  const terminal = logs.map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.level === "warn" || record.level === "error");
  expect(terminal).toHaveLength(1);
  expect(terminal[0]).toMatchObject({ event: "web.preview_action.failed", incidentId, requestId: id });
  expect(JSON.stringify({ logs })).not.toContain("private-preview-worker-label");
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
