/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { CODEX_EXECUTABLE_SHA256, codexProfileRevisionForAuthority, createAiSessionRuntime } from "./ai-session-runtime.js";
import { createCodexCredentialAuthority } from "./codex-credential-authority.js";
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
const fixtureCredential = JSON.stringify({ auth_mode: "chatgpt", tokens: {
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

function dockerBytes(payload: Buffer): Buffer {
  const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function createProtocolDocker(captured: Array<Record<string, unknown>>, respond?: (request: { id?: number; method?: string }, emit: (message: unknown) => void) => void): {
  readonly docker: DockerEngineClient;
  readonly emit: (message: unknown) => void;
  readonly close: () => void;
  readonly uploads: Map<string, Buffer>;
} {
  let sequence = 0;
  let provider: Duplex | null = null;
  const uploads = new Map<string, Buffer>();
  const uploadNames = new Map<string, string>();
  const emit = (message: unknown) => provider?.push(dockerMux(message));
  return {
    emit,
    uploads,
    close: () => provider?.destroy(),
    docker: {
    createExec: (_containerId: string, input: DockerExecInput) => {
      const command = Array.isArray(input.command) ? input.command.join(" ") : "";
      const kind = command.includes("cat >") ? "upload" : command.includes("stat -c") ? "readback" : command.includes("rm -rf") ? "cleanup" : "provider";
      const id = `${kind}-${++sequence}`;
      captured.push({ id, input });
      if (kind === "upload") uploadNames.set(id, String((input.environment as Record<string, string>).DEVSPACE_TARGET_NAME));
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
        process.nextTick(() => stream.emit("close"));
        return Promise.resolve(stream);
      }
      if (execId.startsWith("readback-")) {
        const auth = uploads.get("auth.json") ?? Buffer.alloc(0);
        const stream = new Duplex({ read() { /* readback output is pushed below */ }, write(_chunk, _encoding, callback) { callback(); } });
        process.nextTick(() => { stream.push(Buffer.concat([dockerBytes(Buffer.from(`regular file 600 ${auth.length}\n`)), dockerBytes(auth)])); setImmediate(() => stream.emit("close")); });
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
    inspectExec: () => Promise.resolve({ ID: "synthetic-exec", Running: false, ExitCode: 0, ContainerID: "devspace-test-container" })
    } as unknown as DockerEngineClient
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

async function pinnedServerNotificationSchema(): Promise<JsonSchema> {
  return JSON.parse(await readFile(new URL("../../../packages/contracts/fixtures/codex-app-server/0.145.0/stable/ServerNotification.json", import.meta.url), "utf8")) as JsonSchema;
}

function failedTurn(error: Record<string, unknown>): Record<string, unknown> {
  return {
    method: "turn/completed",
    params: { threadId: "private-thread-id", turn: { id: "private-turn-id", items: [], status: "failed", error } }
  };
}

function errorNotification(error: Record<string, unknown>): Record<string, unknown> {
  return {
    method: "error",
    params: { threadId: "private-thread-id", turnId: "private-turn-id", willRetry: false, error }
  };
}

const privateFixtureError = {
  message: "private fixture message",
  additionalDetails: "private fixture details",
  codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 503 } }
};

describe("AI session runtime", () => {
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
      await restartedRuntime.stop({ ...binding, profileRevision: restartedProfile.profileRevision, processGeneration: 1 });
    } finally {
      await restartedRuntime?.stop({ ...binding, profileRevision: (await runtime.inspect({ projectId, workspaceId, profileId: "codex" })).profileRevision, processGeneration: 1 });
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
      await new Promise((resolve) => setTimeout(resolve, 150));
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
