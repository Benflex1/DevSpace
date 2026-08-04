/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  CODEX_EXECUTABLE_SHA256,
  CODEX_NOTIFICATION_CATEGORY_REGISTRY,
  codexProfileRevisionForAuthority,
  createAiSessionRuntime
} from "./ai-session-runtime.js";
import { createCodexCredentialAuthority, type CodexCredentialAuthority } from "./codex-credential-authority.js";
import { MAX_RETAINED_OUTBOX_EVENTS, createAiSessionOutbox, outboxPathForAiSession } from "./ai-session-outbox.js";
import { canonicalAiEventSchema } from "@devspace/contracts";
import type { DockerEngineClient } from "./docker-runtime.js";
import type { WorkspaceExecutionContext } from "./managed-workspaces.js";

const projectId = "018f1f34-7000-7000-8000-000000000001";
const workspaceId = "018f1f34-7000-7000-8000-000000000002";
const sessionId = "018f1f34-7000-7000-8000-000000000003";
const turnId = "018f1f34-7000-7000-8000-000000000004";
const revisionId = "018f1f34-7000-7000-8000-000000000005";
const profileRevision = `sha256-ai-profile-v1:${"b".repeat(64)}`;
const runtimePlanHash = `sha256-project-options-v1:${"a".repeat(64)}`;
const fixtureCredentialToken = "synthetic-access-value";
const fixtureIdToken = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: "synthetic-subject" })).toString("base64url"),
  Buffer.from("synthetic-signature").toString("base64url")
].join(".");
const fixtureCredential = JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: {
  id_token: fixtureIdToken, access_token: fixtureCredentialToken, refresh_token: "synthetic-refresh-value", account_id: "synthetic-account-value"
}, last_refresh: "2026-07-29T10:00:00.000Z" });

const binding = {
  projectId, workspaceId, aiSessionId: sessionId, revisionId, runtimePlanHash,
  runtimeGeneration: 1, profileId: "codex", profileRevision
};

type JsonSchema = Record<string, any>;
type DockerExecInput = Parameters<DockerEngineClient["createExec"]>[1];

function validateFixture(value: unknown, schema: JsonSchema, root: JsonSchema): void {
  if (schema.$ref !== undefined) return validateFixture(value, root.definitions[schema.$ref.slice("#/definitions/".length)], root);
  if (schema.oneOf !== undefined) {
    let lastError: unknown;
    const matched = schema.oneOf.some((candidate: JsonSchema) => {
      try { validateFixture(value, candidate, root); return true; } catch (error) { lastError = error; return false; }
    });
    if (!matched) throw new Error(`fixture validation failed: ${String(lastError)}`);
    return;
  }
  if (schema.anyOf !== undefined) {
    let lastError: unknown;
    const matched = schema.anyOf.some((candidate: JsonSchema) => {
      try { validateFixture(value, candidate, root); return true; } catch (error) { lastError = error; return false; }
    });
    if (!matched) throw new Error(`fixture validation failed: ${String(lastError)}`);
    return;
  }
  if (schema.allOf !== undefined) for (const candidate of schema.allOf) validateFixture(value, candidate, root);
  if (schema.enum !== undefined) expect(schema.enum).toContain(value);
  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  if (types.length > 0) {
    const valid = types.some((type: string) => type === "null" ? value === null
      : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
        : type === "array" ? Array.isArray(value) : type === "string" ? typeof value === "string"
          : type === "number" ? typeof value === "number" : type === "integer" ? typeof value === "number" && Number.isInteger(value)
            : type === "boolean" && typeof value === "boolean");
    expect(valid).toBe(true);
  }
  if (schema.required !== undefined && value !== null && typeof value === "object") {
    for (const key of schema.required) expect(value).toHaveProperty(key);
  }
  if (schema.properties !== undefined && value !== null && typeof value === "object") {
    for (const [key, property] of Object.entries(schema.properties)) {
      if (key in value) validateFixture((value as Record<string, unknown>)[key], property as JsonSchema, root);
    }
  }
  if (schema.items !== undefined && Array.isArray(value)) for (const item of value) validateFixture(item, schema.items, root);
}

function dockerMux(payload: unknown): Buffer {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`);
  const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function dockerBytes(payload: Buffer, streamType = 1): Buffer {
  const header = Buffer.alloc(8); header[0] = streamType; header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function stagedReadbackBytes(bytes: Buffer): Buffer {
  const snapshot = [7n, 42n, BigInt(bytes.length), 0o100600n, 1000n, 1n, 1000n];
  const metadata = Buffer.alloc(112);
  for (const [index, value] of [...snapshot, ...snapshot].entries()) metadata.writeBigUInt64BE(value, index * 8);
  const header = Buffer.alloc(20);
  Buffer.from("DSAUTH01", "ascii").copy(header, 0);
  header.writeUInt32BE(1, 8); header.writeUInt32BE(metadata.length, 12); header.writeUInt32BE(bytes.length, 16);
  return Buffer.concat([header, metadata, bytes]);
}

type ProtocolDockerControl = {
  readonly uploadExitCodes?: Record<string, number>;
  cleanupExitCode?: number;
  providerRunning?: boolean;
  providerExitCode?: number | null;
  readonly inspectCalls?: string[];
};

function createProtocolDocker(captured: Array<Record<string, unknown>>, respond?: (request: { id?: number; method?: string }, emit: (message: unknown) => void) => void,
  control: ProtocolDockerControl = {}): {
  readonly docker: DockerEngineClient;
  readonly emit: (message: unknown) => void;
  readonly emitBytes: (bytes: Buffer) => void;
  readonly close: () => void;
  readonly uploads: Map<string, Buffer>;
  readonly control: ProtocolDockerControl;
} {
  let sequence = 0;
  let provider: Duplex | null = null;
  const uploads = new Map<string, Buffer>();
  const uploadNames = new Map<string, string>();
  const emit = (message: unknown) => provider?.push(dockerMux(message));
  const emitBytes = (bytes: Buffer) => provider?.push(bytes);
  return {
    emit,
    emitBytes,
    uploads,
    close: () => provider?.destroy(),
    docker: {
    createExec: (_containerId: string, input: DockerExecInput) => {
      const command = Array.isArray(input.command) ? input.command.join(" ") : "";
      const kind = command.includes("cat >") ? "upload" : command.includes("staged-readback-helper") ? "readback" : command.includes("rm -rf") ? "cleanup" : "provider";
      const id = `${kind}-${++sequence}`;
      captured.push({ id, input });
      if (kind === "upload") {
        const name = String((input.environment as Record<string, string>).DEVSPACE_TARGET_NAME);
        uploadNames.set(id, name);
        uploads.set(name, Buffer.alloc(0));
      }
      return Promise.resolve(id);
    },
    startExecAttached: (execId: string) => {
      if (execId.startsWith("upload-")) {
        const stream = new Duplex({ read() { /* upload output is not consumed */ }, write(chunk, _encoding, callback) {
          const name = uploadNames.get(execId)!;
          uploads.set(name, Buffer.concat([uploads.get(name) ?? Buffer.alloc(0), Buffer.from(chunk)]));
          callback();
        } });
        stream.end = function end(chunk?: Buffer) {
          if (chunk !== undefined) stream.write(chunk);
          process.nextTick(() => stream.emit("close")); return stream;
        } as typeof stream.end;
        return Promise.resolve(stream);
      }
      if (execId.startsWith("cleanup-")) {
        const stream = new Duplex({ read() { /* cleanup output is not consumed */ }, write(_chunk, _encoding, callback) { callback(); } });
        setImmediate(() => stream.emit("close"));
        return Promise.resolve(stream);
      }
      if (execId.startsWith("readback-")) {
        const auth = uploads.get("auth.json") ?? Buffer.alloc(0);
        const stream = new Duplex({ read() { /* readback output is pushed below */ }, write(_chunk, _encoding, callback) { callback(); } });
        process.nextTick(() => { stream.push(dockerBytes(stagedReadbackBytes(auth))); setImmediate(() => stream.emit("close")); });
        return Promise.resolve(stream);
      }
      let lineBuffer = "";
      const stream = provider = new Duplex({
        read() { /* responses are pushed after each request */ },
        write(chunk, _encoding, callback) {
          lineBuffer += chunk.toString();
          let newline = lineBuffer.indexOf("\n");
          while (newline >= 0) {
            const line = lineBuffer.slice(0, newline); lineBuffer = lineBuffer.slice(newline + 1); newline = lineBuffer.indexOf("\n");
            if (line.length === 0) continue;
            const request = JSON.parse(line) as { id?: number; method?: string };
            captured.push({ jsonRpc: request });
            if (request.id === undefined) continue;
            if (respond !== undefined) respond(request, emit);
            else {
              const result = request.method === "thread/start" ? { thread: { id: "thread-1" } }
                : request.method === "turn/start" ? { turn: { id: "turn-1" } } : {};
              setImmediate(() => emit({ id: request.id, result }));
            }
          }
          callback();
        }
      });
      return Promise.resolve(stream);
    },
    inspectExec: (execId: string) => {
      control.inspectCalls?.push(execId);
      if (execId.startsWith("upload-")) {
        const name = uploadNames.get(execId) ?? "unknown";
        return Promise.resolve({ ID: execId, Running: false, ExitCode: control.uploadExitCodes?.[name] ?? 0, ContainerID: "devspace-test-container" });
      }
      if (execId.startsWith("cleanup-")) {
        return Promise.resolve({ ID: execId, Running: false, ExitCode: control.cleanupExitCode ?? 0, ContainerID: "devspace-test-container" });
      }
      if (execId.startsWith("provider-")) {
        return Promise.resolve({ ID: execId, Running: control.providerRunning ?? false, ExitCode: control.providerRunning ? null : (control.providerExitCode ?? 0), ContainerID: "devspace-test-container" });
      }
      return Promise.resolve({ ID: execId, Running: false, ExitCode: 0, ContainerID: "devspace-test-container" });
    }
    } as unknown as DockerEngineClient,
    control
  };
}

function managedContext(stateRoot: string): WorkspaceExecutionContext {
  return {
    projectId, workspaceId, revisionId, revisionHash: runtimePlanHash, runtimePlanHash, generation: 1,
    ownership: { developmentContainer: { id: "devspace-test-container" }, worktreePath: stateRoot }, options: {}
  } as unknown as WorkspaceExecutionContext;
}

async function createCodexTestExecutable(stateRoot: string): Promise<string> {
  const executablePath = join(stateRoot, "codex-fixture");
  await writeFile(executablePath, "deterministic codex adapter fixture");
  const authority = createCodexCredentialAuthority(stateRoot);
  await mkdir(authority.authorityDir, { recursive: true, mode: 0o700 });
  await chmod(authority.authorityDir, 0o700);
  await writeFile(authority.authPath, fixtureCredential, { mode: 0o600 });
  await chmod(authority.authPath, 0o600);
  return executablePath;
}

async function flushNativeTurnStart(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function seedStoppedHistory(stateRoot: string, count: number): Promise<void> {
  await createAiSessionOutbox({ stateRoot, binding });
  const eventProfile = { profileId: "codex", profileRevision, provider: "codex" };
  const events = Array.from({ length: count }, (_, index) => canonicalAiEventSchema.parse({
    schemaVersion: "devspace.ai-event/v1",
    eventId: `018f1f34-7000-7000-8000-${(index + 100).toString().padStart(12, "0")}`,
    sessionId,
    turnId: index < count - 2 ? turnId : null,
    sequence: index + 1,
    observedAt: "2026-07-29T00:00:00.000Z",
    profile: eventProfile,
    processGeneration: 1,
    eventType: index === count - 2 ? "session.stopping" : index === count - 1 ? "session.stopped" : "turn.output.delta",
    payload: index === count - 2 ? { reason: "user-request" } : index === count - 1
      ? { reason: "user-request" } : { stream: "assistant", text: `seed-${index + 1}` }
  }));
  await writeFile(outboxPathForAiSession(stateRoot, sessionId), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
}

async function startedCodexFixture(stateRoot: string, respond?: (request: { id?: number; method?: string }, emit: (message: unknown) => void) => void) {
  const protocol = createProtocolDocker([], respond);
  const executablePath = await createCodexTestExecutable(stateRoot);
  const runtime = createAiSessionRuntime({ mode: "codex", stateRoot,
    managed: { executionContext: () => Promise.resolve(managedContext(stateRoot)) } as never,
    docker: protocol.docker, executablePath, codexPreflight: () => undefined } as never);
  const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
  await runtime.start({ ...binding, profileRevision: profile.profileRevision });
  return { protocol, runtime, profile };
}

async function startFixtureTurn(fixture: Awaited<ReturnType<typeof startedCodexFixture>>): Promise<void> {
  await fixture.runtime.sendTurn({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1, turnId,
    content: { kind: "text", text: "hello" } });
  await flushNativeTurnStart();
}

async function pinnedServerNotificationSchema(): Promise<JsonSchema> {
  return JSON.parse(await readFile(new URL("../../../packages/contracts/fixtures/codex-app-server/0.145.0/stable/ServerNotification.json", import.meta.url), "utf8")) as JsonSchema;
}

function failedTurn(error: Record<string, unknown>): Record<string, unknown> {
  return {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", items: [], status: "failed", error } }
  };
}

function errorNotification(error: Record<string, unknown>): Record<string, unknown> {
  return {
    method: "error",
    params: { threadId: "thread-1", turnId: "turn-1", willRetry: false, error }
  };
}

const privateFixtureError = {
  message: "private fixture message",
  additionalDetails: "private fixture details",
  codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 503 } }
};

describe("AI session runtime", () => {
  test("categorizes every pinned 0.145.0 server notification method exactly once", async () => {
    const schema = await pinnedServerNotificationSchema();
    const methods = (schema.oneOf as JsonSchema[]).map((candidate) =>
      ((candidate.properties as JsonSchema).method as JsonSchema).enum[0] as string
    ).sort();
    expect(Object.keys(CODEX_NOTIFICATION_CATEGORY_REGISTRY).sort()).toEqual(methods);
    expect(Object.values(CODEX_NOTIFICATION_CATEGORY_REGISTRY).every((category) => [
      "projected-and-handled", "private-lifecycle", "validated-and-ignored"
    ].includes(category))).toBe(true);
  });
  test("malformed native JSON fails the turn without escaping the stream callback", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-malformed-json-test-"));
    const protocol = createProtocolDocker([], (request, emit) => {
      const result = request.method === "thread/start" ? { thread: { id: "thread-1" } } : request.method === "turn/start" ? { turn: { id: "turn-1" } } : {};
      setImmediate(() => emit({ id: request.id, result }));
    });
    const executablePath = await createCodexTestExecutable(stateRoot);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(managedContext(stateRoot)) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await runtime.start({ ...binding, profileRevision: profile.profileRevision });
      await runtime.sendTurn({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1, turnId, content: { kind: "text", text: "hello" } });
      await flushNativeTurnStart();
      protocol.emitBytes(dockerBytes(Buffer.from("{malformed-json\n", "utf8")));
      const events = await runtime.collect(sessionId, 0, 100);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("malformed-json");
    } finally {
      await runtime.stop({ ...binding, profileRevision: (await runtime.inspect({ projectId, workspaceId, profileId: "codex" })).profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test.each([null, true, 7, "text", [], ["message"]])("rejects a JSON %s instead of treating it as a native message", async (value) => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-json-shape-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      await startFixtureTurn(fixture);
      fixture.protocol.emitBytes(dockerBytes(Buffer.from(`${JSON.stringify(value)}\n`, "utf8")));
      const events = await fixture.runtime.collect(sessionId, 0, 100);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("message");
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("rejects invalid UTF-8 and NUL-containing JSONL privately", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-utf8-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      await startFixtureTurn(fixture);
      fixture.protocol.emitBytes(dockerBytes(Buffer.from([0xc3, 0x28])));
      fixture.protocol.emitBytes(dockerBytes(Buffer.from("{\"method\":\"x\"}\u0000\n", "utf8")));
      const events = await fixture.runtime.collect(sessionId, 0, 100);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("method");
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("decodes a multibyte UTF-8 character split across Docker frames", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-split-utf8-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      await startFixtureTurn(fixture);
      const bytes = Buffer.from(`${JSON.stringify({ method: "item/agentMessage/delta", params: {
        delta: "é", itemId: "item-1", threadId: "thread-1", turnId: "turn-1"
      } })}\n`, "utf8");
      const split = bytes.indexOf(0xc3);
      fixture.protocol.emitBytes(dockerBytes(bytes.subarray(0, split + 1)));
      fixture.protocol.emitBytes(dockerBytes(bytes.subarray(split + 1)));
      const events = await fixture.runtime.collect(sessionId, 0, 100);
      expect(events.find((event) => event.eventType === "turn.output.delta")?.payload).toEqual({ stream: "assistant", text: "é" });
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("rejects an oversized Docker declaration before retaining its payload", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-frame-bound-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      await startFixtureTurn(fixture);
      const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(0xffff_ffff, 4);
      fixture.protocol.emitBytes(header);
      const events = await fixture.runtime.collect(sessionId, 0, 100);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("rejects an oversized JSONL line before newline and keeps stderr private", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-line-bound-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      await startFixtureTurn(fixture);
      fixture.protocol.emitBytes(dockerBytes(Buffer.alloc(1_115_000, 0x61)));
      const events = await fixture.runtime.collect(sessionId, 0, 100);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain('"x":"aaa');
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("rejects an oversized complete native JSON message", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-complete-message-bound-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      await startFixtureTurn(fixture);
      const payload = Buffer.concat([Buffer.from('{"x":"', "utf8"), Buffer.alloc(1_114_110, 0x61), Buffer.from('"}\n', "utf8")]);
      fixture.protocol.emitBytes(dockerBytes(payload));
      const events = await fixture.runtime.collect(sessionId, 0, 100);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain('"x":"aaa');
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("ignores Docker stderr and rejects partial framing or an unterminated JSONL line at close", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-close-framing-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      await startFixtureTurn(fixture);
      fixture.protocol.emitBytes(dockerBytes(Buffer.from("private stderr\n", "utf8"), 2));
      fixture.protocol.emitBytes(dockerBytes(Buffer.from("{}", "utf8")));
      fixture.protocol.close();
      const events = await fixture.runtime.collect(sessionId, 0, 150);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("private stderr");
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("serializes duplicate terminal notifications and rejects conflicting terminals", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-terminal-claim-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    const completion = { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], status: "completed" } } };
    try {
      await startFixtureTurn(fixture);
      fixture.protocol.emit(completion); fixture.protocol.emit(completion);
      const events = await fixture.runtime.collect(sessionId, 0, 100);
      expect(events.filter((event) => event.eventType === "turn.provider-completed")).toHaveLength(1);
      expect(events.filter((event) => event.eventType === "turn.quiesced")).toHaveLength(1);
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("conflicting duplicate terminal notifications cause one private protocol failure", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-conflicting-terminal-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      await startFixtureTurn(fixture);
      fixture.protocol.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], status: "completed" } } });
      fixture.protocol.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], status: "interrupted" } } });
      const events = await fixture.runtime.collect(sessionId, 0, 1_000);
      expect(events.filter((event) => event.eventType === "turn.provider-completed")).toHaveLength(1);
      expect(events.filter((event) => event.eventType === "session.stopping")).toHaveLength(1);
      expect(events.filter((event) => event.eventType === "session.stopped")).toHaveLength(1);
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test.each(["header", "payload"] as const)("treats a partial Docker %s as protocol failure at close", async (kind) => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-partial-frame-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      await startFixtureTurn(fixture);
      const full = dockerBytes(Buffer.from("{}", "utf8"));
      fixture.protocol.emitBytes(kind === "header" ? full.subarray(0, 4) : full.subarray(0, 9));
      fixture.protocol.close();
      const events = await fixture.runtime.collect(sessionId, 0, 150);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("an unsupported Docker stream type is a private protocol failure", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-stream-type-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      await startFixtureTurn(fixture);
      fixture.protocol.emitBytes(dockerBytes(Buffer.from("private", "utf8"), 9));
      const events = await fixture.runtime.collect(sessionId, 0, 100);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("private");
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("a terminal notification without an active native turn cannot complete a later DevSpace turn", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-no-active-terminal-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      fixture.protocol.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], status: "completed" } } });
      await fixture.runtime.collect(sessionId, 0, 100);
      await fixture.runtime.sendTurn({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1, turnId, content: { kind: "text", text: "later" } }).catch(() => undefined);
      const events = await fixture.runtime.replay(sessionId, 0);
      expect(events.filter((event) => event.eventType === "turn.provider-completed")).toHaveLength(0);
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("turn output and activity callbacks preserve native receive order", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-notification-order-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      await startFixtureTurn(fixture);
      fixture.protocol.emit({ method: "item/agentMessage/delta", params: { delta: "first", itemId: "item-1", threadId: "thread-1", turnId: "turn-1" } });
      fixture.protocol.emit({ method: "item/agentMessage/delta", params: { delta: "second", itemId: "item-2", threadId: "thread-1", turnId: "turn-1" } });
      fixture.protocol.emit({ method: "item/started", params: {
        item: { id: "item-activity", type: "agentMessage", text: "" }, startedAtMs: 1, threadId: "thread-1", turnId: "turn-1"
      } });
      const events = await fixture.runtime.collect(sessionId, 0, 100);
      const projected = events.filter((event) => event.eventType === "turn.output.delta" || event.eventType === "turn.activity.started");
      expect(projected.map((event) => event.eventType === "turn.output.delta" ? (event.payload as { text: string }).text : event.eventType)).toEqual([
        "first", "second", "turn.activity.started"
      ]);
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("rejects both-result-and-error responses without leaking either response", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-response-shape-test-"));
    const captured: Array<Record<string, unknown>> = [];
    const protocol = createProtocolDocker(captured, (request, emit) => {
      if (request.method === "turn/start") return;
      const result = request.method === "thread/start" ? { thread: { id: "thread-1" } } : {};
      setImmediate(() => emit({ id: request.id, result }));
    });
    const executablePath = await createCodexTestExecutable(stateRoot);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(managedContext(stateRoot)) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await runtime.start({ ...binding, profileRevision: profile.profileRevision });
      await runtime.sendTurn({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1, turnId, content: { kind: "text", text: "hello" } });
      await flushNativeTurnStart();
      const request = captured.find((entry) => (entry.jsonRpc as { method?: string } | undefined)?.method === "turn/start")?.jsonRpc as { id: number };
      protocol.emit({ id: request.id, result: {}, error: { code: -1, message: "private response" } });
      const events = await runtime.collect(sessionId, 0, 100);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("private response");
    } finally {
      await runtime.stop({ ...binding, profileRevision: (await runtime.inspect({ projectId, workspaceId, profileId: "codex" })).profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("unknown and duplicate response IDs do not affect the valid pending request", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-response-correlation-test-"));
    const captured: Array<Record<string, unknown>> = [];
    const protocol = createProtocolDocker(captured, (request, emit) => {
      if (request.method === "turn/start") return;
      const result = request.method === "thread/start" ? { thread: { id: "thread-1" } } : {};
      setImmediate(() => emit({ id: request.id, result }));
    });
    const executablePath = await createCodexTestExecutable(stateRoot);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(managedContext(stateRoot)) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await runtime.start({ ...binding, profileRevision: profile.profileRevision });
      await runtime.sendTurn({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1, turnId, content: { kind: "text", text: "hello" } });
      await flushNativeTurnStart();
      const request = captured.find((entry) => (entry.jsonRpc as { method?: string } | undefined)?.method === "turn/start")?.jsonRpc as { id: number };
      const response = { id: request.id, result: { turn: { id: "turn-1" } } };
      protocol.emit({ id: 999_999, result: {} }); protocol.emit(response); protocol.emit(response);
      protocol.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], status: "completed" } } });
      const events = await runtime.collect(sessionId, 0, 100);
      expect(events.filter((event) => event.eventType === "turn.provider-completed")).toHaveLength(1);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(0);
    } finally {
      await runtime.stop({ ...binding, profileRevision: (await runtime.inspect({ projectId, workspaceId, profileId: "codex" })).profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("does not project output or activity after terminal processing is claimed", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-late-notification-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      await startFixtureTurn(fixture);
      fixture.protocol.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], status: "completed" } } });
      fixture.protocol.emit({ method: "item/agentMessage/delta", params: { delta: "late-private-output", itemId: "item-1", threadId: "thread-1", turnId: "turn-1" } });
      fixture.protocol.emit({ method: "item/started", params: {
        item: { id: "item-late", type: "agentMessage", text: "" }, startedAtMs: 1, threadId: "thread-1", turnId: "turn-1"
      } });
      const events = await fixture.runtime.collect(sessionId, 0, 150);
      expect(JSON.stringify(events)).not.toContain("late-private-output");
      expect(events.filter((event) => event.eventType === "turn.provider-completed")).toHaveLength(1);
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("one unknown notification fails the protocol immediately and privately exactly once", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-unknown-notification-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      await startFixtureTurn(fixture);
      fixture.protocol.emit({ method: "pinned/unknown", params: { rawSecret: "must-remain-private" } });
      fixture.protocol.emit({ method: "another/unknown", params: { rawSecret: "must-remain-private" } });
      const events = await fixture.runtime.collect(sessionId, 0, 150);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("must-remain-private");
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("rejects a malformed intentionally ignored pinned notification", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-malformed-ignored-notification-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      await startFixtureTurn(fixture);
      fixture.protocol.emit({ method: "thread/status/changed", params: { threadId: "thread-1" } });
      const events = await fixture.runtime.collect(sessionId, 0, 150);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("rejects a malformed projected pinned notification", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-malformed-handled-notification-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      await startFixtureTurn(fixture);
      fixture.protocol.emit({ method: "item/agentMessage/delta", params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: 42
      } });
      const events = await fixture.runtime.collect(sessionId, 0, 150);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("applies pinned additionalProperties rules inside handled notifications", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-notification-extra-field-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      await startFixtureTurn(fixture);
      fixture.protocol.emit({ method: "error", params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: {
          message: "private provider error",
          codexErrorInfo: {
            responseStreamConnectionFailed: { httpStatusCode: 503 },
            unexpectedVariant: {}
          }
        }
      } });
      const events = await fixture.runtime.collect(sessionId, 0, 150);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("private provider error");
      expect(JSON.stringify(events)).not.toContain("unexpectedVariant");
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("accepts representative ignored thread, item, and token-usage notifications without projection", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-valid-ignored-notification-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 };
    try {
      await startFixtureTurn(fixture);
      fixture.protocol.emit({ method: "thread/status/changed", params: { threadId: "thread-1", status: { type: "idle" } } });
      fixture.protocol.emit({ method: "item/plan/delta", params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "private-item-id", delta: "private-plan-content"
      } });
      fixture.protocol.emit({ method: "thread/tokenUsage/updated", params: {
        threadId: "thread-1", turnId: "turn-1", tokenUsage: { last: usage, total: usage, modelContextWindow: 128_000 }
      } });
      fixture.protocol.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], status: "completed" } } });
      const events = await fixture.runtime.collect(sessionId, 0, 200);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(0);
      expect(events.filter((event) => event.eventType === "turn.provider-completed")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("private-item-id");
      expect(JSON.stringify(events)).not.toContain("private-plan-content");
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("fails closed when the native notification queue is exhausted", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-queue-bound-test-"));
    const fixture = await startedCodexFixture(stateRoot);
    try {
      await startFixtureTurn(fixture);
      for (let index = 0; index < 257; index += 1) fixture.protocol.emit({
        method: "thread/status/changed",
        params: { threadId: "thread-1", status: { type: "idle" } }
      });
      const events = await fixture.runtime.collect(sessionId, 0, 150);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
    } finally {
      await fixture.runtime.stop({ ...binding, profileRevision: fixture.profile.profileRevision, processGeneration: 1 }).catch(() => undefined);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("fake app-server preserves ordered streaming, interrupt, and replay", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-runtime-test-"));
    const runtime = createAiSessionRuntime({ mode: "fake", stateRoot });
    try {
    expect((await runtime.inspect({ projectId, workspaceId, profileId: "codex" })).availability.state).toBe("available");
    await runtime.start(binding);
    await runtime.sendTurn({ ...binding, processGeneration: 1, turnId, content: { kind: "text", text: "hello" } });
    const first = await runtime.collect(sessionId, 0, 30);
    expect(first.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "session.started", "session.ready", "turn.accepted", "turn.started", "turn.output.delta",
      "turn.provider-completed", "turn.files.changed", "turn.quiesced"
    ]));
    expect(first.find((event) => event.eventType === "turn.output.delta")?.payload).toEqual({ stream: "assistant", text: "Hello from the deterministic provider." });
    const last = first.at(-1);
    expect(last).toBeDefined();
    const replay = await runtime.collect(sessionId, 0, 100);
    expect(replay.map((event) => event.sequence)).toEqual(first.map((event) => event.sequence));
    await runtime.sendTurn({ ...binding, processGeneration: 1, turnId: "018f1f34-7000-7000-8000-000000000006", content: { kind: "text", text: "long" } });
    await runtime.interrupt({ ...binding, turnId: "018f1f34-7000-7000-8000-000000000006", processGeneration: 1 });
      const interrupted = await runtime.collect(sessionId, last!.sequence, 250);
      expect(interrupted.some((event) => event.eventType === "turn.interrupted")).toBe(true);
      const restarted = createAiSessionRuntime({ mode: "fake", stateRoot });
      const recovered = await restarted.replay(sessionId, 0);
      expect(recovered.at(-1)?.eventType).toBe("session.lost");
      expect(recovered.at(-1)?.payload).toEqual({ code: "AGENT_RESTART" });
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("serializes Stop across admission so accepted and rejected turns have exact terminal behavior", async () => {
    for (const outcome of ["accepted", "rejected"] as const) {
      const stateRoot = await mkdtemp(join(tmpdir(), `devspace-ai-admission-stop-${outcome}-`));
      let contextCalls = 0;
      let releaseContext: (() => void) | undefined;
      const admissionContext = new Promise<void>((resolve) => { releaseContext = resolve; });
      const lifecycle: string[] = [];
      const runtime = createAiSessionRuntime({
        mode: "fake",
        stateRoot,
        managed: {
          executionContext: async () => {
            contextCalls += 1;
            if (contextCalls === 1) return managedContext(stateRoot);
            await admissionContext;
            if (outcome === "rejected") throw new Error("managed-context-unavailable");
            return managedContext(stateRoot);
          }
        } as never,
        fakeProviderTestHooks: {
          onSend: () => lifecycle.push("send"),
          onStop: () => lifecycle.push("stop")
        }
      });
      try {
        const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
        const exactBinding = { ...binding, profileRevision: profile.profileRevision };
        await runtime.start(exactBinding);
        const sending = runtime.sendTurn({
          ...exactBinding, processGeneration: 1, turnId, content: { kind: "text", text: "hello" }
        });
        await new Promise((resolve) => setImmediate(resolve));
        const stopping = runtime.stop({ ...exactBinding, processGeneration: 1 });
        releaseContext?.();
        const sendResult = await Promise.allSettled([sending, stopping]);
        const events = await runtime.replay(sessionId, 0);
        const turnEvents = events.filter((event) => event.turnId === turnId);
        if (outcome === "accepted") {
          expect(sendResult[0]?.status).toBe("fulfilled");
          expect(turnEvents.filter((event) => event.eventType === "turn.accepted")).toHaveLength(1);
          expect(turnEvents.filter((event) => event.eventType === "turn.quiesced" || event.eventType === "turn.failed")).toHaveLength(1);
          expect(lifecycle.indexOf("send")).toBeGreaterThanOrEqual(0);
          expect(lifecycle.indexOf("send")).toBeLessThan(lifecycle.indexOf("stop"));
        } else {
          expect(sendResult[0]?.status).toBe("rejected");
          expect(turnEvents).toEqual([]);
          expect(lifecycle).toEqual(["stop"]);
        }
        expect(events.filter((event) => event.eventType === "session.stopping")).toHaveLength(1);
        expect(events.filter((event) => event.eventType === "session.stopped")).toHaveLength(1);
      } finally {
        await rm(stateRoot, { recursive: true, force: true });
      }
    }
  });

  test.each([1, 2] as const)("resolves a beginTurn fault after append %s according to canonical acceptance", async (turnAppend) => {
    const stateRoot = await mkdtemp(join(tmpdir(), `devspace-ai-partial-begin-${turnAppend}-`));
    let appendCalls = 0;
    let failureAt = Number.MAX_SAFE_INTEGER;
    const runtime = createAiSessionRuntime({
      mode: "fake",
      stateRoot,
      outboxFaultHooks: {
        beforeAppendWrite: () => {
          appendCalls += 1;
          if (appendCalls === failureAt) throw new Error("injected-turn-append-failure");
        }
      }
    });
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      const exactBinding = { ...binding, profileRevision: profile.profileRevision };
      await runtime.start(exactBinding);
      failureAt = appendCalls + turnAppend;
      const sending = runtime.sendTurn({
        ...exactBinding, processGeneration: 1, turnId, content: { kind: "text", text: "hello" }
      });
      if (turnAppend === 1) await expect(sending).rejects.toThrow();
      else await expect(sending).resolves.toBeUndefined();
      const events = await runtime.replay(sessionId, 0);
      const turnEvents = events.filter((event) => event.turnId === turnId);
      if (turnAppend === 1) {
        expect(turnEvents).toEqual([]);
        await runtime.stop({ ...exactBinding, processGeneration: 1 });
      } else {
        expect(turnEvents.map((event) => event.eventType)).toEqual(["turn.accepted", "turn.failed"]);
        expect(events.filter((event) => event.eventType === "session.stopped")).toHaveLength(1);
      }
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ["turn.interrupted", "interrupted"],
    ["turn.provider-completed", "completed"],
    ["turn.files.changed", "completed"],
    ["turn.quiesced", "completed"],
    ["turn.failed", "failed"]
  ] as const)("retains and retries one terminal claim after a fault before %s", async (failedEventType, kind) => {
    const stateRoot = await mkdtemp(join(tmpdir(), `devspace-ai-terminal-claim-${failedEventType.replaceAll(".", "-")}-`));
    let injected = false;
    let cleanupCalls = 0;
    const runtime = createAiSessionRuntime({
      mode: "fake",
      stateRoot,
      fakeProviderTestHooks: {
        onSend: () => {
          if (kind === "failed") throw new Error("synthetic-provider-send-failure");
        },
        onStop: () => {
          cleanupCalls += 1;
        }
      },
      outboxFaultHooks: {
        beforeAppend: ({ eventType }: { eventType: string }) => {
          if (!injected && eventType === failedEventType) {
            injected = true;
            throw new Error(`synthetic-${failedEventType}-fault`);
          }
        }
      }
    } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      const exactBinding = { ...binding, profileRevision: profile.profileRevision };
      await runtime.start(exactBinding);
      await runtime.sendTurn({
        ...exactBinding,
        processGeneration: 1,
        turnId,
        content: { kind: "text", text: kind === "interrupted" ? "long" : "hello" }
      });
      if (kind === "interrupted") {
        await new Promise((resolve) => setImmediate(resolve));
        await expect(runtime.stop({ ...exactBinding, processGeneration: 1 })).rejects.toThrow();
      } else {
        for (let attempt = 0; attempt < 20 && !injected; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(injected).toBe(true);
      const beforeRetry = await runtime.replay(sessionId, 0);
      expect(beforeRetry.filter((event) => event.eventType === failedEventType)).toHaveLength(0);
      expect(beforeRetry.filter((event) => event.eventType === "session.stopping"
        || event.eventType === "session.stopped")).toHaveLength(0);
      expect(cleanupCalls).toBe(0);

      await runtime.stop({ ...exactBinding, processGeneration: 1 });

      const events = await runtime.replay(sessionId, 0);
      const terminal = events.filter((event) => event.turnId === turnId && [
        "turn.interrupted",
        "turn.provider-completed",
        "turn.files.changed",
        "turn.quiesced",
        "turn.failed"
      ].includes(event.eventType));
      const expected = kind === "failed"
        ? ["turn.failed"]
        : kind === "interrupted"
          ? ["turn.interrupted", "turn.provider-completed", "turn.files.changed", "turn.quiesced"]
          : ["turn.provider-completed", "turn.files.changed", "turn.quiesced"];
      expect(terminal.map((event) => event.eventType)).toEqual(expected);
      expect(events.filter((event) => event.eventType === "session.stopping")).toHaveLength(1);
      expect(events.filter((event) => event.eventType === "session.stopped")).toHaveLength(1);
      expect(cleanupCalls).toBe(1);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("restarts one durable session across three unique process generations", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-runtime-restart-test-"));
    let providerStarts = 0;
    let providerStops = 0;
    const runtime = createAiSessionRuntime({ mode: "fake", stateRoot, fakeProviderTestHooks: {
      onStart: () => { providerStarts += 1; },
      onStop: () => { providerStops += 1; }
    } });
    const exactProfile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
    const exactBinding = { ...binding, profileRevision: exactProfile.profileRevision };
    const secondTurnId = "018f1f34-7000-7000-8000-000000000006";
    try {
      await runtime.start(exactBinding);
      await runtime.stop({ ...exactBinding, processGeneration: 1 });

      await runtime.start(exactBinding);
      await runtime.sendTurn({ ...exactBinding, processGeneration: 2, turnId: secondTurnId,
        content: { kind: "text", text: "generation two" } });
      await runtime.collect(sessionId, 0, 30);
      await expect(runtime.sendTurn({ ...exactBinding, processGeneration: 1, turnId,
        content: { kind: "text", text: "stale" } })).rejects.toThrow("ai-identity-mismatch");
      await expect(runtime.interrupt({ ...exactBinding, processGeneration: 1, turnId: secondTurnId }))
        .rejects.toThrow("ai-identity-mismatch");
      await expect(runtime.stop({ ...exactBinding, processGeneration: 1 })).rejects.toThrow("ai-identity-mismatch");
      await runtime.stop({ ...exactBinding, processGeneration: 2 });

      await runtime.start(exactBinding);
      const events = await runtime.replay(sessionId, 0);
      expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1));
      expect(events.filter((event) => event.eventType === "session.started").map((event) => event.processGeneration)).toEqual([1, 2, 3]);
      expect(events.filter((event) => event.eventType === "session.ready").map((event) => event.processGeneration)).toEqual([1, 2, 3]);
      expect(events.filter((event) => event.eventType === "session.stopping").map((event) => event.processGeneration)).toEqual([1, 2]);
      expect(events.filter((event) => event.eventType === "session.stopped").map((event) => event.processGeneration)).toEqual([1, 2]);
      expect(events.filter((event) => event.turnId === secondTurnId).every((event) => event.processGeneration === 2)).toBe(true);
      await runtime.stop({ ...exactBinding, processGeneration: 3 });
      expect(providerStarts).toBe(3);
      expect(providerStops).toBe(3);
      const finalized = await runtime.replay(sessionId, 0);
      for (const generation of [1, 2, 3]) {
        const terminal = finalized.filter((event) => event.processGeneration === generation
          && (event.eventType === "session.stopping" || event.eventType === "session.stopped"));
        expect(terminal.map((event) => event.eventType)).toEqual(["session.stopping", "session.stopped"]);
        expect(terminal[1]!.sequence).toBe(terminal[0]!.sequence + 1);
      }
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("rejects restart before generation advance when finalization capacity is insufficient", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-runtime-restart-capacity-test-"));
    let providerStarts = 0;
    try {
      await seedStoppedHistory(stateRoot, MAX_RETAINED_OUTBOX_EVENTS - 3);
      const runtime = createAiSessionRuntime({
        mode: "fake",
        stateRoot,
        fakeProviderTestHooks: { onStart: () => { providerStarts += 1; } }
      } as never);
      const before = await runtime.replay(sessionId, 0);
      await expect(runtime.start(binding)).rejects.toThrow("AI_OUTBOX_UNAVAILABLE");
      expect(providerStarts).toBe(0);
      expect(await runtime.replay(sessionId, 0)).toEqual(before);
      expect(before.filter((event) => event.eventType === "session.started")).toHaveLength(0);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("uses exact sufficient restart capacity for one complete provider generation", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-runtime-restart-exact-capacity-test-"));
    let providerStarts = 0;
    try {
      await seedStoppedHistory(stateRoot, MAX_RETAINED_OUTBOX_EVENTS - 4);
      const runtime = createAiSessionRuntime({
        mode: "fake",
        stateRoot,
        fakeProviderTestHooks: { onStart: () => { providerStarts += 1; } }
      } as never);
      await runtime.start(binding);
      await runtime.stop({ ...binding, processGeneration: 2 });
      const generationTwo = (await runtime.replay(sessionId, 0)).filter((event) => event.processGeneration === 2);
      expect(providerStarts).toBe(1);
      expect(generationTwo.map((event) => event.eventType)).toEqual([
        "session.started", "session.ready", "session.stopping", "session.stopped"
      ]);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ["normal completion followed by provider close", "hello", false, MAX_RETAINED_OUTBOX_EVENTS - 11, MAX_RETAINED_OUTBOX_EVENTS - 1,
      ["turn.provider-completed", "turn.files.changed", "turn.quiesced"]],
    ["interrupted completion followed by provider close", "long", true, MAX_RETAINED_OUTBOX_EVENTS - 14, MAX_RETAINED_OUTBOX_EVENTS,
      ["turn.interrupted", "turn.provider-completed", "turn.files.changed", "turn.quiesced"]]
  ] as const)("retains the complete %s at the maximum event boundary", async (_name, text, interruptTurn, retained, expectedLength, terminalTypes) => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-runtime-provider-close-boundary-test-"));
    try {
      await seedStoppedHistory(stateRoot, retained);
      const runtime = createAiSessionRuntime({ mode: "fake", stateRoot, fakeProviderTestHooks: { closeAfterTurn: true } } as never);
      await runtime.start(binding);
      await runtime.sendTurn({ ...binding, processGeneration: 2, turnId, content: { kind: "text", text } });
      if (interruptTurn) await runtime.interrupt({ ...binding, processGeneration: 2, turnId });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const events = await runtime.replay(sessionId, 0);
      const generationTwo = events.filter((event) => event.processGeneration === 2);
      expect(events).toHaveLength(expectedLength);
      expect(generationTwo.filter((event) => event.turnId === turnId && terminalTypes.includes(event.eventType as never)).map((event) => event.eventType)).toEqual(terminalTypes);
      expect(generationTwo.slice(-2).map((event) => event.eventType)).toEqual(["session.stopping", "session.stopped"]);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("explicit Stop completes an interrupted active turn at the maximum event boundary", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-runtime-stop-interrupted-boundary-test-"));
    try {
      await seedStoppedHistory(stateRoot, MAX_RETAINED_OUTBOX_EVENTS - 12);
      const runtime = createAiSessionRuntime({ mode: "fake", stateRoot });
      await runtime.start(binding);
      await runtime.sendTurn({ ...binding, processGeneration: 2, turnId, content: { kind: "text", text: "long" } });
      await new Promise((resolve) => setImmediate(resolve));
      await runtime.stop({ ...binding, processGeneration: 2 });
      const events = await runtime.replay(sessionId, 0);
      const generationTwo = events.filter((event) => event.processGeneration === 2);
      expect(events).toHaveLength(MAX_RETAINED_OUTBOX_EVENTS);
      expect(generationTwo.filter((event) => event.turnId === turnId && [
        "turn.interrupted", "turn.provider-completed", "turn.files.changed", "turn.quiesced"
      ].includes(event.eventType)).map((event) => event.eventType)).toEqual([
        "turn.interrupted", "turn.provider-completed", "turn.files.changed", "turn.quiesced"
      ]);
      expect(generationTwo.slice(-2).map((event) => event.eventType)).toEqual(["session.stopping", "session.stopped"]);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("cold Agent restart derives the next generation only from a clean terminal outbox", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-runtime-cold-restart-test-"));
    const first = createAiSessionRuntime({ mode: "fake", stateRoot });
    const profile = await first.inspect({ projectId, workspaceId, profileId: "codex" });
    const exactBinding = { ...binding, profileRevision: profile.profileRevision };
    try {
      await first.start(exactBinding);
      await first.stop({ ...exactBinding, processGeneration: 1 });

      const restarted = createAiSessionRuntime({ mode: "fake", stateRoot });
      await restarted.start(exactBinding);
      const events = await restarted.replay(sessionId, 0);
      expect(events.at(-2)).toMatchObject({ eventType: "session.started", processGeneration: 2 });
      expect(events.at(-1)).toMatchObject({ eventType: "session.ready", processGeneration: 2 });
      expect(events.filter((event) => event.eventType === "session.lost")).toHaveLength(0);
      await restarted.stop({ ...exactBinding, processGeneration: 2 });
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("cold Agent restart rejects a nonterminal outbox", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-runtime-cold-nonterminal-test-"));
    const first = createAiSessionRuntime({ mode: "fake", stateRoot });
    const profile = await first.inspect({ projectId, workspaceId, profileId: "codex" });
    const exactBinding = { ...binding, profileRevision: profile.profileRevision };
    try {
      await first.start(exactBinding);
      const restarted = createAiSessionRuntime({ mode: "fake", stateRoot });
      await expect(restarted.start(exactBinding)).rejects.toThrow("ai-session-restart-unavailable");
      const events = await restarted.replay(sessionId, 0);
      expect(events.at(-1)?.eventType).toBe("session.lost");
      expect(events.filter((event) => event.eventType === "session.started")).toHaveLength(1);
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("cold Agent reconstruction terminalizes an accepted turn before the session and never duplicates loss", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-runtime-cold-active-turn-test-"));
    try {
      const profile = await createAiSessionRuntime({ mode: "fake", stateRoot }).inspect({
        projectId,
        workspaceId,
        profileId: "codex"
      });
      const exactBinding = { ...binding, profileRevision: profile.profileRevision };
      const outbox = await createAiSessionOutbox({ stateRoot, binding: exactBinding });
      const eventProfile = { profileId: "codex", profileRevision: profile.profileRevision, provider: "codex" };
      await outbox.reserveProviderGeneration();
      await outbox.append({
        turnId: null,
        eventType: "session.started",
        payload: { processGeneration: 1 },
        profile: eventProfile,
        processGeneration: 1
      });
      await outbox.append({
        turnId: null,
        eventType: "session.ready",
        payload: {},
        profile: eventProfile,
        processGeneration: 1
      });
      await outbox.beginTurn({
        turnId,
        profile: eventProfile,
        processGeneration: 1,
        content: { kind: "text", text: "long" }
      });
      const restarted = createAiSessionRuntime({ mode: "fake", stateRoot });
      const firstReplay = await restarted.replay(sessionId, 0);
      expect(firstReplay.slice(-2).map((event) => [event.eventType, event.turnId])).toEqual([
        ["turn.lost", turnId],
        ["session.lost", null]
      ]);
      const secondReplay = await restarted.replay(sessionId, 0);
      expect(secondReplay.filter((event) => event.eventType === "turn.lost")).toHaveLength(1);
      expect(secondReplay.filter((event) => event.eventType === "session.lost")).toHaveLength(1);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("cold Agent restart rejects overflow and conflicting retained generations", async () => {
    for (const malformed of ["overflow", "decreasing"] as const) {
      const stateRoot = await mkdtemp(join(tmpdir(), `devspace-ai-runtime-cold-${malformed}-test-`));
      try {
        const profile = (await createAiSessionRuntime({ mode: "fake", stateRoot }).inspect({ projectId, workspaceId, profileId: "codex" }));
        const exactBinding = { ...binding, profileRevision: profile.profileRevision };
        const outbox = await createAiSessionOutbox({ stateRoot, binding });
        const eventProfile = { profileId: "codex", profileRevision: profile.profileRevision, provider: "codex" };
        if (malformed === "decreasing") {
          await outbox.append({ turnId: null, eventType: "session.started", payload: { processGeneration: 2 },
            profile: eventProfile, processGeneration: 2 });
        }
        await outbox.append({ turnId: null, eventType: "session.stopped", payload: { reason: "user-request" },
          profile: eventProfile, processGeneration: malformed === "overflow" ? Number.MAX_SAFE_INTEGER : 1, kind: "terminal" });
        const restarted = createAiSessionRuntime({ mode: "fake", stateRoot });
        await expect(restarted.start(exactBinding)).rejects.toThrow("ai-session-restart-unavailable");
      } finally { await rm(stateRoot, { recursive: true, force: true }); }
    }
  });

  test("rejects restart while the current generation is active", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-runtime-active-restart-test-"));
    const runtime = createAiSessionRuntime({ mode: "fake", stateRoot });
    const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
    const exactBinding = { ...binding, profileRevision: profile.profileRevision };
    try {
      await runtime.start(exactBinding);
      await expect(runtime.start(exactBinding)).rejects.toThrow("ai-session-state-conflict");
      await runtime.stop({ ...exactBinding, processGeneration: 1 });
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("Codex adapter sends the pinned managed-container permission policy", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-adapter-test-"));
    const captured: Array<Record<string, unknown>> = [];
    const protocol = createProtocolDocker(captured);
    const executablePath = await createCodexTestExecutable(stateRoot);
    const context = managedContext(stateRoot);
    const managed = { executionContext: () => Promise.resolve(context) } as never;
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed, docker: protocol.docker, executablePath,
      codexPreflight: () => undefined } as never);
    let restartedRuntime: ReturnType<typeof createAiSessionRuntime> | null = null;
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await runtime.start({ ...binding, profileRevision: profile.profileRevision });
      await runtime.sendTurn({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1, turnId, content: { kind: "text", text: "hello" } });
      expect(protocol.uploads.get("auth.json")?.toString("utf8")).toBe(fixtureCredential);
      const refreshedCredential = fixtureCredential.replace("synthetic-access-value", "synthetic-access-refreshed")
        .replace("synthetic-refresh-value", "synthetic-refresh-refreshed").replace("2026-07-29T10:00:00.000Z", "2026-07-29T10:01:00.000Z");
      protocol.uploads.set("auth.json", Buffer.from(refreshedCredential));
      await runtime.stop({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1 });
      const authUpload = captured.find((entry) => {
        const input = entry.input as DockerExecInput | undefined;
        return input?.environment.DEVSPACE_TARGET_NAME === "auth.json";
      });
      expect((authUpload?.input as DockerExecInput).command.join(" ")).toContain("chmod 600");
      const authEnvironment = (authUpload?.input as DockerExecInput).environment as Record<string, string>;
      expect(authEnvironment.DEVSPACE_TARGET_DIR).toMatch(/^\/tmp\/devspace-ai\/[^/]+\/home$/u);
      expect(authEnvironment.CODEX_HOME).toBe(authEnvironment.DEVSPACE_TARGET_DIR);
      expect(captured.some((entry) => {
        const input = entry.input as DockerExecInput | undefined;
        return Array.isArray(input?.command) && input.command.join(" ").includes("rm -rf");
      })).toBe(true);
      const requests = captured.flatMap((entry) => {
        const request = entry.jsonRpc;
        return request !== undefined ? [request as { method?: string; params?: unknown }] : [];
      });
      const threadStart = requests.find((request) => request.method === "thread/start");
      const turnStart = requests.find((request) => request.method === "turn/start");
      expect(threadStart).toBeDefined();
      expect(turnStart).toBeDefined();
      const schema = JSON.parse(await readFile(new URL("../../../packages/contracts/fixtures/codex-app-server/0.145.0/stable/ClientRequest.json", import.meta.url), "utf8")) as JsonSchema;
      validateFixture({ id: 1, method: threadStart!.method, params: threadStart!.params }, schema, schema);
      validateFixture({ id: 2, method: turnStart!.method, params: turnStart!.params }, schema, schema);
      expect(threadStart?.params).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
      expect(turnStart?.params).toMatchObject({ sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" } });
      expect(requests.every((request) => request.method !== "thread/start" || request.params !== undefined)).toBe(true);
      expect(JSON.stringify(captured)).not.toContain(fixtureCredentialToken);
      expect(JSON.stringify(await runtime.replay(sessionId, 0))).not.toContain(fixtureCredentialToken);
      expect(CODEX_EXECUTABLE_SHA256).toHaveLength(64);
      expect((await runtime.replay(sessionId, 0)).every((event) => event.profile.profileRevision === profile.profileRevision)).toBe(true);
      const restartedProtocol = createProtocolDocker([]);
      restartedRuntime = createAiSessionRuntime({ mode: "codex", stateRoot, managed, docker: restartedProtocol.docker, executablePath,
        codexPreflight: () => undefined } as never);
      const restartedProfile = await restartedRuntime.inspect({ projectId, workspaceId, profileId: "codex" });
      await restartedRuntime.start({ ...binding, profileRevision: restartedProfile.profileRevision });
      expect(restartedProtocol.uploads.get("auth.json")?.toString("utf8")).toBe(refreshedCredential);
      await restartedRuntime.stop({ ...binding, profileRevision: restartedProfile.profileRevision, processGeneration: 2 });
    } finally {
      await restartedRuntime?.stop({ ...binding, profileRevision: (await runtime.inspect({ projectId, workspaceId, profileId: "codex" })).profileRevision, processGeneration: 2 });
      await runtime.stop({ ...binding, profileRevision: (await runtime.inspect({ projectId, workspaceId, profileId: "codex" })).profileRevision, processGeneration: 1 });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("profile revisions fence execution policy but ignore cosmetic display names", () => {
    const authority = {
      providerVersion: "0.145.0", transport: "stdio-jsonl", threadSandbox: "danger-full-access",
      turnSandboxPolicy: "externalSandbox", networkAccess: "enabled", approvalPolicy: "never",
      declaredCapabilities: { interrupt: true, approvals: false, structuredInput: false },
      credentialSourceIdentity: "agent-owned-persistent-codex-auth-v1",
      runtimeIdentity: { projectId, workspaceId, revisionId, runtimePlanHash, runtimeGeneration: 1 },
      displayName: "Codex"
    } as const;
    const base = codexProfileRevisionForAuthority(authority);
    expect(codexProfileRevisionForAuthority({ ...authority, displayName: "Codex (managed)" })).toBe(base);
    expect(codexProfileRevisionForAuthority({ ...authority, threadSandbox: "workspace-write" })).not.toBe(base);
      expect(codexProfileRevisionForAuthority({ ...authority, approvalPolicy: "on-request" })).not.toBe(base);
      expect(codexProfileRevisionForAuthority({ ...authority, turnSandboxPolicy: "dangerFullAccess" })).not.toBe(base);
      expect(codexProfileRevisionForAuthority({ ...authority, declaredCapabilities: { ...authority.declaredCapabilities, interrupt: false } })).not.toBe(base);
      expect(codexProfileRevisionForAuthority({ ...authority, persistentAuthorityPolicyVersion: "other-authority-policy" })).not.toBe(base);
      expect(codexProfileRevisionForAuthority({ ...authority, exclusiveLeasePolicyVersion: "other-lease-policy" })).not.toBe(base);
      expect(codexProfileRevisionForAuthority({ ...authority, stagedWritebackPolicyVersion: "other-writeback-policy" })).not.toBe(base);
  });

  test("fake long turns remain active until interrupt", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-fake-interrupt-test-"));
    const runtime = createAiSessionRuntime({ mode: "fake", stateRoot });
    try {
      await runtime.start(binding);
      const longTurnId = "018f1f34-7000-7000-8000-000000000007";
      await runtime.sendTurn({ ...binding, processGeneration: 1, turnId: longTurnId, content: { kind: "text", text: "long" } });
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      const active = await runtime.replay(sessionId, 0);
      expect(active.some((event) => event.eventType === "turn.quiesced" && event.turnId === longTurnId)).toBe(false);
      await runtime.interrupt({ ...binding, processGeneration: 1, turnId: longTurnId });
      const interrupted = await runtime.collect(sessionId, 0, 100);
      expect(interrupted.some((event) => event.eventType === "turn.interrupted" && event.turnId === longTurnId)).toBe(true);
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("rejects a JSON-RPC error response without projecting its private message", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-json-rpc-error-test-"));
    const captured: Array<Record<string, unknown>> = [];
    const observations: unknown[] = [];
    const timeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const protocol = createProtocolDocker(captured, (request, emit) => {
      const result = request.method === "thread/start" ? { thread: { id: "thread-1" } } : {};
      setImmediate(() => emit(request.method === "turn/start"
        ? { id: request.id, error: { code: -32602, message: "private fixture message" } }
        : { id: request.id, result }));
    });
    const context = managedContext(stateRoot);
    const executablePath = await createCodexTestExecutable(stateRoot);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(context) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined,
      onPrivateFailureObservation: (value: unknown) => observations.push(value) } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await runtime.start({ ...binding, profileRevision: profile.profileRevision });
      await runtime.sendTurn({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1, turnId, content: { kind: "text", text: "hello" } });
      const events = await runtime.collect(sessionId, 0, 75);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
      expect(events.some((event) => event.eventType === "turn.provider-completed")).toBe(false);
      expect(JSON.stringify(events)).not.toContain("private fixture message");
      expect(observations).toEqual([{ stage: "request", kind: "Unknown", httpStatusCode: null }]);
      expect(timeoutSpy).toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
      await runtime.stop({ ...binding, profileRevision: (await runtime.inspect({ projectId, workspaceId, profileId: "codex" })).profileRevision, processGeneration: 1 });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("captures only an allowlisted private observation from a pinned error notification", async () => {
    const schema = await pinnedServerNotificationSchema();
    const notification = errorNotification(privateFixtureError);
    validateFixture(notification, schema, schema);
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-error-notification-test-"));
    const observations: unknown[] = [];
    const protocol = createProtocolDocker([], (request, emit) => {
      const result = request.method === "thread/start" ? { thread: { id: "thread-1" } }
        : request.method === "turn/start" ? { turn: { id: "turn-1" } } : {};
      setImmediate(() => emit({ id: request.id, result }));
    });
    const context = managedContext(stateRoot);
    const executablePath = await createCodexTestExecutable(stateRoot);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(context) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined,
      onPrivateFailureObservation: (value: unknown) => observations.push(value) } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await runtime.start({ ...binding, profileRevision: profile.profileRevision });
      await runtime.sendTurn({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1, turnId, content: { kind: "text", text: "hello" } });
      await flushNativeTurnStart();
      protocol.emit(notification);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(observations).toEqual([{ stage: "turn", kind: "ResponseStreamConnectionFailed", httpStatusCode: 503 }]);
      expect(JSON.stringify(await runtime.replay(sessionId, 0))).not.toContain("private fixture");
    } finally {
      await runtime.stop({ ...binding, profileRevision: (await runtime.inspect({ projectId, workspaceId, profileId: "codex" })).profileRevision, processGeneration: 1 });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("projects a failed turn completion once while retaining only its safe private classification", async () => {
    const schema = await pinnedServerNotificationSchema();
    const completion = failedTurn(privateFixtureError);
    validateFixture(completion, schema, schema);
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-failed-turn-test-"));
    const observations: unknown[] = [];
    const protocol = createProtocolDocker([], (request, emit) => {
      const result = request.method === "thread/start" ? { thread: { id: "thread-1" } }
        : request.method === "turn/start" ? { turn: { id: "turn-1" } } : {};
      setImmediate(() => emit({ id: request.id, result }));
    });
    const context = managedContext(stateRoot);
    const executablePath = await createCodexTestExecutable(stateRoot);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(context) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined,
      onPrivateFailureObservation: (value: unknown) => observations.push(value) } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await runtime.start({ ...binding, profileRevision: profile.profileRevision });
      await runtime.sendTurn({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1, turnId, content: { kind: "text", text: "hello" } });
      await flushNativeTurnStart();
      protocol.emit(completion);
      const events = await runtime.collect(sessionId, 0, 50);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
      expect(events.some((event) => event.eventType === "turn.provider-completed")).toBe(false);
      expect(observations).toEqual([{ stage: "turn", kind: "ResponseStreamConnectionFailed", httpStatusCode: 503 }]);
      expect(JSON.stringify(events)).not.toContain("private fixture");
    } finally {
      await runtime.stop({ ...binding, profileRevision: (await runtime.inspect({ projectId, workspaceId, profileId: "codex" })).profileRevision, processGeneration: 1 });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("a failed terminal turn automatically finalizes the provider exactly once", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-failed-turn-finalize-test-"));
    const captured: Array<Record<string, unknown>> = [];
    const control = { inspectCalls: [] as string[] };
    const protocol = createProtocolDocker(captured, (request, emit) => {
      const result = request.method === "thread/start" ? { thread: { id: "thread-1" } } : request.method === "turn/start" ? { turn: { id: "turn-1" } } : {};
      setImmediate(() => emit({ id: request.id, result }));
    }, control);
    const executablePath = await createCodexTestExecutable(stateRoot);
    const authority = createCodexCredentialAuthority(stateRoot);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(managedContext(stateRoot)) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await runtime.start({ ...binding, profileRevision: profile.profileRevision });
      await runtime.sendTurn({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1, turnId, content: { kind: "text", text: "hello" } });
      await flushNativeTurnStart();
      protocol.emit(failedTurn(privateFixtureError));
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      const events = await runtime.replay(sessionId, 0);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
      expect(events.filter((event) => event.eventType === "session.stopping")).toHaveLength(1);
      expect(events.find((event) => event.eventType === "session.stopping")?.payload).toEqual({ reason: "runtime-stopping" });
      expect(events.filter((event) => event.eventType === "session.stopped")).toHaveLength(1);
      expect(events.find((event) => event.eventType === "session.stopped")?.payload).toEqual({ reason: "provider-exited" });
      expect(control.inspectCalls.some((id) => id.startsWith("provider-"))).toBe(true);
      expect(control.inspectCalls.some((id) => id.startsWith("cleanup-"))).toBe(true);
      await expect(authority.inspect()).resolves.toBeUndefined();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("Unauthorized automatically finalizes, preserves durable auth, and leaves reauthentication required", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-unauthorized-finalize-test-"));
    const control = { inspectCalls: [] as string[] };
    const protocol = createProtocolDocker([], (request, emit) => {
      const result = request.method === "thread/start" ? { thread: { id: "thread-1" } } : request.method === "turn/start" ? { turn: { id: "turn-1" } } : {};
      setImmediate(() => emit({ id: request.id, result }));
    }, control);
    const executablePath = await createCodexTestExecutable(stateRoot);
    const authority = createCodexCredentialAuthority(stateRoot);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(managedContext(stateRoot)) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await runtime.start({ ...binding, profileRevision: profile.profileRevision });
      await runtime.sendTurn({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1, turnId, content: { kind: "text", text: "hello" } });
      await flushNativeTurnStart();
      protocol.emit(errorNotification({ message: "synthetic unauthorized", codexErrorInfo: "unauthorized" }));
      protocol.emit(failedTurn({ codexErrorInfo: "unauthorized" }));
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      const events = await runtime.replay(sessionId, 0);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
      expect(events.filter((event) => event.eventType === "session.stopped")).toHaveLength(1);
      await expect(authority.read()).resolves.toMatchObject({ document: { auth_mode: "chatgpt" } });
      await expect(authority.inspect()).rejects.toThrow("credential-unavailable");
      expect(control.inspectCalls.some((id) => id.startsWith("provider-"))).toBe(true);
      expect(control.inspectCalls.some((id) => id.startsWith("cleanup-"))).toBe(true);
      expect(JSON.stringify(events)).not.toContain("synthetic unauthorized");
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test.each(["codex", "auth.json"])("nonzero %s upload rejects before provider start and proves cleanup", async (uploadName) => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-upload-failure-test-"));
    const captured: Array<Record<string, unknown>> = [];
    const control = { uploadExitCodes: { [uploadName]: 17 }, inspectCalls: [] as string[] };
    const protocol = createProtocolDocker(captured, undefined, control);
    const executablePath = await createCodexTestExecutable(stateRoot);
    const authority = createCodexCredentialAuthority(stateRoot);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(managedContext(stateRoot)) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await expect(runtime.start({ ...binding, profileRevision: profile.profileRevision })).rejects.toThrow("upload");
      expect(captured.some((entry) => String(entry.id).startsWith("provider-"))).toBe(false);
      expect(captured.some((entry) => String(entry.id).startsWith("cleanup-"))).toBe(true);
      expect(control.inspectCalls.some((id) => id.startsWith("upload-"))).toBe(true);
      expect(control.inspectCalls.some((id) => id.startsWith("cleanup-"))).toBe(true);
      await expect(authority.inspect()).resolves.toBeUndefined();
      expect((await runtime.replay(sessionId, 0)).some((event) => event.eventType === "session.ready")).toBe(false);
      expect((await runtime.replay(sessionId, 0)).filter((event) => event.eventType === "session.stopping")).toHaveLength(1);
      expect((await runtime.replay(sessionId, 0)).filter((event) => event.eventType === "session.stopped")).toHaveLength(1);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("nonzero staging cleanup keeps the lease and refuses false session.stopped", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-cleanup-failure-test-"));
    const control = { cleanupExitCode: 17, inspectCalls: [] as string[] };
    const protocol = createProtocolDocker([], undefined, control);
    const executablePath = await createCodexTestExecutable(stateRoot);
    const authority = createCodexCredentialAuthority(stateRoot);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(managedContext(stateRoot)) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await runtime.start({ ...binding, profileRevision: profile.profileRevision });
      const stopping = runtime.stop({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1 });
      await expect(runtime.start({ ...binding, profileRevision: profile.profileRevision })).rejects.toThrow("ai-session-state-conflict");
      await expect(stopping).rejects.toThrow("finalization");
      expect((await runtime.replay(sessionId, 0)).filter((event) => event.eventType === "session.stopped")).toHaveLength(0);
      await expect(authority.inspect()).rejects.toThrow("credential-unavailable");
      await expect(runtime.start({ ...binding, profileRevision: profile.profileRevision })).rejects.toThrow("ai-session-state-conflict");
      await expect(runtime.sendTurn({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1, turnId,
        content: { kind: "text", text: "must not run" } })).rejects.toThrow("ai-session-not-started");
      await expect(authority.inspect()).rejects.toThrow("credential-unavailable");
      control.cleanupExitCode = 0;
      await runtime.stop({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1 });
      expect((await runtime.replay(sessionId, 0)).filter((event) => event.eventType === "session.stopped")).toHaveLength(1);
      await expect(authority.inspect()).resolves.toBeUndefined();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("a stopping append fault cannot prevent cleanup and a later retry completes terminal history once", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-stopping-append-fault-test-"));
    const control = { inspectCalls: [] as string[] };
    const protocol = createProtocolDocker([], undefined, control);
    const executablePath = await createCodexTestExecutable(stateRoot);
    const realAuthority = createCodexCredentialAuthority(stateRoot);
    let releaseAttempts = 0;
    let failStopping = true;
    const authority = {
      ...realAuthority,
      read: realAuthority.read.bind(realAuthority),
      inspect: realAuthority.inspect.bind(realAuthority),
      synchronizeStaged: realAuthority.synchronizeStaged.bind(realAuthority),
      replaceDurable: realAuthority.replaceDurable.bind(realAuthority),
      markReauthenticationRequired: realAuthority.markReauthenticationRequired.bind(realAuthority),
      acquire: async (metadata: Parameters<CodexCredentialAuthority["acquire"]>[0]) => {
        const lease = await realAuthority.acquire(metadata);
        return { release: async () => { releaseAttempts += 1; await lease.release(); } };
      }
    };
    const runtime = createAiSessionRuntime({
      mode: "codex",
      stateRoot,
      managed: { executionContext: () => Promise.resolve(managedContext(stateRoot)) } as never,
      docker: protocol.docker,
      executablePath,
      codexPreflight: () => undefined,
      codexCredentialAuthority: authority,
      outboxFaultHooks: {
        beforeAppend: ({ eventType }: { eventType: string }) => {
          if (eventType === "session.stopping" && failStopping) {
            failStopping = false;
            throw new Error("synthetic-stopping-append-fault");
          }
        }
      }
    } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      const exactBinding = { ...binding, profileRevision: profile.profileRevision };
      await runtime.start(exactBinding);
      await expect(runtime.stop({ ...exactBinding, processGeneration: 1 })).rejects.toThrow("AI_OUTBOX_UNAVAILABLE");
      expect(control.inspectCalls.filter((id) => id.startsWith("cleanup-"))).toHaveLength(1);
      expect(control.inspectCalls.filter((id) => id.startsWith("readback-"))).toHaveLength(2);
      expect(releaseAttempts).toBe(1);
      await expect(realAuthority.inspect()).resolves.toBeUndefined();
      expect((await runtime.replay(sessionId, 0)).filter((event) => event.eventType === "session.stopping" || event.eventType === "session.stopped")).toHaveLength(0);

      await runtime.stop({ ...exactBinding, processGeneration: 1 });
      const terminal = (await runtime.replay(sessionId, 0)).filter((event) => event.eventType === "session.stopping" || event.eventType === "session.stopped");
      expect(terminal.map((event) => event.eventType)).toEqual(["session.stopping", "session.stopped"]);
      expect(control.inspectCalls.filter((id) => id.startsWith("cleanup-"))).toHaveLength(1);
      expect(control.inspectCalls.filter((id) => id.startsWith("readback-"))).toHaveLength(2);
      expect(releaseAttempts).toBe(1);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("a stopped append fault retries only public persistence after cleanup proof", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-stopped-append-fault-test-"));
    const control = { inspectCalls: [] as string[] };
    const protocol = createProtocolDocker([], undefined, control);
    const executablePath = await createCodexTestExecutable(stateRoot);
    const realAuthority = createCodexCredentialAuthority(stateRoot);
    let releaseAttempts = 0;
    let failStopped = true;
    const authority = {
      ...realAuthority,
      read: realAuthority.read.bind(realAuthority),
      inspect: realAuthority.inspect.bind(realAuthority),
      synchronizeStaged: realAuthority.synchronizeStaged.bind(realAuthority),
      replaceDurable: realAuthority.replaceDurable.bind(realAuthority),
      markReauthenticationRequired: realAuthority.markReauthenticationRequired.bind(realAuthority),
      acquire: async (metadata: Parameters<CodexCredentialAuthority["acquire"]>[0]) => {
        const lease = await realAuthority.acquire(metadata);
        return { release: async () => { releaseAttempts += 1; await lease.release(); } };
      }
    };
    const runtime = createAiSessionRuntime({
      mode: "codex",
      stateRoot,
      managed: { executionContext: () => Promise.resolve(managedContext(stateRoot)) } as never,
      docker: protocol.docker,
      executablePath,
      codexPreflight: () => undefined,
      codexCredentialAuthority: authority,
      outboxFaultHooks: {
        beforeAppend: ({ eventType }: { eventType: string }) => {
          if (eventType === "session.stopped" && failStopped) {
            failStopped = false;
            throw new Error("synthetic-stopped-append-fault");
          }
        }
      }
    } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      const exactBinding = { ...binding, profileRevision: profile.profileRevision };
      await runtime.start(exactBinding);
      await expect(runtime.stop({ ...exactBinding, processGeneration: 1 })).rejects.toThrow("AI_OUTBOX_UNAVAILABLE");
      expect((await runtime.replay(sessionId, 0)).filter((event) => event.eventType === "session.stopping")).toHaveLength(1);
      expect((await runtime.replay(sessionId, 0)).filter((event) => event.eventType === "session.stopped")).toHaveLength(0);
      expect(control.inspectCalls.filter((id) => id.startsWith("cleanup-"))).toHaveLength(1);
      expect(releaseAttempts).toBe(1);
      await expect(realAuthority.inspect()).resolves.toBeUndefined();

      await runtime.stop({ ...exactBinding, processGeneration: 1 });
      const terminal = (await runtime.replay(sessionId, 0)).filter((event) => event.eventType === "session.stopping" || event.eventType === "session.stopped");
      expect(terminal.map((event) => event.eventType)).toEqual(["session.stopping", "session.stopped"]);
      expect(control.inspectCalls.filter((id) => id.startsWith("cleanup-"))).toHaveLength(1);
      expect(releaseAttempts).toBe(1);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("each successful provider generation stages, cleans, and releases credentials again", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-generation-cleanup-test-"));
    const captured: Array<Record<string, unknown>> = [];
    const control = { inspectCalls: [] as string[] };
    const protocol = createProtocolDocker(captured, undefined, control);
    const executablePath = await createCodexTestExecutable(stateRoot);
    const authority = createCodexCredentialAuthority(stateRoot);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot,
      managed: { executionContext: () => Promise.resolve(managedContext(stateRoot)) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      const exactBinding = { ...binding, profileRevision: profile.profileRevision };
      await runtime.start(exactBinding);
      await runtime.stop({ ...exactBinding, processGeneration: 1 });
      await expect(authority.inspect()).resolves.toBeUndefined();
      await runtime.start(exactBinding);
      await runtime.stop({ ...exactBinding, processGeneration: 2 });
      await expect(authority.inspect()).resolves.toBeUndefined();

      const events = await runtime.replay(sessionId, 0);
      expect(events.filter((event) => event.eventType === "session.stopped").map((event) => event.processGeneration)).toEqual([1, 2]);
      expect(control.inspectCalls.filter((id) => id.startsWith("provider-"))).toHaveLength(2);
      expect(control.inspectCalls.filter((id) => id.startsWith("cleanup-"))).toHaveLength(2);
      expect(JSON.stringify(captured)).not.toContain(fixtureCredentialToken);
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("provider exit is required before synchronization or staging cleanup", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-provider-running-test-"));
    const control = { providerRunning: true, inspectCalls: [] as string[] };
    const protocol = createProtocolDocker([], undefined, control);
    const executablePath = await createCodexTestExecutable(stateRoot);
    const authority = createCodexCredentialAuthority(stateRoot);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(managedContext(stateRoot)) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await runtime.start({ ...binding, profileRevision: profile.profileRevision });
      await expect(runtime.stop({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1 })).rejects.toThrow("finalization");
      expect(control.inspectCalls.some((id) => id.startsWith("readback-"))).toBe(false);
      expect(control.inspectCalls.some((id) => id.startsWith("cleanup-"))).toBe(false);
      expect((await runtime.replay(sessionId, 0)).filter((event) => event.eventType === "session.stopped")).toHaveLength(0);
      await expect(authority.inspect()).rejects.toThrow("credential-unavailable");
      control.providerRunning = false;
      await runtime.stop({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1 });
      expect((await runtime.replay(sessionId, 0)).filter((event) => event.eventType === "session.stopped")).toHaveLength(1);
      await expect(authority.inspect()).resolves.toBeUndefined();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("lease release failure remains retryable and never reports success early", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-lease-retry-test-"));
    const control = { inspectCalls: [] as string[] };
    const protocol = createProtocolDocker([], undefined, control);
    const executablePath = await createCodexTestExecutable(stateRoot);
    const realAuthority = createCodexCredentialAuthority(stateRoot);
    let releaseAttempts = 0;
    const authority = {
      ...realAuthority,
      read: realAuthority.read.bind(realAuthority),
      inspect: realAuthority.inspect.bind(realAuthority),
      synchronizeStaged: realAuthority.synchronizeStaged.bind(realAuthority),
      replaceDurable: realAuthority.replaceDurable.bind(realAuthority),
      markReauthenticationRequired: realAuthority.markReauthenticationRequired.bind(realAuthority),
      acquire: async (metadata: Parameters<CodexCredentialAuthority["acquire"]>[0]) => {
        const lease = await realAuthority.acquire(metadata);
        return { release: async () => { releaseAttempts += 1; if (releaseAttempts === 1) throw new Error("synthetic-transient-release"); await lease.release(); } };
      }
    };
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(managedContext(stateRoot)) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined, codexCredentialAuthority: authority } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await runtime.start({ ...binding, profileRevision: profile.profileRevision });
      await expect(runtime.stop({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1 })).rejects.toThrow("finalization");
      expect((await runtime.replay(sessionId, 0)).filter((event) => event.eventType === "session.stopped")).toHaveLength(0);
      await expect(realAuthority.inspect()).rejects.toThrow("credential-unavailable");
      await runtime.stop({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1 });
      expect(releaseAttempts).toBe(2);
      expect((await runtime.replay(sessionId, 0)).filter((event) => event.eventType === "session.stopped")).toHaveLength(1);
      await expect(realAuthority.inspect()).resolves.toBeUndefined();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("stream close, failed turn, and explicit Stop share one finalization", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-finalize-race-test-"));
    const captured: Array<Record<string, unknown>> = [];
    const control = { inspectCalls: [] as string[] };
    const protocol = createProtocolDocker(captured, (request, emit) => {
      const result = request.method === "thread/start" ? { thread: { id: "thread-1" } } : request.method === "turn/start" ? { turn: { id: "turn-1" } } : {};
      setImmediate(() => emit({ id: request.id, result }));
    }, control);
    const executablePath = await createCodexTestExecutable(stateRoot);
    const authority = createCodexCredentialAuthority(stateRoot);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(managedContext(stateRoot)) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await runtime.start({ ...binding, profileRevision: profile.profileRevision });
      await runtime.sendTurn({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1, turnId, content: { kind: "text", text: "hello" } });
      await flushNativeTurnStart();
      protocol.emit(failedTurn(privateFixtureError));
      const stop = runtime.stop({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1 });
      await Promise.allSettled([stop, new Promise((resolve) => setTimeout(resolve, 1_300))]);
      const events = await runtime.replay(sessionId, 0);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
      expect(events.filter((event) => event.eventType === "session.stopping")).toHaveLength(1);
      expect(events.filter((event) => event.eventType === "session.stopped")).toHaveLength(1);
      expect(control.inspectCalls.filter((id) => id.startsWith("cleanup-")).length).toBe(1);
      expect(control.inspectCalls.filter((id) => id.startsWith("readback-")).length).toBe(2);
      await expect(authority.inspect()).resolves.toBeUndefined();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("prefers one deterministic private classification when error and terminal completion arrive together", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-error-pair-test-"));
    const observations: unknown[] = [];
    const protocol = createProtocolDocker([], (request, emit) => {
      const result = request.method === "thread/start" ? { thread: { id: "thread-1" } }
        : request.method === "turn/start" ? { turn: { id: "turn-1" } } : {};
      setImmediate(() => emit({ id: request.id, result }));
    });
    const context = managedContext(stateRoot);
    const executablePath = await createCodexTestExecutable(stateRoot);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(context) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined,
      onPrivateFailureObservation: (value: unknown) => observations.push(value) } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await runtime.start({ ...binding, profileRevision: profile.profileRevision });
      await runtime.sendTurn({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1, turnId, content: { kind: "text", text: "hello" } });
      await flushNativeTurnStart();
      protocol.emit(errorNotification(privateFixtureError));
      protocol.emit(failedTurn({ ...privateFixtureError, codexErrorInfo: "internalServerError" }));
      const events = await runtime.collect(sessionId, 0, 50);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
      expect(observations).toEqual([{ stage: "turn", kind: "ResponseStreamConnectionFailed", httpStatusCode: 503 }]);
    } finally {
      await runtime.stop({ ...binding, profileRevision: (await runtime.inspect({ projectId, workspaceId, profileId: "codex" })).profileRevision, processGeneration: 1 });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("rejects still-pending provider requests when the attached stream closes", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-stream-close-test-"));
    const protocol = createProtocolDocker([], (request, emit) => {
      if (request.method !== "turn/start") setImmediate(() => emit({ id: request.id, result: request.method === "thread/start" ? { thread: { id: "thread-1" } } : {} }));
    });
    const context = managedContext(stateRoot);
    const executablePath = await createCodexTestExecutable(stateRoot);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(context) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await runtime.start({ ...binding, profileRevision: profile.profileRevision });
      await runtime.sendTurn({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1, turnId, content: { kind: "text", text: "hello" } });
      protocol.close();
      const events = await runtime.collect(sessionId, 0, 50);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
    } finally {
      await runtime.stop({ ...binding, profileRevision: (await runtime.inspect({ projectId, workspaceId, profileId: "codex" })).profileRevision, processGeneration: 1 });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("production uses only the dedicated authority and does not launch without it", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-production-credential-test-"));
    const captured: Array<Record<string, unknown>> = [];
    const protocol = createProtocolDocker(captured);
    const executablePath = await createCodexTestExecutable(stateRoot);
    const authority = createCodexCredentialAuthority(stateRoot);
    await rm(authority.authPath);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(managedContext(stateRoot)) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await expect(runtime.start({ ...binding, profileRevision: profile.profileRevision })).rejects.toThrow("ai-profile-unavailable");
      expect(captured.some((entry) => entry.id === "provider-1")).toBe(false);
    } finally {
      await runtime.stop({ ...binding, profileRevision: (await runtime.inspect({ projectId, workspaceId, profileId: "codex" })).profileRevision, processGeneration: 1 });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("provider start failure cleans staging and releases the acquired lease", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-start-failure-test-"));
    const captured: Array<Record<string, unknown>> = [];
    const protocol = createProtocolDocker(captured, (request, emit) => {
      setImmediate(() => emit({ id: request.id, error: { code: -32000, message: "synthetic-provider-start-failure" } }));
    });
    const executablePath = await createCodexTestExecutable(stateRoot);
    const authority = createCodexCredentialAuthority(stateRoot);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(managedContext(stateRoot)) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await expect(runtime.start({ ...binding, profileRevision: profile.profileRevision })).rejects.toThrow();
      await expect(authority.inspect()).resolves.toBeUndefined();
      expect(captured.some((entry) => String(entry.id).startsWith("cleanup-"))).toBe(true);
    } finally {
      await runtime.stop({ ...binding, profileRevision: (await runtime.inspect({ projectId, workspaceId, profileId: "codex" })).profileRevision, processGeneration: 1 });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("Unauthorized preserves the failed turn, marks reauthentication, and keeps durable auth", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-codex-unauthorized-test-"));
    const protocol = createProtocolDocker([], (request, emit) => {
      const result = request.method === "thread/start" ? { thread: { id: "thread-1" } } : request.method === "turn/start" ? { turn: { id: "turn-1" } } : {};
      setImmediate(() => emit({ id: request.id, result }));
    });
    const executablePath = await createCodexTestExecutable(stateRoot);
    const authority = createCodexCredentialAuthority(stateRoot);
    const runtime = createAiSessionRuntime({ mode: "codex", stateRoot, managed: { executionContext: () => Promise.resolve(managedContext(stateRoot)) } as never,
      docker: protocol.docker, executablePath, codexPreflight: () => undefined } as never);
    try {
      const profile = await runtime.inspect({ projectId, workspaceId, profileId: "codex" });
      await runtime.start({ ...binding, profileRevision: profile.profileRevision });
      await runtime.sendTurn({ ...binding, profileRevision: profile.profileRevision, processGeneration: 1, turnId, content: { kind: "text", text: "hello" } });
      await flushNativeTurnStart();
      protocol.emit(errorNotification({ message: "synthetic unauthorized", codexErrorInfo: "unauthorized" }));
      protocol.emit(failedTurn({ codexErrorInfo: "unauthorized" }));
      const events = await runtime.collect(sessionId, 0, 50);
      expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(1);
      await expect(authority.inspect()).rejects.toThrow("credential-unavailable");
      await expect(authority.read()).resolves.toMatchObject({ document: { auth_mode: "chatgpt" } });
      expect(JSON.stringify(events)).not.toContain("synthetic unauthorized");
    } finally {
      await runtime.stop({ ...binding, profileRevision: (await runtime.inspect({ projectId, workspaceId, profileId: "codex" })).profileRevision, processGeneration: 1 });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
