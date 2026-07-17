import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import pathModule from "node:path";
import {
  auditEvents, migrateDatabase, operations, projectConfigRevisions, projects, workspaces,
  type Operation, type Project, type ProjectConfigRevision
} from "@devspace/database";
import { and, desc, eq } from "drizzle-orm";
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
        return {
          ...toView(project),
          activeRevision: revision === undefined ? null : { id: revision.id, number: revision.revisionNumber, hash: revision.configurationHash },
          primaryWorkspace: workspace === undefined ? null : {
            id: workspace.id, name: workspace.name, branchName: workspace.branchName,
            desiredState: workspace.desiredState, observedState: workspace.observedState, dirtyState: workspace.dirtyState
          }
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
      projectId: string; configurationJson: string; configurationHash: string; actor: string;
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
            compiledRuntimePlanJson: null, runtimePlanHash: null, source: "user", state: "draft",
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
      }).where(and(eq(operations.operationId, operationId), eq(operations.state, "accepted"))).run();
    },
    finalizePrimaryWorkspace(input: {
      projectId: string; revisionId: string; workspaceId: string; branchName: string; baseRef: string; actor: string;
      dirtyState: "clean" | "dirty";
    }): ManagedProjectView {
      client.transaction(() => {
        const project = db.select().from(projects).where(eq(projects.id, input.projectId)).get();
        if (project === undefined) throw new ProjectSetupConflictError("The project no longer exists.");
        if (project.state === "ready") return;
        const required = ["configuration-revision.register", "project.managed-store.create", "project.fetch", "workspace.create"];
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
    listConfigRevisions: () => db.select().from(projectConfigRevisions).orderBy(projectConfigRevisions.revisionNumber).all(),
    listWorkspaces: () => db.select().from(workspaces).orderBy(workspaces.createdAt, workspaces.id).all(),
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
