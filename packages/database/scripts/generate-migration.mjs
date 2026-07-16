import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const migrationName = process.argv.slice(2).find((argument) => argument !== "--");
if (migrationName === undefined || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(migrationName)) {
  console.error("Usage: pnpm db:generate <lowercase_migration_name>");
  process.exitCode = 1;
} else {
  const drizzleKit = fileURLToPath(new URL("../node_modules/.bin/drizzle-kit", import.meta.url));
  const result = spawnSync(
    drizzleKit,
    ["generate", "--config", "drizzle.config.mjs", "--name", migrationName],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "inherit" }
  );
  if (result.error !== undefined) throw result.error;
  process.exitCode = result.status ?? 1;
}
