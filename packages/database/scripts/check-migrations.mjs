import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const drizzleKit = fileURLToPath(new URL("../node_modules/.bin/drizzle-kit", import.meta.url));
const committedDirectory = join(packageDirectory, "src", "migrations");

function runDrizzleKit(arguments_, options = {}) {
  const result = spawnSync(drizzleKit, arguments_, {
    cwd: packageDirectory,
    encoding: "utf8",
    ...options
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `drizzle-kit ${arguments_.join(" ")} failed:\n${result.stdout}${result.stderr}`
    );
  }
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "devspace-drizzle-check-"));
try {
  runDrizzleKit(["check", "--config", "drizzle.config.mjs"]);

  const copiedHistoryDirectory = join(temporaryDirectory, "history");
  await cp(committedDirectory, copiedHistoryDirectory, { recursive: true });
  const filesBefore = (await readdir(copiedHistoryDirectory, { recursive: true })).sort();
  runDrizzleKit(
    ["generate", "--config", "drizzle.config.mjs", "--name", "drift_check"],
    { env: { ...process.env, DEVSPACE_DRIZZLE_OUT: copiedHistoryDirectory } }
  );
  const filesAfter = (await readdir(copiedHistoryDirectory, { recursive: true })).sort();
  if (JSON.stringify(filesAfter) !== JSON.stringify(filesBefore)) {
    throw new Error(
      "The Drizzle schema has changes not represented by the committed forward migration history."
    );
  }

  const baselineDirectory = join(temporaryDirectory, "baseline");
  runDrizzleKit(
    ["generate", "--config", "drizzle.config.mjs", "--name", "initial"],
    { env: { ...process.env, DEVSPACE_DRIZZLE_OUT: baselineDirectory } }
  );

  const committedJournal = JSON.parse(
    await readFile(join(committedDirectory, "meta", "_journal.json"), "utf8")
  );
  if (
    committedJournal?.dialect !== "sqlite"
    || !Array.isArray(committedJournal.entries)
    || committedJournal.entries.length === 0
    || committedJournal.entries[0]?.tag !== "0000_initial"
    || committedJournal.entries.some((entry, index) => entry?.idx !== index)
  ) {
    throw new Error("The migration journal is missing or has nondeterministic ordering metadata.");
  }

  if (committedJournal.entries.length === 1) {
    const [committedSql, regeneratedSql] = await Promise.all([
      readFile(join(committedDirectory, "0000_initial.sql"), "utf8"),
      readFile(join(baselineDirectory, "0000_initial.sql"), "utf8")
    ]);
    if (committedSql !== regeneratedSql) {
      throw new Error(
        "Drizzle schema and committed initial migration differ. "
        + "Generate and review a forward migration instead of rewriting migration history."
      );
    }
  }

  console.log("Migration history is consistent and the committed initial SQL matches the Drizzle schema.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
