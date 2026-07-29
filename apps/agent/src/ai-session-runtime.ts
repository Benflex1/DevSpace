import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-unused-vars, @typescript-eslint/require-await */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  AI_EVENT_NDJSON_CONTENT_TYPE,
  aiAfterSequenceSchema,
  aiProviderProfileProjectionSchema,
  canonicalAiEventSchema,
  type CanonicalAiEvent,
  type AiProviderProfileProjection,
  CODEX_APP_SERVER_CLI_VERSION, CODEX_APP_SERVER_VERSION_OUTPUT
} from "@devspace/contracts";
import { v7 as uuidv7 } from "uuid";
import { DockerEngineClient, defaultRootlessDockerSocketPath } from "./docker-runtime.js";
import type { ManagedWorkspaces, WorkspaceExecutionContext } from "./managed-workspaces.js";
import {
  CODEX_AUTH_CREDENTIAL_SOURCE_IDENTITY,
  CODEX_AUTHORITY_POLICY_VERSION,
  CODEX_CREDENTIAL_LEASE_POLICY_VERSION,
  CODEX_STAGED_WRITEBACK_POLICY_VERSION,
  createCodexCredentialAuthority,
  type CodexCredentialAuthority
} from "./codex-credential-authority.js";

const execFileAsync = promisify(execFile);
const CODEX_PROFILE_ID = "codex";
const CODEX_EXECUTABLE_SHA256 = "a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14";
const MAX_OUTBOX_EVENTS = 2048;
const ACK_RETAINED_EVENTS = 512;
const MAX_GIT_PATHS = 256;
const PRIVATE_CONTAINER_ROOT = "/tmp/devspace-ai";
const CODEX_DOCKER_EXEC_TIMEOUT_MS = 5_000;
const CODEX_APPROVAL_POLICY = "never" as const;
const CODEX_THREAD_SANDBOX = "danger-full-access" as const;
const CODEX_TURN_SANDBOX_POLICY = "externalSandbox" as const;
const CODEX_NETWORK_ACCESS = "enabled" as const;
const CODEX_CAPABILITIES = Object.freeze({
  inspect: true, start: true, resume: false, sendTurn: true, interrupt: true,
  approvals: false, structuredInput: false, stop: true, streamEvents: true
});

export interface AiSessionBinding {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly aiSessionId: string;
  readonly revisionId: string;
  readonly runtimePlanHash: string;
  readonly runtimeGeneration: number;
  readonly profileId: string;
  readonly profileRevision: string;
}
interface AiProcessBinding {
  readonly projectId: string; readonly workspaceId: string; readonly aiSessionId: string;
  readonly profileId: string; readonly profileRevision: string; readonly processGeneration: number;
}

export interface AiSessionRuntimeOptions {
  readonly mode?: "codex" | "fake";
  readonly stateRoot?: string;
  readonly managed?: ManagedWorkspaces;
  readonly docker?: DockerEngineClient;
  readonly executablePath?: string;
  readonly now?: () => Date;
  readonly createId?: () => string;
  /** Agent-private structured diagnostic hook. It never crosses the F11 boundary. */
  readonly onPrivateFailureObservation?: (observation: CodexPrivateFailureObservation) => void;
  /** Deterministic adapter-test preflight; the server never supplies this hook. */
  readonly codexPreflight?: () => void | Promise<void>;
  /** Agent-private bounded authority seam; the server never supplies this implementation. */
  readonly codexCredentialAuthority?: CodexCredentialAuthority;
}

export type CodexPrivateFailureObservation = Readonly<{
  stage: "request" | "turn";
  kind:
    | "ContextWindowExceeded"
    | "SessionBudgetExceeded"
    | "UsageLimitExceeded"
    | "ServerOverloaded"
    | "CyberPolicy"
    | "ThreadRollbackFailed"
    | "HttpConnectionFailed"
    | "ResponseStreamConnectionFailed"
    | "ResponseStreamDisconnected"
    | "ResponseTooManyFailedAttempts"
    | "ActiveTurnNotSteerable"
    | "BadRequest"
    | "Unauthorized"
    | "SandboxError"
    | "InternalServerError"
    | "Other"
    | "Unknown";
  httpStatusCode: number | null;
}>;

export interface AiSessionRuntime {
  inspect(input: { projectId: string; workspaceId: string; profileId: string }): Promise<AiProviderProfileProjection>;
  start(input: AiSessionBinding): Promise<void>;
  sendTurn(input: AiProcessBinding & { turnId: string; content: { kind: "text"; text: string } }): Promise<void>;
  interrupt(input: AiProcessBinding & { turnId: string }): Promise<void>;
  stop(input: AiProcessBinding): Promise<void>;
  replay(sessionId: string, afterSequence: number): Promise<CanonicalAiEvent[]>;
  subscribe(sessionId: string, afterSequence: number, listener: (event: CanonicalAiEvent) => void): Promise<() => void>;
  acknowledge(sessionId: string, throughSequence: number): Promise<void>;
  collect(sessionId: string, afterSequence: number, waitMs: number): Promise<CanonicalAiEvent[]>;
}

interface SessionRecord {
  readonly binding: AiSessionBinding;
  readonly processGeneration: number;
  readonly events: CanonicalAiEvent[];
  readonly listeners: Set<(event: CanonicalAiEvent) => void>;
  readonly turnBaselines: Map<string, Set<string>>;
  readonly privateFailures: Map<string, CodexPrivateFailureObservation>;
  adapter: ProviderAdapter | null;
  activeTurnId: string | null;
  nextSequence: number;
  acknowledgedThrough: number;
  eventChain: Promise<void>;
  finalizationPromise: Promise<ProviderFinalizationResult> | null;
  finalizationState: "active" | "finalizing" | "finalized" | "cleanup-unproven";
  finalizationReason: "user-request" | "provider-exited" | null;
  stoppingEmitted: boolean;
}

type CredentialSynchronizationResult = "synchronized" | "unchanged-valid" | "rejected-and-reauth-required";
type ProviderFinalizationResult =
  | { readonly state: "finalized"; readonly synchronization: CredentialSynchronizationResult }
  | { readonly state: "cleanup-unproven"; readonly providerExited: boolean; readonly stagingRemoved: boolean; readonly leaseReleased: boolean };

class ProviderFinalizationUnprovenError extends Error {
  constructor() {
    super("ai-provider-finalization-unproven");
    this.name = "ProviderFinalizationUnprovenError";
  }
}

interface ProviderAdapter {
  start(): Promise<void>;
  sendTurn(turnId: string, text: string): Promise<void>;
  interrupt(): Promise<void>;
  stop(): Promise<ProviderFinalizationResult>;
}

interface AdapterCallbacks {
  readonly outputDelta: (text: string) => Promise<void>;
  readonly activity: (summary: string) => Promise<void>;
  readonly completed: (outcome: "completed" | "interrupted" | "failed") => Promise<void>;
  readonly privateFailure: (observation: CodexPrivateFailureObservation) => void;
  readonly failed: (observation: CodexPrivateFailureObservation) => Promise<void>;
  readonly providerClosed: () => Promise<void>;
}

export interface CodexProfileRevisionAuthority {
  readonly providerVersion: string;
  readonly transport: string;
  readonly threadSandbox: string;
  readonly turnSandboxPolicy: string;
  readonly networkAccess: string;
  readonly approvalPolicy: string;
  readonly declaredCapabilities: Readonly<Record<string, boolean>>;
  readonly credentialSourceIdentity: string;
  readonly persistentAuthorityPolicyVersion?: string;
  readonly exclusiveLeasePolicyVersion?: string;
  readonly stagedWritebackPolicyVersion?: string;
  readonly runtimeIdentity: Readonly<{
    projectId: string; workspaceId: string; revisionId: string; runtimePlanHash: string; runtimeGeneration: number;
  }> | null;
  readonly displayName?: string;
}

export function codexProfileRevisionForAuthority(input: CodexProfileRevisionAuthority): string {
  const identity = JSON.stringify({
    profileId: CODEX_PROFILE_ID,
    provider: CODEX_PROFILE_ID,
    providerVersion: input.providerVersion,
    transport: input.transport,
    threadSandbox: input.threadSandbox,
    turnSandboxPolicy: input.turnSandboxPolicy,
    networkAccess: input.networkAccess,
    approvalPolicy: input.approvalPolicy,
    declaredCapabilities: input.declaredCapabilities,
    credentialSourceIdentity: input.credentialSourceIdentity,
    persistentAuthorityPolicyVersion: input.persistentAuthorityPolicyVersion ?? CODEX_AUTHORITY_POLICY_VERSION,
    exclusiveLeasePolicyVersion: input.exclusiveLeasePolicyVersion ?? CODEX_CREDENTIAL_LEASE_POLICY_VERSION,
    stagedWritebackPolicyVersion: input.stagedWritebackPolicyVersion ?? CODEX_STAGED_WRITEBACK_POLICY_VERSION,
    runtimeIdentity: input.runtimeIdentity
  });
  return `sha256-ai-profile-v1:${createHash("sha256").update(identity).digest("hex")}`;
}

function defaultProfileAuthority(): CodexProfileRevisionAuthority {
  return {
    providerVersion: CODEX_APP_SERVER_CLI_VERSION, transport: "stdio-jsonl", threadSandbox: CODEX_THREAD_SANDBOX,
    turnSandboxPolicy: CODEX_TURN_SANDBOX_POLICY, networkAccess: CODEX_NETWORK_ACCESS, approvalPolicy: CODEX_APPROVAL_POLICY,
    declaredCapabilities: CODEX_CAPABILITIES, credentialSourceIdentity: CODEX_AUTH_CREDENTIAL_SOURCE_IDENTITY,
    persistentAuthorityPolicyVersion: CODEX_AUTHORITY_POLICY_VERSION,
    exclusiveLeasePolicyVersion: CODEX_CREDENTIAL_LEASE_POLICY_VERSION,
    stagedWritebackPolicyVersion: CODEX_STAGED_WRITEBACK_POLICY_VERSION, runtimeIdentity: null
  };
}

function profileRevision(): string { return codexProfileRevisionForAuthority(defaultProfileAuthority()); }

function profileAuthorityForContext(context: WorkspaceExecutionContext): CodexProfileRevisionAuthority {
  return {
    ...defaultProfileAuthority(),
    runtimeIdentity: {
      projectId: context.projectId, workspaceId: context.workspaceId, revisionId: context.revisionId,
      runtimePlanHash: context.runtimePlanHash, runtimeGeneration: context.generation
    }
  };
}

function profileRevisionForBinding(binding: AiSessionBinding): string {
  return codexProfileRevisionForAuthority({
    ...defaultProfileAuthority(),
    runtimeIdentity: {
      projectId: binding.projectId, workspaceId: binding.workspaceId, revisionId: binding.revisionId,
      runtimePlanHash: binding.runtimePlanHash, runtimeGeneration: binding.runtimeGeneration
    }
  });
}

function publicProfile(availability: AiProviderProfileProjection["availability"], authority = defaultProfileAuthority()): AiProviderProfileProjection {
  return aiProviderProfileProjectionSchema.parse({
    profileId: CODEX_PROFILE_ID,
    profileRevision: codexProfileRevisionForAuthority(authority),
    provider: CODEX_PROFILE_ID,
    displayName: "Codex",
    capabilities: CODEX_CAPABILITIES,
    availability
  });
}

function outboxPath(root: string, sessionId: string): string {
  return path.join(root, "ai-events", `${sessionId}.jsonl`);
}

async function readOutbox(root: string, sessionId: string): Promise<CanonicalAiEvent[]> {
  try {
    const text = await readFile(outboxPath(root, sessionId), "utf8");
    return text.split("\n").filter((line) => line.length > 0).map((line) => canonicalAiEventSchema.parse(JSON.parse(line)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

class CodexRequestFailure extends Error {
  constructor(readonly observation: CodexPrivateFailureObservation) { super("codex-json-rpc-request-failed"); }
}

function privateHttpStatus(value: unknown): number | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>).httpStatusCode;
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0 && candidate <= 65_535 ? candidate : null;
}

function codexPrivateFailureObservation(stage: CodexPrivateFailureObservation["stage"], value: unknown): CodexPrivateFailureObservation {
  const unknown = { stage, kind: "Unknown", httpStatusCode: null } as const;
  if (typeof value === "string") {
    const kind = ({
      contextWindowExceeded: "ContextWindowExceeded", sessionBudgetExceeded: "SessionBudgetExceeded", usageLimitExceeded: "UsageLimitExceeded",
      serverOverloaded: "ServerOverloaded", cyberPolicy: "CyberPolicy", internalServerError: "InternalServerError",
      unauthorized: "Unauthorized", badRequest: "BadRequest", threadRollbackFailed: "ThreadRollbackFailed", sandboxError: "SandboxError", other: "Other"
    } as const)[value];
    return kind === undefined ? unknown : { stage, kind, httpStatusCode: null };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return unknown;
  const record = value as Record<string, unknown>;
  const tagged = ([
    ["httpConnectionFailed", "HttpConnectionFailed"],
    ["responseStreamConnectionFailed", "ResponseStreamConnectionFailed"],
    ["responseStreamDisconnected", "ResponseStreamDisconnected"],
    ["responseTooManyFailedAttempts", "ResponseTooManyFailedAttempts"],
    ["activeTurnNotSteerable", "ActiveTurnNotSteerable"]
  ] as const).find(([key]) => key in record);
  return tagged === undefined ? unknown : { stage, kind: tagged[1], httpStatusCode: privateHttpStatus(record[tagged[0]]) };
}

function privateFailureFromError(error: unknown): CodexPrivateFailureObservation | null {
  return error instanceof CodexRequestFailure ? error.observation : null;
}

function safeErrorCode(error: unknown): "AI_PROVIDER_TRANSPORT_FAILURE" | "AI_PROVIDER_PROTOCOL_FAILURE" {
  const observation = privateFailureFromError(error);
  if (observation === null) return error instanceof SyntaxError ? "AI_PROVIDER_PROTOCOL_FAILURE" : "AI_PROVIDER_TRANSPORT_FAILURE";
  return observation.kind === "HttpConnectionFailed" || observation.kind === "ResponseStreamConnectionFailed" || observation.kind === "ResponseStreamDisconnected"
    ? "AI_PROVIDER_TRANSPORT_FAILURE" : "AI_PROVIDER_PROTOCOL_FAILURE";
}

function canonicalPath(value: string): string | null {
  if (value.startsWith("/") || value.includes("\\")) return null;
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return value;
}

function parseGitStatus(output: string): { files: Array<{ change: "added" | "modified" | "deleted" | "renamed" | "untracked"; path: string; oldPath: string | null }>; truncated: boolean } {
  const files: Array<{ change: "added" | "modified" | "deleted" | "renamed" | "untracked"; path: string; oldPath: string | null }> = [];
  let truncated = false;
  for (const line of output.split("\n").filter(Boolean)) {
    const status = line.slice(0, 2);
    const raw = line.slice(3);
    const rename = /^(.+) -> (.+)$/u.exec(raw);
    const pathValue = canonicalPath(rename?.[2] ?? raw);
    if (pathValue === null) continue;
    const oldPath = rename === null ? null : canonicalPath(rename[1]!);
    const change = rename !== null ? "renamed" : status.includes("??") ? "untracked"
      : status.includes("D") ? "deleted" : status.includes("A") ? "added" : "modified";
    if (oldPath === null && change === "renamed") continue;
    if (files.length >= MAX_GIT_PATHS) { truncated = true; break; }
    files.push({ change, path: pathValue, oldPath });
  }
  return { files, truncated };
}

async function gitSummary(worktreePath: string, before: Set<string>): Promise<ReturnType<typeof parseGitStatus>> {
  const result = await execFileAsync("/usr/bin/git", ["-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all"], {
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 2_000_000
  });
  const current = parseGitStatus(result.stdout);
  return { files: current.files.filter((file) => !before.has(`${file.change}:${file.path}:${file.oldPath ?? ""}`)), truncated: current.truncated };
}

async function gitBaseline(worktreePath: string): Promise<Set<string>> {
  const result = await execFileAsync("/usr/bin/git", ["-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all"], {
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 2_000_000
  });
  return new Set(parseGitStatus(result.stdout).files.map((file) => `${file.change}:${file.path}:${file.oldPath ?? ""}`));
}

class FakeProvider implements ProviderAdapter {
  private interrupted = false;
  private stopped = false;
  private releaseLongTurn: (() => void) | null = null;
  private longTurnTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly callbacks: AdapterCallbacks, private readonly worktreePath: string | null) {}
  async start(): Promise<void> { return; }
  async sendTurn(_turnId: string, text: string): Promise<void> {
    this.interrupted = false;
    this.stopped = false;
    if (text.includes("devspace-ai-beta-check.txt") && this.worktreePath !== null) {
      await writeFile(path.join(this.worktreePath, "devspace-ai-beta-check.txt"), "DevSpace AI beta check", { mode: 0o600 });
    }
    if (text === "long") {
      await this.callbacks.activity("Deterministic provider is inspecting the workspace.");
      await this.callbacks.outputDelta("I am still working on it.");
      await new Promise<void>((resolve) => {
        this.releaseLongTurn = resolve;
        this.longTurnTimer = setTimeout(resolve, 30_000);
        if (this.interrupted || this.stopped) resolve();
      });
      if (this.longTurnTimer !== null) clearTimeout(this.longTurnTimer);
      this.longTurnTimer = null; this.releaseLongTurn = null;
      await this.callbacks.completed(this.interrupted || this.stopped ? "interrupted" : "completed");
      return;
    }
    const chunks = ["Hello from the deterministic provider."];
    for (const chunk of chunks) {
      await new Promise((resolve) => setTimeout(resolve, 8));
      if (this.interrupted || this.stopped) return await this.callbacks.completed("interrupted");
      await this.callbacks.outputDelta(chunk);
    }
    await this.callbacks.completed("completed");
  }
  async interrupt(): Promise<void> { this.interrupted = true; this.releaseLongTurn?.(); }
  async stop(): Promise<ProviderFinalizationResult> {
    this.stopped = true; this.releaseLongTurn?.();
    return { state: "finalized", synchronization: "unchanged-valid" };
  }
}

type DockerExecStream = import("node:stream").Duplex;

async function waitForDockerExecClose(stream: DockerExecStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(new Error("codex-docker-exec-unproven"));
    }, CODEX_DOCKER_EXEC_TIMEOUT_MS);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener("close", onClose);
      stream.removeListener("error", onError);
      if (error !== undefined) reject(error); else resolve();
    };
    const onClose = () => finish();
    const onError = () => finish(new Error("codex-docker-exec-unproven"));
    stream.once("close", onClose);
    stream.once("error", onError);
  });
}

async function requireDockerExecSuccess(docker: DockerEngineClient, execId: string, stream: DockerExecStream, failureCode = "codex-docker-exec-failed"): Promise<void> {
  await waitForDockerExecClose(stream);
  const inspection = await docker.inspectExec(execId).catch(() => null);
  if (inspection === null || inspection.Running || inspection.ExitCode !== 0) throw new Error(failureCode);
}

class CodexProvider implements ProviderAdapter {
  private stream: import("node:stream").Duplex | null = null;
  private requestId = 0;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private buffer = "";
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private containerDir: string | null = null;
  private dockerBuffer = Buffer.alloc(0);
  private turnFailure: CodexPrivateFailureObservation | null = null;
  private providerExecId: string | null = null;
  private providerReady = false;
  private finalizationPromise: Promise<ProviderFinalizationResult> | null = null;
  private finalizationState: "active" | "finalizing" | "finalized" | "cleanup-unproven" = "active";
  private finalizationResult: ProviderFinalizationResult | null = null;
  private providerExitedProof: boolean | null = null;
  private stagingRemoved = false;
  private synchronizationResult: CredentialSynchronizationResult | null = null;
  private lease: Awaited<ReturnType<CodexCredentialAuthority["acquire"]>> | null = null;
  constructor(private readonly input: {
    readonly docker: DockerEngineClient;
    readonly ownership: WorkspaceExecutionContext;
    readonly executablePath: string;
    readonly sessionId: string;
    readonly processGeneration: number;
    readonly callbacks: AdapterCallbacks;
    readonly authority: CodexCredentialAuthority;
  }) {}
  async start(): Promise<void> {
    try {
      this.lease = await this.input.authority.acquire({
        aiSessionId: this.input.sessionId, workspaceId: this.input.ownership.workspaceId, processGeneration: this.input.processGeneration
      });
      const auth = await this.input.authority.read();
      const opaque = `${this.input.sessionId.replaceAll("-", "")}-${Date.now().toString(36)}`;
      const containerDir = `${PRIVATE_CONTAINER_ROOT}/${opaque}`;
      this.containerDir = containerDir;
      const executable = await readFile(this.input.executablePath);
      await this.runUpload(containerDir, executable, "codex");
      await this.runUpload(`${containerDir}/home`, Buffer.from(auth.bytes), "auth.json", { CODEX_HOME: `${containerDir}/home` });
      const execId = await this.input.docker.createExec(this.input.ownership.ownership.developmentContainer.id, {
        command: [`${containerDir}/codex`, "app-server", "--stdio"], workingDirectory: "/workspace",
        environment: { CODEX_HOME: `${containerDir}/home` }, attachStdin: true, tty: false
      });
      this.providerExecId = execId;
      this.stream = await this.input.docker.startExecAttached(execId, false);
      this.stream.on("data", (chunk: Buffer) => this.readDockerFrames(chunk));
      this.stream.on("error", () => this.rejectPending());
      this.stream.on("close", () => {
        this.rejectPending();
        if (this.finalizationState === "active") void this.input.callbacks.providerClosed();
      });
      await this.request("initialize", { clientInfo: { name: "devspace", title: "DevSpace", version: "1.0.0" } });
      this.write({ method: "initialized" });
      const thread = await this.request("thread/start", {
        cwd: "/workspace", approvalPolicy: CODEX_APPROVAL_POLICY, sandbox: CODEX_THREAD_SANDBOX
      }) as { thread?: { id?: string } };
      this.threadId = typeof thread.thread?.id === "string" ? thread.thread.id : null;
      if (this.threadId === null) throw new Error("codex-thread-id-missing");
      this.providerReady = true;
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }
  async sendTurn(_turnId: string, text: string): Promise<void> {
    if (this.threadId === null) throw new Error("codex-thread-not-started");
    this.turnFailure = null;
    const response = await this.request("turn/start", {
      threadId: this.threadId, input: [{ type: "text", text }],
      sandboxPolicy: { type: CODEX_TURN_SANDBOX_POLICY, networkAccess: CODEX_NETWORK_ACCESS }
    }) as { turn?: { id?: string } };
    this.turnId = typeof response.turn?.id === "string" ? response.turn.id : this.turnId;
  }
  async interrupt(): Promise<void> {
    if (this.threadId !== null && this.turnId !== null) await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
  }
  async stop(): Promise<ProviderFinalizationResult> {
    if (this.finalizationState === "finalized" && this.finalizationResult !== null) return this.finalizationResult;
    if (this.finalizationPromise !== null) return await this.finalizationPromise;
    this.finalizationState = "finalizing";
    const attempt = this.finalizeAttempt();
    const promise = attempt.then((result) => {
      this.finalizationState = result.state;
      this.finalizationResult = result.state === "finalized" ? result : null;
      return result;
    }, (error) => {
      this.finalizationState = "cleanup-unproven";
      throw error;
    });
    this.finalizationPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.finalizationPromise === promise) this.finalizationPromise = null;
    }
  }
  private async finalizeAttempt(): Promise<ProviderFinalizationResult> {
    await Promise.race([
      this.interrupt().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 250))
    ]);
    const stream = this.stream;
    if (stream !== null && !stream.destroyed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        stream.once("close", () => { clearTimeout(timer); resolve(); });
        stream.once("error", () => { clearTimeout(timer); resolve(); });
      });
      if (!stream.destroyed) stream.destroy();
    }
    this.stream = null;
    if (this.providerExitedProof !== true) {
      this.providerExitedProof = this.providerExecId === null;
      if (this.providerExecId !== null && !this.providerExitedProof) {
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          const inspection = await this.input.docker.inspectExec(this.providerExecId).catch(() => null);
          if (inspection !== null && !inspection.Running && inspection.ExitCode !== null) {
            this.providerExitedProof = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    }
    if (this.providerExitedProof !== true) return this.cleanupUnprovenResult();
    if (this.providerReady && this.synchronizationResult === null && this.containerDir !== null) {
      try {
        await this.input.authority.synchronizeStaged({
          docker: this.input.docker, containerId: this.input.ownership.ownership.developmentContainer.id,
          stagedAuthPath: `${this.containerDir}/home/auth.json`
        });
        this.synchronizationResult = "synchronized";
      } catch {
        try {
          await this.input.authority.markReauthenticationRequired();
          this.synchronizationResult = "rejected-and-reauth-required";
        } catch {
          return this.cleanupUnprovenResult();
        }
      }
    }
    if (!this.stagingRemoved && this.containerDir !== null) {
      if (!await this.removeContainerDir(this.containerDir)) return this.cleanupUnprovenResult();
      this.stagingRemoved = true;
      this.containerDir = null;
    }
    if (this.lease !== null) {
      try {
        await this.lease.release();
        this.lease = null;
      } catch {
        return this.cleanupUnprovenResult();
      }
    }
    return { state: "finalized", synchronization: this.synchronizationResult ?? "unchanged-valid" };
  }
  private cleanupUnprovenResult(): ProviderFinalizationResult {
    return {
      state: "cleanup-unproven",
      providerExited: this.providerExitedProof === true,
      stagingRemoved: this.stagingRemoved,
      leaseReleased: this.lease === null
    };
  }
  private async removeContainerDir(directory: string): Promise<boolean> {
    try {
      const execId = await this.input.docker.createExec(this.input.ownership.ownership.developmentContainer.id, {
        command: ["sh", "-c", 'rm -rf -- "$DEVSPACE_TARGET_DIR"'], workingDirectory: "/workspace",
        environment: { DEVSPACE_TARGET_DIR: directory }, attachStdin: false, tty: false
      });
      const stream = await this.input.docker.startExecAttached(execId, false);
      stream.resume();
      await requireDockerExecSuccess(this.input.docker, execId, stream, "codex-cleanup-exec-failed");
      return true;
    } catch { /* cleanup is best effort after the provider attachment is gone */ return false; }
  }
  private async runUpload(directory: string, data: Buffer, name: string, environment: Record<string, string> = {}): Promise<void> {
    const mode = name === "auth.json" ? "600" : "700";
    const command = ["sh", "-c", `umask 077; mkdir -p "$DEVSPACE_TARGET_DIR"; cat > "$DEVSPACE_TARGET_DIR/$DEVSPACE_TARGET_NAME"; chmod ${mode} "$DEVSPACE_TARGET_DIR/$DEVSPACE_TARGET_NAME"`];
    const execId = await this.input.docker.createExec(this.input.ownership.ownership.developmentContainer.id, {
      command, workingDirectory: "/workspace", environment: { DEVSPACE_TARGET_DIR: directory, DEVSPACE_TARGET_NAME: name, ...environment }, attachStdin: true, tty: false
    });
    const stream = await this.input.docker.startExecAttached(execId, false);
    stream.end(data);
    await requireDockerExecSuccess(this.input.docker, execId, stream, "codex-upload-exec-failed");
  }
  private write(value: unknown): void { this.stream?.write(`${JSON.stringify(value)}\n`); }
  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id); pending.reject(new Error("codex-request-timeout"));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.write({ id, method, params });
    });
  }
  private rejectPending(): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timeout);
      request.reject(new Error("codex-provider-stream-closed"));
    }
  }
  private readDockerFrames(chunk: Buffer): void {
    this.dockerBuffer = Buffer.concat([this.dockerBuffer, chunk]);
    let offset = 0;
    while (offset + 8 <= this.dockerBuffer.length) {
      const size = this.dockerBuffer.readUInt32BE(offset + 4);
      if (offset + 8 + size > this.dockerBuffer.length) break;
      const streamType = this.dockerBuffer[offset]; const payload = this.dockerBuffer.subarray(offset + 8, offset + 8 + size).toString("utf8"); offset += 8 + size;
      if (streamType !== 1) continue;
      this.buffer += payload;
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1); newline = this.buffer.indexOf("\n");
        if (line.length > 0) this.handle(JSON.parse(line) as Record<string, unknown>);
      }
    }
    this.dockerBuffer = this.dockerBuffer.subarray(offset);
  }
  private handle(message: Record<string, unknown>): void {
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (pending !== undefined) {
        this.pending.delete(message.id); clearTimeout(pending.timeout);
        if ("error" in message) {
          const error = message.error;
          const detail = error !== null && typeof error === "object" ? (error as Record<string, unknown>).codexErrorInfo : null;
          const observation = codexPrivateFailureObservation("request", detail);
          if (observation.kind === "Unauthorized") void this.input.authority.markReauthenticationRequired().catch(() => undefined);
          pending.reject(new CodexRequestFailure(observation));
        }
        else pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string" || message.params === null || typeof message.params !== "object") return;
    const method = message.method;
    const params = message.params as Record<string, unknown>;
    if (method === "error") {
      const error = params.error;
      const detail = error !== null && typeof error === "object" ? (error as Record<string, unknown>).codexErrorInfo : null;
      if (this.turnFailure === null) this.turnFailure = codexPrivateFailureObservation("turn", detail);
      if (this.turnFailure.kind === "Unauthorized") void this.input.authority.markReauthenticationRequired().catch(() => undefined);
      this.input.callbacks.privateFailure(this.turnFailure);
    }
    else if (method === "item/agentMessage/delta" && typeof params.delta === "string") void this.input.callbacks.outputDelta(params.delta);
    else if (method === "item/started") void this.input.callbacks.activity("Provider activity started.");
    else if (method === "turn/completed") {
      const turn = params.turn; const turnRecord = turn !== null && typeof turn === "object" ? turn as Record<string, unknown> : null;
      const status = turnRecord?.status;
      if (status === "failed") {
        if (this.turnFailure === null) this.turnFailure = codexPrivateFailureObservation("turn", (turnRecord?.error as Record<string, unknown> | undefined)?.codexErrorInfo);
        if (this.turnFailure.kind === "Unauthorized") void this.input.authority.markReauthenticationRequired().catch(() => undefined);
        void this.input.callbacks.failed(this.turnFailure);
        this.turnFailure = null;
      } else void this.input.callbacks.completed(status === "interrupted" ? "interrupted" : "completed");
    }
  }
}

async function verifyCodexExecutable(executablePath: string): Promise<void> {
  const executable = await readFile(executablePath);
  const digest = createHash("sha256").update(executable).digest("hex");
  if (digest !== CODEX_EXECUTABLE_SHA256) throw new Error("codex-executable-integrity-mismatch");
}

function bindingMatches(left: AiSessionBinding, right: AiSessionBinding): boolean {
  return left.projectId === right.projectId && left.workspaceId === right.workspaceId && left.aiSessionId === right.aiSessionId
    && left.revisionId === right.revisionId && left.runtimePlanHash === right.runtimePlanHash && left.runtimeGeneration === right.runtimeGeneration
    && left.profileId === right.profileId && left.profileRevision === right.profileRevision;
}

export function createAiSessionRuntime(options: AiSessionRuntimeOptions = {}): AiSessionRuntime {
  const mode = options.mode ?? "codex";
  const stateRoot = options.stateRoot ?? "/srv/devspace/state";
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? uuidv7;
  const sessions = new Map<string, SessionRecord>();
  const docker = options.docker ?? new DockerEngineClient(process.env.DEVSPACE_DOCKER_SOCKET_PATH ?? defaultRootlessDockerSocketPath());

  async function recordFor(binding: AiSessionBinding | AiProcessBinding): Promise<SessionRecord> {
    const existing = sessions.get(binding.aiSessionId);
    if (existing !== undefined) {
      if (existing.binding.projectId !== binding.projectId || existing.binding.workspaceId !== binding.workspaceId || existing.binding.profileId !== binding.profileId
        || existing.binding.profileRevision !== binding.profileRevision
        || ("processGeneration" in binding && existing.processGeneration !== binding.processGeneration)) throw new Error("ai-identity-mismatch");
      return existing;
    }
    if (!("revisionId" in binding)) throw new Error("ai-session-not-started");
    const events = await readOutbox(stateRoot, binding.aiSessionId);
    const record: SessionRecord = {
      binding, processGeneration: 1, events, listeners: new Set(), turnBaselines: new Map(), privateFailures: new Map(), adapter: null, activeTurnId: null,
      nextSequence: (events.at(-1)?.sequence ?? 0) + 1, acknowledgedThrough: 0, eventChain: Promise.resolve(), finalizationPromise: null,
      finalizationState: "active", finalizationReason: null, stoppingEmitted: false
    };
    sessions.set(binding.aiSessionId, record); return record;
  }

  async function emit(record: SessionRecord, turnId: string | null, eventType: string, payload: unknown): Promise<CanonicalAiEvent> {
    let event: CanonicalAiEvent | undefined;
    const previous = record.eventChain;
    const current = previous.then(async () => {
      event = canonicalAiEventSchema.parse({ schemaVersion: "devspace.ai-event/v1", eventId: createId(), sessionId: record.binding.aiSessionId,
        turnId, sequence: record.nextSequence++, observedAt: now().toISOString(), profile: {
          profileId: CODEX_PROFILE_ID,
          profileRevision: mode === "codex" ? profileRevisionForBinding(record.binding) : profileRevision(),
          provider: CODEX_PROFILE_ID
        },
        processGeneration: record.processGeneration, eventType, payload });
      await mkdir(path.dirname(outboxPath(stateRoot, record.binding.aiSessionId)), { recursive: true, mode: 0o700 });
      await appendFile(outboxPath(stateRoot, record.binding.aiSessionId), `${JSON.stringify(event)}\n`, { mode: 0o600 });
      record.events.push(event); if (record.events.length > MAX_OUTBOX_EVENTS) record.events.splice(0, record.events.length - MAX_OUTBOX_EVENTS);
      for (const listener of record.listeners) listener(event);
    });
    record.eventChain = current.then(() => undefined, () => undefined);
    await current;
    return event!;
  }

  function rememberPrivateFailure(record: SessionRecord, turnId: string, observation: CodexPrivateFailureObservation): CodexPrivateFailureObservation {
    const existing = record.privateFailures.get(turnId);
    if (existing !== undefined) return existing;
    record.privateFailures.set(turnId, observation);
    try { options.onPrivateFailureObservation?.(observation); } catch { /* diagnostics never alter provider lifecycle */ }
    return observation;
  }

  async function failTurn(record: SessionRecord, turnId: string, observation: CodexPrivateFailureObservation): Promise<void> {
    if (record.activeTurnId !== turnId) return;
    const selected = rememberPrivateFailure(record, turnId, observation);
    record.activeTurnId = null; record.turnBaselines.delete(turnId); record.privateFailures.delete(turnId);
    const code = safeErrorCode(new CodexRequestFailure(selected));
    await emit(record, turnId, "turn.failed", { failure: { code, category: code === "AI_PROVIDER_PROTOCOL_FAILURE" ? "protocol-failure" : "transport-failure", incidentId: createId() } });
    await finalizeRecord(record, "provider-exited");
  }

  async function finalizeRecord(record: SessionRecord, reason: "user-request" | "provider-exited"): Promise<void> {
    if (record.finalizationState === "finalized") return;
    if (record.finalizationPromise !== null) {
      await record.finalizationPromise;
      return;
    }
    const adapter = record.adapter;
    if (adapter === null) return;
    record.finalizationReason ??= reason;
    record.finalizationState = "finalizing";
    const finalizationReason = record.finalizationReason;
    const attempt = (async () => {
      if (!record.stoppingEmitted) {
        record.stoppingEmitted = true;
        await emit(record, null, "session.stopping", { reason: finalizationReason === "user-request" ? "user-request" : "runtime-stopping" });
      }
      const result = await adapter.stop();
      if (result.state !== "finalized") throw new ProviderFinalizationUnprovenError();
      record.adapter = null;
      record.finalizationState = "finalized";
      await emit(record, null, "session.stopped", { reason: finalizationReason === "user-request" ? "user-request" : "provider-exited" });
      return result;
    })();
    const promise = attempt.then((result) => result, (error) => {
      record.finalizationState = "cleanup-unproven";
      throw error;
    });
    record.finalizationPromise = promise;
    try {
      await promise;
    } finally {
      if (record.finalizationPromise === promise) record.finalizationPromise = null;
    }
  }

  const runtime: AiSessionRuntime = {
    async inspect(input) {
      if (input.profileId !== CODEX_PROFILE_ID) throw new Error("ai-profile-not-found");
      if (mode === "fake") return publicProfile({ state: "available" });
      if (options.managed === undefined) return publicProfile({ state: "unavailable", code: "RUNTIME_IDENTITY_UNAVAILABLE" });
      let authority = defaultProfileAuthority();
      try {
        const context = await options.managed.executionContext(input.projectId, input.workspaceId);
        authority = profileAuthorityForContext(context);
        if (options.codexPreflight !== undefined) await options.codexPreflight();
        else {
          const executablePath = options.executablePath ?? "/home/benjamin/.local/bin/codex";
          await verifyCodexExecutable(executablePath);
          const result = await execFileAsync(executablePath, ["--version"], { maxBuffer: 1024 });
          if (result.stdout.trim() !== CODEX_APP_SERVER_VERSION_OUTPUT) return publicProfile({ state: "unavailable", code: "VERSION_MISMATCH" });
        }
        await (options.codexCredentialAuthority ?? createCodexCredentialAuthority(stateRoot)).inspect();
        return publicProfile({ state: "available" }, authority);
      } catch (error) {
        if (error instanceof Error && error.message.includes("credential")) return publicProfile({ state: "unavailable", code: "CREDENTIAL_SOURCE_UNAVAILABLE" }, authority);
        if (error instanceof Error && error.message.includes("identity")) return publicProfile({ state: "unavailable", code: "RUNTIME_IDENTITY_UNAVAILABLE" }, authority);
        if (error instanceof Error && error.message.includes("integrity")) return publicProfile({ state: "unavailable", code: "VERSION_MISMATCH" }, authority);
        return publicProfile({ state: "unavailable", code: "EXECUTABLE_MISSING" }, authority);
      }
    },
    async start(binding) {
      const record = await recordFor(binding);
      if (record.adapter !== null) return;
      if (mode === "codex" && binding.profileRevision !== profileRevisionForBinding(binding)) throw new Error("ai-profile-revision-mismatch");
      const profile = await runtime.inspect(binding);
      if (profile.availability.state !== "available" || (mode === "codex" && profile.profileRevision !== binding.profileRevision)) throw new Error("ai-profile-unavailable");
      const callbacks: AdapterCallbacks = {
        outputDelta: async (text) => { await emit(record, record.activeTurnId, "turn.output.delta", { stream: "assistant", text }); },
        activity: async (summary) => { const activityId = createId(); await emit(record, record.activeTurnId, "turn.activity.started", { activityId, presentation: { kind: "analysis", summary } });
          await emit(record, record.activeTurnId, "turn.activity.completed", { activityId, outcome: "succeeded" }); },
        completed: async (outcome) => {
          if (record.activeTurnId === null) return;
          const turnId = record.activeTurnId; if (outcome === "interrupted") await emit(record, turnId, "turn.interrupted", { reason: "provider-confirmed" });
          await emit(record, turnId, "turn.provider-completed", { outcome });
          if (options.managed !== undefined) {
            const ctx = await options.managed.executionContext(binding.projectId, binding.workspaceId).catch(() => null);
            if (ctx !== null) {
              const before = record.turnBaselines.get(turnId) ?? new Set();
              const summary = await gitSummary(ctx.ownership.worktreePath, before).catch(() => ({ files: [], truncated: false }));
              await emit(record, turnId, "turn.files.changed", summary);
            }
          } else await emit(record, turnId, "turn.files.changed", { files: [], truncated: false });
          await emit(record, turnId, "turn.quiesced", { outcome }); record.turnBaselines.delete(turnId); record.activeTurnId = null;
        },
        privateFailure: (observation) => {
          if (record.activeTurnId !== null) rememberPrivateFailure(record, record.activeTurnId, observation);
        },
        failed: async (observation) => {
          if (record.activeTurnId !== null) await failTurn(record, record.activeTurnId, observation).catch(() => undefined);
        },
        providerClosed: async () => { await finalizeRecord(record, "provider-exited").catch(() => undefined); }
      };
      let adapter: ProviderAdapter;
      if (mode === "fake") {
        const worktreePath = options.managed === undefined ? null : (await options.managed.executionContext(binding.projectId, binding.workspaceId)).ownership.worktreePath;
        adapter = new FakeProvider(callbacks, worktreePath);
      } else {
        if (options.managed === undefined) throw new Error("runtime-identity-unavailable");
        if (options.codexPreflight === undefined) await verifyCodexExecutable(options.executablePath ?? "/home/benjamin/.local/bin/codex");
        const ownership = await options.managed.executionContext(binding.projectId, binding.workspaceId);
        adapter = new CodexProvider({ docker, ownership, executablePath: options.executablePath ?? "/home/benjamin/.local/bin/codex", sessionId: binding.aiSessionId, processGeneration: record.processGeneration, callbacks,
          authority: options.codexCredentialAuthority ?? createCodexCredentialAuthority(stateRoot) });
      }
      record.adapter = adapter;
      await emit(record, null, "session.started", { processGeneration: record.processGeneration });
      try {
        await adapter.start();
        await emit(record, null, "session.ready", {});
      } catch (error) {
        const finalization = await adapter.stop().catch(() => null);
        if (finalization?.state === "finalized") record.adapter = null;
        throw error;
      }
    },
    async sendTurn(input) {
      const record = await recordFor(input); if (record.adapter === null) throw new Error("ai-session-not-started");
      if (record.activeTurnId !== null) throw new Error("ai-turn-state-conflict");
      if (options.managed !== undefined) {
        const context = await options.managed.executionContext(input.projectId, input.workspaceId);
        record.turnBaselines.set(input.turnId, await gitBaseline(context.ownership.worktreePath).catch(() => new Set()));
      } else record.turnBaselines.set(input.turnId, new Set());
      record.activeTurnId = input.turnId; await emit(record, input.turnId, "turn.accepted", { content: input.content }); await emit(record, input.turnId, "turn.started", {});
      void record.adapter.sendTurn(input.turnId, input.content.text).catch(async (error) => {
        await failTurn(record, input.turnId, privateFailureFromError(error) ?? { stage: "request", kind: "Unknown", httpStatusCode: null });
      });
    },
    async interrupt(input) {
      const record = await recordFor(input); if (record.adapter === null || record.activeTurnId !== input.turnId) throw new Error("ai-turn-state-conflict");
      await emit(record, input.turnId, "turn.interrupt.requested", {}); await record.adapter.interrupt();
    },
    async stop(input) {
      const record = await recordFor(input); await finalizeRecord(record, "user-request");
    },
    async replay(sessionId, afterSequence) {
      aiAfterSequenceSchema.parse(afterSequence);
      const record = sessions.get(sessionId); let events = record?.events ?? await readOutbox(stateRoot, sessionId);
      if (record === undefined && events.length > 0) {
        const last = events.at(-1)!;
        const terminal = last.eventType === "session.stopped" || last.eventType === "session.lost";
        if (!terminal) {
          const lost = canonicalAiEventSchema.parse({ schemaVersion: "devspace.ai-event/v1", eventId: createId(), sessionId,
            turnId: null, sequence: last.sequence + 1, observedAt: now().toISOString(), profile: last.profile,
            processGeneration: last.processGeneration, eventType: "session.lost", payload: { code: "AGENT_RESTART" } });
          await mkdir(path.dirname(outboxPath(stateRoot, sessionId)), { recursive: true, mode: 0o700 });
          await appendFile(outboxPath(stateRoot, sessionId), `${JSON.stringify(lost)}\n`, { mode: 0o600 });
          events = [...events, lost];
        }
      }
      return events.filter((event) => event.sequence > afterSequence);
    },
    async subscribe(sessionId, afterSequence, listener) {
      const record = sessions.get(sessionId); if (record === undefined) { await runtime.replay(sessionId, afterSequence); return () => undefined; }
      for (const event of record.events.filter((candidate) => candidate.sequence > afterSequence)) listener(event);
      record.listeners.add(listener); return () => { record.listeners.delete(listener); };
    },
    async acknowledge(sessionId, throughSequence) {
      aiAfterSequenceSchema.parse(throughSequence);
      const record = sessions.get(sessionId);
      if (record === undefined) return;
      if (throughSequence >= record.nextSequence) throw new Error("ai-acknowledgement-ahead-of-outbox");
      record.acknowledgedThrough = Math.max(record.acknowledgedThrough, throughSequence);
      if (record.events.length <= ACK_RETAINED_EVENTS) return;
      const retainFrom = Math.max(1, record.acknowledgedThrough - ACK_RETAINED_EVENTS + 1);
      const retained = record.events.filter((event) => event.sequence >= retainFrom || event.sequence > record.acknowledgedThrough);
      record.events.splice(0, record.events.length, ...retained);
      await writeFile(outboxPath(stateRoot, sessionId), retained.map((event) => JSON.stringify(event)).join("\n") + (retained.length === 0 ? "" : "\n"), { mode: 0o600 });
    },
    async collect(sessionId, afterSequence, waitMs) { await new Promise((resolve) => setTimeout(resolve, waitMs)); return await runtime.replay(sessionId, afterSequence); }
  };
  return runtime;
}

export { AI_EVENT_NDJSON_CONTENT_TYPE, CODEX_EXECUTABLE_SHA256, CODEX_PROFILE_ID, CODEX_APP_SERVER_CLI_VERSION };
