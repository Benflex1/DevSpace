import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function readManifest(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));
}

test("local development scripts resolve Agent from the workspace and prepare dependencies first", async () => {
  const [root, agent, web] = await Promise.all([
    readManifest("package.json"),
    readManifest("apps/agent/package.json"),
    readManifest("apps/web/package.json")
  ]);

  assert.match(agent.scripts.dev, /^pnpm run build:helper && pnpm --dir \.\.\/\.\. exec tsx apps\/agent\/src\/cli\.ts$/u);
  assert.equal(root.scripts["dev:prepare"], "pnpm --filter @devspace/web run prepare:deps");
  assert.match(web.scripts["prepare:deps"], /@devspace\/gateway-caddy build/u);
  assert.match(root.scripts.dev, /pnpm run dev:prepare &&/u);
  assert.match(root.scripts["dev:web"], /pnpm run dev:prepare &&/u);
  assert.match(root.scripts["dev:agent"], /pnpm run dev:prepare &&/u);
  assert.match(root.scripts.dev, /DEVSPACE_DEPS_PREPARED=1/u);
  assert.match(root.scripts["dev:web"], /DEVSPACE_DEPS_PREPARED=1/u);
  assert.match(web.scripts.predev, /DEVSPACE_DEPS_PREPARED/u);
});
