import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
/* eslint-disable @typescript-eslint/require-await */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  AI_EVENT_NDJSON_CONTENT_TYPE,
  aiAfterSequenceSchema,
  codexCompatibilityDiagnostics,
  mapCodexDiagnosticToPublicAvailability,
  type CanonicalAiEvent,
  type CodexCapabilitySet,
  type AiProviderProfileProjection,
} from "@devspace/contracts";
import { v7 as uuidv7 } from "uuid";
import { DockerEngineClient, defaultRootlessDockerSocketPath } from "./docker-runtime.js";
import type { ManagedWorkspaces } from "./managed-workspaces.js";
import {
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
import { CODEX_NOTIFICATION_CATEGORY_REGISTRY } from "./codex-app-server/notifications.js";
import type { CodexInteractionProjection } from "./codex-app-server/interactions.js";
import { FakeProvider, type FakeProviderTestHooks } from "./codex-app-server/fake-provider.js";
import {
  CodexProvider,
  CodexRequestFailure,
  privateFailureFromError,
  stablePrivateJson,
  type AdapterCallbacks,
  type AiInteractionDecision,
  type AiStructuredInputAnswer,
  type CodexPrivateFailureObservation,
  type ProviderAdapter
} from "./codex-app-server/provider.js";
import { discoverCodex, type CodexDiscoveryResult } from "./codex-app-server/discovery.js";
import {
  codexProfileRevisionForDiscovery,
  discoveryAvailability,
  fakeCodexProfileProjection,
  safeCodexProfileProjection
} from "./codex-app-server/profile-authority.js";
import {
  createCodexArtifactStager,
  type CodexArtifactStager,
  type CodexLaunchArtifact
} from "./codex-app-server/artifact-stager.js";
import {
  CODEX_ARTIFACT_READBACK_HELPER_SHA256,
  CODEX_STAGED_READBACK_HELPER_SHA256
} from "./codex-native-helper-identity.js";
import { resolveCodexExecutablePath } from "./codex-executable-resolution.js";

const execFileAsync = promisify(execFile);
const CODEX_PROFILE_ID = "codex";
const CODEX_STAGED_READBACK_HELPER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/native/codex-staged-readback");
const CODEX_ARTIFACT_READBACK_HELPER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/native/codex-artifact-readback");
const MAX_GIT_PATHS = 256;

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
  /** Agent-private discovery seam used by deterministic compatibility tests. */
  readonly codexDiscovery?: (input: Parameters<typeof discoverCodex>[0]) => Promise<CodexDiscoveryResult>;
  /** Agent-private deterministic helper seam; production uses the reproducibly built helper asset. */
  readonly codexReadbackHelperBytes?: Uint8Array;
  readonly codexReadbackHelperPath?: string;
  readonly codexArtifactReadbackHelperBytes?: Uint8Array;
  readonly codexArtifactReadbackHelperPath?: string;
  /** Agent-private deterministic artifact-stager seam; production uses the managed Docker stager. */
  readonly codexArtifactStager?: (input: { readonly readbackHelperBytes: Buffer }) => CodexArtifactStager;
  /** Agent-private bounded authority seam; the server never supplies this implementation. */
  readonly codexCredentialAuthority?: CodexCredentialAuthority;
  /** Agent-private deterministic outbox seam; the server never supplies these hooks. */
  readonly outboxFaultHooks?: AiSessionOutboxFaultHooks;
  /** Agent-private deterministic fake-provider seam; the server never supplies these hooks. */
  readonly fakeProviderTestHooks?: FakeProviderTestHooks;
}

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
  capabilities: CodexCapabilitySet;
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

class ProviderFinalizationUnprovenError extends Error {
  constructor() {
    super("ai-provider-finalization-unproven");
    this.name = "ProviderFinalizationUnprovenError";
  }
}

type PendingAgentInteraction = {
  readonly projection: CodexInteractionProjection;
  readonly adapter: ProviderAdapter;
  readonly processGeneration: number;
  state: "pending" | "response-attempted";
};

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

async function readCodexReadbackHelper(options: AiSessionRuntimeOptions): Promise<Buffer> {
  if (options.codexReadbackHelperBytes !== undefined) return Buffer.from(options.codexReadbackHelperBytes);
  if (options.codexPreflight !== undefined) return Buffer.from("deterministic-agent-owned-readback-helper");
  const helper = await readFile(options.codexReadbackHelperPath ?? CODEX_STAGED_READBACK_HELPER_PATH);
  if (createHash("sha256").update(helper).digest("hex") !== CODEX_STAGED_READBACK_HELPER_SHA256) throw new Error("codex-readback-helper-integrity-mismatch");
  return helper;
}

async function readCodexArtifactReadbackHelper(options: AiSessionRuntimeOptions): Promise<Buffer> {
  if (options.codexArtifactReadbackHelperBytes !== undefined) return Buffer.from(options.codexArtifactReadbackHelperBytes);
  const helper = await readFile(options.codexArtifactReadbackHelperPath ?? CODEX_ARTIFACT_READBACK_HELPER_PATH);
  if (createHash("sha256").update(helper).digest("hex") !== CODEX_ARTIFACT_READBACK_HELPER_SHA256) {
    throw new Error("codex-artifact-readback-helper-integrity-mismatch");
  }
  return helper;
}

type PublicUnavailableCode = Extract<AiProviderProfileProjection["availability"], { state: "unavailable" }>["code"];

function unavailableCodexProfile(code: PublicUnavailableCode): AiProviderProfileProjection {
  const generic = fakeCodexProfileProjection();
  return safeCodexProfileProjection({
    revision: generic.profileRevision,
    capabilities: {
      ...generic.capabilities,
      interrupt: false,
      approvals: false,
      structuredInput: false
    },
    availability: { state: "unavailable", code }
  });
}

function availabilityForDiscoveryError(error: unknown): AiProviderProfileProjection["availability"] {
  const message = error instanceof Error ? error.message : "";
  const diagnostic = codexCompatibilityDiagnostics.find((candidate) => candidate === message);
  if (diagnostic !== undefined) {
    return {
      state: "unavailable",
      code: mapCodexDiagnosticToPublicAvailability(diagnostic) ?? "PROFILE_DISABLED"
    };
  }
  if (message.includes("credential")) return { state: "unavailable", code: "CREDENTIAL_SOURCE_UNAVAILABLE" };
  if (message.includes("identity")) return { state: "unavailable", code: "RUNTIME_IDENTITY_UNAVAILABLE" };
  return { state: "unavailable", code: "EXECUTABLE_MISSING" };
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
  const codexDiscoveries = new Map<string, CodexDiscoveryResult>();
  const docker = options.docker ?? new DockerEngineClient(process.env.DEVSPACE_DOCKER_SOCKET_PATH ?? defaultRootlessDockerSocketPath());

  function discoveryKey(input: { readonly projectId: string; readonly workspaceId: string; }): string {
    return `${input.projectId}:${input.workspaceId}`;
  }

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
      capabilities: fakeCodexProfileProjection().capabilities,
      activeTurnToken: null, activeTurnPromise: null, admissionPromise: null, finalizationPromise: null,
      finalizationState: outbox.events.length === 0 ? "active" : "finalized", finalizationReason: null,
      cleanupProven: outbox.events.length > 0, stoppingEmitted: outbox.events.length > 0,
      terminalClaim: null, terminalClaimPromise: null, terminalDrivePromise: null
    };
    sessions.set(binding.aiSessionId, record); return record;
  }

  function admittedProfileFor(input: { projectId: string; workspaceId: string; profileId: string }): AiProviderProfileProjection | null {
    const record = [...sessions.values()].find((candidate) => candidate.binding.projectId === input.projectId
      && candidate.binding.workspaceId === input.workspaceId && candidate.binding.profileId === input.profileId
      && candidate.adapter !== null && candidate.ready && candidate.finalizationState === "active");
    if (record === undefined) return null;
    return safeCodexProfileProjection({
      revision: record.binding.profileRevision,
      capabilities: record.capabilities,
      availability: { state: "available" }
    });
  }

  async function emit(record: SessionRecord, turnId: string | null, eventType: string, payload: unknown): Promise<CanonicalAiEvent> {
    const turnFinalization = new Set(["turn.interrupted", "turn.provider-completed", "turn.files.changed", "turn.quiesced", "turn.failed"]).has(eventType);
    const providerFinalization = eventType === "session.stopping" || eventType === "session.stopped";
    return await record.outbox.append({ turnId, eventType, payload, profile: {
      profileId: CODEX_PROFILE_ID,
      profileRevision: record.binding.profileRevision,
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
      if (mode === "fake") return fakeCodexProfileProjection();
      if (options.managed === undefined) return unavailableCodexProfile("RUNTIME_IDENTITY_UNAVAILABLE");
      const admitted = admittedProfileFor(input);
      if (admitted !== null) return admitted;
      try {
        const context = await options.managed.executionContext(input.projectId, input.workspaceId);
        if (options.codexPreflight !== undefined) {
          await options.codexPreflight();
          await readCodexReadbackHelper(options);
          await (options.codexCredentialAuthority ?? createCodexCredentialAuthority(stateRoot)).inspect();
          return fakeCodexProfileProjection();
        }
        const discovery = await (options.codexDiscovery ?? discoverCodex)({
          configuredPath: options.executablePath ?? resolveCodexExecutablePath(),
          managedContainerId: context.ownership.developmentContainer.id,
          workspaceContext: context,
          stateRoot,
          docker,
          createId
        });
        codexDiscoveries.set(discoveryKey(input), discovery);
        await readCodexReadbackHelper(options);
        await (options.codexCredentialAuthority ?? createCodexCredentialAuthority(stateRoot)).inspect();
        return safeCodexProfileProjection({
          revision: codexProfileRevisionForDiscovery(discovery.profileAuthority),
          capabilities: discovery.compatibility.capabilities,
          availability: discoveryAvailability(discovery)
        });
      } catch (error) {
        const availability = availabilityForDiscoveryError(error);
        return unavailableCodexProfile(availability.state === "unavailable" ? availability.code : "PROFILE_DISABLED");
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
      const profile = await runtime.inspect(binding);
      if (profile.availability.state !== "available" || (mode === "codex" && profile.profileRevision !== binding.profileRevision)) throw new Error("ai-profile-unavailable");
      record.capabilities = profile.capabilities;
      const stillRestarting = record.outbox.events.length > 0;
      if (stillRestarting !== restarting || record.adapter !== null || record.activeTurnId !== null || record.finalizationPromise !== null
        || (restarting && record.finalizationState !== "finalized")
        || (!restarting && record.finalizationState !== "active")) throw new Error("ai-session-state-conflict");
      if (restarting && validateStoppedOutbox(record.outbox, binding) !== record.processGeneration) throw new Error("ai-session-restart-unavailable");
      let launchArtifact: CodexLaunchArtifact | undefined;
      let artifactStager: CodexArtifactStager | undefined;
      let experimentalApi = true;
      let approvalPolicy = "on-request" as const;
      let approvalsReviewer = "user" as const;
      if (mode === "codex" && options.codexPreflight === undefined) {
        const discovery = codexDiscoveries.get(discoveryKey(binding));
        if (discovery === undefined || codexProfileRevisionForDiscovery(discovery.profileAuthority) !== binding.profileRevision) {
          throw new Error("ai-profile-revision-mismatch");
        }
        if (discovery.profileAuthority.approvalPolicy !== "on-request"
          || discovery.profileAuthority.approvalsReviewer !== "user") {
          throw new Error("CODEX_APPROVAL_PROTOCOL_UNAVAILABLE");
        }
        experimentalApi = discovery.profileAuthority.experimentalApi;
        approvalPolicy = "on-request";
        approvalsReviewer = "user";
        const artifactReadbackHelperBytes = await readCodexArtifactReadbackHelper(options);
        artifactStager = options.codexArtifactStager?.({ readbackHelperBytes: artifactReadbackHelperBytes })
          ?? createCodexArtifactStager({ docker, readbackHelperBytes: artifactReadbackHelperBytes, createId });
        launchArtifact = {
          staged: discovery.stagedArtifact,
          managedImageId: discovery.profileAuthority.probeRuntimeIdentity.imageId,
          probeRuntime: discovery.profileAuthority.probeRuntimeIdentity,
          profileRevision: binding.profileRevision
        };
      }
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
        interactionResolved: async (requestId, _cause) => {
          if (!currentGeneration()) return;
          const pending = record.pendingInteractions.get(requestId);
          if (pending === undefined) return;
          if (pending.state === "pending") {
            await emit(record, pending.projection.turnId, "turn.interaction.expired", { requestId });
          }
          record.pendingInteractions.delete(requestId);
        },
        providerIncompatible: async (diagnostic) => {
          if (!currentGeneration()) return;
          const observation: CodexPrivateFailureObservation = {
            stage: record.activeTurnId === null ? "request" : "turn",
            protocolFailure: true,
            diagnostic,
            kind: "Unknown",
            httpStatusCode: null
          };
          if (record.activeTurnId !== null) rememberPrivateFailure(record, record.activeTurnId, observation);
          else {
            try { options.onPrivateFailureObservation?.(observation); } catch { /* diagnostics never alter provider lifecycle */ }
          }
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
          const readbackHelperBytes = await readCodexReadbackHelper(options);
          const ownership = await options.managed.executionContext(binding.projectId, binding.workspaceId);
          adapter = new CodexProvider({ docker, ownership,
            artifactStager, launchArtifact, sessionId: binding.aiSessionId, processGeneration: adapterGeneration, readbackHelperBytes, callbacks,
            authority: options.codexCredentialAuthority ?? createCodexCredentialAuthority(stateRoot), createId,
            capabilities: profile.capabilities, experimentalApi, approvalPolicy, approvalsReviewer });
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
            profileRevision: record.binding.profileRevision,
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
      if (!record.capabilities.interrupt) throw new Error("ai-capability-unsupported");
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
      if (!record.capabilities.approvals) throw new Error("ai-capability-unsupported");
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
      if (!record.capabilities.structuredInput) throw new Error("ai-capability-unsupported");
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
  CODEX_STAGED_READBACK_HELPER_SHA256,
  CODEX_ARTIFACT_READBACK_HELPER_SHA256,
  CODEX_PROFILE_ID,
  CODEX_NOTIFICATION_CATEGORY_REGISTRY
};
