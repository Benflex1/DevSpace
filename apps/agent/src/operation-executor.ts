import type { AgentExecutionFailure, AgentResourceReference, AgentSnapshotResource } from "@devspace/contracts";
import { v7 as uuidv7 } from "uuid";
import { AgentEventLog } from "./event-log.js";
import { AgentExecutionError, ManagedWorkspaces } from "./managed-workspaces.js";
import { OperationJournal, type JournalRecord } from "./operation-journal.js";

function resourceFor(record: JournalRecord): AgentResourceReference | null {
  const request = record.request as { projectId?: string; workspaceId?: string; revisionId?: string };
  if (typeof request.projectId !== "string") return null;
  if (record.operationName === "workspace.create" && typeof request.workspaceId === "string") {
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
    private readonly createId: () => string = uuidv7
  ) {}

  get isHealthy(): boolean { return this.observationHealthy; }
  async initialize(): Promise<void> {
    try { this.resources = await this.managed.snapshotResources(); }
    catch { this.observationHealthy = false; this.resources = []; }
  }
  snapshotResources(): AgentSnapshotResource[] { return this.resources; }

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
    try {
      await this.managed.awaitProjectExecutionFence(projectId);
      record = await this.journal.markRunning(operationId);
      this.events.progressed(operationId, resource, "Operation execution started.");
      switch (record.operationName) {
        case "configuration-revision.register":
          await this.managed.registerRevision(record.request as Parameters<ManagedWorkspaces["registerRevision"]>[0]);
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
      }
      if (record.operationName !== "configuration-revision.register") {
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
        } else {
          const project = this.resources.find((item) => item.type === "project" && item.projectId === request.projectId);
          const inspection = project?.type === "project" ? project.gitInspections.find((item) => item.scope.kind === "managed-store")?.inspection : undefined;
          if (inspection === undefined) throw new Error("project-observation-missing");
          this.events.projectInspected(request.projectId, null, inspection);
        }
      }
      await this.journal.succeed(operationId);
      this.events.succeeded(operationId, resource);
    } catch (error) {
      const failure: AgentExecutionFailure = error instanceof AgentExecutionError ? error.failure : {
        code: "AGENT_INTERNAL_ERROR", message: "The Agent encountered an unexpected error.", retryable: true,
        details: { incidentId: this.createId() }
      };
      await this.journal.fail(operationId, failure);
      this.events.failed(operationId, resource, failure);
    }
  }
}
