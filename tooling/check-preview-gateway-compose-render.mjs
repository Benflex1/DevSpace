import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const requiredServices = ["caddy", "preview-gateway-host", "preview-ingress-connector"];
const runtimeVolumeName = "gateway-runtime";
const ingressVolumeName = "gateway-ingress";
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

function assertNoHostPorts(serviceModel, serviceName) {
  requireCondition(serviceModel.ports === undefined || (Array.isArray(serviceModel.ports) && serviceModel.ports.length === 0), `${serviceName} must not publish host ports.`);
}

function assertNoDockerSocket(serviceModel, serviceName) {
  for (const mount of volumes(serviceModel, serviceName)) {
    const paths = [mount.source, mount.target].filter((value) => typeof value === "string");
    requireCondition(!paths.some((value) => value.includes("docker.sock")), `${serviceName} must not mount a Docker socket.`);
  }
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

function assertTopLevelVolume(model, volumeName, expectedDevice) {
  const topVolumes = object(model.volumes, "top-level volumes");
  requireCondition(Object.hasOwn(topVolumes, volumeName), `top-level volume ${volumeName} is missing.`);
  const volume = object(topVolumes[volumeName], `top-level volume ${volumeName}`);
  requireCondition(volume.driver === "local", `${volumeName} must use the local volume driver.`);
  const driverOptions = object(volume.driver_opts, `${volumeName} driver_opts`);
  requireCondition(driverOptions.type === "none", `${volumeName} driver_opts.type must be none.`);
  requireCondition(driverOptions.o === "bind", `${volumeName} driver_opts.o must be bind.`);
  requireCondition(driverOptions.device === expectedDevice, `${volumeName} device must be ${expectedDevice}.`);
  requireCondition(!JSON.stringify(volume).includes("docker.sock"), `${volumeName} must not map a Docker socket.`);
  requireCondition(!JSON.stringify(volume).includes("/var/run") && !JSON.stringify(volume).includes("/etc/"), `${volumeName} must not map a sensitive host path.`);
}

export function validateRenderedPreviewGatewayCompose(model, expected = expectedDefaults) {
  object(model, "rendered Compose model");
  const services = object(model.services, "services");
  for (const serviceName of requiredServices) service({ services }, serviceName);

  const topVolumes = object(model.volumes, "top-level volumes");
  const topVolumeNames = Object.keys(topVolumes);
  requireCondition(topVolumeNames.length === 2 && topVolumeNames.includes(runtimeVolumeName) && topVolumeNames.includes(ingressVolumeName), "top-level volumes must contain only the runtime and ingress gateway volumes.");
  assertTopLevelVolume(model, runtimeVolumeName, expected.hostDir);
  assertTopLevelVolume(model, ingressVolumeName, `${expected.hostDir}/ingress`);
  requireCondition(!JSON.stringify(topVolumes).includes("docker.sock"), "top-level volumes must not map a Docker socket.");
  requireCondition(!JSON.stringify(topVolumes).includes("/var/run") && !JSON.stringify(topVolumes).includes("/etc/"), "top-level volumes must not map a sensitive host path.");

  assertHostService(services.caddy, "caddy", expected);
  assertHostService(services["preview-gateway-host"], "preview-gateway-host", expected);
  assertConnector(services["preview-ingress-connector"], expected);
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
