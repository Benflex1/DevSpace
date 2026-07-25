import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const requiredServices = ["caddy", "preview-gateway-host", "preview-ingress-connector"];
const runtimeVolumeName = "gateway-runtime";
const ingressVolumeName = "gateway-ingress";
const externalVolumeNames = {
  [runtimeVolumeName]: "devspace-gateway-runtime",
  [ingressVolumeName]: "devspace-gateway-ingress"
};
const expectedDefaults = {
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

function assertNoHostPorts(serviceModel, serviceName) {
  requireCondition(serviceModel.ports === undefined || (Array.isArray(serviceModel.ports) && serviceModel.ports.length === 0), `${serviceName} must not publish host ports.`);
}

function assertNoDockerSocket(serviceModel, serviceName) {
  for (const mount of volumes(serviceModel, serviceName)) {
    const paths = [mount.source, mount.target].filter((value) => typeof value === "string");
    requireCondition(!paths.some((value) => value.includes("docker.sock")), `${serviceName} must not mount a Docker socket.`);
  }
}

function assertCommand(serviceModel, serviceName, expectedCommand) {
  requireCondition(Array.isArray(serviceModel.command), `${serviceName} command must render as an array.`);
  requireCondition(
    JSON.stringify(serviceModel.command) === JSON.stringify(expectedCommand),
    `${serviceName} command contract changed.`
  );
}

function assertEnvironment(serviceModel, serviceName, expectedEnvironment) {
  const environment = object(serviceModel.environment, `${serviceName} environment`);
  const keys = Object.keys(environment);
  requireCondition(
    keys.length === Object.keys(expectedEnvironment).length &&
      keys.every((key) => environment[key] === expectedEnvironment[key]),
    `${serviceName} environment contract changed.`
  );
}

function assertSafeNamedVolumeSource(mount, serviceName, expectedSource) {
  requireCondition(typeof mount.source === "string", `${serviceName} volume source must be a rendered string.`);
  requireCondition(!mount.source.includes("${"), `${serviceName} volume source must not contain interpolation.`);
  requireCondition(!/[`$;&|<>()[\]{}!*?\\]/u.test(mount.source), `${serviceName} volume source must not contain shell metacharacters.`);
  requireCondition(!mount.source.startsWith("/") && !mount.source.startsWith("."), `${serviceName} volume source must not be an absolute or relative path.`);
  requireCondition(/^[a-z][a-z0-9_-]*$/u.test(mount.source), `${serviceName} volume source must be a stable named-volume identifier.`);
  requireCondition(mount.source === expectedSource, `${serviceName} volume source must be ${expectedSource}.`);
}

function assertNocopyIfRetained(mount, serviceName) {
  if (mount.volume === undefined) return;
  const volume = object(mount.volume, `${serviceName} volume options`);
  requireCondition(volume.nocopy === undefined || volume.nocopy === true, `${serviceName} volume.nocopy must remain enabled.`);
}

function assertVolumeMount(mount, serviceName, expectedSource, expectedTarget, { readOnly = false } = {}) {
  requireCondition(mount.type === "volume", `${serviceName} must use a named volume mount.`);
  assertSafeNamedVolumeSource(mount, serviceName, expectedSource);
  requireCondition(mount.target === expectedTarget, `${serviceName} volume target must be ${expectedTarget}.`);
  assertNocopyIfRetained(mount, serviceName);
  if (readOnly) requireCondition(mount.read_only === true, `${serviceName} ingress volume must be read-only.`);
  else requireCondition(mount.read_only === undefined || mount.read_only === false, `${serviceName} runtime volume must remain read-write.`);
}

function assertHostService(serviceModel, serviceName, expected) {
  requireCondition(serviceModel.network_mode === "host", `${serviceName} must use host networking.`);
  requireCondition(userValue(serviceModel, serviceName) === `${expected.uid}:${expected.gid}`, `${serviceName} user must be ${expected.uid}:${expected.gid}.`);
  requireCondition(serviceModel.restart === "unless-stopped", `${serviceName} restart policy must be unless-stopped.`);
  assertNoHostPorts(serviceModel, serviceName);
  assertNoDockerSocket(serviceModel, serviceName);
  const mounts = volumes(serviceModel, serviceName);
  requireCondition(mounts.length === 1, `${serviceName} must have exactly one gateway volume mount.`);
  assertVolumeMount(mounts[0], serviceName, runtimeVolumeName, runtimeRoot);
}

function assertConnector(serviceModel, expected) {
  requireCondition(serviceModel.network_mode !== "host", "preview-ingress-connector must not use host networking.");
  requireCondition(serviceModel.network_mode === undefined || serviceModel.network_mode === "default", "preview-ingress-connector must use an isolated Compose network.");
  requireCondition(userValue(serviceModel, "preview-ingress-connector") === `${expected.uid}:${expected.gid}`, "preview-ingress-connector user must resolve to the configured UID/GID.");
  requireCondition(serviceModel.restart === "unless-stopped", "preview-ingress-connector restart policy must be unless-stopped.");
  assertNoHostPorts(serviceModel, "preview-ingress-connector");
  assertNoDockerSocket(serviceModel, "preview-ingress-connector");
  const mounts = volumes(serviceModel, "preview-ingress-connector");
  requireCondition(mounts.length === 1, "preview-ingress-connector must receive only the ingress volume.");
  assertVolumeMount(mounts[0], "preview-ingress-connector", ingressVolumeName, ingressRoot, { readOnly: true });
  requireCondition(mounts[0].source !== runtimeVolumeName && mounts[0].target !== runtimeRoot, "preview-ingress-connector must not receive the parent runtime volume.");
  const mountText = JSON.stringify(mounts[0]);
  for (const forbiddenPath of forbiddenConnectorPaths) {
    requireCondition(!mountText.includes(forbiddenPath), `preview-ingress-connector must not receive ${forbiddenPath}.`);
  }

  const exposed = serviceModel.expose;
  requireCondition(Array.isArray(exposed), "preview-ingress-connector must expose its internal port.");
  const exposedPorts = exposed.map((port) => String(port).split("/")[0]);
  requireCondition(exposedPorts.length === 1 && exposedPorts[0] === expected.ingressPort, `preview-ingress-connector internal port must be ${expected.ingressPort}.`);
}

function assertTopLevelVolume(model, volumeName) {
  const topVolumes = object(model.volumes, "top-level volumes");
  requireCondition(Object.hasOwn(topVolumes, volumeName), `top-level volume ${volumeName} is missing.`);
  const volume = object(topVolumes[volumeName], `top-level volume ${volumeName}`);
  requireCondition(volume.external === true, `${volumeName} must remain external.`);
  requireCondition(volume.name === externalVolumeNames[volumeName], `${volumeName} external name must be exactly ${externalVolumeNames[volumeName]}.`);
  requireCondition(!volume.name.includes("${"), `${volumeName} external name must not contain interpolation.`);
  requireCondition(volume.driver === undefined && volume.driver_opts === undefined && volume.device === undefined, `${volumeName} must not contain a driver, driver_opts, or device.`);
  requireCondition(!/[/\\]/u.test(JSON.stringify(volume)), `${volumeName} must not contain a host path.`);
  requireCondition(Object.keys(volume).every((key) => key === "external" || key === "name"), `${volumeName} must contain only external and name.`);
}

export function validateRenderedPreviewGatewayCompose(model, expected = expectedDefaults) {
  object(model, "rendered Compose model");
  const services = object(model.services, "services");
  for (const serviceName of requiredServices) service({ services }, serviceName);
  requireCondition(
    Object.keys(services).length === requiredServices.length,
    "services must contain exactly caddy, preview-gateway-host, and preview-ingress-connector."
  );

  const topVolumes = object(model.volumes, "top-level volumes");
  const topVolumeNames = Object.keys(topVolumes);
  requireCondition(topVolumeNames.length === 2 && topVolumeNames.includes(runtimeVolumeName) && topVolumeNames.includes(ingressVolumeName), "top-level volumes must contain only the runtime and ingress gateway volumes.");
  assertTopLevelVolume(model, runtimeVolumeName);
  assertTopLevelVolume(model, ingressVolumeName);

  assertHostService(services.caddy, "caddy", expected);
  assertHostService(services["preview-gateway-host"], "preview-gateway-host", expected);
  assertConnector(services["preview-ingress-connector"], expected);
  assertCommand(services.caddy, "caddy", [
    "caddy", "run", "--config", "/etc/caddy/caddy.json"
  ]);
  assertCommand(services["preview-ingress-connector"], "preview-ingress-connector", [
    "node", "dist/connector-index.js"
  ]);
  assertEnvironment(services["preview-gateway-host"], "preview-gateway-host", {
    DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET: "/run/devspace/gateway/lease-resolver.sock",
    DEVSPACE_PREVIEW_PROBE_SOCKET: "/run/devspace/gateway/preview-probe.sock",
    NODE_ENV: "production"
  });
  assertEnvironment(services["preview-ingress-connector"], "preview-ingress-connector", {
    DEVSPACE_PREVIEW_HTTP_SOCKET: "/run/devspace/gateway/ingress/preview-http.sock",
    DEVSPACE_PREVIEW_INGRESS_PORT: expected.ingressPort,
    NODE_ENV: "production"
  });
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
