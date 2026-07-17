import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("development scripts preserve an explicit app origin and default to localhost", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  for (const name of ["dev", "dev:web"]) {
    assert.match(packageJson.scripts[name], /DEVSPACE_APP_ORIGIN=\$\{DEVSPACE_APP_ORIGIN:-http:\/\/localhost:3000\}/u);
  }
  const nextConfig = await readFile(new URL("../../apps/web/next.config.ts", import.meta.url), "utf8");
  assert.match(nextConfig, /DEVSPACE_ALLOWED_DEV_ORIGINS/u);
  assert.match(nextConfig, /new URL\(appOrigin\)\.hostname/u);
  assert.doesNotMatch(nextConfig, /10\.0\.6\.2/u);
});
