import http from "node:http";
import {
  AGENT_API_VERSION,
  agentApiV1EndpointByOperation,
  f10AgentApiV1EndpointByOperation,
  type AgentSnapshotData,
  type ActivatePreviewData,
  type ConfigurationRevisionData,
  type ConfigurationRuntimePlanData,
  type CreateManagedStoreData,
  type CreateWorkspaceData,
  type GitInspectionData,
  type HealthData,
  type MutationReceipt,
  type PreviewInspectionData,
  type RuntimeStatusData,
  type SourceInspectionData,
  type ProcessInspectionData,
  type WorkspaceInspectionData
} from "@devspace/contracts";
import {
  classifyFailureCode, createLogger, type FailureCategory, type LogContext, type StructuredLogger
} from "@devspace/diagnostics";
import { v7 as uuidv7 } from "uuid";

const MAX_RESPONSE_BYTES = 256 * 1024;
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
} = {}) {
  const defaultTimeoutMs = options.timeoutMs ?? 5_000;
  const mutationReceiptTimeoutMs = options.mutationReceiptTimeoutMs ?? defaultTimeoutMs;
  const observationTimeoutMs = options.observationTimeoutMs ?? defaultTimeoutMs;
  const createId = options.createId ?? uuidv7;
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? createLogger({ component: "web", subsystem: "agent-client", now });

  type SupportedOperation = "agent.health.get" | "agent.runtime-status.get" | "project.source.inspect" | "configuration-revision.register" | "configuration-runtime-plan.register"
    | "project.managed-store.create" | "project.fetch" | "project.git.inspect" | "workspace.create"
    | "workspace.inspect" | "workspace.start" | "workspace.stop" | "task.start" | "process.stop" | "process.inspect"
    | "terminal.create" | "terminal.close" | "preview.activate" | "preview.deactivate" | "preview.inspect" | "snapshot.get";

  async function call(
    operation: SupportedOperation,
    data?: unknown,
    operationId?: string,
    diagnosticOperationId = operationId
  ): Promise<unknown> {
    const endpoint = operation === "snapshot.get"
      ? f10AgentApiV1EndpointByOperation["snapshot.get"]
      : agentApiV1EndpointByOperation[operation];
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
    fetchProject: async (operationId: string, projectId: string): Promise<void> => {
      await call("project.fetch", { projectId }, operationId);
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
  };
}

export type FullAgentClient = ReturnType<typeof createAgentClient>;
export type WorkspaceAgentClient = Pick<FullAgentClient,
  "health" | "runtimeStatus" | "inspectSource" | "registerRevision" | "registerRuntimePlan" | "createManagedStore" |
  "fetchProject" | "createWorkspace" | "inspectGit" | "inspectWorkspace" | "startWorkspace" | "stopWorkspace" | "snapshot">;
export type AgentClient = Pick<WorkspaceAgentClient, "health" | "inspectSource">;
