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

test("preview gateway deployment accepts the valid named-bind source model", async () => {
  assert.equal(await validatePreviewGatewayDeployment(), true);
});

test("preview gateway deployment rejects Coolify-incompatible service interpolation", async () => {
  await assertComposeMutationRejected(
    (compose) => compose.replace("source: gateway-runtime", "source: ${DEVSPACE_GATEWAY_HOST_DIR:-gateway-runtime}"),
    /must not contain variable interpolation/u
  );
});

test("preview gateway deployment rejects service-level absolute and relative paths", async () => {
  await assertComposeMutationRejected(
    (compose) => compose.replace("source: gateway-runtime", "source: /srv/devspace/gateway"),
    /must not be an absolute host path/u
  );
  await assertComposeMutationRejected(
    (compose) => compose.replace("source: gateway-runtime", "source: ./gateway"),
    /must not be a relative path/u
  );
});

test("preview gateway deployment keeps runtime and connector volume identities isolated", async () => {
  await assertComposeMutationRejected(
    (compose) => compose.replace("source: gateway-ingress", "source: gateway-runtime"),
    /must mount named volume gateway-ingress/u
  );
  await assertComposeMutationRejected(
    (compose) => compose.replace("source: gateway-ingress", "source: gateway-runtime").replace(
      "device: ${DEVSPACE_GATEWAY_HOST_DIR:-/srv/devspace/gateway}/ingress",
      "device: ${DEVSPACE_GATEWAY_HOST_DIR:-/srv/devspace/gateway}"
    ),
    /must append \/ingress|device must be/u
  );
});

test("preview gateway deployment requires connector read-only isolation", async () => {
  await assertComposeMutationRejected(
    (compose) => compose.replace("read_only: true", "read_only: false"),
    /ingress mount must be read-only/u
  );
});

test("preview gateway deployment keeps the shared runtime mounts read-write", async () => {
  await assertComposeMutationRejected(
    (compose) => compose.replace("target: /run/devspace/gateway\n        volume:", "target: /run/devspace/gateway\n        read_only: true\n        volume:"),
    /runtime mount must remain read-write/u
  );
});

test("preview gateway deployment requires nocopy on every service volume", async () => {
  await assertComposeMutationRejected(
    (compose) => compose.replace("          nocopy: true", "          nocopy: false"),
    /volume\.nocopy: true/u
  );
  await assertComposeMutationRejected(
    (compose) => compose.replace("          nocopy: true\n", ""),
    /volume\.nocopy: true/u
  );
});

test("preview gateway deployment requires local top-level bind volumes", async () => {
  await assertComposeMutationRejected(
    (compose) => compose.replace("driver: local", "driver: nfs"),
    /local volume driver/u
  );
  await assertComposeMutationRejected(
    (compose) => compose.replace("      o: bind\n", ""),
    /driver_opts\.o must be bind/u
  );
  await assertComposeMutationRejected(
    (compose) => compose.replace(
      "device: ${DEVSPACE_GATEWAY_HOST_DIR:-/srv/devspace/gateway}",
      "device: ${DEVSPACE_GATEWAY_HOST_DIR:-/srv/devspace/gateway}/wrong"
    ),
    /device must be \$\{DEVSPACE_GATEWAY_HOST_DIR/u
  );
  await assertComposeMutationRejected(
    (compose) => compose.replace(
      "device: ${DEVSPACE_GATEWAY_HOST_DIR:-/srv/devspace/gateway}/ingress",
      "device: ${DEVSPACE_GATEWAY_HOST_DIR:-/srv/devspace/gateway}"
    ),
    /device must be \$\{DEVSPACE_GATEWAY_HOST_DIR/u
  );
});

test("preview gateway deployment rejects Docker sockets and sensitive top-level paths", async () => {
  await assertComposeMutationRejected(
    (compose) => compose.replace(
      "device: ${DEVSPACE_GATEWAY_HOST_DIR:-/srv/devspace/gateway}",
      "device: /var/run/docker.sock"
    ),
    /sensitive host path|device must be/u
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
