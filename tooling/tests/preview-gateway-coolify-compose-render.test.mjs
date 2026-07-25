import assert from "node:assert/strict";
import test from "node:test";
import { validateRenderedCoolifyPreviewGatewayCompose } from "../check-preview-gateway-coolify-compose-render.mjs";

const expected = {
  uid: "12345",
  gid: "12346",
  ingressPort: "18081"
};
const proxyNetwork = "temporary-ci-proxy-network";

function volumeMount(source, target, readOnly = false) {
  return {
    type: "volume",
    source,
    target,
    read_only: readOnly,
    volume: { nocopy: true }
  };
}

function renderedModel() {
  return {
    services: {
      caddy: {
        command: ["caddy", "run", "--config", "/etc/caddy/caddy.json"],
        user: "12345:12346",
        network_mode: "host",
        restart: "unless-stopped",
        volumes: [volumeMount("gateway-runtime", "/run/devspace/gateway")]
      },
      "preview-gateway-host": {
        environment: {
          DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET: "/run/devspace/gateway/lease-resolver.sock",
          DEVSPACE_PREVIEW_PROBE_SOCKET: "/run/devspace/gateway/preview-probe.sock",
          NODE_ENV: "production"
        },
        user: "12345:12346",
        network_mode: "host",
        restart: "unless-stopped",
        volumes: [volumeMount("gateway-runtime", "/run/devspace/gateway")]
      },
      "preview-ingress-connector": {
        command: ["node", "dist/connector-index.js"],
        environment: {
          DEVSPACE_PREVIEW_HTTP_SOCKET: "/run/devspace/gateway/ingress/preview-http.sock",
          DEVSPACE_PREVIEW_INGRESS_PORT: "18081",
          NODE_ENV: "production"
        },
        user: "12345:12346",
        restart: "unless-stopped",
        expose: ["18081"],
        networks: {
          "coolify-proxy": {
            aliases: ["preview-ingress-connector", "devspace-preview-ingress"]
          }
        },
        volumes: [volumeMount("gateway-ingress", "/run/devspace/gateway/ingress", true)]
      }
    },
    networks: {
      "coolify-proxy": {
        external: true,
        name: proxyNetwork
      }
    },
    volumes: {
      "gateway-runtime": {
        external: true,
        name: "devspace-gateway-runtime"
      },
      "gateway-ingress": {
        external: true,
        name: "devspace-gateway-ingress"
      }
    }
  };
}

test("accepts the rendered Coolify single-network adapter topology", () => {
  assert.equal(
    validateRenderedCoolifyPreviewGatewayCompose(renderedModel(), expected, proxyNetwork),
    true
  );
});

test("accepts Docker Compose v2.38.2 empty IPAM normalization", () => {
  const model = renderedModel();
  model.networks["coolify-proxy"].ipam = {};
  assert.equal(
    validateRenderedCoolifyPreviewGatewayCompose(model, expected, proxyNetwork),
    true
  );
});

test("requires the exact supplied external proxy network", () => {
  const wrongName = renderedModel();
  wrongName.networks["coolify-proxy"].name = "another-network";
  assert.throws(
    () => validateRenderedCoolifyPreviewGatewayCompose(wrongName, expected, proxyNetwork),
    /name must be exactly temporary-ci-proxy-network/u
  );

  const managed = renderedModel();
  managed.networks["coolify-proxy"].external = false;
  assert.throws(
    () => validateRenderedCoolifyPreviewGatewayCompose(managed, expected, proxyNetwork),
    /must remain external/u
  );

  const configuredIpam = renderedModel();
  configuredIpam.networks["coolify-proxy"].ipam = {
    config: [{ subnet: "192.0.2.0/24" }]
  };
  assert.throws(
    () => validateRenderedCoolifyPreviewGatewayCompose(configuredIpam, expected, proxyNetwork),
    /must not define IPAM configuration/u
  );

  const driver = renderedModel();
  driver.networks["coolify-proxy"].driver = "bridge";
  assert.throws(
    () => validateRenderedCoolifyPreviewGatewayCompose(driver, expected, proxyNetwork),
    /may contain only external, name/u
  );
});

test("attaches only the connector to the proxy network", () => {
  for (const serviceName of ["caddy", "preview-gateway-host"]) {
    const model = renderedModel();
    model.services[serviceName].networks = { "coolify-proxy": {} };
    assert.throws(
      () => validateRenderedCoolifyPreviewGatewayCompose(model, expected, proxyNetwork),
      /must not attach/u
    );
  }

  const extra = renderedModel();
  extra.services["preview-ingress-connector"].networks.default = {};
  assert.throws(
    () => validateRenderedCoolifyPreviewGatewayCompose(extra, expected, proxyNetwork),
    /exactly the Coolify proxy network/u
  );
});

test("requires the stable connector alias", () => {
  const model = renderedModel();
  model.services["preview-ingress-connector"].networks["coolify-proxy"].aliases = [
    "preview-ingress-connector"
  ];
  assert.throws(
    () => validateRenderedCoolifyPreviewGatewayCompose(model, expected, proxyNetwork),
    /stable devspace-preview-ingress alias/u
  );
});

test("requires a non-empty expected network during validation", () => {
  assert.throws(
    () => validateRenderedCoolifyPreviewGatewayCompose(renderedModel(), expected, ""),
    /expected proxy network must be non-empty/u
  );
});
