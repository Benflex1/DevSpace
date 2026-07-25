import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(repositoryRoot, "deploy/preview-gateway/compose.yaml");
const caddyImage = "caddy:2.11.3";
const adminSocketName = "caddy-admin.sock";
const previewHttpSocketName = "preview-http.sock";
const routesPath = "/config/apps/http/servers/devspace-preview/routes";
const fallbackId = "devspace-preview-fallback-v1";
const maxResponseBytes = 1_048_576;

function configuredId(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (!/^[0-9]+$/u.test(value)) throw new Error(`${name} must be a numeric UID/GID.`);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0 || id > 65_535) throw new Error(`${name} is outside the supported UID/GID range.`);
  return id;
}

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
      const result = { code: code ?? 1, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (!allowFailure && result.code !== 0) reject(new Error(`docker ${args[0]} failed (${result.code}): ${result.stderr.trim()}`));
      else resolve(result);
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForSocket(socketPath, containerId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await lstat(socketPath)).isSocket()) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const state = await runDocker(["inspect", "--format", "{{.State.Running}}", containerId], true);
    if (state.code !== 0 || state.stdout.trim() !== "true") {
      throw new Error(`Caddy exited before its Admin socket became available: ${state.stderr.trim()}`);
    }
    await delay(100);
  }
  throw new Error("Caddy Admin Unix socket did not become available within 20 seconds.");
}

async function adminRequest(socketPath, method, body) {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: routesPath,
      method,
      headers: { accept: "application/json", ...(encoded === undefined ? {} : {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(encoded)
      }) }
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= maxResponseBytes) chunks.push(chunk);
      });
      response.on("end", () => {
        if (bytes > maxResponseBytes) return reject(new Error("Caddy Admin response exceeded the smoke-test bound."));
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        if (text !== "") {
          try { parsed = JSON.parse(text); } catch { parsed = text; }
        }
        resolve({ status: response.statusCode ?? 0, body: parsed });
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error("Caddy Admin request timed out.")));
    request.once("error", reject);
    if (encoded !== undefined) request.write(encoded);
    request.end();
  });
}

function assertFallback(routes, message) {
  assert.ok(Array.isArray(routes), `${message}: response must be an array`);
  assert.equal(routes.length, 1, `${message}: exactly one fallback route expected`);
  assert.equal(routes[0]?.["@id"], fallbackId, `${message}: fallback route ID changed`);
  assert.equal(routes[0]?.terminal, true, `${message}: fallback must be terminal`);
  assert.equal(routes[0]?.handle?.[0]?.handler, "static_response", `${message}: fallback handler changed`);
  assert.equal(routes[0]?.handle?.[0]?.status_code, 404, `${message}: fallback status changed`);
}

async function main() {
  if (!dockerAvailable()) {
    console.error("Caddy smoke unavailable: Docker is not installed or its daemon is unavailable.");
    process.exitCode = 2;
    return;
  }

  const uid = configuredId("DEVSPACE_GATEWAY_UID", "1000");
  const gid = configuredId("DEVSPACE_GATEWAY_GID", "1000");
  const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "devspace-caddy-smoke-"));
  const uniqueId = path.basename(runtimeDirectory).replace(/[^a-z0-9]/gu, "").toLowerCase();
  const composeProject = `devspacecaddysmoke${uniqueId}`;
  const runtimeVolumeName = `devspace-caddy-smoke-runtime-${uniqueId}`;
  const ingressVolumeName = `devspace-caddy-smoke-ingress-${uniqueId}`;
  const overrideFile = path.join(runtimeDirectory, "compose.smoke.yaml");
  const adminSocket = path.join(runtimeDirectory, adminSocketName);
  const ingressDirectory = path.join(runtimeDirectory, "ingress");
  const previewHttpSocket = path.join(ingressDirectory, previewHttpSocketName);
  let containerId;
  let runtimeVolumeCreated = false;
  let ingressVolumeCreated = false;
  try {
    // The real deployment provisions this directory for the selected UID/GID.
    // The setgid bit preserves the smoke runner's group on Caddy's configured
    // 0660 socket, allowing the host-side smoke client to exercise that socket
    // while Caddy still runs with the deployment's effective UID/GID.
    await chmod(runtimeDirectory, 0o2777);
    await mkdir(ingressDirectory, { mode: 0o2777 });
    await chmod(ingressDirectory, 0o2777);
    await writeFile(overrideFile, [
      "services:",
      "  caddy:",
      "    network_mode: none",
      "volumes:",
      "  gateway-runtime:",
      "    external: true",
      `    name: ${runtimeVolumeName}`,
      "  gateway-ingress:",
      "    external: true",
      `    name: ${ingressVolumeName}`,
      ""
    ].join("\n"));
    await runDocker([
      "volume", "create", "--driver", "local", "--opt", "type=none", "--opt", "o=bind",
      "--opt", `device=${runtimeDirectory}`, runtimeVolumeName
    ]);
    runtimeVolumeCreated = true;
    await runDocker([
      "volume", "create", "--driver", "local", "--opt", "type=none", "--opt", "o=bind",
      "--opt", `device=${ingressDirectory}`, ingressVolumeName
    ]);
    ingressVolumeCreated = true;
    for (const [volumeName, device] of [
      [runtimeVolumeName, runtimeDirectory],
      [ingressVolumeName, ingressDirectory]
    ]) {
      const inspected = await runDocker(["volume", "inspect", volumeName, "--format", "{{json .Options}}"]);
      assert.deepEqual(JSON.parse(inspected.stdout), { device, o: "bind", type: "none" });
    }

    const composeArgs = ["compose", "-p", composeProject, "-f", composeFile, "-f", overrideFile];
    await runDocker([
      ...composeArgs, "up", "--build", "--detach", "--no-deps", "caddy"
    ]);
    const started = await runDocker([...composeArgs, "ps", "--quiet", "caddy"]);
    containerId = started.stdout.trim();
    assert.match(containerId, /^[0-9a-f]+$/u, "Docker did not return a Caddy container ID.");
    const mounts = await runDocker(["inspect", "--format", "{{json .Mounts}}", containerId]);
    const runtimeMount = JSON.parse(mounts.stdout).find((mount) => mount.Destination === "/run/devspace/gateway");
    const containerUser = await runDocker(["inspect", "--format", "{{.Config.User}}", containerId]);
    assert.equal(containerUser.stdout.trim(), `${uid}:${gid}`, "Caddy must retain the configured UID/GID.");
    assert.equal(runtimeMount?.Type, "volume", "Caddy runtime mount must remain a volume.");
    assert.equal(runtimeMount?.Name, runtimeVolumeName, "Caddy must receive the isolated external runtime volume.");
    assert.equal(runtimeMount?.RW, true, "Caddy runtime volume must remain read-write.");
    await waitForSocket(adminSocket, containerId);

    const initial = await adminRequest(adminSocket, "GET");
    assert.equal(initial.status, 200, "initial route inspection must succeed");
    assertFallback(initial.body, "initial route inspection");
    const dataPlane = await new Promise((resolve, reject) => {
      const request = http.request({ socketPath: previewHttpSocket, path: "/", headers: { host: "ordinary-application.example" } }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", reject);
      request.end();
    });
    assert.equal(dataPlane, 404, "private HTTP data-plane must retain the terminal fallback");

    const replacement = {
      "@id": "devspace-preview-caddy-smoke-v1",
      match: [{ host: ["smoke.localhost"] }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:43123" }], flush_interval: -1 }],
      terminal: true
    };
    const fallback = initial.body[0];
    const replaced = await adminRequest(adminSocket, "PATCH", [replacement, fallback]);
    assert.ok([200, 204].includes(replaced.status), `route replacement returned HTTP ${replaced.status}`);

    const observedReplacement = await adminRequest(adminSocket, "GET");
    assert.equal(observedReplacement.status, 200, "replacement inspection must succeed");
    assert.ok(Array.isArray(observedReplacement.body), "replacement inspection must return an array");
    assert.deepEqual(observedReplacement.body.map((route) => route["@id"]), [replacement["@id"], fallbackId]);

    const restored = await adminRequest(adminSocket, "PATCH", [fallback]);
    assert.ok([200, 204].includes(restored.status), `fallback restoration returned HTTP ${restored.status}`);
    const final = await adminRequest(adminSocket, "GET");
    assert.equal(final.status, 200, "final route inspection must succeed");
    assertFallback(final.body, "final route inspection");
    console.log(`real Caddy ${caddyImage} smoke passed (isolated external bind volume, native JSON, Unix Admin socket, GET, PATCH, fallback restore)`);
  } catch (error) {
    if (containerId !== undefined) {
      const logs = await runDocker(["logs", containerId], true);
      if (logs.stdout.trim() !== "" || logs.stderr.trim() !== "") {
        console.error(`Caddy container logs:\n${logs.stdout}${logs.stderr}`);
      }
    }
    throw error;
  } finally {
    await runDocker([
      "compose", "-p", composeProject, "-f", composeFile, "-f", overrideFile,
      "down", "--remove-orphans"
    ], true);
    if (containerId !== undefined) await runDocker(["rm", "--force", containerId], true);
    if (ingressVolumeCreated) await runDocker(["volume", "rm", ingressVolumeName], true);
    if (runtimeVolumeCreated) await runDocker(["volume", "rm", runtimeVolumeName], true);
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
}

await main();
