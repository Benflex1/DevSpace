import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import {
  DockerMultiplexParser, parseOwnershipRecord, parseReadiness
} from "./core.mjs";

const SOCKET = process.env.DEVSPACE_DOCKER_SOCKET_PATH;
const IMAGE = "node:24-bookworm";
const LABEL = "devspace.ai-supervisor-proof";
const TOOL_ROOT = path.resolve("tooling/ai-supervisor-proof");
const EXEC_TIMEOUT = 15_000;
if (SOCKET !== "/run/devspace-docker/docker.sock") {
  throw new Error("proof-requires-dedicated-container-socket");
}

function api(method, requestPath, body, accepted = [200, 201, 204], contentType = "application/json") {
  const encoded = body === undefined ? undefined
    : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: SOCKET, method, path: requestPath,
      headers: encoded === undefined ? {} : {
        "content-type": contentType, "content-length": String(encoded.length)
      }
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) request.destroy(new Error("docker-response-too-large"));
        else chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => {
        if (accepted.includes(response.statusCode ?? 0)) resolve(Buffer.concat(chunks));
        else reject(Object.assign(new Error(`docker-api-${method}-${response.statusCode}`), {
          statusCode: response.statusCode
        }));
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error("docker-api-timeout")));
    request.on("error", reject);
    if (encoded !== undefined) request.write(encoded);
    request.end();
  });
}
async function json(method, requestPath, body, accepted) {
  const text = (await api(method, requestPath, body, accepted)).toString("utf8");
  try { return JSON.parse(text); } catch { throw new Error("docker-json-invalid"); }
}
async function removeContainer(id) {
  await api("DELETE", `/containers/${id}?force=1`, undefined, [204, 404]);
}

class CleanupCoordinator {
  #containers = new Set();
  #roots = new Set();
  #inflight = new Set();
  #promise;
  constructor(runId) { this.runId = runId; }
  registerRoot(root) { this.#roots.add(root); }
  trackCreation(promise) {
    this.#inflight.add(promise);
    promise.then((id) => this.#containers.add(id), () => {}).finally(() => this.#inflight.delete(promise));
    return promise;
  }
  trackContainer(id) { this.#containers.add(id); }
  forgetContainer(id) { this.#containers.delete(id); }
  cleanup() {
    this.#promise ??= (async () => {
      await Promise.allSettled([...this.#inflight]);
      const failures = [];
      for (const id of this.#containers) {
        try { await removeContainer(id); } catch { failures.push("container-removal-failed"); }
      }
      for (const root of this.#roots) {
        try { await rm(root, { recursive: true, force: true }); } catch { failures.push("state-removal-failed"); }
      }
      const filters = encodeURIComponent(JSON.stringify({ label: [`${LABEL}=${this.runId}`] }));
      const remaining = await json("GET", `/containers/json?all=1&filters=${filters}`);
      if (remaining.length > 0) failures.push("proof-container-audit-failed");
      if (failures.length > 0) throw new Error(failures.join(","));
    })();
    return this.#promise;
  }
}

async function createExec(containerId, command, counter) {
  counter?.set(containerId, (counter.get(containerId) ?? 0) + 1);
  const response = await json("POST", `/containers/${containerId}/exec`, {
    AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false,
    Cmd: command, WorkingDir: "/tooling/ai-supervisor-proof", Env: []
  });
  return response.Id;
}

function startExec(execId, stdin, { readiness = false } = {}) {
  const encoded = Buffer.from('{"Detach":false,"Tty":false}');
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: SOCKET, method: "POST", path: `/exec/${execId}/start`,
      headers: {
        "content-type": "application/json", "content-length": String(encoded.length),
        connection: "Upgrade", upgrade: "tcp"
      }
    });
    let settled = false;
    const timer = setTimeout(() => fail(new Error("exec-lifetime-timeout")), EXEC_TIMEOUT);
    const parser = new DockerMultiplexParser();
    const streams = { stdout: [], stderr: [] };
    function finish(socket, requireEnd) {
      if (settled) return;
      try {
        if (requireEnd) parser.finish();
        const output = {
          stdout: Buffer.concat(streams.stdout).toString("utf8"),
          stderr: Buffer.concat(streams.stderr).toString("utf8")
        };
        if (readiness) parseReadiness(output.stdout, output.stderr);
        settled = true;
        clearTimeout(timer);
        if (readiness) socket.destroy();
        resolve({ ...output, socket });
      } catch (error) {
        const privateText = Buffer.concat(streams.stderr).toString("utf8");
        const classification = [
          "fixture-process-group-unproven", "process-topology-unstable-or-escaped",
          "invalid-bootstrap", "fixture-process-group-topology-churn"
        ].find((token) => privateText.includes(token));
        fail(classification === undefined ? error : new Error(`supervisor-bootstrap-${classification}`));
      }
    }
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
    request.once("upgrade", (_response, socket, head) => {
      const consume = (chunk) => {
        try {
          for (const frame of parser.push(Buffer.from(chunk))) streams[frame.kind].push(frame.payload);
          if (readiness) {
            const stdout = Buffer.concat(streams.stdout).toString("utf8");
            const stderr = Buffer.concat(streams.stderr).toString("utf8");
            if (stdout.endsWith("\n")) {
              parseReadiness(stdout, stderr);
              finish(socket, false);
            }
          }
        } catch (error) { socket.destroy(); fail(error); }
      };
      if (head.length > 0) consume(head);
      socket.on("data", consume);
      socket.once("end", () => finish(socket, true));
      socket.once("error", fail);
      socket.write(Buffer.from(`${stdin}\n`));
    });
    request.once("response", (response) => fail(new Error(`exec-start-http-${response.statusCode}`)));
    request.once("error", fail);
    request.end(encoded);
  });
}

async function uploadTooling(containerId, inject) {
  if (inject === "during-archive-upload") throw new Error("injected-during-archive-upload");
  const repositoryRoot = path.dirname(path.dirname(TOOL_ROOT));
  const archive = spawnSync("tar", ["-C", repositoryRoot, "-cf", "-", "tooling/ai-supervisor-proof"], {
    encoding: null, maxBuffer: 8 * 1024 * 1024
  });
  if (archive.status !== 0) throw new Error("proof-archive-failed");
  await api("PUT", `/containers/${containerId}/archive?path=/`, archive.stdout, [200], "application/x-tar");
}

async function createContainer(runId, suffix, cleanup, inject = null, fixedName = null) {
  const name = fixedName ?? `devspace-ai-proof-${runId}-${suffix}`;
  const creation = json("POST", `/containers/create?name=${name}`, {
    Image: IMAGE,
    Cmd: ["node", "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    WorkingDir: "/tmp",
    Labels: { [LABEL]: runId, "devspace.managed": "proof-only" },
    HostConfig: {
      Privileged: false, NetworkMode: "none", PidMode: "", IpcMode: "private",
      CgroupnsMode: "private", AutoRemove: false, ReadonlyRootfs: false,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 }, CapAdd: [], CapDrop: [],
      Devices: [], SecurityOpt: ["no-new-privileges:true"], PidsLimit: 128
    }
  }).then((created) => created.Id);
  const id = await cleanup.trackCreation(creation);
  if (inject === "after-container-create") throw new Error("injected-after-container-create");
  await uploadTooling(id, inject);
  await api("POST", `/containers/${id}/start`);
  if (inject === "after-start") throw new Error("injected-after-start");
  const inspected = await json("GET", `/containers/${id}/json`);
  if (inspected.Id !== id || inspected.State.Running !== true) throw new Error("container-identity-unproven");
  return { id, name };
}

function binding(containerId, execId, generation = 1) {
  return {
    schemaVersion: "devspace.ai-supervisor-proof-binding/v1",
    projectId: "01990000-0000-7000-8000-000000000001",
    workspaceId: "01990000-0000-7000-8000-000000000002",
    configurationRevisionId: "01990000-0000-7000-8000-000000000003",
    runtimePlanHash: `sha256-runtime-plan-v1:${"a".repeat(64)}`,
    runtimeGeneration: 7,
    containerId,
    aiSessionId: "01990000-0000-7000-8000-000000000004",
    profileId: "proof-profile",
    profileRevision: `sha256-ai-profile-v1:${"b".repeat(64)}`,
    processGeneration: generation,
    operationId: "01990000-0000-7000-8000-000000000005",
    dockerExecId: execId
  };
}
const request = (record, action, payload = null, requestId = randomUUID()) => ({
  socketPath: record.socketPath,
  action,
  binding: record.binding,
  credential: record.credential,
  ownership: action === "establish" ? null : record.ownership,
  payload,
  requestId
});

async function helper(containerId, control, counter, inject = null) {
  const execId = await createExec(containerId, [
    "node", "/tooling/ai-supervisor-proof/control-client.mjs"
  ], counter);
  if (inject === "during-helper-reconnect") throw new Error("injected-during-helper-reconnect");
  const output = await startExec(execId, JSON.stringify(control));
  if (output.stderr !== "") throw new Error("helper-private-diagnostic");
  let response;
  try { response = JSON.parse(output.stdout.trim()); } catch { throw new Error("helper-response-invalid"); }
  return { execId, response, inspection: await json("GET", `/exec/${execId}/json`) };
}

async function launch(runId, stateRoot, suffix, cleanup, counter, fixtureMode = "cooperative", inject = null) {
  const container = await createContainer(runId, suffix, cleanup, inject);
  const execId = await createExec(container.id, [
    "node", "/tooling/ai-supervisor-proof/supervisor.mjs"
  ], counter);
  const bound = binding(container.id, execId);
  const credential = randomBytes(32).toString("hex");
  const socketPath = `/tmp/devspace-ai-proof/${bound.aiSessionId}-${bound.processGeneration}.sock`;
  const bootstrap = {
    format: "devspace.ai-supervisor-proof-bootstrap/v2",
    credential, socketPath, binding: bound, fixtureMode
  };
  if (inject === "during-supervisor-bootstrap") throw new Error("injected-during-supervisor-bootstrap");
  const initial = await startExec(execId, JSON.stringify(bootstrap), { readiness: true });
  const execInspection = await json("GET", `/exec/${execId}/json`);
  if (execInspection.ID !== execId || execInspection.ContainerID !== container.id
    || !execInspection.Running || !Number.isSafeInteger(execInspection.Pid)) {
    throw new Error("docker-exec-identity-unproven");
  }
  const provisional = { socketPath, credential, binding: bound, ownership: null };
  const established = await helper(container.id, request(provisional, "establish"), counter);
  if (!established.response.ok) throw new Error("supervisor-establish-rejected");
  const ownership = {
    ...established.response.result.ownership,
    dockerExecProcess: {
      outerPid: execInspection.Pid,
      bindingMethod: "authenticated-exact-exec-stdin-bootstrap"
    }
  };
  const recordPath = path.join(stateRoot, `${suffix}.json`);
  const record = {
    format: "devspace.ai-supervisor-proof-record/v2",
    credential, socketPath, binding: bound, ownership,
    containerId: container.id, supervisorExecId: execId
  };
  await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(recordPath, 0o600);
  if (inject === "after-ownership-record-write") throw new Error("injected-after-ownership-record-write");
  if ((await stat(recordPath)).mode & 0o077) throw new Error("ownership-record-permissions");
  return { container, execId, execInspection, record, recordPath, initial };
}

async function loadRecord(recordPath, expectedBinding, expectedOwnership = null) {
  const text = await readFile(recordPath, "utf8");
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("ownership-record-invalid"); }
  const record = parseOwnershipRecord(value, expectedBinding);
  if (expectedOwnership !== null && !isDeepStrictEqual(record.ownership, expectedOwnership)) {
    throw new Error("ownership-record-object-mismatch");
  }
  return record;
}

async function recoveryEntry(
  recordPath, expectedBinding, action, counter, inject = null, expectedOwnership = null
) {
  const record = await loadRecord(recordPath, expectedBinding, expectedOwnership);
  let container;
  try { container = await json("GET", `/containers/${record.containerId}/json`); } catch {
    throw new Error("owned-container-unavailable");
  }
  if (container.Id !== record.containerId || container.State.Running !== true) {
    throw new Error("owned-container-mismatch");
  }
  const execInspection = await json("GET", `/exec/${record.supervisorExecId}/json`);
  if (execInspection.ID !== record.supervisorExecId
    || execInspection.ContainerID !== record.containerId
    || execInspection.Pid !== record.ownership.dockerExecProcess.outerPid
    || !execInspection.Running) throw new Error("owned-exec-mismatch");
  return helper(record.containerId, request(record, action), counter, inject);
}

async function separateHostReconnect(recordPath, expectedBinding, expectedOwnership) {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "--reconnect-child"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { DEVSPACE_DOCKER_SOCKET_PATH: SOCKET }
  });
  child.stdin.end(`${JSON.stringify({ recordPath, expectedBinding, expectedOwnership })}\n`);
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 128 * 1024) child.kill("SIGKILL");
    (stream === child.stdout ? stdout : stderr).push(Buffer.from(chunk));
  });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  if (code !== 0) throw new Error("reconnect-child-failed");
  return JSON.parse(Buffer.concat(stdout).toString("utf8"));
}

async function probeCgroups(runId, cleanup, counter) {
  const container = await createContainer(runId, "cgroup", cleanup);
  const execId = await createExec(container.id, [
    "node", "/tooling/ai-supervisor-proof/cgroup-probe.mjs"
  ], counter);
  const output = await startExec(execId, "");
  if (output.stderr !== "") throw new Error("cgroup-probe-diagnostic");
  const probe = JSON.parse(output.stdout.trim());
  const name = `devspace-ai-proof-${runId}-writable-cgroup`;
  let rootlessWritableCgroup = "unexpectedly-started";
  const creation = json("POST", `/containers/create?name=${name}`, {
    Image: IMAGE, Cmd: ["node", "-e", "setInterval(()=>{},1000)"],
    Labels: { [LABEL]: runId },
    HostConfig: {
      NetworkMode: "none", CgroupnsMode: "private", CapAdd: [], CapDrop: [],
      SecurityOpt: ["no-new-privileges:true", "writable-cgroups=true"]
    }
  }).then((created) => created.Id);
  const candidate = await cleanup.trackCreation(creation);
  try { await api("POST", `/containers/${candidate}/start`); } catch (error) {
    rootlessWritableCgroup = error.statusCode === 500
      ? "rejected-by-rootless-user-namespace" : "docker-start-rejected";
  }
  if (rootlessWritableCgroup === "unexpectedly-started") {
    throw new Error("writable-cgroup-capability-requires-review");
  }
  return { ...probe, rootlessWritableCgroup };
}

async function expectReject(operation) {
  try { await operation(); } catch { return; }
  throw new Error("expected-rejection-missing");
}

async function assertNoProofResources(stateRoot, runId) {
  const filters = encodeURIComponent(JSON.stringify({ label: [`${LABEL}=${runId}`] }));
  const listed = await json("GET", `/containers/json?all=1&filters=${filters}`);
  const rootExists = await stat(stateRoot).then(() => true, () => false);
  if (listed.length !== 0 || rootExists) throw new Error("cleanup-verification-failed");
}

async function failureInjectionMatrix(runId) {
  const stages = [
    "after-container-create", "during-archive-upload", "after-start",
    "during-supervisor-bootstrap", "after-ownership-record-write", "during-helper-reconnect"
  ];
  for (const stage of stages) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "devspace-ai-proof-"));
    await chmod(stateRoot, 0o700);
    const stageRunId = `${runId}-${stages.indexOf(stage)}`;
    const cleanup = new CleanupCoordinator(stageRunId);
    cleanup.registerRoot(stateRoot);
    const counter = new Map();
    try {
      if (stage === "during-helper-reconnect") {
        const launched = await launch(stageRunId, stateRoot, `inject-${stage}`, cleanup, counter);
        await recoveryEntry(launched.recordPath, launched.record.binding, "proof", counter, stage);
      } else {
        await launch(stageRunId, stateRoot, `inject-${stage}`, cleanup, counter, "cooperative", stage);
      }
      throw new Error("failure-injection-not-triggered");
    } catch (error) {
      if (error.message === "failure-injection-not-triggered") throw error;
    } finally {
      await cleanup.cleanup();
    }
    await assertNoProofResources(stateRoot, stageRunId);
  }
  return stages;
}

async function signalChild(runId) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "devspace-ai-proof-"));
  await chmod(stateRoot, 0o700);
  const cleanup = new CleanupCoordinator(runId);
  cleanup.registerRoot(stateRoot);
  await createContainer(runId, "signal", cleanup);
  const keepAlive = setInterval(() => {}, 1_000);
  const signalled = new Promise((resolve, reject) => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        void cleanup.cleanup().then(resolve, reject);
      });
    }
  });
  process.stdout.write(`${JSON.stringify({ type: "signal-ready", stateRoot })}\n`);
  try { await signalled; } finally { clearInterval(keepAlive); }
}

async function signalCleanupMatrix(runId) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const signalRunId = `${runId}-${signal.toLowerCase()}`;
    const child = spawn(process.execPath, [
      new URL(import.meta.url).pathname, "--signal-child", signalRunId
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { DEVSPACE_DOCKER_SOCKET_PATH: SOCKET }
    });
    let stdout = "";
    let stderr = "";
    let stateRoot;
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("signal-child-start-timeout")), 15_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > 16_384) {
          reject(new Error("signal-child-output-too-large"));
          return;
        }
        if (!stdout.includes("\n")) return;
        try {
          const message = JSON.parse(stdout.slice(0, stdout.indexOf("\n")));
          if (message.type !== "signal-ready") throw new Error();
          stateRoot = message.stateRoot;
          clearTimeout(timer);
          resolve();
        } catch { reject(new Error("signal-child-readiness-invalid")); }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (Buffer.byteLength(stderr) > 16_384) reject(new Error("signal-child-diagnostic-too-large"));
      });
    });
    await ready;
    child.kill(signal);
    const outcome = await new Promise((resolve) => child.once("exit", (code, exitSignal) => {
      resolve({ code, exitSignal });
    }));
    if (outcome.code !== 0 || outcome.exitSignal !== null || stderr !== "") {
      throw new Error(`signal-child-cleanup-failed-${outcome.code}-${outcome.exitSignal}-${stderr.length}`);
    }
    await assertNoProofResources(stateRoot, signalRunId);
  }
  return ["SIGINT", "SIGTERM"];
}

async function main() {
  const runId = randomUUID().slice(0, 8);
  const stateRoot = await mkdtemp(path.join(tmpdir(), "devspace-ai-proof-"));
  await chmod(stateRoot, 0o700);
  const cleanup = new CleanupCoordinator(runId);
  cleanup.registerRoot(stateRoot);
  const execCounter = new Map();
  const matrix = {};
  let signalSeen = null;
  const onSignal = (signal) => {
    signalSeen = signal;
    void cleanup.cleanup().then(() => { process.exitCode = 128 + (signal === "SIGINT" ? 2 : 15); });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await api("GET", "/_ping");
    const info = await json("GET", "/info");
    if (!info.SecurityOptions?.some((value) => /rootless/iu.test(value))) {
      throw new Error("daemon-not-rootless");
    }
    const cgroup = await probeCgroups(runId, cleanup, execCounter);

    const normal = await launch(runId, stateRoot, "normal", cleanup, execCounter);
    const roundTrip = await helper(normal.container.id, request(normal.record, "send", {
      operationId: "normal-round-trip", value: "fixture"
    }), execCounter);
    if (roundTrip.response.result?.type !== "echo") throw new Error("round-trip-failed");
    matrix.A = { status: "PASS", action: "launched and authenticated exact exec/supervisor/provider chain",
      evidence: "direct child, stable start identity, coherent bounded topology, JSONL round trip",
      sideEffect: "one correlated provider input", cleanup: "tracked" };

    const reconnect = await separateHostReconnect(
      normal.recordPath, normal.record.binding, normal.record.ownership
    );
    if (!reconnect.response.ok) throw new Error("reconnect-rejected");
    const continued = await recoveryEntry(
      normal.recordPath, normal.record.binding, "proof", execCounter
    );
    if (!continued.response.ok) throw new Error("reconnect-proof-rejected");
    matrix.B = { status: "PASS", action: "destroyed launch attachment and used separate host process/new helper exec",
      evidence: "exact container and supervisor exec re-inspected before authenticated socket access",
      sideEffect: "new helper only after identity verification", cleanup: "tracked" };

    const baseline = await recoveryEntry(normal.recordPath, normal.record.binding, "proof", execCounter);
    const wrongCredential = structuredClone(request(normal.record, "proof"));
    wrongCredential.credential = "0".repeat(64);
    const rejectedCredential = await helper(normal.container.id, wrongCredential, execCounter);
    if (rejectedCredential.response.code !== "authentication-failed") throw new Error("wrong-credential-accepted");
    matrix.C = { status: "PASS", action: "sent wrong credential through real helper",
      evidence: "authentication-failed and unchanged event sequence", sideEffect: "none",
      cleanup: "tracked" };

    for (const mutation of [
      (value) => { value.binding.aiSessionId = "01990000-0000-7000-8000-000000000099"; },
      (value) => { value.binding.processGeneration += 1; }
    ]) {
      const altered = structuredClone(request(normal.record, "proof"));
      mutation(altered);
      if ((await helper(normal.container.id, altered, execCounter)).response.ok !== false) {
        throw new Error("generation-claim-accepted");
      }
    }
    matrix.D = { status: "PASS", action: "mutated session and process generation on real socket",
      evidence: "both rejected without generation fallback", sideEffect: "none", cleanup: "tracked" };

    for (const field of ["containerId", "workspaceId", "profileRevision", "runtimeGeneration", "dockerExecId"]) {
      const altered = structuredClone(request(normal.record, "proof"));
      altered.binding[field] = typeof altered.binding[field] === "number"
        ? altered.binding[field] + 1
        : field.endsWith("Id") && ["containerId", "dockerExecId"].includes(field)
          ? "f".repeat(64)
          : field === "profileRevision" ? `sha256-ai-profile-v1:${"c".repeat(64)}`
            : "01990000-0000-7000-8000-000000000099";
      if ((await helper(normal.container.id, altered, execCounter)).response.ok !== false) {
        throw new Error(`mutated-binding-accepted-${field}`);
      }
    }
    const afterReject = await recoveryEntry(normal.recordPath, normal.record.binding, "proof", execCounter);
    if (afterReject.response.result.eventSequence !== baseline.response.result.eventSequence) {
      throw new Error("rejection-had-provider-side-effect");
    }
    matrix.E = { status: "PASS", action: "mutated five immutable fields independently",
      evidence: "strict schema/equality rejection and stable event sequence", sideEffect: "none",
      cleanup: "tracked" };

    const interruptId = randomUUID();
    const interruptRequest = request(normal.record, "interrupt", null, interruptId);
    const interrupted = await helper(normal.container.id, interruptRequest, execCounter);
    const duplicate = await helper(normal.container.id, interruptRequest, execCounter);
    if (interrupted.response.result?.type !== "interrupted"
      || JSON.stringify(interrupted.response) !== JSON.stringify(duplicate.response)) {
      throw new Error("interrupt-correlation-failed");
    }
    matrix.F = { status: "PASS", action: "correlated cooperative interrupt and exact duplicate",
      evidence: "post-baseline request ID match; idempotent duplicate; provider remained live",
      sideEffect: "one provider interrupt", cleanup: "tracked" };

    const graceful = await helper(
      normal.container.id, request(normal.record, "fixture-stop"), execCounter
    );
    if (graceful.response.result?.authority !== "fixture-process-group-experiment"
      || graceful.response.result?.escalated !== false
      || !(await json("GET", `/containers/${normal.container.id}/json`)).State.Running) {
      throw new Error("fixture-graceful-experiment-failed");
    }
    matrix.G = { status: "PARTIAL", action: "sent SIGTERM to rechecked cooperative fixture PGID",
      evidence: "fixture descendants exited; unrelated PID 1 sentinel/container survived",
      sideEffect: "fixture-only group signal", cleanup: "tracked",
      limitation: "numeric PGID is non-atomic/reusable and not production Stop authority" };

    const forced = await launch(runId, stateRoot, "forced", cleanup, execCounter, "ignore-term");
    const forcedResult = await helper(
      forced.container.id, request(forced.record, "fixture-stop"), execCounter
    );
    if (forcedResult.response.result?.escalated !== true
      || !(await json("GET", `/containers/${forced.container.id}/json`)).State.Running) {
      throw new Error("fixture-force-experiment-failed");
    }
    for (const mode of ["setsid-child", "double-fork", "group-churn"]) {
      await expectReject(() => launch(runId, stateRoot, `adversarial-${mode}`, cleanup, execCounter, mode));
    }
    matrix.H = { status: "BLOCKED", action: "probed cgroup delegation and adversarial fixture escape/churn",
      evidence: "cgroup filesystem read-only; rootless writable-cgroups start rejected; escapes/churn invalidate PGID proof",
      sideEffect: "fixture-only escalation executed; no production-safe boundary", cleanup: "tracked",
      limitation: "atomic descendant-tree termination unavailable" };

    const exited = await launch(runId, stateRoot, "exited", cleanup, execCounter);
    await helper(exited.container.id, request(exited.record, "exit-provider"), execCounter);
    const already = await helper(exited.container.id, request(exited.record, "fixture-stop"), execCounter);
    const stale = structuredClone(request(exited.record, "proof"));
    stale.ownership.provider.startTime = String(BigInt(stale.ownership.provider.startTime) + 1n);
    if (already.response.result?.signalSent !== false
      || (await helper(exited.container.id, stale, execCounter)).response.ok !== false) {
      throw new Error("already-exited-safety-failed");
    }
    matrix.I = { status: "PASS", action: "exited provider then invoked fixture stop and stale-start proof",
      evidence: "no signal sent after exit; start-time mismatch rejected", sideEffect: "none after exit",
      cleanup: "tracked", limitation: "deterministic PID reuse not forced" };

    const replaced = await launch(runId, stateRoot, "replaced", cleanup, execCounter);
    const staleRecord = replaced.recordPath;
    const staleBinding = replaced.record.binding;
    const oldId = replaced.container.id;
    const oldName = replaced.container.name;
    await removeContainer(oldId);
    cleanup.forgetContainer(oldId);
    const replacement = await createContainer(runId, "replacement", cleanup, null, oldName);
    const beforeB = execCounter.get(replacement.id) ?? 0;
    await expectReject(() => recoveryEntry(staleRecord, staleBinding, "proof", execCounter));
    await expectReject(() => recoveryEntry(staleRecord, staleBinding, "fixture-stop", execCounter));
    const afterB = execCounter.get(replacement.id) ?? 0;
    if (replacement.id === oldId || beforeB !== afterB
      || !(await json("GET", `/containers/${replacement.id}/json`)).State.Running) {
      throw new Error("replaced-container-contacted");
    }
    matrix.J = { status: "PASS", action: "replaced A with B under the same name; invoked real recovery and signal-capable entry",
      evidence: "exact A ID 404 rejected before helper; B helper-exec counter unchanged and sentinel live",
      sideEffect: "none in B", cleanup: "A removed, B tracked separately" };

    const corruptCases = [];
    const base = structuredClone(normal.record);
    const values = [
      "", "{", JSON.stringify({ ...base, extra: true }),
      JSON.stringify({ ...base, format: "wrong" }),
      JSON.stringify({ ...base, containerId: "f".repeat(64) }),
      JSON.stringify({ ...base, supervisorExecId: "f".repeat(64) }),
      JSON.stringify({ ...base, ownership: { ...base.ownership, supervisor: undefined } }),
      JSON.stringify({ ...base, ownership: { ...base.ownership,
        provider: { ...base.ownership.provider, nspid: ["bad"] } } }),
      JSON.stringify({ ...base, binding: { ...base.binding, processGeneration: 99 } }),
      JSON.stringify({ ...base, ownership: { ...base.ownership,
        provider: { ...base.ownership.provider,
          startTime: String(BigInt(base.ownership.provider.startTime) + 1n) } } }),
      JSON.stringify(forced.record)
    ];
    const missing = path.join(stateRoot, "missing.json");
    const execBeforeK = [...execCounter.values()].reduce((sum, value) => sum + value, 0);
    for (const [index, value] of [null, ...values].entries()) {
      const testPath = index === 0 ? missing : path.join(stateRoot, `corrupt-${index}.json`);
      if (index > 0) await writeFile(testPath, value, { mode: 0o600 });
      await expectReject(() => recoveryEntry(
        testPath, normal.record.binding, "proof", execCounter, null, normal.record.ownership
      ));
      await expectReject(() => recoveryEntry(
        testPath, normal.record.binding, "fixture-stop", execCounter, null, normal.record.ownership
      ));
      corruptCases.push(index === 0 ? "missing" : `case-${index}`);
    }
    const execAfterK = [...execCounter.values()].reduce((sum, value) => sum + value, 0);
    if (execBeforeK !== execAfterK) throw new Error("corrupt-record-created-helper");
    matrix.K = { status: "PASS", action: "ran real recovery and signal-capable entries across strict corrupt-record corpus",
      evidence: `${corruptCases.length} cases rejected before Docker helper creation; exec count unchanged`,
      sideEffect: "none", cleanup: "temp corpus under tracked root",
      limitation: "proof-local validators are not production request authority" };

    const leakTarget = forced;
    const leak = await helper(leakTarget.container.id, request(leakTarget.record, "leak-inspect"), execCounter);
    const inspections = [
      await json("GET", `/containers/${leakTarget.container.id}/json`),
      await json("GET", `/exec/${leakTarget.execId}/json`),
      leak.inspection
    ];
    const hostBytes = Buffer.concat([
      await readFile(`/proc/${process.pid}/cmdline`), await readFile(`/proc/${process.pid}/environ`)
    ]);
    const repositorySearch = spawnSync("rg", ["-l", leakTarget.record.credential, "."], {
      cwd: process.cwd(), encoding: "utf8"
    });
    const stateMode = (await stat(stateRoot)).mode & 0o777;
    const recordMode = (await stat(leakTarget.recordPath)).mode & 0o777;
    if (leak.response.result.credentialPresent
      || inspections.some((value) => JSON.stringify(value).includes(leakTarget.record.credential))
      || hostBytes.includes(Buffer.from(leakTarget.record.credential))
      || repositorySearch.status === 0 || stateMode !== 0o700 || recordMode !== 0o600
      || leakTarget.initial.stdout.includes(leakTarget.record.credential)
      || leakTarget.initial.stderr.includes(leakTarget.record.credential)) {
      throw new Error("credential-leak-detected");
    }
    matrix.L = { status: "PARTIAL", action: "live credential scan of runner, container processes, Docker configs, output, and repository",
      evidence: "absent in inspected argv/env/config/labels/exec/output; state 0700 and record 0600",
      sideEffect: "read-only inspection", cleanup: "tracked",
      limitation: "coverage is the enumerated success and sanitized-error paths, not universal future failures" };

    const injected = await failureInjectionMatrix(`${runId}-inject`);
    const signals = await signalCleanupMatrix(`${runId}-signal`);
    await cleanup.cleanup();
    await assertNoProofResources(stateRoot, runId);
    matrix.M = { status: "PASS", action: "idempotent cleanup plus six injected failures",
      evidence: `daemon label and temp-root audits empty after ${injected.join(", ")} and ${signals.join("/")}`,
      sideEffect: "exact tracked disposable containers removed", cleanup: "verified" };

    const ordered = Object.fromEntries("ABCDEFGHIJKLM".split("").map((key) => [key, matrix[key]]));
    const result = {
      schemaVersion: "devspace.ai-supervisor-proof-result/v2",
      verdict: "BLOCKED",
      blocker: "production-safe descendant termination boundary not proven",
      environment: { engineClass: "dedicated rootless Docker", image: IMAGE },
      cgroup,
      scenarios: ordered
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    if (signalSeen === null) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
    await cleanup.cleanup();
  }
}

if (process.argv[2] === "--reconnect-child") {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 128 * 1024) throw new Error("reconnect-input-too-large");
  }
  const { recordPath, expectedBinding, expectedOwnership } = JSON.parse(input);
  const counter = new Map();
  const result = await recoveryEntry(
    recordPath, expectedBinding, "proof", counter, null, expectedOwnership
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (process.argv[2] === "--signal-child") {
  await signalChild(process.argv[3]);
} else {
  await main();
}
