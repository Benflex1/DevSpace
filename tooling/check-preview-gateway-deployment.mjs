import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const caddyConfigPath = "deploy/preview-gateway/caddy.json";
const caddyDockerfilePath = "deploy/preview-gateway/Caddy.Dockerfile";
const composePath = "deploy/preview-gateway/compose.yaml";
const dockerfilePath = "deploy/preview-gateway/Dockerfile";
const sharedRuntimeSource = "/srv/devspace/gateway";
const sharedRuntimeTarget = "/run/devspace/gateway";
const adminSocket = "unix//run/devspace/gateway/caddy-admin.sock|0660";
const previewHttpSocket = "unix//run/devspace/gateway/ingress/preview-http.sock|0660";

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

function requireConnectorBasics(block) {
  requireCondition(!/\n? {4}network_mode:/u.test(block), "preview-ingress-connector must use an isolated Compose network.");
  requireCondition(!/\n? {4}ports:/u.test(block), "preview-ingress-connector must not publish a host port.");
  requireCondition(/\n? {4}expose:/u.test(block), "preview-ingress-connector must expose its internal service port.");
  requireCondition(block.includes("source: /srv/devspace/gateway/ingress"), "preview-ingress-connector must mount only the ingress directory.");
  requireCondition(block.includes("target: /run/devspace/gateway/ingress"), "preview-ingress-connector must mount the ingress directory at the private data-plane path.");
  requireCondition(!block.includes("source: /srv/devspace/gateway\n") && !block.includes("target: /run/devspace/gateway\n"), "preview-ingress-connector must not mount the parent private runtime directory.");
  for (const forbidden of ["caddy-admin.sock", "preview-probe.sock", "lease-resolver.sock", "agent.sock", "docker.sock"]) {
    requireCondition(!block.includes(forbidden), `preview-ingress-connector must not receive ${forbidden}.`);
  }
}

export async function validatePreviewGatewayDeployment(repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  const [caddyText, caddyDockerfile, compose, dockerfile] = await Promise.all([
    readFile(path.join(repositoryRoot, caddyConfigPath), "utf8"),
    readFile(path.join(repositoryRoot, caddyDockerfilePath), "utf8"),
    readFile(path.join(repositoryRoot, composePath), "utf8"),
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
  requireCondition(caddyService.includes("build:\n      context: ../..\n      dockerfile: deploy/preview-gateway/Caddy.Dockerfile"), "Caddy must use the self-contained deployment image build.");
  requireCondition(caddyDockerfile.includes("FROM caddy:2.11.3"), "Caddy deployment image must be based on caddy:2.11.3.");
  requireCondition(caddyDockerfile.includes("COPY deploy/preview-gateway/caddy.json /etc/caddy/caddy.json"), "Caddy deployment image must bake in caddy.json.");
  requireHostServiceBasics(caddyService, "caddy");
  requireHostServiceBasics(hostService, "preview-gateway-host");
  requireConnectorBasics(connectorService);
  requireCondition(connectorService.match(/\n? {4}user: ([^\n]+)\n/u)?.[1] === hostService.match(/\n? {4}user: ([^\n]+)\n/u)?.[1], "Connector must support the same configured UID/GID as the gateway services.");
  requireCondition(connectorService.includes("command: [\"node\", \"dist/connector-index.js\"]"), "Connector must run the dedicated byte-transparent entry point.");
  requireCondition(!caddyService.includes("source: ./caddy.json") && !caddyService.includes("target: /etc/caddy/caddy.json"), "Caddy must not use a repository-relative caddy.json bind mount.");
  requireCondition(!caddyService.includes("--adapter"), "Native Caddy JSON configuration must not use the json adapter.");
  requireCondition(caddyService.includes("command: [\"caddy\", \"run\", \"--config\", \"/etc/caddy/caddy.json\"]"), "Caddy must invoke the native JSON configuration through the caddy executable without an adapter.");
  requireCondition(caddyService.match(/\n? {4}user: ([^\n]+)\n/u)?.[1] === hostService.match(/\n? {4}user: ([^\n]+)\n/u)?.[1], "Both services must support the same configured UID/GID.");
  requireCondition(hostService.includes("DEVSPACE_PREVIEW_PROBE_SOCKET: /run/devspace/gateway/preview-probe.sock"), "Host service probe socket is missing.");
  requireCondition(hostService.includes("DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET: /run/devspace/gateway/lease-resolver.sock"), "Host service lease resolver socket is missing.");
  requireCondition(dockerfile.includes("pnpm deploy --filter @devspace/preview-gateway-host --prod --legacy /runtime"), "Preview gateway Dockerfile must use pnpm's legacy deploy mode.");

  return true;
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await validatePreviewGatewayDeployment();
  console.log("preview gateway deployment artifact checks passed");
}
