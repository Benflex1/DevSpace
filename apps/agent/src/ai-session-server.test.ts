/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createAgentServer } from "./server.js";
import { createAiSessionRuntime } from "./ai-session-runtime.js";

const projectId = "018f1f34-7000-7000-8000-000000000001";
const workspaceId = "018f1f34-7000-7000-8000-000000000002";
const sessionId = "018f1f34-7000-7000-8000-000000000003";
const turnId = "018f1f34-7000-7000-8000-000000000004";

async function call(socketPath: string, method: string, requestPath: string, data?: unknown): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const body = data === undefined ? undefined : JSON.stringify({ data });
    const request = http.request({ socketPath, method, path: requestPath, headers: {
      "X-DevSpace-Protocol-Version": "1", "X-DevSpace-Request-Id": "018f1f34-7000-7000-8000-000000000005",
      "X-DevSpace-Sent-At": "2026-07-26T05:00:00.000Z", ...(method === "POST" && !requestPath.includes("ai-profiles/inspect") && !requestPath.includes("acknowledge-events") ? { "X-DevSpace-Operation-Id": "018f1f34-7000-7000-8000-000000000006" } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
    } }, (response) => { const chunks: Buffer[] = []; response.on("data", (chunk) => chunks.push(Buffer.from(chunk))); response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })); });
    request.once("error", reject); if (body !== undefined) request.write(body); request.end();
  });
}

async function collectStream(socketPath: string, requestPath: string): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method: "GET", path: requestPath, headers: {
      "X-DevSpace-Protocol-Version": "1", "X-DevSpace-Request-Id": "018f1f34-7000-7000-8000-000000000005", "X-DevSpace-Sent-At": "2026-07-26T05:00:00.000Z"
    } }, (response) => {
      const chunks: Buffer[] = []; response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      setTimeout(() => { request.destroy(); resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }); }, 100);
    });
    request.once("error", (error) => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error); }); request.end();
  });
}

describe("F11 Agent fake provider flow", () => {
  test("inspects, starts, streams, and acknowledges the deterministic session", async () => {
    const root = await mkdtemp(join(tmpdir(), "devspace-ai-agent-")); const socketPath = join(root, "agent.sock");
    const server = createAgentServer({ socketPath, managedRoots: { projects: join(root, "projects"), workspaces: join(root, "workspaces"), state: join(root, "state") },
      aiRuntime: createAiSessionRuntime({ mode: "fake", stateRoot: join(root, "ai-state") }) });
    await server.start();
    try {
      const inspected = await call(socketPath, "POST", "/v1/ai-profiles/inspect", { projectId, workspaceId, profileId: "codex" });
      expect(inspected.status).toBe(200); const profile = JSON.parse(inspected.body).data;
      const binding = { projectId, workspaceId, aiSessionId: sessionId, revisionId: "018f1f34-7000-7000-8000-000000000007",
        runtimePlanHash: `sha256-jcs-v1:${"a".repeat(64)}`, runtimeGeneration: 1, processGeneration: 1, profileId: "codex", profileRevision: profile.profileRevision };
      const { processGeneration: _processGeneration, ...startBinding } = binding;
      expect((await call(socketPath, "POST", "/v1/ai-sessions/start", startBinding)).status).toBe(202);
      expect((await call(socketPath, "POST", "/v1/ai-sessions/send-turn", { projectId, workspaceId, aiSessionId: sessionId,
        profileId: "codex", profileRevision: profile.profileRevision, processGeneration: 1, turnId, content: { kind: "text", text: "hello" } })).status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const stream = await collectStream(socketPath, `/v1/ai-sessions/${sessionId}/events?afterSequence=0`);
      expect(stream.status).toBe(200);
      expect(stream.body).toContain("turn.output.delta"); expect(stream.body).toContain("turn.files.changed");
      const canonical = stream.body.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((frame) => frame.eventType === "turn.files.changed")!;
      const acknowledgement = { projectId, workspaceId, aiSessionId: sessionId, throughSequence: canonical.sequence as number, throughEventId: canonical.eventId as string };
      const acknowledged = await call(socketPath, "POST", "/v1/ai-sessions/acknowledge-events", acknowledgement);
      expect(acknowledged.status).toBe(200);
      expect(JSON.parse(acknowledged.body).data).toEqual(acknowledgement);
    } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
  });
});
