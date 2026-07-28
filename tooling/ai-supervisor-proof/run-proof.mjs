import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import {
  beginProofShutdown, classifyCgroupProbe, CleanupLifecycle, deriveSocketPath,
  DockerMultiplexParser, isProofOperationAborted, parseOwnershipRecord, parseReadinessFrames,
  ProofOperationAbortedError, ProofOperationFence, spawnConfigurationContainsSecret
} from "./core.mjs";

const SOCKET = process.env.DEVSPACE_DOCKER_SOCKET_PATH;
const IMAGE = "node:24-bookworm";
const LABEL = "devspace.ai-supervisor-proof";
const TOOL_ROOT = path.resolve("tooling/ai-supervisor-proof");
const EXEC_TIMEOUT = 15_000;
if (SOCKET !== "/run/devspace-docker/docker.sock") {
  throw new Error("proof-requires-dedicated-container-socket");
}

function dockerRequest(
  operation,
  method,
  requestPath,
  body,
  accepted = [200, 201, 204],
  contentType = "application/json",
  onStarted = null
) {
  const encoded = body === undefined ? undefined
    : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  operation?.mark("docker-request");
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
      response.on("end", async () => {
        try {
          await startedGate;
          operation?.assertOpen();
          if (accepted.includes(response.statusCode ?? 0)) resolve(Buffer.concat(chunks));
          else {
            const responseBody = Buffer.concat(chunks).toString("utf8");
            const safeReason = /conflicts with user namespaces and rootless mode/iu.test(responseBody)
              ? "rootless-user-namespace-conflict"
              : "unclassified";
            reject(Object.assign(new Error(`docker-api-${method}-${response.statusCode}`), {
              statusCode: response.statusCode,
              safeReason
            }));
          }
        } catch (error) { reject(error); }
      });
    });
    const abort = () => request.destroy(new ProofOperationAbortedError());
    operation?.signal.addEventListener("abort", abort, { once: true });
    request.setTimeout(10_000, () => request.destroy(new Error("docker-api-timeout")));
    request.on("error", reject);
    request.on("close", () => operation?.signal.removeEventListener("abort", abort));
    operation?.assertOpen();
    if (encoded !== undefined) request.write(encoded);
    request.end();
    const startedGate = onStarted === null ? Promise.resolve() : Promise.resolve().then(onStarted);
    startedGate.catch((error) => request.destroy(error));
  });
}
function api(operation, method, requestPath, body, accepted, contentType, onStarted) {
  if (!(operation instanceof ProofOperationFence)) throw new Error("proof-operation-fence-required");
  return dockerRequest(
    operation, method, requestPath, body, accepted, contentType, onStarted
  );
}
function cleanupApi(method, requestPath, body, accepted, contentType, onStarted) {
  return dockerRequest(
    null, method, requestPath, body, accepted, contentType, onStarted
  );
}
async function json(operation, method, requestPath, body, accepted) {
  const text = (await api(operation, method, requestPath, body, accepted)).toString("utf8");
  try { return JSON.parse(text); } catch { throw new Error("docker-json-invalid"); }
}
async function cleanupJson(method, requestPath, body, accepted) {
  const text = (await cleanupApi(method, requestPath, body, accepted)).toString("utf8");
  try { return JSON.parse(text); } catch { throw new Error("docker-json-invalid"); }
}
async function removeContainer(id) {
  await cleanupApi("DELETE", `/containers/${id}?force=1`, undefined, [204, 404]);
}

function createCleanupCoordinator(runId) {
  return new CleanupLifecycle({
    removeContainer,
    removeRoot: (root) => rm(root, { recursive: true, force: true }),
    audit: async () => {
      const filters = encodeURIComponent(JSON.stringify({ label: [`${LABEL}=${runId}`] }));
      const remaining = await cleanupJson("GET", `/containers/json?all=1&filters=${filters}`);
      const named = (await cleanupJson("GET", "/containers/json?all=1"))
        .filter((item) => item.Names?.some((name) =>
          name.startsWith(`/devspace-ai-proof-${runId}`)));
      if (remaining.length > 0 || named.length > 0) throw new Error("proof-container-audit-failed");
    }
  });
}

function createLifecycleHooks({ failStage = null, pauseStage = null, signal = null, onPause = null } = {}) {
  return {
    async reached(stage) {
      if (failStage === stage) throw new Error(`injected-${stage}`);
      if (pauseStage !== stage) return;
      onPause?.(stage);
      await new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("proof-aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(
          signal.reason ?? new Error("proof-aborted")
        ), { once: true });
      });
    }
  };
}

async function createExec(operation, containerId, command, counter) {
  operation.assertOpen();
  counter?.set(containerId, (counter.get(containerId) ?? 0) + 1);
  const response = await json(operation, "POST", `/containers/${containerId}/exec`, {
    AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false,
    Cmd: command, WorkingDir: "/tooling/ai-supervisor-proof", Env: []
  });
  operation.assertOpen();
  return response.Id;
}

function startExec(operation, execId, stdin, { readiness = false, onStarted = null } = {}) {
  operation.mark("docker-exec-start");
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
    const frames = [];
    let readinessObserved = false;
    let readinessTimer;
    let startGateReady = onStarted === null;
    let upgradedSocket;
    const abort = () => {
      upgradedSocket?.destroy();
      request.destroy(new ProofOperationAbortedError());
    };
    function finish(socket, requireEnd) {
      if (settled) return;
      try {
        operation.assertOpen();
        if (requireEnd) parser.finish(); else parser.assertBoundary();
        if (readiness && parser.frameCount !== 1) throw new Error("supervisor-readiness-frame-count");
        const streams = { stdout: [], stderr: [] };
        for (const frame of frames) streams[frame.kind].push(frame.payload);
        const output = {
          stdout: Buffer.concat(streams.stdout).toString("utf8"),
          stderr: Buffer.concat(streams.stderr).toString("utf8")
        };
        if (readiness) parseReadinessFrames(frames);
        settled = true;
        clearTimeout(timer);
        operation.signal.removeEventListener("abort", abort);
        if (readiness) socket.destroy();
        resolve({ ...output, socket });
      } catch (error) {
        const privateText = Buffer.concat(
          frames.filter((frame) => frame.kind === "stderr").map((frame) => frame.payload)
        ).toString("utf8");
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
      operation.signal.removeEventListener("abort", abort);
      reject(error);
    }
    request.once("upgrade", (_response, socket, head) => {
      upgradedSocket = socket;
      try { operation.assertOpen(); } catch (error) {
        socket.destroy();
        fail(error);
        return;
      }
      const consume = (chunk) => {
        try {
          const parsed = parser.push(Buffer.from(chunk));
          frames.push(...parsed);
          if (readiness) {
            if (readinessObserved) {
              parser.assertBoundary();
              if (parsed.length > 0) throw new Error("supervisor-readiness-extra-frame");
            }
            if (frames.length > 1) throw new Error("supervisor-readiness-extra-frame");
            if (frames.length === 1) {
              parseReadinessFrames(frames);
              parser.assertBoundary();
              readinessObserved = true;
              clearTimeout(readinessTimer);
              readinessTimer = setTimeout(() => {
                if (startGateReady) finish(socket, false);
              }, 20);
            }
          }
        } catch (error) { socket.destroy(); fail(error); }
      };
      if (head.length > 0) consume(head);
      socket.on("data", consume);
      socket.once("end", () => finish(socket, true));
      socket.once("error", fail);
      try {
        operation.mark("control-input");
      } catch (error) {
        socket.destroy();
        fail(error);
        return;
      }
      socket.write(Buffer.from(`${stdin}\n`));
      if (onStarted !== null) {
        Promise.resolve().then(onStarted).then(() => {
          try {
            operation.assertOpen();
            startGateReady = true;
            if (readinessObserved) {
              clearTimeout(readinessTimer);
              readinessTimer = setTimeout(() => finish(socket, false), 20);
            }
          } catch (error) {
            socket.destroy();
            fail(error);
          }
        }, (error) => {
          socket.destroy();
          fail(error);
        });
      }
    });
    request.once("response", (response) => fail(new Error(`exec-start-http-${response.statusCode}`)));
    request.once("error", fail);
    operation.signal.addEventListener("abort", abort, { once: true });
    operation.assertOpen();
    request.end(encoded);
  });
}

async function uploadTooling(operation, containerId, hooks) {
  operation.mark("archive-create");
  const repositoryRoot = path.dirname(path.dirname(TOOL_ROOT));
  const archive = spawnSync("tar", ["-C", repositoryRoot, "-cf", "-", "tooling/ai-supervisor-proof"], {
    encoding: null, maxBuffer: 8 * 1024 * 1024
  });
  if (archive.status !== 0) throw new Error("proof-archive-failed");
  operation.assertOpen();
  await api(
    operation,
    "PUT",
    `/containers/${containerId}/archive?path=/`,
    archive.stdout,
    [200],
    "application/x-tar",
    () => hooks?.reached("during-archive-upload")
  );
  operation.assertOpen();
}

async function createContainer(
  operation, runId, suffix, cleanup, hooks = null, fixedName = null
) {
  operation.assertOpen();
  const name = fixedName ?? `devspace-ai-proof-${runId}-${suffix}`;
  operation.mark("container-create");
  const creation = cleanupJson("POST", `/containers/create?name=${name}`, {
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
  operation.assertOpen();
  await hooks?.reached("after-container-create");
  operation.assertOpen();
  await uploadTooling(operation, id, hooks);
  operation.assertOpen();
  await api(operation, "POST", `/containers/${id}/start`);
  operation.assertOpen();
  await hooks?.reached("after-start");
  operation.assertOpen();
  const inspected = await json(operation, "GET", `/containers/${id}/json`);
  if (inspected.Id !== id || inspected.State.Running !== true) throw new Error("container-identity-unproven");
  return { id, name };
}

function binding(
  containerId,
  execId,
  generation = 1,
  aiSessionId = "01990000-0000-7000-8000-000000000004"
) {
  return {
    schemaVersion: "devspace.ai-supervisor-proof-binding/v1",
    projectId: "01990000-0000-7000-8000-000000000001",
    workspaceId: "01990000-0000-7000-8000-000000000002",
    configurationRevisionId: "01990000-0000-7000-8000-000000000003",
    runtimePlanHash: `sha256-runtime-plan-v1:${"a".repeat(64)}`,
    runtimeGeneration: 7,
    containerId,
    aiSessionId,
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

async function helper(operation, containerId, control, counter, hooks = null) {
  operation.assertOpen();
  const execId = await createExec(operation, containerId, [
    "node", "/tooling/ai-supervisor-proof/control-client.mjs"
  ], counter);
  operation.assertOpen();
  const output = await startExec(operation, execId, JSON.stringify(control), {
    onStarted: () => hooks?.reached("during-helper-reconnect")
  });
  operation.assertOpen();
  if (output.stderr !== "") throw new Error("helper-private-diagnostic");
  let response;
  try { response = JSON.parse(output.stdout.trim()); } catch { throw new Error("helper-response-invalid"); }
  operation.assertOpen();
  const inspection = await json(operation, "GET", `/exec/${execId}/json`);
  operation.assertOpen();
  return { execId, response, inspection };
}

async function launch(
  operation,
  runId,
  stateRoot,
  suffix,
  cleanup,
  counter,
  fixtureMode = "cooperative",
  hooks = null,
  identity = {}
) {
  operation.assertOpen();
  const container = await createContainer(operation, runId, suffix, cleanup, hooks);
  operation.assertOpen();
  const execId = await createExec(operation, container.id, [
    "node", "/tooling/ai-supervisor-proof/supervisor.mjs"
  ], counter);
  operation.assertOpen();
  const bound = binding(
    container.id,
    execId,
    identity.processGeneration ?? 1,
    identity.aiSessionId ?? "01990000-0000-7000-8000-000000000004"
  );
  const credential = randomBytes(32).toString("hex");
  const socketPath = deriveSocketPath(bound);
  const bootstrap = {
    format: "devspace.ai-supervisor-proof-bootstrap/v2",
    credential, socketPath, binding: bound, fixtureMode
  };
  const initial = await startExec(operation, execId, JSON.stringify(bootstrap), {
    readiness: true,
    onStarted: () => hooks?.reached("during-supervisor-bootstrap")
  });
  operation.assertOpen();
  const execInspection = await json(operation, "GET", `/exec/${execId}/json`);
  if (execInspection.ID !== execId || execInspection.ContainerID !== container.id
    || !execInspection.Running || !Number.isSafeInteger(execInspection.Pid)) {
    throw new Error("docker-exec-identity-unproven");
  }
  const provisional = { socketPath, credential, binding: bound, ownership: null };
  operation.assertOpen();
  const established = await helper(
    operation, container.id, request(provisional, "establish"), counter
  );
  operation.assertOpen();
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
  operation.mark("ownership-record-write");
  await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  operation.assertOpen();
  await chmod(recordPath, 0o600);
  operation.assertOpen();
  await hooks?.reached("after-ownership-record-write");
  operation.assertOpen();
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
  operation, recordPath, expectedBinding, action, counter, hooks = null, expectedOwnership = null
) {
  operation.assertOpen();
  const record = await loadRecord(recordPath, expectedBinding, expectedOwnership);
  operation.assertOpen();
  let container;
  try {
    container = await json(operation, "GET", `/containers/${record.containerId}/json`);
  } catch (error) {
    if (isProofOperationAborted(error)) throw error;
    throw new Error("owned-container-unavailable", { cause: error });
  }
  operation.assertOpen();
  if (container.Id !== record.containerId || container.State.Running !== true) {
    throw new Error("owned-container-mismatch");
  }
  const execInspection = await json(operation, "GET", `/exec/${record.supervisorExecId}/json`);
  operation.assertOpen();
  if (execInspection.ID !== record.supervisorExecId
    || execInspection.ContainerID !== record.containerId
    || execInspection.Pid !== record.ownership.dockerExecProcess.outerPid
    || !execInspection.Running) throw new Error("owned-exec-mismatch");
  operation.assertOpen();
  return helper(operation, record.containerId, request(record, action), counter, hooks);
}

async function separateHostReconnect(
  operation, recordPath, expectedBinding, expectedOwnership, credential
) {
  operation.assertOpen();
  const argv = [new URL(import.meta.url).pathname, "--reconnect-child"];
  const environment = { DEVSPACE_DOCKER_SOCKET_PATH: SOCKET };
  if (spawnConfigurationContainsSecret(argv, environment, credential)) {
    throw new Error("reconnect-spawn-credential-leak");
  }
  operation.mark("reconnect-host-spawn");
  const child = spawn(process.execPath, argv, {
    stdio: ["pipe", "pipe", "pipe"],
    env: environment
  });
  let rejectForAbort;
  const aborted = new Promise((_resolve, reject) => { rejectForAbort = reject; });
  const abort = () => {
    child.kill("SIGTERM");
    rejectForAbort(new ProofOperationAbortedError());
  };
  operation.signal.addEventListener("abort", abort, { once: true });
  operation.assertOpen();
  operation.mark("reconnect-input");
  child.stdin.write(`${JSON.stringify({ recordPath, expectedBinding, expectedOwnership })}\n`);
  let stdout = "";
  const stderr = [];
  let bytes = 0;
  const responseLine = new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 128 * 1024) reject(new Error("reconnect-child-output-too-large"));
      const newline = stdout.indexOf("\n");
      if (newline >= 0) resolve(stdout.slice(0, newline));
    });
  });
  child.stderr.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 128 * 1024) child.kill("SIGKILL");
    stderr.push(Buffer.from(chunk));
  });
  try {
    const encodedResponse = await Promise.race([responseLine, aborted]);
    operation.assertOpen();
    const liveProcessData = Buffer.concat([
      await readFile(`/proc/${child.pid}/cmdline`),
      await readFile(`/proc/${child.pid}/environ`)
    ]);
    operation.assertOpen();
    if (liveProcessData.includes(Buffer.from(credential))) {
      throw new Error("reconnect-live-process-credential-leak");
    }
    operation.mark("reconnect-release");
    child.stdin.end("release\n");
    const code = await new Promise((resolve) => child.once("exit", resolve));
    operation.assertOpen();
    if (code !== 0 || stderr.length > 0) throw new Error("reconnect-child-failed");
    return { ...JSON.parse(encodedResponse), hostCredentialAbsent: true };
  } finally {
    operation.signal.removeEventListener("abort", abort);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

async function probeCgroups(operation, runId, cleanup, counter) {
  operation.assertOpen();
  const container = await createContainer(operation, runId, "cgroup", cleanup);
  operation.assertOpen();
  const execId = await createExec(operation, container.id, [
    "node", "/tooling/ai-supervisor-proof/cgroup-probe.mjs"
  ], counter);
  operation.assertOpen();
  const output = await startExec(operation, execId, "");
  operation.assertOpen();
  if (output.stderr !== "") throw new Error("cgroup-probe-diagnostic");
  let probe;
  try { probe = JSON.parse(output.stdout.trim()); } catch {
    return {
      probe: null,
      classification: { outcome: "PROBE_FAILED", reason: "invalid-cgroup-probe-json" }
    };
  }
  const name = `devspace-ai-proof-${runId}-writable-cgroup`;
  let rootlessWritableCgroup = "started";
  operation.mark("container-create");
  const creation = cleanupJson("POST", `/containers/create?name=${name}`, {
    Image: IMAGE, Cmd: ["node", "-e", "setInterval(()=>{},1000)"],
    Labels: { [LABEL]: runId },
    HostConfig: {
      NetworkMode: "none", CgroupnsMode: "private", CapAdd: [], CapDrop: [],
      SecurityOpt: ["no-new-privileges:true", "writable-cgroups=true"]
    }
  }).then((created) => created.Id);
  const candidate = await cleanup.trackCreation(creation);
  operation.assertOpen();
  try { await api(operation, "POST", `/containers/${candidate}/start`); } catch (error) {
    if (isProofOperationAborted(error)) throw error;
    rootlessWritableCgroup = error.statusCode === 500
      && error.safeReason === "rootless-user-namespace-conflict"
      ? "rejected-by-rootless-user-namespace" : "docker-start-rejected";
  }
  const completeProbe = {
    ...probe,
    rootlessWritableCgroup: rootlessWritableCgroup === "docker-start-rejected"
      ? "probe-failed" : rootlessWritableCgroup
  };
  return { probe: completeProbe, classification: classifyCgroupProbe(completeProbe) };
}

async function expectReject(operation) {
  try { await operation(); } catch (error) {
    if (isProofOperationAborted(error)) throw error;
    return;
  }
  throw new Error("expected-rejection-missing");
}

async function repositoryContainsSecret(root, secret, {
  maximumFileBytes = 1024 * 1024,
  maximumTotalBytes = 128 * 1024 * 1024,
  maximumFiles = 10_000
} = {}) {
  const skippedDirectories = new Set([
    ".git", ".cache", ".next", "coverage", "dist", "node_modules"
  ]);
  const sourceDirectories = new Set([
    ".github", "apps", "deploy", "docs", "e2e", "packages", "schemas", "tooling"
  ]);
  const resolvedRoot = path.resolve(root);
  const pending = [resolvedRoot];
  let totalBytes = 0;
  let files = 0;
  const needle = Buffer.from(secret);
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
      if (directory === resolvedRoot && entry.isDirectory()
        && !sourceDirectories.has(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (!entry.isFile()) continue;
      const metadata = await lstat(candidate);
      files += 1;
      if (files > maximumFiles) throw new Error("repository-secret-scan-file-limit");
      if (metadata.size > maximumFileBytes) continue;
      totalBytes += metadata.size;
      if (totalBytes > maximumTotalBytes) throw new Error("repository-secret-scan-total-limit");
      const handle = await open(candidate, "r");
      try {
        const bytes = Buffer.alloc(metadata.size);
        const { bytesRead } = await handle.read(bytes, 0, metadata.size, 0);
        if (bytes.subarray(0, bytesRead).includes(needle)) return true;
      } finally { await handle.close(); }
    }
  }
  return false;
}

async function assertNoProofResources(stateRoot, runId) {
  const filters = encodeURIComponent(JSON.stringify({ label: [`${LABEL}=${runId}`] }));
  const listed = await cleanupJson("GET", `/containers/json?all=1&filters=${filters}`);
  const named = (await cleanupJson("GET", "/containers/json?all=1")).filter((item) =>
    item.Names?.some((name) => name.startsWith(`/devspace-ai-proof-${runId}`)));
  const rootExists = await stat(stateRoot).then(() => true, () => false);
  if (listed.length !== 0 || named.length !== 0 || rootExists) {
    throw new Error("cleanup-verification-failed");
  }
}

async function failureInjectionMatrix(parentOperation, runId) {
  const stages = [
    "after-container-create", "during-archive-upload", "after-start",
    "during-supervisor-bootstrap", "after-ownership-record-write", "during-helper-reconnect"
  ];
  for (const stage of stages) {
    parentOperation.assertOpen();
    const stateRoot = await mkdtemp(path.join(tmpdir(), "devspace-ai-proof-"));
    try {
      parentOperation.assertOpen();
      await chmod(stateRoot, 0o700);
      parentOperation.assertOpen();
    } catch (error) {
      await rm(stateRoot, { recursive: true, force: true });
      throw error;
    }
    const stageRunId = `${runId}-${stages.indexOf(stage)}`;
    const cleanup = createCleanupCoordinator(stageRunId);
    cleanup.registerRoot(stateRoot);
    const operation = new ProofOperationFence(cleanup, parentOperation.signal);
    const counter = new Map();
    const hooks = createLifecycleHooks({ failStage: stage });
    try {
      if (stage === "during-helper-reconnect") {
        const launched = await launch(
          operation, stageRunId, stateRoot, `inject-${stage}`, cleanup, counter
        );
        await recoveryEntry(
          operation, launched.recordPath, launched.record.binding, "proof", counter, hooks
        );
      } else {
        await launch(
          operation, stageRunId, stateRoot, `inject-${stage}`,
          cleanup, counter, "cooperative", hooks
        );
      }
      throw new Error("failure-injection-not-triggered");
    } catch (error) {
      if (isProofOperationAborted(error)) throw error;
      if (error.message === "failure-injection-not-triggered") throw error;
    } finally {
      await cleanup.cleanup();
    }
    await assertNoProofResources(stateRoot, stageRunId);
    parentOperation.assertOpen();
  }
  return stages;
}

async function signalChild(runId, stage) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "devspace-ai-proof-"));
  await chmod(stateRoot, 0o700);
  const cleanup = createCleanupCoordinator(runId);
  cleanup.registerRoot(stateRoot);
  const controller = new AbortController();
  const effects = new Map();
  const operation = new ProofOperationFence(cleanup, controller.signal, effects);
  const execCounter = new Map();
  let readySent = false;
  let shutdownPromise;
  let betweenMutationEvidence = null;
  const hooks = createLifecycleHooks({
    pauseStage: stage,
    signal: controller.signal,
    onPause: () => {
      if (readySent) return;
      readySent = true;
      process.stdout.write(`${JSON.stringify({ type: "signal-ready", stateRoot, stage })}\n`);
    }
  });
  const keepAlive = setInterval(() => {}, 1_000);
  for (const signalName of ["SIGINT", "SIGTERM"]) {
    process.once(signalName, () => {
      shutdownPromise ??= beginProofShutdown(cleanup, controller);
    });
  }
  try {
    if (stage === "between-mutations") {
      const launched = await launch(
        operation, runId, stateRoot, "signal", cleanup, execCounter
      );
      const first = await helper(operation, launched.container.id, request(
        launched.record, "send", { operationId: "before-signal", value: "fixture" }
      ), execCounter);
      if (first.response.result?.type !== "echo") throw new Error("signal-first-mutation-failed");
      await hooks.reached("between-mutations");
      throw new Error("between-mutations-signal-missing");
    } else if (stage === "during-helper-reconnect") {
      const launched = await launch(
        operation, runId, stateRoot, "signal", cleanup, execCounter
      );
      await recoveryEntry(
        operation, launched.recordPath, launched.record.binding, "proof", execCounter, hooks
      );
    } else {
      await launch(
        operation, runId, stateRoot, "signal", cleanup, execCounter, "cooperative", hooks
      );
    }
    throw new Error("signal-stage-not-reached");
  } catch (error) {
    if (!isProofOperationAborted(error) || !controller.signal.aborted) throw error;
    if (stage === "between-mutations") {
      const before = new Map(effects);
      let secondError;
      try {
        await helper(operation, "f".repeat(64), { action: "must-not-run" }, execCounter);
      } catch (candidate) { secondError = candidate; }
      betweenMutationEvidence = {
        categoricalAbort: isProofOperationAborted(secondError),
        dockerRequestsUnchanged: effects.get("docker-request") === before.get("docker-request"),
        execStartsUnchanged: effects.get("docker-exec-start") === before.get("docker-exec-start"),
        controlInputsUnchanged: effects.get("control-input") === before.get("control-input")
      };
      if (!Object.values(betweenMutationEvidence).every(Boolean)) {
        throw new Error("post-signal-side-effect-observed", { cause: error });
      }
    }
  } finally {
    await (shutdownPromise ?? cleanup.cleanup());
    clearInterval(keepAlive);
  }
  if (betweenMutationEvidence !== null) {
    process.stdout.write(`${JSON.stringify({
      type: "signal-result", stage, ...betweenMutationEvidence
    })}\n`);
  }
}

async function signalCleanupMatrix(operation, runId) {
  const stages = [
    "after-container-create",
    "during-archive-upload",
    "during-supervisor-bootstrap",
    "during-helper-reconnect",
    "between-mutations"
  ];
  for (const stage of stages) {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      operation.assertOpen();
      const signalRunId = `${runId}-${stages.indexOf(stage)}-${signal.toLowerCase()}`;
    operation.mark("signal-test-child-spawn");
    const child = spawn(process.execPath, [
      new URL(import.meta.url).pathname, "--signal-child", signalRunId, stage
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { DEVSPACE_DOCKER_SOCKET_PATH: SOCKET }
    });
    const abort = () => child.kill("SIGTERM");
    operation.signal.addEventListener("abort", abort, { once: true });
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
          if (message.type !== "signal-ready" || message.stage !== stage) throw new Error();
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
    operation.assertOpen();
    operation.mark("signal-test-child-signal");
    child.kill(signal);
    const outcome = await new Promise((resolve) => child.once("exit", (code, exitSignal) => {
      resolve({ code, exitSignal });
    }));
    if (outcome.code !== 0 || outcome.exitSignal !== null || stderr !== "") {
      throw new Error(`signal-child-cleanup-failed-${outcome.code}-${outcome.exitSignal}-${stderr.length}`);
    }
    operation.signal.removeEventListener("abort", abort);
    operation.assertOpen();
    if (stage === "between-mutations") {
      const messages = stdout.trim().split("\n").map((line) => JSON.parse(line));
      const result = messages.find((message) => message.type === "signal-result");
      if (result === undefined || !result.categoricalAbort
        || !result.dockerRequestsUnchanged || !result.execStartsUnchanged
        || !result.controlInputsUnchanged) throw new Error("between-mutations-evidence-missing");
    }
    await assertNoProofResources(stateRoot, signalRunId);
    operation.assertOpen();
    }
  }
  return stages.flatMap((stage) => [`${stage}:SIGINT`, `${stage}:SIGTERM`]);
}

async function main() {
  const runId = randomUUID().slice(0, 8);
  const stateRoot = await mkdtemp(path.join(tmpdir(), "devspace-ai-proof-"));
  await chmod(stateRoot, 0o700);
  const cleanup = createCleanupCoordinator(runId);
  cleanup.registerRoot(stateRoot);
  const controller = new AbortController();
  const operation = new ProofOperationFence(cleanup, controller.signal);
  const execCounter = new Map();
  const matrix = {};
  let signalSeen = null;
  let shutdownPromise;
  const onSignal = (signal) => {
    if (signalSeen !== null) return;
    signalSeen = signal;
    shutdownPromise = beginProofShutdown(cleanup, controller);
    void shutdownPromise.then(() => {
      process.exitCode = 128 + (signal === "SIGINT" ? 2 : 15);
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await api(operation, "GET", "/_ping");
    operation.assertOpen();
    const info = await json(operation, "GET", "/info");
    if (!info.SecurityOptions?.some((value) => /rootless/iu.test(value))) {
      throw new Error("daemon-not-rootless");
    }
    const cgroupResult = await probeCgroups(operation, runId, cleanup, execCounter);
    operation.assertOpen();
    if (cgroupResult.classification.outcome !== "BLOCKED") {
      await cleanup.cleanup();
      process.stdout.write(`${JSON.stringify({
        schemaVersion: "devspace.ai-supervisor-proof-result/v3",
        verdict: cgroupResult.classification.outcome,
        reason: cgroupResult.classification.reason,
        environment: { engineClass: "dedicated rootless Docker", image: IMAGE },
        cgroup: cgroupResult.probe,
        scenarios: null
      }, null, 2)}\n`);
      return;
    }
    const cgroup = cgroupResult.probe;

    const normal = await launch(operation, runId, stateRoot, "normal", cleanup, execCounter);
    operation.assertOpen();
    const roundTrip = await helper(operation, normal.container.id, request(normal.record, "send", {
      operationId: "normal-round-trip", value: "fixture"
    }), execCounter);
    if (roundTrip.response.result?.type !== "echo") throw new Error("round-trip-failed");
    matrix.A = { status: "PASS", action: "launched and authenticated exact exec/supervisor/provider chain",
      evidence: "direct child, stable start identity, coherent bounded topology, JSONL round trip",
      sideEffect: "one correlated provider input", cleanup: "tracked" };

    const reconnect = await separateHostReconnect(
      operation, normal.recordPath, normal.record.binding,
      normal.record.ownership, normal.record.credential
    );
    if (!reconnect.response.ok || reconnect.hostCredentialAbsent !== true) {
      throw new Error("reconnect-rejected");
    }
    const continued = await recoveryEntry(
      operation, normal.recordPath, normal.record.binding, "proof", execCounter
    );
    if (!continued.response.ok) throw new Error("reconnect-proof-rejected");
    matrix.B = { status: "PASS", action: "destroyed launch attachment and used separate host process/new helper exec",
      evidence: "exact container and supervisor exec re-inspected before authenticated socket access",
      sideEffect: "new helper only after identity verification", cleanup: "tracked" };

    const baseline = await recoveryEntry(
      operation, normal.recordPath, normal.record.binding, "proof", execCounter
    );
    const wrongCredential = structuredClone(request(normal.record, "proof"));
    wrongCredential.credential = "0".repeat(64);
    const rejectedCredential = await helper(
      operation, normal.container.id, wrongCredential, execCounter
    );
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
      if ((await helper(
        operation, normal.container.id, altered, execCounter
      )).response.ok !== false) {
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
      if ((await helper(
        operation, normal.container.id, altered, execCounter
      )).response.ok !== false) {
        throw new Error(`mutated-binding-accepted-${field}`);
      }
    }
    const afterReject = await recoveryEntry(
      operation, normal.recordPath, normal.record.binding, "proof", execCounter
    );
    if (afterReject.response.result.eventSequence !== baseline.response.result.eventSequence) {
      throw new Error("rejection-had-provider-side-effect");
    }
    matrix.E = { status: "PASS", action: "mutated five immutable fields independently",
      evidence: "strict schema/equality rejection and stable event sequence", sideEffect: "none",
      cleanup: "tracked" };

    const replay = await launch(
      operation, runId, stateRoot, "replay", cleanup, execCounter
    );
    const interruptId = randomUUID();
    const interruptRequest = request(replay.record, "interrupt", null, interruptId);
    const interrupted = await helper(
      operation, replay.container.id, interruptRequest, execCounter
    );
    const duplicate = await helper(
      operation, replay.container.id, interruptRequest, execCounter
    );
    const conflicting = await helper(operation, replay.container.id, {
      ...interruptRequest,
      action: "send",
      payload: { operationId: "conflicting-replay", value: "must-not-forward" }
    }, execCounter);
    if (interrupted.response.result?.type !== "interrupted"
      || JSON.stringify(interrupted.response) !== JSON.stringify(duplicate.response)
      || conflicting.response.code !== "conflicting-request-id") {
      throw new Error("interrupt-correlation-failed");
    }
    for (let index = 0; index < 255; index += 1) {
      const filled = await helper(operation, replay.container.id, request(replay.record, "send", {
        operationId: `ledger-fill-${index}`, value: "fixture"
      }), execCounter);
      if (filled.response.result?.type !== "echo") throw new Error("ledger-fill-failed");
    }
    const beforeCapacity = await recoveryEntry(
      operation, replay.recordPath, replay.record.binding, "proof", execCounter
    );
    const atCapacity = await helper(operation, replay.container.id, request(replay.record, "send", {
      operationId: "ledger-overflow", value: "must-not-forward"
    }), execCounter);
    const duplicateAtCapacity = await helper(
      operation, replay.container.id, interruptRequest, execCounter
    );
    const afterCapacity = await recoveryEntry(
      operation, replay.recordPath, replay.record.binding, "proof", execCounter
    );
    if (atCapacity.response.code !== "request-ledger-capacity-reached"
      || JSON.stringify(duplicateAtCapacity.response) !== JSON.stringify(interrupted.response)
      || beforeCapacity.response.result.eventSequence !== afterCapacity.response.result.eventSequence) {
      throw new Error("request-ledger-capacity-safety-failed");
    }
    matrix.F = { status: "PASS", action: "correlated cooperative interrupt and exact duplicate",
      evidence: "duplicates remained idempotent at capacity; conflict/new IDs rejected without provider effects",
      sideEffect: "one provider interrupt", cleanup: "tracked" };

    const graceful = await helper(
      operation, normal.container.id, request(normal.record, "fixture-stop"), execCounter
    );
    if (graceful.response.result?.authority !== "fixture-process-group-experiment"
      || graceful.response.result?.escalated !== false
      || !(await json(
        operation, "GET", `/containers/${normal.container.id}/json`
      )).State.Running) {
      throw new Error("fixture-graceful-experiment-failed");
    }
    matrix.G = { status: "PARTIAL", action: "sent SIGTERM to rechecked cooperative fixture PGID",
      evidence: "fixture descendants exited; unrelated PID 1 sentinel/container survived",
      sideEffect: "fixture-only group signal", cleanup: "tracked",
      limitation: "numeric PGID is non-atomic/reusable and not production Stop authority" };

    const forced = await launch(
      operation, runId, stateRoot, "forced", cleanup, execCounter, "ignore-term"
    );
    const forcedResult = await helper(
      operation, forced.container.id, request(forced.record, "fixture-stop"), execCounter
    );
    if (forcedResult.response.result?.escalated !== true
      || !(await json(
        operation, "GET", `/containers/${forced.container.id}/json`
      )).State.Running) {
      throw new Error("fixture-force-experiment-failed");
    }
    for (const mode of ["setsid-child", "double-fork", "group-churn"]) {
      await expectReject(() => launch(
        operation, runId, stateRoot, `adversarial-${mode}`, cleanup, execCounter, mode
      ));
    }
    matrix.H = { status: "BLOCKED", action: "probed cgroup delegation and adversarial fixture escape/churn",
      evidence: "cgroup filesystem read-only; rootless writable-cgroups start rejected; escapes/churn invalidate PGID proof",
      sideEffect: "fixture-only escalation executed; no production-safe boundary", cleanup: "tracked",
      limitation: "atomic descendant-tree termination unavailable" };

    const exited = await launch(
      operation, runId, stateRoot, "exited", cleanup, execCounter
    );
    await helper(
      operation, exited.container.id, request(exited.record, "exit-provider"), execCounter
    );
    const already = await helper(
      operation, exited.container.id, request(exited.record, "fixture-stop"), execCounter
    );
    const stale = structuredClone(request(exited.record, "proof"));
    stale.ownership.provider.startTime = String(BigInt(stale.ownership.provider.startTime) + 1n);
    if (already.response.result?.signalSent !== false
      || (await helper(
        operation, exited.container.id, stale, execCounter
      )).response.ok !== false) {
      throw new Error("already-exited-safety-failed");
    }
    matrix.I = { status: "PASS", action: "exited provider then invoked fixture stop and stale-start proof",
      evidence: "no signal sent after exit; start-time mismatch rejected", sideEffect: "none after exit",
      cleanup: "tracked", limitation: "deterministic PID reuse not forced" };

    const replaced = await launch(
      operation, runId, stateRoot, "replaced", cleanup, execCounter
    );
    const staleRecord = replaced.recordPath;
    const staleBinding = replaced.record.binding;
    const oldId = replaced.container.id;
    const oldName = replaced.container.name;
    await api(operation, "DELETE", `/containers/${oldId}?force=1`, undefined, [204, 404]);
    operation.assertOpen();
    cleanup.forgetContainer(oldId);
    const replacement = await createContainer(
      operation, runId, "replacement", cleanup, null, oldName
    );
    const beforeB = execCounter.get(replacement.id) ?? 0;
    await expectReject(() => recoveryEntry(
      operation, staleRecord, staleBinding, "proof", execCounter
    ));
    await expectReject(() => recoveryEntry(
      operation, staleRecord, staleBinding, "fixture-stop", execCounter
    ));
    const afterB = execCounter.get(replacement.id) ?? 0;
    if (replacement.id === oldId || beforeB !== afterB
      || !(await json(
        operation, "GET", `/containers/${replacement.id}/json`
      )).State.Running) {
      throw new Error("replaced-container-contacted");
    }
    matrix.J = { status: "PASS", action: "replaced A with B under the same name; invoked real recovery and signal-capable entry",
      evidence: "exact A ID 404 rejected before helper; B helper-exec counter unchanged and sentinel live",
      sideEffect: "none in B", cleanup: "A removed, B tracked separately" };

    const corruptCases = [];
    const base = structuredClone(normal.record);
    const separateSession = await launch(
      operation,
      runId,
      stateRoot,
      "separate-session",
      cleanup,
      execCounter,
      "cooperative",
      null,
      { aiSessionId: "01990000-0000-7000-8000-000000000088", processGeneration: 2 }
    );
    const mutateRecord = (mutation) => {
      const value = structuredClone(base);
      mutation(value);
      return JSON.stringify(value);
    };
    const cases = [
      ["empty", ""],
      ["truncated-json", "{"],
      ["unknown-field", JSON.stringify({ ...base, extra: true })],
      ["wrong-format", JSON.stringify({ ...base, format: "wrong" })],
      ["top-container-mismatch", mutateRecord((value) => { value.containerId = "f".repeat(64); })],
      ["binding-container-mismatch", mutateRecord((value) => {
        value.binding.containerId = "f".repeat(64);
      })],
      ["top-exec-mismatch", mutateRecord((value) => { value.supervisorExecId = "f".repeat(64); })],
      ["binding-exec-mismatch", mutateRecord((value) => {
        value.binding.dockerExecId = "f".repeat(64);
      })],
      ["missing-supervisor", JSON.stringify({
        ...base, ownership: { ...base.ownership, supervisor: undefined }
      })],
      ["malformed-nspid", mutateRecord((value) => {
        value.ownership.provider.nspid = ["bad"];
      })],
      ["stale-generation", mutateRecord((value) => { value.binding.processGeneration = 99; })],
      ["stale-start", mutateRecord((value) => {
        value.ownership.provider.startTime = String(
          BigInt(value.ownership.provider.startTime) + 1n
        );
      })],
      ["escaped-descendant-pgid", mutateRecord((value) => {
        value.ownership.descendants[0].pgid += 1;
      })],
      ["escaped-descendant-sid", mutateRecord((value) => {
        value.ownership.descendants[0].sid += 1;
      })],
      ["inconsistent-group-member", mutateRecord((value) => {
        value.ownership.groupMembers[1].startTime = String(
          BigInt(value.ownership.groupMembers[1].startTime) + 1n
        );
      })],
      ["foreign-group-member", mutateRecord((value) => {
        const foreignPid = 120;
        value.ownership.groupMembers.push({
          ...value.ownership.provider,
          pid: foreignPid,
          ppid: 1,
          startTime: "999999",
          nspid: [foreignPid]
        });
      })],
      ["missing-descendant", mutateRecord((value) => {
        value.ownership.descendants.pop();
        value.ownership.groupMembers.pop();
      })],
      ["altered-descendant-parent", mutateRecord((value) => {
        value.ownership.descendants[1].ppid = 1;
        value.ownership.groupMembers[2].ppid = 1;
      })],
      ["duplicate-pid", mutateRecord((value) => {
        const duplicate = value.ownership.descendants[0];
        value.ownership.descendants[1].pid = duplicate.pid;
        value.ownership.descendants[1].nspid = [...duplicate.nspid];
        value.ownership.groupMembers[2].pid = duplicate.pid;
        value.ownership.groupMembers[2].nspid = [...duplicate.nspid];
      })],
      ["crossed-socket-generation", mutateRecord((value) => {
        value.socketPath = `/tmp/devspace-ai-proof/${value.binding.aiSessionId}-2.sock`;
      })],
      ["crossed-socket-session", mutateRecord((value) => {
        value.socketPath = "/tmp/devspace-ai-proof/01990000-0000-7000-8000-000000000077-1.sock";
      })],
      ["genuine-separate-session", JSON.stringify(separateSession.record)]
    ];
    const missing = path.join(stateRoot, "missing.json");
    const execBeforeK = [...execCounter.values()].reduce((sum, value) => sum + value, 0);
    for (const [index, entry] of [["missing", null], ...cases].entries()) {
      const [name, value] = entry;
      const testPath = index === 0 ? missing : path.join(stateRoot, `corrupt-${index}.json`);
      if (index > 0) await writeFile(testPath, value, { mode: 0o600 });
      await expectReject(() => recoveryEntry(
        operation, testPath, normal.record.binding,
        "proof", execCounter, null, normal.record.ownership
      ));
      await expectReject(() => recoveryEntry(
        operation, testPath, normal.record.binding,
        "fixture-stop", execCounter, null, normal.record.ownership
      ));
      corruptCases.push(name);
    }
    const execAfterK = [...execCounter.values()].reduce((sum, value) => sum + value, 0);
    if (execBeforeK !== execAfterK) throw new Error("corrupt-record-created-helper");
    matrix.K = { status: "PASS", action: "ran real recovery and signal-capable entries across strict corrupt-record corpus",
      evidence: `${corruptCases.length} semantic/cross-authority cases rejected before Docker helper creation; exec count unchanged`,
      sideEffect: "none", cleanup: "temp corpus under tracked root",
      limitation: "proof-local validators are not production request authority" };

    const leakTarget = forced;
    const leak = await helper(
      operation, leakTarget.container.id,
      request(leakTarget.record, "leak-inspect"), execCounter
    );
    const inspections = [
      await json(operation, "GET", `/containers/${leakTarget.container.id}/json`),
      await json(operation, "GET", `/exec/${leakTarget.execId}/json`),
      leak.inspection
    ];
    const hostBytes = Buffer.concat([
      await readFile(`/proc/${process.pid}/cmdline`), await readFile(`/proc/${process.pid}/environ`)
    ]);
    const repositoryLeak = await repositoryContainsSecret(
      process.cwd(), leakTarget.record.credential
    );
    operation.assertOpen();
    const stateMode = (await stat(stateRoot)).mode & 0o777;
    operation.assertOpen();
    const recordMode = (await stat(leakTarget.recordPath)).mode & 0o777;
    operation.assertOpen();
    if (leak.response.result.credentialPresent
      || inspections.some((value) => JSON.stringify(value).includes(leakTarget.record.credential))
      || hostBytes.includes(Buffer.from(leakTarget.record.credential))
      || repositoryLeak || stateMode !== 0o700 || recordMode !== 0o600
      || leakTarget.initial.stdout.includes(leakTarget.record.credential)
      || leakTarget.initial.stderr.includes(leakTarget.record.credential)) {
      throw new Error("credential-leak-detected");
    }
    matrix.L = { status: "PARTIAL", action: "live credential scan of runner, container processes, Docker configs, output, and repository",
      evidence: "absent in inspected argv/env/config/labels/exec/output; state 0700 and record 0600",
      sideEffect: "read-only inspection", cleanup: "tracked",
      limitation: "coverage is the enumerated success and sanitized-error paths, not universal future failures" };

    operation.assertOpen();
    const injected = await failureInjectionMatrix(operation, `${runId}-inject`);
    operation.assertOpen();
    const signals = await signalCleanupMatrix(operation, `${runId}-signal`);
    operation.assertOpen();
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
      cgroupClassification: cgroupResult.classification,
      scenarios: ordered
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    if (signalSeen !== null && isProofOperationAborted(error)) {
      await shutdownPromise;
      return;
    }
    throw error;
  } finally {
    if (signalSeen === null) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
    await (shutdownPromise ?? cleanup.cleanup());
  }
}

if (process.argv[2] === "--reconnect-child") {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || Buffer.byteLength(first.value) > 128 * 1024) {
    throw new Error("reconnect-input-invalid");
  }
  const input = first.value;
  const { recordPath, expectedBinding, expectedOwnership } = JSON.parse(input);
  const counter = new Map();
  const controller = new AbortController();
  const operation = new ProofOperationFence({ state: "open" }, controller.signal);
  const result = await recoveryEntry(
    operation, recordPath, expectedBinding, "proof", counter, null, expectedOwnership
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  const release = await iterator.next();
  lines.close();
  if (release.done || release.value !== "release") throw new Error("reconnect-release-invalid");
} else if (process.argv[2] === "--signal-child") {
  await signalChild(process.argv[3], process.argv[4]);
} else {
  await main();
}
