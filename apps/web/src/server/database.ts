import BetterSqlite3 from "better-sqlite3";
import type { AgentSnapshotData, WorkspaceInspectionData } from "@devspace/contracts";
import { mkdirSync } from "node:fs";
import pathModule from "node:path";
import {
  auditEvents, migrateDatabase, operations, processes, projectConfigRevisions, projects, runtimeStacks, taskRuns, terminalSessions,
  workspaceServices, workspaces,
  type Operation, type Project, type ProjectConfigRevision
} from "@devspace/database";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { parseProjectOptionsV1 } from "@devspace/project-options";

export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly repositoryUrl: string;
  readonly defaultBranch: string;
  readonly state: "registering" | "ready" | "invalid" | "archived";
  readonly createdAt: string;
}

export interface ProjectSummaryView extends ProjectView {
  readonly primaryWorkspace: null | { readonly name: string; readonly observedState: string };
  readonly runtime: null | { readonly observedState: string };
}

export interface ManagedProjectView extends ProjectView {
  readonly activeRevision: null | { readonly id: string; readonly number: number; readonly hash: string };
  readonly primaryWorkspace: null | {
    readonly id: string; readonly name: string; readonly branchName: string;
    readonly desiredState: string; readonly observedState: string; readonly dirtyState: string;
  };
  readonly runtime: null | {
    readonly id: string; readonly desiredState: string; readonly observedState: string;
    readonly generation: number; readonly errorMessage: string | null; readonly serviceObservedState: string | null;
  };
  readonly tasks: readonly { readonly key: string; readonly displayName: string }[];
  readonly taskRuns: readonly { readonly id: string; readonly taskKey: string; readonly processId: string | null;
    readonly state: string; readonly processState: string | null; readonly exitCode: number | null }[];
  readonly terminals: readonly { readonly id: string; readonly processId: string; readonly state: string }[];
}

export interface CreateProjectInput {
  readonly name: string;
  readonly slug: string;
  readonly repositoryUrl: string;
  readonly defaultBranch: string;
  readonly actor: string;
}

export class DuplicateProjectSlugError extends Error {
  constructor() { super("A project with this slug already exists."); this.name = "DuplicateProjectSlugError"; }
}
export class ProjectSetupConflictError extends Error {
  constructor(message: string) { super(message); this.name = "ProjectSetupConflictError"; }
}

function toView(project: Project): ProjectView {
  return {
    id: project.id, name: project.name, slug: project.slug, repositoryUrl: project.repositoryUrl,
    defaultBranch: project.defaultBranch, state: project.state, createdAt: project.createdAt
  };
}

export function openProjectDatabase(path: string, options: {
  now?: () => Date;
  createId?: () => string;
  beforeAuditInsert?: () => void;
} = {}) {
  if (path !== ":memory:") mkdirSync(pathModule.dirname(pathModule.resolve(path)), { recursive: true, mode: 0o700 });
  const client = new BetterSqlite3(path);
  migrateDatabase(client);
  client.pragma("foreign_keys = ON");
  const db = drizzle({ client });
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? uuidv7;
  const readManagedProject = (project: Project): ManagedProjectView => {
    const revision = project.activeConfigRevisionId === null ? undefined
      : db.select().from(projectConfigRevisions).where(eq(projectConfigRevisions.id, project.activeConfigRevisionId)).get();
    const workspace = project.primaryWorkspaceId === null ? undefined
      : db.select().from(workspaces).where(eq(workspaces.id, project.primaryWorkspaceId)).get();
    const runtime = workspace === undefined ? undefined
      : db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, workspace.id)).get();
    const development = runtime === undefined ? undefined : db.select().from(workspaceServices).where(and(
      eq(workspaceServices.runtimeStackId, runtime.id), eq(workspaceServices.kind, "development")
    )).get();
    const projectOptions = revision === undefined ? null : parseProjectOptionsV1(JSON.parse(revision.configurationJson));
    const recentRuns = workspace === undefined ? [] : db.select().from(taskRuns).where(eq(taskRuns.workspaceId, workspace.id))
      .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id)).limit(20).all();
    const terminalRows = workspace === undefined ? [] : db.select().from(terminalSessions).where(eq(terminalSessions.workspaceId, workspace.id))
      .orderBy(desc(terminalSessions.createdAt), desc(terminalSessions.id)).all();
    return {
      ...toView(project),
      activeRevision: revision === undefined ? null : { id: revision.id, number: revision.revisionNumber, hash: revision.configurationHash },
      primaryWorkspace: workspace === undefined ? null : {
        id: workspace.id, name: workspace.name, branchName: workspace.branchName,
        desiredState: workspace.desiredState, observedState: workspace.observedState, dirtyState: workspace.dirtyState
      },
      runtime: runtime === undefined ? null : { id: runtime.id, desiredState: runtime.desiredState,
        observedState: runtime.observedState, generation: runtime.runtimeGeneration,
        errorMessage: runtime.lastErrorMessage, serviceObservedState: development?.observedState ?? null },
      tasks: projectOptions?.tasks.map((task) => ({ key: task.key, displayName: task.displayName })) ?? [],
      taskRuns: recentRuns.map((run) => { const process = run.processId === null ? undefined
        : db.select().from(processes).where(eq(processes.id, run.processId)).get();
        return { id: run.id, taskKey: run.taskKey, processId: run.processId, state: run.state,
          processState: process?.observedState ?? null, exitCode: run.exitCode }; }),
      terminals: terminalRows.map((terminal) => ({ id: terminal.id, processId: terminal.processId, state: terminal.state }))
    };
  };
  return {
    close: () => client.close(),
    listProjects: (): ProjectView[] => db.select().from(projects).orderBy(desc(projects.createdAt)).all().map(toView),
    listProjectSummaries(): ProjectSummaryView[] {
      return db.select().from(projects).orderBy(desc(projects.createdAt)).all().map((project) => {
        const workspace = project.primaryWorkspaceId === null ? undefined
          : db.select().from(workspaces).where(eq(workspaces.id, project.primaryWorkspaceId)).get();
        const runtime = workspace === undefined ? undefined
          : db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, workspace.id)).get();
        return { ...toView(project), primaryWorkspace: workspace === undefined ? null
          : { name: workspace.name, observedState: workspace.observedState },
        runtime: runtime === undefined ? null : { observedState: runtime.observedState } };
      });
    },
    listManagedProjects(): ManagedProjectView[] {
      return db.select().from(projects).orderBy(desc(projects.createdAt)).all().map(readManagedProject);
    },
    getManagedProject(projectId: string): ManagedProjectView | undefined {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      return project === undefined ? undefined : readManagedProject(project);
    },
    createProject(input: CreateProjectInput): ProjectView {
      const projectId = createId();
      const auditId = createId();
      const timestamp = now().toISOString();
      const row = {
        id: projectId,
        name: input.name,
        slug: input.slug,
        repositoryUrl: input.repositoryUrl,
        repositoryStorePath: `/srv/devspace/projects/${projectId}/repository.git`,
        defaultBranch: input.defaultBranch,
        automaticFetchPolicy: "manual" as const,
        state: "registering" as const,
        activeConfigRevisionId: null,
        primaryWorkspaceId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
        rowVersion: 1
      };
      try {
        client.transaction(() => {
          db.insert(projects).values(row).run();
          const last = db.select({ sequence: auditEvents.sequence }).from(auditEvents)
            .orderBy(desc(auditEvents.sequence)).limit(1).get();
          options.beforeAuditInsert?.();
          db.insert(auditEvents).values({
            id: auditId,
            sequence: (last?.sequence ?? -1) + 1,
            actor: input.actor,
            eventType: "project.registered",
            resourceType: "project",
            resourceId: projectId,
            operationId: null,
            metadataJson: JSON.stringify({ sourceKind: "remote" }),
            createdAt: timestamp
          }).run();
        }).immediate();
      } catch (error) {
        if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
          && error instanceof Error && error.message.includes("projects.slug")) {
          throw new DuplicateProjectSlugError();
        }
        throw error;
      }
      return toView(row);
    },
    preparePrimaryWorkspace(input: {
      projectId: string; configurationJson: string; configurationHash: string;
      compiledRuntimePlanJson: string; runtimePlanHash: string; actor: string;
    }): { project: Project; revision: ProjectConfigRevision; workspaceId: string } {
      return client.transaction(() => {
        const project = db.select().from(projects).where(eq(projects.id, input.projectId)).get();
        if (project === undefined) throw new ProjectSetupConflictError("The project no longer exists.");
        if (project.state === "ready" && project.activeConfigRevisionId !== null && project.primaryWorkspaceId !== null) {
          const revision = db.select().from(projectConfigRevisions).where(eq(projectConfigRevisions.id, project.activeConfigRevisionId)).get();
          if (revision === undefined) throw new ProjectSetupConflictError("The ready project is missing its active revision.");
          return { project, revision, workspaceId: project.primaryWorkspaceId };
        }
        if (project.state !== "registering") throw new ProjectSetupConflictError("This project cannot be set up from its current state.");
        let revision = db.select().from(projectConfigRevisions).where(and(
          eq(projectConfigRevisions.projectId, project.id), eq(projectConfigRevisions.state, "draft")
        )).get();
        if (revision !== undefined && (revision.configurationHash !== input.configurationHash || revision.configurationJson !== input.configurationJson)) {
          throw new ProjectSetupConflictError("Workspace setup is already in progress with different Project Options.");
        }
        if (revision === undefined) {
          const createdAt = now().toISOString();
          revision = {
            id: createId(), projectId: project.id, revisionNumber: 1, schemaVersion: 1,
            configurationJson: input.configurationJson, configurationHash: input.configurationHash,
            compiledRuntimePlanJson: input.compiledRuntimePlanJson, runtimePlanHash: input.runtimePlanHash, source: "user", state: "draft",
            createdBy: input.actor, createdAt, activatedAt: null, supersededAt: null
          };
          db.insert(projectConfigRevisions).values(revision).run();
        }
        let workspaceOperation = db.select().from(operations).where(and(
          eq(operations.projectId, project.id), eq(operations.operationName, "workspace.create")
        )).orderBy(desc(operations.createdAt), desc(operations.operationId)).get();
        if (workspaceOperation === undefined) {
          const createdAt = now().toISOString();
          workspaceOperation = {
            operationId: createId(), projectId: project.id, workspaceId: null, actor: input.actor,
            operationName: "workspace.create", resourceType: "workspace", resourceId: createId(),
            state: "accepted", progressJson: null, errorCode: null, errorMessage: null,
            createdAt, startedAt: null, finishedAt: null
          };
          db.insert(operations).values(workspaceOperation).run();
        }
        return { project, revision, workspaceId: workspaceOperation.resourceId };
      }).immediate();
    },
    getOrCreateOperation(input: {
      projectId: string; actor: string; operationName: string; resourceType: string; resourceId: string;
    }): Operation {
      return client.transaction(() => {
        const existing = db.select().from(operations).where(and(
          eq(operations.projectId, input.projectId), eq(operations.operationName, input.operationName)
        )).orderBy(desc(operations.createdAt), desc(operations.operationId)).get();
        if (existing !== undefined && existing.state !== "failed") {
          if (existing.resourceId !== input.resourceId || existing.resourceType !== input.resourceType) {
            throw new ProjectSetupConflictError("The retained setup operation has incompatible resource ownership.");
          }
          return existing;
        }
        const timestamp = now().toISOString();
        const operation: Operation = {
          operationId: createId(), projectId: input.projectId, workspaceId: null, actor: input.actor,
          operationName: input.operationName, resourceType: input.resourceType, resourceId: input.resourceId,
          state: "accepted", progressJson: null, errorCode: null, errorMessage: null,
          createdAt: timestamp, startedAt: null, finishedAt: null
        };
        db.insert(operations).values(operation).run();
        return operation;
      }).immediate();
    },
    finishOperation(operationId: string, outcome: { state: "succeeded" } | { state: "failed"; code: string; message: string }): void {
      const timestamp = now().toISOString();
      db.update(operations).set({
        state: outcome.state, finishedAt: timestamp,
        errorCode: outcome.state === "failed" ? outcome.code : null,
        errorMessage: outcome.state === "failed" ? outcome.message : null
      }).where(and(eq(operations.operationId, operationId), or(
        eq(operations.state, "accepted"), eq(operations.state, "running")
      ))).run();
    },
    getRuntimeContext(projectId: string) {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (project === undefined || project.state !== "ready" || project.primaryWorkspaceId === null || project.activeConfigRevisionId === null) {
        throw new ProjectSetupConflictError("A ready primary workspace is required.");
      }
      const workspace = db.select().from(workspaces).where(and(eq(workspaces.id, project.primaryWorkspaceId), eq(workspaces.projectId, project.id))).get();
      const revision = db.select().from(projectConfigRevisions).where(and(
        eq(projectConfigRevisions.id, project.activeConfigRevisionId), eq(projectConfigRevisions.projectId, project.id)
      )).get();
      if (workspace === undefined || workspace.kind !== "primary" || revision === undefined || workspace.configRevisionId !== revision.id) {
        throw new ProjectSetupConflictError("The primary workspace configuration is inconsistent.");
      }
      return { project, workspace, revision };
    },
    storeRuntimePlanPair(input: { projectId: string; revisionId: string; canonicalJson: string; hash: string }): void {
      client.transaction(() => {
        const revision = db.select().from(projectConfigRevisions).where(and(
          eq(projectConfigRevisions.id, input.revisionId), eq(projectConfigRevisions.projectId, input.projectId)
        )).get();
        if (revision === undefined) throw new ProjectSetupConflictError("The configuration revision no longer exists.");
        if (revision.compiledRuntimePlanJson !== null || revision.runtimePlanHash !== null) {
          if (revision.compiledRuntimePlanJson !== input.canonicalJson || revision.runtimePlanHash !== input.hash) {
            throw new ProjectSetupConflictError("The retained runtime plan does not match deterministic compilation.");
          }
          return;
        }
        db.update(projectConfigRevisions).set({ compiledRuntimePlanJson: input.canonicalJson, runtimePlanHash: input.hash })
          .where(and(eq(projectConfigRevisions.id, input.revisionId), isNull(projectConfigRevisions.compiledRuntimePlanJson))).run();
      }).immediate();
    },
    prepareRuntimeMutation(input: {
      projectId: string; workspaceId: string; actor: string; action: "start" | "stop";
      runtimePlanHash: string; imageReference: string;
    }): Operation {
      return client.transaction(() => {
        const context = this.getRuntimeContext(input.projectId);
        if (context.workspace.id !== input.workspaceId || context.workspace.observedState === "provisioning") {
          throw new ProjectSetupConflictError("The primary workspace is not ready for a runtime action.");
        }
        const active = db.select().from(operations).where(and(eq(operations.projectId, input.projectId),
          eq(operations.workspaceId, input.workspaceId))).orderBy(desc(operations.createdAt), desc(operations.operationId)).all()
          .find((candidate) => (candidate.operationName === "workspace.start" || candidate.operationName === "workspace.stop")
            && (candidate.state === "accepted" || candidate.state === "running"));
        if (active !== undefined) {
          if (active.operationName === `workspace.${input.action}`) return active;
          throw new ProjectSetupConflictError("Another runtime action is still in progress.");
        }
        let stack = db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, input.workspaceId)).get();
        const target = input.action === "start" ? "running" as const : "stopped" as const;
        if (stack === undefined && input.action === "stop") throw new ProjectSetupConflictError("No development runtime exists to stop.");
        const timestamp = now().toISOString();
        if (stack === undefined) {
          stack = { id: createId(), workspaceId: input.workspaceId, runtimeNamespace: `workspace-runtime:${input.workspaceId}`,
            runtimePlanHash: input.runtimePlanHash, desiredState: "running", observedState: "absent", runtimeGeneration: 1,
            createdAt: timestamp, updatedAt: timestamp, lastObservedAt: null, lastErrorCode: null, lastErrorMessage: null };
          db.insert(runtimeStacks).values(stack).run();
          db.insert(workspaceServices).values({ id: createId(), runtimeStackId: stack.id, serviceKey: "development", kind: "development",
            containerId: null, imageReference: input.imageReference, imageDigest: null, desiredState: "running", observedState: "absent",
            healthState: "unknown", startedAt: null, stoppedAt: null, lastObservedAt: null }).run();
        } else {
          if (stack.runtimePlanHash !== input.runtimePlanHash || stack.runtimeGeneration !== 1) {
            throw new ProjectSetupConflictError("The retained runtime stack belongs to another plan or generation.");
          }
          db.update(runtimeStacks).set({ desiredState: target, updatedAt: timestamp, lastErrorCode: null, lastErrorMessage: null })
            .where(eq(runtimeStacks.id, stack.id)).run();
          db.update(workspaceServices).set({ desiredState: target }).where(eq(workspaceServices.runtimeStackId, stack.id)).run();
        }
        db.update(workspaces).set({ desiredState: target, updatedAt: timestamp, rowVersion: context.workspace.rowVersion + 1 })
          .where(eq(workspaces.id, input.workspaceId)).run();
        const operation: Operation = { operationId: createId(), projectId: input.projectId, workspaceId: input.workspaceId,
          actor: input.actor, operationName: `workspace.${input.action}`, resourceType: "workspace", resourceId: input.workspaceId,
          state: "accepted", progressJson: null, errorCode: null, errorMessage: null,
          createdAt: timestamp, startedAt: null, finishedAt: null };
        db.insert(operations).values(operation).run();
        return operation;
      }).immediate();
    },
    finishRuntimeMutation(input: { operationId: string; projectId: string; workspaceId: string;
      outcome: { state: "succeeded"; workspaceObserved: WorkspaceInspectionData["observedState"];
        runtimeObserved: WorkspaceInspectionData["runtimeStack"]["observedState"] }
        | { state: "failed"; code: string; message: string } }): void {
      client.transaction(() => {
        const timestamp = now().toISOString();
        const stack = db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, input.workspaceId)).get();
        if (stack === undefined) throw new ProjectSetupConflictError("The runtime stack no longer exists.");
        if (input.outcome.state === "succeeded") {
          db.update(runtimeStacks).set({ observedState: input.outcome.runtimeObserved, lastObservedAt: timestamp,
            updatedAt: timestamp, lastErrorCode: null, lastErrorMessage: null }).where(eq(runtimeStacks.id, stack.id)).run();
          db.update(workspaces).set({ observedState: input.outcome.workspaceObserved, updatedAt: timestamp })
            .where(eq(workspaces.id, input.workspaceId)).run();
          db.update(workspaceServices).set({ observedState: input.outcome.runtimeObserved, healthState: "unknown", lastObservedAt: timestamp,
            startedAt: input.outcome.runtimeObserved === "running" ? timestamp : null,
            stoppedAt: input.outcome.runtimeObserved === "stopped" ? timestamp : null }).where(eq(workspaceServices.runtimeStackId, stack.id)).run();
        } else {
          db.update(runtimeStacks).set({ updatedAt: timestamp, lastObservedAt: timestamp, lastErrorCode: input.outcome.code,
            lastErrorMessage: input.outcome.message.slice(0, 512) }).where(eq(runtimeStacks.id, stack.id)).run();
        }
        this.finishOperation(input.operationId, input.outcome.state === "succeeded" ? { state: "succeeded" }
          : { state: "failed", code: input.outcome.code, message: input.outcome.message.slice(0, 512) });
      }).immediate();
    },
    prepareTerminalCreate(projectId: string, actor: string): { operation: Operation; workspaceId: string; terminalId: string } {
      return client.transaction(() => {
        const context = this.getRuntimeContext(projectId);
        if (context.workspace.observedState !== "running") throw new ProjectSetupConflictError("The workspace runtime must be running.");
        const stack = db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, context.workspace.id)).get();
        const service = stack === undefined ? undefined : db.select().from(workspaceServices).where(and(
          eq(workspaceServices.runtimeStackId, stack.id), eq(workspaceServices.kind, "development"))).get();
        if (stack?.observedState !== "running" || service?.observedState !== "running") {
          throw new ProjectSetupConflictError("The exact development container is not running.");
        }
        const terminalId = createId();
        const timestamp = now().toISOString();
        db.insert(processes).values({ id: terminalId, workspaceId: context.workspace.id, serviceId: service.id,
          kind: "terminal", definitionKey: null, desiredState: "running", observedState: "queued", exitCode: null,
          startedAt: null, finishedAt: null, lastObservedAt: null }).run();
        db.insert(terminalSessions).values({ id: terminalId, workspaceId: context.workspace.id, processId: terminalId,
          title: "Workspace terminal", shellProfileKey: "agent-default-sh", state: "creating", createdAt: timestamp,
          lastActivityAt: null, closedAt: null }).run();
        const operation: Operation = { operationId: createId(), projectId, workspaceId: context.workspace.id, actor,
          operationName: "terminal.create", resourceType: "terminal", resourceId: terminalId, state: "accepted",
          progressJson: null, errorCode: null, errorMessage: null, createdAt: timestamp, startedAt: null, finishedAt: null };
        db.insert(operations).values(operation).run();
        return { operation, workspaceId: context.workspace.id, terminalId };
      }).immediate();
    },
    failTerminalCreate(input: { operationId: string; terminalId: string; code: string; message: string }): void {
      client.transaction(() => {
        const timestamp = now().toISOString();
        this.finishOperation(input.operationId, { state: "failed", code: input.code, message: input.message.slice(0, 512) });
        db.update(terminalSessions).set({ state: "failed", closedAt: timestamp })
          .where(and(eq(terminalSessions.id, input.terminalId), eq(terminalSessions.state, "creating"))).run();
        db.update(processes).set({ observedState: "failed", finishedAt: timestamp, lastObservedAt: timestamp })
          .where(and(eq(processes.id, input.terminalId), eq(processes.observedState, "queued"))).run();
      }).immediate();
    },
    prepareTerminalClose(projectId: string, terminalId: string, actor: string): { operation: Operation; workspaceId: string } {
      return client.transaction(() => {
        const context = this.getRuntimeContext(projectId);
        const terminal = db.select().from(terminalSessions).where(and(eq(terminalSessions.id, terminalId),
          eq(terminalSessions.workspaceId, context.workspace.id))).get();
        if (terminal === undefined) throw new ProjectSetupConflictError("The terminal was not found.");
        const retained = db.select().from(operations).where(and(eq(operations.resourceId, terminalId), eq(operations.operationName, "terminal.close")))
          .orderBy(desc(operations.createdAt)).get();
        if (retained !== undefined && (retained.state === "accepted" || retained.state === "running")) {
          return { operation: retained, workspaceId: context.workspace.id };
        }
        if (!["active", "disconnected"].includes(terminal.state)) {
          throw new ProjectSetupConflictError("The terminal is no longer attachable.");
        }
        const timestamp = now().toISOString();
        db.update(terminalSessions).set({ state: "closing" }).where(eq(terminalSessions.id, terminalId)).run();
        db.update(processes).set({ desiredState: "stopped" }).where(eq(processes.id, terminal.processId)).run();
        const operation: Operation = { operationId: createId(), projectId, workspaceId: context.workspace.id, actor,
          operationName: "terminal.close", resourceType: "terminal", resourceId: terminalId, state: "accepted",
          progressJson: null, errorCode: null, errorMessage: null, createdAt: timestamp, startedAt: null, finishedAt: null };
        db.insert(operations).values(operation).run();
        return { operation, workspaceId: context.workspace.id };
      }).immediate();
    },
    prepareTaskStart(projectId: string, taskKey: string, actor: string): { operation: Operation; workspaceId: string; taskRunId: string; processId: string } {
      return client.transaction(() => {
        const context = this.getRuntimeContext(projectId);
        if (context.workspace.observedState !== "running") throw new ProjectSetupConflictError("The workspace runtime must be running.");
        const options = parseProjectOptionsV1(JSON.parse(context.revision.configurationJson));
        const task = options.tasks.find((candidate) => candidate.key === taskKey);
        if (task === undefined) throw new ProjectSetupConflictError("The configured task was not found.");
        const stack = db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, context.workspace.id)).get();
        const service = stack === undefined ? undefined : db.select().from(workspaceServices).where(and(
          eq(workspaceServices.runtimeStackId, stack.id), eq(workspaceServices.kind, "development"))).get();
        if (stack?.observedState !== "running" || service?.observedState !== "running") throw new ProjectSetupConflictError("The exact development container is not running.");
        const activeRuns = db.select().from(taskRuns).where(and(eq(taskRuns.workspaceId, context.workspace.id), eq(taskRuns.taskKey, taskKey))).all()
          .filter((run) => ["queued", "starting", "running"].includes(run.state));
        if (task.concurrencyPolicy === "reject" && activeRuns.length > 0) throw new ProjectSetupConflictError("This task already has an active run.");
        const staleRuns = db.select().from(taskRuns).where(eq(taskRuns.workspaceId, context.workspace.id)).all()
          .filter((run) => ["passed", "failed", "cancelled", "timed_out", "lost"].includes(run.state))
          .sort((left, right) => (right.finishedAt ?? right.id).localeCompare(left.finishedAt ?? left.id)).slice(99);
        for (const stale of staleRuns) {
          db.delete(taskRuns).where(eq(taskRuns.id, stale.id)).run();
          if (stale.processId !== null) db.delete(processes).where(eq(processes.id, stale.processId)).run();
        }
        const taskRunId = createId(); const processId = createId(); const timestamp = now().toISOString();
        db.insert(processes).values({ id: processId, workspaceId: context.workspace.id, serviceId: service.id,
          kind: "task", definitionKey: taskKey, desiredState: "running", observedState: "queued", exitCode: null,
          startedAt: null, finishedAt: null, lastObservedAt: null }).run();
        db.insert(taskRuns).values({ id: taskRunId, workspaceId: context.workspace.id, taskKey, processId,
          configRevisionId: context.revision.id, state: "queued", exitCode: null, startedAt: null, finishedAt: null,
          summaryJson: null }).run();
        const operation: Operation = { operationId: createId(), projectId, workspaceId: context.workspace.id, actor,
          operationName: "task.start", resourceType: "task-run", resourceId: taskRunId, state: "accepted",
          progressJson: null, errorCode: null, errorMessage: null, createdAt: timestamp, startedAt: null, finishedAt: null };
        db.insert(operations).values(operation).run();
        return { operation, workspaceId: context.workspace.id, taskRunId, processId };
      }).immediate();
    },
    prepareProcessStop(projectId: string, processId: string, actor: string): { operation: Operation; workspaceId: string } {
      return client.transaction(() => {
        const context = this.getRuntimeContext(projectId);
        const process = db.select().from(processes).where(and(eq(processes.id, processId), eq(processes.workspaceId, context.workspace.id))).get();
        if (process === undefined || process.kind !== "task") throw new ProjectSetupConflictError("The task process was not found.");
        const retained = db.select().from(operations).where(and(eq(operations.resourceId, processId), eq(operations.operationName, "process.stop")))
          .orderBy(desc(operations.createdAt)).get();
        if (retained !== undefined && (retained.state === "accepted" || retained.state === "running")) return { operation: retained, workspaceId: context.workspace.id };
        const timestamp = now().toISOString();
        db.update(processes).set({ desiredState: "stopped" }).where(eq(processes.id, processId)).run();
        const operation: Operation = { operationId: createId(), projectId, workspaceId: context.workspace.id, actor,
          operationName: "process.stop", resourceType: "process", resourceId: processId, state: "accepted",
          progressJson: null, errorCode: null, errorMessage: null, createdAt: timestamp, startedAt: null, finishedAt: null };
        db.insert(operations).values(operation).run(); return { operation, workspaceId: context.workspace.id };
      }).immediate();
    },
    applyExecutionSnapshot(snapshot: AgentSnapshotData): void {
      client.transaction(() => {
        const timestamp = now().toISOString();
        for (const operation of snapshot.operationObservations) {
          const local = db.select().from(operations).where(eq(operations.operationId, operation.operationId)).get();
          if (local === undefined || !["task.start", "process.stop", "terminal.create", "terminal.close"].includes(local.operationName)) continue;
          if (operation.state === "succeeded") this.finishOperation(local.operationId, { state: "succeeded" });
          else if (operation.state === "failed") {
            this.finishOperation(local.operationId, { state: "failed",
              code: operation.failure.code, message: operation.failure.message.slice(0, 512) });
            if (local.operationName === "terminal.create") {
              db.update(terminalSessions).set({ state: "failed", closedAt: timestamp }).where(eq(terminalSessions.id, local.resourceId)).run();
              db.update(processes).set({ observedState: "failed", finishedAt: timestamp, lastObservedAt: timestamp })
                .where(eq(processes.id, local.resourceId)).run();
            } else if (local.operationName === "task.start") {
              const run = db.select().from(taskRuns).where(eq(taskRuns.id, local.resourceId)).get();
              db.update(taskRuns).set({ state: "failed", finishedAt: timestamp }).where(eq(taskRuns.id, local.resourceId)).run();
              if (run?.processId !== null && run?.processId !== undefined) {
                db.update(processes).set({ observedState: "failed", finishedAt: timestamp, lastObservedAt: timestamp })
                  .where(eq(processes.id, run.processId)).run();
              }
            } else if (local.operationName === "process.stop") {
              db.update(processes).set({ desiredState: "running" }).where(eq(processes.id, local.resourceId)).run();
            } else if (local.operationName === "terminal.close") {
              const terminal = db.select({ state: terminalSessions.state }).from(terminalSessions)
                .where(eq(terminalSessions.id, local.resourceId)).get();
              if (terminal !== undefined && ["active", "disconnected"].includes(terminal.state)) {
                db.update(terminalSessions).set({ state: "disconnected" }).where(eq(terminalSessions.id, local.resourceId)).run();
                db.update(processes).set({ desiredState: "running" }).where(eq(processes.id, local.resourceId)).run();
              }
            }
          }
          else db.update(operations).set({ state: operation.state, startedAt: operation.state === "running" ? timestamp : local.startedAt })
            .where(eq(operations.operationId, local.operationId)).run();
        }
        for (const resource of snapshot.resources) {
          if (resource.type === "process") {
            const observed = resource.observation;
            db.update(processes).set({ desiredState: observed.desiredState, observedState: observed.observedState,
              exitCode: observed.exitCode, startedAt: observed.startedAt, finishedAt: observed.finishedAt, lastObservedAt: timestamp })
              .where(and(eq(processes.id, observed.processId), eq(processes.workspaceId, observed.workspaceId))).run();
          } else if (resource.type === "terminal") {
            db.update(terminalSessions).set({ state: resource.state, lastActivityAt: timestamp,
              closedAt: ["closed", "failed", "lost"].includes(resource.state) ? timestamp : null })
              .where(and(eq(terminalSessions.id, resource.identity.terminalId), eq(terminalSessions.workspaceId, resource.identity.workspaceId))).run();
          }
        }
        const allRuns = db.select().from(taskRuns).all();
        for (const run of allRuns) {
          if (run.processId === null) continue;
          const process = db.select().from(processes).where(eq(processes.id, run.processId)).get();
          if (process === undefined) continue;
          const revision = db.select().from(projectConfigRevisions).where(eq(projectConfigRevisions.id, run.configRevisionId)).get();
          const task = revision === undefined ? undefined : parseProjectOptionsV1(JSON.parse(revision.configurationJson)).tasks.find((item) => item.key === run.taskKey);
          let state: typeof run.state;
          if (["queued", "starting", "running"].includes(process.observedState)) state = process.observedState === "queued" ? "queued" : process.observedState === "starting" ? "starting" : "running";
          else if (process.observedState === "lost") state = "lost";
          else if (process.desiredState === "stopped" || process.observedState === "killed") {
            const timedOut = task?.timeoutSeconds !== null && task?.timeoutSeconds !== undefined && process.startedAt !== null
              && now().valueOf() >= new Date(process.startedAt).valueOf() + task.timeoutSeconds * 1_000;
            state = timedOut ? "timed_out" : "cancelled";
          } else state = process.exitCode !== null && task?.successExitCodes.includes(process.exitCode) ? "passed" : "failed";
          db.update(taskRuns).set({ state, exitCode: process.exitCode, startedAt: process.startedAt,
            finishedAt: process.finishedAt }).where(eq(taskRuns.id, run.id)).run();
        }
      }).immediate();
    },
    authorizeTerminal(projectId: string, workspaceId: string, terminalId: string): boolean {
      const project = db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.primaryWorkspaceId, workspaceId))).get();
      if (project === undefined || project.state !== "ready") return false;
      const terminal = db.select().from(terminalSessions).where(and(eq(terminalSessions.id, terminalId), eq(terminalSessions.workspaceId, workspaceId))).get();
      return terminal !== undefined && ["active", "disconnected"].includes(terminal.state);
    },
    finalizePrimaryWorkspace(input: {
      projectId: string; revisionId: string; workspaceId: string; branchName: string; baseRef: string; actor: string;
      dirtyState: "clean" | "dirty";
    }): ManagedProjectView {
      client.transaction(() => {
        const project = db.select().from(projects).where(eq(projects.id, input.projectId)).get();
        if (project === undefined) throw new ProjectSetupConflictError("The project no longer exists.");
        if (project.state === "ready") return;
        const required = ["configuration-revision.register", "configuration-runtime-plan.register", "project.managed-store.create", "project.fetch", "workspace.create"];
        const completed = db.select().from(operations).where(eq(operations.projectId, project.id)).all();
        if (required.some((name) => !completed.some((operation) => operation.operationName === name && operation.state === "succeeded"))) {
          throw new ProjectSetupConflictError("Workspace setup operations have not all succeeded.");
        }
        const timestamp = now().toISOString();
        db.insert(workspaces).values({
          id: input.workspaceId, projectId: project.id, configRevisionId: input.revisionId,
          kind: "primary", name: "Primary", slug: "primary", branchName: input.branchName,
          baseRef: input.baseRef, worktreePath: `/srv/devspace/workspaces/${input.workspaceId}/source`,
          desiredState: "stopped", observedState: "stopped", dirtyState: input.dirtyState,
          createdAt: timestamp, updatedAt: timestamp, archivedAt: null, removedAt: null, rowVersion: 1
        }).run();
        db.update(projectConfigRevisions).set({ state: "active", activatedAt: timestamp })
          .where(and(eq(projectConfigRevisions.id, input.revisionId), eq(projectConfigRevisions.state, "draft"))).run();
        db.update(projects).set({
          activeConfigRevisionId: input.revisionId, primaryWorkspaceId: input.workspaceId,
          state: "ready", updatedAt: timestamp, rowVersion: project.rowVersion + 1
        }).where(and(eq(projects.id, project.id), eq(projects.state, "registering"))).run();
        const last = db.select({ sequence: auditEvents.sequence }).from(auditEvents).orderBy(desc(auditEvents.sequence)).limit(1).get();
        const workspaceOperation = completed.find((operation) => operation.operationName === "workspace.create");
        db.insert(auditEvents).values({
          id: createId(), sequence: (last?.sequence ?? -1) + 1, actor: input.actor,
          eventType: "workspace.primary.created", resourceType: "workspace", resourceId: input.workspaceId,
          operationId: workspaceOperation?.operationId ?? null, metadataJson: JSON.stringify({ desiredState: "stopped", runtimeStack: "absent" }),
          createdAt: timestamp
        }).run();
      }).immediate();
      const result = this.listManagedProjects().find((project) => project.id === input.projectId);
      if (result === undefined) throw new ProjectSetupConflictError("The finalized project could not be read.");
      return result;
    },
    listOperations: () => db.select().from(operations).orderBy(operations.createdAt, operations.operationId).all(),
    listRuntimeOperations: (projectId: string, workspaceId: string) => db.select().from(operations).where(and(
      eq(operations.projectId, projectId), eq(operations.workspaceId, workspaceId)
    )).orderBy(desc(operations.createdAt), desc(operations.operationId)).all().filter((operation) =>
      operation.operationName === "workspace.start" || operation.operationName === "workspace.stop"),
    listConfigRevisions: () => db.select().from(projectConfigRevisions).orderBy(projectConfigRevisions.revisionNumber).all(),
    listWorkspaces: () => db.select().from(workspaces).orderBy(workspaces.createdAt, workspaces.id).all(),
    listRuntimeStacks: () => db.select().from(runtimeStacks).all(),
    listWorkspaceServices: () => db.select().from(workspaceServices).all(),
    listAuditEvents: () => db.select().from(auditEvents).orderBy(auditEvents.sequence).all()
  };
}

export type ProjectDatabase = ReturnType<typeof openProjectDatabase>;

let singleton: { path: string; database: ProjectDatabase } | undefined;
export function getProjectDatabase(path: string): ProjectDatabase {
  if (singleton?.path !== path) {
    singleton?.database.close();
    singleton = { path, database: openProjectDatabase(path) };
  }
  return singleton.database;
}
