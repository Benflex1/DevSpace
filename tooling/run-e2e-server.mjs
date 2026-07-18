import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDockerEngineFixture } from "./docker-engine-fixture.mjs";

const temporaryRoot = tmpdir();
for (const entry of await readdir(temporaryRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith("devspace-e2e-")) continue;
  const candidate = path.join(temporaryRoot, entry.name); let active = false;
  try { const pid = Number(await readFile(path.join(candidate, "owner.pid"), "utf8")); process.kill(pid, 0); active = true; } catch { /* inactive */ }
  if (!active) await rm(candidate, { recursive: true, force: true });
}

const runtimeDirectory = await mkdtemp(path.join(temporaryRoot, "devspace-e2e-"));
const coordinationPath = path.resolve(".cache/e2e-runtime.json");
await writeFile(path.join(runtimeDirectory, "owner.pid"), `${process.pid}\n`, { mode: 0o600 });
const certificate = path.join(runtimeDirectory, "origin-cert.pem");
const privateKey = path.join(runtimeDirectory, "origin-key.pem");
const openssl = spawnSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", privateKey,
  "-out", certificate, "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-days", "1"], { stdio: "ignore" });
if (openssl.status !== 0) throw new Error("Unable to create the E2E HTTPS certificate.");

const originRoot = path.join(runtimeDirectory, "origin");
const source = path.join(runtimeDirectory, "source");
const repository = path.join(originRoot, "repository.git");
execFileSync("/usr/bin/git", ["init", "-b", "main", source]);
execFileSync("/usr/bin/git", ["-C", source, "config", "user.name", "DevSpace E2E"]);
execFileSync("/usr/bin/git", ["-C", source, "config", "user.email", "e2e@example.invalid"]);
await writeFile(path.join(source, "README.md"), "deterministic managed workspace fixture\n", "utf8");
execFileSync("/usr/bin/git", ["-C", source, "add", "README.md"]);
execFileSync("/usr/bin/git", ["-C", source, "commit", "-m", "fixture"]);
const expectedHead = execFileSync("/usr/bin/git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
execFileSync("/usr/bin/git", ["clone", "--bare", source, repository]);
execFileSync("/usr/bin/git", ["--git-dir", repository, "update-server-info"]);

const origin = https.createServer({ key: await readFile(privateKey), cert: await readFile(certificate) }, async (request, response) => {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return; }
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "https://origin.local").pathname);
    const target = path.resolve(originRoot, `.${pathname}`);
    if (target !== originRoot && !target.startsWith(`${originRoot}${path.sep}`)) { response.writeHead(404).end(); return; }
    const details = await stat(target);
    if (!details.isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-length": details.size, "content-type": pathname.endsWith("/info/refs") ? "text/plain" : "application/octet-stream" });
    if (request.method === "HEAD") response.end(); else createReadStream(target).pipe(response);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve, reject) => { origin.once("error", reject); origin.listen(3443, "127.0.0.1", resolve); });

const databasePath = path.join(runtimeDirectory, "devspace.sqlite");
const sqliteModule = createRequire(path.resolve("apps/web/package.json"))("better-sqlite3");
const seedPath = path.join(runtimeDirectory, "seed.json");
const repositoryUrl = "https://127.0.0.1:3443/repository.git";
const seed = spawnSync("pnpm", ["exec", "tsx", "tooling/seed-e2e-project.ts", databasePath, repositoryUrl, seedPath], { encoding: "utf8" });
if (seed.status !== 0) throw new Error(`Unable to seed E2E project: ${seed.stderr}`);
const { projectId } = JSON.parse(await readFile(seedPath, "utf8"));
const controlToken = randomUUID();
const managedRoot = path.join(runtimeDirectory, "managed");
await Promise.all(["projects", "workspaces", "state/operations"]
  .map(async (relative) => await mkdir(path.join(managedRoot, relative), { recursive: true })));
const environment = {
  ...process.env, DEVSPACE_AUTH_MODE: "development", DEVSPACE_APP_ORIGIN: "http://127.0.0.1:3100",
  DEVSPACE_DEPS_PREPARED: "1",
  DEVSPACE_DATABASE_PATH: databasePath, DEVSPACE_AGENT_SOCKET_PATH: path.join(runtimeDirectory, "agent.sock"),
  DEVSPACE_MANAGED_ROOT: managedRoot, DEVSPACE_GIT_CA_FILE: certificate,
  DEVSPACE_DOCKER_SOCKET_PATH: path.join(runtimeDirectory, "docker-engine.sock")
};
const dockerFixture = await createDockerEngineFixture(environment.DEVSPACE_DOCKER_SOCKET_PATH, path.join(managedRoot, "workspaces"));
await writeFile(coordinationPath, `${JSON.stringify({ runtimeDirectory, databasePath, managedRoot, projectId, repositoryUrl, expectedHead, controlToken })}\n`, { mode: 0o600 });

let agentChild = null; let webChild = null; let stopping = false; let restarting = false;
function watchChild(child) {
  child.once("exit", (code) => { if (!stopping && !restarting && code !== 0) void stop(code ?? 1); });
}
function startAgent() {
  agentChild = spawn("pnpm", ["exec", "tsx", "apps/agent/test/e2e-server.ts"], { env: environment, stdio: "inherit", detached: true });
  watchChild(agentChild);
}
function startWeb() {
  webChild = spawn("pnpm", ["--filter", "@devspace/web", "run", "dev"], {
    env: { ...environment, DEVSPACE_WEB_HOST: "127.0.0.1", PORT: "3100" }, stdio: "inherit", detached: true
  });
  watchChild(webChild);
}
function startChildren() { startAgent(); startWeb(); }
async function stopProcesses(current) {
  for (const child of current) if (child !== null && child.exitCode === null) process.kill(-child.pid, "SIGTERM");
  await Promise.all(current.map((child) => child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve))));
}
async function stopChildren() {
  const current = [agentChild, webChild].filter((child) => child !== null); agentChild = null; webChild = null;
  await stopProcesses(current);
}
async function waitForWeb() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { const response = await fetch("http://127.0.0.1:3100/"); if (response.ok) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Web did not restart in time.");
}
async function waitForAgent() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = createConnection(environment.DEVSPACE_AGENT_SOCKET_PATH);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Agent did not restart in time.");
}
startChildren();

const control = http.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${controlToken}`) {
    response.writeHead(404).end(); return;
  }
  if (request.method === "POST" && request.url === "/fail-next-container-create") {
    dockerFixture.failNextContainerCreates(); response.writeHead(204).end(); return;
  }
  if (request.method === "POST" && request.url === "/simulate-stale-web-runtime-operation") {
    const database = new sqliteModule(databasePath);
    try {
      database.prepare("update operations set state = 'accepted', finished_at = null, error_code = null, error_message = null where operation_id = (select operation_id from operations where operation_name = 'workspace.start' order by created_at desc, operation_id desc limit 1)").run();
    } finally { database.close(); }
    response.writeHead(204).end(); return;
  }
  if (request.method === "GET" && request.url === "/docker-snapshot") {
    const snapshot = dockerFixture.snapshot();
    const body = JSON.stringify({ networks: snapshot.networks.length, containers: snapshot.containers.length, execs: snapshot.execs });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }).end(body); return;
  }
  if (request.method !== "POST" || !["/restart", "/restart-web", "/restart-agent"].includes(request.url ?? "")) {
    response.writeHead(404).end(); return;
  }
  restarting = true;
  try {
    if (request.url === "/restart") { await stopChildren(); startChildren(); }
    else if (request.url === "/restart-web") {
      const previous = webChild; webChild = null; if (previous !== null) await stopProcesses([previous]); startWeb();
    } else {
      const previous = agentChild; agentChild = null; if (previous !== null) await stopProcesses([previous]); startAgent();
    }
    await Promise.all([waitForAgent(), waitForWeb()]); response.writeHead(204).end();
  }
  catch { response.writeHead(500).end(); }
  finally { restarting = false; }
});
await new Promise((resolve, reject) => { control.once("error", reject); control.listen(3199, "127.0.0.1", resolve); });

async function stop(code = 0) {
  if (stopping) return; stopping = true;
  await stopChildren();
  await new Promise((resolve) => control.close(resolve));
  await new Promise((resolve) => origin.close(resolve));
  await dockerFixture.close();
  await rm(coordinationPath, { force: true });
  await rm(runtimeDirectory, { recursive: true, force: true });
  process.exit(code);
}
process.once("SIGINT", () => { void stop(0); });
process.once("SIGTERM", () => { void stop(0); });
