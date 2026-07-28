import { timingSafeEqual } from "node:crypto";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONFIG_KEY = /^[a-z][a-z0-9-]{0,63}$/u;
const DOCKER_ID = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const SOCKET = /^\/tmp\/devspace-ai-proof\/[0-9a-f-]{36}-[1-9][0-9]*\.sock$/u;
const MAX_FRAME = 64 * 1024;
const MAX_STREAM = 256 * 1024;
const MAX_MULTIPLEX_FRAMES = 256;

export const BINDING_KEYS = Object.freeze([
  "schemaVersion", "projectId", "workspaceId", "configurationRevisionId",
  "runtimePlanHash", "runtimeGeneration", "containerId", "aiSessionId",
  "profileId", "profileRevision", "processGeneration", "operationId", "dockerExecId"
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, keys) {
  return plainObject(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function safePositive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function parseBinding(value) {
  if (!exactKeys(value, BINDING_KEYS)
    || value.schemaVersion !== "devspace.ai-supervisor-proof-binding/v1"
    || !UUID_V7.test(value.projectId) || !UUID_V7.test(value.workspaceId)
    || !UUID_V7.test(value.configurationRevisionId) || !UUID_V7.test(value.aiSessionId)
    || !UUID_V7.test(value.operationId) || !CONFIG_KEY.test(value.profileId)
    || !/^sha256-runtime-plan-v1:[0-9a-f]{64}$/u.test(value.runtimePlanHash)
    || !/^sha256-ai-profile-v1:[0-9a-f]{64}$/u.test(value.profileRevision)
    || !DOCKER_ID.test(value.containerId) || !DOCKER_ID.test(value.dockerExecId)
    || !safePositive(value.runtimeGeneration) || !safePositive(value.processGeneration)) {
    throw new Error("invalid-binding");
  }
  return Object.fromEntries(BINDING_KEYS.map((key) => [key, value[key]]));
}

export function deriveSocketPath(binding) {
  const parsed = parseBinding(binding);
  return `/tmp/devspace-ai-proof/${parsed.aiSessionId}-${parsed.processGeneration}.sock`;
}

export function parseBootstrap(value) {
  if (!exactKeys(value, ["binding", "credential", "fixtureMode", "format", "socketPath"])
    || value.format !== "devspace.ai-supervisor-proof-bootstrap/v2"
    || typeof value.credential !== "string" || !/^[0-9a-f]{64}$/u.test(value.credential)
    || typeof value.socketPath !== "string" || !SOCKET.test(value.socketPath)
    || !["cooperative", "ignore-term", "setsid-child", "double-fork", "group-churn"]
      .includes(value.fixtureMode)) throw new Error("invalid-bootstrap");
  const binding = parseBinding(value.binding);
  if (value.socketPath !== deriveSocketPath(binding)) throw new Error("invalid-bootstrap-socket-authority");
  return { ...value, binding };
}

const ACTIONS = new Set([
  "establish", "proof", "send", "interrupt", "malformed-provider",
  "exit-provider", "leak-inspect", "fixture-stop"
]);
export function parseControlRequest(value) {
  if (!exactKeys(value, ["action", "binding", "credential", "ownership", "payload", "requestId"])
    || !ACTIONS.has(value.action) || !UUID.test(value.requestId)
    || typeof value.credential !== "string" || !/^[0-9a-f]{64}$/u.test(value.credential)
    || (!plainObject(value.ownership) && value.ownership !== null)
    || (!plainObject(value.payload) && value.payload !== null)) throw new Error("invalid-control-request");
  return {
    ...value,
    binding: parseBinding(value.binding),
    ownership: value.ownership === null ? null : parseOwnership(value.ownership)
  };
}

export function parseProcessIdentity(value) {
  const keys = ["nspid", "pgid", "pid", "pidNamespace", "ppid", "sid", "startTime", "state"];
  if (!exactKeys(value, keys) || !safePositive(value.pid) || !Number.isSafeInteger(value.ppid) || value.ppid < 0
    || !safePositive(value.pgid) || !safePositive(value.sid)
    || typeof value.state !== "string" || !/^[A-Z]$/u.test(value.state)
    || typeof value.startTime !== "string" || !DECIMAL.test(value.startTime)
    || BigInt(value.startTime) < 1n
    || typeof value.pidNamespace !== "string" || !/^pid:\[[1-9][0-9]*\]$/u.test(value.pidNamespace)
    || !Array.isArray(value.nspid) || value.nspid.length < 1 || value.nspid.length > 8
    || !value.nspid.every(safePositive)
    || new Set(value.nspid).size !== value.nspid.length
    || value.nspid.at(-1) !== value.pid) throw new Error("invalid-process-identity");
  return { ...value, nspid: [...value.nspid] };
}

function parseBoundary(value) {
  if (!exactKeys(value, ["kind", "pgid", "pidNamespace", "sid"])
    || value.kind !== "process-group-experiment" || !safePositive(value.pgid)
    || !safePositive(value.sid) || typeof value.pidNamespace !== "string"
    || !/^pid:\[[1-9][0-9]*\]$/u.test(value.pidNamespace)) throw new Error("invalid-boundary");
  return { ...value };
}

function parseDockerExecProcess(value) {
  if (!exactKeys(value, ["bindingMethod", "outerPid"])
    || value.bindingMethod !== "authenticated-exact-exec-stdin-bootstrap"
    || !safePositive(value.outerPid)) throw new Error("invalid-docker-exec-process");
  return { ...value };
}

export function parseOwnership(value) {
  const keys = ["descendantBoundary", "descendants", "dockerExecProcess", "groupMembers", "provider", "sentinel", "supervisor"];
  if (!exactKeys(value, keys) || !Array.isArray(value.descendants) || value.descendants.length < 2
    || value.descendants.length > 64 || !Array.isArray(value.groupMembers)
    || value.groupMembers.length < 3 || value.groupMembers.length > 65) throw new Error("invalid-ownership");
  const parsed = {
    supervisor: parseProcessIdentity(value.supervisor),
    provider: parseProcessIdentity(value.provider),
    descendants: value.descendants.map(parseProcessIdentity),
    groupMembers: value.groupMembers.map(parseProcessIdentity),
    sentinel: parseProcessIdentity(value.sentinel),
    descendantBoundary: parseBoundary(value.descendantBoundary),
    dockerExecProcess: parseDockerExecProcess(value.dockerExecProcess)
  };
  const allIdentities = [
    parsed.supervisor, parsed.provider, ...parsed.descendants, parsed.sentinel
  ];
  const allPids = allIdentities.map((item) => item.pid);
  if (new Set(allPids).size !== allPids.length || parsed.provider.ppid !== parsed.supervisor.pid
    || parsed.provider.pid !== parsed.provider.pgid || parsed.provider.pid !== parsed.provider.sid
    || parsed.descendantBoundary.pgid !== parsed.provider.pgid
    || parsed.descendantBoundary.sid !== parsed.provider.sid
    || parsed.descendantBoundary.pidNamespace !== parsed.provider.pidNamespace
    || parsed.sentinel.pgid === parsed.provider.pgid
    || !validateDescendantBoundary(
      parsed.supervisor, parsed.provider, parsed.descendants, parsed.groupMembers
    )) throw new Error("invalid-ownership-semantics");
  return parsed;
}

export function parseOwnershipRecord(value, expectedBinding = null) {
  const keys = ["binding", "containerId", "credential", "format", "ownership", "socketPath", "supervisorExecId"];
  if (!exactKeys(value, keys) || value.format !== "devspace.ai-supervisor-proof-record/v2"
    || typeof value.credential !== "string" || !/^[0-9a-f]{64}$/u.test(value.credential)
    || typeof value.socketPath !== "string" || !SOCKET.test(value.socketPath)
    || !DOCKER_ID.test(value.containerId) || !DOCKER_ID.test(value.supervisorExecId)) {
    throw new Error("invalid-ownership-record");
  }
  const binding = parseBinding(value.binding);
  if (value.containerId !== binding.containerId || value.supervisorExecId !== binding.dockerExecId
    || value.socketPath !== deriveSocketPath(binding)
    || (expectedBinding !== null && !bindingsEqual(binding, expectedBinding))) {
    throw new Error("ownership-record-binding-mismatch");
  }
  return { ...value, binding, ownership: parseOwnership(value.ownership) };
}

export function bindingsEqual(left, right) {
  try {
    const a = parseBinding(left); const b = parseBinding(right);
    return BINDING_KEYS.every((key) => a[key] === b[key]);
  } catch { return false; }
}

export function credentialEqual(expected, supplied) {
  if (typeof expected !== "string" || typeof supplied !== "string") return false;
  const a = Buffer.from(expected); const b = Buffer.from(supplied);
  const padded = Buffer.alloc(Math.max(a.length, b.length, 1));
  const other = Buffer.alloc(padded.length);
  a.copy(padded); b.copy(other);
  return timingSafeEqual(padded, other) && a.length === b.length;
}

export function parseProcStat(text) {
  if (typeof text !== "string" || !/^[1-9][0-9]* \(/u.test(text)) throw new Error("invalid-proc-stat");
  const close = text.lastIndexOf(")");
  if (close < 3) throw new Error("invalid-proc-stat");
  const fields = text.slice(close + 2).trim().split(/ +/u);
  const values = [text.slice(0, text.indexOf(" ")), fields[1], fields[2], fields[3]];
  if (fields.length < 20 || !values.every(DECIMAL.test.bind(DECIMAL)) || !DECIMAL.test(fields[19])) {
    throw new Error("invalid-proc-stat");
  }
  const [pid, ppid, pgid, sid] = values.map(Number);
  if (![pid, ppid, pgid, sid].every(Number.isSafeInteger)) throw new Error("invalid-proc-stat");
  return { pid, state: fields[0], ppid, pgid, sid, startTime: fields[19] };
}

export function processIdentityEqual(left, right) {
  try {
    const a = parseProcessIdentity(left); const b = parseProcessIdentity(right);
    return ["pid", "ppid", "pgid", "sid", "startTime", "pidNamespace"]
      .every((key) => a[key] === b[key])
      && a.nspid.length === b.nspid.length && a.nspid.every((item, index) => item === b.nspid[index]);
  } catch { return false; }
}

export function validateDescendantBoundary(supervisor, provider, descendants, groupMembers) {
  try {
    supervisor = parseProcessIdentity(supervisor); provider = parseProcessIdentity(provider);
    descendants = descendants.map(parseProcessIdentity); groupMembers = groupMembers.map(parseProcessIdentity);
  } catch { return false; }
  if (provider.ppid !== supervisor.pid || provider.pgid !== provider.pid
    || provider.sid !== provider.pid || provider.pidNamespace !== supervisor.pidNamespace) return false;
  const owned = [provider, ...descendants];
  const ownedPids = new Set(owned.map((item) => item.pid));
  if (ownedPids.size !== owned.length
    || descendants.some((item) => item.pgid !== provider.pgid || item.sid !== provider.sid
      || item.pidNamespace !== provider.pidNamespace)) return false;
  const reachable = new Set([provider.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const item of descendants) {
      if (!reachable.has(item.pid) && reachable.has(item.ppid)) {
        reachable.add(item.pid);
        changed = true;
      }
    }
  }
  if (reachable.size !== owned.length
    || !descendants.some((item) => item.ppid === provider.pid)
    || !descendants.some((item) => item.ppid !== provider.pid)) return false;
  const groupPids = groupMembers.map((item) => item.pid);
  if (new Set(groupPids).size !== groupPids.length || groupMembers.length !== owned.length) return false;
  const expected = new Map(owned.map((item) => [item.pid, item]));
  return groupMembers.every((item) => {
    const authority = expected.get(item.pid);
    return authority !== undefined && processIdentityEqual(item, authority)
      && item.pgid === provider.pgid && item.sid === provider.sid
      && item.pidNamespace === provider.pidNamespace;
  });
}

export function validateStableTopology(first, second) {
  if (!plainObject(first) || !plainObject(second)) return false;
  const fields = ["supervisor", "provider", "descendants", "groupMembers"];
  if (!fields.every((key) => key in first && key in second)) return false;
  const stableArray = (left, right) => left.length === right.length
    && left.every((item, index) => processIdentityEqual(item, right[index]));
  return processIdentityEqual(first.supervisor, second.supervisor)
    && processIdentityEqual(first.provider, second.provider)
    && stableArray(first.descendants, second.descendants)
    && stableArray(first.groupMembers, second.groupMembers)
    && validateDescendantBoundary(
      second.supervisor, second.provider, second.descendants, second.groupMembers
    );
}

export class DockerMultiplexParser {
  #buffer = Buffer.alloc(0);
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #frameCount = 0;
  constructor({
    maxFrameBytes = MAX_FRAME,
    maxStreamBytes = MAX_STREAM,
    maxFrameCount = MAX_MULTIPLEX_FRAMES
  } = {}) {
    this.maxFrameBytes = maxFrameBytes;
    this.maxStreamBytes = maxStreamBytes;
    this.maxFrameCount = maxFrameCount;
  }
  push(chunk) {
    if (!Buffer.isBuffer(chunk)) throw new Error("docker-frame-chunk-invalid");
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const frames = [];
    while (this.#buffer.length >= 8) {
      const kind = this.#buffer[0];
      if (kind !== 1 && kind !== 2) throw new Error("docker-frame-kind-invalid");
      if (this.#buffer[1] !== 0 || this.#buffer[2] !== 0 || this.#buffer[3] !== 0) {
        throw new Error("docker-frame-reserved-invalid");
      }
      const length = this.#buffer.readUInt32BE(4);
      if (length > this.maxFrameBytes) throw new Error("docker-frame-too-large");
      if (this.#buffer.length < 8 + length) break;
      this.#frameCount += 1;
      if (this.#frameCount > this.maxFrameCount) throw new Error("docker-frame-count-exceeded");
      const payload = this.#buffer.subarray(8, 8 + length);
      if (kind === 1) this.#stdoutBytes += length; else this.#stderrBytes += length;
      if (this.#stdoutBytes + this.#stderrBytes > this.maxStreamBytes) throw new Error("docker-stream-too-large");
      frames.push({ kind: kind === 1 ? "stdout" : "stderr", payload: Buffer.from(payload) });
      this.#buffer = this.#buffer.subarray(8 + length);
    }
    return frames;
  }
  finish() {
    if (this.#buffer.length !== 0) {
      throw new Error(this.#buffer.length < 8 ? "docker-frame-header-truncated" : "docker-frame-payload-truncated");
    }
  }
  assertBoundary() {
    if (this.#buffer.length !== 0) throw new Error(
      this.#buffer.length < 8 ? "docker-frame-header-truncated" : "docker-frame-payload-truncated"
    );
  }
  get frameCount() { return this.#frameCount; }
}

export function parseReadiness(stdout, stderr) {
  if (stderr.length !== 0 || !stdout.endsWith("\n") || stdout.slice(0, -1).includes("\n")) {
    throw new Error("supervisor-readiness-invalid");
  }
  let value;
  try { value = JSON.parse(stdout.slice(0, -1)); } catch { throw new Error("supervisor-readiness-invalid"); }
  if (!exactKeys(value, ["type"]) || value.type !== "supervisor-ready") throw new Error("supervisor-readiness-invalid");
  return value;
}

export function parseReadinessFrames(frames) {
  if (!Array.isArray(frames) || frames.length !== 1 || frames[0]?.kind !== "stdout"
    || !Buffer.isBuffer(frames[0].payload)) throw new Error("supervisor-readiness-framing-invalid");
  return parseReadiness(frames[0].payload.toString("utf8"), "");
}

export function parseJsonLine(text, maximumBytes = 65_536) {
  if (typeof text !== "string" || Buffer.byteLength(text) > maximumBytes
    || !text.endsWith("\n") || text.slice(0, -1).includes("\n")) throw new Error("invalid-frame");
  try { return JSON.parse(text.slice(0, -1)); } catch { throw new Error("invalid-frame"); }
}

export function escalationDecision({ running, identityMatches, graceExpired, boundaryValid }) {
  if (!running) return "already-exited";
  if (!identityMatches || !boundaryValid) return "reject";
  return graceExpired ? "fixture-force-group" : "wait";
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /credential|secret|token|request/iu.test(key) ? "<redacted>" : redact(item)]));
}

export function cleanupPlan({ containerId, recordPath }) {
  if (!DOCKER_ID.test(containerId) || typeof recordPath !== "string" || !recordPath.startsWith("/tmp/devspace-ai-proof-")) {
    throw new Error("invalid-cleanup-plan");
  }
  return [{ kind: "remove-container", containerId }, { kind: "remove-record", recordPath }];
}

export class SerializedRequestLedger {
  #completed = new Map();
  #tail = Promise.resolve();
  constructor(capacity = 256) {
    if (!safePositive(capacity) || capacity > 4096) throw new Error("invalid-ledger-capacity");
    this.capacity = capacity;
  }
  run(requestId, content, operation) {
    if (!UUID.test(requestId) || typeof content !== "string" || typeof operation !== "function") {
      throw new Error("invalid-ledger-request");
    }
    const previous = this.#completed.get(requestId);
    if (previous !== undefined) {
      return previous.content === content
        ? previous.promise
        : Promise.resolve({ ok: false, code: "conflicting-request-id" });
    }
    if (this.#completed.size >= this.capacity) {
      return Promise.resolve({ ok: false, code: "request-ledger-capacity-reached" });
    }
    const promise = this.#tail.then(operation, operation);
    this.#tail = promise.then(() => undefined, () => undefined);
    this.#completed.set(requestId, { content, promise });
    return promise;
  }
}

const PROBE_KEYS = Object.freeze([
  "childCreation", "controllers", "delegatedChild", "killPresent", "killWritable",
  "mountReadOnly", "namespace", "path", "rootlessWritableCgroup", "subtreeControl", "version"
]);

export function classifyCgroupProbe(value) {
  if (!exactKeys(value, PROBE_KEYS)
    || ![1, 2].includes(value.version)
    || typeof value.mountReadOnly !== "boolean"
    || typeof value.namespace !== "string"
    || typeof value.path !== "string"
    || !Array.isArray(value.controllers) || !value.controllers.every((item) => CONFIG_KEY.test(item))
    || new Set(value.controllers).size !== value.controllers.length
    || !Array.isArray(value.subtreeControl)
    || !value.subtreeControl.every((item) => CONFIG_KEY.test(item))
    || new Set(value.subtreeControl).size !== value.subtreeControl.length
    || typeof value.delegatedChild !== "boolean"
    || !["created", "read-only", "permission-denied", "unavailable"].includes(value.childCreation)
    || typeof value.killPresent !== "boolean" || typeof value.killWritable !== "boolean"
    || !["rejected-by-rootless-user-namespace", "started", "probe-failed"]
      .includes(value.rootlessWritableCgroup)) {
    return { outcome: "PROBE_FAILED", reason: "malformed-cgroup-probe" };
  }
  if ((value.delegatedChild !== (value.childCreation === "created"))
    || (value.killWritable && !value.killPresent)
    || (value.mountReadOnly && (value.delegatedChild || value.killWritable))
    || (value.version === 2 && (!/^0::(?:\/.*)?$/u.test(value.path)
      || !/^cgroup:\[[1-9][0-9]*\]$/u.test(value.namespace)))) {
    return { outcome: "PROBE_FAILED", reason: "contradictory-cgroup-probe" };
  }
  if (value.version !== 2) {
    return { outcome: "ENVIRONMENT_CHANGED_REVIEW_REQUIRED", reason: "cgroup-version-changed" };
  }
  if (value.delegatedChild || value.killWritable
    || value.rootlessWritableCgroup === "started" || !value.mountReadOnly) {
    return { outcome: "ENVIRONMENT_CHANGED_REVIEW_REQUIRED", reason: "stronger-capability-observed" };
  }
  if (value.rootlessWritableCgroup === "probe-failed") {
    return { outcome: "PROBE_FAILED", reason: "rootless-writable-cgroup-probe-failed" };
  }
  return { outcome: "BLOCKED", reason: "no-race-safe-descendant-boundary" };
}

export function spawnConfigurationContainsSecret(argv, environment, secret) {
  if (!Array.isArray(argv) || !plainObject(environment) || typeof secret !== "string" || secret === "") {
    throw new Error("invalid-spawn-secret-check");
  }
  return argv.some((item) => typeof item === "string" && item.includes(secret))
    || Object.entries(environment).some(([key, item]) =>
      key.includes(secret) || String(item).includes(secret));
}

export class ProofOperationAbortedError extends Error {
  constructor() {
    super("proof-operation-aborted");
    this.name = "ProofOperationAbortedError";
    this.code = "PROOF_OPERATION_ABORTED";
  }
}

export function isProofOperationAborted(error) {
  return error instanceof ProofOperationAbortedError
    || error?.code === "PROOF_OPERATION_ABORTED";
}

export class ProofOperationFence {
  constructor(cleanup, signal, counters = null) {
    if (cleanup === null || typeof cleanup !== "object"
      || typeof cleanup.state !== "string"
      || signal === null || typeof signal !== "object"
      || typeof signal.aborted !== "boolean"
      || (counters !== null && !(counters instanceof Map))) {
      throw new Error("invalid-proof-operation-fence");
    }
    this.cleanup = cleanup;
    this.signal = signal;
    this.counters = counters;
  }
  assertOpen() {
    if (this.signal.aborted || this.cleanup.state !== "open") {
      throw new ProofOperationAbortedError();
    }
  }
  mark(sideEffect) {
    this.assertOpen();
    if (this.counters !== null) {
      this.counters.set(sideEffect, (this.counters.get(sideEffect) ?? 0) + 1);
    }
  }
  async run(sideEffect, operation) {
    if (typeof sideEffect !== "string" || sideEffect === ""
      || typeof operation !== "function") throw new Error("invalid-proof-operation");
    this.mark(sideEffect);
    const result = await operation();
    this.assertOpen();
    return result;
  }
}

export function beginProofShutdown(cleanup, controller) {
  if (cleanup === null || typeof cleanup?.cleanup !== "function"
    || controller === null || typeof controller?.abort !== "function"
    || typeof controller.signal?.aborted !== "boolean") {
    throw new Error("invalid-proof-shutdown");
  }
  const cleanupPromise = cleanup.cleanup();
  if (!controller.signal.aborted) controller.abort(new ProofOperationAbortedError());
  return cleanupPromise;
}

export class CleanupLifecycle {
  #containers = new Set();
  #roots = new Set();
  #inflight = new Set();
  #promise;
  #state = "open";
  constructor({ removeContainer, removeRoot, audit }) {
    if (![removeContainer, removeRoot, audit].every((item) => typeof item === "function")) {
      throw new Error("invalid-cleanup-lifecycle");
    }
    this.removeContainer = removeContainer;
    this.removeRoot = removeRoot;
    this.audit = audit;
  }
  get state() { return this.#state; }
  assertOpen() {
    if (this.#state !== "open") throw new Error("proof-cleanup-in-progress");
  }
  registerRoot(root) {
    this.assertOpen();
    this.#roots.add(root);
  }
  trackCreation(promise) {
    this.assertOpen();
    const tracked = Promise.resolve(promise).then(async (id) => {
      if (this.#state === "open") this.#containers.add(id);
      else await this.removeContainer(id);
      return id;
    });
    this.#inflight.add(tracked);
    tracked.finally(() => this.#inflight.delete(tracked)).catch(() => {});
    return tracked;
  }
  forgetContainer(id) {
    this.assertOpen();
    this.#containers.delete(id);
  }
  cleanup() {
    if (this.#state !== "open") return this.#promise;
    this.#state = "closing";
    this.#promise = (async () => {
      while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
      const failures = [];
      while (this.#containers.size > 0) {
        const id = this.#containers.values().next().value;
        this.#containers.delete(id);
        try { await this.removeContainer(id); } catch { failures.push("container-removal-failed"); }
      }
      for (const root of this.#roots) {
        try { await this.removeRoot(root); } catch { failures.push("state-removal-failed"); }
      }
      try { await this.audit(); } catch { failures.push("proof-resource-audit-failed"); }
      this.#state = "closed";
      if (failures.length > 0) throw new Error(failures.join(","));
    })();
    return this.#promise;
  }
}
