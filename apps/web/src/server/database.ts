import BetterSqlite3 from "better-sqlite3";
import type { WorkspaceInspectionData } from "@devspace/contracts";
import { mkdirSync } from "node:fs";
import pathModule from "node:path";
import {
  auditEvents, migrateDatabase, operations, projectConfigRevisions, projects, runtimeStacks, workspaceServices, workspaces,
  type Operation, type Project, type ProjectConfigRevision
} from "@devspace/database";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { v7 as uuidv7 } from "uuid";

export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly repositoryUrl: string;
  readonly defaultBranch: string;
  readonly state: "registering" | "ready" | "invalid" | "archived";
  readonly createdAt: string;
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
  return {
    close: () => client.close(),
    listProjects: (): ProjectView[] => db.select().from(projects).orderBy(desc(projects.createdAt)).all().map(toView),
    listManagedProjects(): ManagedProjectView[] {
      return db.select().from(projects).orderBy(desc(projects.createdAt)).all().map((project) => {
        const revision = project.activeConfigRevisionId === null ? undefined
          : db.select().from(projectConfigRevisions).where(eq(projectConfigRevisions.id, project.activeConfigRevisionId)).get();
        const workspace = project.primaryWorkspaceId === null ? undefined
          : db.select().from(workspaces).where(eq(workspaces.id, project.primaryWorkspaceId)).get();
        const runtime = workspace === undefined ? undefined
          : db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, workspace.id)).get();
        const development = runtime === undefined ? undefined : db.select().from(workspaceServices).where(and(
          eq(workspaceServices.runtimeStackId, runtime.id), eq(workspaceServices.kind, "development")
        )).get();
        return {
          ...toView(project),
          activeRevision: revision === undefined ? null : { id: revision.id, number: revision.revisionNumber, hash: revision.configurationHash },
          primaryWorkspace: workspace === undefined ? null : {
            id: workspace.id, name: workspace.name, branchName: workspace.branchName,
            desiredState: workspace.desiredState, observedState: workspace.observedState, dirtyState: workspace.dirtyState
          },
          runtime: runtime === undefined ? null : { id: runtime.id, desiredState: runtime.desiredState,
            observedState: runtime.observedState, generation: runtime.runtimeGeneration,
            errorMessage: runtime.lastErrorMessage, serviceObservedState: development?.observedState ?? null }
        };
      });
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
