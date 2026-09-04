import { withTemporaryDirectory } from "@devspace/testkit";
import Database from "better-sqlite3";
import { getTableName } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  applicationTableNames,
  drizzleMigrationTableName,
  latestSchemaVersion,
  migrateDatabase,
  schema
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

function rows<T>(database: Database.Database, sql: string): T[] {
  return database.prepare(sql).all() as T[];
}

describe("database schema metadata", () => {
  test("exports exactly the accepted application tables", () => {
    expect(Object.keys(schema)).toHaveLength(19);
    expect(Object.values(schema).map(getTableName)).toEqual(applicationTableNames);
  });

  test("a fresh real SQLite file has the accepted tables, metadata, foreign keys, and partial indexes", async () => {
    await withTemporaryDirectory((directory) => {
      const database = new Database(`${directory}/schema.sqlite`);
      try {
        migrateDatabase(database, { migrationsFolder });

        const applicationTables = rows<{ name: string }>(
          database,
          `select name from sqlite_schema
           where type = 'table' and name not like 'sqlite_%' and name <> '${drizzleMigrationTableName}'
           order by name`
        ).map(({ name }) => name);
        expect(applicationTables).toEqual([...applicationTableNames].sort());
        expect(database.pragma("user_version", { simple: true })).toBe(latestSchemaVersion);
        expect(database.pragma("foreign_keys", { simple: true })).toBe(1);

        const migrationRows = rows<{ hash: string; created_at: number }>(
          database,
          `select hash, created_at from ${drizzleMigrationTableName} order by created_at`
        );
        expect(migrationRows).toHaveLength(latestSchemaVersion);
        for (const migration of migrationRows) {
          expect(migration.hash).toMatch(/^[0-9a-f]{64}$/);
          expect(migration.created_at).toEqual(expect.any(Number));
        }
        expect(migrationRows.map(({ created_at }) => created_at))
          .toEqual([...migrationRows.map(({ created_at }) => created_at)].sort((left, right) => left - right));

        const foreignKeys = applicationTableNames.flatMap((tableName) =>
          rows<{
            table: string;
            from: string;
            to: string;
            on_update: string;
            on_delete: string;
          }>(database, `pragma foreign_key_list('${tableName}')`).map((foreignKey) => ({
            ...foreignKey,
            childTable: tableName
          }))
        );
        expect(foreignKeys).toHaveLength(33);
        expect(new Set(foreignKeys.map(({ on_update }) => on_update))).toEqual(new Set(["NO ACTION"]));
        expect(Object.fromEntries(["CASCADE", "RESTRICT", "SET NULL"].map((action) => [
          action,
          foreignKeys.filter(({ on_delete }) => on_delete === action).length
        ]))).toEqual({ CASCADE: 15, RESTRICT: 9, "SET NULL": 9 });
        for (const foreignKey of foreignKeys.filter(({ on_delete }) => on_delete === "SET NULL")) {
          const column = rows<{ name: string; notnull: number }>(
            database,
            `pragma table_info('${foreignKey.childTable}')`
          ).find(({ name }) => name === foreignKey.from);
          expect(column?.notnull, `${foreignKey.childTable}.${foreignKey.from} must be nullable`).toBe(0);
        }

        const indexes = new Map(rows<{ name: string; sql: string }>(
          database,
          "select name, sql from sqlite_schema where type = 'index' and sql is not null"
        ).map(({ name, sql }) => [name, sql]));
        expect(indexes.get("project_config_revisions_one_active_per_project"))
          .toContain("WHERE \"project_config_revisions\".\"state\" = 'active'");
        expect(indexes.get("workspaces_one_non_removed_primary_per_project"))
          .toContain("WHERE \"workspaces\".\"kind\" = 'primary' and \"workspaces\".\"desired_state\" <> 'removed'");
        expect(indexes.get("port_leases_one_live_address_port"))
          .toContain("WHERE \"port_leases\".\"state\" in ('reserved', 'active')");

        const revisionsColumns = rows<{ name: string; notnull: number }>(
          database,
          "pragma table_info('project_config_revisions')"
        );
        expect(revisionsColumns.map(({ name }) => name)).not.toEqual(expect.arrayContaining([
          "name",
          "slug",
          "repository_url",
          "default_branch",
          "automatic_fetch_policy",
          "workspace_name"
        ]));
        expect(revisionsColumns.find(({ name }) => name === "created_at")?.notnull).toBe(1);
        expect(revisionsColumns.find(({ name }) => name === "activated_at")?.notnull).toBe(0);

        const timestampNullability: Record<string, Record<string, number>> = {
          projects: { created_at: 1, updated_at: 1, archived_at: 0 },
          project_config_revisions: { created_at: 1, activated_at: 0, superseded_at: 0 },
          workspaces: { created_at: 1, updated_at: 1, archived_at: 0, removed_at: 0 },
          runtime_stacks: { created_at: 1, updated_at: 1, last_observed_at: 0 },
          workspace_services: { started_at: 0, stopped_at: 0, last_observed_at: 0 },
          processes: { started_at: 0, finished_at: 0, last_observed_at: 0 },
          terminal_sessions: { created_at: 1, last_activity_at: 0, closed_at: 0 },
          previews: { created_at: 1, updated_at: 1, activated_at: 0, deactivated_at: 0 },
          port_leases: { created_at: 1, activated_at: 0, released_at: 0, expires_at: 1 },
          ai_sessions: { created_at: 1, updated_at: 1, last_activity_at: 0, stopped_at: 0 },
          task_runs: { started_at: 0, finished_at: 0 },
          operations: { created_at: 1, started_at: 0, finished_at: 0 },
          audit_events: { created_at: 1 }
        };
        for (const [tableName, expected] of Object.entries(timestampNullability)) {
          const actual = Object.fromEntries(
            rows<{ name: string; notnull: number }>(database, `pragma table_info('${tableName}')`)
              .filter(({ name }) => name.endsWith("_at"))
              .map(({ name, notnull }) => [name, notnull])
          );
          expect(actual, `${tableName} timestamp nullability`).toEqual(expected);
        }

        const schemaSql = rows<{ name: string; sql: string }>(
          database,
          "select name, sql from sqlite_schema where type = 'table'"
        );
        const projectsSql = schemaSql.find(({ name }) => name === "projects")?.sql;
        const taskRunsSql = schemaSql.find(({ name }) => name === "task_runs")?.sql;
        expect(projectsSql).toContain("'registering', 'ready', 'invalid', 'archived'");
        expect(taskRunsSql).toContain(
          "'queued', 'starting', 'running', 'passed', 'failed', 'cancelled', 'timed_out', 'lost'"
        );
        const previewColumns = rows<{ name: string; notnull: number; dflt_value: string | null }>(
          database,
          "pragma table_info('previews')"
        );
        expect(previewColumns.find(({ name }) => name === "hostname")?.notnull).toBe(1);
        expect(previewColumns.find(({ name }) => name === "route_present"))
          .toMatchObject({ notnull: 1, dflt_value: "false" });
        expect(previewColumns.map(({ name }) => name)).toEqual(expect.arrayContaining([
          "config_revision_id", "display_name", "target_kind", "target_key", "domain_base_id",
          "hostname_pattern", "health_statuses_json", "startup_timeout_seconds", "web_socket_forwarding",
          "runtime_generation", "last_observation_json", "last_error_code", "last_error_message", "operation_id"
        ]));

        const forbiddenTables = [
          "agent_journal",
          "agent_operations",
          "agent_events",
          "event_history",
          "event_cursors",
          "snapshots",
          "agent_snapshots"
        ];
        expect(applicationTables).not.toEqual(expect.arrayContaining(forbiddenTables));
      } finally {
        database.close();
      }
      return Promise.resolve();
    });
  });
});
