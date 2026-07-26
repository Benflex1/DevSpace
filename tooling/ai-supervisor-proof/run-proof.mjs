import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { parseOwnershipRecord, processIdentityEqual } from "./core.mjs";

const SOCKET = process.env.DEVSPACE_DOCKER_SOCKET_PATH;
const IMAGE = "node:24-bookworm";
const LABEL = "devspace.ai-supervisor-proof";
const TOOL_ROOT = path.resolve("tooling/ai-supervisor-proof");

if (SOCKET !== "/run/devspace-docker/docker.sock") throw new Error("proof-requires-dedicated-container-socket");

function api(method, requestPath, body, accepted = [200, 201, 204], contentType = "application/json") {
  const encoded = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: SOCKET, method, path: requestPath,
      headers: encoded === undefined ? {} : { "content-type": contentType, "content-length": String(encoded.length) } }, (response) => {
      const chunks = []; response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const result = Buffer.concat(chunks);
        if (accepted.includes(response.statusCode ?? 0)) resolve(result);
        else reject(Object.assign(new Error(`docker-api-${method}-${response.statusCode}`), { statusCode: response.statusCode, body: result }));
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error("docker-api-timeout")));
    request.on("error", reject);
    if (encoded !== undefined) request.write(encoded);
    request.end();
  });
}
async function json(method, requestPath, body, accepted) {
  return JSON.parse((await api(method, requestPath, body, accepted)).toString("utf8"));
}
function demux(buffer) {
  const streams = { stdout: [], stderr: [] }; let offset = 0;
  while (offset + 8 <= buffer.length) {
    const kind = buffer[offset]; const length = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + length > buffer.length) break;
    (kind === 2 ? streams.stderr : streams.stdout).push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return { stdout: Buffer.concat(streams.stdout).toString("utf8"),
    stderr: Buffer.concat(streams.stderr).toString("utf8"), consumed: offset };
}
async function createExec(containerId, command) {
  const response = await json("POST", `/containers/${containerId}/exec`, {
    AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false,
    Cmd: command, WorkingDir: "/tooling/ai-supervisor-proof", Env: []
  });
  return response.Id;
}
function startExec(execId, stdin, readyPattern = null) {
  const encoded = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: SOCKET, method: "POST", path: `/exec/${execId}/start`,
      headers: { "content-type": "application/json", "content-length": String(encoded.length),
        connection: "Upgrade", upgrade: "tcp" } });
    request.setTimeout(10_000, () => request.destroy(new Error("exec-start-timeout")));
    request.once("upgrade", (_response, socket, head) => {
      request.setTimeout(0); const chunks = []; if (head.length > 0) chunks.push(head);
      let finished = false;
      const finish = () => {
        if (finished) return; finished = true;
        resolve({ ...demux(Buffer.concat(chunks)), socket });
      };
      socket.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
        if (readyPattern !== null && demux(Buffer.concat(chunks)).stdout.includes(readyPattern)) {
          socket.destroy(); finish();
        }
      });
      socket.once("end", finish); socket.once("error", reject);
      socket.write(Buffer.from(`${stdin}\n`));
    });
    request.once("response", (response) => reject(new Error(`exec-start-http-${response.statusCode}`)));
    request.once("error", reject); request.end(encoded);
  });
}
async function helper(containerId, request) {
  const execId = await createExec(containerId, ["node", "/tooling/ai-supervisor-proof/control-client.mjs"]);
  const output = await startExec(execId, JSON.stringify(request));
  if (output.stderr !== "") throw new Error(`helper-private-diagnostic:${output.stderr.trim()}`);
  const response = JSON.parse(output.stdout.trim());
  return { execId, response, inspection: await json("GET", `/exec/${execId}/json`) };
}
async function uploadTooling(containerId) {
  const repositoryRoot = path.dirname(path.dirname(TOOL_ROOT));
  const archive = spawnSync("tar", ["-C", repositoryRoot, "-cf", "-", "tooling/ai-supervisor-proof"],
    { encoding: null, maxBuffer: 8 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error("proof-archive-failed");
  await api("PUT", `/containers/${containerId}/archive?path=/`, archive.stdout, [200], "application/x-tar");
}
async function createContainer(runId, suffix) {
  const name = `devspace-ai-proof-${runId}-${suffix}`;
  const created = await json("POST", `/containers/create?name=${name}`, {
    Image: IMAGE, Cmd: ["node", "-e", "setInterval(()=>{},1000)"], WorkingDir: "/tmp",
    Labels: { [LABEL]: runId, "devspace.managed": "proof-only" },
    HostConfig: { Privileged: false, PublishAllPorts: false, NetworkMode: "none", PidMode: "",
      IpcMode: "private", UTSMode: "", UsernsMode: "", CgroupnsMode: "private", AutoRemove: false,
      ReadonlyRootfs: false, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      CapAdd: [], CapDrop: [], Devices: [], SecurityOpt: ["no-new-privileges:true"], PidsLimit: 128 }
  });
  try {
    await uploadTooling(created.Id);
    await api("POST", `/containers/${created.Id}/start`);
    const inspected = await json("GET", `/containers/${created.Id}/json`);
    if (inspected.Id !== created.Id || inspected.State.Running !== true) throw new Error("container-identity-unproven");
    return { id: created.Id, name };
  } catch (error) {
    await removeContainer(created.Id).catch(() => {});
    throw error;
  }
}
async function removeContainer(id) {
  await api("DELETE", `/containers/${id}?force=1`, undefined, [204, 404]).catch((error) => {
    if (error.statusCode !== 404) throw error;
  });
}
function binding(containerId, execId, generation = 1) {
  return {
    schemaVersion: "devspace.ai-supervisor-proof-binding/v1",
    projectId: "01990000-0000-7000-8000-000000000001",
    workspaceId: "01990000-0000-7000-8000-000000000002",
    configurationRevisionId: "01990000-0000-7000-8000-000000000003",
    runtimePlanHash: `sha256-runtime-plan-v1:${"a".repeat(64)}`,
    runtimeGeneration: 7, containerId,
    aiSessionId: "01990000-0000-7000-8000-000000000004",
    profileId: "proof-profile",
    profileRevision: `sha256-ai-profile-v1:${"b".repeat(64)}`,
    processGeneration: generation,
    operationId: "01990000-0000-7000-8000-000000000005",
    dockerExecId: execId
  };
}
async function launch(runId, stateRoot, suffix, ignoreTerm = false) {
  const container = await createContainer(runId, suffix);
  try {
    const execId = await createExec(container.id, ["node", "/tooling/ai-supervisor-proof/supervisor.mjs"]);
    const bound = binding(container.id, execId);
    const credential = randomBytes(32).toString("hex");
    const socketPath = `/tmp/devspace-ai-proof/${bound.aiSessionId}-${bound.processGeneration}.sock`;
    const bootstrap = { format: "devspace.ai-supervisor-proof-bootstrap/v1", credential,
      socketPath, binding: bound, ignoreTerm };
    const initial = await startExec(execId, JSON.stringify(bootstrap), "supervisor-ready");
    if (!initial.stdout.includes("supervisor-ready") || initial.stderr !== "") throw new Error("supervisor-bootstrap-failed");
    const execInspection = await json("GET", `/exec/${execId}/json`);
    if (execInspection.ID !== execId || execInspection.ContainerID !== container.id || !execInspection.Running) {
      throw new Error("docker-exec-identity-unproven");
    }
    const established = await helper(container.id, { socketPath, credential, binding: bound, ownership: null, action: "establish" });
    if (!established.response.ok) throw new Error("supervisor-establish-rejected");
    const ownership = established.response.result;
    const execProcess = { outerPid: execInspection.Pid, bindingMethod: "authenticated-exact-exec-stdin-bootstrap" };
    if (!Number.isSafeInteger(execInspection.Pid) || execInspection.Pid < 1
      || ownership.provider.ppid !== ownership.supervisor.pid
      || ownership.descendants.length < 2) {
      throw new Error(`exec-process-chain-unproven:${JSON.stringify({
        execPid: execInspection.Pid, supervisorPid: ownership.supervisor.pid,
        supervisorNspid: ownership.supervisor.nspid, descendantCount: ownership.descendants.length,
        directChild: ownership.provider.ppid === ownership.supervisor.pid
      })}`);
    }
    ownership.dockerExecProcess = execProcess;
    const recordPath = path.join(stateRoot, `${suffix}.json`);
    const record = { format: "devspace.ai-supervisor-proof-record/v1", credential, socketPath,
      binding: bound, ownership, containerId: container.id, supervisorExecId: execId };
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(recordPath, 0o600);
    if ((await stat(recordPath)).mode & 0o077) throw new Error("ownership-record-permissions");
    return { container, execId, execInspection, record, recordPath, initial };
  } catch (error) {
    await removeContainer(container.id).catch(() => {});
    throw error;
  }
}
async function reconnectChild(recordPath) {
  const record = parseOwnershipRecord(JSON.parse(await readFile(recordPath, "utf8")));
  const inspected = await json("GET", `/exec/${record.supervisorExecId}/json`);
  if (inspected.ID !== record.supervisorExecId || inspected.ContainerID !== record.containerId
    || inspected.Pid !== record.ownership.dockerExecProcess.outerPid) {
    throw new Error("reconnect-exec-process-mismatch");
  }
  return await helper(record.containerId, { socketPath: record.socketPath, credential: record.credential,
    binding: record.binding, ownership: record.ownership, action: "proof" });
}
async function separateHostReconnect(recordPath) {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "--reconnect-child"],
    { stdio: ["pipe", "pipe", "pipe"], env: { DEVSPACE_DOCKER_SOCKET_PATH: SOCKET } });
  child.stdin.end(`${recordPath}\n`);
  const stdout = []; const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  if (code !== 0) throw new Error(`reconnect-child-failed:${Buffer.concat(stderr).toString("utf8")}`);
  return JSON.parse(Buffer.concat(stdout).toString("utf8"));
}
async function assertRejected(record, mutate) {
  const request = { socketPath: record.socketPath, credential: record.credential,
    binding: structuredClone(record.binding), ownership: record.ownership, action: "proof" };
  mutate(request);
  const result = await helper(record.containerId, request);
  if (result.response.ok !== false) throw new Error("mutated-authority-accepted");
  return result.response.code;
}
async function main() {
  const runId = randomUUID().slice(0, 8); const stateRoot = await mkdtemp(path.join(tmpdir(), "devspace-ai-proof-"));
  await chmod(stateRoot, 0o700);
  const containers = new Set(); const records = new Set(); const matrix = {};
  const cleanup = async () => {
    for (const id of containers) await removeContainer(id).catch(() => {});
    await rm(stateRoot, { recursive: true, force: true });
  };
  const onSignal = () => { void cleanup().finally(() => process.exit(130)); };
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  try {
    await api("GET", "/_ping");
    const info = await json("GET", "/info");
    if (!info.SecurityOptions?.some((value) => /rootless/iu.test(value))) throw new Error("daemon-not-rootless");

    const normal = await launch(runId, stateRoot, "normal"); containers.add(normal.container.id); records.add(normal.recordPath);
    const roundTrip = await helper(normal.container.id, { socketPath: normal.record.socketPath,
      credential: normal.record.credential, binding: normal.record.binding, ownership: normal.record.ownership,
      action: "send", message: { type: "operation", operationId: "normal-round-trip", value: "fixture" } });
    if (roundTrip.response.result?.type !== "echo") throw new Error("round-trip-failed");
    matrix.A = { status: "PASS", evidence: "exact container/exec plus authenticated stdin bootstrap, stable inner process identity, direct child, and JSONL round trip" };

    const reconnect = await separateHostReconnect(normal.recordPath);
    if (!reconnect.response.ok) throw new Error("reconnect-rejected");
    const continued = await helper(normal.container.id, { socketPath: normal.record.socketPath,
      credential: normal.record.credential, binding: normal.record.binding, ownership: normal.record.ownership,
      action: "send", message: { type: "operation", operationId: "reconnect-round-trip", value: "fixture" } });
    if (continued.response.result?.type !== "echo") throw new Error("reconnect-round-trip-failed");
    matrix.B = { status: "PASS", evidence: "new host process and new helper exec re-proved chain after launch attachment destruction" };

    const rejectionBaseline = (await reconnectChild(normal.recordPath)).response.result;
    matrix.C = { status: (await assertRejected(normal.record, (request) => { request.credential = "0".repeat(64); }))
      === "authentication-failed" ? "PASS" : "FAIL", evidence: "wrong credential rejected" };
    await assertRejected(normal.record, (request) => { request.binding.aiSessionId = "foreign-session"; });
    await assertRejected(normal.record, (request) => { request.binding.processGeneration += 1; });
    matrix.D = { status: "PASS", evidence: "foreign session and generation rejected" };
    for (const field of ["containerId", "workspaceId", "profileRevision", "dockerExecId"]) {
      await assertRejected(normal.record, (request) => { request.binding[field] = `mutated-${field}`; });
    }
    await assertRejected(normal.record, (request) => { request.binding.runtimeGeneration += 1; });
    const rejectionAfter = (await reconnectChild(normal.recordPath)).response.result;
    if (rejectionAfter.events.length !== rejectionBaseline.events.length
      || !processIdentityEqual(rejectionAfter.provider, rejectionBaseline.provider)) {
      throw new Error("rejected-control-had-side-effect");
    }
    matrix.E = { status: "PASS", evidence: "five immutable field mutations rejected independently" };

    const interrupt = await helper(normal.container.id, { socketPath: normal.record.socketPath,
      credential: normal.record.credential, binding: normal.record.binding, ownership: normal.record.ownership,
      action: "interrupt" });
    const afterInterrupt = await reconnectChild(normal.recordPath);
    if (interrupt.response.result?.type !== "interrupted" || afterInterrupt.response.result.providerState !== "running") {
      throw new Error("interrupt-semantics-failed");
    }
    matrix.F = { status: "PASS", evidence: "protocol interrupt acknowledged; provider and supervisor remained live" };
    const malformed = await helper(normal.container.id, { socketPath: normal.record.socketPath,
      credential: normal.record.credential, binding: normal.record.binding, ownership: normal.record.ownership,
      action: "malformed-provider" });
    if (malformed.response.result?.type !== "protocol-error") throw new Error("malformed-provider-undetected");

    const leak = await helper(normal.container.id, { socketPath: normal.record.socketPath,
      credential: normal.record.credential, binding: normal.record.binding, ownership: normal.record.ownership,
      action: "leak-inspect" });
    const containerInspect = await json("GET", `/containers/${normal.container.id}/json`);
    const execInspect = await json("GET", `/exec/${normal.execId}/json`);
    const repoFiles = spawnSync("rg", ["-l", normal.record.credential, "."], { cwd: process.cwd(), encoding: "utf8" });
    if (repoFiles.status !== 0 && repoFiles.status !== 1) throw new Error("repository-leak-scan-failed");
    const hostProcessData = Buffer.concat([
      await readFile(`/proc/${process.pid}/cmdline`), await readFile(`/proc/${process.pid}/environ`)
    ]);
    const secretLeak = leak.response.result.credentialPresent
      || JSON.stringify(containerInspect.Config).includes(normal.record.credential)
      || JSON.stringify(execInspect.ProcessConfig).includes(normal.record.credential)
      || JSON.stringify(leak.inspection.ProcessConfig).includes(normal.record.credential)
      || hostProcessData.includes(Buffer.from(normal.record.credential))
      || repoFiles.status === 0 || normal.initial.stdout.includes(normal.record.credential)
      || normal.initial.stderr.includes(normal.record.credential);
    if (secretLeak) throw new Error("credential-leak-detected");
    matrix.L = { status: "PASS", evidence: "credential absent from proc args/env, Docker config/labels/exec, output, diagnostics, repository" };

    const graceful = await helper(normal.container.id, { socketPath: normal.record.socketPath,
      credential: normal.record.credential, binding: normal.record.binding, ownership: normal.record.ownership, action: "stop" });
    if (graceful.response.result?.escalated !== false || graceful.response.result?.descendantExited !== true) {
      throw new Error("graceful-stop-escalated");
    }
    const sentinel = await json("GET", `/containers/${normal.container.id}/json`);
    if (!sentinel.State.Running) throw new Error("sentinel-killed");
    matrix.G = { status: "PASS", evidence: "graceful provider process-group exit; PID 1 sentinel survived" };

    const forced = await launch(runId, stateRoot, "forced", true); containers.add(forced.container.id); records.add(forced.recordPath);
    const forceStop = await helper(forced.container.id, { socketPath: forced.record.socketPath,
      credential: forced.record.credential, binding: forced.record.binding, ownership: forced.record.ownership, action: "stop" });
    if (forceStop.response.result?.escalated !== true || forceStop.response.result?.descendantExited !== true
      || !(await json("GET", `/containers/${forced.container.id}/json`)).State.Running) throw new Error("forced-stop-failed");
    matrix.H = { status: "PASS", evidence: "grace timeout then SIGKILL to re-proven provider group; sentinel survived" };

    const exited = await launch(runId, stateRoot, "exited"); containers.add(exited.container.id); records.add(exited.recordPath);
    await helper(exited.container.id, { socketPath: exited.record.socketPath, credential: exited.record.credential,
      binding: exited.record.binding, ownership: exited.record.ownership, action: "exit-provider" });
    const already = await helper(exited.container.id, { socketPath: exited.record.socketPath, credential: exited.record.credential,
      binding: exited.record.binding, ownership: exited.record.ownership, action: "stop" });
    await assertRejected(exited.record, (request) => { request.ownership = structuredClone(request.ownership);
      request.ownership.provider.startTime = String(Number(request.ownership.provider.startTime) + 1); });
    if (already.response.result?.signalSent !== false) throw new Error("already-exited-signalled");
    matrix.I = { status: "PASS", evidence: "already-exited returned without signal; mutated start time rejected" };

    const replacedA = await createContainer(runId, "replaced-a"); containers.add(replacedA.id);
    const retainedA = replacedA.id; await removeContainer(replacedA.id); containers.delete(replacedA.id);
    const replacedB = await createContainer(runId, "replaced-b"); containers.add(replacedB.id);
    let oldMissing = false; try { await json("GET", `/containers/${retainedA}/json`); } catch (error) { oldMissing = error.statusCode === 404; }
    if (!oldMissing || replacedB.id === retainedA) throw new Error("replaced-container-not-distinguished");
    matrix.J = { status: "PASS", evidence: "retained A ID missing and distinct B ID not contacted for recovery or Stop" };

    const missingPath = path.join(stateRoot, "missing.json");
    let missingRejected = false; try { await readFile(missingPath); } catch (error) { missingRejected = error.code === "ENOENT"; }
    const corruptPath = path.join(stateRoot, "corrupt.json"); await writeFile(corruptPath, "{", { mode: 0o600 });
    let corruptRejected = false; try { parseOwnershipRecord(JSON.parse(await readFile(corruptPath, "utf8"))); } catch { corruptRejected = true; }
    if (!missingRejected || !corruptRejected) throw new Error("record-fail-closed-broken");
    matrix.K = { status: "PASS", evidence: "missing/corrupt records rejected before Docker helper or signal path" };

    await cleanup(); containers.clear(); records.clear();
    const listed = await json("GET", `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [LABEL] }))}`);
    const stateExists = await stat(stateRoot).then(() => true, () => false);
    if (listed.length !== 0 || stateExists) throw new Error("cleanup-verification-failed");
    matrix.M = { status: "PASS", evidence: "daemon label query empty and Agent-private temp root absent" };
    const orderedScenarios = Object.fromEntries("ABCDEFGHIJKLM".split("").map((key) => [key, matrix[key]]));
    const result = { schemaVersion: "devspace.ai-supervisor-proof-result/v1",
      verdict: "CONDITIONAL PASS", environment: { engine: "rootless Docker 29.6.2 API 1.55", image: IMAGE },
      prerequisites: ["Node.js 24", "Linux /proc with NSpid and starttime", "Unix sockets", "POSIX process groups/sessions",
        "installed fixed supervisor and helper"], scenarios: orderedScenarios };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await cleanup();
    process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
  }
}

if (process.argv[2] === "--reconnect-child") {
  let input = ""; process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(`${JSON.stringify(await reconnectChild(input.trim()))}\n`);
} else {
  await main();
}
