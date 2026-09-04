import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";

export const latestSchemaVersion = 7;
export const drizzleMigrationTableName = "__drizzle_migrations";

export interface MigrationOptions {
  readonly migrationsFolder?: string;
}

export class UnsupportedDatabaseVersionError extends Error {
  readonly databaseVersion: number;
  readonly supportedVersion: number;

  constructor(databaseVersion: number, supportedVersion: number) {
    super(
      `Database schema version ${databaseVersion} is newer than supported version ${supportedVersion}.`
    );
    this.name = "UnsupportedDatabaseVersionError";
    this.databaseVersion = databaseVersion;
    this.supportedVersion = supportedVersion;
  }
}

export class UnsupportedMigrationHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedMigrationHistoryError";
  }
}

export function defaultMigrationsFolder(): string {
  return fileURLToPath(new URL("./migrations", import.meta.url));
}

function readUserVersion(client: BetterSqlite3.Database): number {
  const value = client.pragma("user_version", { simple: true });
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`SQLite returned an invalid PRAGMA user_version: ${String(value)}.`);
  }
  return value;
}

interface PersistedMigration {
  readonly hash: string;
  readonly created_at: number | null;
}

function migrationTableExists(client: BetterSqlite3.Database): boolean {
  return client.prepare(
    "select 1 from sqlite_schema where type = 'table' and name = ?"
  ).get(drizzleMigrationTableName) !== undefined;
}

function assertCompatibleMigrationHistory(
  client: BetterSqlite3.Database,
  bundledMigrations: readonly MigrationMeta[]
): void {
  if (!migrationTableExists(client)) return;

  const persistedMigrations = client.prepare(
    `select hash, created_at from ${drizzleMigrationTableName} order by created_at asc`
  ).all() as PersistedMigration[];

  if (persistedMigrations.length > bundledMigrations.length) {
    throw new UnsupportedMigrationHistoryError(
      `Database has ${persistedMigrations.length} applied migrations, but this application bundles `
      + `${bundledMigrations.length}.`
    );
  }

  for (const [index, persisted] of persistedMigrations.entries()) {
    const bundled = bundledMigrations[index];
    if (
      bundled === undefined
      || persisted.created_at !== bundled.folderMillis
      || persisted.hash !== bundled.hash
    ) {
      throw new UnsupportedMigrationHistoryError(
        `Database migration history contains an unknown or modified migration at position ${index}.`
      );
    }
  }
}

/**
 * Applies committed forward migrations to an explicitly supplied SQLite connection.
 *
 * The future Web owner controls connection creation and the database path. This helper only
 * establishes connection-level foreign-key enforcement, refuses newer schemas, and runs the
 * committed migration set.
 */
export function migrateDatabase(
  client: BetterSqlite3.Database,
  options: MigrationOptions = {}
): void {
  client.pragma("foreign_keys = ON");

  const migrationsFolder = options.migrationsFolder ?? defaultMigrationsFolder();
  const bundledMigrations = readMigrationFiles({ migrationsFolder });

  const databaseVersion = readUserVersion(client);
  if (databaseVersion > latestSchemaVersion) {
    throw new UnsupportedDatabaseVersionError(databaseVersion, latestSchemaVersion);
  }

  // Drizzle's committed history is authoritative for exact compatibility. user_version is a
  // coarse additional marker because its update occurs after Drizzle's supported transaction.
  assertCompatibleMigrationHistory(client, bundledMigrations);

  migrate(drizzle({ client }), {
    migrationsFolder
  });

  // Recheck before advancing the coarse marker so a concurrently introduced unknown migration
  // cannot be hidden by writing this application's user_version.
  assertCompatibleMigrationHistory(client, bundledMigrations);
  client.pragma(`user_version = ${latestSchemaVersion}`);
}
