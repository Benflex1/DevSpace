import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expectedPackages } from "../workspace-graph.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const checker = path.join(repositoryRoot, "tooling/check-workspace-graph.mjs");

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-graph-"));
  for (const [directory, definition] of expectedPackages) {
    await mkdir(path.join(root, directory), { recursive: true });
    const dependencies = Object.fromEntries(definition.dependencies.map((name) => [name, "workspace:*"]));
    await writeFile(path.join(root, directory, "package.json"), `${JSON.stringify({
      name: definition.name,
      private: true,
      type: "module",
      ...(definition.kind === "library" ? {
        exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
        types: "./dist/index.d.ts",
        files: ["dist"]
      } : {}),
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {})
    }, null, 2)}\n`);
  }
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [checker, "--root", root], { encoding: "utf8" });
}

async function addDependency(root, directory, dependency) {
  const manifestPath = path.join(root, directory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies = { ...manifest.dependencies, [dependency]: "workspace:*" };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("accepted security -> domain and contracts -> domain edges pass", async () => {
  const root = await fixture();
  try {
    assert.equal(run(root).status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [directory, dependency] of [
  ["packages/contracts", "@devspace/security"],
  ["packages/contracts", "@devspace/project-options"],
  ["packages/contracts", "@devspace/database"],
  ["packages/security", "@devspace/project-options"]
] ) {
  test(`rejects unrelated edge ${directory} -> ${dependency}`, async () => {
    const root = await fixture();
    try {
      await addDependency(root, directory, dependency);
      const result = run(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /prohibited internal dependency/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
