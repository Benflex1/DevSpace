import assert from "node:assert/strict";
import test from "node:test";
import { validateRenderedPreviewGatewayCompose } from "../check-preview-gateway-compose-render.mjs";

const expected = {
  uid: "12345",
  gid: "12346",
  ingressPort: "18081"
};

function volumeMount(source, target, options = {}) {
  const mount = {
    type: "volume",
    source,
    target,
    volume: { nocopy: options.nocopy ?? true }
  };
  if (options.readOnly !== undefined) mount.read_only = options.readOnly;
  return mount;
}

function externalVolume(name, options = {}) {
  return {
    external: options.external ?? true,
    name
  };
}

function renderedModel() {
  return {
    name: "preview-gateway",
    services: {
      caddy: {
        user: "12345:12346",
        network_mode: "host",
        restart: "unless-stopped",
        volumes: [volumeMount("gateway-runtime", "/run/devspace/gateway")]
      },
      "preview-gateway-host": {
        user: "12345:12346",
        network_mode: "host",
        restart: "unless-stopped",
        volumes: [volumeMount("gateway-runtime", "/run/devspace/gateway")]
      },
      "preview-ingress-connector": {
        user: "12345:12346",
        restart: "unless-stopped",
        expose: ["18081"],
        networks: { default: { aliases: ["preview-ingress-connector"] } },
        volumes: [volumeMount("gateway-ingress", "/run/devspace/gateway/ingress", { readOnly: true })]
      }
    },
    volumes: {
      "gateway-runtime": externalVolume("devspace-gateway-runtime"),
      "gateway-ingress": externalVolume("devspace-gateway-ingress")
    }
  };
}

function cloneModel() {
  return structuredClone(renderedModel());
}

test("accepts the valid rendered external-volume Compose model", () => {
  assert.equal(validateRenderedPreviewGatewayCompose(renderedModel(), expected), true);
});

test("rejects service-level interpolation and absolute volume sources", () => {
  const interpolated = cloneModel();
  interpolated.services.caddy.volumes[0].source = "${DEVSPACE_GATEWAY_HOST_DIR:-gateway-runtime}";
  assert.throws(() => validateRenderedPreviewGatewayCompose(interpolated, expected), /interpolation|stable named-volume/u);

  const absolute = cloneModel();
  absolute.services.caddy.volumes[0].source = "/srv/devspace/gateway";
  assert.throws(() => validateRenderedPreviewGatewayCompose(absolute, expected), /absolute|stable named-volume/u);
});

test("rejects runtime and connector volume identity confusion", () => {
  const sameVolume = cloneModel();
  sameVolume.services["preview-ingress-connector"].volumes[0].source = "gateway-runtime";
  assert.throws(() => validateRenderedPreviewGatewayCompose(sameVolume, expected), /gateway-ingress/u);

  const parentTarget = cloneModel();
  parentTarget.services["preview-ingress-connector"].volumes[0].target = "/run/devspace/gateway";
  assert.throws(() => validateRenderedPreviewGatewayCompose(parentTarget, expected), /target|parent runtime/u);
});

test("rejects a connector mount that is not read-only", () => {
  const model = cloneModel();
  model.services["preview-ingress-connector"].volumes[0].read_only = false;
  assert.throws(() => validateRenderedPreviewGatewayCompose(model, expected), /read-only/u);
});

test("rejects a read-only shared runtime mount", () => {
  const model = cloneModel();
  model.services.caddy.volumes[0].read_only = true;
  assert.throws(() => validateRenderedPreviewGatewayCompose(model, expected), /runtime volume must remain read-write/u);
});

test("rejects missing or disabled retained nocopy", () => {
  const disabled = cloneModel();
  disabled.services.caddy.volumes[0].volume.nocopy = false;
  assert.throws(() => validateRenderedPreviewGatewayCompose(disabled, expected), /nocopy/u);

  const missingVolumeOptions = cloneModel();
  delete missingVolumeOptions.services.caddy.volumes[0].volume;
  assert.equal(validateRenderedPreviewGatewayCompose(missingVolumeOptions, expected), true);
});

test("accepts Compose-omitted false/default fields", () => {
  const model = cloneModel();
  model.services.caddy.volumes[0].read_only = false;
  delete model.services["preview-ingress-connector"].network_mode;
  assert.equal(validateRenderedPreviewGatewayCompose(model, expected), true);
});

test("rejects a top-level volume that is not external", () => {
  const model = cloneModel();
  model.volumes["gateway-runtime"].external = false;
  assert.throws(() => validateRenderedPreviewGatewayCompose(model, expected), /must remain external/u);
});

test("rejects incorrect rendered external volume names", () => {
  const runtime = cloneModel();
  runtime.volumes["gateway-runtime"].name = "wrong-runtime";
  assert.throws(() => validateRenderedPreviewGatewayCompose(runtime, expected), /gateway-runtime external name/u);

  const ingress = cloneModel();
  ingress.volumes["gateway-ingress"].name = "wrong-ingress";
  assert.throws(() => validateRenderedPreviewGatewayCompose(ingress, expected), /gateway-ingress external name/u);
});

test("rejects malformed rendered external-volume definitions", () => {
  for (const mutation of [
    (volume) => { delete volume.external; },
    (volume) => { volume.driver = "local"; },
    (volume) => { volume.driver_opts = { type: "none", o: "bind", device: "/srv/devspace/gateway" }; },
    (volume) => { volume.device = "/srv/devspace/gateway"; },
    (volume) => { volume.name = "${DEVSPACE_GATEWAY_VOLUME:-devspace-gateway-runtime}"; }
  ]) {
    const model = cloneModel();
    mutation(model.volumes["gateway-runtime"]);
    assert.throws(() => validateRenderedPreviewGatewayCompose(model, expected), /external|driver|device|host path|interpolation/u);
  }
});

test("rejects Docker socket and sensitive extra mounts", () => {
  const socket = cloneModel();
  socket.services.caddy.volumes.push(volumeMount("gateway-runtime", "/var/run/docker.sock"));
  assert.throws(() => validateRenderedPreviewGatewayCompose(socket, expected), /exactly one gateway volume mount|Docker socket/u);

  const sensitiveVolume = cloneModel();
  sensitiveVolume.volumes["gateway-runtime"].device = "/etc/shadow";
  assert.throws(() => validateRenderedPreviewGatewayCompose(sensitiveVolume, expected), /driver|device|host path/u);
});

test("rejects unexpected top-level volumes", () => {
  const model = cloneModel();
  model.volumes.extra = externalVolume("devspace-unexpected");
  assert.throws(() => validateRenderedPreviewGatewayCompose(model, expected), /only the runtime and ingress/u);
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
