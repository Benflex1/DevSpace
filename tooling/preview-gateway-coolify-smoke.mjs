import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(repositoryRoot, "deploy/preview-gateway/compose.coolify.yaml");
const alias = "devspace-preview-ingress";

function dockerAvailable() {
  const result = spawnSync("docker", ["info"], { stdio: "ignore" });
  return result.error === undefined && result.status === 0;
}

async function runDocker(args, allowFailure = false) {
  return await new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const result = {
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (!allowFailure && result.code !== 0) {
        reject(new Error(`docker ${args[0]} failed (${result.code}): ${result.stderr.trim()}`));
      } else {
        resolve(result);
      }
    });
  });
}

function parseJsonOutput(result, description) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${description} did not return valid JSON: ${result.stdout.trim()}`);
  }
}

function assertNoPortBindings(inspect, serviceName) {
  const bindings = inspect.HostConfig.PortBindings;
  assert.ok(
    bindings === null || (typeof bindings === "object" && Object.keys(bindings).length === 0),
    `${serviceName} must publish no host ports.`
  );
}

async function main() {
  if (!dockerAvailable()) {
    console.error("Coolify adapter smoke unavailable: Docker is not installed or its daemon is unavailable.");
    process.exitCode = 2;
    return;
  }

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devspace-coolify-smoke-"));
  const uniqueId = path.basename(temporaryRoot).replace(/[^a-z0-9]/gu, "").toLowerCase();
  const composeProject = `devspacecoolifysmoke${uniqueId}`;
  const proxyNetwork = `devspace-coolify-smoke-proxy-${uniqueId}`;
  const runtimeVolume = `devspace-coolify-smoke-runtime-${uniqueId}`;
  const ingressVolume = `devspace-coolify-smoke-ingress-${uniqueId}`;
  const ingressDirectory = path.join(temporaryRoot, "ingress");
  const overrideFile = path.join(temporaryRoot, "compose.smoke.yaml");
  const composeEnvironment = {
    ...process.env,
    DEVSPACE_COOLIFY_PROXY_NETWORK: proxyNetwork,
    DEVSPACE_GATEWAY_UID: String(process.getuid?.() ?? 1000),
    DEVSPACE_GATEWAY_GID: String(process.getgid?.() ?? 1000)
  };
  let networkCreated = false;
  let runtimeVolumeCreated = false;
  let ingressVolumeCreated = false;
  let connectorId;
  let caddyId;

  const runCompose = async (args, allowFailure = false) => await new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      ["compose", "-p", composeProject, "-f", composeFile, "-f", overrideFile, ...args],
      { env: composeEnvironment, stdio: ["ignore", "pipe", "pipe"] }
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const result = {
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (!allowFailure && result.code !== 0) {
        reject(new Error(`docker compose ${args[0]} failed (${result.code}): ${result.stderr.trim()}`));
      } else {
        resolve(result);
      }
    });
  });

  try {
    await chmod(temporaryRoot, 0o777);
    await mkdir(ingressDirectory, { mode: 0o777 });
    await chmod(ingressDirectory, 0o777);
    await writeFile(overrideFile, [
      "volumes:",
      "  gateway-runtime:",
      "    external: true",
      `    name: ${runtimeVolume}`,
      "  gateway-ingress:",
      "    external: true",
      `    name: ${ingressVolume}`,
      ""
    ].join("\n"));

    await runDocker(["network", "create", proxyNetwork]);
    networkCreated = true;
    await runDocker([
      "volume", "create", "--driver", "local", "--opt", "type=none", "--opt", "o=bind",
      "--opt", `device=${temporaryRoot}`, runtimeVolume
    ]);
    runtimeVolumeCreated = true;
    await runDocker([
      "volume", "create", "--driver", "local", "--opt", "type=none", "--opt", "o=bind",
      "--opt", `device=${ingressDirectory}`, ingressVolume
    ]);
    ingressVolumeCreated = true;
    for (const [volumeName, device] of [
      [runtimeVolume, temporaryRoot],
      [ingressVolume, ingressDirectory]
    ]) {
      const volumeInspect = parseJsonOutput(
        await runDocker(["volume", "inspect", volumeName, "--format", "{{json .Options}}"]),
        `${volumeName} options`
      );
      assert.deepEqual(volumeInspect, { device, o: "bind", type: "none" });
    }

    await runCompose(["up", "--build", "--detach", "--no-deps", "caddy", "preview-ingress-connector"]);
    caddyId = (await runCompose(["ps", "--quiet", "caddy"])).stdout.trim();
    connectorId = (await runCompose(["ps", "--quiet", "preview-ingress-connector"])).stdout.trim();
    assert.match(caddyId, /^[0-9a-f]+$/u, "Docker did not return a Caddy container ID.");
    assert.match(connectorId, /^[0-9a-f]+$/u, "Docker did not return a connector container ID.");

    const caddyInspect = parseJsonOutput(
      await runDocker(["inspect", caddyId, "--format", "{{json .}}"]),
      "Caddy inspection"
    );
    const connectorInspect = parseJsonOutput(
      await runDocker(["inspect", connectorId, "--format", "{{json .}}"]),
      "connector inspection"
    );
    assert.equal(caddyInspect.HostConfig.NetworkMode, "host", "Caddy must remain host-networked.");
    assertNoPortBindings(caddyInspect, "Caddy");
    assertNoPortBindings(connectorInspect, "connector");
    assert.deepEqual(
      Object.keys(connectorInspect.NetworkSettings.Networks),
      [proxyNetwork],
      "connector must attach only to the selected temporary proxy network"
    );
    assert.ok(
      connectorInspect.NetworkSettings.Networks[proxyNetwork].Aliases.includes(alias),
      "connector must receive the stable proxy-network alias"
    );

    const caddyMounts = caddyInspect.Mounts;
    assert.equal(caddyMounts.length, 1, "Caddy must receive only one mount.");
    assert.equal(caddyMounts[0].Name, runtimeVolume, "Caddy must receive the temporary runtime volume.");
    assert.equal(caddyMounts[0].Destination, "/run/devspace/gateway");
    assert.equal(caddyMounts[0].RW, true, "Caddy runtime storage must remain read-write.");
    const connectorMounts = connectorInspect.Mounts;
    assert.equal(connectorMounts.length, 1, "connector must receive only one mount.");
    assert.equal(connectorMounts[0].Name, ingressVolume, "connector must receive the temporary ingress volume.");
    assert.equal(connectorMounts[0].Destination, "/run/devspace/gateway/ingress");
    assert.equal(connectorMounts[0].RW, false, "connector ingress storage must remain read-only.");
    assert.ok(
      !connectorMounts.some((mount) => mount.Name === runtimeVolume || mount.Destination === "/run/devspace/gateway"),
      "connector must not receive the full gateway runtime volume"
    );
    for (const serviceInspect of [caddyInspect, connectorInspect]) {
      assert.ok(
        !serviceInspect.Mounts.some((mount) => String(mount.Source).includes("docker.sock") || String(mount.Destination).includes("docker.sock")),
        "gateway services must not mount a Docker socket"
      );
    }

    const connectorImage = connectorInspect.Config.Image;
    const probeScript = [
      "const http = require('node:http');",
      "let attempts = 0;",
      "function probe() {",
      `  const request = http.get({ host: '${alias}', port: 8080, path: '/', headers: { host: 'network-smoke-preview.invalid' } }, (response) => {`,
      "    response.resume();",
      "    response.once('end', () => {",
      "      if (response.statusCode === 404) { console.log('404'); return; }",
      "      console.error(`unexpected HTTP status ${response.statusCode}`); process.exit(1);",
      "    });",
      "  });",
      "  request.setTimeout(1000, () => request.destroy(new Error('timeout')));",
      "  request.once('error', (error) => {",
      "    attempts += 1;",
      "    if (attempts >= 50) { console.error(error.message); process.exit(1); }",
      "    setTimeout(probe, 200);",
      "  });",
      "}",
      "probe();"
    ].join("\n");
    const probe = await runDocker([
      "run", "--rm", "--network", proxyNetwork, connectorImage, "node", "-e", probeScript
    ]);
    assert.equal(probe.stdout.trim(), "404", "proxy-network request must receive Caddy's fallback HTTP 404.");
    console.log("Coolify adapter smoke passed (temporary external network and bind volumes, stable alias, connector → ingress Unix socket → Caddy HTTP 404, no host ports)");
  } catch (error) {
    for (const containerId of [caddyId, connectorId]) {
      if (containerId === undefined) continue;
      const logs = await runDocker(["logs", containerId], true);
      if (logs.stdout.trim() !== "" || logs.stderr.trim() !== "") {
        console.error(`container ${containerId} logs:\n${logs.stdout}${logs.stderr}`);
      }
    }
    throw error;
  } finally {
    await runCompose(["down", "--remove-orphans", "--rmi", "local"], true);
    if (connectorId !== undefined) await runDocker(["rm", "--force", connectorId], true);
    if (caddyId !== undefined) await runDocker(["rm", "--force", caddyId], true);
    if (ingressVolumeCreated) await runDocker(["volume", "rm", ingressVolume], true);
    if (runtimeVolumeCreated) await runDocker(["volume", "rm", runtimeVolume], true);
    if (networkCreated) await runDocker(["network", "rm", proxyNetwork], true);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
