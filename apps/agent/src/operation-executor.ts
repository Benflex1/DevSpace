import { agentApiV1EndpointByOperation, type AgentExecutionFailure, type AgentResourceReference, type AgentSnapshotResource,
  type GitInspectionData } from "@devspace/contracts";
import { performance } from "node:perf_hooks";
import { v7 as uuidv7 } from "uuid";
import { AgentEventLog } from "./event-log.js";
import { AgentExecutionError, FetchMutationRecoveryRequiredError, ManagedWorkspaces } from "./managed-workspaces.js";
import { OperationJournal, type JournalRecord } from "./operation-journal.js";
import { ExecutionManager, TaskStartRecoveryRequiredError } from "./execution-manager.js";
import { classifyFailureCode, createLogger, type StructuredLogger } from "@devspace/diagnostics";

function resourceFor(record: JournalRecord): AgentResourceReference | null {
  const request = record.request as { projectId?: string; workspaceId?: string; revisionId?: string; previewId?: string };
  if (typeof request.projectId !== "string") return null;
  if (["workspace.create", "workspace.start", "workspace.stop", "task.start", "process.stop", "terminal.create", "terminal.close", "project.push",
    "project.git.stage", "project.git.unstage", "project.git.commit",
    "preview.activate", "preview.deactivate"].includes(record.operationName)
    && typeof request.workspaceId === "string") {
    if (["preview.activate", "preview.deactivate"].includes(record.operationName) && typeof request.previewId === "string") {
      return { type: "preview", projectId: request.projectId, workspaceId: request.workspaceId, previewId: request.previewId };
    }
    return { type: "workspace", projectId: request.projectId, workspaceId: request.workspaceId };
  }
  return { type: "project", projectId: request.projectId };
}

function diagnosticErrorClass(error: unknown): string {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  return error instanceof Error ? "Error" : "UnknownError";
}

export class OperationExecutor {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly projectTails = new Map<string, Promise<void>>();
  private resources: AgentSnapshotResource[] = [];
  private observationHealthy = true;

  constructor(
    private readonly journal: OperationJournal,
    private readonly managed: ManagedWorkspaces,
    private readonly events: AgentEventLog,
    private readonly createId: () => string = uuidv7,
    private readonly execution: Pick<ExecutionManager, "snapshotResources" | "startTask" | "stop" | "createTerminal" | "closeTerminal" | "stopWorkspace"> = {
      snapshotResources: () => [],
      startTask: () => Promise.reject(new Error("execution-manager-unavailable")),
      stop: () => Promise.reject(new Error("execution-manager-unavailable")),
      createTerminal: () => Promise.reject(new Error("execution-manager-unavailable")),
      closeTerminal: () => Promise.reject(new Error("execution-manager-unavailable")),
      stopWorkspace: () => Promise.resolve()
    },
    private readonly logger: StructuredLogger = createLogger({ component: "agent", subsystem: "operations" })
  ) {}

  get isHealthy(): boolean { return this.observationHealthy; }
  private observationFailureFields(error: unknown): Record<string, unknown> {
    if (error instanceof AgentExecutionError) {
      const details = error.failure.details as Record<string, unknown>;
      const action = typeof details["action"] === "string" ? details["action"] : undefined;
      return { errorCode: error.failure.code, ...(action === undefined ? {} : { action }) };
    }
    return { errorName: error instanceof Error ? error.name : "unknown" };
  }

  private async refreshResources(event: string, message: string, fields: Record<string, unknown> = {}): Promise<boolean> {
    try {
      this.resources = await this.managed.snapshotResources();
      this.observationHealthy = true;
      return true;
    } catch (error) {
      this.observationHealthy = false;
      this.logger.warn(event, message, { ...fields, ...this.observationFailureFields(error) });
      return false;
    }
  }

  async initialize(): Promise<void> {
    await this.refreshResources("agent.observation.initialize_failed", "Initial Agent resource observation failed; retaining the previous snapshot.");
  }
  snapshotResources(): AgentSnapshotResource[] { return [...this.resources, ...this.execution.snapshotResources()]; }

  private async refreshAfterPreviewMutation(operationId: string, operationName: string, resourceFields: Record<string, unknown>): Promise<boolean> {
    return await this.refreshResources("agent.observation.refresh_failed", "Agent resource observation refresh failed; retaining the previous snapshot.", {
      operationId, operationName, ...resourceFields
    });
  }

  private async refreshWorkspaceGit(operationId: string, operationName: string, projectId: string, workspaceId: string): Promise<void> {
    let inspection: GitInspectionData;
    try {
      inspection = await this.managed.inspectGit(projectId, workspaceId);
    } catch (error) {
      this.observationHealthy = false;
      this.logger.warn("agent.observation.target_refresh_failed", "Target workspace Git observation failed; completed mutation remains recoverable.", {
        operationId, operationName, projectId, workspaceId, ...this.observationFailureFields(error)
      });
      throw error;
    }
    const projectIndex = this.resources.findIndex((resource) => resource.type === "project" && resource.projectId === projectId);
    if (projectIndex === -1) {
      this.logger.warn("agent.observation.target_cache_missing", "Target workspace Git observation is fresh but its project cache is unavailable.", {
        operationId, operationName, projectId, workspaceId
      });
    } else {
      const projectResource = this.resources[projectIndex];
      if (projectResource?.type !== "project") throw new Error("project-resource-index-invalid");
      type ProjectResource = Extract<AgentSnapshotResource, { type: "project" }>;
      const inspectionIndex = projectResource.gitInspections.findIndex((item) =>
        item.scope.kind === "workspace" && item.scope.workspaceId === workspaceId);
      const target: ProjectResource["gitInspections"][number] = { scope: { kind: "workspace" as const, workspaceId }, inspection };
      const gitInspections = inspectionIndex === -1
        ? [...projectResource.gitInspections, target]
        : projectResource.gitInspections.map((item, index) => index === inspectionIndex ? target : item);
      this.resources = this.resources.map((resource, index) => index === projectIndex ? { ...projectResource, gitInspections } : resource);
    }
    this.observationHealthy = true;
    this.events.projectInspected(projectId, workspaceId, inspection);
  }

  schedule(record: JournalRecord): void {
    if (record.state === "succeeded" || record.state === "failed" || this.inFlight.has(record.operationId)) return;
    const projectId = (record.request as { projectId: string }).projectId;
    const previous = this.projectTails.get(projectId) ?? Promise.resolve();
    const execution = previous.catch(() => undefined).then(async () => await this.execute(record.operationId));
    this.projectTails.set(projectId, execution);
    this.inFlight.set(record.operationId, execution);
    void execution.finally(() => {
      if (this.inFlight.get(record.operationId) === execution) this.inFlight.delete(record.operationId);
      if (this.projectTails.get(projectId) === execution) this.projectTails.delete(projectId);
    }).catch(() => undefined);
  }

  resumeAccepted(): void { for (const record of this.journal.resumable()) this.schedule(record); }
  isRunning(operationId: string): boolean { return this.inFlight.has(operationId); }
  async drain(): Promise<void> { await Promise.allSettled([...this.inFlight.values()]); }

  private async execute(operationId: string): Promise<void> {
    let record = this.journal.get(operationId);
    if (record === undefined || record.state === "succeeded" || record.state === "failed") return;
    const projectId = (record.request as { projectId: string }).projectId;
    const resource = resourceFor(record);
    const request = record.request as { projectId?: unknown; workspaceId?: unknown; previewId?: unknown };
    const resourceFields = {
      ...(typeof request.projectId === "string" ? { projectId: request.projectId } : {}),
      ...(typeof request.workspaceId === "string" ? { workspaceId: request.workspaceId } : {}),
      ...(typeof request.previewId === "string" ? { previewId: request.previewId } : {})
    };
    const previewMutation = record.operationName === "preview.activate" || record.operationName === "preview.deactivate";
    const localGitMutation = ["project.git.stage", "project.git.unstage", "project.git.commit"].includes(record.operationName);
    let taskStartCompleted = false;
    let fetchMutationCompleted = false;
    let gitMutationCompleted = false;
    let phase = "operation-setup";
    const operationStartedAt = performance.now();
    try {
      this.logger.info("agent.operation.started", "Agent operation execution started", {
        operationId, operationName: record.operationName, operationState: record.state, ...resourceFields
      });
      await this.managed.awaitProjectExecutionFence(projectId);
      record = await this.journal.markRunning(operationId);
      this.events.progressed(operationId, resource, "Operation execution started.");
      let previousRuntime: "absent" | "stopped" | "running" = "absent";
      if ((record.operationName === "workspace.start" || record.operationName === "workspace.stop")
        && typeof (record.request as { workspaceId?: string }).workspaceId === "string") {
        const request = record.request as { projectId: string; workspaceId: string };
        phase = "operation-inspection";
        const runtimeStack = await this.managed.inspectWorkspaceRuntime(request.projectId, request.workspaceId);
        previousRuntime = runtimeStack.observedState === "running" ? "running"
          : runtimeStack.observedState === "stopped" ? "stopped" : "absent";
      }
      phase = "operation-dispatch";
      switch (record.operationName) {
        case "configuration-revision.register":
          await this.managed.registerRevision(record.request as Parameters<ManagedWorkspaces["registerRevision"]>[0]);
          break;
        case "configuration-runtime-plan.register":
          await this.managed.registerRuntimePlan(record.request as Parameters<ManagedWorkspaces["registerRuntimePlan"]>[0]);
          break;
        case "project.managed-store.create":
          await this.managed.createManagedStore(record.request as Parameters<ManagedWorkspaces["createManagedStore"]>[0], operationId);
          break;
        case "project.fetch":
          await this.managed.fetch((record.request as { projectId: string; source?: import("@devspace/contracts").SourceLocator }).projectId,
            operationId, (record.request as { projectId: string; source?: import("@devspace/contracts").SourceLocator }).source,
            (record.request as { githubAuthorityGeneration?: number }).githubAuthorityGeneration);
          fetchMutationCompleted = true;
          break;
        case "project.push":
          await this.managed.push(record.request as Parameters<ManagedWorkspaces["push"]>[0], operationId);
          break;
        case "project.git.stage": {
          const request = record.request as { projectId: string; workspaceId: string; path: string };
          await this.managed.stageWorkspaceFile(request.projectId, request.workspaceId, request.path);
          gitMutationCompleted = true;
          break;
        }
        case "project.git.unstage": {
          const request = record.request as { projectId: string; workspaceId: string; path: string };
          await this.managed.unstageWorkspaceFile(request.projectId, request.workspaceId, request.path);
          gitMutationCompleted = true;
          break;
        }
        case "project.git.commit": {
          const request = record.request as { projectId: string; workspaceId: string; message: string; userName?: string; userEmail?: string };
          await this.managed.commitWorkspace(request.projectId, request.workspaceId, request.message, request.userName, request.userEmail);
          gitMutationCompleted = true;
          break;
        }
        case "workspace.create": {
          const request = record.request as Parameters<ManagedWorkspaces["createWorkspace"]>[0];
          await this.managed.createWorkspace(request, operationId);
          break;
        }
        case "workspace.start": {
          const request = record.request as { projectId: string; workspaceId: string };
          await this.managed.startWorkspace(request.projectId, request.workspaceId, operationId);
          this.events.workspaceRuntimeConverged(operationId, request.projectId, request.workspaceId, previousRuntime, "running");
          break;
        }
        case "workspace.stop": {
          const request = record.request as { projectId: string; workspaceId: string };
          await this.execution.stopWorkspace(request.projectId, request.workspaceId);
          await this.managed.stopWorkspace(request.projectId, request.workspaceId);
          this.events.workspaceRuntimeConverged(operationId, request.projectId, request.workspaceId, previousRuntime, "stopped");
          break;
        }
        case "preview.activate":
          await this.managed.activatePreview(record.request as Parameters<ManagedWorkspaces["activatePreview"]>[0], operationId);
          break;
        case "preview.deactivate":
          await this.managed.deactivatePreview(record.request as Parameters<ManagedWorkspaces["deactivatePreview"]>[0], operationId);
          break;
        case "task.start":
          await this.execution.startTask(record.request as Parameters<ExecutionManager["startTask"]>[0], operationId);
          taskStartCompleted = true;
          break;
        case "process.stop": {
          const request = record.request as { projectId: string; workspaceId: string; processId: string };
          await this.execution.stop(request.projectId, request.workspaceId, request.processId);
          break;
        }
        case "terminal.create":
          await this.execution.createTerminal(record.request as Parameters<ExecutionManager["createTerminal"]>[0]);
          break;
        case "terminal.close":
          await this.execution.closeTerminal(record.request as Parameters<ExecutionManager["closeTerminal"]>[0]);
          break;
      }
      phase = "operation-finalization";
      if (previewMutation) await this.refreshAfterPreviewMutation(operationId, record.operationName, resourceFields);
      if (localGitMutation) {
        const request = record.request as { projectId: string; workspaceId: string };
        await this.refreshWorkspaceGit(operationId, record.operationName, request.projectId, request.workspaceId);
      } else if (!["configuration-revision.register", "configuration-runtime-plan.register", "task.start", "process.stop", "terminal.create", "terminal.close",
        "preview.activate", "preview.deactivate"]
        .includes(record.operationName)) {
        const refreshed = await this.refreshResources("agent.observation.refresh_failed", "Agent resource observation refresh failed; retaining the previous snapshot.", {
          operationId, operationName: record.operationName, ...resourceFields
        });
        const request = record.request as { projectId: string; workspaceId?: string };
        if (record.operationName === "workspace.create" && request.workspaceId !== undefined) {
          this.events.workspaceCreated(operationId, request.projectId, request.workspaceId);
          if (refreshed) {
            const project = this.resources.find((item) => item.type === "project" && item.projectId === request.projectId);
            const inspection = project?.type === "project" ? project.gitInspections.find((item) =>
              item.scope.kind === "workspace" && item.scope.workspaceId === request.workspaceId)?.inspection : undefined;
            if (inspection === undefined) {
              this.logger.warn("agent.observation.target_missing", "Successful operation completed without a target workspace inspection.", {
                operationId, operationName: record.operationName, projectId: request.projectId, workspaceId: request.workspaceId
              });
            } else this.events.projectInspected(request.projectId, request.workspaceId, inspection);
          }
        } else if (record.operationName !== "workspace.start" && record.operationName !== "workspace.stop") {
          if (refreshed) {
            const project = this.resources.find((item) => item.type === "project" && item.projectId === request.projectId);
            const inspection = project?.type === "project" ? project.gitInspections.find((item) => item.scope.kind === "managed-store")?.inspection : undefined;
            if (inspection === undefined) {
              this.logger.warn("agent.observation.target_missing", "Successful operation completed without a target project inspection.", {
                operationId, operationName: record.operationName, projectId: request.projectId
              });
            } else this.events.projectInspected(request.projectId, null, inspection);
          }
        }
      }
      await this.journal.succeed(operationId);
      this.events.succeeded(operationId, resource);
      this.logger.info("agent.operation.completed", "Agent operation completed", {
        operationId, operationName: record.operationName, operationState: "succeeded", ...resourceFields
      });
    } catch (error) {
      if (previewMutation) await this.refreshAfterPreviewMutation(operationId, record.operationName, resourceFields);
      // Once private execution evidence says the start occurred, a later journal write outage
      // must leave this operation resumable; it must never rewrite successful start as failure.
      if (record.operationName === "task.start" && (taskStartCompleted || error instanceof TaskStartRecoveryRequiredError)) return;
      if (localGitMutation && gitMutationCompleted) {
        this.logger.warn("agent.operation.git_recovery_required", "Git mutation completed; operation remains recoverable after post-success failure.", {
          operationId, operationName: record.operationName, ...resourceFields
        });
        return;
      }
      if (record.operationName === "project.fetch" && (fetchMutationCompleted || error instanceof FetchMutationRecoveryRequiredError)) {
        this.logger.warn("agent.operation.fetch_recovery_required", "Git Fetch completed; operation remains recoverable after post-success failure.", {
          operationId, operationName: record.operationName, ...resourceFields
        });
        return;
      }
      const originalFailure = error instanceof AgentExecutionError ? error.failure : undefined;
      const incompatibleFailure = originalFailure !== undefined
        && !agentApiV1EndpointByOperation[record.operationName].errors.some((candidate) => candidate.code === originalFailure.code);
      const journalFailure: AgentExecutionFailure = originalFailure !== undefined && !incompatibleFailure ? originalFailure : {
        code: "AGENT_INTERNAL_ERROR", message: "The Agent encountered an unexpected error.", retryable: true,
        details: { incidentId: this.createId() }
      };
      const internalReason = error instanceof AgentExecutionError ? error.internalReason : undefined;
      await this.journal.fail(operationId, journalFailure);
      this.events.failed(operationId, resource, journalFailure);
      const incidentId = "incidentId" in journalFailure.details ? journalFailure.details.incidentId : undefined;
      this.logger.error("agent.operation.failed", "Agent operation failed", {
        operationId, operationName: record.operationName, operationState: "failed", errorCategory: "operation",
        failureCategory: classifyFailureCode(journalFailure.code), errorCode: journalFailure.code, retryable: journalFailure.retryable,
        ...(incompatibleFailure && originalFailure !== undefined ? { failureCode: originalFailure.code } : {}),
        ...(incidentId === undefined ? {} : { incidentId }), ...(internalReason === undefined ? {} : { internalReason }),
        ...(record.operationName === "workspace.start" ? { phase, errorClass: diagnosticErrorClass(error),
          durationMs: Math.max(0, performance.now() - operationStartedAt) } : {}), ...resourceFields
      });
    }
  }
}
