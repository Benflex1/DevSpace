import assert from "node:assert/strict";
import test from "node:test";
import { validateRenderedPreviewGatewayCompose } from "../check-preview-gateway-compose-render.mjs";

const expected = {
  hostDir: "/tmp/devspace-gateway-compose-contract",
  uid: "12345",
  gid: "12346",
  ingressPort: "18081"
};

function bindMount(source, target, options = {}) {
  const mount = {
    type: "bind",
    source,
    target,
    read_only: options.readOnly ?? false
  };
  if (options.createHostPath !== undefined) mount.bind = { create_host_path: options.createHostPath };
  return mount;
}

function renderedModel() {
  return {
    name: "preview-gateway",
    services: {
      caddy: {
        user: "12345:12346",
        network_mode: "host",
        restart: "unless-stopped",
        volumes: [bindMount(expected.hostDir, "/run/devspace/gateway")]
      },
      "preview-gateway-host": {
        user: "12345:12346",
        network_mode: "host",
        restart: "unless-stopped",
        volumes: [bindMount(expected.hostDir, "/run/devspace/gateway")]
      },
      "preview-ingress-connector": {
        user: "12345:12346",
        restart: "unless-stopped",
        expose: ["18081"],
        networks: { default: { aliases: ["preview-ingress-connector"] } },
        volumes: [bindMount(`${expected.hostDir}/ingress`, "/run/devspace/gateway/ingress", { readOnly: true })]
      }
    }
  };
}

function cloneModel() {
  return structuredClone(renderedModel());
}

test("accepts the valid rendered Compose model", () => {
  assert.equal(validateRenderedPreviewGatewayCompose(renderedModel(), expected), true);
});

test("rejects an incorrect gateway root source", () => {
  const model = cloneModel();
  model.services.caddy.volumes[0].source = "/srv/devspace/gateway";
  assert.throws(() => validateRenderedPreviewGatewayCompose(model, expected), /bind source/u);
});

test("rejects a connector source without /ingress", () => {
  const model = cloneModel();
  model.services["preview-ingress-connector"].volumes[0].source = expected.hostDir;
  assert.throws(() => validateRenderedPreviewGatewayCompose(model, expected), /bind source/u);
});

test("rejects a connector mount that is not read-only", () => {
  const model = cloneModel();
  model.services["preview-ingress-connector"].volumes[0].read_only = false;
  assert.throws(() => validateRenderedPreviewGatewayCompose(model, expected), /read-only/u);
});

test("accepts an explicit create_host_path false", () => {
  const model = cloneModel();
  model.services.caddy.volumes[0].bind = { create_host_path: false };
  assert.equal(validateRenderedPreviewGatewayCompose(model, expected), true);
});

test("rejects enabled or malformed create_host_path values", () => {
  for (const value of [true, "false", "true", 0, 1, null, [], {}]) {
    const model = cloneModel();
    model.services.caddy.volumes[0].bind = { create_host_path: value };
    assert.throws(
      () => validateRenderedPreviewGatewayCompose(model, expected),
      /must not enable automatic host-path creation/u,
      `create_host_path=${JSON.stringify(value)} should be rejected`
    );
  }
});

test("rejects host networking on the connector", () => {
  const model = cloneModel();
  model.services["preview-ingress-connector"].network_mode = "host";
  assert.throws(() => validateRenderedPreviewGatewayCompose(model, expected), /must not use host networking/u);
});

test("rejects a published host port", () => {
  const model = cloneModel();
  model.services["preview-ingress-connector"].ports = [{ target: 18081, published: 18081 }];
  assert.throws(() => validateRenderedPreviewGatewayCompose(model, expected), /publish host ports/u);
});

test("rejects a Docker socket mount", () => {
  const model = cloneModel();
  model.services.caddy.volumes.push(bindMount("/var/run/docker.sock", "/var/run/docker.sock"));
  assert.throws(() => validateRenderedPreviewGatewayCompose(model, expected), /exactly one gateway bind mount|Docker socket/u);
});

test("rejects an incorrect rendered UID/GID", () => {
  const model = cloneModel();
  model.services["preview-gateway-host"].user = "1000:1000";
  assert.throws(() => validateRenderedPreviewGatewayCompose(model, expected), /user must be 12345:12346/u);
});

test("rejects an incorrect rendered internal ingress port", () => {
  const model = cloneModel();
  model.services["preview-ingress-connector"].expose = ["8080"];
  assert.throws(() => validateRenderedPreviewGatewayCompose(model, expected), /internal port must be 18081/u);
});
