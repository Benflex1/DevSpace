import http from "node:http";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createAgentClient, AgentUnavailableError } from "./agent-client.js";

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
