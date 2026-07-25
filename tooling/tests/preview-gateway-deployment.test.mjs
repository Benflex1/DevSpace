import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { validatePreviewGatewayDeployment } from "../check-preview-gateway-deployment.mjs";

async function assertComposeMutationRejected(mutate, message) {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-deployment-test-"));
  try {
    await cp(path.resolve("deploy/preview-gateway"), path.join(root, "deploy/preview-gateway"), { recursive: true });
    const composePath = path.join(root, "deploy/preview-gateway/compose.yaml");
    const compose = await readFile(composePath, "utf8");
    await writeFile(composePath, mutate(compose));
    await assert.rejects(() => validatePreviewGatewayDeployment(root), message);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("preview gateway deployment artifacts satisfy the repository contract", async () => {
  assert.equal(await validatePreviewGatewayDeployment(), true);
});

test("preview gateway deployment requires create_host_path false on every bind", async () => {
  await assertComposeMutationRejected(
    (compose) => compose.replace("create_host_path: false", "create_host_path: true"),
    /create_host_path: false/u
  );
});

test("preview gateway deployment keeps the connector on the ingress-only read-only mount", async () => {
  await assertComposeMutationRejected(
    (compose) => compose.replace(
      "source: ${DEVSPACE_GATEWAY_HOST_DIR:-/srv/devspace/gateway}/ingress",
      "source: ${DEVSPACE_GATEWAY_HOST_DIR:-/srv/devspace/gateway}"
    ),
    /Connector bind source must append \/ingress|mount only the ingress directory/u
  );
  await assertComposeMutationRejected(
    (compose) => compose.replace("read_only: true", "read_only: false"),
    /must be read-only/u
  );
});

test("preview gateway deployment requires the portable host source contract", async () => {
  await assertComposeMutationRejected(
    (compose) => compose.replace("source: ${DEVSPACE_GATEWAY_HOST_DIR:-/srv/devspace/gateway}", "source: /srv/devspace/gateway"),
    /configurable gateway host root|DEVSPACE_GATEWAY_HOST_DIR/u
  );
});

test("preview gateway deployment keeps host-network and restart invariants", async () => {
  await assertComposeMutationRejected(
    (compose) => compose.replace("network_mode: host", "network_mode: bridge"),
    /must use host networking/u
  );
  await assertComposeMutationRejected(
    (compose) => compose.replace("restart: unless-stopped", "restart: always"),
    /unless-stopped restart policy/u
  );
  await assertComposeMutationRejected(
    (compose) => compose.replace("expose:", "ports:"),
    /must not publish host ports/u
  );
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
