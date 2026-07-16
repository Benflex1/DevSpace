# @devspace/database

SQLite schema definitions, committed forward migrations, and narrow migration mechanics. The web
application owns repositories, application transactions, connection paths, and runtime SQLite
writes; the Agent must not depend on this package.

The public API exports the 13 Drizzle tables as `schema`, individual table definitions, inferred
select/insert row types, migration version metadata, and `migrateDatabase`. The migrator accepts an
explicit `better-sqlite3` connection, enables foreign keys for that connection, rejects a
`PRAGMA user_version` newer than this application supports, and applies the committed Drizzle
migrations. The persisted Drizzle migration history is the authoritative exact compatibility
signal: its timestamps and SQL hashes must be a prefix of the migrations mechanically read from
the bundled journal and SQL artifacts. `user_version` remains an additional coarse marker because
Drizzle commits its supported migration transaction before the caller can advance that pragma.
Consequently, a crash between those commits leaves a stale marker but cannot make an older binary
accept newer or unknown migration history. The helper does not open an implicit or production
database path.

## Migration workflow

- `pnpm db:generate <lowercase_migration_name>` intentionally creates a forward migration with a
  deterministic sequence/name. Review generated SQL and metadata before keeping it.
- `pnpm db:check` is read-only with respect to tracked files. It checks migration-history
  consistency, regenerates against a temporary copy to detect schema drift, and verifies the
  initial migration remains reproducible.
- `pnpm db:migrate:test` applies the committed migrations to isolated temporary SQLite files and
  exercises fresh, already-current, newer-version refusal, metadata, and constraint behavior.

Migration SQL and Drizzle snapshots under `src/migrations` are committed release artifacts and are
copied into `dist` by the package build. Migrations are forward-only. Backup-before-destructive-
migration remains a future Web deployment responsibility; the initial migration is non-destructive.
