import { withTemporaryDirectory } from "@devspace/testkit";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  drizzleMigrationTableName,
  latestSchemaVersion,
  migrateDatabase,
  UnsupportedMigrationHistoryError,
  UnsupportedDatabaseVersionError
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
const timestamp = "2026-07-16T12:00:00.000Z";
const hash = `sha256-jcs-v1:${"a".repeat(64)}`;

function id(value: number): string {
  return `0190a000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
}

function insertProject(
  database: Database.Database,
  projectId: string,
  slug: string,
  storePath = `/var/lib/devspace/repositories/${slug}`
): void {
  database.prepare(`
    insert into projects (
      id, name, slug, repository_url, repository_store_path, default_branch,
      state, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, 'registering', ?, ?)
  `).run(projectId, `Project ${slug}`, slug, `https://example.test/${slug}.git`, storePath, "main", timestamp, timestamp);
}

function insertRevision(
  database: Database.Database,
  revisionId: string,
  projectId: string,
  revisionNumber: number,
  state: "draft" | "active" = "draft"
): void {
  database.prepare(`
    insert into project_config_revisions (
      id, project_id, revision_number, schema_version, configuration_json,
      configuration_hash, source, state, created_by, created_at
    ) values (?, ?, ?, 1, '{}', ?, 'user', ?, 'owner', ?)
  `).run(revisionId, projectId, revisionNumber, hash, state, timestamp);
}

function insertWorkspace(
  database: Database.Database,
  workspaceId: string,
  projectId: string,
  revisionId: string,
  kind: "primary" | "isolated",
  desiredState: "stopped" | "removed",
  slug: string
): void {
  database.prepare(`
    insert into workspaces (
      id, project_id, config_revision_id, kind, name, slug, branch_name, base_ref,
      worktree_path, desired_state, observed_state, dirty_state, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, 'main', ?, ?, ?, 'clean', ?, ?)
  `).run(
    workspaceId,
    projectId,
    revisionId,
    kind,
    `Workspace ${slug}`,
    slug,
    `work/${slug}`,
    `/var/lib/devspace/worktrees/${slug}`,
    desiredState,
    desiredState === "removed" ? "removed" : "stopped",
    timestamp,
    timestamp
  );
}

describe("forward SQLite migration runner", () => {
  test("is safe against an already-current real database", async () => {
    await withTemporaryDirectory((directory) => {
      const database = new Database(`${directory}/already-current.sqlite`);
      try {
        migrateDatabase(database, { migrationsFolder });
        const before = database.prepare(
          "select name, type, sql from sqlite_schema order by type, name"
        ).all();

        migrateDatabase(database, { migrationsFolder });

        expect(database.prepare(`select count(*) as count from ${drizzleMigrationTableName}`).get())
          .toEqual({ count: 1 });
        expect(database.prepare("select name, type, sql from sqlite_schema order by type, name").all())
          .toEqual(before);
        expect(database.pragma("user_version", { simple: true })).toBe(latestSchemaVersion);
      } finally {
        database.close();
      }
      return Promise.resolve();
    });
  });

  test("refuses newer Drizzle history even when user_version is still supported", async () => {
    await withTemporaryDirectory((directory) => {
      const database = new Database(`${directory}/newer-history-stale-version.sqlite`);
      try {
        migrateDatabase(database, { migrationsFolder });
        const current = database.prepare(
          `select max(created_at) as createdAt from ${drizzleMigrationTableName}`
        ).get() as { createdAt: number };

        database.exec("create table reviewer_newer_schema_evidence (id integer primary key)");
        database.prepare(
          `insert into ${drizzleMigrationTableName} (hash, created_at) values (?, ?)`
        ).run("b".repeat(64), current.createdAt + 1);
        database.pragma(`user_version = ${latestSchemaVersion}`);

        expect(() => migrateDatabase(database, { migrationsFolder })).toThrow(
          UnsupportedMigrationHistoryError
        );
        expect(database.pragma("user_version", { simple: true })).toBe(latestSchemaVersion);
      } finally {
        database.close();
      }
      return Promise.resolve();
    });
  });

  test("refuses a newer application schema before applying migrations", async () => {
    await withTemporaryDirectory((directory) => {
      const database = new Database(`${directory}/newer.sqlite`);
      try {
        database.pragma(`user_version = ${latestSchemaVersion + 1}`);
        expect(() => migrateDatabase(database, { migrationsFolder })).toThrow(
          UnsupportedDatabaseVersionError
        );
        expect(database.prepare(
          "select name from sqlite_schema where type = 'table' and name = ?"
        ).get(drizzleMigrationTableName)).toBeUndefined();
      } finally {
        database.close();
      }
      return Promise.resolve();
    });
  });

  test("accepts only canonical lowercase UUIDv7 text in real SQLite writes", async () => {
    await withTemporaryDirectory((directory) => {
      const database = new Database(`${directory}/uuid-checks.sqlite`);
      try {
        migrateDatabase(database, { migrationsFolder });
        insertProject(database, id(100), "valid-uuid");

        const malformedIds = [
          ["0190a00--0000-7000-8000-000000000001", "embedded-hyphen"],
          ["0190a0000000-7000-8000-000000000001", "missing-hyphen"],
          ["0190A000-0000-7000-8000-000000000001", "uppercase-hex"],
          ["0190a000-0000-6000-8000-000000000001", "wrong-version"],
          ["0190a000-0000-7000-7000-000000000001", "wrong-variant"]
        ] as const;

        for (const [malformedId, slug] of malformedIds) {
          expect(() => insertProject(database, malformedId, slug)).toThrow(/CHECK/);
        }
      } finally {
        database.close();
      }
      return Promise.resolve();
    });
  });

  test("enforces representative uniqueness, FK, lifecycle, delete, and pointer workflows", async () => {
    await withTemporaryDirectory((directory) => {
      const database = new Database(`${directory}/constraints.sqlite`);
      try {
        migrateDatabase(database, { migrationsFolder });

        const projectId = id(1);
        const revisionId = id(2);
        const secondRevisionId = id(3);
        const primaryWorkspaceId = id(4);
        const removedPrimaryWorkspaceId = id(5);
        const isolatedWorkspaceId = id(6);
        insertProject(database, projectId, "alpha");
        expect(() => insertProject(database, id(7), "alpha", "/different/store")).toThrow(/UNIQUE/);
        expect(() => insertRevision(database, id(8), id(999), 1)).toThrow(/FOREIGN KEY/);
        expect(() => database.prepare("update projects set state = 'mystery' where id = ?").run(projectId))
          .toThrow(/CHECK/);

        insertRevision(database, revisionId, projectId, 1, "active");
        expect(() => insertRevision(database, secondRevisionId, projectId, 2, "active")).toThrow(/UNIQUE/);
        insertRevision(database, secondRevisionId, projectId, 2, "draft");

        insertWorkspace(database, primaryWorkspaceId, projectId, revisionId, "primary", "stopped", "primary");
        insertWorkspace(
          database,
          removedPrimaryWorkspaceId,
          projectId,
          revisionId,
          "primary",
          "removed",
          "removed-primary"
        );
        expect(() => insertWorkspace(
          database,
          id(9),
          projectId,
          revisionId,
          "primary",
          "stopped",
          "other-primary"
        )).toThrow(/UNIQUE/);
        insertWorkspace(database, isolatedWorkspaceId, projectId, revisionId, "isolated", "stopped", "isolated");

        database.prepare(`
          update projects
          set active_config_revision_id = ?, primary_workspace_id = ?, state = 'ready'
          where id = ?
        `).run(revisionId, primaryWorkspaceId, projectId);
        expect(() => database.prepare("delete from project_config_revisions where id = ?").run(revisionId))
          .toThrow(/FOREIGN KEY/);
        expect(() => database.prepare("delete from workspaces where id = ?").run(primaryWorkspaceId))
          .toThrow(/FOREIGN KEY/);

        const stackId = id(10);
        const serviceId = id(11);
        const processId = id(12);
        const previewId = id(13);
        database.prepare(`
          insert into runtime_stacks (
            id, workspace_id, runtime_namespace, runtime_plan_hash, desired_state,
            observed_state, runtime_generation, created_at, updated_at
          ) values (?, ?, 'alpha-primary', ?, 'stopped', 'stopped', 1, ?, ?)
        `).run(stackId, primaryWorkspaceId, hash, timestamp, timestamp);
        database.prepare(`
          insert into workspace_services (
            id, runtime_stack_id, service_key, kind, image_reference, desired_state,
            observed_state, health_state
          ) values (?, ?, 'web', 'development', 'example/web:latest', 'running', 'running', 'healthy')
        `).run(serviceId, stackId);
        database.prepare(`
          insert into processes (
            id, workspace_id, service_id, kind, process_token, desired_state, observed_state
          ) values (?, ?, ?, 'task', 'process-token-1', 'running', 'running')
        `).run(processId, primaryWorkspaceId, serviceId);
        expect(() => database.prepare("delete from workspace_services where id = ?").run(serviceId))
          .toThrow(/FOREIGN KEY/);

        database.prepare(`
          insert into previews (
            id, workspace_id, service_id, preview_key, hostname, container_port, protocol,
            health_path, desired_state, observed_state, created_at, updated_at
          ) values (?, ?, ?, 'web', 'web.alpha.test', 3000, 'http', '/health',
            'active', 'healthy', ?, ?)
        `).run(previewId, primaryWorkspaceId, serviceId, timestamp, timestamp);
        database.prepare(`
          insert into port_leases (
            id, workspace_id, preview_id, port, bind_address, state, lease_token,
            created_at, expires_at
          ) values (?, ?, ?, 41000, '127.0.0.1', 'reserved', 'lease-1', ?, ?)
        `).run(id(14), primaryWorkspaceId, previewId, timestamp, timestamp);
        database.prepare(`
          insert into port_leases (
            id, workspace_id, port, bind_address, state, lease_token, created_at, expires_at
          ) values (?, ?, 41000, '127.0.0.1', 'released', 'lease-2', ?, ?)
        `).run(id(15), primaryWorkspaceId, timestamp, timestamp);
        expect(() => database.prepare(`
          insert into port_leases (
            id, workspace_id, port, bind_address, state, lease_token, created_at, expires_at
          ) values (?, ?, 41000, '127.0.0.1', 'active', 'lease-3', ?, ?)
        `).run(id(16), primaryWorkspaceId, timestamp, timestamp)).toThrow(/UNIQUE/);

        database.prepare("delete from previews where id = ?").run(previewId);
        expect(database.prepare("select preview_id from port_leases where id = ?").get(id(14)))
          .toEqual({ preview_id: null });

        const operationId = id(17);
        database.prepare(`
          insert into operations (
            operation_id, project_id, workspace_id, actor, operation_name, resource_type,
            resource_id, state, created_at
          ) values (?, ?, ?, 'owner', 'workspace.remove', 'workspace', ?, 'succeeded', ?)
        `).run(operationId, projectId, isolatedWorkspaceId, isolatedWorkspaceId, timestamp);
        database.prepare(`
          insert into audit_events (
            id, sequence, actor, event_type, resource_type, resource_id,
            operation_id, metadata_json, created_at
          ) values (?, 1, 'owner', 'workspace.removed', 'workspace', ?, ?, '{}', ?)
        `).run(id(18), isolatedWorkspaceId, operationId, timestamp);

        database.prepare("delete from workspaces where id = ?").run(isolatedWorkspaceId);
        expect(database.prepare("select workspace_id from operations where operation_id = ?").get(operationId))
          .toEqual({ workspace_id: null });

        // Current child pointers must be cleared before deleting their owning project.
        database.prepare(`
          update projects
          set active_config_revision_id = null, primary_workspace_id = null, state = 'archived'
          where id = ?
        `).run(projectId);
        expect(() => database.prepare("delete from projects where id = ?").run(projectId))
          .toThrow(/FOREIGN KEY/);
        database.prepare("delete from processes where workspace_id = ?").run(primaryWorkspaceId);
        database.prepare("delete from workspaces where project_id = ?").run(projectId);
        database.prepare("delete from projects where id = ?").run(projectId);
        expect(database.prepare("select count(*) as count from workspaces where project_id = ?").get(projectId))
          .toEqual({ count: 0 });
        expect(database.prepare("select count(*) as count from project_config_revisions where project_id = ?").get(projectId))
          .toEqual({ count: 0 });
        expect(database.prepare("select operation_id from audit_events where id = ?").get(id(18)))
          .toEqual({ operation_id: null });
      } finally {
        database.close();
      }
      return Promise.resolve();
    });
  });
});
