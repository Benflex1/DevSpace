import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
/* eslint-disable @typescript-eslint/require-await */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  AI_EVENT_NDJSON_CONTENT_TYPE,
  aiAfterSequenceSchema,
  AI_OUTPUT_DELTA_MAX_BYTES,
  AI_OUTPUT_ITEM_MAX_BYTES,
  aiProviderProfileProjectionSchema,
  type CanonicalAiEvent,
  type AiProviderProfileProjection,
  CODEX_BASELINE_CLI_VERSION, CODEX_BASELINE_VERSION_OUTPUT
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
import {
  createAiSessionOutbox,
  openExistingAiSessionOutbox,
  type AiEventAcknowledgement,
  type AiSessionOutbox,
  type AiSessionOutboxFaultHooks
} from "./ai-session-outbox.js";
import {
  CODEX_NOTIFICATION_CATEGORY_REGISTRY,
  validatePinnedCodexNotification
} from "./codex-notification-schema-v0-145.js";
import {
  encodeCodexApprovalResponse,
  encodeCodexInputResponse,
  parseCodexServerInteractionRequest,
  projectCodexApprovalRequest,
  projectCodexFileChangeItem,
  projectCodexInputRequest,
  type CodexFileChangeItem,
  type CodexInteractionProjection
} from "./codex-interactions-v0-145.js";

const execFileAsync = promisify(execFile);
const CODEX_PROFILE_ID = "codex";
const CODEX_EXECUTABLE_SHA256 = "a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14";
const CODEX_STAGED_READBACK_HELPER_SHA256 = "d07b2735546d3f514c2be5871521ec0430352638f24f0b134f93cbb5c2b951d1";
const CODEX_STAGED_READBACK_HELPER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/native/codex-staged-readback");
const MAX_GIT_PATHS = 256;
const PRIVATE_CONTAINER_ROOT = "/tmp/devspace-ai";
const CODEX_DOCKER_EXEC_TIMEOUT_MS = 5_000;
// Codex 0.145.0 can carry an output item up to the public 1 MiB item bound.
// The native envelope, JSON escaping, and a bounded future metadata allowance
// add 64 KiB. Docker's one-frame bound adds one 8 KiB framing allowance. These
// are Agent-private limits; public events remain governed by @devspace/contracts.
const CODEX_PROTOCOL_JSON_OVERHEAD_BYTES = 64 * 1024;
const CODEX_MAX_NATIVE_JSON_MESSAGE_BYTES = AI_OUTPUT_ITEM_MAX_BYTES + CODEX_PROTOCOL_JSON_OVERHEAD_BYTES;
const CODEX_MAX_DOCKER_FRAME_PAYLOAD_BYTES = CODEX_MAX_NATIVE_JSON_MESSAGE_BYTES + 8 * 1024;
const CODEX_MAX_DOCKER_PARTIAL_BUFFER_BYTES = 8 + CODEX_MAX_DOCKER_FRAME_PAYLOAD_BYTES;
const CODEX_MAX_NATIVE_NOTIFICATIONS = 256;
const CODEX_NOTIFICATION_DRAIN_TIMEOUT_MS = 1_000;
const CODEX_APPROVAL_POLICY = "on-request" as const;
const CODEX_EXPERIMENTAL_API = true as const;
const CODEX_APPROVALS_REVIEWER = "user" as const;
const CODEX_THREAD_SANDBOX = "danger-full-access" as const;
const CODEX_TURN_SANDBOX_POLICY = "externalSandbox" as const;
const CODEX_NETWORK_ACCESS = "enabled" as const;
const CODEX_CAPABILITIES = Object.freeze({
  inspect: true, start: true, resume: false, sendTurn: true, interrupt: true,
  approvals: true, structuredInput: true, stop: true, streamEvents: true
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
  /** Agent-private deterministic helper seam; production uses the reproducibly built helper asset. */
  readonly codexReadbackHelperBytes?: Uint8Array;
  readonly codexReadbackHelperPath?: string;
  /** Agent-private bounded authority seam; the server never supplies this implementation. */
  readonly codexCredentialAuthority?: CodexCredentialAuthority;
  /** Agent-private deterministic outbox seam; the server never supplies these hooks. */
  readonly outboxFaultHooks?: AiSessionOutboxFaultHooks;
  /** Agent-private deterministic fake-provider seam; the server never supplies these hooks. */
  readonly fakeProviderTestHooks?: Readonly<{
    readonly onStart?: () => void;
    readonly onSend?: () => void;
    readonly onStop?: () => void;
    readonly closeAfterTurn?: boolean;
  }>;
}

export type CodexPrivateFailureObservation = Readonly<{
  stage: "request" | "turn";
  protocolFailure?: true;
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
  respondToAiApproval(input: AiProcessBinding & { turnId: string; requestId: string; decision: AiInteractionDecision }): Promise<void>;
  respondToAiStructuredInput(input: AiProcessBinding & { turnId: string; requestId: string; answers: readonly AiStructuredInputAnswer[] }): Promise<void>;
  stop(input: AiProcessBinding): Promise<void>;
  synchronized(sessionId: string): Promise<{ processGeneration: number; pendingInteractionIds: readonly string[] }>;
  replay(sessionId: string, afterSequence: number): Promise<CanonicalAiEvent[]>;
  subscribe(sessionId: string, afterSequence: number, listener: (event: CanonicalAiEvent) => unknown): Promise<() => void>;
  acknowledge(input: AiEventAcknowledgement): Promise<AiEventAcknowledgement>;
  collect(sessionId: string, afterSequence: number, waitMs: number): Promise<CanonicalAiEvent[]>;
}

interface SessionRecord {
  readonly binding: AiSessionBinding;
  processGeneration: number;
  readonly outbox: AiSessionOutbox;
  readonly turnBaselines: Map<string, Set<string>>;
  readonly privateFailures: Map<string, CodexPrivateFailureObservation>;
  readonly pendingInteractions: Map<string, PendingAgentInteraction>;
  adapter: ProviderAdapter | null;
  ready: boolean;
  activeTurnId: string | null;
  activeTurnToken: object | null;
  activeTurnPromise: Promise<void> | null;
  admissionPromise: Promise<void> | null;
  finalizationPromise: Promise<void> | null;
  finalizationState: "active" | "finalizing" | "cleanup-unproven" | "cleanup-proven-public-pending" | "finalized";
  finalizationReason: "user-request" | "provider-exited" | null;
  cleanupProven: boolean;
  stoppingEmitted: boolean;
  terminalClaim: TurnTerminalClaim | null;
  terminalClaimPromise: Promise<TurnTerminalClaim | null> | null;
  terminalDrivePromise: Promise<void> | null;
}

type TurnTerminalKind = "completed" | "interrupted" | "failed" | "lost";
type TurnTerminalStep = Readonly<{
  eventType: "turn.interrupted" | "turn.provider-completed" | "turn.files.changed" | "turn.quiesced" | "turn.failed" | "turn.lost";
  payload: unknown;
}>;
type TurnTerminalClaim = {
  readonly turnId: string;
  readonly processGeneration: number;
  readonly kind: TurnTerminalKind;
  readonly finalOutcome: "completed" | "interrupted" | null;
  readonly reason: string | null;
  readonly changedFiles: Extract<CanonicalAiEvent, { eventType: "turn.files.changed" }>["payload"] | null;
  readonly safeFailure: Extract<CanonicalAiEvent, { eventType: "turn.failed" }>["payload"] | null;
  readonly steps: readonly TurnTerminalStep[];
  stage: number;
};

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
  respondToApproval(requestId: string, decision: "approve-once" | "approve-for-session" | "deny" | "cancel"): Promise<void>;
  respondToStructuredInput(requestId: string, answers: readonly {
    readonly questionId: string;
    readonly kind: "selected" | "text" | "other";
    readonly optionId?: string;
    readonly text?: string;
  }[]): Promise<void>;
  pendingInteractionIds(): readonly string[];
  retireInteractions(turnId: string): void;
  stop(): Promise<ProviderFinalizationResult>;
}

type AiStructuredInputAnswer =
  | Readonly<{ questionId: string; kind: "selected"; optionId: string }>
  | Readonly<{ questionId: string; kind: "text"; text: string }>
  | Readonly<{ questionId: string; kind: "other"; text: string }>;
type AiInteractionDecision = "approve-once" | "approve-for-session" | "deny" | "cancel";
type PendingAgentInteraction = {
  readonly projection: CodexInteractionProjection;
  readonly adapter: ProviderAdapter;
  readonly processGeneration: number;
  state: "pending" | "response-attempted";
};

interface AdapterCallbacks {
  readonly outputDelta: (text: string) => Promise<void>;
  readonly activity: (summary: string) => Promise<void>;
  readonly interactionRequested: (projection: CodexInteractionProjection) => Promise<void>;
  readonly interactionResolved: (requestId: string) => Promise<void>;
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
  readonly experimentalApi: boolean;
  readonly approvalsReviewer: "user" | "auto_review" | "guardian_subagent";
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
    experimentalApi: input.experimentalApi,
    approvalsReviewer: input.approvalsReviewer,
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
    providerVersion: CODEX_BASELINE_CLI_VERSION, transport: "stdio-jsonl", threadSandbox: CODEX_THREAD_SANDBOX,
    turnSandboxPolicy: CODEX_TURN_SANDBOX_POLICY, networkAccess: CODEX_NETWORK_ACCESS, approvalPolicy: CODEX_APPROVAL_POLICY,
    experimentalApi: CODEX_EXPERIMENTAL_API, approvalsReviewer: CODEX_APPROVALS_REVIEWER,
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
  if (observation?.protocolFailure === true) return "AI_PROVIDER_PROTOCOL_FAILURE";
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
  private readonly pendingInteractions = new Map<string, { kind: "approval" | "input"; decision?: AiInteractionDecision; answers?: readonly AiStructuredInputAnswer[] }>();
  private releaseInteraction: (() => void) | null = null;
  constructor(
    private readonly callbacks: AdapterCallbacks,
    private readonly worktreePath: string | null,
    private readonly testHooks: AiSessionRuntimeOptions["fakeProviderTestHooks"],
    private readonly createId: () => string
  ) {}
  async start(): Promise<void> { this.testHooks?.onStart?.(); }
  async sendTurn(_turnId: string, text: string): Promise<void> {
    this.testHooks?.onSend?.();
    this.interrupted = false;
    this.stopped = false;
    if (text.includes("devspace-ai-beta-check.txt") && this.worktreePath !== null) {
      await writeFile(path.join(this.worktreePath, "devspace-ai-beta-check.txt"), "DevSpace AI beta check", { mode: 0o600 });
    }
    if (text.includes("approval") || text.includes("file approval")) {
      const requestId = this.createId();
      const fileChange = text.includes("file approval");
      const projection: CodexInteractionProjection = fileChange ? {
        requestId, turnId: _turnId, kind: "approval",
        presentation: { kind: "file-change", summary: "Codex wants to update the beta check file.", paths: ["devspace-ai-beta-check.txt"], truncated: false, redacted: true },
        public: { requestId, turnId: _turnId, kind: "approval", presentation: { kind: "file-change", summary: "Codex wants to update the beta check file.", paths: ["devspace-ai-beta-check.txt"], truncated: false, redacted: true } },
        binding: { nativeRequestId: "fake-native-approval", nativeThreadId: "fake-thread", nativeTurnId: "fake-turn", nativeItemId: "fake-item" }
      } : {
        requestId, turnId: _turnId, kind: "approval",
        presentation: { kind: "command", summary: "Codex wants to run the bounded approval test command.", commandText: "printf 'DevSpace approval'", workingDirectory: ".", risk: "read", redacted: true },
        public: { requestId, turnId: _turnId, kind: "approval", presentation: { kind: "command", summary: "Codex wants to run the bounded approval test command.", commandText: "printf 'DevSpace approval'", workingDirectory: ".", risk: "read", redacted: true } },
        binding: { nativeRequestId: "fake-native-approval", nativeThreadId: "fake-thread", nativeTurnId: "fake-turn", nativeItemId: "fake-item" }
      };
      this.pendingInteractions.set(requestId, { kind: "approval" });
      await this.callbacks.interactionRequested(projection);
      await this.waitForInteraction();
      const result = this.pendingInteractions.get(requestId);
      if (this.interrupted || this.stopped) return await this.callbacks.completed("interrupted");
      await this.callbacks.outputDelta(result?.decision === "deny" ? "The command was denied." : "The approved command completed.");
      this.pendingInteractions.delete(requestId);
      await this.callbacks.completed("completed");
      return;
    }
    if (text.includes("question") || text.includes("structured input")) {
      const requestId = this.createId();
      const questions = [
        { questionId: "question-1", header: "Mode", question: "Choose a safe mode.", responseKind: "single-select" as const, allowOther: true, secret: false as const,
          options: [{ optionId: "option-1", label: "Safe", description: "Use the bounded safe mode." }, { optionId: "option-2", label: "Explain", description: "Explain before continuing." }] },
        { questionId: "question-2", header: "Reason", question: "Why should Codex continue?", responseKind: "single-select" as const, allowOther: true, secret: false as const,
          options: [{ optionId: "option-1", label: "Continue", description: "Continue with the bounded task." }] }
      ];
      const projection: CodexInteractionProjection = {
        requestId, turnId: _turnId, kind: "input", questions,
        public: { requestId, turnId: _turnId, kind: "input", questions },
        mapping: { requestId, turnId: _turnId, questions: [
          { publicQuestionId: "question-1", nativeQuestionId: "fake-question-1", responseKind: "single-select", allowOther: true, options: [{ publicOptionId: "option-1", nativeOptionLabel: "Safe" }, { publicOptionId: "option-2", nativeOptionLabel: "Explain" }] },
          { publicQuestionId: "question-2", nativeQuestionId: "fake-question-2", responseKind: "single-select", allowOther: true, options: [{ publicOptionId: "option-1", nativeOptionLabel: "Continue" }] }
        ], binding: { nativeRequestId: "fake-native-input", nativeThreadId: "fake-thread", nativeTurnId: "fake-turn", nativeItemId: "fake-item" } }
      };
      this.pendingInteractions.set(requestId, { kind: "input" });
      await this.callbacks.interactionRequested(projection);
      await this.waitForInteraction();
      const result = this.pendingInteractions.get(requestId);
      if (this.interrupted || this.stopped) return await this.callbacks.completed("interrupted");
      await this.callbacks.outputDelta(result?.answers === undefined ? "The answer was not received." : result.answers.some((answer) => answer.kind === "other")
        ? "Thanks, I will continue with the Other answer."
        : "Thanks, I will continue with those answers.");
      this.pendingInteractions.delete(requestId);
      await this.callbacks.completed("completed");
      return;
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
      if (this.testHooks?.closeAfterTurn === true) await this.callbacks.providerClosed();
      return;
    }
    const chunks = ["Hello from the deterministic provider."];
    for (const chunk of chunks) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.interrupted || this.stopped) return await this.callbacks.completed("interrupted");
      await this.callbacks.outputDelta(chunk);
    }
    await this.callbacks.completed("completed");
    if (this.testHooks?.closeAfterTurn === true) await this.callbacks.providerClosed();
  }
  private async waitForInteraction(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.releaseInteraction = resolve;
      if (this.interrupted || this.stopped) resolve();
    });
    this.releaseInteraction = null;
  }
  async interrupt(): Promise<void> { this.interrupted = true; this.releaseLongTurn?.(); this.releaseInteraction?.(); }
  async respondToApproval(requestId: string, decision: AiInteractionDecision): Promise<void> {
    const pending = this.pendingInteractions.get(requestId);
    if (pending?.kind !== "approval") throw new Error("ai-interaction-not-pending");
    pending.decision = decision;
    this.releaseInteraction?.();
  }
  async respondToStructuredInput(requestId: string, answers: readonly AiStructuredInputAnswer[]): Promise<void> {
    const pending = this.pendingInteractions.get(requestId);
    if (pending?.kind !== "input") throw new Error("ai-interaction-not-pending");
    pending.answers = answers;
    this.releaseInteraction?.();
  }
  pendingInteractionIds(): readonly string[] { return [...this.pendingInteractions.keys()]; }
  retireInteractions(): void { this.pendingInteractions.clear(); this.releaseInteraction?.(); }
  async stop(): Promise<ProviderFinalizationResult> {
    this.testHooks?.onStop?.();
    this.stopped = true; this.releaseLongTurn?.(); this.releaseInteraction?.();
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

function stablePrivateJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stablePrivateJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stablePrivateJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

class CodexProvider implements ProviderAdapter {
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
  private dockerHeader = Buffer.alloc(0);
  private dockerPayload = Buffer.alloc(0);
  private dockerPayloadLength: number | null = null;
  private dockerStreamType: 1 | 2 | null = null;
  private readonly utf8Decoder = new TextDecoder("utf-8", { fatal: true });
  private jsonLine = "";
  private jsonLineBytes = 0;
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
    readonly executablePath: string;
    readonly sessionId: string;
    readonly processGeneration: number;
    readonly readbackHelperBytes: Buffer;
    readonly callbacks: AdapterCallbacks;
    readonly authority: CodexCredentialAuthority;
    readonly createId: () => string;
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
      await this.runUpload(containerDir, this.input.readbackHelperBytes, "staged-readback-helper");
      await this.runUpload(`${containerDir}/home`, Buffer.from(auth.bytes), "auth.json", { CODEX_HOME: `${containerDir}/home` });
      const execId = await this.input.docker.createExec(this.input.ownership.ownership.developmentContainer.id, {
        command: [`${containerDir}/codex`, "app-server", "--stdio"], workingDirectory: "/workspace",
        environment: { CODEX_HOME: `${containerDir}/home` }, attachStdin: true, tty: false
      });
      this.providerExecId = execId;
      this.stream = await this.input.docker.startExecAttached(execId, false);
      this.stream.on("data", (chunk: Buffer) => { this.receiveDockerData(chunk); });
      this.stream.on("error", () => { this.rejectPending(new Error("codex-provider-stream-error")); });
      this.stream.on("close", () => { this.streamClosePromise = this.handleStreamClose(); void this.streamClosePromise.catch(() => undefined); });
      const initialized = await this.request("initialize", {
        clientInfo: { name: "devspace", title: "DevSpace", version: "1.0.0" },
        capabilities: { experimentalApi: CODEX_EXPERIMENTAL_API }
      });
      if (this.objectRecord(initialized) === null) {
        this.failProtocolOnce();
        throw new CodexRequestFailure(this.protocolFailureObservation ?? this.protocolObservation("request"));
      }
      this.write({ method: "initialized" });
      const thread = await this.request("thread/start", {
        cwd: "/workspace", approvalPolicy: CODEX_APPROVAL_POLICY, approvalsReviewer: CODEX_APPROVALS_REVIEWER, sandbox: CODEX_THREAD_SANDBOX
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
    if (this.stream === null || this.protocolFailureClaimed) throw new Error("codex-provider-stream-unavailable");
    this.stream.write(`${JSON.stringify(value)}\n`);
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
  private receiveDockerData(chunk: Buffer): void {
    if (this.protocolFailureClaimed) return;
    try {
      if (!Buffer.isBuffer(chunk)) throw new Error("invalid-docker-chunk");
      let offset = 0;
      while (offset < chunk.length && !this.protocolFailureClaimed) {
        if (this.dockerPayloadLength === null) {
          const need = 8 - this.dockerHeader.length;
          const take = Math.min(need, chunk.length - offset);
          this.appendDockerBytes("header", chunk.subarray(offset, offset + take)); offset += take;
          if (this.dockerHeader.length < 8) continue;
          if (this.dockerHeader[1] !== 0 || this.dockerHeader[2] !== 0 || this.dockerHeader[3] !== 0) throw new Error("invalid-docker-header");
          const streamType = this.dockerHeader[0];
          if (streamType !== 1 && streamType !== 2) throw new Error("unsupported-docker-stream");
          const size = this.dockerHeader.readUInt32BE(4);
          if (!Number.isSafeInteger(size) || size > CODEX_MAX_DOCKER_FRAME_PAYLOAD_BYTES
            || size > Number.MAX_SAFE_INTEGER - 8) throw new Error("docker-frame-too-large");
          this.dockerPayloadLength = size;
          this.dockerStreamType = streamType;
          this.dockerHeader = Buffer.alloc(0);
          this.dockerPayload = Buffer.alloc(0);
          if (size === 0) this.finishDockerFrame();
        } else {
          const need = this.dockerPayloadLength - this.dockerPayload.length;
          const take = Math.min(need, chunk.length - offset);
          this.appendDockerBytes("payload", chunk.subarray(offset, offset + take)); offset += take;
          if (this.dockerPayload.length === this.dockerPayloadLength) this.finishDockerFrame();
        }
      }
    } catch {
      this.failProtocolOnce();
    }
  }
  private appendDockerBytes(kind: "header" | "payload", bytes: Uint8Array): void {
    const retained = this.dockerHeader.length + this.dockerPayload.length + bytes.length;
    if (retained > CODEX_MAX_DOCKER_PARTIAL_BUFFER_BYTES) throw new Error("docker-partial-buffer-too-large");
    if (kind === "header") {
      if (this.dockerHeader.length + bytes.length > 8) throw new Error("docker-header-overflow");
      this.dockerHeader = Buffer.concat([this.dockerHeader, bytes]);
    } else {
      if (this.dockerPayloadLength === null || this.dockerPayload.length + bytes.length > this.dockerPayloadLength) throw new Error("docker-payload-overflow");
      this.dockerPayload = Buffer.concat([this.dockerPayload, bytes]);
    }
  }
  private finishDockerFrame(): void {
    const payload = this.dockerPayload;
    const streamType = this.dockerStreamType;
    this.dockerPayload = Buffer.alloc(0); this.dockerPayloadLength = null; this.dockerStreamType = null;
    if (streamType === 1 && payload.length > 0) this.processStdoutPayload(payload);
  }
  private processStdoutPayload(payload: Buffer): void {
    try { this.processDecodedText(this.utf8Decoder.decode(payload, { stream: true })); }
    catch { this.failProtocolOnce(); }
  }
  private processDecodedText(text: string): void {
    if (text.includes("\u0000")) { this.failProtocolOnce(); return; }
    let offset = 0;
    while (offset < text.length && !this.protocolFailureClaimed) {
      const newline = text.indexOf("\n", offset);
      const end = newline < 0 ? text.length : newline;
      const fragment = text.slice(offset, end);
      const fragmentBytes = Buffer.byteLength(fragment, "utf8");
      if (this.jsonLineBytes + fragmentBytes > CODEX_MAX_NATIVE_JSON_MESSAGE_BYTES) { this.failProtocolOnce(); return; }
      this.jsonLine += fragment; this.jsonLineBytes += fragmentBytes;
      if (newline < 0) return;
      this.finishJsonLine();
      offset = newline + 1;
    }
  }
  private finishJsonLine(): void {
    const line = this.jsonLine.endsWith("\r") ? this.jsonLine.slice(0, -1) : this.jsonLine;
    this.jsonLine = ""; this.jsonLineBytes = 0;
    if (line.length === 0) return;
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; } catch { this.failProtocolOnce(); return; }
    const message = this.objectRecord(parsed);
    if (message === null) { this.failProtocolOnce(); return; }
    this.classifyMessage(message);
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
      this.failProtocolOnce();
      return;
    }
    if ([...this.pendingInteractions.values()].some((pending) => {
      const nativeId = pending.projection.kind === "input"
        ? pending.projection.mapping.binding.nativeRequestId
        : pending.projection.binding.nativeRequestId;
      return nativeId === nativeRequest.nativeRequestId;
    })) {
      this.failProtocolOnce();
      return;
    }
    const projection = nativeRequest.method === "item/tool/requestUserInput"
      ? projectCodexInputRequest(nativeRequest, this.devspaceTurnId, this.input.createId)
      : projectCodexApprovalRequest(nativeRequest, this.devspaceTurnId, this.input.createId, this.fileChangeItems);
    if (projection === null) {
      this.failProtocolOnce();
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
    const category = validatePinnedCodexNotification(notification);
    if (category === null) { this.failProtocolOnce(); return; }
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
      const [requestId] = resolved;
      this.pendingInteractions.delete(requestId);
      await this.input.callbacks.interactionResolved(requestId);
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
  private async handleStreamClose(): Promise<void> {
    if (this.protocolFailureClaimed === false) {
      try {
        this.processDecodedText(this.utf8Decoder.decode());
        if (this.dockerHeader.length !== 0 || this.dockerPayloadLength !== null || this.dockerPayload.length !== 0 || this.jsonLineBytes !== 0) throw new Error("codex-partial-protocol");
      } catch { this.failProtocolOnce(); }
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

async function verifyCodexExecutable(executablePath: string): Promise<void> {
  const executable = await readFile(executablePath);
  const digest = createHash("sha256").update(executable).digest("hex");
  if (digest !== CODEX_EXECUTABLE_SHA256) throw new Error("codex-executable-integrity-mismatch");
}

async function readCodexReadbackHelper(options: AiSessionRuntimeOptions): Promise<Buffer> {
  if (options.codexReadbackHelperBytes !== undefined) return Buffer.from(options.codexReadbackHelperBytes);
  if (options.codexPreflight !== undefined) return Buffer.from("deterministic-agent-owned-readback-helper");
  const helper = await readFile(options.codexReadbackHelperPath ?? CODEX_STAGED_READBACK_HELPER_PATH);
  if (createHash("sha256").update(helper).digest("hex") !== CODEX_STAGED_READBACK_HELPER_SHA256) throw new Error("codex-readback-helper-integrity-mismatch");
  return helper;
}

function bindingMatches(left: AiSessionBinding, right: AiSessionBinding): boolean {
  return left.projectId === right.projectId && left.workspaceId === right.workspaceId && left.aiSessionId === right.aiSessionId
    && left.revisionId === right.revisionId && left.runtimePlanHash === right.runtimePlanHash && left.runtimeGeneration === right.runtimeGeneration
    && left.profileId === right.profileId && left.profileRevision === right.profileRevision;
}

function validateStoppedOutbox(outbox: AiSessionOutbox, binding: AiSessionBinding): number {
  const events = outbox.events;
  const last = events.at(-1);
  const penultimate = events.at(-2);
  if (last === undefined || last.eventType !== "session.stopped" || last.turnId !== null
    || penultimate === undefined || penultimate.eventType !== "session.stopping"
    || penultimate.processGeneration !== last.processGeneration
    || last.profile.profileId !== binding.profileId || last.profile.profileRevision !== binding.profileRevision
    || last.profile.provider !== binding.profileId || !Number.isSafeInteger(last.processGeneration)
    || last.processGeneration < 1) {
    throw new Error("ai-session-restart-unavailable");
  }
  if (events.some((event) => event.profile.profileId !== binding.profileId
    || event.profile.profileRevision !== binding.profileRevision || event.profile.provider !== binding.profileId)) {
    throw new Error("ai-session-restart-unavailable");
  }
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1]!;
    const current = events[index]!;
    if (current.processGeneration < previous.processGeneration
      || current.processGeneration > previous.processGeneration + 1
      || (current.processGeneration === previous.processGeneration + 1
        && (previous.eventType !== "session.stopped" || current.eventType !== "session.started"))
      || ((previous.eventType === "session.stopped" || previous.eventType === "session.lost")
        && current.processGeneration === previous.processGeneration)) {
      throw new Error("ai-session-restart-unavailable");
    }
  }
  return last.processGeneration;
}

export function createAiSessionRuntime(options: AiSessionRuntimeOptions = {}): AiSessionRuntime {
  const mode = options.mode ?? "codex";
  const stateRoot = options.stateRoot ?? "/srv/devspace/state";
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? uuidv7;
  const sessions = new Map<string, SessionRecord>();
  const outboxes = new Map<string, AiSessionOutbox>();
  const docker = options.docker ?? new DockerEngineClient(process.env.DEVSPACE_DOCKER_SOCKET_PATH ?? defaultRootlessDockerSocketPath());

  async function outboxFor(sessionId: string, binding?: AiSessionBinding): Promise<AiSessionOutbox> {
    const cached = outboxes.get(sessionId);
    if (cached !== undefined) {
      if (binding !== undefined && (cached.binding.projectId !== binding.projectId || cached.binding.workspaceId !== binding.workspaceId)) throw new Error("ai-identity-mismatch");
      return cached;
    }
    const faultOptions = options.outboxFaultHooks === undefined ? {} : { faultHooks: options.outboxFaultHooks };
    const opened = binding === undefined
      ? await openExistingAiSessionOutbox({ stateRoot, sessionId, createId, now, ...faultOptions })
      : await createAiSessionOutbox({ stateRoot, binding, createId, now, ...faultOptions });
    outboxes.set(sessionId, opened);
    return opened;
  }

  async function recordFor(binding: AiSessionBinding | AiProcessBinding): Promise<SessionRecord> {
    const existing = sessions.get(binding.aiSessionId);
    if (existing !== undefined) {
      if (existing.binding.projectId !== binding.projectId || existing.binding.workspaceId !== binding.workspaceId || existing.binding.profileId !== binding.profileId
        || existing.binding.profileRevision !== binding.profileRevision
        || ("processGeneration" in binding && existing.processGeneration !== binding.processGeneration)) throw new Error("ai-identity-mismatch");
      if ("revisionId" in binding && !bindingMatches(existing.binding, binding)) throw new Error("ai-identity-mismatch");
      return existing;
    }
    if (!("revisionId" in binding)) throw new Error("ai-session-not-started");
    const outbox = await outboxFor(binding.aiSessionId, binding);
    const previousGeneration = outbox.events.length === 0 ? 1 : validateStoppedOutbox(outbox, binding);
    const record: SessionRecord = {
      binding, processGeneration: previousGeneration, outbox, turnBaselines: new Map(), privateFailures: new Map(), pendingInteractions: new Map(), adapter: null, ready: false, activeTurnId: null,
      activeTurnToken: null, activeTurnPromise: null, admissionPromise: null, finalizationPromise: null,
      finalizationState: outbox.events.length === 0 ? "active" : "finalized", finalizationReason: null,
      cleanupProven: outbox.events.length > 0, stoppingEmitted: outbox.events.length > 0,
      terminalClaim: null, terminalClaimPromise: null, terminalDrivePromise: null
    };
    sessions.set(binding.aiSessionId, record); return record;
  }

  async function emit(record: SessionRecord, turnId: string | null, eventType: string, payload: unknown): Promise<CanonicalAiEvent> {
    const turnFinalization = new Set(["turn.interrupted", "turn.provider-completed", "turn.files.changed", "turn.quiesced", "turn.failed"]).has(eventType);
    const providerFinalization = eventType === "session.stopping" || eventType === "session.stopped";
    return await record.outbox.append({ turnId, eventType, payload, profile: {
      profileId: CODEX_PROFILE_ID,
      profileRevision: mode === "codex" ? profileRevisionForBinding(record.binding) : profileRevision(),
      provider: CODEX_PROFILE_ID
    }, processGeneration: record.processGeneration,
    kind: turnFinalization ? "turn-finalization" : providerFinalization ? "provider-finalization" : eventType === "session.lost" ? "terminal" : "normal" });
  }

  function rememberPrivateFailure(record: SessionRecord, turnId: string, observation: CodexPrivateFailureObservation): CodexPrivateFailureObservation {
    const existing = record.privateFailures.get(turnId);
    if (existing !== undefined) return existing;
    record.privateFailures.set(turnId, observation);
    try { options.onPrivateFailureObservation?.(observation); } catch { /* diagnostics never alter provider lifecycle */ }
    return observation;
  }

  async function changedFilesForTurn(record: SessionRecord, turnId: string) {
    if (options.managed === undefined) return { files: [], truncated: false };
    const context = await options.managed.executionContext(record.binding.projectId, record.binding.workspaceId).catch(() => null);
    if (context === null) return { files: [], truncated: false };
    const before = record.turnBaselines.get(turnId) ?? new Set();
    return await gitSummary(context.ownership.worktreePath, before).catch(() => ({ files: [], truncated: false }));
  }

  async function failTurn(record: SessionRecord, turnId: string, observation: CodexPrivateFailureObservation): Promise<void> {
    if (record.activeTurnId !== turnId) return;
    await establishTerminalClaim(record, "failed", { observation });
    await driveTerminalClaim(record);
    await finalizeRecord(record, "provider-exited");
  }

  const terminalEventTypes = new Set([
    "turn.interrupted",
    "turn.provider-completed",
    "turn.files.changed",
    "turn.quiesced",
    "turn.failed",
    "turn.lost"
  ]);

  async function establishTerminalClaim(
    record: SessionRecord,
    kind: TurnTerminalKind,
    options: {
      readonly observation?: CodexPrivateFailureObservation;
      readonly reason?: "provider-confirmed" | "provider-process-stopped";
    } = {}
  ): Promise<TurnTerminalClaim | null> {
    if (record.terminalClaim !== null) return record.terminalClaim;
    if (record.terminalClaimPromise !== null) return await record.terminalClaimPromise;
    if (record.activeTurnId === null) return null;
    const turnId = record.activeTurnId;
    const generation = record.processGeneration;
    const attempt = (async (): Promise<TurnTerminalClaim | null> => {
      if (record.terminalClaim !== null) return record.terminalClaim;
      if (record.activeTurnId !== turnId || record.processGeneration !== generation) return null;
      let changedFiles: Extract<CanonicalAiEvent, { eventType: "turn.files.changed" }>["payload"] | null = null;
      let safeFailure: Extract<CanonicalAiEvent, { eventType: "turn.failed" }>["payload"] | null = null;
      let finalOutcome: "completed" | "interrupted" | null = null;
      let reason: string | null = options.reason ?? null;
      let steps: readonly TurnTerminalStep[];
      if (kind === "completed" || kind === "interrupted") {
        finalOutcome = kind;
        changedFiles = await changedFilesForTurn(record, turnId);
        steps = [
          ...(kind === "interrupted" ? [{
            eventType: "turn.interrupted" as const,
            payload: { reason: options.reason ?? "provider-confirmed" }
          }] : []),
          { eventType: "turn.provider-completed", payload: { outcome: kind } },
          { eventType: "turn.files.changed", payload: changedFiles },
          { eventType: "turn.quiesced", payload: { outcome: kind } }
        ];
      } else if (kind === "failed") {
        const selected = rememberPrivateFailure(
          record,
          turnId,
          options.observation ?? { stage: "turn", kind: "Unknown", httpStatusCode: null }
        );
        const code = safeErrorCode(new CodexRequestFailure(selected));
        safeFailure = {
          failure: {
            code,
            category: code === "AI_PROVIDER_PROTOCOL_FAILURE" ? "protocol-failure" : "transport-failure",
            incidentId: createId()
          }
        };
        steps = [{ eventType: "turn.failed", payload: safeFailure }];
      } else {
        reason = "AGENT_RESTART";
        steps = [{ eventType: "turn.lost", payload: { code: "AGENT_RESTART" } }];
      }
      const claim: TurnTerminalClaim = {
        turnId,
        processGeneration: generation,
        kind,
        finalOutcome,
        reason,
        changedFiles,
        safeFailure,
        steps,
        stage: 0
      };
      record.terminalClaim = claim;
      return claim;
    })();
    record.terminalClaimPromise = attempt;
    try {
      return await attempt;
    } finally {
      if (record.terminalClaimPromise === attempt) record.terminalClaimPromise = null;
    }
  }

  function inspectTerminalClaim(record: SessionRecord, claim: TurnTerminalClaim): number {
    if (record.processGeneration !== claim.processGeneration) throw new Error("ai-turn-terminal-generation-conflict");
    const durable = record.outbox.events.filter((event) =>
      event.turnId === claim.turnId
      && event.processGeneration === claim.processGeneration
      && terminalEventTypes.has(event.eventType)
    );
    if (durable.length > claim.steps.length) throw new Error("ai-turn-terminal-suffix-conflict");
    for (const [index, event] of durable.entries()) {
      const expected = claim.steps[index];
      if (expected === undefined || event.eventType !== expected.eventType
        || stablePrivateJson(event.payload) !== stablePrivateJson(expected.payload)) {
        throw new Error("ai-turn-terminal-suffix-conflict");
      }
    }
    return durable.length;
  }

  async function driveTerminalClaim(record: SessionRecord): Promise<void> {
    if (record.terminalDrivePromise !== null) return await record.terminalDrivePromise;
    const claim = record.terminalClaim;
    if (claim === null) return;
    const attempt = (async () => {
      while (true) {
        claim.stage = inspectTerminalClaim(record, claim);
        const step = claim.steps[claim.stage];
        if (step === undefined) break;
        await emit(record, claim.turnId, step.eventType, step.payload);
      }
      claim.stage = inspectTerminalClaim(record, claim);
      if (claim.stage !== claim.steps.length) throw new Error("ai-turn-terminal-suffix-incomplete");
      if (record.activeTurnId !== claim.turnId) throw new Error("ai-turn-terminal-owner-conflict");
      record.adapter?.retireInteractions(claim.turnId);
      for (const [requestId, pending] of record.pendingInteractions.entries()) {
        if (pending.projection.turnId === claim.turnId) record.pendingInteractions.delete(requestId);
      }
      record.activeTurnId = null;
      record.turnBaselines.delete(claim.turnId);
      record.privateFailures.delete(claim.turnId);
      await record.outbox.finishTurn();
      if (record.terminalClaim === claim) record.terminalClaim = null;
    })();
    record.terminalDrivePromise = attempt;
    try {
      await attempt;
    } finally {
      if (record.terminalDrivePromise === attempt) record.terminalDrivePromise = null;
    }
  }

  async function finalizeRecord(record: SessionRecord, reason: "user-request" | "provider-exited"): Promise<void> {
    if (record.finalizationState === "finalized") return;
    if (record.finalizationPromise !== null) {
      await record.finalizationPromise;
      return;
    }
    if (record.finalizationState === "active" && record.adapter === null && !record.cleanupProven) return;
    record.finalizationReason ??= reason;
    record.finalizationState = "finalizing";
    const finalizationReason = record.finalizationReason;
    const attempt = (async () => {
      if (record.activeTurnId !== null) {
        await establishTerminalClaim(record, "interrupted", { reason: "provider-process-stopped" });
        await driveTerminalClaim(record);
      }
      if (!record.cleanupProven) {
        const adapter = record.adapter;
        if (adapter === null) throw new ProviderFinalizationUnprovenError();
        const result = await adapter.stop();
        if (result.state !== "finalized") throw new ProviderFinalizationUnprovenError();
        record.ready = false;
        record.adapter = null;
        record.cleanupProven = true;
        record.finalizationState = "cleanup-proven-public-pending";
      }
      if (!record.stoppingEmitted) {
        await emit(record, null, "session.stopping", { reason: finalizationReason === "user-request" ? "user-request" : "runtime-stopping" });
        record.stoppingEmitted = true;
      }
      await emit(record, null, "session.stopped", { reason: finalizationReason === "user-request" ? "user-request" : "provider-exited" });
      await record.outbox.releaseProviderGeneration();
      record.finalizationState = "finalized";
    })();
    const promise = attempt.then(() => undefined, (error) => {
      record.finalizationState = record.cleanupProven ? "cleanup-proven-public-pending" : "cleanup-unproven";
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
          if (result.stdout.trim() !== CODEX_BASELINE_VERSION_OUTPUT) return publicProfile({ state: "unavailable", code: "VERSION_MISMATCH" });
        }
        await readCodexReadbackHelper(options);
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
      const restarting = record.outbox.events.length > 0;
      if (record.adapter !== null || record.activeTurnId !== null || record.finalizationPromise !== null
        || (restarting && record.finalizationState !== "finalized")
        || (!restarting && record.finalizationState !== "active")) {
        throw new Error("ai-session-state-conflict");
      }
      let nextGeneration = record.processGeneration;
      if (restarting) {
        const previousGeneration = validateStoppedOutbox(record.outbox, binding);
        if (previousGeneration !== record.processGeneration || previousGeneration === Number.MAX_SAFE_INTEGER) {
          throw new Error("ai-session-restart-unavailable");
        }
        nextGeneration = previousGeneration + 1;
      }
      if (mode === "codex" && binding.profileRevision !== profileRevisionForBinding(binding)) throw new Error("ai-profile-revision-mismatch");
      const profile = await runtime.inspect(binding);
      if (profile.availability.state !== "available" || (mode === "codex" && profile.profileRevision !== binding.profileRevision)) throw new Error("ai-profile-unavailable");
      const stillRestarting = record.outbox.events.length > 0;
      if (stillRestarting !== restarting || record.adapter !== null || record.activeTurnId !== null || record.finalizationPromise !== null
        || (restarting && record.finalizationState !== "finalized")
        || (!restarting && record.finalizationState !== "active")) throw new Error("ai-session-state-conflict");
      if (restarting && validateStoppedOutbox(record.outbox, binding) !== record.processGeneration) throw new Error("ai-session-restart-unavailable");
      await record.outbox.reserveProviderGeneration();
      const adapterGeneration = nextGeneration;
      let generationAdapter: ProviderAdapter | null = null;
      const currentGeneration = () => record.processGeneration === adapterGeneration && record.adapter === generationAdapter;
      const callbacks: AdapterCallbacks = {
        outputDelta: async (text) => { if (currentGeneration()) await emit(record, record.activeTurnId, "turn.output.delta", { stream: "assistant", text }); },
        activity: async (summary) => { if (!currentGeneration()) return; const activityId = createId(); await emit(record, record.activeTurnId, "turn.activity.started", { activityId, presentation: { kind: "analysis", summary } });
          await emit(record, record.activeTurnId, "turn.activity.completed", { activityId, outcome: "succeeded" }); },
        interactionRequested: async (projection) => {
          if (!currentGeneration() || record.activeTurnId !== projection.turnId) throw new Error("ai-interaction-state-conflict");
          if (record.pendingInteractions.has(projection.requestId)) throw new Error("ai-interaction-state-conflict");
          const pending: PendingAgentInteraction = { projection, adapter: generationAdapter!, processGeneration: adapterGeneration, state: "pending" };
          record.pendingInteractions.set(projection.requestId, pending);
          try {
            await emit(record, projection.turnId, projection.kind === "approval" ? "turn.approval.requested" : "turn.input.requested",
              projection.kind === "approval" ? { requestId: projection.requestId, presentation: projection.presentation }
                : { requestId: projection.requestId, questions: projection.questions });
          } catch (error) {
            record.pendingInteractions.delete(projection.requestId);
            throw error;
          }
        },
        interactionResolved: async (requestId) => {
          if (!currentGeneration()) return;
          const pending = record.pendingInteractions.get(requestId);
          if (pending === undefined) return;
          if (pending.state === "pending") {
            await emit(record, pending.projection.turnId, "turn.interaction.expired", { requestId });
          }
          record.pendingInteractions.delete(requestId);
        },
        completed: async (outcome) => {
          if (!currentGeneration() || record.activeTurnId === null) return;
          await establishTerminalClaim(
            record,
            outcome === "failed" ? "failed" : outcome === "interrupted" ? "interrupted" : "completed",
            outcome === "interrupted" ? { reason: "provider-confirmed" } : {}
          );
          await driveTerminalClaim(record);
        },
        privateFailure: (observation) => {
          if (!currentGeneration()) return;
          if (record.activeTurnId !== null) rememberPrivateFailure(record, record.activeTurnId, observation);
          else {
            try { options.onPrivateFailureObservation?.(observation); } catch { /* diagnostics never alter provider lifecycle */ }
          }
        },
        failed: async (observation) => {
          if (currentGeneration() && record.activeTurnId !== null) await failTurn(record, record.activeTurnId, observation).catch(() => undefined);
        },
        providerClosed: async () => { if (currentGeneration()) await finalizeRecord(record, "provider-exited").catch(() => undefined); }
      };
      let adapter: ProviderAdapter;
      try {
        if (mode === "fake") {
          const worktreePath = options.managed === undefined ? null : (await options.managed.executionContext(binding.projectId, binding.workspaceId)).ownership.worktreePath;
          adapter = new FakeProvider(callbacks, worktreePath, options.fakeProviderTestHooks, createId);
        } else {
          if (options.managed === undefined) throw new Error("runtime-identity-unavailable");
          if (options.codexPreflight === undefined) await verifyCodexExecutable(options.executablePath ?? "/home/benjamin/.local/bin/codex");
          const readbackHelperBytes = await readCodexReadbackHelper(options);
          const ownership = await options.managed.executionContext(binding.projectId, binding.workspaceId);
          adapter = new CodexProvider({ docker, ownership, executablePath: options.executablePath ?? "/home/benjamin/.local/bin/codex", sessionId: binding.aiSessionId, processGeneration: adapterGeneration, readbackHelperBytes, callbacks,
            authority: options.codexCredentialAuthority ?? createCodexCredentialAuthority(stateRoot), createId });
        }
      } catch (error) {
        await record.outbox.cancelProviderGenerationReservation().catch(() => undefined);
        throw error;
      }
      generationAdapter = adapter;
      record.processGeneration = adapterGeneration;
      record.finalizationPromise = null;
      record.finalizationState = "active";
      record.finalizationReason = null;
      record.cleanupProven = false;
      record.stoppingEmitted = false;
      record.activeTurnToken = null;
      record.activeTurnPromise = null;
      record.admissionPromise = null;
      record.turnBaselines.clear();
      record.privateFailures.clear();
      record.terminalClaim = null;
      record.terminalClaimPromise = null;
      record.terminalDrivePromise = null;
      record.pendingInteractions.clear();
      record.adapter = adapter;
      try {
        await emit(record, null, "session.started", { processGeneration: record.processGeneration });
        await adapter.start();
        await emit(record, null, "session.ready", {});
        record.ready = true;
      } catch (error) {
        record.ready = false;
        await finalizeRecord(record, "provider-exited").catch(() => undefined);
        throw error;
      }
    },
    async sendTurn(input) {
      const record = await recordFor(input);
      if (record.adapter === null || !record.ready || record.finalizationState !== "active") throw new Error("ai-session-not-started");
      if (record.activeTurnId !== null || record.admissionPromise !== null) throw new Error("ai-turn-state-conflict");
      const admissionAdapter = record.adapter;
      const admissionGeneration = record.processGeneration;
      const admission = (async () => {
        let baseline = new Set<string>();
        if (options.managed !== undefined) {
          const context = await options.managed.executionContext(input.projectId, input.workspaceId);
          if (context.projectId !== record.binding.projectId
            || context.workspaceId !== record.binding.workspaceId
            || context.revisionId !== record.binding.revisionId
            || context.runtimePlanHash !== record.binding.runtimePlanHash
            || context.generation !== record.binding.runtimeGeneration) {
            throw new Error("ai-identity-mismatch");
          }
          baseline = await gitBaseline(context.ownership.worktreePath).catch(() => new Set());
        }
        if (record.adapter !== admissionAdapter || record.processGeneration !== admissionGeneration
          || !record.ready || record.finalizationState !== "active" || record.activeTurnId !== null) {
          throw new Error("ai-turn-state-conflict");
        }
        try {
          await record.outbox.beginTurn({ turnId: input.turnId, profile: {
            profileId: CODEX_PROFILE_ID,
            profileRevision: mode === "codex" ? profileRevisionForBinding(record.binding) : profileRevision(),
            provider: CODEX_PROFILE_ID
          }, processGeneration: admissionGeneration, content: input.content });
        } catch (error) {
          const acceptedDurable = record.outbox.events.some((event) =>
            event.turnId === input.turnId
            && event.processGeneration === admissionGeneration
            && event.eventType === "turn.accepted"
            && JSON.stringify(event.payload.content) === JSON.stringify(input.content)
          );
          if (!acceptedDurable) {
            await record.outbox.finishTurn().catch(() => undefined);
            throw error;
          }
          record.turnBaselines.set(input.turnId, baseline);
          record.activeTurnId = input.turnId;
          await failTurn(record, input.turnId,
            privateFailureFromError(error) ?? { stage: "request", kind: "Unknown", httpStatusCode: null });
          return;
        }
        record.turnBaselines.set(input.turnId, baseline);
        record.activeTurnId = input.turnId;
        const turnPromise = Promise.resolve()
          .then(async () => await admissionAdapter.sendTurn(input.turnId, input.content.text))
          .catch(async (error) => {
            if (record.adapter !== admissionAdapter || record.processGeneration !== admissionGeneration) return;
            if (record.terminalClaim !== null) return;
            await failTurn(record, input.turnId,
              privateFailureFromError(error) ?? { stage: "request", kind: "Unknown", httpStatusCode: null });
          });
        const turnToken = {};
        const trackedTurnPromise = turnPromise.finally(() => {
          if (record.activeTurnToken === turnToken) {
            record.activeTurnToken = null;
            record.activeTurnPromise = null;
          }
        });
        record.activeTurnToken = turnToken;
        record.activeTurnPromise = trackedTurnPromise;
        void trackedTurnPromise.catch(() => undefined);
      })();
      record.admissionPromise = admission;
      try {
        await admission;
      } finally {
        if (record.admissionPromise === admission) record.admissionPromise = null;
      }
    },
    async interrupt(input) {
      const record = await recordFor(input);
      if (record.adapter === null || !record.ready || record.finalizationState !== "active" || record.activeTurnId !== input.turnId) {
        throw new Error("ai-turn-state-conflict");
      }
      await emit(record, input.turnId, "turn.interrupt.requested", {}); await record.adapter.interrupt();
    },
    async respondToAiApproval(input) {
      const record = await recordFor(input);
      const pending = record.pendingInteractions.get(input.requestId);
      if (record.adapter === null || !record.ready || record.finalizationState !== "active"
        || record.activeTurnId !== input.turnId || pending === undefined
        || pending.processGeneration !== input.processGeneration || pending.adapter !== record.adapter
        || pending.projection.turnId !== input.turnId || pending.projection.kind !== "approval"
        || pending.state !== "pending") throw new Error("ai-interaction-state-conflict");
      pending.state = "response-attempted";
      try {
        await record.adapter.respondToApproval(input.requestId, input.decision);
      } catch (error) {
        throw error instanceof Error ? error : new Error("ai-interaction-response-ambiguous");
      }
      await emit(record, input.turnId, "turn.approval.responded", { requestId: input.requestId, decision: input.decision });
      record.pendingInteractions.delete(input.requestId);
    },
    async respondToAiStructuredInput(input) {
      const record = await recordFor(input);
      const pending = record.pendingInteractions.get(input.requestId);
      if (record.adapter === null || !record.ready || record.finalizationState !== "active"
        || record.activeTurnId !== input.turnId || pending === undefined
        || pending.processGeneration !== input.processGeneration || pending.adapter !== record.adapter
        || pending.projection.turnId !== input.turnId || pending.projection.kind !== "input"
        || pending.state !== "pending") throw new Error("ai-interaction-state-conflict");
      pending.state = "response-attempted";
      try {
        await record.adapter.respondToStructuredInput(input.requestId, input.answers);
      } catch (error) {
        throw error instanceof Error ? error : new Error("ai-interaction-response-ambiguous");
      }
      await emit(record, input.turnId, "turn.input.responded", { requestId: input.requestId, answers: input.answers });
      record.pendingInteractions.delete(input.requestId);
    },
    async stop(input) {
      const record = await recordFor(input);
      await record.admissionPromise?.catch(() => undefined);
      await finalizeRecord(record, "user-request");
    },
    async synchronized(sessionId) {
      const record = sessions.get(sessionId);
      const outbox = record?.outbox ?? await outboxFor(sessionId);
      const processGeneration = record?.processGeneration ?? outbox.events.at(-1)?.processGeneration ?? 1;
      if (record === undefined || record.adapter === null) return { processGeneration, pendingInteractionIds: [] };
      const adapterPending = new Set(record.adapter.pendingInteractionIds());
      const pendingInteractionIds = [...record.pendingInteractions.entries()]
        .filter(([, pending]) => pending.state === "pending" && pending.processGeneration === processGeneration
          && pending.adapter === record.adapter && adapterPending.has(pending.projection.requestId))
        .map(([requestId]) => requestId);
      return { processGeneration, pendingInteractionIds };
    },
    async replay(sessionId, afterSequence) {
      aiAfterSequenceSchema.parse(afterSequence);
      const record = sessions.get(sessionId);
      const outbox = record?.outbox ?? await outboxFor(sessionId);
      if (record === undefined && outbox.events.length > 0) {
        const last = outbox.events.at(-1)!;
        const terminal = last.eventType === "session.stopped" || last.eventType === "session.lost";
        if (!terminal) {
          const generationEvents = outbox.events.filter((event) => event.processGeneration === last.processGeneration);
          const acceptedTurns = generationEvents.filter((event) => event.eventType === "turn.accepted");
          const active = acceptedTurns.findLast((accepted) => {
            const turnEvents = generationEvents.filter((event) => event.turnId === accepted.turnId);
            return !turnEvents.some((event) =>
              event.eventType === "turn.quiesced"
              || event.eventType === "turn.failed"
              || event.eventType === "turn.lost"
            );
          });
          if (active !== undefined) {
            const alreadyLost = generationEvents.some((event) =>
              event.turnId === active.turnId && event.eventType === "turn.lost"
            );
            if (!alreadyLost) {
              await outbox.append({
                turnId: active.turnId,
                eventType: "turn.lost",
                payload: { code: "AGENT_RESTART" },
                profile: last.profile,
                processGeneration: last.processGeneration,
                kind: "terminal"
              });
            }
          }
          await outbox.append({ turnId: null, eventType: "session.lost", payload: { code: "AGENT_RESTART" }, profile: last.profile,
            processGeneration: last.processGeneration, kind: "terminal" });
        }
      }
      return await outbox.replay(afterSequence);
    },
    async subscribe(sessionId, afterSequence, listener) {
      const record = sessions.get(sessionId);
      const outbox = record?.outbox ?? await outboxFor(sessionId);
      return await outbox.subscribe(afterSequence, listener);
    },
    async acknowledge(input) {
      const record = sessions.get(input.aiSessionId);
      const outbox = record?.outbox ?? await outboxFor(input.aiSessionId);
      return await outbox.acknowledge(input);
    },
    async collect(sessionId, afterSequence, waitMs) { await new Promise((resolve) => setTimeout(resolve, waitMs)); return await runtime.replay(sessionId, afterSequence); }
  };
  return runtime;
}

export {
  AI_EVENT_NDJSON_CONTENT_TYPE,
  CODEX_EXECUTABLE_SHA256,
  CODEX_STAGED_READBACK_HELPER_SHA256,
  CODEX_PROFILE_ID,
  CODEX_BASELINE_CLI_VERSION,
  CODEX_NOTIFICATION_CATEGORY_REGISTRY
};
