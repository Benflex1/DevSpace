import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { validateRenderedPreviewGatewayCompose } from "./check-preview-gateway-compose-render.mjs";

const proxyNetworkKey = "coolify-proxy";
const proxyNetworkAlias = "devspace-preview-ingress";

function fail(message) {
  throw new Error(`rendered Coolify preview gateway Compose validation failed: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function object(value, description) {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), `${description} must be an object.`);
  return value;
}

function serviceNetworks(service, serviceName) {
  if (service.networks === undefined || service.networks === null) return {};
  return object(service.networks, `${serviceName} networks`);
}

export function validateRenderedCoolifyPreviewGatewayCompose(model, expected, expectedProxyNetwork) {
  validateRenderedPreviewGatewayCompose(model, expected);
  requireCondition(
    typeof expectedProxyNetwork === "string" && expectedProxyNetwork.length > 0,
    "the expected proxy network must be non-empty."
  );

  const services = object(model.services, "services");
  const networks = object(model.networks, "top-level networks");
  requireCondition(
    Object.keys(networks).length === 1 && Object.hasOwn(networks, proxyNetworkKey),
    "the adapter must declare only its selected external proxy network."
  );
  const proxyNetwork = object(networks[proxyNetworkKey], "Coolify proxy network");
  requireCondition(proxyNetwork.external === true, "the selected proxy network must remain external.");
  requireCondition(
    proxyNetwork.name === expectedProxyNetwork,
    `the selected proxy network name must be exactly ${expectedProxyNetwork}.`
  );
  if (proxyNetwork.ipam !== undefined) {
    const ipam = object(proxyNetwork.ipam, "selected proxy network IPAM normalization");
    requireCondition(
      Object.keys(ipam).length === 0,
      "the selected external proxy network must not define IPAM configuration."
    );
  }
  requireCondition(
    Object.keys(proxyNetwork).every((key) => key === "external" || key === "name" || key === "ipam"),
    "the selected proxy network may contain only external, name, and Compose's empty IPAM normalization."
  );

  for (const serviceName of ["caddy", "preview-gateway-host"]) {
    requireCondition(
      Object.keys(serviceNetworks(services[serviceName], serviceName)).length === 0,
      `${serviceName} must not attach to the Coolify proxy network.`
    );
  }

  const connectorNetworks = serviceNetworks(
    services["preview-ingress-connector"],
    "preview-ingress-connector"
  );
  requireCondition(
    Object.keys(connectorNetworks).length === 1 && Object.hasOwn(connectorNetworks, proxyNetworkKey),
    "only preview-ingress-connector may attach to exactly the Coolify proxy network."
  );
  const connectorProxy = object(connectorNetworks[proxyNetworkKey], "connector proxy network attachment");
  requireCondition(
    Array.isArray(connectorProxy.aliases) && connectorProxy.aliases.includes(proxyNetworkAlias),
    `preview-ingress-connector must receive the stable ${proxyNetworkAlias} alias.`
  );
  return true;
}

async function main() {
  const inputPath = process.argv[2];
  const expectedProxyNetwork = process.argv[3];
  requireCondition(
    inputPath !== undefined && expectedProxyNetwork !== undefined,
    "usage: node tooling/check-preview-gateway-coolify-compose-render.mjs RENDERED_COMPOSE_JSON EXPECTED_PROXY_NETWORK"
  );
  let model;
  try {
    model = JSON.parse(await readFile(inputPath, "utf8"));
  } catch (error) {
    fail(`rendered Compose JSON is missing or malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateRenderedCoolifyPreviewGatewayCompose(model, undefined, expectedProxyNetwork);
  console.log("rendered Coolify preview gateway Compose contract passed");
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
