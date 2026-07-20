import type { AgentExecutionFailure, AgentResourceReference, AgentSnapshotResource } from "@devspace/contracts";
import { v7 as uuidv7 } from "uuid";
import { AgentEventLog } from "./event-log.js";
import { AgentExecutionError, ManagedWorkspaces } from "./managed-workspaces.js";
import { OperationJournal, type JournalRecord } from "./operation-journal.js";
import { ExecutionManager, TaskStartRecoveryRequiredError } from "./execution-manager.js";

function resourceFor(record: JournalRecord): AgentResourceReference | null {
  const request = record.request as { projectId?: string; workspaceId?: string; revisionId?: string; previewId?: string };
  if (typeof request.projectId !== "string") return null;
  if (["workspace.create", "workspace.start", "workspace.stop", "task.start", "process.stop", "terminal.create", "terminal.close",
    "preview.activate", "preview.deactivate"].includes(record.operationName)
    && typeof request.workspaceId === "string") {
    if (["preview.activate", "preview.deactivate"].includes(record.operationName) && typeof request.previewId === "string") {
      return { type: "preview", projectId: request.projectId, workspaceId: request.workspaceId, previewId: request.previewId };
    }
    return { type: "workspace", projectId: request.projectId, workspaceId: request.workspaceId };
  }
  return { type: "project", projectId: request.projectId };
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
    }
  ) {}

  get isHealthy(): boolean { return this.observationHealthy; }
  async initialize(): Promise<void> {
    try { this.resources = await this.managed.snapshotResources(); }
    catch { this.observationHealthy = false; this.resources = []; }
  }
  snapshotResources(): AgentSnapshotResource[] { return [...this.resources, ...this.execution.snapshotResources()]; }

  private async refreshAfterPreviewMutation(): Promise<void> {
    try { this.resources = await this.managed.snapshotResources(); }
    catch { this.observationHealthy = false; this.resources = []; }
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
    const previewMutation = record.operationName === "preview.activate" || record.operationName === "preview.deactivate";
    let taskStartCompleted = false;
    try {
      await this.managed.awaitProjectExecutionFence(projectId);
      record = await this.journal.markRunning(operationId);
      this.events.progressed(operationId, resource, "Operation execution started.");
      let previousRuntime: "absent" | "stopped" | "running" = "absent";
      if ((record.operationName === "workspace.start" || record.operationName === "workspace.stop")
        && typeof (record.request as { workspaceId?: string }).workspaceId === "string") {
        const request = record.request as { projectId: string; workspaceId: string };
        const before = await this.managed.inspectWorkspace(request.projectId, request.workspaceId);
        previousRuntime = before.runtimeStack.observedState === "running" ? "running"
          : before.runtimeStack.observedState === "stopped" ? "stopped" : "absent";
      }
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
          await this.managed.fetch((record.request as { projectId: string }).projectId, operationId);
          break;
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
      if (previewMutation) await this.refreshAfterPreviewMutation();
      if (!["configuration-revision.register", "configuration-runtime-plan.register", "task.start", "process.stop", "terminal.create", "terminal.close",
        "preview.activate", "preview.deactivate"]
        .includes(record.operationName)) {
        try { this.resources = await this.managed.snapshotResources(); }
        catch (error) { this.observationHealthy = false; throw error; }
        const request = record.request as { projectId: string; workspaceId?: string };
        if (record.operationName === "workspace.create" && request.workspaceId !== undefined) {
          this.events.workspaceCreated(operationId, request.projectId, request.workspaceId);
          const project = this.resources.find((item) => item.type === "project" && item.projectId === request.projectId);
          const inspection = project?.type === "project" ? project.gitInspections.find((item) =>
            item.scope.kind === "workspace" && item.scope.workspaceId === request.workspaceId)?.inspection : undefined;
          if (inspection === undefined) throw new Error("workspace-observation-missing");
          this.events.projectInspected(request.projectId, request.workspaceId, inspection);
        } else if (record.operationName !== "workspace.start" && record.operationName !== "workspace.stop") {
          const project = this.resources.find((item) => item.type === "project" && item.projectId === request.projectId);
          const inspection = project?.type === "project" ? project.gitInspections.find((item) => item.scope.kind === "managed-store")?.inspection : undefined;
          if (inspection === undefined) throw new Error("project-observation-missing");
          this.events.projectInspected(request.projectId, null, inspection);
        }
      }
      await this.journal.succeed(operationId);
      this.events.succeeded(operationId, resource);
    } catch (error) {
      if (previewMutation) await this.refreshAfterPreviewMutation();
      // Once private execution evidence says the start occurred, a later journal write outage
      // must leave this operation resumable; it must never rewrite successful start as failure.
      if (record.operationName === "task.start" && (taskStartCompleted || error instanceof TaskStartRecoveryRequiredError)) return;
      const failure: AgentExecutionFailure = error instanceof AgentExecutionError ? error.failure : {
        code: "AGENT_INTERNAL_ERROR", message: "The Agent encountered an unexpected error.", retryable: true,
        details: { incidentId: this.createId() }
      };
      await this.journal.fail(operationId, failure);
      this.events.failed(operationId, resource, failure);
    }
  }
}
