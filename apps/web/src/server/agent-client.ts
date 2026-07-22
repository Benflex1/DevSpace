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
import { createLogger, type StructuredLogger } from "@devspace/diagnostics";
import { v7 as uuidv7 } from "uuid";

const MAX_RESPONSE_BYTES = 256 * 1024;
export class AgentUnavailableError extends Error {
  constructor() { super("The DevSpace Agent is unavailable."); this.name = "AgentUnavailableError"; }
}
export class AgentResponseError extends Error {
  readonly code: string;
  constructor(code: string, message = "The Agent could not complete the requested operation.") { super(message); this.name = "AgentResponseError"; this.code = code; }
}

export function createAgentClient(socketPath: string, options: {
  timeoutMs?: number; mutationReceiptTimeoutMs?: number; observationTimeoutMs?: number;
  createId?: () => string; now?: () => Date;
  logger?: StructuredLogger;
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

  async function call(operation: SupportedOperation, data?: unknown, operationId?: string): Promise<unknown> {
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
    const diagnosticPreviewCall = operation === "preview.activate" || operation === "preview.deactivate" || operation === "preview.inspect";
    if (diagnosticPreviewCall) logger.info("web.agent_request.started", "Preview Agent request started", {
      requestId, ...(operationId === undefined ? {} : { operationId }), operationName: operation, ...resourceFields
    });
    const timeoutMs = endpoint.classification === "mutation" ? mutationReceiptTimeoutMs : observationTimeoutMs;
    const body = data === undefined ? undefined : JSON.stringify(endpoint.requestBodySchema.parse({ data }));
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
          if (bytes > MAX_RESPONSE_BYTES) request.destroy(new AgentUnavailableError());
          else chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (response.statusCode === endpoint.successStatus) {
              if (diagnosticPreviewCall) logger.info("web.agent_request.completed", "Preview Agent request completed", {
                requestId, ...(operationId === undefined ? {} : { operationId }), operationName: operation,
                durationMs: Date.now() - callStartedAt, statusCode: response.statusCode ?? 0, ...resourceFields
              });
              return resolve(endpoint.successBodySchema.parse(parsed).data);
            }
            const error = endpoint.errorSchema.parse(parsed) as { error: { code: string; message: string } };
            if (diagnosticPreviewCall) logger.warn("web.agent_request.failed", "Preview Agent request failed", {
              requestId, ...(operationId === undefined ? {} : { operationId }), operationName: operation,
              durationMs: Date.now() - callStartedAt, statusCode: response.statusCode ?? 0, errorCategory: "agent-response",
              errorCode: error.error.code, ...resourceFields
            });
            return reject(new AgentResponseError(error.error.code, error.error.message));
          } catch {
            return reject(new AgentUnavailableError());
          }
        });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new AgentUnavailableError()));
      request.on("error", (error) => reject(error instanceof AgentUnavailableError ? error : new AgentUnavailableError()));
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
    inspectPreview: async (projectId: string, workspaceId: string, revisionId: string, previewId: string): Promise<PreviewInspectionData> =>
      await call("preview.inspect", { projectId, workspaceId, revisionId, previewId }) as PreviewInspectionData,
    snapshot: async (): Promise<AgentSnapshotData> => await call("snapshot.get") as AgentSnapshotData
  };
}

export type FullAgentClient = ReturnType<typeof createAgentClient>;
export type WorkspaceAgentClient = Pick<FullAgentClient,
  "health" | "runtimeStatus" | "inspectSource" | "registerRevision" | "registerRuntimePlan" | "createManagedStore" |
  "fetchProject" | "createWorkspace" | "inspectGit" | "inspectWorkspace" | "startWorkspace" | "stopWorkspace" | "snapshot">;
export type AgentClient = Pick<WorkspaceAgentClient, "health" | "inspectSource">;
