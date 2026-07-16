import { readdir } from "node:fs/promises";
import { join } from "node:path";

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".cache",
  "coverage",
  "dist"
]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;

    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(filePath));
    else files.push(filePath);
  }

  return files;
}

const forbiddenConfigFiles = (await walk(".")).filter((filePath) => {
  const basename = filePath.split("/").at(-1);
  return basename === ".devspace.yml" || basename === ".devspace.yaml";
});

if (forbiddenConfigFiles.length > 0) {
  throw new Error(
    "Repository YAML configuration is prohibited: " + forbiddenConfigFiles.join(", ")
  );
}

console.log("architecture boundary checks passed");
