import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { f10AgentApiV1EndpointByOperation } from "@devspace/contracts";
import { externalExecutionMarkerSchema, parseLinuxProcStat, type ExternalExecutionMarker } from "./external-execution.js";

const exec = promisify(execFile);
const projectId = "018f0f00-0000-7000-8000-000000000001";
const operationId = "018f0f00-0000-7000-8000-000000000002";
const requestId = "018f0f00-0000-7000-8000-000000000003";
const roots: string[] = [];
const children: ChildProcess[] = [];
const servers: https.Server[] = [];
const releases: Array<() => void> = [];
let survivingMarker: ExternalExecutionMarker | null = null;

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(servers.splice(0).map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))));
  if (survivingMarker?.phase === "running") {
    try {
      const observed = parseLinuxProcStat(survivingMarker.process.pid,
        await readFile(`/proc/${survivingMarker.process.pid}/stat`, "utf8"));
      if (observed.startTimeTicks === survivingMarker.process.startTimeTicks
        && observed.processGroupId === survivingMarker.process.processGroupId) process.kill(-observed.processGroupId, "SIGKILL");
    } catch { /* the exact test process is already gone */ }
  }
  survivingMarker = null;
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function headers(includeOperation: boolean) {
  return { "X-DevSpace-Protocol-Version": "1", "X-DevSpace-Request-Id": requestId,
    "X-DevSpace-Sent-At": new Date().toISOString(), ...(includeOperation ? { "X-DevSpace-Operation-Id": operationId } : {}) };
}

async function request(socketPath: string, method: string, requestPath: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const outgoing = http.request({ socketPath, method, path: requestPath, headers: {
      ...headers(method === "POST"), ...(encoded === undefined ? {} : { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(encoded)) })
    } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }));
    });
    outgoing.on("error", reject); if (encoded !== undefined) outgoing.write(encoded); outgoing.end();
  });
}

async function waitForAgent(socketPath: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await request(socketPath, "GET", "/v1/health")).status === 200) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Agent did not become ready");
}

async function waitForMarker(markerPath: string): Promise<ExternalExecutionMarker> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const parsed: unknown = JSON.parse(await readFile(markerPath, "utf8"));
      const marker = externalExecutionMarkerSchema.parse(parsed);
      if (marker.phase === "running") return marker;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Git execution marker did not become running");
}

function startAgent(environment: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/agent/test/e2e-server.ts"], {
    cwd: path.resolve("."), env: environment, stdio: "ignore"
  });
  children.push(child); return child;
}

test("an abrupt Agent death cannot overlap a surviving real Git mutation", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-abrupt-agent-")); roots.push(root);
  const certificate = path.join(root, "cert.pem"); const privateKey = path.join(root, "key.pem");
  await exec("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", privateKey,
    "-out", certificate, "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-days", "1"]);
  const originRoot = path.join(root, "origin"); const source = path.join(root, "source");
  const repository = path.join(originRoot, "repository.git"); await mkdir(originRoot);
  await exec("/usr/bin/git", ["init", "-b", "main", source]);
  await exec("/usr/bin/git", ["-C", source, "config", "user.name", "DevSpace Test"]);
  await exec("/usr/bin/git", ["-C", source, "config", "user.email", "devspace@example.invalid"]);
  await writeFile(path.join(source, "README.md"), "abrupt restart fixture\n", "utf8");
  await exec("/usr/bin/git", ["-C", source, "add", "README.md"]);
  await exec("/usr/bin/git", ["-C", source, "commit", "-m", "fixture"]);
  await exec("/usr/bin/git", ["clone", "--bare", source, repository]);
  await exec("/usr/bin/git", ["--git-dir", repository, "update-server-info"]);

  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); releases.push(release);
  let infoRequests = 0; let activeInfoRequests = 0; let maximumActiveInfoRequests = 0;
  const serveOrigin = async (incoming: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    try {
      const pathname = decodeURIComponent(new URL(incoming.url ?? "/", "https://origin.invalid").pathname);
      if (pathname.endsWith("/info/refs")) {
        infoRequests += 1; activeInfoRequests += 1; maximumActiveInfoRequests = Math.max(maximumActiveInfoRequests, activeInfoRequests);
        await gate; activeInfoRequests -= 1;
      }
      const target = path.resolve(originRoot, `.${pathname}`);
      if (!target.startsWith(`${originRoot}${path.sep}`)) { response.writeHead(404).end(); return; }
      const details = await stat(target);
      response.writeHead(200, { "content-length": details.size,
        "content-type": pathname.endsWith("/info/refs") ? "text/plain" : "application/octet-stream" });
      createReadStream(target).pipe(response);
    } catch { response.writeHead(404).end(); }
  };
  const origin = https.createServer({ key: await readFile(privateKey), cert: await readFile(certificate) },
    (incoming, response) => { void serveOrigin(incoming, response).catch(() => response.destroy()); });
  servers.push(origin);
  await new Promise<void>((resolve, reject) => { origin.once("error", reject); origin.listen(0, "127.0.0.1", () => resolve()); });
  const address = origin.address(); if (address === null || typeof address === "string") throw new Error("origin address missing");
  const repositoryUrl = `https://127.0.0.1:${address.port}/repository.git`;
  const managedRoot = path.join(root, "managed"); const socketPath = path.join(root, "agent.sock");
  await Promise.all(["projects", "workspaces", "state/operations"]
    .map(async (relative) => await mkdir(path.join(managedRoot, relative), { recursive: true })));
  const environment = { ...process.env, DEVSPACE_AGENT_SOCKET_PATH: socketPath, DEVSPACE_MANAGED_ROOT: managedRoot,
    DEVSPACE_GIT_CA_FILE: certificate };

  const firstAgent = startAgent(environment); await waitForAgent(socketPath);
  const receipt = await request(socketPath, "POST", "/v1/projects/create-managed-store", {
    data: { projectId, source: { kind: "remote", url: repositoryUrl } }
  });
  expect(receipt).toMatchObject({ status: 202, body: { data: { operationId } } });
  const markerPath = path.join(managedRoot, "state", "executions", `${operationId}.json`);
  survivingMarker = await waitForMarker(markerPath);
  expect(survivingMarker.phase).toBe("running");
  if (survivingMarker.phase !== "running") throw new Error("running marker expected");
  expect(parseLinuxProcStat(survivingMarker.process.pid,
    await readFile(`/proc/${survivingMarker.process.pid}/stat`, "utf8")).startTimeTicks).toBe(survivingMarker.process.startTimeTicks);

  firstAgent.kill("SIGKILL"); await new Promise((resolve) => firstAgent.once("exit", resolve));
  expect(() => process.kill(survivingMarker!.phase === "running" ? survivingMarker!.process.pid : 0, 0)).not.toThrow();
  const secondAgent = startAgent(environment); await waitForAgent(socketPath);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const recoveredMarker = externalExecutionMarkerSchema.parse(JSON.parse(await readFile(markerPath, "utf8")) as unknown);
  expect(recoveredMarker.executionId).toBe(survivingMarker.executionId);
  expect(infoRequests).toBe(1); expect(maximumActiveInfoRequests).toBe(1);

  release(); releases.splice(releases.indexOf(release), 1);
  const deadline = Date.now() + 30_000; let terminal: unknown;
  while (Date.now() < deadline) {
    const snapshot = await request(socketPath, "GET", "/v1/snapshot");
    if (snapshot.status === 200) {
      const data = f10AgentApiV1EndpointByOperation["snapshot.get"].successBodySchema.parse(snapshot.body).data;
      const observation = data.operationObservations.find((item) => item.operationId === operationId);
      if (observation?.state === "succeeded" || observation?.state === "failed") { terminal = observation; break; }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(terminal).toMatchObject({ operationId, state: "succeeded" });
  expect((await lstat(path.join(managedRoot, "projects", projectId, "repository.git"))).isDirectory()).toBe(true);
  expect(await readdir(path.join(managedRoot, "state", "executions"))).toEqual([]);
  expect(infoRequests).toBe(1); expect(maximumActiveInfoRequests).toBe(1);
  survivingMarker = null;
  secondAgent.kill("SIGTERM"); await new Promise((resolve) => secondAgent.once("exit", resolve));
});
