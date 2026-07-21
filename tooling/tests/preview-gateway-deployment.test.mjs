import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { validatePreviewGatewayDeployment } from "../check-preview-gateway-deployment.mjs";

test("preview gateway deployment artifacts satisfy the repository contract", async () => {
  assert.equal(await validatePreviewGatewayDeployment(), true);
});

test("preview gateway deployment rejects the native JSON adapter form", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-deployment-test-"));
  try {
    await cp(path.resolve("deploy/preview-gateway"), path.join(root, "deploy/preview-gateway"), { recursive: true });
    const composePath = path.join(root, "deploy/preview-gateway/compose.yaml");
    const compose = await readFile(composePath, "utf8");
    await writeFile(composePath, compose.replace(
      'command: ["caddy", "run", "--config", "/etc/caddy/caddy.json"]',
      'command: ["caddy", "run", "--config", "/etc/caddy/caddy.json", "--adapter", "json"]'
    ));
    await assert.rejects(() => validatePreviewGatewayDeployment(root), /json adapter/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preview gateway deployment requires the caddy executable in the Compose command", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-deployment-test-"));
  try {
    await cp(path.resolve("deploy/preview-gateway"), path.join(root, "deploy/preview-gateway"), { recursive: true });
    const composePath = path.join(root, "deploy/preview-gateway/compose.yaml");
    const compose = await readFile(composePath, "utf8");
    await writeFile(composePath, compose.replace(
      'command: ["caddy", "run", "--config", "/etc/caddy/caddy.json"]',
      'command: ["run", "--config", "/etc/caddy/caddy.json"]'
    ));
    await assert.rejects(() => validatePreviewGatewayDeployment(root), /caddy executable/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preview gateway deployment requires a self-contained Caddy image", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-deployment-test-"));
  try {
    await cp(path.resolve("deploy/preview-gateway"), path.join(root, "deploy/preview-gateway"), { recursive: true });
    const composePath = path.join(root, "deploy/preview-gateway/compose.yaml");
    const compose = await readFile(composePath, "utf8");
    await writeFile(composePath, compose.replace(
      "dockerfile: deploy/preview-gateway/Caddy.Dockerfile",
      "image: caddy:2.11.3"
    ));
    await assert.rejects(() => validatePreviewGatewayDeployment(root), /self-contained deployment image/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preview gateway deployment rejects a repository-relative Caddy config bind", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-deployment-test-"));
  try {
    await cp(path.resolve("deploy/preview-gateway"), path.join(root, "deploy/preview-gateway"), { recursive: true });
    const composePath = path.join(root, "deploy/preview-gateway/compose.yaml");
    const compose = await readFile(composePath, "utf8");
    const configBind = [
      "      - type: bind",
      "        source: ./caddy.json",
      "        target: /etc/caddy/caddy.json",
      "        read_only: true",
      "        bind:",
      "          create_host_path: false",
      ""
    ].join("\n");
    await writeFile(composePath, compose.replace("    volumes:\n", `    volumes:\n${configBind}`));
    await assert.rejects(() => validatePreviewGatewayDeployment(root), /repository-relative caddy.json bind/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preview gateway deployment requires legacy pnpm deploy mode", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-deployment-test-"));
  try {
    await cp(path.resolve("deploy/preview-gateway"), path.join(root, "deploy/preview-gateway"), { recursive: true });
    const dockerfilePath = path.join(root, "deploy/preview-gateway/Dockerfile");
    const dockerfile = await readFile(dockerfilePath, "utf8");
    await writeFile(dockerfilePath, dockerfile.replace("--prod --legacy /runtime", "--prod /runtime"));
    await assert.rejects(() => validatePreviewGatewayDeployment(root), /legacy deploy mode/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
