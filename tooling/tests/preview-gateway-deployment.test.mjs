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

async function assertDeploymentFileMutationRejected(fileName, mutate, message) {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-deployment-test-"));
  try {
    await cp(path.resolve("deploy/preview-gateway"), path.join(root, "deploy/preview-gateway"), { recursive: true });
    const filePath = path.join(root, "deploy/preview-gateway", fileName);
    const source = await readFile(filePath, "utf8");
    await writeFile(filePath, mutate(source));
    await assert.rejects(() => validatePreviewGatewayDeployment(root), message);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("preview gateway deployment accepts the valid external-volume model", async () => {
  assert.equal(await validatePreviewGatewayDeployment(), true);
});

test("generic preview gateway Compose remains provider-neutral", async () => {
  await assertComposeMutationRejected(
    (compose) => `${compose}\n# Coolify proxy integration\n`,
    /provider-neutral/u
  );
});

test("Coolify artifact is generated from the generic contract", async () => {
  await assertComposeMutationRejected(
    (compose) => compose.replace(
      "    restart: unless-stopped\n",
      "    restart: unless-stopped\n    stop_grace_period: 10s\n"
    ),
    /Coolify Compose artifact has drifted/u
  );
});

test("Coolify artifact rejects unapproved local edits", async () => {
  await assertDeploymentFileMutationRejected(
    "compose.coolify.yaml",
    (compose) => compose.replace(
      '    restart: "unless-stopped"\n',
      '    restart: "unless-stopped"\n    privileged: true\n'
    ),
    /drifted from the generic contract/u
  );
});

test("Coolify artifact rejects include and extends dependencies", async () => {
  await assertDeploymentFileMutationRejected(
    "compose.coolify.yaml",
    (compose) => `${compose}include:\n  - compose.yaml\n`,
    /must not use include or extends/u
  );
  await assertDeploymentFileMutationRejected(
    "compose.coolify.yaml",
    (compose) => compose.replace(
      "  caddy:\n",
      "  caddy:\n    extends:\n      file: compose.yaml\n      service: caddy\n"
    ),
    /include or extends/u
  );
});

test("Coolify artifact requires the explicit network expression and stable alias", async () => {
  await assertDeploymentFileMutationRejected(
    "compose.coolify.yaml",
    (compose) => compose.replace(
      "${DEVSPACE_COOLIFY_PROXY_NETWORK:?DEVSPACE_COOLIFY_PROXY_NETWORK must be set and non-empty}",
      "${DEVSPACE_COOLIFY_PROXY_NETWORK:-default}"
    ),
    /drifted from the generic contract/u
  );
  await assertDeploymentFileMutationRejected(
    "compose.coolify.yaml",
    (compose) => compose.replace("devspace-preview-ingress", "generated-resource-name"),
    /drifted from the generic contract/u
  );
});

test("Coolify artifact contains no committed home-server UUID or network name", async () => {
  const compose = await readFile(
    path.resolve("deploy/preview-gateway/compose.coolify.yaml"),
    "utf8"
  );
  assert.doesNotMatch(compose, /[a-z0-9]{24}/u);
  assert.match(
    compose,
    /\$\{DEVSPACE_COOLIFY_PROXY_NETWORK:\?DEVSPACE_COOLIFY_PROXY_NETWORK must be set and non-empty\}/u
  );
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
    (compose) => compose.replace("target: /run/devspace/gateway/ingress", "target: /run/devspace/gateway"),
    /must mount \/run\/devspace\/gateway\/ingress|parent private runtime/u
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

test("preview gateway deployment requires exact external volume definitions", async () => {
  await assertComposeMutationRejected(
    (compose) => compose.replace("external: true", "external: false"),
    /must set external: true/u
  );
  await assertComposeMutationRejected(
    (compose) => compose.replace("    external: true\n", ""),
    /must set external: true/u
  );
  await assertComposeMutationRejected(
    (compose) => compose.replace("name: devspace-gateway-runtime", "name: wrong-runtime"),
    /external name must be exactly devspace-gateway-runtime/u
  );
  await assertComposeMutationRejected(
    (compose) => compose.replace("name: devspace-gateway-ingress", "name: wrong-ingress"),
    /external name must be exactly devspace-gateway-ingress/u
  );
});

test("preview gateway deployment rejects reintroduced local-driver options", async () => {
  await assertComposeMutationRejected(
    (compose) => compose.replace(
      "    name: devspace-gateway-runtime",
      "    name: devspace-gateway-runtime\n    driver: local\n    driver_opts:\n      type: none\n      o: bind\n      device: /srv/devspace/gateway"
    ),
    /driver, driver_opts, or device|host path/u
  );
});

test("preview gateway deployment rejects top-level devices, host paths, and interpolation", async () => {
  await assertComposeMutationRejected(
    (compose) => compose.replace("    name: devspace-gateway-runtime", "    name: devspace-gateway-runtime\n    device: /srv/devspace/gateway"),
    /driver, driver_opts, or device|host path/u
  );
  await assertComposeMutationRejected(
    (compose) => compose.replace("name: devspace-gateway-runtime", "name: ${DEVSPACE_GATEWAY_VOLUME:-devspace-gateway-runtime}"),
    /external name|interpolation/u
  );
  await assertComposeMutationRejected(
    (compose) => compose.replace("name: devspace-gateway-runtime", "name: /srv/devspace/gateway"),
    /external name|host path/u
  );
});

test("preview gateway deployment rejects unexpected top-level volumes", async () => {
  await assertComposeMutationRejected(
    (compose) => `${compose}\n  unexpected:\n    external: true\n    name: devspace-unexpected\n`,
    /only the runtime and ingress gateway volumes/u
  );
});

test("preview gateway deployment rejects Docker socket service mounts", async () => {
  await assertComposeMutationRejected(
    (compose) => compose.replace(
      "    volumes:\n",
      "    volumes:\n      - type: bind\n        source: /var/run/docker.sock\n        target: /var/run/docker.sock\n"
    ),
    /long volume syntax|Docker socket|exactly one gateway volume mount/u
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
