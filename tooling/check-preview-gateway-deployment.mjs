import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const caddyConfigPath = "deploy/preview-gateway/caddy.json";
const caddyDockerfilePath = "deploy/preview-gateway/Caddy.Dockerfile";
const composePath = "deploy/preview-gateway/compose.yaml";
const coolifyComposePath = "deploy/preview-gateway/compose.coolify.yaml";
const coolifyNetworkPath = "deploy/preview-gateway/compose.coolify-network.yaml";
const dockerfilePath = "deploy/preview-gateway/Dockerfile";
const gatewayUserExpression = '"${DEVSPACE_GATEWAY_UID:-1000}:${DEVSPACE_GATEWAY_GID:-1000}"';
const runtimeVolumeName = "gateway-runtime";
const ingressVolumeName = "gateway-ingress";
const externalVolumeNames = {
  [runtimeVolumeName]: "devspace-gateway-runtime",
  [ingressVolumeName]: "devspace-gateway-ingress"
};
const sharedRuntimeTarget = "/run/devspace/gateway";
const ingressRuntimeTarget = "/run/devspace/gateway/ingress";
const adminSocket = "unix//run/devspace/gateway/caddy-admin.sock|0660";
const previewHttpSocket = "unix//run/devspace/gateway/ingress/preview-http.sock|0660";
const coolifyProxyNetworkVariable = "DEVSPACE_COOLIFY_PROXY_NETWORK";
const coolifyProxyNetworkAlias = "devspace-preview-ingress";

function requireCondition(condition, message) {
  if (!condition) throw new Error(`preview gateway deployment validation failed: ${message}`);
}

function serviceBlock(compose, serviceName) {
  const match = new RegExp(`(?:^|\\n)  ${serviceName}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|$)`, "u").exec(compose);
  requireCondition(match !== null, `Compose service ${serviceName} is missing.`);
  return match[1];
}

function lineValue(block, field, indent) {
  const match = new RegExp(`(?:^|\\n)${" ".repeat(indent)}${field}: ([^\\n]+)`, "u").exec(block);
  return match?.[1]?.trim();
}

function serviceMounts(block, serviceName) {
  requireCondition(block.includes("\n    volumes:\n"), `${serviceName} must define service volumes.`);
  const volumeSection = block.slice(block.indexOf("\n    volumes:\n"));
  requireCondition(!/\n {6}- (?!type:)/u.test(volumeSection), `${serviceName} must use long volume syntax.`);

  const mounts = [...block.matchAll(/\n {6}- type: ([^\n]+)\n([\s\S]*?)(?=\n {6}- type: [^\n]+\n|$)/gu)].map((match) => ({
    type: match[1].trim(),
    body: match[2],
    source: lineValue(match[2], "source", 8),
    target: lineValue(match[2], "target", 8)
  }));
  requireCondition(mounts.length > 0, `${serviceName} must define at least one volume mount.`);
  return mounts;
}

function requireSafeServiceVolumeSource(mount, serviceName) {
  requireCondition(typeof mount.source === "string", `${serviceName} volume source is missing.`);
  requireCondition(!mount.source.includes("${"), `${serviceName} service volume source must not contain variable interpolation for Coolify compatibility.`);
  requireCondition(!/[`$;&|<>()[\]{}!*?\\]/u.test(mount.source), `${serviceName} service volume source must not contain shell metacharacters.`);
  requireCondition(!mount.source.startsWith("/"), `${serviceName} service volume source must not be an absolute host path.`);
  requireCondition(!mount.source.startsWith("."), `${serviceName} service volume source must not be a relative path.`);
  requireCondition(/^[a-z][a-z0-9_-]*$/u.test(mount.source), `${serviceName} service volume source must be a stable named-volume identifier.`);
}

function requireNocopy(mount, serviceName) {
  requireCondition(mount.body.includes("\n        volume:\n") && mount.body.includes("\n          nocopy: true\n"), `${serviceName} volume mount must set volume.nocopy: true.`);
}

function requireNamedVolumeMount(mount, serviceName, expectedSource, expectedTarget, { readOnly = false } = {}) {
  requireCondition(mount.type === "volume", `${serviceName} must use a volume mount.`);
  requireSafeServiceVolumeSource(mount, serviceName);
  requireCondition(mount.source === expectedSource, `${serviceName} must mount named volume ${expectedSource}.`);
  requireCondition(mount.target === expectedTarget, `${serviceName} must mount ${expectedTarget}.`);
  requireNocopy(mount, serviceName);
  if (readOnly) requireCondition(mount.body.includes("\n        read_only: true\n"), `${serviceName} ingress mount must be read-only.`);
  else requireCondition(!mount.body.includes("\n        read_only: true\n"), `${serviceName} runtime mount must remain read-write.`);
}

function topLevelVolumeSection(compose) {
  const match = /\nvolumes:\n([\s\S]*)$/u.exec(compose);
  requireCondition(match !== null, "top-level Compose volumes are missing.");
  return match[1];
}

function topLevelVolumeNames(section) {
  return [...section.matchAll(/(?:^|\n) {2}([A-Za-z0-9_-]+):\n/gu)].map((match) => match[1]);
}

function topLevelVolumeBlock(section, volumeName) {
  const match = new RegExp(`(?:^|\\n)  ${volumeName}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|$)`, "u").exec(section);
  requireCondition(match !== null, `top-level volume ${volumeName} is missing.`);
  return match[1];
}

function requireExternalVolume(section, volumeName) {
  const block = topLevelVolumeBlock(section, volumeName);
  const expectedName = externalVolumeNames[volumeName];
  requireCondition(lineValue(block, "external", 4) === "true", `${volumeName} must set external: true so Coolify does not create or rewrite it.`);
  requireCondition(lineValue(block, "name", 4) === expectedName, `${volumeName} external name must be exactly ${expectedName}.`);
  requireCondition(!block.includes("${"), `${volumeName} external name must not use interpolation across the unverified Coolify parser boundary.`);
  requireCondition(!/(?:^|\n) {4}(?:driver|driver_opts|device):/u.test(block), `${volumeName} must not define driver, driver_opts, or device in the Coolify-consumed Compose file.`);
  requireCondition(!/[/\\]/u.test(block), `${volumeName} must not contain a host path.`);
  requireCondition(!block.includes("docker.sock") && !block.includes("/var/run") && !block.includes("/etc/"), `${volumeName} must not map a Docker socket or sensitive host path.`);
  const keys = [...block.matchAll(/(?:^|\n) {4}([A-Za-z0-9_-]+):/gu)].map((match) => match[1]);
  requireCondition(keys.length === 2 && keys.includes("external") && keys.includes("name"), `${volumeName} must contain only external and name.`);
}

function requireHostServiceBasics(block, serviceName) {
  requireCondition(/\n? {4}network_mode: host\n/u.test(block), `${serviceName} must use host networking.`);
  requireCondition(!/\n? {4}ports:/u.test(block), `${serviceName} must not publish Docker ports.`);
  requireCondition(!block.includes("docker.sock"), `${serviceName} must not mount a Docker socket.`);
  requireCondition(block.includes("\n    restart: unless-stopped\n"), `${serviceName} must use the unless-stopped restart policy.`);
  requireCondition(lineValue(block, "user", 4) === gatewayUserExpression, `${serviceName} must retain the portable UID/GID configuration.`);
  const mounts = serviceMounts(block, serviceName);
  requireCondition(mounts.length === 1, `${serviceName} must have exactly one gateway volume mount.`);
  requireNamedVolumeMount(mounts[0], serviceName, runtimeVolumeName, sharedRuntimeTarget);
}

function requireConnectorBasics(block) {
  requireCondition(!/\n? {4}network_mode:/u.test(block), "preview-ingress-connector must use an isolated Compose network.");
  requireCondition(!/\n? {4}ports:/u.test(block), "preview-ingress-connector must not publish a host port.");
  requireCondition(/\n? {4}expose:/u.test(block), "preview-ingress-connector must expose its internal service port.");
  requireCondition(block.includes("\n    restart: unless-stopped\n"), "preview-ingress-connector must use the unless-stopped restart policy.");
  requireCondition(lineValue(block, "user", 4) === gatewayUserExpression, "preview-ingress-connector must retain the portable UID/GID configuration.");
  requireCondition(!block.includes("docker.sock"), "preview-ingress-connector must not mount a Docker socket.");
  const mounts = serviceMounts(block, "preview-ingress-connector");
  requireCondition(mounts.length === 1, "preview-ingress-connector must have exactly one volume mount.");
  requireNamedVolumeMount(mounts[0], "preview-ingress-connector", ingressVolumeName, ingressRuntimeTarget, { readOnly: true });
  requireCondition(mounts[0].source !== runtimeVolumeName && mounts[0].target !== sharedRuntimeTarget, "preview-ingress-connector must not mount the parent private runtime volume.");
  for (const forbidden of ["caddy-admin.sock", "preview-probe.sock", "lease-resolver.sock", "agent.sock", "docker.sock"]) {
    requireCondition(!block.includes(forbidden), `preview-ingress-connector must not receive ${forbidden}.`);
  }
  requireCondition(block.includes('- "${DEVSPACE_PREVIEW_INGRESS_PORT:-8080}"'), "preview-ingress-connector must retain the bounded configurable internal ingress port.");
}

export async function validatePreviewGatewayDeployment(repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  const [caddyText, caddyDockerfile, compose, coolifyCompose, coolifyNetwork, dockerfile] = await Promise.all([
    readFile(path.join(repositoryRoot, caddyConfigPath), "utf8"),
    readFile(path.join(repositoryRoot, caddyDockerfilePath), "utf8"),
    readFile(path.join(repositoryRoot, composePath), "utf8"),
    readFile(path.join(repositoryRoot, coolifyComposePath), "utf8"),
    readFile(path.join(repositoryRoot, coolifyNetworkPath), "utf8"),
    readFile(path.join(repositoryRoot, dockerfilePath), "utf8")
  ]);
  let caddy;
  try { caddy = JSON.parse(caddyText); }
  catch { throw new Error("preview gateway deployment validation failed: Caddy JSON is invalid."); }

  const servers = caddy?.apps?.http?.servers;
  requireCondition(servers !== null && typeof servers === "object" && !Array.isArray(servers), "Caddy HTTP servers are missing.");
  requireCondition(Object.keys(servers).length === 1 && Object.hasOwn(servers, "devspace-preview"), "Caddy server key must be exactly devspace-preview.");
  const server = servers["devspace-preview"];
  requireCondition(Array.isArray(server.listen) && server.listen.length === 2 && server.listen.includes("127.0.0.1:18080") && server.listen.includes(previewHttpSocket), "Caddy must listen on loopback and the private HTTP data-plane socket.");
  requireCondition(caddy.admin?.listen === adminSocket, "Caddy Admin must use the required Unix socket only.");
  requireCondition(server.automatic_https?.disable === true, "Caddy automatic HTTPS must be disabled.");
  requireCondition(Array.isArray(server.routes) && server.routes.length === 1, "Caddy must start with only the managed fallback route.");
  const fallback = server.routes[0];
  requireCondition(fallback?.["@id"] === "devspace-preview-fallback-v1" && !Object.hasOwn(fallback, "match")
    && fallback.terminal === true && fallback.handle?.[0]?.handler === "static_response"
    && fallback.handle[0].status_code === 404, "Caddy fallback must be an unconditional terminal HTTP 404.");
  requireCondition(!caddyText.includes("docker.sock") && !caddyText.includes("reverse_proxy"), "Caddy static config must not contain Docker discovery or a wildcard proxy.");

  const caddyService = serviceBlock(compose, "caddy");
  const hostService = serviceBlock(compose, "preview-gateway-host");
  const connectorService = serviceBlock(compose, "preview-ingress-connector");
  const volumes = topLevelVolumeSection(compose);
  const volumeNames = topLevelVolumeNames(volumes);
  requireCondition(volumeNames.length === 2 && volumeNames.includes(runtimeVolumeName) && volumeNames.includes(ingressVolumeName), "top-level volumes must contain only the runtime and ingress gateway volumes.");
  requireExternalVolume(volumes, runtimeVolumeName);
  requireExternalVolume(volumes, ingressVolumeName);
  requireCondition(!compose.includes("docker.sock"), "The gateway stack must not mount a Docker socket.");
  requireCondition(!volumes.includes("${") && !/[/\\]/u.test(volumes), "Gateway top-level volumes must not contain interpolation or host paths.");
  requireCondition(!/\n {4}ports:/u.test(compose), "The gateway stack must not publish host ports.");
  requireCondition(caddyService.includes("build:\n      context: ../..\n      dockerfile: deploy/preview-gateway/Caddy.Dockerfile"), "Caddy must use the self-contained deployment image build.");
  requireCondition(caddyDockerfile.includes("FROM caddy:2.11.3"), "Caddy deployment image must be based on caddy:2.11.3.");
  requireCondition(caddyDockerfile.includes("COPY deploy/preview-gateway/caddy.json /etc/caddy/caddy.json"), "Caddy deployment image must bake in caddy.json.");
  requireCondition(!caddyService.includes("source: ./caddy.json") && !caddyService.includes("target: /etc/caddy/caddy.json"), "Caddy must not use a repository-relative caddy.json bind mount.");
  requireCondition(!caddyService.includes("--adapter"), "Native Caddy JSON configuration must not use the json adapter.");
  requireHostServiceBasics(caddyService, "caddy");
  requireHostServiceBasics(hostService, "preview-gateway-host");
  requireConnectorBasics(connectorService);
  requireCondition(connectorService.includes("\n    expose:\n") && !connectorService.includes("\n    network_mode: host\n"), "preview-ingress-connector must remain on an isolated Compose network rather than host networking.");
  requireCondition(connectorService.match(/\n? {4}user: ([^\n]+)\n/u)?.[1] === hostService.match(/\n? {4}user: ([^\n]+)\n/u)?.[1], "Connector must support the same configured UID/GID as the gateway services.");
  requireCondition(connectorService.includes("command: [\"node\", \"dist/connector-index.js\"]"), "Connector must run the dedicated byte-transparent entry point.");
  requireCondition(caddyService.includes("command: [\"caddy\", \"run\", \"--config\", \"/etc/caddy/caddy.json\"]"), "Caddy must invoke the native JSON configuration through the caddy executable without an adapter.");
  requireCondition(caddyService.match(/\n? {4}user: ([^\n]+)\n/u)?.[1] === hostService.match(/\n? {4}user: ([^\n]+)\n/u)?.[1], "Both services must support the same configured UID/GID.");
  requireCondition(hostService.includes("DEVSPACE_PREVIEW_PROBE_SOCKET: /run/devspace/gateway/preview-probe.sock"), "Host service probe socket is missing.");
  requireCondition(hostService.includes("DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET: /run/devspace/gateway/lease-resolver.sock"), "Host service lease resolver socket is missing.");
  requireCondition(dockerfile.includes("pnpm deploy --filter @devspace/preview-gateway-host --prod --legacy /runtime"), "Preview gateway Dockerfile must use pnpm's legacy deploy mode.");
  requireCondition(
    !/coolify|traefik|DEVSPACE_COOLIFY_PROXY_NETWORK|devspace-preview-ingress/iu.test(compose),
    "The generic Compose file must remain provider-neutral."
  );

  const expectedCoolifyCompose = [
    "include:",
    "  - path:",
    "      - compose.yaml",
    "      - compose.coolify-network.yaml"
  ].join("\n");
  requireCondition(
    coolifyCompose.trim() === expectedCoolifyCompose,
    "Coolify Compose Location must include the generic contract and only the repository-owned network override."
  );

  const expectedCoolifyNetwork = [
    "services:",
    "  preview-ingress-connector:",
    "    networks:",
    "      coolify-proxy:",
    "        aliases:",
    `          - ${coolifyProxyNetworkAlias}`,
    "",
    "networks:",
    "  coolify-proxy:",
    "    external: true",
    `    name: \${${coolifyProxyNetworkVariable}:?${coolifyProxyNetworkVariable} must be set and non-empty}`
  ].join("\n");
  requireCondition(
    coolifyNetwork.trim() === expectedCoolifyNetwork,
    "Coolify network override must attach only the connector to one required administrator-selected external network and stable alias."
  );
  requireCondition(
    !coolifyNetwork.includes("ports:") && !coolifyNetwork.includes("docker.sock"),
    "Coolify network override must not publish ports or mount a Docker socket."
  );

  return true;
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await validatePreviewGatewayDeployment();
  console.log("preview gateway deployment artifact checks passed");
}
