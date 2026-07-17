import { writeFile } from "node:fs/promises";
import { openProjectDatabase } from "../apps/web/src/server/database.js";

const [databasePath, repositoryUrl, metadataPath] = process.argv.slice(2);
if (databasePath === undefined || repositoryUrl === undefined || metadataPath === undefined) throw new Error("seed arguments are required");
const database = openProjectDatabase(databasePath);
const project = database.createProject({
  name: "Managed Fixture", slug: "managed-fixture", repositoryUrl, defaultBranch: "main", actor: "e2e@example.invalid"
});
database.close();
await writeFile(metadataPath, `${JSON.stringify({ projectId: project.id, repositoryUrl })}\n`, { mode: 0o600 });
