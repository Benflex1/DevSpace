import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateRenderedCoolifyPreviewGatewayCompose } from "./check-preview-gateway-coolify-compose-render.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceCompose = path.join(repositoryRoot, "deploy/preview-gateway/compose.coolify.yaml");
const selectedFileName = "docker-compose.yaml";
const proxyNetwork = "devspace-materialization-test-proxy";
const expected = {
  uid: "12345",
  gid: "12346",
  ingressPort: "18081"
};

function composeEnvironment() {
  const environment = {
    ...process.env,
    COOLIFY_BRANCH: "main",
    COOLIFY_RESOURCE_UUID: "materialization-test"
  };
  delete environment.DEVSPACE_COOLIFY_PROXY_NETWORK;
  delete environment.DEVSPACE_GATEWAY_UID;
  delete environment.DEVSPACE_GATEWAY_GID;
  delete environment.DEVSPACE_PREVIEW_INGRESS_PORT;
  return environment;
}

function renderCompose(materializationDirectory, environmentFile) {
  return spawnSync("docker", [
    "compose",
    "--env-file", environmentFile,
    "--project-directory", materializationDirectory,
    "-f", path.join(materializationDirectory, selectedFileName),
    "config",
    "--format", "json"
  ], {
    cwd: materializationDirectory,
    encoding: "utf8",
    env: composeEnvironment()
  });
}

function requireComposeCommand(result) {
  if (result.error?.code === "ENOENT") {
    throw new Error("Coolify single-file materialization regression requires Docker Compose.");
  }
  if (result.error !== undefined) throw result.error;
}

async function main() {
  const materializationDirectory = await mkdtemp(
    path.join(os.tmpdir(), "devspace-coolify-materialized-")
  );
  const selectedCompose = path.join(materializationDirectory, selectedFileName);
  const environmentFile = path.join(materializationDirectory, ".env");
  try {
    await copyFile(sourceCompose, selectedCompose);
    assert.deepEqual(
      await readdir(materializationDirectory),
      [selectedFileName],
      "the materialization directory must initially contain only the arbitrarily named selected artifact"
    );
    const selectedSource = await readFile(selectedCompose, "utf8");
    assert.doesNotMatch(
      selectedSource,
      /(?:^|\n)\s*(?:include|extends):/u,
      "the selected artifact must not depend on another Compose file"
    );

    await writeFile(environmentFile, [
      `DEVSPACE_COOLIFY_PROXY_NETWORK=${proxyNetwork}`,
      `DEVSPACE_GATEWAY_UID=${expected.uid}`,
      `DEVSPACE_GATEWAY_GID=${expected.gid}`,
      `DEVSPACE_PREVIEW_INGRESS_PORT=${expected.ingressPort}`,
      ""
    ].join("\n"));
    assert.deepEqual(
      (await readdir(materializationDirectory)).sort(),
      [".env", selectedFileName],
      "no repository deployment sibling may be copied beside the selected artifact"
    );
    const rendered = renderCompose(materializationDirectory, environmentFile);
    requireComposeCommand(rendered);
    assert.equal(rendered.status, 0, `single-file Compose render failed: ${rendered.stderr.trim()}`);
    const model = JSON.parse(rendered.stdout);
    assert.equal(
      validateRenderedCoolifyPreviewGatewayCompose(model, expected, proxyNetwork),
      true
    );

    await writeFile(environmentFile, [
      `DEVSPACE_GATEWAY_UID=${expected.uid}`,
      `DEVSPACE_GATEWAY_GID=${expected.gid}`,
      `DEVSPACE_PREVIEW_INGRESS_PORT=${expected.ingressPort}`,
      ""
    ].join("\n"));
    const unset = renderCompose(materializationDirectory, environmentFile);
    requireComposeCommand(unset);
    assert.notEqual(unset.status, 0, "an unset proxy network must fail closed");

    await writeFile(environmentFile, [
      "DEVSPACE_COOLIFY_PROXY_NETWORK=",
      `DEVSPACE_GATEWAY_UID=${expected.uid}`,
      `DEVSPACE_GATEWAY_GID=${expected.gid}`,
      `DEVSPACE_PREVIEW_INGRESS_PORT=${expected.ingressPort}`,
      ""
    ].join("\n"));
    const empty = renderCompose(materializationDirectory, environmentFile);
    requireComposeCommand(empty);
    assert.notEqual(empty.status, 0, "an empty proxy network must fail closed");

    console.log(
      "Coolify single-file materialization regression passed " +
      "(arbitrary directory/name, explicit env file/project directory/file, full topology, unset/empty fail closed)"
    );
  } finally {
    await rm(materializationDirectory, { recursive: true, force: true });
  }
}

await main();
