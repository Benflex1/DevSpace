import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const caddyConfigPath = "deploy/preview-gateway/caddy.json";
const composePath = "deploy/preview-gateway/compose.yaml";
const sharedRuntimeSource = "/srv/devspace/gateway";
const sharedRuntimeTarget = "/run/devspace/gateway";
const adminSocket = "unix//run/devspace/gateway/caddy-admin.sock|0660";

function requireCondition(condition, message) {
  if (!condition) throw new Error(`preview gateway deployment validation failed: ${message}`);
}

function serviceBlock(compose, serviceName) {
  const match = new RegExp(`(?:^|\\n)  ${serviceName}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|$)`, "u").exec(compose);
  requireCondition(match !== null, `Compose service ${serviceName} is missing.`);
  return match[1];
}

function requireHostServiceBasics(block, serviceName) {
  requireCondition(/\n? {4}network_mode: host\n/u.test(block), `${serviceName} must use host networking.`);
  requireCondition(!/\n? {4}ports:/u.test(block), `${serviceName} must not publish Docker ports.`);
  requireCondition(!block.includes("docker.sock"), `${serviceName} must not mount a Docker socket.`);
  requireCondition(block.includes(`source: ${sharedRuntimeSource}`), `${serviceName} must mount ${sharedRuntimeSource}.`);
  requireCondition(block.includes(`target: ${sharedRuntimeTarget}`), `${serviceName} must mount ${sharedRuntimeTarget}.`);
}

export async function validatePreviewGatewayDeployment(repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  const [caddyText, compose] = await Promise.all([
    readFile(path.join(repositoryRoot, caddyConfigPath), "utf8"),
    readFile(path.join(repositoryRoot, composePath), "utf8")
  ]);
  let caddy;
  try { caddy = JSON.parse(caddyText); }
  catch { throw new Error("preview gateway deployment validation failed: Caddy JSON is invalid."); }

  const servers = caddy?.apps?.http?.servers;
  requireCondition(servers !== null && typeof servers === "object" && !Array.isArray(servers), "Caddy HTTP servers are missing.");
  requireCondition(Object.keys(servers).length === 1 && Object.hasOwn(servers, "devspace-preview"), "Caddy server key must be exactly devspace-preview.");
  const server = servers["devspace-preview"];
  requireCondition(Array.isArray(server.listen) && server.listen.length === 1 && server.listen[0] === "127.0.0.1:18080", "Caddy must listen only on 127.0.0.1:18080.");
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
  requireCondition(/\n? {4}image: caddy:2\.11\.3\n/u.test(caddyService), "Caddy image must be pinned to caddy:2.11.3.");
  requireHostServiceBasics(caddyService, "caddy");
  requireHostServiceBasics(hostService, "preview-gateway-host");
  requireCondition(caddyService.includes("target: /etc/caddy/caddy.json") && caddyService.includes("read_only: true"), "Caddy JSON must be mounted read-only.");
  requireCondition(!caddyService.includes("--adapter"), "Native Caddy JSON configuration must not use the json adapter.");
  requireCondition(caddyService.includes("command: [\"caddy\", \"run\", \"--config\", \"/etc/caddy/caddy.json\"]"), "Caddy must invoke the native JSON configuration through the caddy executable without an adapter.");
  requireCondition(caddyService.match(/\n? {4}user: ([^\n]+)\n/u)?.[1] === hostService.match(/\n? {4}user: ([^\n]+)\n/u)?.[1], "Both services must support the same configured UID/GID.");
  requireCondition(hostService.includes("DEVSPACE_PREVIEW_PROBE_SOCKET: /run/devspace/gateway/preview-probe.sock"), "Host service probe socket is missing.");
  requireCondition(hostService.includes("DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET: /run/devspace/gateway/lease-resolver.sock"), "Host service lease resolver socket is missing.");

  return true;
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await validatePreviewGatewayDeployment();
  console.log("preview gateway deployment artifact checks passed");
}
