import { chmod, link, lstat, unlink } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  AGENT_API_VERSION,
  AGENT_SOCKET_PATH,
  agentApiV1EndpointByOperation,
  extractDevSpaceProtocolHeaders,
  f10AgentApiV1EndpointByOperation,
  f11AiAgentApiV1EndpointByOperation,
  githubAgentApiV1EndpointByOperation,
  aiEventStreamFrameSchema,
  nativeHarnessInspectResponseSchema,
  parseEventCursor,
  nativeHarnessInspectDataSchema,
  nativeHarnessResumeDataSchema,
  nativeHarnessStartDataSchema,
  type AgentExecutionFailure,
  type SourceInspectionData
} from "@devspace/contracts";
import { v7 as uuidv7 } from "uuid";
import { WebSocketServer } from "ws";
import * as z from "zod";
import { GitInspectionPolicyError, GitInspectionUnavailableError, createProductionGitInspector, type GitInspector } from "./git-inspector.js";
import { AgentEventLog } from "./event-log.js";
import { AgentExecutionError, ConfigurationValidationError, ManagedWorkspaces, type ManagedWorkspaceRoots } from "./managed-workspaces.js";
import { OperationExecutor } from "./operation-executor.js";
import { OperationConflictError, OperationJournal } from "./operation-journal.js";
import { ExecutionManager, type HarnessRecoveryIdentity } from "./execution-manager.js";
import { DockerEngineClient, defaultRootlessDockerSocketPath } from "./docker-runtime.js";
import type { ApprovedPreviewBaseRegistry } from "@devspace/security";
import { classifyFailureCode, createLogger, type StructuredLogger } from "@devspace/diagnostics";
import { toPublicPreviewInspectionData, type PreviewGatewayProbe } from "./preview-runtime.js";
import type { OpaqueLeaseResolver, PreviewGatewayAdapterContract } from "@devspace/gateway-caddy";
import { PreviewLeaseResolverServer } from "./preview-lease-resolver.js";
import { createAiSessionRuntime, type AiSessionRuntime } from "./ai-session-runtime.js";
import { probeImageCodex } from "./harness-executable.js";
import { stageAgentCodexIntoContainer } from "./harness-codex-artifact.js";
import { createHarnessHomeStore, HarnessHomeError } from "./harness-home.js";
import { createHarnessRuntime, HarnessRuntimeError } from "./harness-runtime.js";
import { AiOutboxError } from "./ai-session-outbox.js";
import { createAiStreamAdmission } from "./ai-stream-admission.js";
import { createGithubAppAuthority, type GithubAppAuthority } from "./github-app.js";
import {
  AI_STREAM_BACKPRESSURE_TIMEOUT_MS,
  AI_STREAM_LIVE_QUEUE_MAX_BYTES,
  AI_STREAM_LIVE_QUEUE_MAX_EVENTS,
  createAiStreamDelivery
} from "./ai-stream-delivery.js";

const MAX_BODY_BYTES = 2_200_000;
const SOCKET_PROBE_TIMEOUT_MS = 300;
const healthEndpoint = agentApiV1EndpointByOperation["agent.health.get"];
const runtimeStatusEndpoint = agentApiV1EndpointByOperation["agent.runtime-status.get"];
const inspectEndpoint = agentApiV1EndpointByOperation["project.source.inspect"];
const snapshotEndpoint = f10AgentApiV1EndpointByOperation["snapshot.get"];
const eventEndpoint = f10AgentApiV1EndpointByOperation["event.stream"];

export interface AgentServerOptions {
  readonly socketPath?: string;
  /** Internal test seam for exercising private bind-path ownership. */
  readonly privateSocketPath?: string;
  /** Internal test seam for forcing publication-stage failures. */
  readonly publishSocket?: (privatePath: string, publicPath: string) => Promise<void>;
  readonly gitInspector?: GitInspector;
  readonly managedRoots?: ManagedWorkspaceRoots;
  readonly operationJournalPath?: string;
  readonly managedWorkspaces?: ManagedWorkspaces;
  readonly previewBaseRegistry?: ApprovedPreviewBaseRegistry;
  readonly previewProbe?: PreviewGatewayProbe;
  readonly previewGateway?: PreviewGatewayAdapterContract;
  readonly previewGatewayFactory?: (resolveLease: OpaqueLeaseResolver) => PreviewGatewayAdapterContract;
  readonly previewLeaseResolverSocketPath?: string;
  readonly operationJournal?: OperationJournal;
  readonly eventRetention?: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly logger?: StructuredLogger;
  readonly aiRuntime?: AiSessionRuntime;
  readonly githubAuthority?: GithubAppAuthority;
  /** Internal test seams may only lower stream admission and queue limits. */
  readonly aiStreamGlobalLimit?: number;
  readonly aiStreamPerSessionLimit?: number;
  readonly aiStreamLiveQueueMaxEvents?: number;
  readonly aiStreamLiveQueueMaxBytes?: number;
  /** Internal test seam for a shorter bounded drain timeout. */
  readonly aiStreamBackpressureTimeoutMs?: number;
}

export interface AgentServer {
  readonly socketPath: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function meta(requestId: string, now: () => Date) {
  return { protocolVersion: AGENT_API_VERSION, requestId, respondedAt: now().toISOString() };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store"
  });
  response.end(encoded);
}

interface EndpointErrorResponse {
  readonly operation: string;
  readonly errorSchema: {
    safeParse(input: unknown):
      | { readonly success: true; readonly data: unknown }
      | { readonly success: false; readonly error: { readonly issues: readonly { readonly path: readonly PropertyKey[] }[] } };
  };
}

function safeFailureLog(error: unknown): Record<string, unknown> {
  if (error instanceof AgentExecutionError) {
    const rawFailure = error.failure as unknown;
    if (rawFailure === null || typeof rawFailure !== "object" || Array.isArray(rawFailure)) {
      return { type: error.name, failureType: typeof rawFailure };
    }
    const failure = rawFailure as { readonly code?: unknown; readonly details?: unknown };
    const details = failure.details;
    return {
      type: error.name,
      code: typeof failure.code === "string" ? failure.code : "invalid",
      detailKeys: details !== null && typeof details === "object" && !Array.isArray(details)
        ? Object.keys(details).slice(0, 32)
        : []
    };
  }
  if (error instanceof Error) return { type: error.name };
  return { type: typeof error };
}

function sendEndpointErrorResponse(
  endpoint: EndpointErrorResponse,
  response: ServerResponse,
  status: number,
  requestId: string,
  now: () => Date,
  failure: unknown,
  source: unknown,
  createId: () => string,
  logger: StructuredLogger
): void {
  const intended = endpoint.errorSchema.safeParse({ meta: meta(requestId, now), error: failure });
  if (intended.success) {
    sendJson(response, status, intended.data);
    return;
  }

  const incidentId = createId();
  const safeFailure = safeFailureLog(source);
  logger.error("agent.error_response_schema_mismatch", "Agent error response did not match its contract", {
    requestId, errorCategory: "response-schema", errorCode: typeof safeFailure.code === "string" ? safeFailure.code : "AGENT_INTERNAL_ERROR",
    endpoint: endpoint.operation, incidentId, detailKeys: Array.isArray(safeFailure.detailKeys) ? safeFailure.detailKeys : []
  });

  const fallback = endpoint.errorSchema.safeParse({ meta: meta(requestId, now), error: {
    code: "AGENT_INTERNAL_ERROR", message: "The Agent encountered an unexpected error.", retryable: true,
    details: { incidentId }
  } });
  if (fallback.success) {
    sendJson(response, 500, fallback.data);
    return;
  }

  // Every executable endpoint includes AGENT_INTERNAL_ERROR in its error union.
  // Keep the request alive even if that contract invariant is ever violated.
  logger.error("agent.error_response_fallback_schema_mismatch", "Agent error response fallback did not match its contract", {
    requestId, errorCategory: "response-schema", errorCode: "AGENT_INTERNAL_ERROR", endpoint: endpoint.operation, incidentId
  });
  sendJson(response, 500, { meta: meta(requestId, now), error: {
    code: "AGENT_INTERNAL_ERROR", message: "The Agent encountered an unexpected error.", retryable: true,
    details: { incidentId }
  } });
}

function requestError(response: ServerResponse, requestId: string, now: () => Date, input: {
  location: "headers" | "path" | "query" | "body";
  field: string | null;
  reason: "missing" | "malformed" | "unknown" | "inconsistent";
}): void {
  sendJson(response, 400, {
    meta: meta(requestId, now),
    error: { code: "REQUEST_INVALID", message: "The Agent request is invalid.", retryable: false, details: input }
  });
}

function gitFailureStatus(code: string): number {
  if (code === "PROJECT_NOT_FOUND" || code === "WORKSPACE_FILE_NOT_FOUND" || code === "RESOURCE_NOT_FOUND") return 404;
  if (code === "WORKSPACE_FILE_TOO_LARGE") return 413;
  if (code === "WORKSPACE_PATH_INVALID" || code === "WORKSPACE_FILE_UNSUPPORTED" || code === "GIT_COMMIT_MESSAGE_INVALID"
    || code === "GIT_IDENTITY_REQUIRED") return 422;
  if (code === "GIT_OPERATION_FAILED") return 409;
  return 500;
}

function diagnosticResourceFields(value: unknown): { projectId?: string; workspaceId?: string; previewId?: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const data = value as { projectId?: unknown; workspaceId?: unknown; previewId?: unknown };
  return {
    ...(typeof data.projectId === "string" ? { projectId: data.projectId } : {}),
    ...(typeof data.workspaceId === "string" ? { workspaceId: data.workspaceId } : {}),
    ...(typeof data.previewId === "string" ? { previewId: data.previewId } : {})
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("body-too-large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export interface SocketIdentity { readonly dev: bigint; readonly ino: bigint }

function socketIdentity(stats: Awaited<ReturnType<typeof lstat>>): SocketIdentity {
  return { dev: BigInt(stats.dev), ino: BigInt(stats.ino) };
}

function sameSocket(left: SocketIdentity, right: SocketIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Internal ownership-checked cleanup used by the bind/publication lifecycle and its tests. */
export async function unlinkOwnedSocket(socketPath: string, ownership: SocketIdentity): Promise<void> {
  try {
    const current = await lstat(socketPath);
    if (current.isSocket() && sameSocket(ownership, socketIdentity(current))) await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function probeSocket(socketPath: string, now: () => Date, createId: () => string): Promise<"active" | "stale" | "absent" | "uncertain"> {
  return await new Promise((resolve) => {
    let connected = false;
    let settled = false;
    const finish = (result: "active" | "stale" | "absent" | "uncertain") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      call.destroy();
      resolve(result);
    };
    const call = http.request({
      socketPath,
      method: "GET",
      path: healthEndpoint.path,
      headers: {
        "X-DevSpace-Protocol-Version": String(AGENT_API_VERSION),
        "X-DevSpace-Request-Id": createId(),
        "X-DevSpace-Sent-At": now().toISOString()
      }
    }, (response) => {
      response.resume();
      finish("active");
    });
    call.once("socket", (socket) => socket.once("connect", () => { connected = true; }));
    call.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") finish("absent");
      else if (!connected && error.code === "ECONNREFUSED") finish("stale");
      else finish("uncertain");
    });
    const timer = setTimeout(() => finish("uncertain"), SOCKET_PROBE_TIMEOUT_MS);
    timer.unref();
    call.end();
  });
}

async function prepareSocketPath(socketPath: string, now: () => Date, createId: () => string): Promise<void> {
  let existing;
  try {
    existing = await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!existing.isSocket()) throw new Error(`Refusing to replace non-socket Agent path: ${socketPath}`);
  const identity = socketIdentity(existing);
  const probe = await probeSocket(socketPath, now, createId);
  if (probe === "active") throw new Error(`An active listener already owns the Agent socket: ${socketPath}`);
  if (probe === "uncertain") throw new Error(`Unable to prove that the existing Agent socket is stale: ${socketPath}`);
  if (probe === "absent") return;
  let current;
  try { current = await lstat(socketPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!current.isSocket() || !sameSocket(identity, socketIdentity(current))) {
    throw new Error(`The Agent socket changed while stale ownership was being checked: ${socketPath}`);
  }
  await unlink(socketPath);
}

export function createAgentServer(options: AgentServerOptions = {}): AgentServer {
  const socketPath = options.socketPath ?? AGENT_SOCKET_PATH;
  const publishSocket = options.publishSocket ?? (async (privatePath, publicPath) => { await link(privatePath, publicPath); });
  const inspector = options.gitInspector ?? createProductionGitInspector();
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? uuidv7;
  const logger = options.logger ?? createLogger({ component: "agent", subsystem: "lifecycle", now });
  const fallbackManagedRoot = socketPath === AGENT_SOCKET_PATH
    ? "/srv/devspace"
    : path.join(path.dirname(socketPath), ".devspace-managed");
  const managedRoots = options.managedRoots ?? {
    projects: path.join(fallbackManagedRoot, "projects"),
    workspaces: path.join(fallbackManagedRoot, "workspaces"),
    state: path.join(fallbackManagedRoot, "state")
  };
  // The gateway lease resolver closes over the managed instance, so initialization is intentionally
  // split into declaration and assignment.
  let managed!: ManagedWorkspaces; // eslint-disable-line prefer-const
  const previewGateway = options.previewGateway ?? options.previewGatewayFactory?.(async (leaseId) => await managed.resolvePreviewLease(leaseId));
  managed = options.managedWorkspaces ?? new ManagedWorkspaces(managedRoots, undefined, undefined, undefined, undefined,
    options.previewBaseRegistry, options.previewProbe, previewGateway);
  const previewLeaseResolver = options.previewLeaseResolverSocketPath === undefined ? null : new PreviewLeaseResolverServer({
    socketPath: options.previewLeaseResolverSocketPath,
    resolveLease: async (leaseId) => await managed.resolvePreviewLease(leaseId)
  });
  const journal = options.operationJournal ?? new OperationJournal(options.operationJournalPath ?? path.join(managedRoots.state, "operations"), now);
  const agentBootId = createId();
  const events = new AgentEventLog(agentBootId, now, options.eventRetention);
  const harnessHooks: {
    onHarnessSettled?: (event: { processId: string }) => Promise<void>;
    onHarnessRecovered?: (event: HarnessRecoveryIdentity) => Promise<void>;
  } = {};
  const execution = new ExecutionManager(managedRoots.state, managed,
    new DockerEngineClient(process.env.DEVSPACE_DOCKER_SOCKET_PATH ?? defaultRootlessDockerSocketPath()), undefined, now, harnessHooks);
  const harnessHome = createHarnessHomeStore(managedRoots.state);
  const harnessRuntime = createHarnessRuntime({
    home: harnessHome,
    stateRoot: managedRoots.state,
    createHarnessExec: async (input) => {
      await execution.createHarness(input);
    },
    observeHarnessRecovery: () => execution.harnessRecoveryReports(),
    inspectSlot: async (workspaceId) => await managed.observeHarnessSlot(workspaceId),
    recreateWorkspace: async (input) => await managed.recreateHarnessSlot(input.projectId, input.workspaceId),
    probeImageCodex: async (input) => {
      const context = await managed.executionContext(input.projectId, input.workspaceId);
      return probeImageCodex(new DockerEngineClient(process.env.DEVSPACE_DOCKER_SOCKET_PATH ?? defaultRootlessDockerSocketPath()),
        context.ownership.developmentContainer.id);
    },
    stageNativeCodex: async (input) => {
      const context = await managed.executionContext(input.projectId, input.workspaceId);
      return stageAgentCodexIntoContainer({
        docker: new DockerEngineClient(process.env.DEVSPACE_DOCKER_SOCKET_PATH ?? defaultRootlessDockerSocketPath()),
        containerId: context.ownership.developmentContainer.id,
        stateRoot: managedRoots.state,
        createId,
        environment: process.env
      });
    }
  });
  harnessHooks.onHarnessSettled = async (event) => {
    await harnessRuntime.settleByProcess(event.processId);
  };
  harnessHooks.onHarnessRecovered = async (event) => {
    await harnessRuntime.finalizeRecoveredLoss(event);
  };
  const executor = new OperationExecutor(journal, managed, events, createId, execution, logger.child({}));
  const configuredCodexPath = process.env.DEVSPACE_CODEX_EXECUTABLE_PATH;
  const aiRuntime = options.aiRuntime ?? createAiSessionRuntime({ managed, stateRoot: managedRoots.state, now, createId,
    mode: process.env.DEVSPACE_AI_PROVIDER_MODE === "fake" ? "fake" : "codex",
    // The configured entrypoint is inspected and staged by Agent-owned
    // compatibility discovery before any provider process is launched.
    ...(configuredCodexPath === undefined ? {} : { executablePath: configuredCodexPath }) });
  let githubAuthority = options.githubAuthority ?? null;
  const aiStreamAdmission = createAiStreamAdmission({
    globalLimit: Math.max(0, Math.min(options.aiStreamGlobalLimit ?? 4, 4)),
    perSessionLimit: Math.max(0, Math.min(options.aiStreamPerSessionLimit ?? 2, 2))
  });
  const aiStreamBackpressureTimeoutMs = Math.max(
    0,
    Math.min(options.aiStreamBackpressureTimeoutMs ?? AI_STREAM_BACKPRESSURE_TIMEOUT_MS, AI_STREAM_BACKPRESSURE_TIMEOUT_MS)
  );
  const aiStreamLiveQueueMaxEvents = Math.max(
    0,
    Math.min(options.aiStreamLiveQueueMaxEvents ?? AI_STREAM_LIVE_QUEUE_MAX_EVENTS, AI_STREAM_LIVE_QUEUE_MAX_EVENTS)
  );
  const aiStreamLiveQueueMaxBytes = Math.max(
    0,
    Math.min(options.aiStreamLiveQueueMaxBytes ?? AI_STREAM_LIVE_QUEUE_MAX_BYTES, AI_STREAM_LIVE_QUEUE_MAX_BYTES)
  );
  const terminalWebSockets = new WebSocketServer({ noServer: true, clientTracking: false,
    maxPayload: 65_537, perMessageDeflate: false, handleProtocols: (protocols) => protocols.size === 1 && protocols.has("devspace.terminal.v1")
      ? "devspace.terminal.v1" : false });
  const eventResponses = new Set<ServerResponse>();
  const previewObservationLog = new Map<string, string>();
  let started = false;
  let ownedSocket: SocketIdentity | undefined;
  let startupPreviewReconciliationHealthy = true;
  let resolverStarted = false;

  // Node's request listener is intentionally promise-backed; all handler paths produce a response.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const server = http.createServer(async (request, response) => {
    const fallbackRequestId = createId();
    const url = new URL(request.url ?? "/", "http://agent.local");
    const aiMutationEndpoint = (["ai-session.start", "ai-session.resume", "ai-session.turn.send", "ai-session.turn.interrupt", "ai-session.approval.respond", "ai-session.input.respond", "ai-session.stop"] as const)
      .map((operation) => f11AiAgentApiV1EndpointByOperation[operation]!)
      .find((endpoint) => url.pathname === endpoint.path);
    const githubEndpoint = (["github.app.inspect", "github.installation.verify", "github.installation.inspect", "github.installation.refresh", "github.installation.disconnect", "github.installation.reconnect.prepare", "github.repositories.list", "github.repositories.resolve"] as const)
      .map((operation) => githubAgentApiV1EndpointByOperation[operation])
      .find((endpoint) => request.method === endpoint.method && url.pathname === endpoint.path);
    const selectedEndpoint = request.method === "GET" && url.pathname === healthEndpoint.path ? healthEndpoint
      : request.method === "GET" && url.pathname === runtimeStatusEndpoint.path ? runtimeStatusEndpoint
      : request.method === "POST" && url.pathname === inspectEndpoint.path ? inspectEndpoint
      : githubEndpoint !== undefined ? githubEndpoint
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["configuration-revision.register"].path ? agentApiV1EndpointByOperation["configuration-revision.register"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["configuration-runtime-plan.register"].path ? agentApiV1EndpointByOperation["configuration-runtime-plan.register"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["project.managed-store.create"].path ? agentApiV1EndpointByOperation["project.managed-store.create"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["project.fetch"].path ? agentApiV1EndpointByOperation["project.fetch"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["project.push"].path ? agentApiV1EndpointByOperation["project.push"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["project.git.inspect"].path ? agentApiV1EndpointByOperation["project.git.inspect"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["project.git.diff"].path ? agentApiV1EndpointByOperation["project.git.diff"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["project.git.stage"].path ? agentApiV1EndpointByOperation["project.git.stage"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["project.git.unstage"].path ? agentApiV1EndpointByOperation["project.git.unstage"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["project.git.commit"].path ? agentApiV1EndpointByOperation["project.git.commit"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["workspace.create"].path ? agentApiV1EndpointByOperation["workspace.create"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["workspace.inspect"].path ? agentApiV1EndpointByOperation["workspace.inspect"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["workspace.files.list"].path ? agentApiV1EndpointByOperation["workspace.files.list"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["workspace.files.read"].path ? agentApiV1EndpointByOperation["workspace.files.read"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["workspace.files.save"].path ? agentApiV1EndpointByOperation["workspace.files.save"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["workspace.start"].path ? agentApiV1EndpointByOperation["workspace.start"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["workspace.stop"].path ? agentApiV1EndpointByOperation["workspace.stop"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["task.start"].path ? agentApiV1EndpointByOperation["task.start"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["process.stop"].path ? agentApiV1EndpointByOperation["process.stop"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["process.inspect"].path ? agentApiV1EndpointByOperation["process.inspect"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["terminal.create"].path ? agentApiV1EndpointByOperation["terminal.create"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["terminal.close"].path ? agentApiV1EndpointByOperation["terminal.close"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["preview.activate"].path ? agentApiV1EndpointByOperation["preview.activate"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["preview.deactivate"].path ? agentApiV1EndpointByOperation["preview.deactivate"]
      : request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["preview.inspect"].path ? agentApiV1EndpointByOperation["preview.inspect"]
      : request.method === "GET" && url.pathname === snapshotEndpoint.path ? snapshotEndpoint
      : request.method === "GET" && url.pathname === eventEndpoint.path ? eventEndpoint
      : request.method === "POST" && url.pathname === f11AiAgentApiV1EndpointByOperation["ai-provider.inspect"].path ? f11AiAgentApiV1EndpointByOperation["ai-provider.inspect"]
      : request.method === "GET" && /^\/v1\/ai-sessions\/[0-9a-f-]+\/events$/u.test(url.pathname) ? f11AiAgentApiV1EndpointByOperation["ai-session.events.stream"]
      : request.method === "POST" && url.pathname === f11AiAgentApiV1EndpointByOperation["ai-session.events.acknowledge"].path ? f11AiAgentApiV1EndpointByOperation["ai-session.events.acknowledge"]
      : request.method === "POST" && aiMutationEndpoint !== undefined ? aiMutationEndpoint
      : undefined;
    const projection = extractDevSpaceProtocolHeaders(request.rawHeaders.reduce<[string, string][]>((all, value, index, raw) => {
      if (index % 2 === 0) all.push([value, raw[index + 1] ?? ""]);
      return all;
    }, []));
    if (!projection.ok) return requestError(response, fallbackRequestId, now, {
      location: "headers", field: projection.error.header,
      reason: projection.error.code === "UNKNOWN_DEVSPACE_HEADER" ? "unknown" : "inconsistent"
    });
    const parsedHeaders = (selectedEndpoint?.headersSchema ?? healthEndpoint.headersSchema).safeParse(projection.headers);
    const requestId = typeof projection.headers["X-DevSpace-Request-Id"] === "string"
      ? projection.headers["X-DevSpace-Request-Id"]
      : fallbackRequestId;
    if (!parsedHeaders.success) {
      const protocol = projection.headers["X-DevSpace-Protocol-Version"];
      if (protocol !== "1") {
        const received = protocol !== undefined && /^\d+$/u.test(protocol) ? Number(protocol) : null;
        return sendJson(response, received !== null && received !== 1 ? 426 : 400, {
          meta: meta(requestId, now),
          error: {
            code: "PROTOCOL_VERSION_UNSUPPORTED",
            message: "The Agent protocol version is unsupported.",
            retryable: false,
            details: { supportedProtocolVersion: 1, receivedProtocolVersion: Number.isSafeInteger(received) ? received : null }
          }
        });
      }
      return requestError(response, requestId, now, { location: "headers", field: null, reason: "malformed" });
    }

    const isAiStreamPath = /^\/v1\/ai-sessions\/[0-9a-f-]+\/events$/u.test(url.pathname);
    if (url.pathname !== eventEndpoint.path && !isAiStreamPath && url.search !== "") return requestError(response, requestId, now, {
      location: "query", field: null, reason: "unknown"
    });

    if (githubEndpoint !== undefined) {
      try {
        let data: unknown;
        if (githubEndpoint.requestDataSchema === null) {
          if ((request.headers["content-length"] ?? "0") !== "0" || request.headers["transfer-encoding"] !== undefined) {
            return requestError(response, requestId, now, { location: "body", field: null, reason: "inconsistent" });
          }
        } else {
          let body: unknown;
          try { body = await readJsonBody(request); } catch { return requestError(response, requestId, now, { location: "body", field: null, reason: "malformed" }); }
          const parsed = githubEndpoint.requestBodySchema.safeParse(body);
          if (!parsed.success) return requestError(response, requestId, now, { location: "body", field: null, reason: "malformed" });
          data = parsed.data.data;
        }
        if (githubAuthority === null) throw new Error("github-app-unconfigured");
        const result = githubEndpoint.operation === "github.app.inspect" ? await githubAuthority.inspectApp()
          : githubEndpoint.operation === "github.installation.verify" ? await githubAuthority.verifyInstallation(data as never)
          : githubEndpoint.operation === "github.installation.inspect" ? await githubAuthority.inspectInstallation((data as { connectionId: string; lifecycleGeneration?: number }).connectionId,
            (data as { connectionId: string; lifecycleGeneration?: number }).lifecycleGeneration)
          : githubEndpoint.operation === "github.installation.refresh" ? await githubAuthority.refreshInstallation(data as never)
          : githubEndpoint.operation === "github.installation.disconnect" ? await githubAuthority.disconnectInstallation(data as never)
          : githubEndpoint.operation === "github.installation.reconnect.prepare" ? await githubAuthority.prepareGithubReconnect(data as never)
          : githubEndpoint.operation === "github.repositories.resolve" ? await githubAuthority.resolveRepository(data as never)
          : await githubAuthority.listRepositories(data as never);
        return sendJson(response, 200, githubEndpoint.successBodySchema.parse({ meta: meta(requestId, now), data: result }));
      } catch (error) {
        if (error instanceof AgentExecutionError && (error.failure.code === "AGENT_INTERNAL_ERROR"
          || ["GITHUB_AUTHORITY_INVALID", "GITHUB_CONNECTION_DISABLED", "GITHUB_AUTHORITY_GENERATION_STALE", "GITHUB_INSTALLATION_REMOVED", "GITHUB_INSTALLATION_SUSPENDED", "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE", "GITHUB_UPSTREAM_TRANSIENT", "GITHUB_INSTALLATION_UNAVAILABLE", "GITHUB_REPOSITORY_NOT_AUTHORIZED", "GITHUB_CONTENTS_PERMISSION_REQUIRED", "GITHUB_GIT_AUTHENTICATION_FAILED", "GITHUB_TOKEN_LEASE_ACTIVE"].includes(error.failure.code))) {
          const status = error.failure.code === "GITHUB_INSTALLATION_REMOVED" ? 410
            : error.failure.code === "GITHUB_INSTALLATION_SUSPENDED" || error.failure.code === "GITHUB_CONTENTS_PERMISSION_REQUIRED"
              || error.failure.code === "GITHUB_REPOSITORY_NOT_AUTHORIZED" || error.failure.code === "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE" ? 403
            : error.failure.code === "AGENT_INTERNAL_ERROR" ? 500 : error.failure.code === "GITHUB_AUTHORITY_INVALID" ? 422
            : error.failure.code === "GITHUB_GIT_AUTHENTICATION_FAILED" ? 502 : 503;
          return sendJson(response, status, githubEndpoint.errorSchema.parse({ meta: meta(requestId, now), error: error.failure }));
        }
        const message = error instanceof Error ? error.message : "";
        if (error instanceof z.ZodError || message === "github-authority-contract-violation" || message === "github-authority-programming-error") {
          return sendJson(response, 500, githubEndpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
            code: "AGENT_INTERNAL_ERROR", message: "The Agent encountered an unexpected error.", retryable: true, details: { incidentId: createId() }
          } }));
        }
        const selected = message === "github-connection-not-found" ? { status: 404, code: "GITHUB_CONNECTION_NOT_FOUND", retryable: false, details: {} }
          : message === "github-connection-disabled" ? { status: 409, code: "GITHUB_CONNECTION_DISABLED", retryable: false, details: {} }
          : message === "github-authority-generation-stale" ? { status: 409, code: "GITHUB_AUTHORITY_GENERATION_STALE", retryable: false, details: {} }
          : message === "github-token-lease-active" ? { status: 503, code: "GITHUB_TOKEN_LEASE_ACTIVE", retryable: true, details: {} }
          : message === "github-contents-permission-required" ? { status: 403, code: "GITHUB_CONTENTS_PERMISSION_REQUIRED", retryable: false, details: {} }
          : message === "github-permission-required" ? { status: 422, code: "GITHUB_AUTHORITY_INVALID", retryable: false, details: { reason: "permission-required" } }
          : message === "github-installation-unavailable" ? { status: 503, code: "GITHUB_INSTALLATION_UNAVAILABLE", retryable: true, details: {} }
          : message === "github-installation-removed" ? { status: 410, code: "GITHUB_INSTALLATION_REMOVED", retryable: false, details: {} }
          : message === "github-installation-suspended" ? { status: 403, code: "GITHUB_INSTALLATION_SUSPENDED", retryable: false, details: {} }
          : message === "github-repository-not-authorized" ? { status: 403, code: "GITHUB_REPOSITORY_NOT_AUTHORIZED", retryable: false, details: {} }
          : message === "github-repository-access-unavailable" ? { status: 403, code: "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE", retryable: false, details: {} }
          : message === "github-git-authentication-failed" ? { status: 502, code: "GITHUB_GIT_AUTHENTICATION_FAILED", retryable: false, details: {} }
          : message === "github-app-unconfigured" ? { status: 422, code: "GITHUB_AUTHORITY_INVALID", retryable: false, details: { reason: "unconfigured" } }
          : message === "github-authority-invalid" || message === "github-installation-conflict" ? { status: 422, code: "GITHUB_AUTHORITY_INVALID", retryable: false, details: { reason: "mismatch" } }
          : message === "github-upstream-transient" ? { status: 503, code: "GITHUB_UPSTREAM_TRANSIENT", retryable: true, details: {} }
          : message === "github-upstream-invalid" || message === "github-token-mint-failed" || message === "github-operation-failed"
            ? { status: 503, code: "GITHUB_AUTHORITY_INVALID", retryable: false, details: { reason: "upstream-unavailable" } }
          : { status: 500, code: "AGENT_INTERNAL_ERROR", retryable: true, details: { incidentId: createId() } };
        return sendJson(response, selected.status, githubEndpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
          code: selected.code, message: selected.code === "AGENT_INTERNAL_ERROR" ? "The Agent encountered an unexpected error."
            : selected.code === "GITHUB_AUTHORITY_INVALID" && "reason" in selected.details
              && selected.details.reason === "permission-required"
              ? "The GitHub installation does not have the required read permission."
              : "GitHub App authority could not be established safely.",
          retryable: selected.retryable, details: selected.details
        } }));
      }
    }

    const aiStreamMatch = /^\/v1\/ai-sessions\/([0-9a-f-]+)\/events$/u.exec(url.pathname);
    if (request.method === "GET" && aiStreamMatch !== null) {
      const endpoint = f11AiAgentApiV1EndpointByOperation["ai-session.events.stream"];
      if ((request.headers["content-length"] ?? "0") !== "0" || request.headers["transfer-encoding"] !== undefined) {
        return requestError(response, requestId, now, { location: "body", field: null, reason: "inconsistent" });
      }
      const query = endpoint.querySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
      if (!query.success) return requestError(response, requestId, now, { location: "query", field: null, reason: "malformed" });
      const afterSequence = Number(query.data.afterSequence);
      const sessionId = aiStreamMatch[1]!;
      const releaseAdmission = aiStreamAdmission.tryAcquire(sessionId);
      if (releaseAdmission === null) {
        return sendJson(response, 503, endpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
          code: "AI_OUTBOX_UNAVAILABLE",
          message: "The AI event stream is temporarily unavailable.",
          retryable: true,
          failure: {
            code: "AI_OUTBOX_UNAVAILABLE",
            category: "dependency-unavailable",
            incidentId: createId()
          }
        } }));
      }
      eventResponses.add(response);
      const delivery = createAiStreamDelivery({
        request,
        response,
        backpressureTimeoutMs: aiStreamBackpressureTimeoutMs,
        liveQueueMaxEvents: aiStreamLiveQueueMaxEvents,
        liveQueueMaxBytes: aiStreamLiveQueueMaxBytes,
        onClose: () => {
          eventResponses.delete(response);
          releaseAdmission();
        }
      });
      let replay;
      try { replay = await aiRuntime.replay(sessionId, afterSequence); }
      catch (error) {
        const code = error instanceof AiOutboxError ? error.code : "AI_OUTBOX_UNAVAILABLE";
        const selected = code === "AI_EVENT_GAP" ? { status: 409, retryable: false } : { status: 503, retryable: true };
        delivery.close(false);
        if (response.destroyed) return;
        return sendJson(response, selected.status, endpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
          code, message: "The AI event outbox could not be replayed safely.", retryable: selected.retryable,
          failure: { code, category: code === "AI_EVENT_GAP" ? "protocol-failure" : "dependency-unavailable", incidentId: createId() }
        } }));
      }
      if (delivery.closed) return;
      try {
        response.writeHead(200, { "content-type": endpoint.successContentType, "cache-control": "no-store", connection: "keep-alive" });
        response.flushHeaders();
        for (const event of replay) {
          if (!await delivery.writeFrame(event)) return;
        }
        const throughSequence = replay.at(-1)?.sequence ?? afterSequence;
        const synchronization = await aiRuntime.synchronized(sessionId);
        const synchronized = aiEventStreamFrameSchema.parse({
          schemaVersion: "devspace.ai-stream/v1",
          frameType: "stream.synchronized",
          sessionId,
          throughSequence,
          processGeneration: synchronization.processGeneration,
          pendingInteractionIds: synchronization.pendingInteractionIds
        });
        if (!await delivery.writeFrame(synchronized)) return;
        const unsubscribe = await aiRuntime.subscribe(
          sessionId,
          throughSequence,
          (event) => delivery.enqueueLive(event)
        );
        delivery.setUnsubscribe(unsubscribe);
      } catch {
        delivery.close();
      }
      return;
    }

    const aiMutationOperations = ["ai-session.start", "ai-session.resume", "ai-session.turn.send", "ai-session.turn.interrupt", "ai-session.approval.respond", "ai-session.input.respond", "ai-session.stop"] as const;
    for (const operation of aiMutationOperations) {
      const endpoint = f11AiAgentApiV1EndpointByOperation[operation]!;
      if (request.method !== endpoint.method || url.pathname !== endpoint.path) continue;
      let body: { data: unknown };
      try { body = endpoint.requestBodySchema.parse(await readJsonBody(request)); }
      catch { return requestError(response, requestId, now, { location: "body", field: null, reason: "malformed" }); }
      const operationId = projection.headers["X-DevSpace-Operation-Id"];
      if (typeof operationId !== "string") return requestError(response, requestId, now, { location: "headers", field: "X-DevSpace-Operation-Id", reason: "missing" });
      try {
        if (operation === "ai-session.start") await aiRuntime.start(body.data as Parameters<AiSessionRuntime["start"]>[0]);
        else if (operation === "ai-session.resume") throw new Error("ai-capability-unsupported");
        else if (operation === "ai-session.turn.send") await aiRuntime.sendTurn(body.data as Parameters<AiSessionRuntime["sendTurn"]>[0]);
        else if (operation === "ai-session.turn.interrupt") await aiRuntime.interrupt(body.data as Parameters<AiSessionRuntime["interrupt"]>[0]);
        else if (operation === "ai-session.approval.respond") await aiRuntime.respondToAiApproval(body.data as Parameters<AiSessionRuntime["respondToAiApproval"]>[0]);
        else if (operation === "ai-session.input.respond") await aiRuntime.respondToAiStructuredInput(body.data as Parameters<AiSessionRuntime["respondToAiStructuredInput"]>[0]);
        else await aiRuntime.stop(body.data as Parameters<AiSessionRuntime["stop"]>[0]);
        return sendJson(response, endpoint.successStatus, endpoint.successBodySchema.parse({ meta: meta(requestId, now), data: { operationId } }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "ai-provider-failure";
        const fallbackCode = operation === "ai-session.start" ? "AI_PROFILE_UNAVAILABLE" : "AI_OUTBOX_UNAVAILABLE";
        const code = message === "ai-profile-unavailable" ? "AI_PROFILE_UNAVAILABLE"
          : message === "ai-profile-not-found" ? "AI_PROFILE_NOT_FOUND"
            : message === "ai-capability-unsupported" ? "AI_CAPABILITY_UNSUPPORTED"
              : message === "ai-turn-state-conflict" ? "AI_TURN_STATE_CONFLICT"
                : message === "ai-interaction-state-conflict" || message === "ai-interaction-response-ambiguous" ? "AI_INTERACTION_STATE_CONFLICT"
                  : message === "ai-profile-revision-mismatch" ? "AI_PROFILE_REVISION_CONFLICT"
                : message === "ai-identity-mismatch" ? "AI_IDENTITY_MISMATCH" : fallbackCode;
        const policy: Record<string, { status: number; retryable: boolean; category: string; incident: boolean }> = {
          AI_PROFILE_UNAVAILABLE: { status: 503, retryable: true, category: "dependency-unavailable", incident: false },
          AI_PROFILE_NOT_FOUND: { status: 404, retryable: false, category: "user-error", incident: false },
          AI_CAPABILITY_UNSUPPORTED: { status: 422, retryable: false, category: "user-error", incident: false },
          AI_TURN_STATE_CONFLICT: { status: 409, retryable: false, category: "state-conflict", incident: false },
          AI_INTERACTION_STATE_CONFLICT: { status: 409, retryable: false, category: "state-conflict", incident: false },
          AI_PROFILE_REVISION_CONFLICT: { status: 409, retryable: false, category: "state-conflict", incident: false },
          AI_IDENTITY_MISMATCH: { status: 409, retryable: false, category: "internal-failure", incident: true },
          AI_OUTBOX_UNAVAILABLE: { status: 503, retryable: true, category: "dependency-unavailable", incident: true },
          AI_PROVIDER_TRANSPORT_FAILURE: { status: 502, retryable: true, category: "transport-failure", incident: true }
        };
        const selected = policy[code]!; const incidentId = selected.incident ? createId() : null;
        return sendJson(response, selected.status, endpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
          code, message: code === "AI_PROFILE_UNAVAILABLE" ? "Codex is unavailable for this workspace." : "The AI session action could not be completed.", retryable: selected.retryable,
          failure: { code, category: selected.category, incidentId }
        } }));
      }
    }

    if (request.method === "POST" && url.pathname === f11AiAgentApiV1EndpointByOperation["ai-provider.inspect"].path) {
      const endpoint = f11AiAgentApiV1EndpointByOperation["ai-provider.inspect"];
      let body: { data: { projectId: string; workspaceId: string; profileId: string } };
      try { body = endpoint.requestBodySchema.parse(await readJsonBody(request)); }
      catch { return requestError(response, requestId, now, { location: "body", field: null, reason: "malformed" }); }
      try { return sendJson(response, 200, endpoint.successBodySchema.parse({ meta: meta(requestId, now), data: await aiRuntime.inspect(body.data) })); }
      catch (error) {
        const code = error instanceof Error && error.message === "ai-profile-not-found" ? "AI_PROFILE_NOT_FOUND" : "AI_INTERNAL_FAILURE";
        return sendJson(response, code === "AI_PROFILE_NOT_FOUND" ? 404 : 500, endpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
          code, message: "The Codex profile could not be inspected.", retryable: code !== "AI_PROFILE_NOT_FOUND", failure: { code, category: code === "AI_PROFILE_NOT_FOUND" ? "user-error" : "internal-failure", incidentId: code === "AI_PROFILE_NOT_FOUND" ? null : createId() }
        } }));
      }
    }

    if (request.method === "POST" && url.pathname === f11AiAgentApiV1EndpointByOperation["ai-session.events.acknowledge"].path) {
      const endpoint = f11AiAgentApiV1EndpointByOperation["ai-session.events.acknowledge"];
      let body: { data: Parameters<AiSessionRuntime["acknowledge"]>[0] };
      try { body = endpoint.requestBodySchema.parse(await readJsonBody(request)); }
      catch { return requestError(response, requestId, now, { location: "body", field: null, reason: "malformed" }); }
      try {
        const acknowledged = await aiRuntime.acknowledge(body.data);
        return sendJson(response, 200, endpoint.successBodySchema.parse({ meta: meta(requestId, now), data: acknowledged }));
      } catch (error) {
        const code = error instanceof AiOutboxError ? error.code : "AI_OUTBOX_UNAVAILABLE";
        const selected = code === "AI_IDENTITY_MISMATCH"
          ? { status: 409, retryable: false, category: "internal-failure" }
          : code === "AI_EVENT_SEQUENCE_CONFLICT"
            ? { status: 409, retryable: false, category: "protocol-failure" }
            : { status: 503, retryable: true, category: "dependency-unavailable" };
        return sendJson(response, selected.status, endpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
          code, message: "The AI event acknowledgement could not be completed safely.", retryable: selected.retryable,
          failure: { code, category: selected.category, incidentId: createId() }
        } }));
      }
    }

    if (request.method === "GET" && url.pathname === healthEndpoint.path) {
      if ((request.headers["content-length"] ?? "0") !== "0" || request.headers["transfer-encoding"] !== undefined) {
        return requestError(response, requestId, now, { location: "body", field: null, reason: "inconsistent" });
      }
      const healthBreakdown = {
        "managed-workspace-layer": managed.isHealthy ? "healthy" : "unhealthy",
        "operation-journal": journal.isHealthy ? "healthy" : "unhealthy",
        "operation-executor": executor.isHealthy ? "healthy" : "unhealthy",
        "startup-preview-reconciliation": startupPreviewReconciliationHealthy ? "healthy" : "unhealthy"
      };
      const status = Object.values(healthBreakdown).every((value) => value === "healthy") ? "ok" : "degraded";
      logger.info("agent.health.evaluated", "Agent health evaluated", { requestId, healthBreakdown });
      return sendJson(response, 200, healthEndpoint.successBodySchema.parse({ meta: meta(requestId, now), data: { status } }));
    }

    if (request.method === "GET" && url.pathname === runtimeStatusEndpoint.path) {
      if ((request.headers["content-length"] ?? "0") !== "0" || request.headers["transfer-encoding"] !== undefined) {
        return requestError(response, requestId, now, { location: "body", field: null, reason: "inconsistent" });
      }
      return sendJson(response, 200, runtimeStatusEndpoint.successBodySchema.parse({ meta: meta(requestId, now), data: {
        rootlessRuntime: await managed.runtimeStatus(),
        operationJournal: journal.isHealthy ? "available" : "corrupt", checkedAt: now().toISOString()
      } }));
    }

    if (request.method === "GET" && url.pathname === eventEndpoint.path) {
      if ((request.headers["content-length"] ?? "0") !== "0" || request.headers["transfer-encoding"] !== undefined) {
        return requestError(response, requestId, now, { location: "body", field: null, reason: "inconsistent" });
      }
      const entries = [...url.searchParams.entries()];
      if (entries.length !== 1 || entries[0]?.[0] !== "cursor") {
        if (entries.length === 0) {
          return sendJson(response, 400, eventEndpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
            code: "EVENT_CURSOR_INVALID", message: "The event cursor is invalid.", retryable: false, details: { reason: "missing" }
          } }));
        }
        return requestError(response, requestId, now, { location: "query", field: null, reason: entries.length > 1 ? "inconsistent" : "unknown" });
      }
      const parsed = parseEventCursor(entries[0][1]);
      if (!parsed.ok) return sendJson(response, 400, eventEndpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
        code: "EVENT_CURSOR_INVALID", message: "The event cursor is invalid.", retryable: false, details: { reason: parsed.reason }
      } }));
      const replay = events.replay(parsed.cursor);
      if (!replay.ok) return sendJson(response, 409, eventEndpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
        code: "EVENT_SNAPSHOT_REQUIRED", message: "A new Agent snapshot is required.", retryable: false,
        details: { reason: replay.reason, currentAgentBootId: events.bootId, snapshotPath: "/v1/snapshot" }
      } }));
      response.writeHead(200, { "content-type": eventEndpoint.successContentType, "cache-control": "no-store", connection: "keep-alive" });
      response.flushHeaders();
      eventResponses.add(response);
      for (const event of replay.events) response.write(`${JSON.stringify(event)}\n`);
      const unsubscribe = events.subscribe((event) => { if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`); });
      request.once("close", unsubscribe);
      response.once("close", () => { eventResponses.delete(response); unsubscribe(); });
      return;
    }

    if (request.method === "GET" && url.pathname === snapshotEndpoint.path) {
      if ((request.headers["content-length"] ?? "0") !== "0" || request.headers["transfer-encoding"] !== undefined) {
        return requestError(response, requestId, now, { location: "body", field: null, reason: "inconsistent" });
      }
      if (!managed.isHealthy || !journal.isHealthy || !executor.isHealthy) return sendJson(response, 500, snapshotEndpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
        code: "AGENT_INTERNAL_ERROR", message: "Agent-private state is corrupt.", retryable: true, details: { incidentId: createId() }
      } }));
      await execution.flushHarnessSettlements().catch(() => undefined);
      const data = { agentBootId, throughCursor: events.throughCursor, resources: executor.snapshotResources(), operationObservations: journal.observations() };
      return sendJson(response, 200, snapshotEndpoint.successBodySchema.parse({ meta: meta(requestId, now), data }));
    }

    if (request.method === "POST" && (url.pathname === "/v1/harness-sessions/start" || url.pathname === "/v1/harness-sessions/resume" || url.pathname === "/v1/harness-sessions/inspect")) {
      let raw: unknown;
      try { raw = await readJsonBody(request); }
      catch { return requestError(response, requestId, now, { location: "body", field: null, reason: "malformed" }); }
      const envelope = z.strictObject({ data: z.unknown() }).safeParse(raw);
      if (!envelope.success) return requestError(response, requestId, now, { location: "body", field: null, reason: "malformed" });
      try {
        if (url.pathname.endsWith("/inspect")) {
          const data = nativeHarnessInspectDataSchema.parse(envelope.data.data);
          const capability = data.definition === undefined
            ? await harnessRuntime.capability(data.sessionId)
            : await harnessRuntime.capability(data.sessionId, data.definition);
          return sendJson(response, 200, { meta: meta(requestId, now), data: nativeHarnessInspectResponseSchema.parse(capability) });
        }
        let sessionId: string;
        if (url.pathname.endsWith("/start")) {
          const data = nativeHarnessStartDataSchema.parse(envelope.data.data);
          sessionId = data.sessionId;
          if (data.definition !== undefined) harnessRuntime.registerCustom(data.definition);
          await harnessRuntime.start(data);
        } else {
          const data = nativeHarnessResumeDataSchema.parse(envelope.data.data);
          sessionId = data.sessionId;
          await harnessRuntime.resumeExec({
            sessionId: data.sessionId, projectId: data.projectId, processId: data.processId,
            terminalId: data.terminalId, processGeneration: data.processGeneration,
            ...(data.definition === undefined ? {} : { definition: data.definition })
          });
        }
        const snapshot = await harnessRuntime.publicSnapshot(sessionId);
        return sendJson(response, 200, { meta: meta(requestId, now), data: { ok: true, settled: snapshot.state !== "live" } });
      } catch (error) {
        const code = error instanceof HarnessRuntimeError || error instanceof HarnessHomeError ? error.code : "AGENT_INTERNAL_ERROR";
        const status = code === "HARNESS_ADMISSION_UNCERTAIN" ? 503
          : code === "HARNESS_HOME_IN_USE" || code === "RESOURCE_STATE_CONFLICT" || code === "HARNESS_DEFINITION_CONFLICT" ? 409
            : code === "AI_CAPABILITY_UNSUPPORTED" || code === "HARNESS_SLOT_MOUNT_MISSING" || code === "HARNESS_EXECUTABLE_UNAVAILABLE" ? 422
              : code === "RESOURCE_NOT_FOUND" ? 404 : 500;
        return sendJson(response, status, {
          meta: meta(requestId, now),
          error: {
            code,
            message: error instanceof Error ? error.message : "harness-failure",
            retryable: code === "HARNESS_ADMISSION_UNCERTAIN",
            details: {}
          }
        });
      }
    }

    const mutationRoutes = ["configuration-revision.register", "configuration-runtime-plan.register", "project.managed-store.create", "project.fetch", "project.push", "project.git.stage", "project.git.unstage", "project.git.commit", "workspace.create", "workspace.start", "workspace.stop",
      "task.start", "process.stop", "terminal.create", "terminal.close", "preview.activate", "preview.deactivate"] as const;
    for (const operation of mutationRoutes) {
      const endpoint = agentApiV1EndpointByOperation[operation];
      if (request.method !== endpoint.method || url.pathname !== endpoint.path) continue;
      let body: { data: unknown };
      try { body = endpoint.requestBodySchema.parse(await readJsonBody(request)); }
      catch { return requestError(response, requestId, now, { location: "body", field: null, reason: "malformed" }); }
      if (operation === "configuration-revision.register") {
        try { managed.validateRevision(body.data as Parameters<ManagedWorkspaces["validateRevision"]>[0]); }
        catch (error) {
          if (error instanceof ConfigurationValidationError) {
            return sendJson(response, 422, endpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
              code: "CONFIGURATION_INVALID", message: error.message, retryable: false,
              details: { revisionId: (body.data as { revisionId: string }).revisionId, reason: error.reason }
            } }));
          }
          throw error;
        }
      }
      const operationId = projection.headers["X-DevSpace-Operation-Id"];
      if (typeof operationId !== "string") return requestError(response, requestId, now, { location: "headers", field: "X-DevSpace-Operation-Id", reason: "missing" });
      let record;
      try {
        const wasKnown = journal.get(operationId) !== undefined;
        record = await journal.accept(operationId, operation, body.data);
        logger.info("agent.operation.accepted", "Agent operation accepted", {
          requestId, operationId, operationName: operation, operationState: record.state, ...diagnosticResourceFields(body.data)
        });
        if (!wasKnown && record.state === "accepted") events.progressed(operationId,
          { type: "project", projectId: (body.data as { projectId: string }).projectId }, "Operation durably accepted.");
      }
      catch (error) {
        if (error instanceof OperationConflictError) {
          return sendJson(response, 409, endpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
            code: "OPERATION_CONFLICT", message: error.message, retryable: false,
            details: { operationId, reason: error.reason }
          } }));
        }
        return sendJson(response, 503, endpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
          code: "OPERATION_JOURNAL_UNAVAILABLE", message: "The Agent operation journal is unavailable.", retryable: true,
          details: { reason: journal.isHealthy ? "unavailable" : "corrupt" }
        } }));
      }
      executor.schedule(record);
      return sendJson(response, 202, endpoint.successBodySchema.parse({ meta: meta(requestId, now), data: { operationId } }));
    }

    if (request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["preview.inspect"].path) {
      const endpoint = agentApiV1EndpointByOperation["preview.inspect"];
      let body;
      try { body = endpoint.requestBodySchema.parse(await readJsonBody(request)); }
      catch { return requestError(response, requestId, now, { location: "body", field: null, reason: "malformed" }); }
      const startedAt = now().valueOf();
      const resourceFields = diagnosticResourceFields(body.data);
      logger.debug("agent.preview.inspection.started", "Preview inspection started", { requestId, ...resourceFields });
      try {
        const data = await managed.inspectPreview(body.data);
        const observationKey = `${body.data.projectId}:${body.data.workspaceId}:${body.data.previewId}`;
        const observationSignature = `${data.observedState}:${data.routePresent}:${data.diagnosticCode ?? ""}`;
        const previousObservation = previewObservationLog.get(observationKey);
        if (["failed", "lost", "unhealthy"].includes(data.observedState)) {
          if (previousObservation !== observationSignature) logger.warn("agent.preview.observation.degraded", "Preview observation is degraded", {
            requestId, durationMs: Math.max(0, now().valueOf() - startedAt), errorCategory: "preview-observation",
            ...(data.diagnosticCode === undefined ? {} : { errorCode: data.diagnosticCode }), ...resourceFields
          });
        } else if (previousObservation !== undefined && previousObservation !== observationSignature) {
          logger.info("agent.preview.observation.recovered", "Preview observation recovered", {
            requestId, durationMs: Math.max(0, now().valueOf() - startedAt), observedState: data.observedState,
            routePresent: data.routePresent, ...resourceFields
          });
        }
        previewObservationLog.set(observationKey, observationSignature);
        logger.debug("agent.preview.inspection.completed", "Preview inspection completed", {
          requestId, durationMs: Math.max(0, now().valueOf() - startedAt), observedState: data.observedState,
          routePresent: data.routePresent, routeStatus: data.routePresent ? "present" : "absent",
          ...(data.diagnosticCode === undefined ? {} : { errorCode: data.diagnosticCode }), ...resourceFields
        });
        return sendJson(response, 200, endpoint.successBodySchema.parse({ meta: meta(requestId, now), data: toPublicPreviewInspectionData(data) }));
      } catch (error) {
        const failure: AgentExecutionFailure = error instanceof AgentExecutionError ? error.failure : {
          code: "AGENT_INTERNAL_ERROR", message: "The preview could not be inspected safely.", retryable: true,
          details: { incidentId: createId() }
        };
        const incidentId = "incidentId" in failure.details ? failure.details.incidentId : undefined;
        const fields = {
          requestId, durationMs: Math.max(0, now().valueOf() - startedAt), errorCategory: "preview-inspection",
          failureCategory: classifyFailureCode(failure.code), errorCode: failure.code,
          ...(incidentId === undefined ? {} : { incidentId }), ...resourceFields
        };
        if (incidentId === undefined) logger.warn("agent.preview.inspection.failed", "Preview inspection failed", fields);
        else logger.error("agent.preview.inspection.failed", "Preview inspection failed", fields);
        if (error instanceof AgentExecutionError) {
          const status = error.failure.code === "RESOURCE_NOT_FOUND" ? 404
            : error.failure.code === "ROOTLESS_RUNTIME_UNAVAILABLE" ? 503 : 500;
          sendEndpointErrorResponse(endpoint, response, status, requestId, now, failure, error, createId, logger);
          return;
        }
        sendEndpointErrorResponse(endpoint, response, 500, requestId, now, failure, error, createId, logger);
        return;
      }
    }

    if (request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["project.git.inspect"].path) {
      const endpoint = agentApiV1EndpointByOperation["project.git.inspect"];
      let body;
      try { body = endpoint.requestBodySchema.parse(await readJsonBody(request)); }
      catch { return requestError(response, requestId, now, { location: "body", field: null, reason: "malformed" }); }
      try {
        const data = await managed.inspectGit(body.data.projectId, body.data.workspaceId);
        return sendJson(response, 200, endpoint.successBodySchema.parse({ meta: meta(requestId, now), data }));
      } catch (error) {
        if (!managed.isHealthy) return sendJson(response, 500, endpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
          code: "AGENT_INTERNAL_ERROR", message: "Agent-private state is corrupt.", retryable: true, details: { incidentId: createId() }
        } }));
        if (error instanceof AgentExecutionError) {
          sendEndpointErrorResponse(endpoint, response, gitFailureStatus(error.failure.code), requestId, now, error.failure, error, createId, logger);
          return;
        }
        const isWorkspace = body.data.workspaceId !== null;
        return sendJson(response, 404, endpoint.errorSchema.parse({ meta: meta(requestId, now), error: isWorkspace
          ? { code: "RESOURCE_NOT_FOUND", message: "The workspace was not found.", retryable: false, details: { resource: { type: "workspace", id: body.data.workspaceId } } }
          : { code: "PROJECT_NOT_FOUND", message: "The managed project was not found.", retryable: false, details: { projectId: body.data.projectId } }
        }));
      }
    }

    if (request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["project.git.diff"].path) {
      const endpoint = agentApiV1EndpointByOperation["project.git.diff"];
      let body;
      try { body = endpoint.requestBodySchema.parse(await readJsonBody(request)); }
      catch { return requestError(response, requestId, now, { location: "body", field: null, reason: "malformed" }); }
      try {
        const data = await managed.diffGit(body.data.projectId, body.data.workspaceId, body.data.path, body.data.kind);
        return sendJson(response, 200, endpoint.successBodySchema.parse({ meta: meta(requestId, now), data }));
      } catch (error) {
        if (!managed.isHealthy) return sendJson(response, 500, endpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
          code: "AGENT_INTERNAL_ERROR", message: "Agent-private state is corrupt.", retryable: true, details: { incidentId: createId() }
        } }));
        if (error instanceof AgentExecutionError) {
          sendEndpointErrorResponse(endpoint, response, gitFailureStatus(error.failure.code), requestId, now, error.failure, error, createId, logger);
          return;
        }
        sendEndpointErrorResponse(endpoint, response, 500, requestId, now, {
          code: "AGENT_INTERNAL_ERROR", message: "The Agent encountered an unexpected error.", retryable: true, details: { incidentId: createId() }
        }, error, createId, logger);
        return;
      }
    }

    if (request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["workspace.inspect"].path) {
      const endpoint = agentApiV1EndpointByOperation["workspace.inspect"];
      let body;
      try { body = endpoint.requestBodySchema.parse(await readJsonBody(request)); }
      catch { return requestError(response, requestId, now, { location: "body", field: null, reason: "malformed" }); }
      try {
        const data = await managed.inspectWorkspace(body.data.projectId, body.data.workspaceId);
        return sendJson(response, 200, endpoint.successBodySchema.parse({ meta: meta(requestId, now), data }));
      } catch {
        if (!managed.isHealthy) return sendJson(response, 500, endpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
          code: "AGENT_INTERNAL_ERROR", message: "Agent-private state is corrupt.", retryable: true, details: { incidentId: createId() }
        } }));
        return sendJson(response, 404, endpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
          code: "RESOURCE_NOT_FOUND", message: "The workspace was not found.", retryable: false,
          details: { resource: { type: "workspace", id: body.data.workspaceId } }
        } }));
      }
    }

    const workspaceFileOperation = request.method === "POST"
      ? (["workspace.files.list", "workspace.files.read", "workspace.files.save"] as const)
        .map((operation) => agentApiV1EndpointByOperation[operation])
        .find((candidate) => candidate.path === url.pathname)
      : undefined;
    if (workspaceFileOperation !== undefined) {
      let body;
      try { body = workspaceFileOperation.requestBodySchema.parse(await readJsonBody(request)); }
      catch { return requestError(response, requestId, now, { location: "body", field: null, reason: "malformed" }); }
      try {
        const requestData = body.data as {
          readonly projectId: string;
          readonly workspaceId: string;
          readonly path: string;
          readonly content?: string;
          readonly expectedRevision?: string;
        };
        const data = workspaceFileOperation.operation === "workspace.files.list"
          ? await managed.listWorkspaceDirectory(requestData.projectId, requestData.workspaceId, requestData.path)
          : workspaceFileOperation.operation === "workspace.files.read"
            ? await managed.readWorkspaceFile(requestData.projectId, requestData.workspaceId, requestData.path)
            : await managed.saveWorkspaceFile(requestData.projectId, requestData.workspaceId, requestData.path, requestData.content!, requestData.expectedRevision!);
        return sendJson(response, 200, workspaceFileOperation.successBodySchema.parse({ meta: meta(requestId, now), data }));
      } catch (error) {
        const failure: AgentExecutionFailure = error instanceof AgentExecutionError ? error.failure : {
          code: "AGENT_INTERNAL_ERROR", message: "The workspace file operation failed safely.", retryable: true,
          details: { incidentId: createId() }
        };
        const status = failure.code === "RESOURCE_NOT_FOUND" || failure.code === "WORKSPACE_FILE_NOT_FOUND" ? 404
          : failure.code === "WORKSPACE_FILE_TOO_LARGE" || failure.code === "WORKSPACE_DIRECTORY_TOO_LARGE" ? 413
            : failure.code === "WORKSPACE_PATH_INVALID" || failure.code === "WORKSPACE_FILE_UNSUPPORTED" ? 422
              : failure.code === "WORKSPACE_FILE_CHANGED" ? 409 : 500;
        sendEndpointErrorResponse(workspaceFileOperation, response, status, requestId, now, failure, error, createId, logger);
        return;
      }
    }

    if (request.method === "POST" && url.pathname === agentApiV1EndpointByOperation["process.inspect"].path) {
      const endpoint = agentApiV1EndpointByOperation["process.inspect"];
      let body;
      try { body = endpoint.requestBodySchema.parse(await readJsonBody(request)); }
      catch { return requestError(response, requestId, now, { location: "body", field: null, reason: "malformed" }); }
      try {
        const data = await execution.inspect(body.data.projectId, body.data.workspaceId, body.data.processId);
        return sendJson(response, 200, endpoint.successBodySchema.parse({ meta: meta(requestId, now), data }));
      } catch (error) {
        if (error instanceof AgentExecutionError) {
          const status = error.failure.code === "RESOURCE_NOT_FOUND" ? 404 : error.failure.code === "PROCESS_IDENTITY_MISMATCH" ? 409 : 503;
          return sendJson(response, status, endpoint.errorSchema.parse({ meta: meta(requestId, now), error: error.failure }));
        }
        return sendJson(response, 500, endpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
          code: "AGENT_INTERNAL_ERROR", message: "The process could not be inspected safely.", retryable: true, details: { incidentId: createId() }
        } }));
      }
    }

    if (request.method === "POST" && url.pathname === inspectEndpoint.path) {
      let body: ReturnType<typeof inspectEndpoint.requestBodySchema.parse>;
      try {
        body = inspectEndpoint.requestBodySchema.parse(await readJsonBody(request));
      } catch {
        return requestError(response, requestId, now, { location: "body", field: null, reason: "malformed" });
      }
      if (body.data.source.kind === "github-app") {
        try {
          const data = await managed.inspectSource(body.data.source, body.data.githubAuthorityGeneration);
          return sendJson(response, 200, inspectEndpoint.successBodySchema.parse({ meta: meta(requestId, now), data }));
        } catch (error) {
          if (error instanceof AgentExecutionError && error.internalReason !== undefined) {
            logger.error("agent.source.inspection.failed", "Private source inspection failed at an internal GitHub boundary", {
              requestId, errorCategory: "github-authority-boundary", errorCode: error.failure.code,
              internalReason: error.internalReason
            });
          }
          if (error instanceof AgentExecutionError && (error.failure.code === "AGENT_INTERNAL_ERROR"
            || ["GITHUB_AUTHORITY_INVALID", "GITHUB_CONNECTION_DISABLED", "GITHUB_AUTHORITY_GENERATION_STALE", "GITHUB_INSTALLATION_REMOVED", "GITHUB_INSTALLATION_SUSPENDED", "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE", "GITHUB_UPSTREAM_TRANSIENT", "GITHUB_INSTALLATION_UNAVAILABLE", "GITHUB_REPOSITORY_NOT_AUTHORIZED", "GITHUB_CONTENTS_PERMISSION_REQUIRED", "GITHUB_GIT_AUTHENTICATION_FAILED", "GITHUB_TOKEN_LEASE_ACTIVE"].includes(error.failure.code))) {
            const status = error.failure.code === "AGENT_INTERNAL_ERROR" ? 500
              : error.failure.code === "GITHUB_CONNECTION_DISABLED" || error.failure.code === "GITHUB_AUTHORITY_GENERATION_STALE" ? 409
              : error.failure.code === "GITHUB_INSTALLATION_REMOVED" ? 410
              : error.failure.code === "GITHUB_INSTALLATION_SUSPENDED" || error.failure.code === "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE"
                || error.failure.code === "GITHUB_CONTENTS_PERMISSION_REQUIRED" || error.failure.code === "GITHUB_REPOSITORY_NOT_AUTHORIZED" ? 403
              : error.failure.code === "GITHUB_AUTHORITY_INVALID" ? 422
              : error.failure.code === "GITHUB_GIT_AUTHENTICATION_FAILED" ? 502 : 503;
            return sendJson(response, status, inspectEndpoint.errorSchema.parse({ meta: meta(requestId, now), error: error.failure }));
          }
          const message = error instanceof Error ? error.message : "";
          if (error instanceof z.ZodError || message === "github-authority-contract-violation" || message === "github-authority-programming-error") {
            return sendJson(response, 500, inspectEndpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
              code: "AGENT_INTERNAL_ERROR", message: "The Agent encountered an unexpected error.", retryable: true, details: { incidentId: createId() }
            } }));
          }
          const selected = message === "github-connection-disabled"
            ? { status: 409, code: "GITHUB_CONNECTION_DISABLED" as const, retryable: false }
            : message === "github-authority-generation-stale"
              ? { status: 409, code: "GITHUB_AUTHORITY_GENERATION_STALE" as const, retryable: false }
            : message === "github-installation-removed"
              ? { status: 410, code: "GITHUB_INSTALLATION_REMOVED" as const, retryable: false }
            : message === "github-installation-suspended"
              ? { status: 403, code: "GITHUB_INSTALLATION_SUSPENDED" as const, retryable: false }
            : message === "github-repository-access-unavailable"
              ? { status: 403, code: "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE" as const, retryable: false }
            : message === "github-upstream-transient"
              ? { status: 503, code: "GITHUB_UPSTREAM_TRANSIENT" as const, retryable: true }
            : message === "github-permission-required"
              ? { status: 422, code: "GITHUB_AUTHORITY_INVALID" as const, retryable: false, details: { reason: "permission-required" as const } }
            : message === "github-contents-permission-required"
            ? { status: 403, code: "GITHUB_CONTENTS_PERMISSION_REQUIRED" as const, retryable: false }
            : message === "github-repository-not-authorized"
              ? { status: 403, code: "GITHUB_REPOSITORY_NOT_AUTHORIZED" as const, retryable: false }
              : message === "github-installation-unavailable"
                ? { status: 503, code: "GITHUB_INSTALLATION_UNAVAILABLE" as const, retryable: true }
                : message === "github-git-authentication-failed"
                  ? { status: 502, code: "GITHUB_GIT_AUTHENTICATION_FAILED" as const, retryable: false }
                  : message === "github-token-lease-active"
                    ? { status: 503, code: "GITHUB_TOKEN_LEASE_ACTIVE" as const, retryable: true }
                  : { status: 503, code: "SOURCE_UNAVAILABLE" as const, retryable: true };
          return sendJson(response, selected.status, inspectEndpoint.errorSchema.parse({ meta: meta(requestId, now), error: {
            code: selected.code, message: selected.code === "GITHUB_CONTENTS_PERMISSION_REQUIRED" ? "GitHub Contents read permission is required."
              : selected.code === "GITHUB_CONNECTION_DISABLED" ? "The GitHub connection is disconnected."
              : selected.code === "GITHUB_AUTHORITY_GENERATION_STALE" ? "The GitHub connection changed while this operation was starting."
              : selected.code === "GITHUB_INSTALLATION_REMOVED" ? "The GitHub installation is no longer available."
              : selected.code === "GITHUB_INSTALLATION_SUSPENDED" ? "The GitHub installation is suspended."
              : selected.code === "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE" ? "The selected GitHub repository is no longer available to this connection."
              : selected.code === "GITHUB_UPSTREAM_TRANSIENT" ? "GitHub is temporarily unavailable. Try again."
              : selected.code === "GITHUB_AUTHORITY_INVALID" && "details" in selected
                && "reason" in selected.details && selected.details.reason === "permission-required"
                ? "The GitHub installation does not have the required read permission."
              : "The GitHub repository source is currently unavailable.",
            retryable: selected.retryable, details: "details" in selected ? selected.details : {}
          } }));
        }
      }
      if (body.data.source.kind !== "remote") {
        return sendJson(response, 422, inspectEndpoint.errorSchema.parse({
          meta: meta(requestId, now),
          error: { code: "RUNTIME_POLICY_VIOLATION", message: "The source type is not approved for this route.",
            retryable: false, details: { policy: "source-not-approved" } }
        }));
      }
      const sourceUrl = new URL(body.data.source.url);
      if (sourceUrl.protocol !== "https:" || sourceUrl.search !== "") {
        return sendJson(response, 422, inspectEndpoint.errorSchema.parse({
          meta: meta(requestId, now),
          error: { code: "RUNTIME_POLICY_VIOLATION", message: "Only HTTPS repository URLs without query parameters are supported.",
            retryable: false, details: { policy: "source-not-approved" } }
        }));
      }
      try {
        const data: SourceInspectionData = await inspector.inspect(body.data.source.url);
        return sendJson(response, 200, inspectEndpoint.successBodySchema.parse({ meta: meta(requestId, now), data }));
      } catch (error) {
        if (error instanceof GitInspectionPolicyError) {
          return sendJson(response, 422, inspectEndpoint.errorSchema.parse({
            meta: meta(requestId, now),
            error: { code: "RUNTIME_POLICY_VIOLATION", message: error.message, retryable: false,
              details: { policy: "source-not-approved" } }
          }));
        }
        if (error instanceof GitInspectionUnavailableError) {
          if (error.reason === "remote-source" || error.reason === "timeout") {
            return sendJson(response, 503, inspectEndpoint.errorSchema.parse({
              meta: meta(requestId, now),
              error: { code: "SOURCE_UNAVAILABLE", message: "The repository source is currently unavailable.", retryable: true, details: {} }
            }));
          }
          return sendJson(response, 500, inspectEndpoint.errorSchema.parse({
            meta: meta(requestId, now),
            error: { code: "AGENT_INTERNAL_ERROR", message: "The Agent encountered an unexpected error.", retryable: true, details: { incidentId: createId() } }
          }));
        }
        return sendJson(response, 500, inspectEndpoint.errorSchema.parse({
          meta: meta(requestId, now),
          error: { code: "AGENT_INTERNAL_ERROR", message: "The Agent encountered an unexpected error.",
            retryable: true, details: { incidentId: createId() } }
        }));
      }
    }

    if (url.pathname.startsWith("/v1/")) {
      sendJson(response, 404, {
        meta: meta(requestId, now),
        error: { code: "REQUEST_INVALID", message: "The Agent route does not exist.", retryable: false,
          details: { location: "path", field: null, reason: "unknown" } }
      });
      return;
    }
    sendJson(response, 426, {
      meta: meta(requestId, now),
      error: { code: "PROTOCOL_VERSION_UNSUPPORTED", message: "The Agent protocol version is unsupported.",
        retryable: false, details: { supportedProtocolVersion: 1, receivedProtocolVersion: null } }
    });
  });

  function rejectUpgrade(socket: Duplex, status: number): void {
    const reason = status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : status === 409 ? "Conflict" : "Bad Request";
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  server.on("upgrade", (request, socket, head) => {
    const match = /^\/v1\/terminals\/([0-9a-f-]+)\/stream$/u.exec(new URL(request.url ?? "/", "http://agent.local").pathname);
    if (request.method !== "GET" || match === null || request.headers["sec-websocket-protocol"] !== "devspace.terminal.v1") {
      rejectUpgrade(socket, 400); return;
    }
    const projection = extractDevSpaceProtocolHeaders(request.rawHeaders.reduce<[string, string][]>((all, value, index, raw) => {
      if (index % 2 === 0) all.push([value, raw[index + 1] ?? ""]); return all;
    }, []));
    if (!projection.ok || !agentApiV1EndpointByOperation["terminal.stream"].headersSchema.safeParse(projection.headers).success) {
      rejectUpgrade(socket, 401); return;
    }
    let reservation;
    try { reservation = execution.reserveTerminalAttachment(match[1]!); }
    catch (error) {
      rejectUpgrade(socket, error instanceof AgentExecutionError && error.failure.code === "RESOURCE_STATE_CONFLICT" ? 409 : 404); return;
    }
    try {
      terminalWebSockets.handleUpgrade(request, socket, head, (websocket) => {
        void reservation.attach(websocket).catch(() => websocket.close(1011));
      });
    } catch { reservation.release(); socket.destroy(); }
  });

  return {
    socketPath,
    async start() {
      if (started) return;
      startupPreviewReconciliationHealthy = true;
      githubAuthority ??= await createGithubAppAuthority({ stateRoot: managedRoots.state, now, createId });
      managed.setGithubAuthority(githubAuthority);
      await managed.initialize();
      await journal.initialize();
      if (managed.isHealthy) {
        await execution.initialize();
        await harnessRuntime.recoverAfterAgentRestart();
      }
      if (managed.isHealthy && journal.isHealthy) {
        await managed.validateCreationJournalBindings((operationId) => journal.get(operationId)).catch(() => undefined);
        if (managed.isHealthy) {
          try { managed.validateExecutionJournalBindings((operationId) => journal.get(operationId)); }
          catch { /* health remains degraded and recovery stays disabled */ }
        }
      }
      if (managed.isHealthy && journal.isHealthy) {
        const startedAt = now().valueOf();
        logger.info("agent.startup.preview_reconciliation.started", "Startup preview reconciliation started");
        try {
          await managed.reconcilePreviewRoutes();
          logger.info("agent.startup.preview_reconciliation.completed", "Startup preview reconciliation completed", { durationMs: Math.max(0, now().valueOf() - startedAt) });
        } catch {
          startupPreviewReconciliationHealthy = false;
          logger.error("agent.startup.preview_reconciliation.failed", "Startup preview reconciliation failed", {
            durationMs: Math.max(0, now().valueOf() - startedAt), errorCategory: "startup-reconciliation", errorCode: "AGENT_INTERNAL_ERROR"
          });
        }
      }
      if (managed.isHealthy && journal.isHealthy) await executor.initialize();
      await prepareSocketPath(socketPath, now, createId);
      const bindingPath = options.privateSocketPath ?? path.join(path.dirname(socketPath), `.devspace-agent-${createId()}.sock`);
      let bindingIdentity: SocketIdentity | undefined;
      try {
        if (previewLeaseResolver !== null) {
          await previewLeaseResolver.start();
          resolverStarted = true;
        }
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(bindingPath, () => { server.off("error", reject); resolve(); });
        });
        await chmod(bindingPath, 0o660);
        bindingIdentity = socketIdentity(await lstat(bindingPath));
        // A hard link publishes the socket atomically without letting Node own cleanup of the
        // public pathname. This makes shutdown cleanup exclusively identity-checked below.
        await publishSocket(bindingPath, socketPath);
        const created = await lstat(socketPath);
        if (!created.isSocket() || !sameSocket(bindingIdentity, socketIdentity(created))) {
          throw new Error(`The Agent socket changed while it was being published: ${socketPath}`);
        }
        ownedSocket = socketIdentity(created);
        await unlinkOwnedSocket(bindingPath, bindingIdentity);
        started = true;
        if (managed.isHealthy && journal.isHealthy) executor.resumeAccepted();
      } catch (error) {
        if (resolverStarted && previewLeaseResolver !== null) {
          await previewLeaseResolver.stop().catch(() => undefined);
          resolverStarted = false;
        }
        if (bindingIdentity !== undefined) {
          // Remove the bound pathname before Node closes its UDS handle. This ensures the
          // runtime's own close cleanup sees an absent pathname, while our deletion remains
          // authorized by the exact identity captured after bind.
          await unlinkOwnedSocket(bindingPath, bindingIdentity);
          await new Promise<void>((resolve, reject) => server.close((closeError) => closeError === undefined ? resolve() : reject(closeError)));
        }
        throw error;
      }
    },
    async stop() {
      if (!started) return;
      for (const response of eventResponses) response.destroy();
      eventResponses.clear();
      execution.shutdownTransports();
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      await executor.drain();
      await managed.shutdown();
      if (resolverStarted && previewLeaseResolver !== null) {
        await previewLeaseResolver.stop();
        resolverStarted = false;
      }
      try {
        const current = await lstat(socketPath);
        if (ownedSocket !== undefined && current.isSocket() && sameSocket(ownedSocket, socketIdentity(current))) await unlink(socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      started = false;
      ownedSocket = undefined;
    }
  };
}
