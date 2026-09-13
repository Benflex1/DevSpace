import { AI_OUTPUT_DELTA_MAX_BYTES, AI_OUTPUT_ITEM_MAX_BYTES, type CodexCapabilitySet, type CodexCompatibilityDiagnostic } from "@devspace/contracts";
import { DockerEngineClient } from "../docker-runtime.js";
import type { WorkspaceExecutionContext } from "../managed-workspaces.js";
import type { CodexCredentialAuthority } from "../codex-credential-authority.js";
import type { CodexArtifactStager, CodexLaunchArtifact } from "./artifact-stager.js";
import { createCodexJsonlTransport } from "./transport.js";
import {
  encodeCodexApprovalResponse,
  encodeCodexInputResponse,
  parseCodexServerInteractionRequest,
  projectCodexApprovalRequest,
  projectCodexFileChangeItem,
  projectCodexInputRequest,
  type CodexFileChangeItem,
  type CodexInteractionProjection
} from "./interactions.js";
import { classifyCodexNotification } from "./notifications.js";

const PRIVATE_CONTAINER_ROOT = "/tmp/devspace-ai";
const CODEX_DOCKER_EXEC_TIMEOUT_MS = 5_000;
const CODEX_PROTOCOL_JSON_OVERHEAD_BYTES = 64 * 1024;
const CODEX_MAX_NATIVE_JSON_MESSAGE_BYTES = AI_OUTPUT_ITEM_MAX_BYTES + CODEX_PROTOCOL_JSON_OVERHEAD_BYTES;
const CODEX_MAX_DOCKER_FRAME_PAYLOAD_BYTES = CODEX_MAX_NATIVE_JSON_MESSAGE_BYTES + 8 * 1024;
const CODEX_MAX_DOCKER_PARTIAL_BUFFER_BYTES = 8 + CODEX_MAX_DOCKER_FRAME_PAYLOAD_BYTES;
const CODEX_MAX_NATIVE_NOTIFICATIONS = 256;
const CODEX_NOTIFICATION_DRAIN_TIMEOUT_MS = 1_000;
const CODEX_EXPERIMENTAL_API = true as const;
const CODEX_THREAD_SANDBOX = "danger-full-access" as const;
const CODEX_TURN_SANDBOX_POLICY = "externalSandbox" as const;
const CODEX_NETWORK_ACCESS = "enabled" as const;

export type CodexPrivateFailureObservation = Readonly<{
  stage: "request" | "turn";
  protocolFailure?: true;
  diagnostic?: CodexCompatibilityDiagnostic;
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

export type AiStructuredInputAnswer =
  | Readonly<{ questionId: string; kind: "selected"; optionId: string }>
  | Readonly<{ questionId: string; kind: "text"; text: string }>
  | Readonly<{ questionId: string; kind: "other"; text: string }>;
export type AiInteractionDecision = "approve-once" | "approve-for-session" | "deny" | "cancel";

export type CredentialSynchronizationResult = "synchronized" | "unchanged-valid" | "rejected-and-reauth-required";
export type ProviderFinalizationResult =
  | { readonly state: "finalized"; readonly synchronization: CredentialSynchronizationResult }
  | { readonly state: "cleanup-unproven"; readonly providerExited: boolean; readonly stagingRemoved: boolean; readonly leaseReleased: boolean };

export interface AdapterCallbacks {
  readonly outputDelta: (text: string) => Promise<void>;
  readonly activity: (summary: string) => Promise<void>;
  readonly interactionRequested: (projection: CodexInteractionProjection) => Promise<void>;
  readonly interactionResolved: (requestId: string, cause: "provider-resolved" | "provider-expired") => Promise<void>;
  readonly completed: (outcome: "completed" | "interrupted" | "failed") => Promise<void>;
  readonly providerIncompatible: (diagnostic: CodexCompatibilityDiagnostic) => Promise<void>;
  readonly privateFailure: (observation: CodexPrivateFailureObservation) => void;
  readonly failed: (observation: CodexPrivateFailureObservation) => Promise<void>;
  readonly providerClosed: () => Promise<void>;
}

export interface ProviderAdapter {
  start(): Promise<void>;
  sendTurn(turnId: string, text: string): Promise<void>;
  interrupt(): Promise<void>;
  respondToApproval(requestId: string, decision: AiInteractionDecision): Promise<void>;
  respondToStructuredInput(requestId: string, answers: readonly AiStructuredInputAnswer[]): Promise<void>;
  pendingInteractionIds(): readonly string[];
  retireInteractions(turnId: string): void;
  stop(): Promise<ProviderFinalizationResult>;
}

export class CodexRequestFailure extends Error {
  constructor(readonly observation: CodexPrivateFailureObservation) { super("codex-json-rpc-request-failed"); }
}

function privateHttpStatus(value: unknown): number | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>).httpStatusCode;
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0 && candidate <= 65_535 ? candidate : null;
}

export function codexPrivateFailureObservation(stage: CodexPrivateFailureObservation["stage"], value: unknown): CodexPrivateFailureObservation {
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

export function privateFailureFromError(error: unknown): CodexPrivateFailureObservation | null {
  return error instanceof CodexRequestFailure ? error.observation : null;
}

export function stablePrivateJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stablePrivateJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stablePrivateJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
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

export class CodexProvider implements ProviderAdapter {
  private stream: import("node:stream").Duplex | null = null;
  private requestId = 0;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private devspaceTurnId: string | null = null;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private pendingInteractions = new Map<string, {
    readonly projection: CodexInteractionProjection;
    readonly request: ReturnType<typeof parseCodexServerInteractionRequest>;
    state: "pending" | "response-attempted";
  }>();
  private fileChangeItems = new Map<string, CodexFileChangeItem>();
  private containerDir: string | null = null;
  private transport: ReturnType<typeof createCodexJsonlTransport> | null = null;
  private notificationChain = Promise.resolve();
  private notificationQueueLength = 0;
  private protocolFailureClaimed = false;
  private protocolFailureObservation: CodexPrivateFailureObservation | null = null;
  private nativeTurnState: "idle" | "active" | "terminal-claimed" | "terminal-delivered" = "idle";
  private terminalFingerprint: string | null = null;
  private streamClosePromise: Promise<void> | null = null;
  private providerClosedNotified = false;
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
    readonly artifactStager: CodexArtifactStager | undefined;
    readonly launchArtifact: CodexLaunchArtifact | undefined;
    readonly sessionId: string;
    readonly processGeneration: number;
    readonly readbackHelperBytes: Buffer;
    readonly callbacks: AdapterCallbacks;
    readonly authority: CodexCredentialAuthority;
    readonly createId: () => string;
    readonly capabilities: CodexCapabilitySet;
    readonly experimentalApi: boolean;
    readonly approvalPolicy: "on-request";
    readonly approvalsReviewer: "user";
  }) {}
  async start(): Promise<void> {
    try {
      this.lease = await this.input.authority.acquire({
        aiSessionId: this.input.sessionId, workspaceId: this.input.ownership.workspaceId, processGeneration: this.input.processGeneration
      });
      const auth = await this.input.authority.read();
      const opaque = `${this.input.sessionId.replaceAll("-", "")}-${Date.now().toString(36)}`;
      let containerDir: string;
      let executablePath: string;
      if (this.input.artifactStager !== undefined && this.input.launchArtifact !== undefined) {
        const staged = await this.input.artifactStager.stageIntoManagedProvider({
          containerId: this.input.ownership.ownership.developmentContainer.id,
          launchArtifact: this.input.launchArtifact,
          sessionId: this.input.sessionId,
          processGeneration: this.input.processGeneration
        });
        containerDir = staged.containerRoot;
        executablePath = staged.entrypointPath;
      } else {
        containerDir = `${PRIVATE_CONTAINER_ROOT}/${opaque}`;
        executablePath = `${containerDir}/codex`;
        this.containerDir = containerDir;
        const executable = Buffer.from("deterministic codex adapter fixture");
        await this.runUpload(containerDir, executable, "codex");
      }
      this.containerDir = containerDir;
      await this.runUpload(containerDir, this.input.readbackHelperBytes, "staged-readback-helper");
      await this.runUpload(`${containerDir}/home`, Buffer.from(auth.bytes), "auth.json", { CODEX_HOME: `${containerDir}/home` });
      const execId = await this.input.docker.createExec(this.input.ownership.ownership.developmentContainer.id, {
        command: [executablePath, "app-server", "--stdio"], workingDirectory: "/workspace",
        environment: { CODEX_HOME: `${containerDir}/home` }, attachStdin: true, tty: false
      });
      this.providerExecId = execId;
      this.stream = await this.input.docker.startExecAttached(execId, false);
      this.transport = createCodexJsonlTransport({
        stream: this.stream,
        onMessage: (message) => { this.classifyMessage(message); },
        onProtocolFailure: () => { this.failProtocolOnce(); },
        maxJsonMessageBytes: CODEX_MAX_NATIVE_JSON_MESSAGE_BYTES,
        maxFramePayloadBytes: CODEX_MAX_DOCKER_FRAME_PAYLOAD_BYTES,
        maxPartialBufferBytes: CODEX_MAX_DOCKER_PARTIAL_BUFFER_BYTES
      });
      this.stream.on("data", (chunk: Buffer) => { this.transport?.receiveDockerData(chunk); });
      this.stream.on("error", () => { this.rejectPending(new Error("codex-provider-stream-error")); });
      this.stream.on("close", () => { this.streamClosePromise = this.handleStreamClose(); void this.streamClosePromise.catch(() => undefined); });
      const initialized = await this.request("initialize", {
        clientInfo: { name: "devspace", title: "DevSpace", version: "1.0.0" },
        capabilities: this.input.experimentalApi ? { experimentalApi: CODEX_EXPERIMENTAL_API } : {}
      });
      if (this.objectRecord(initialized) === null) {
        this.failProtocolOnce();
        throw new CodexRequestFailure(this.protocolFailureObservation ?? this.protocolObservation("request"));
      }
      this.write({ method: "initialized" });
      const thread = await this.request("thread/start", {
        cwd: "/workspace", approvalPolicy: this.input.approvalPolicy, approvalsReviewer: this.input.approvalsReviewer, sandbox: CODEX_THREAD_SANDBOX
      });
      const threadRecord = this.objectRecord(thread);
      const threadValue = threadRecord === null ? null : this.objectRecord(threadRecord.thread);
      this.threadId = threadValue !== null && typeof threadValue.id === "string" ? threadValue.id : null;
      if (this.threadId === null) {
        this.failProtocolOnce();
        throw new CodexRequestFailure(this.protocolFailureObservation ?? this.protocolObservation("request"));
      }
      this.providerReady = true;
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }
  async sendTurn(_turnId: string, text: string): Promise<void> {
    if (this.threadId === null) throw new Error("codex-thread-not-started");
    this.fileChangeItems.clear();
    this.turnFailure = null;
    const response = await this.request("turn/start", {
      threadId: this.threadId, input: [{ type: "text", text }],
      sandboxPolicy: { type: CODEX_TURN_SANDBOX_POLICY, networkAccess: CODEX_NETWORK_ACCESS }
    });
    const responseRecord = this.objectRecord(response);
    const turnRecord = responseRecord === null ? null : this.objectRecord(responseRecord.turn);
    const nativeTurnId = turnRecord !== null && typeof turnRecord.id === "string" ? turnRecord.id : null;
    if (nativeTurnId === null || this.nativeTurnState === "active" || this.nativeTurnState === "terminal-claimed") {
      this.failProtocolOnce();
      throw new CodexRequestFailure(this.protocolFailureObservation ?? this.protocolObservation("request"));
    }
    this.turnId = nativeTurnId;
    this.devspaceTurnId = _turnId;
    this.nativeTurnState = "active";
    this.terminalFingerprint = null;
  }
  async interrupt(): Promise<void> {
    if (this.threadId !== null && this.turnId !== null && this.nativeTurnState === "active") {
      await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    }
  }
  async respondToApproval(requestId: string, decision: AiInteractionDecision): Promise<void> {
    const pending = this.pendingInteractions.get(requestId);
    if (pending === undefined || pending.state !== "pending" || pending.projection.kind !== "approval") {
      throw new Error("ai-interaction-state-conflict");
    }
    pending.state = "response-attempted";
    try {
      const request = pending.request;
      if (request === null) throw new Error("ai-interaction-state-conflict");
      this.write({ id: request.nativeRequestId, result: encodeCodexApprovalResponse(request, decision) });
    } catch (error) {
      throw error instanceof Error ? error : new Error("ai-interaction-response-ambiguous");
    }
  }
  async respondToStructuredInput(requestId: string, answers: ReadonlyArray<AiStructuredInputAnswer>): Promise<void> {
    const pending = this.pendingInteractions.get(requestId);
    if (pending === undefined || pending.state !== "pending" || pending.projection.kind !== "input") {
      throw new Error("ai-interaction-state-conflict");
    }
    pending.state = "response-attempted";
    try {
      this.write({ id: pending.projection.mapping.binding.nativeRequestId, result: encodeCodexInputResponse(pending.projection.mapping, answers) });
    } catch (error) {
      throw error instanceof Error ? error : new Error("ai-interaction-response-ambiguous");
    }
  }
  pendingInteractionIds(): readonly string[] {
    return [...this.pendingInteractions.entries()]
      .filter(([, pending]) => pending.state === "pending")
      .map(([requestId]) => requestId);
  }
  retireInteractions(turnId: string): void {
    for (const [requestId, pending] of this.pendingInteractions.entries()) {
      if (pending.projection.turnId === turnId) this.pendingInteractions.delete(requestId);
    }
    this.fileChangeItems.clear();
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
          stagedAuthPath: `${this.containerDir}/home/auth.json`, readbackHelperPath: `${this.containerDir}/staged-readback-helper`
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
  private objectRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  }
  private protocolObservation(stage: CodexPrivateFailureObservation["stage"]): CodexPrivateFailureObservation {
    return { stage, protocolFailure: true, kind: "Unknown", httpStatusCode: null };
  }
  private write(value: unknown): void {
    if (this.transport === null || this.protocolFailureClaimed) throw new Error("codex-provider-stream-unavailable");
    this.transport.write(value);
  }
  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id); pending.reject(new Error("codex-request-timeout"));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.write({ id, method, params }); }
      catch (error) {
        this.pending.delete(id); clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error("codex-provider-write-failed"));
      }
    });
  }
  private rejectPending(error = new Error("codex-provider-stream-closed")): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
  }
  private classifyMessage(message: Record<string, unknown>): void {
    if (this.protocolFailureClaimed) return;
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = Object.prototype.hasOwnProperty.call(message, "error");
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    if (hasResult || hasError) {
      if (!hasId || typeof message.id !== "number" || !Number.isSafeInteger(message.id) || hasResult === hasError) {
        this.failProtocolOnce(); return;
      }
      if (hasError) {
        const error = this.objectRecord(message.error);
        if (error === null || typeof error.code !== "number" || !Number.isSafeInteger(error.code) || typeof error.message !== "string") {
          this.failProtocolOnce(); return;
        }
      }
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id); clearTimeout(pending.timeout);
      if (hasError) {
        const error = message.error as Record<string, unknown>;
        const detail = error.codexErrorInfo;
        const observation = codexPrivateFailureObservation("request", detail);
        if (observation.kind === "Unauthorized") void this.input.authority.markReauthenticationRequired().catch(() => undefined);
        pending.reject(new CodexRequestFailure(observation));
      } else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string" || !Object.prototype.hasOwnProperty.call(message, "params")) { this.failProtocolOnce(); return; }
    const params = this.objectRecord(message.params);
    if (params === null) { this.failProtocolOnce(); return; }
    if (hasId) {
      this.enqueueServerRequest(message, params);
      return;
    }
    this.enqueueNotification(message, message.method, params);
  }
  private enqueueServerRequest(message: Record<string, unknown>, params: Record<string, unknown>): void {
    const previous = this.notificationChain;
    const current = previous.then(async () => {
      if (!this.protocolFailureClaimed) await this.dispatchServerRequest(message, params);
    });
    this.notificationChain = current.then(() => undefined, () => undefined);
    void current.catch(() => { this.failProtocolOnce(); });
  }
  private async dispatchServerRequest(message: Record<string, unknown>, params: Record<string, unknown>): Promise<void> {
    const nativeRequest = parseCodexServerInteractionRequest({ id: message.id, method: message.method, params });
    if (nativeRequest === null || this.nativeTurnState !== "active" || this.devspaceTurnId === null
      || nativeRequest.params.threadId !== this.threadId || nativeRequest.params.turnId !== this.turnId) {
      await this.handleUnknownBlockingRequest();
      return;
    }
    if (nativeRequest.method === "item/tool/requestUserInput" && !this.input.capabilities.structuredInput) {
      await this.handleUnknownBlockingRequest();
      return;
    }
    if (nativeRequest.method !== "item/tool/requestUserInput" && !this.input.capabilities.approvals) {
      await this.handleUnknownBlockingRequest();
      return;
    }
    if ([...this.pendingInteractions.values()].some((pending) => {
      const nativeId = pending.projection.kind === "input"
        ? pending.projection.mapping.binding.nativeRequestId
        : pending.projection.binding.nativeRequestId;
      return nativeId === nativeRequest.nativeRequestId;
    })) {
      await this.handleUnknownBlockingRequest();
      return;
    }
    const projection = nativeRequest.method === "item/tool/requestUserInput"
      ? projectCodexInputRequest(nativeRequest, this.devspaceTurnId, this.input.createId)
      : projectCodexApprovalRequest(nativeRequest, this.devspaceTurnId, this.input.createId, this.fileChangeItems);
    if (projection === null) {
      await this.handleUnknownBlockingRequest();
      return;
    }
    this.pendingInteractions.set(projection.requestId, { projection, request: nativeRequest, state: "pending" });
    try {
      await this.input.callbacks.interactionRequested(projection);
    } catch {
      this.pendingInteractions.delete(projection.requestId);
      this.failProtocolOnce();
    }
  }
  private enqueueNotification(notification: Record<string, unknown>, method: string, params: Record<string, unknown>): void {
    if (this.notificationQueueLength >= CODEX_MAX_NATIVE_NOTIFICATIONS) { this.failProtocolOnce(); return; }
    this.notificationQueueLength += 1;
    const previous = this.notificationChain;
    const current = previous.then(async () => {
      if (!this.protocolFailureClaimed) await this.dispatchNotification(notification, method, params);
    }).finally(() => { this.notificationQueueLength -= 1; });
    this.notificationChain = current.then(() => undefined, () => undefined);
    void current.catch(() => { this.failProtocolOnce(); });
  }
  private async dispatchNotification(notification: Record<string, unknown>, method: string, params: Record<string, unknown>): Promise<void> {
    const category = classifyCodexNotification(notification);
    if (category === null) { this.failProtocolOnce(); return; }
    if (category === "unknown-non-blocking") return;
    if (method === "error") {
      const error = this.objectRecord(params.error);
      if (!this.correlates(params, true) || error === null || typeof params.willRetry !== "boolean" || typeof error.message !== "string") { this.failProtocolOnce(); return; }
      const detail = (params.error as Record<string, unknown>).codexErrorInfo;
      if (this.turnFailure === null) this.turnFailure = codexPrivateFailureObservation("turn", detail);
      if (this.turnFailure.kind === "Unauthorized") void this.input.authority.markReauthenticationRequired().catch(() => undefined);
      try { this.input.callbacks.privateFailure(this.turnFailure); } catch { this.failProtocolOnce(); }
      return;
    }
    if (method === "item/agentMessage/delta") {
      if (!this.correlates(params, true) || typeof params.itemId !== "string" || typeof params.delta !== "string"
        || Buffer.byteLength(params.delta, "utf8") > AI_OUTPUT_DELTA_MAX_BYTES) { this.failProtocolOnce(); return; }
      await this.input.callbacks.outputDelta(params.delta);
      return;
    }
    if (method === "item/started") {
      const item = this.objectRecord(params.item);
      if (!this.correlates(params, true) || item === null || typeof params.startedAtMs !== "number"
        || !Number.isSafeInteger(params.startedAtMs)) { this.failProtocolOnce(); return; }
      if (item.type === "fileChange") {
        const fileChangeItem = projectCodexFileChangeItem(item, this.threadId!, this.turnId!);
        if (fileChangeItem === null) { this.failProtocolOnce(); return; }
        this.fileChangeItems.set(fileChangeItem.nativeItemId, fileChangeItem);
      }
      await this.input.callbacks.activity("Provider activity started.");
      return;
    }
    if (method === "turn/started") {
      const turn = this.objectRecord(params.turn);
      if (typeof params.threadId !== "string" || params.threadId !== this.threadId || turn === null || turn.id !== this.turnId
        || !Array.isArray(turn.items) || !["inProgress", "completed", "interrupted", "failed"].includes(String(turn.status))) this.failProtocolOnce();
      return;
    }
    if (method === "turn/completed") {
      const turn = this.objectRecord(params.turn);
      const nativeTurnId = turn?.id;
      const identityMatches = typeof params.threadId === "string" && params.threadId === this.threadId && nativeTurnId === this.turnId;
      const fingerprint = stablePrivateJson(params);
      if (this.nativeTurnState === "terminal-claimed" || this.nativeTurnState === "terminal-delivered") {
        if (identityMatches && fingerprint === this.terminalFingerprint) return;
        this.failProtocolOnce(); return;
      }
      if (this.nativeTurnState !== "active" || !identityMatches || turn === null || !Array.isArray(turn.items)
        || !["completed", "interrupted", "failed"].includes(String(turn.status))) {
        this.failProtocolOnce(); return;
      }
      this.nativeTurnState = "terminal-claimed";
      this.terminalFingerprint = fingerprint;
      if (turn.status === "failed") {
        if (this.turnFailure === null) this.turnFailure = codexPrivateFailureObservation("turn", (this.objectRecord(turn.error)?.codexErrorInfo));
        if (this.turnFailure.kind === "Unauthorized") void this.input.authority.markReauthenticationRequired().catch(() => undefined);
        await this.input.callbacks.failed(this.turnFailure);
      } else {
        await this.input.callbacks.completed(turn.status === "interrupted" ? "interrupted" : "completed");
      }
      this.nativeTurnState = "terminal-delivered";
      this.turnFailure = null;
      return;
    }
    if (method === "serverRequest/resolved") {
      if (typeof params.threadId !== "string" || params.threadId !== this.threadId) return;
      const resolved = [...this.pendingInteractions.entries()].find(([, pending]) => {
        const request = pending.request;
        return request !== null && request.params.threadId === params.threadId && request.nativeRequestId === params.requestId;
      });
      if (resolved === undefined) return;
      const [requestId, pending] = resolved;
      this.pendingInteractions.delete(requestId);
      await this.input.callbacks.interactionResolved(requestId, pending.state === "pending" ? "provider-expired" : "provider-resolved");
      return;
    }
    if (category === "validated-and-ignored") return;
    this.failProtocolOnce();
  }
  private correlates(params: Record<string, unknown>, requireTurn: boolean): boolean {
    if (this.nativeTurnState !== "active") return false;
    if (typeof params.threadId !== "string" || params.threadId !== this.threadId) return false;
    return !requireTurn || (typeof params.turnId === "string" && params.turnId === this.turnId);
  }
  private failProtocolOnce(): void {
    if (this.protocolFailureClaimed) return;
    this.protocolFailureClaimed = true;
    const stage = this.nativeTurnState === "active" || this.nativeTurnState === "terminal-claimed" ? "turn" : "request";
    const observation = this.protocolObservation(stage);
    this.protocolFailureObservation = observation;
    this.rejectPending(new CodexRequestFailure(observation));
    try { this.input.callbacks.privateFailure(observation); } catch { /* private diagnostics cannot escape the protocol boundary */ }
    if (this.nativeTurnState === "active") void this.input.callbacks.failed(observation).catch(() => undefined);
    const stream = this.stream;
    if (stream !== null && !stream.destroyed) stream.destroy();
  }
  private async handleUnknownBlockingRequest(): Promise<void> {
    if (this.protocolFailureClaimed) return;
    this.protocolFailureClaimed = true;
    const stage = this.nativeTurnState === "active" || this.nativeTurnState === "terminal-claimed" ? "turn" : "request";
    const observation: CodexPrivateFailureObservation = {
      ...this.protocolObservation(stage),
      diagnostic: "CODEX_UNKNOWN_BLOCKING_REQUEST"
    };
    this.protocolFailureObservation = observation;
    this.rejectPending(new CodexRequestFailure(observation));
    const pendingRequestIds = [...this.pendingInteractions.keys()];
    this.pendingInteractions.clear();
    this.fileChangeItems.clear();
    try { this.input.callbacks.privateFailure(observation); } catch { /* private diagnostics cannot escape the protocol boundary */ }
    await this.input.callbacks.providerIncompatible("CODEX_UNKNOWN_BLOCKING_REQUEST").catch(() => undefined);
    await Promise.all(pendingRequestIds.map((requestId) => this.input.callbacks.interactionResolved(requestId, "provider-expired").catch(() => undefined)));
    if (this.nativeTurnState === "active") await this.input.callbacks.failed(observation).catch(() => undefined);
    const stream = this.stream;
    if (stream !== null && !stream.destroyed) stream.destroy();
  }
  private async handleStreamClose(): Promise<void> {
    if (this.protocolFailureClaimed === false) {
      this.transport?.finish();
    }
    await Promise.race([
      this.notificationChain,
      new Promise<void>((resolve) => setTimeout(resolve, CODEX_NOTIFICATION_DRAIN_TIMEOUT_MS))
    ]);
    this.rejectPending();
    const observation = this.protocolObservation(this.nativeTurnState === "active" ? "turn" : "request");
    try { this.input.callbacks.privateFailure(observation); } catch { /* diagnostics cannot alter terminalization */ }
    await this.input.callbacks.failed(observation).catch(() => undefined);
    if (this.finalizationState === "active" && !this.providerClosedNotified) {
      this.providerClosedNotified = true;
      await this.input.callbacks.providerClosed().catch(() => undefined);
    }
  }
}
