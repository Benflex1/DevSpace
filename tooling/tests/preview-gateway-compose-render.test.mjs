import assert from "node:assert/strict";
import test from "node:test";
import { validateRenderedPreviewGatewayCompose } from "../check-preview-gateway-compose-render.mjs";

const expected = {
  hostDir: "/tmp/devspace-gateway-compose-contract",
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

function localBindVolume(device, options = {}) {
  return {
    driver: options.driver ?? "local",
    driver_opts: options.driverOpts ?? { type: "none", o: "bind", device }
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
      "gateway-runtime": localBindVolume(expected.hostDir),
      "gateway-ingress": localBindVolume(`${expected.hostDir}/ingress`)
    }
  };
}

function cloneModel() {
  return structuredClone(renderedModel());
}

test("accepts the valid rendered named-bind Compose model", () => {
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

test("rejects a non-local top-level volume driver", () => {
  const model = cloneModel();
  model.volumes["gateway-runtime"].driver = "nfs";
  assert.throws(() => validateRenderedPreviewGatewayCompose(model, expected), /local volume driver/u);
});

test("rejects a top-level volume without bind mode", () => {
  const model = cloneModel();
  delete model.volumes["gateway-runtime"].driver_opts.o;
  assert.throws(() => validateRenderedPreviewGatewayCompose(model, expected), /driver_opts\.o/u);
});

test("rejects incorrect rendered runtime and ingress devices", () => {
  const runtime = cloneModel();
  runtime.volumes["gateway-runtime"].driver_opts.device = "/tmp/wrong";
  assert.throws(() => validateRenderedPreviewGatewayCompose(runtime, expected), /gateway-runtime device/u);

  const ingress = cloneModel();
  ingress.volumes["gateway-ingress"].driver_opts.device = expected.hostDir;
  assert.throws(() => validateRenderedPreviewGatewayCompose(ingress, expected), /gateway-ingress device/u);
});

test("rejects malformed rendered driver options", () => {
  for (const driverOpts of [null, { type: "bind", o: "bind", device: expected.hostDir }, { type: "none", o: ["bind"], device: expected.hostDir }]) {
    const model = cloneModel();
    model.volumes["gateway-runtime"].driver_opts = driverOpts;
    assert.throws(() => validateRenderedPreviewGatewayCompose(model, expected), /driver_opts|must be none|must be bind/u);
  }
});

test("rejects Docker socket and sensitive extra mounts", () => {
  const socket = cloneModel();
  socket.services.caddy.volumes.push(volumeMount("gateway-runtime", "/var/run/docker.sock"));
  assert.throws(() => validateRenderedPreviewGatewayCompose(socket, expected), /exactly one gateway volume mount|Docker socket/u);

  const sensitiveVolume = cloneModel();
  sensitiveVolume.volumes["gateway-runtime"].driver_opts.device = "/etc/shadow";
  assert.throws(() => validateRenderedPreviewGatewayCompose(sensitiveVolume, expected), /sensitive host path|device/u);
});

test("rejects unexpected top-level volumes", () => {
  const model = cloneModel();
  model.volumes.extra = localBindVolume("/var/lib/docker");
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
