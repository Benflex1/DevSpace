import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const requiredServices = ["caddy", "preview-gateway-host", "preview-ingress-connector"];
const expectedDefaults = {
  hostDir: "/tmp/devspace-gateway-compose-contract",
  uid: "12345",
  gid: "12346",
  ingressPort: "18081"
};
const runtimeRoot = "/run/devspace/gateway";
const ingressRoot = `${runtimeRoot}/ingress`;
const forbiddenConnectorPaths = [
  "caddy-admin.sock",
  "preview-probe.sock",
  "lease-resolver.sock",
  "agent.sock",
  "docker.sock"
];

function fail(message) {
  throw new Error(`rendered preview gateway Compose validation failed: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function object(value, description) {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), `${description} must be an object.`);
  return value;
}

function service(model, name) {
  const services = object(model.services, "services");
  requireCondition(Object.hasOwn(services, name), `service ${name} is missing.`);
  return object(services[name], `service ${name}`);
}

function userValue(serviceModel, serviceName) {
  requireCondition(typeof serviceModel.user === "string", `${serviceName} user must be a rendered string.`);
  return serviceModel.user;
}

function volumes(serviceModel, serviceName) {
  const raw = serviceModel.volumes;
  requireCondition(Array.isArray(raw) || (raw !== null && typeof raw === "object"), `${serviceName} volumes must be an array or object.`);
  if (Array.isArray(raw)) return raw.map((mount, index) => object(mount, `${serviceName} volume ${index}`));
  return Object.entries(raw).map(([target, mount]) => ({ target, ...object(mount, `${serviceName} volume ${target}`) }));
}

function mountField(mount, field, serviceName) {
  requireCondition(typeof mount[field] === "string", `${serviceName} bind mount ${field} must be a rendered string.`);
  return mount[field];
}

function assertNoHostPorts(serviceModel, serviceName) {
  requireCondition(serviceModel.ports === undefined || (Array.isArray(serviceModel.ports) && serviceModel.ports.length === 0), `${serviceName} must not publish host ports.`);
}

function assertNoDockerSocket(serviceModel, serviceName) {
  for (const mount of volumes(serviceModel, serviceName)) {
    const paths = [mount.source, mount.target].filter((value) => typeof value === "string");
    requireCondition(!paths.some((value) => value.includes("docker.sock")), `${serviceName} must not mount a Docker socket.`);
  }
}

function assertBindMount(mount, serviceName, expectedSource, expectedTarget, { readOnly = false } = {}) {
  requireCondition(mount.type === "bind", `${serviceName} must use a bind mount.`);
  requireCondition(mountField(mount, "source", serviceName) === expectedSource, `${serviceName} bind source must be ${expectedSource}.`);
  requireCondition(mountField(mount, "target", serviceName) === expectedTarget, `${serviceName} bind target must be ${expectedTarget}.`);
  requireCondition(mount.bind?.create_host_path === false, `${serviceName} bind mount create_host_path must be false.`);
  if (readOnly) requireCondition(mount.read_only === true, `${serviceName} ingress bind mount must be read-only.`);
}

function assertHostService(serviceModel, serviceName, expected) {
  requireCondition(serviceModel.network_mode === "host", `${serviceName} must use host networking.`);
  requireCondition(userValue(serviceModel, serviceName) === `${expected.uid}:${expected.gid}`, `${serviceName} user must be ${expected.uid}:${expected.gid}.`);
  requireCondition(serviceModel.restart === "unless-stopped", `${serviceName} restart policy must be unless-stopped.`);
  assertNoHostPorts(serviceModel, serviceName);
  assertNoDockerSocket(serviceModel, serviceName);
  const mounts = volumes(serviceModel, serviceName);
  requireCondition(mounts.length === 1, `${serviceName} must have exactly one gateway bind mount.`);
  assertBindMount(mounts[0], serviceName, expected.hostDir, runtimeRoot);
}

function assertConnector(serviceModel, expected) {
  requireCondition(serviceModel.network_mode !== "host", "preview-ingress-connector must not use host networking.");
  requireCondition(serviceModel.network_mode === undefined || serviceModel.network_mode === "default", "preview-ingress-connector must use an isolated Compose network.");
  requireCondition(userValue(serviceModel, "preview-ingress-connector") === `${expected.uid}:${expected.gid}`, "preview-ingress-connector user must resolve to the configured UID/GID.");
  requireCondition(serviceModel.restart === "unless-stopped", "preview-ingress-connector restart policy must be unless-stopped.");
  assertNoHostPorts(serviceModel, "preview-ingress-connector");
  assertNoDockerSocket(serviceModel, "preview-ingress-connector");
  const mounts = volumes(serviceModel, "preview-ingress-connector");
  requireCondition(mounts.length === 1, "preview-ingress-connector must receive only the ingress bind mount.");
  assertBindMount(mounts[0], "preview-ingress-connector", `${expected.hostDir}/ingress`, ingressRoot, { readOnly: true });
  const mountText = JSON.stringify(mounts[0]);
  for (const forbiddenPath of forbiddenConnectorPaths) {
    requireCondition(!mountText.includes(forbiddenPath), `preview-ingress-connector must not receive ${forbiddenPath}.`);
  }

  const exposed = serviceModel.expose;
  requireCondition(Array.isArray(exposed), "preview-ingress-connector must expose its internal port.");
  const exposedPorts = exposed.map((port) => String(port).split("/")[0]);
  requireCondition(exposedPorts.length === 1 && exposedPorts[0] === expected.ingressPort, `preview-ingress-connector internal port must be ${expected.ingressPort}.`);
}

export function validateRenderedPreviewGatewayCompose(model, expected = expectedDefaults) {
  object(model, "rendered Compose model");
  object(model.services, "services");
  for (const serviceName of requiredServices) service(model, serviceName);

  assertHostService(service(model, "caddy"), "caddy", expected);
  assertHostService(service(model, "preview-gateway-host"), "preview-gateway-host", expected);
  assertConnector(service(model, "preview-ingress-connector"), expected);
  return true;
}

async function main() {
  const inputPath = process.argv[2];
  requireCondition(inputPath !== undefined, "usage: node tooling/check-preview-gateway-compose-render.mjs RENDERED_COMPOSE_JSON");
  let model;
  try {
    model = JSON.parse(await readFile(inputPath, "utf8"));
  } catch (error) {
    fail(`rendered Compose JSON is missing or malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateRenderedPreviewGatewayCompose(model);
  console.log("rendered preview gateway Compose contract passed");
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
