import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDirectory = fileURLToPath(new URL("..", import.meta.url));
const artifactPath = path.join(rootDirectory, "schemas/project-options-v1.schema.json");
const packageEntry = pathToFileURL(
  path.join(rootDirectory, "packages/project-options/dist/index.js")
).href;
const { generateProjectOptionsV1JsonSchema } = await import(packageEntry);
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "devspace-project-options-schema-"));
const generatedPath = path.join(temporaryDirectory, "project-options-v1.schema.json");

try {
  const generated = `${JSON.stringify(generateProjectOptionsV1JsonSchema(), null, 2)}\n`;
  await writeFile(generatedPath, generated, "utf8");
  if (process.argv.includes("--write")) {
    await writeFile(artifactPath, generated, "utf8");
    console.log(`generated schema: ${path.relative(rootDirectory, artifactPath)}`);
  } else {
    const committed = await readFile(artifactPath, "utf8");
    if (generated !== committed) {
      throw new Error(
        "Project Options JSON Schema is stale; regenerate schemas/project-options-v1.schema.json from the Zod source"
      );
    }
    console.log(`generated schema is current: ${path.relative(rootDirectory, artifactPath)}`);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
