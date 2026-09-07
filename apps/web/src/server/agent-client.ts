import http from "node:http";
import {
  AGENT_API_VERSION,
  agentApiV1EndpointByOperation,
  f10AgentApiV1EndpointByOperation,
  f11AiAgentApiV1EndpointByOperation,
  githubAgentApiV1EndpointByOperation,
  aiEventStreamFrameSchema,
  AI_EVENT_STREAM_FRAME_MAX_BYTES,
  type AiEventStreamFrame,
  type AiProviderProfileProjection,
  type AgentSnapshotData,
  type ActivatePreviewData,
  type AcknowledgeAiEventsData,
  type ConfigurationRevisionData,
  type ConfigurationRuntimePlanData,
  type CreateManagedStoreData,
  type CreateWorkspaceData,
  type GitInspectionData,
  type HealthData,
  type MutationReceipt,
  type PreviewInspectionData,
  type ProjectPushData,
  type RuntimeStatusData,
  type SourceInspectionData,
  type SourceLocator,
  type ProcessInspectionData,
  type WorkspaceInspectionData,
  type GithubAppInspection,
  type GithubLifecycleInspection,
  type GithubInstallationInspection,
  type GithubRepositoryPage,
  type GithubRepositoryResolution
} from "@devspace/contracts";
import {
  classifyFailureCode, createLogger, type FailureCategory, type LogContext, type StructuredLogger
} from "@devspace/diagnostics";
import { v7 as uuidv7 } from "uuid";
import {
  processAiStreamAdmission,
  type AiStreamAdmission
} from "./ai-stream-admission.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const AI_EVENT_STREAM_PARSER_SLAB_BYTES = 64 * 1024;
const AI_EVENT_STREAM_PARSER_MAX_SEGMENTS =
  Math.ceil(AI_EVENT_STREAM_FRAME_MAX_BYTES / AI_EVENT_STREAM_PARSER_SLAB_BYTES);

function streamProtocolFailure(requestId: string): AgentUnavailableError {
  return new AgentUnavailableError("INVALID_RESPONSE_CONTRACT", "protocol-failure", requestId);
}

async function* parseBoundedAiEventNdjson(
  response: http.IncomingMessage,
  requestId: string,
  signal?: AbortSignal
): AsyncGenerator<AiEventStreamFrame> {
  let segments: Buffer[] = [];
  let pendingBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const append = (bytes: Buffer, start: number, end: number): void => {
    const length = end - start;
    if (pendingBytes + length > AI_EVENT_STREAM_FRAME_MAX_BYTES) throw streamProtocolFailure(requestId);
    let offset = start;
    while (offset < end) {
      let segment = segments.at(-1);
      const used = pendingBytes % AI_EVENT_STREAM_PARSER_SLAB_BYTES;
      if (segment === undefined || used === 0) {
        if (segments.length >= AI_EVENT_STREAM_PARSER_MAX_SEGMENTS) throw streamProtocolFailure(requestId);
        segment = Buffer.allocUnsafe(AI_EVENT_STREAM_PARSER_SLAB_BYTES);
        segments.push(segment);
      }
      const copied = Math.min(end - offset, AI_EVENT_STREAM_PARSER_SLAB_BYTES - used);
      bytes.copy(segment, used, offset, offset + copied);
      pendingBytes += copied;
      offset += copied;
    }
  };
  const finishFrame = (): AiEventStreamFrame => {
    if (pendingBytes === 0) throw streamProtocolFailure(requestId);
    const length = pendingBytes;
    const retained = segments;
    segments = [];
    pendingBytes = 0;
    const encoded = retained.length === 1
      ? retained[0]!.subarray(0, length)
      : Buffer.concat(retained.map((segment, index) => segment.subarray(
        0,
        index === retained.length - 1 ? length - index * AI_EVENT_STREAM_PARSER_SLAB_BYTES : undefined
      )), length);
    try {
      return aiEventStreamFrameSchema.parse(JSON.parse(decoder.decode(encoded)));
    } catch {
      throw streamProtocolFailure(requestId);
    }
  };
  try {
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(0x0a, offset);
        const end = newline < 0 ? bytes.length : newline;
        append(bytes, offset, end);
        if (newline < 0) break;
        const frame = finishFrame();
        yield frame;
        offset = newline + 1;
      }
    }
    if (pendingBytes !== 0) throw streamProtocolFailure(requestId);
  } catch (error) {
    response.destroy();
    if (signal?.aborted === true) return;
    throw error instanceof AgentUnavailableError ? error : streamProtocolFailure(requestId);
  } finally {
    segments = [];
    pendingBytes = 0;
  }
}

export class AgentUnavailableError extends Error {
  readonly retryable = true;
  readonly incidentId: string | undefined = undefined;
  constructor(
    readonly code = "AGENT_UNAVAILABLE",
    readonly failureCategory: FailureCategory = "dependency-unavailable",
    readonly requestId?: string,
    readonly operationId?: string,
    readonly diagnosticContext: LogContext = {}
  ) {
    super(code === "AGENT_REQUEST_TIMEOUT"
      ? "The DevSpace Agent request timed out."
      : code === "INVALID_RESPONSE_CONTRACT" || code === "MALFORMED_RESPONSE"
        ? "The DevSpace Agent returned an invalid response."
        : "The DevSpace Agent is unavailable.");
    this.name = "AgentUnavailableError";
  }
}
export class AgentResponseError extends Error {
  readonly incidentId: string | undefined;
  /** Validated Agent text retained for server-private diagnostics only; never project this message. */
  constructor(
    readonly code: string,
    message = "The Agent could not complete the requested operation.",
    readonly retryable = false,
    incidentId?: string,
    readonly failureCategory: FailureCategory = classifyFailureCode(code),
    readonly requestId?: string,
    readonly operationId?: string,
    readonly diagnosticContext: LogContext = {}
  ) {
    super(message);
    this.name = "AgentResponseError";
    this.incidentId = incidentId;
  }
}

export function createAgentClient(socketPath: string, options: {
  timeoutMs?: number; mutationReceiptTimeoutMs?: number; observationTimeoutMs?: number;
  createId?: () => string; now?: () => Date;
  logger?: StructuredLogger;
  previewFailureDiagnostics?: "terminal" | "deferred";
  aiStreamAdmission?: AiStreamAdmission;
} = {}) {
  const defaultTimeoutMs = options.timeoutMs ?? 5_000;
  const mutationReceiptTimeoutMs = options.mutationReceiptTimeoutMs ?? defaultTimeoutMs;
  const observationTimeoutMs = options.observationTimeoutMs ?? defaultTimeoutMs;
  const createId = options.createId ?? uuidv7;
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? createLogger({ component: "web", subsystem: "agent-client", now });
  const aiStreamAdmission = options.aiStreamAdmission ?? processAiStreamAdmission;

  type SupportedOperation = "agent.health.get" | "agent.runtime-status.get" | "project.source.inspect" | "configuration-revision.register" | "configuration-runtime-plan.register"
    | "github.app.inspect" | "github.installation.verify" | "github.installation.inspect" | "github.installation.refresh"
    | "github.installation.disconnect" | "github.installation.reconnect.prepare"
    | "github.repositories.list" | "github.repositories.resolve"
    | "project.managed-store.create" | "project.fetch" | "project.push" | "project.git.inspect" | "workspace.create"
    | "workspace.inspect" | "workspace.start" | "workspace.stop" | "task.start" | "process.stop" | "process.inspect"
    | "terminal.create" | "terminal.close" | "preview.activate" | "preview.deactivate" | "preview.inspect" | "snapshot.get"
    | "ai-provider.inspect" | "ai-session.start" | "ai-session.resume" | "ai-session.turn.send" | "ai-session.turn.interrupt"
    | "ai-session.approval.respond" | "ai-session.input.respond" | "ai-session.stop" | "ai-session.events.acknowledge";

  async function call(
    operation: SupportedOperation,
    data?: unknown,
    operationId?: string,
    diagnosticOperationId = operationId
  ): Promise<unknown> {
    const endpoint = operation === "snapshot.get" ? f10AgentApiV1EndpointByOperation["snapshot.get"]
      : operation.startsWith("ai-") ? f11AiAgentApiV1EndpointByOperation[operation as keyof typeof f11AiAgentApiV1EndpointByOperation]
      : operation.startsWith("github.") ? githubAgentApiV1EndpointByOperation[operation as keyof typeof githubAgentApiV1EndpointByOperation]
      : agentApiV1EndpointByOperation[operation as keyof typeof agentApiV1EndpointByOperation];
    if (endpoint === undefined) throw new Error("agent-operation-endpoint-missing");
    if (endpoint.successBodySchema === null) throw new Error("stream-operation-requires-stream-client");
    const requestId = createId();
    const callStartedAt = Date.now();
    const resource = data !== null && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
    const resourceFields = {
      ...(typeof resource.projectId === "string" ? { projectId: resource.projectId } : {}),
      ...(typeof resource.workspaceId === "string" ? { workspaceId: resource.workspaceId } : {}),
      ...(typeof resource.previewId === "string" ? { previewId: resource.previewId } : {})
    };
    const diagnosticContext = {
      requestId,
      ...(diagnosticOperationId === undefined ? {} : { operationId: diagnosticOperationId }),
      ...resourceFields
    };
    const diagnosticPreviewCall = operation === "preview.activate" || operation === "preview.deactivate" || operation === "preview.inspect";
    let terminalLogged = false;
    if (diagnosticPreviewCall) logger.debug("web.agent_request.started", "Preview Agent request started", {
      requestId, ...(operationId === undefined ? {} : { operationId }), operationName: operation, ...resourceFields
    });
    const logFailure = (errorCategory: string, errorCode: string, statusCode?: number, incidentId?: string): void => {
      if (!diagnosticPreviewCall || terminalLogged) return;
      terminalLogged = true;
      if (options.previewFailureDiagnostics === "deferred") return;
      logger.warn("web.agent_request.failed", "Preview Agent request failed", {
        requestId, ...(operationId === undefined ? {} : { operationId }), operationName: operation,
        durationMs: Date.now() - callStartedAt, errorCategory, errorCode,
        failureCategory: classifyFailureCode(errorCode),
        ...(statusCode === undefined ? {} : { statusCode }),
        ...(incidentId === undefined ? {} : { incidentId }), ...resourceFields
      });
    };
    const logCompleted = (statusCode: number): void => {
      if (!diagnosticPreviewCall || terminalLogged) return;
      terminalLogged = true;
      logger.debug("web.agent_request.completed", "Preview Agent request completed", {
        requestId, ...(operationId === undefined ? {} : { operationId }), operationName: operation,
        durationMs: Date.now() - callStartedAt, statusCode, ...resourceFields
      });
    };
    const timeoutMs = endpoint.classification === "mutation" ? mutationReceiptTimeoutMs : observationTimeoutMs;
    let body: string | undefined;
    try { body = data === undefined ? undefined : JSON.stringify(endpoint.requestBodySchema.parse({ data })); }
    catch (error) {
      logFailure("agent-protocol", "REQUEST_SERIALIZATION_FAILED");
      throw error;
    }
    return await new Promise((resolve, reject) => {
      const request = http.request({
        socketPath,
        path: endpoint.path,
        method: endpoint.method,
        headers: {
          "X-DevSpace-Protocol-Version": String(AGENT_API_VERSION),
          "X-DevSpace-Request-Id": requestId,
          "X-DevSpace-Sent-At": now().toISOString(),
          ...(operationId === undefined ? {} : { "X-DevSpace-Operation-Id": operationId }),
          Accept: "application/json",
          ...(body === undefined ? {} : {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(body)
          })
        }
      }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            logFailure("agent-transport", "AGENT_RESPONSE_TOO_LARGE");
            request.destroy(new AgentUnavailableError("AGENT_RESPONSE_TOO_LARGE", "transport-failure", requestId, operationId, diagnosticContext));
          }
          else chunks.push(chunk);
        });
        response.on("end", () => {
          const statusCode = response.statusCode ?? 0;
          let parsed: unknown;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch {
            logFailure("agent-protocol", "MALFORMED_RESPONSE", statusCode);
            return reject(new AgentUnavailableError("MALFORMED_RESPONSE", "protocol-failure", requestId, operationId, diagnosticContext));
          }
          if (statusCode === endpoint.successStatus) {
            try {
              const data = endpoint.successBodySchema.parse(parsed).data;
              logCompleted(statusCode);
              return resolve(data);
            } catch {
              logFailure("agent-protocol", "INVALID_RESPONSE_CONTRACT", statusCode);
              return reject(new AgentUnavailableError("INVALID_RESPONSE_CONTRACT", "protocol-failure", requestId, operationId, diagnosticContext));
            }
          }
          try {
            const envelope = endpoint.errorSchema.parse(parsed) as {
              error: { code: string; message: string; retryable: boolean; details: unknown };
            };
            const details = envelope.error.details;
            const incidentId = details !== null && typeof details === "object" && !Array.isArray(details)
              && typeof (details as { incidentId?: unknown }).incidentId === "string"
              ? (details as { incidentId: string }).incidentId
              : undefined;
            logFailure("agent-response", envelope.error.code, statusCode, incidentId);
            return reject(new AgentResponseError(
              envelope.error.code,
              envelope.error.message,
              envelope.error.retryable,
              incidentId,
              classifyFailureCode(envelope.error.code),
              requestId,
              operationId,
              diagnosticContext
            ));
          } catch {
            logFailure("agent-protocol", "INVALID_RESPONSE_CONTRACT", statusCode);
            return reject(new AgentUnavailableError("INVALID_RESPONSE_CONTRACT", "protocol-failure", requestId, operationId, diagnosticContext));
          }
        });
      });
      request.setTimeout(timeoutMs, () => {
        logFailure("agent-transport", "AGENT_REQUEST_TIMEOUT");
        request.destroy(new AgentUnavailableError("AGENT_REQUEST_TIMEOUT", "transport-failure", requestId, operationId, diagnosticContext));
      });
      request.on("error", (error) => {
        if (!(error instanceof AgentUnavailableError)) logFailure("agent-transport", "AGENT_UNAVAILABLE");
        reject(error instanceof AgentUnavailableError ? error
          : new AgentUnavailableError("AGENT_UNAVAILABLE", "dependency-unavailable", requestId, operationId, diagnosticContext));
      });
      if (body !== undefined) request.write(body);
      request.end();
    });
  }

  return {
    health: async (): Promise<HealthData> => await call("agent.health.get") as HealthData,
    runtimeStatus: async (): Promise<RuntimeStatusData> => await call("agent.runtime-status.get") as RuntimeStatusData,
    inspectGithubApp: async (): Promise<GithubAppInspection> => await call("github.app.inspect") as GithubAppInspection,
    verifyGithubInstallation: async (connectionId: string, installationId: string, lifecycleGeneration?: number): Promise<GithubInstallationInspection> =>
      await call("github.installation.verify", { connectionId, installationId, ...(lifecycleGeneration === undefined ? {} : { lifecycleGeneration }) }) as GithubInstallationInspection,
    inspectGithubInstallation: async (connectionId: string, lifecycleGeneration?: number): Promise<GithubInstallationInspection> =>
      await call("github.installation.inspect", { connectionId, ...(lifecycleGeneration === undefined ? {} : { lifecycleGeneration }) }) as GithubInstallationInspection,
    refreshGithubInstallation: async (connectionId: string, lifecycleGeneration?: number): Promise<GithubInstallationInspection> =>
      await call("github.installation.refresh", { connectionId, ...(lifecycleGeneration === undefined ? {} : { lifecycleGeneration }) }) as GithubInstallationInspection,
    disconnectGithubInstallation: async (connectionId: string, lifecycleGeneration: number): Promise<GithubLifecycleInspection> =>
      await call("github.installation.disconnect", { connectionId, lifecycleGeneration }) as GithubLifecycleInspection,
    prepareGithubReconnect: async (connectionId: string, lifecycleGeneration: number): Promise<GithubLifecycleInspection> =>
      await call("github.installation.reconnect.prepare", { connectionId, lifecycleGeneration }) as GithubLifecycleInspection,
    listGithubRepositories: async (connectionId: string, pageSize: number, continuation?: string, lifecycleGeneration?: number): Promise<GithubRepositoryPage> =>
      await call("github.repositories.list", { connectionId, pageSize, ...(continuation === undefined ? {} : { continuation }), ...(lifecycleGeneration === undefined ? {} : { lifecycleGeneration }) }) as GithubRepositoryPage,
    resolveGithubRepository: async (connectionId: string, repositoryId: string, lifecycleGeneration?: number): Promise<GithubRepositoryResolution> =>
      await call("github.repositories.resolve", { connectionId, repositoryId, ...(lifecycleGeneration === undefined ? {} : { lifecycleGeneration }) }) as GithubRepositoryResolution,
    inspectSource: async (url: string): Promise<SourceInspectionData> => await call(
      "project.source.inspect", { source: { kind: "remote", url } }
    ) as SourceInspectionData,
    registerRevision: async (operationId: string, data: ConfigurationRevisionData): Promise<void> => {
      await call("configuration-revision.register", data, operationId);
    },
    registerRuntimePlan: async (operationId: string, data: ConfigurationRuntimePlanData): Promise<void> => {
      await call("configuration-runtime-plan.register", data, operationId);
    },
    createManagedStore: async (operationId: string, data: CreateManagedStoreData): Promise<void> => {
      await call("project.managed-store.create", data, operationId);
    },
    fetchProject: async (operationId: string, projectId: string, source?: SourceLocator, githubAuthorityGeneration?: number): Promise<void> => {
      await call("project.fetch", { projectId, ...(source === undefined ? {} : { source }),
        ...(githubAuthorityGeneration === undefined ? {} : { githubAuthorityGeneration }) }, operationId);
    },
    pushProject: async (operationId: string, data: ProjectPushData): Promise<void> => {
      await call("project.push", data, operationId);
    },
    createWorkspace: async (operationId: string, data: CreateWorkspaceData): Promise<void> => {
      await call("workspace.create", data, operationId);
    },
    inspectGit: async (projectId: string, workspaceId: string | null): Promise<GitInspectionData> =>
      await call("project.git.inspect", { projectId, workspaceId }) as GitInspectionData,
    inspectWorkspace: async (projectId: string, workspaceId: string): Promise<WorkspaceInspectionData> =>
      await call("workspace.inspect", { projectId, workspaceId }) as WorkspaceInspectionData,
    startWorkspace: async (operationId: string, projectId: string, workspaceId: string): Promise<void> => {
      await call("workspace.start", { projectId, workspaceId }, operationId);
    },
    stopWorkspace: async (operationId: string, projectId: string, workspaceId: string): Promise<void> => {
      await call("workspace.stop", { projectId, workspaceId }, operationId);
    },
    startTask: async (operationId: string, data: { projectId: string; workspaceId: string; taskRunId: string; processId: string; taskKey: string }): Promise<void> => {
      await call("task.start", data, operationId);
    },
    stopProcess: async (operationId: string, projectId: string, workspaceId: string, processId: string): Promise<void> => {
      await call("process.stop", { projectId, workspaceId, processId }, operationId);
    },
    inspectProcess: async (projectId: string, workspaceId: string, processId: string): Promise<ProcessInspectionData> =>
      await call("process.inspect", { projectId, workspaceId, processId }) as ProcessInspectionData,
    createTerminal: async (operationId: string, projectId: string, workspaceId: string, terminalId: string): Promise<void> => {
      await call("terminal.create", { projectId, workspaceId, terminalId }, operationId);
    },
    closeTerminal: async (operationId: string, projectId: string, workspaceId: string, terminalId: string): Promise<void> => {
      await call("terminal.close", { projectId, workspaceId, terminalId }, operationId);
    },
    activatePreview: async (operationId: string, data: ActivatePreviewData): Promise<MutationReceipt> => {
      return await call("preview.activate", data, operationId) as MutationReceipt;
    },
    deactivatePreview: async (operationId: string, projectId: string, workspaceId: string, revisionId: string, previewId: string): Promise<MutationReceipt> => {
      return await call("preview.deactivate", { projectId, workspaceId, revisionId, previewId }, operationId) as MutationReceipt;
    },
    inspectPreview: async (
      projectId: string,
      workspaceId: string,
      revisionId: string,
      previewId: string,
      diagnosticOperationId?: string
    ): Promise<PreviewInspectionData> =>
      await call("preview.inspect", { projectId, workspaceId, revisionId, previewId }, undefined, diagnosticOperationId) as PreviewInspectionData,
    snapshot: async (): Promise<AgentSnapshotData> => await call("snapshot.get") as AgentSnapshotData
    ,inspectAiProvider: async (projectId: string, workspaceId: string, profileId = "codex"): Promise<AiProviderProfileProjection> =>
      await call("ai-provider.inspect", { projectId, workspaceId, profileId }) as AiProviderProfileProjection,
    startAiSession: async (operationId: string, data: unknown): Promise<MutationReceipt> => await call("ai-session.start", data, operationId) as MutationReceipt,
    sendAiTurn: async (operationId: string, data: unknown): Promise<MutationReceipt> => await call("ai-session.turn.send", data, operationId) as MutationReceipt,
    interruptAiTurn: async (operationId: string, data: unknown): Promise<MutationReceipt> => await call("ai-session.turn.interrupt", data, operationId) as MutationReceipt,
    stopAiSession: async (operationId: string, data: unknown): Promise<MutationReceipt> => await call("ai-session.stop", data, operationId) as MutationReceipt,
    acknowledgeAiEvents: async (data: AcknowledgeAiEventsData): Promise<AcknowledgeAiEventsData> => await call("ai-session.events.acknowledge", data) as AcknowledgeAiEventsData,
    streamAiEvents: async function* (
      sessionId: string,
      afterSequence: number,
      streamOptions: { signal?: AbortSignal } = {}
    ): AsyncGenerator<AiEventStreamFrame> {
      const signal = streamOptions.signal;
      const isCancelled = (): boolean => signal?.aborted === true;
      if (isCancelled()) return;
      const releaseAdmission = aiStreamAdmission.tryAcquire(sessionId);
      if (releaseAdmission === null) throw new AgentUnavailableError();
      if (isCancelled()) {
        releaseAdmission();
        return;
      }
      let activeRequest: http.ClientRequest | null = null;
      let activeResponse: http.IncomingMessage | null = null;
      const abortError = new Error("ai-event-stream-cancelled");
      const destroyActive = (error?: Error): void => {
        activeResponse?.destroy(error);
        activeRequest?.destroy(error);
      };
      const abortDownstream = (): void => {
        destroyActive(abortError);
      };
      signal?.addEventListener("abort", abortDownstream, { once: true });
      try {
        if (isCancelled()) return;
        const endpoint = f11AiAgentApiV1EndpointByOperation["ai-session.events.stream"];
        const requestId = createId();
        const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
          const request = http.request({ socketPath, path: endpoint.path.replace("{aiSessionId}", encodeURIComponent(sessionId)) + `?afterSequence=${afterSequence}`,
            method: "GET", headers: { "X-DevSpace-Protocol-Version": String(AGENT_API_VERSION), "X-DevSpace-Request-Id": requestId,
              "X-DevSpace-Sent-At": now().toISOString(), Accept: endpoint.successContentType } }, (response) => {
                activeResponse = response;
                if (isCancelled()) {
                  abortDownstream();
                  return;
                }
                if (response.statusCode === endpoint.successStatus && response.headers["content-type"] === endpoint.successContentType) request.setTimeout(0);
                resolve(response);
              });
          activeRequest = request;
          request.setTimeout(observationTimeoutMs, () => request.destroy(new AgentUnavailableError("AGENT_REQUEST_TIMEOUT", "transport-failure", requestId)));
          request.once("error", reject); request.end();
        });
        if (response.statusCode !== endpoint.successStatus) {
          const chunks: Buffer[] = []; let bytes = 0;
          for await (const chunk of response) {
            const data = Buffer.from(chunk as Uint8Array); bytes += data.length;
            if (bytes > MAX_RESPONSE_BYTES) throw new AgentUnavailableError("AGENT_RESPONSE_TOO_LARGE", "transport-failure", requestId);
            chunks.push(data);
          }
          try {
            const parsed = endpoint.errorSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))) as { error: { code: string; message: string; retryable: boolean } };
            throw new AgentResponseError(parsed.error.code, parsed.error.message, parsed.error.retryable, undefined, classifyFailureCode(parsed.error.code), requestId);
          } catch (error) { if (error instanceof AgentResponseError) throw error; throw new AgentUnavailableError("INVALID_RESPONSE_CONTRACT", "protocol-failure", requestId); }
        }
        if (response.headers["content-type"] !== endpoint.successContentType) throw new AgentUnavailableError("INVALID_RESPONSE_CONTRACT", "protocol-failure", requestId);
        yield* parseBoundedAiEventNdjson(response, requestId, signal);
      } catch (error) {
        if (isCancelled()) return;
        throw error;
      } finally {
        signal?.removeEventListener("abort", abortDownstream);
        destroyActive();
        activeResponse = null;
        activeRequest = null;
        releaseAdmission();
      }
    }
  };
}

export type FullAgentClient = ReturnType<typeof createAgentClient>;
export type WorkspaceAgentClient = Pick<FullAgentClient,
  "health" | "runtimeStatus" | "inspectSource" | "registerRevision" | "registerRuntimePlan" | "createManagedStore" |
  "fetchProject" | "createWorkspace" | "inspectGit" | "inspectWorkspace" | "startWorkspace" | "stopWorkspace" | "snapshot">;
export type AgentClient = Pick<FullAgentClient, "health" | "inspectSource">
  & Partial<Pick<FullAgentClient, "resolveGithubRepository">>;
