import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { agentEventSchema, f10AgentApiV1EndpointByOperation, type AgentEvent, type AgentSnapshotData } from "@devspace/contracts";
import { canonicalizeProjectOptionsV1, hashProjectOptionsV1, parseProjectOptionsV1 } from "@devspace/project-options";
import { ManagedWorkspaces } from "./managed-workspaces.js";
import { createAgentServer } from "./server.js";

const ids = {
  boot: "018f0f00-0000-7000-8000-000000000001",
  boot2: "018f0f00-0000-7000-8000-000000000002",
  request: "018f0f00-0000-7000-8000-000000000003",
  operation: "018f0f00-0000-7000-8000-000000000004",
  operation2: "018f0f00-0000-7000-8000-000000000007",
  project: "018f0f00-0000-7000-8000-000000000005",
  revision: "018f0f00-0000-7000-8000-000000000006",
  revision2: "018f0f00-0000-7000-8000-000000000008"
};
const timestamp = "2026-07-17T12:00:00.000Z";
const roots: string[] = [];
const servers: ReturnType<typeof createAgentServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.stop().catch(() => undefined)));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function headers(operationId?: string) {
  return { "X-DevSpace-Protocol-Version": "1", "X-DevSpace-Request-Id": ids.request,
    "X-DevSpace-Sent-At": timestamp, ...(operationId === undefined ? {} : { "X-DevSpace-Operation-Id": operationId }) };
}
async function jsonRequest(socketPath: string, method: string, requestPath: string, body?: unknown, operationId?: string) {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const request = http.request({ socketPath, method, path: requestPath, headers: {
      ...headers(operationId), ...(encoded === undefined ? {} : { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(encoded)) })
    } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve({ status: response.statusCode ?? 0, body: parsed });
      });
    });
    request.on("error", reject); if (encoded !== undefined) request.write(encoded); request.end();
  });
}
function snapshotData(body: unknown): AgentSnapshotData {
  return f10AgentApiV1EndpointByOperation["snapshot.get"].successBodySchema.parse(body).data;
}
function errorCode(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || !("error" in body)) return undefined;
  const error = body.error;
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}
async function waitForTerminal(socketPath: string): Promise<AgentSnapshotData> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const snapshot = await jsonRequest(socketPath, "GET", "/v1/snapshot");
    const data = snapshotData(snapshot.body);
    const observation = data.operationObservations.find((item) => item.operationId === ids.operation);
    if (observation?.state === "succeeded" || observation?.state === "failed") return data;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("operation did not finish");
}
async function replayEvents(socketPath: string, cursor: string, count: number): Promise<AgentEvent[]> {
  return await new Promise((resolve, reject) => {
    const events: AgentEvent[] = []; let buffered = "";
    const request = http.request({ socketPath, method: "GET", path: `/v1/events?cursor=${encodeURIComponent(cursor)}`, headers: headers() }, (response) => {
      response.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        for (;;) {
          const newline = buffered.indexOf("\n"); if (newline < 0) break;
          const parsed: unknown = JSON.parse(buffered.slice(0, newline));
          events.push(agentEventSchema.parse(parsed)); buffered = buffered.slice(newline + 1);
          if (events.length === count) { response.destroy(); request.destroy(); resolve(events); return; }
        }
      });
    });
    request.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "ECONNRESET") reject(error); });
    request.end();
  });
}
async function openLiveEvent(socketPath: string, cursor: string): Promise<{ next: Promise<AgentEvent> }> {
  return await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error("live stream headers were not received")), 1_000);
    const request = http.request({ socketPath, method: "GET", path: `/v1/events?cursor=${encodeURIComponent(cursor)}`, headers: headers() });
    request.once("response", (response) => {
      clearTimeout(timer);
      let buffered = "";
      ready({ next: new Promise((resolve) => {
        response.on("data", (chunk: Buffer) => {
          buffered += chunk.toString("utf8");
          const newline = buffered.indexOf("\n");
          if (newline < 0) return;
          const parsed: unknown = JSON.parse(buffered.slice(0, newline));
          response.destroy(); request.destroy(); resolve(agentEventSchema.parse(parsed));
        });
      }) });
    });
    request.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); if (error.code !== "ECONNRESET") reject(error); });
    request.end();
  });
}

test("mutation receipt is immediate, execution is async, F10 is truthful, and durable state survives a new boot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-async-agent-")); roots.push(root);
  const socket = path.join(root, "agent.sock");
  const managedRoots = { projects: path.join(root, "projects"), workspaces: path.join(root, "workspaces"), state: path.join(root, "state") };
  await Promise.all(Object.values(managedRoots).map(async (directory) => await mkdir(directory, { recursive: true })));
  await mkdir(path.join(managedRoots.state, "operations"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  class SlowManaged extends ManagedWorkspaces {
    override async registerRevision(data: Parameters<ManagedWorkspaces["registerRevision"]>[0]): Promise<void> {
      entered = true; await gate; await super.registerRevision(data);
    }
  }
  const managed = new SlowManaged(managedRoots);
  const server = createAgentServer({ socketPath: socket, managedRoots, managedWorkspaces: managed,
    operationJournalPath: path.join(managedRoots.state, "operations"), now: () => new Date(timestamp), createId: () => ids.boot });
  servers.push(server); await server.start();
  const options = parseProjectOptionsV1({ schemaVersion: 1, developmentEnvironment: { source: { kind: "image", imageReference: "node:24-bookworm" } } });
  const mutationBody = { data: { projectId: ids.project, revisionId: ids.revision, configuration: {
    format: "devspace.project-options/v1", hash: hashProjectOptionsV1(options), canonicalJson: canonicalizeProjectOptionsV1(options)
  } } };
  const receipt = await jsonRequest(socket, "POST", "/v1/configuration-revisions/register", mutationBody, ids.operation);
  expect(receipt).toMatchObject({ status: 202, body: { data: { operationId: ids.operation } } });
  const pending = await jsonRequest(socket, "GET", "/v1/snapshot");
  const pendingData = snapshotData(pending.body);
  expect(pendingData.throughCursor).not.toMatch(/\.0$/u);
  expect(pendingData.operationObservations).toContainEqual(expect.objectContaining({ operationId: ids.operation, state: "accepted" }));
  release();
  const terminal = await waitForTerminal(socket);
  expect(entered).toBe(true);
  expect(terminal.operationObservations).toContainEqual(expect.objectContaining({ operationId: ids.operation, state: "succeeded" }));
  const terminalSequence = Number(String(terminal.throughCursor).split(".").at(-1));
  expect(terminalSequence).toBeGreaterThan(1);
  const replay = await replayEvents(socket, `v1.${ids.boot}.0`, terminalSequence);
  expect(replay.map((event) => event.sequence)).toEqual(Array.from({ length: terminalSequence }, (_, index) => index + 1));
  const live = await openLiveEvent(socket, terminal.throughCursor);
  const secondBody = { data: { ...mutationBody.data, revisionId: ids.revision2 } };
  await expect(jsonRequest(socket, "POST", "/v1/configuration-revisions/register", secondBody, ids.operation2)).resolves.toMatchObject({ status: 202 });
  await expect(live.next).resolves.toMatchObject({ sequence: terminalSequence + 1, type: "operation.progressed", operationId: ids.operation2 });
  expect((await jsonRequest(socket, "GET", `/v1/events?cursor=v1.${ids.boot}.${terminalSequence + 1_000}`)).status).toBe(409);
  expect(errorCode((await jsonRequest(socket, "GET", `/v1/events?cursor=v1.${ids.boot2}.0`)).body)).toBe("EVENT_SNAPSHOT_REQUIRED");
  expect(errorCode((await jsonRequest(socket, "GET", "/v1/events?cursor=bad")).body)).toBe("EVENT_CURSOR_INVALID");

  await server.stop(); servers.splice(servers.indexOf(server), 1);
  const restarted = createAgentServer({ socketPath: socket, managedRoots, operationJournalPath: path.join(managedRoots.state, "operations"),
    now: () => new Date(timestamp), createId: () => ids.boot2 });
  servers.push(restarted); await restarted.start();
  const recovered = await jsonRequest(socket, "GET", "/v1/snapshot");
  const recoveredData = snapshotData(recovered.body);
  expect(recoveredData.agentBootId).toBe(ids.boot2);
  expect(recoveredData.throughCursor).toBe(`v1.${ids.boot2}.0`);
  expect(recoveredData.operationObservations).toContainEqual(expect.objectContaining({ operationId: ids.operation, state: "succeeded" }));
});

test("corrupt journal state degrades health and blocks mutation and snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-corrupt-agent-")); roots.push(root);
  const socket = path.join(root, "agent.sock"); const managedRoot = path.join(root, "managed");
  const operationRoot = path.join(managedRoot, "state/operations");
  await mkdir(operationRoot, { recursive: true });
  await Promise.all([path.join(managedRoot, "projects"), path.join(managedRoot, "workspaces")]
    .map(async (directory) => await mkdir(directory, { recursive: true })));
  await writeFile(path.join(operationRoot, `${ids.operation}.json`), "{corrupt\n", "utf8");
  const server = createAgentServer({ socketPath: socket, managedRoots: {
    projects: path.join(managedRoot, "projects"), workspaces: path.join(managedRoot, "workspaces"), state: path.join(managedRoot, "state")
  }, operationJournalPath: operationRoot, now: () => new Date(timestamp), createId: () => ids.boot });
  servers.push(server); await server.start();
  await expect(jsonRequest(socket, "GET", "/v1/health")).resolves.toMatchObject({ body: { data: { status: "degraded" } } });
  await expect(jsonRequest(socket, "GET", "/v1/snapshot")).resolves.toMatchObject({ status: 500 });
  const body = { data: { projectId: ids.project } };
  await expect(jsonRequest(socket, "POST", "/v1/projects/fetch", body, ids.operation)).resolves.toMatchObject({
    status: 503, body: { error: { code: "OPERATION_JOURNAL_UNAVAILABLE" } }
  });
});
