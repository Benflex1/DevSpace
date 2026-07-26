import { timingSafeEqual } from "node:crypto";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONFIG_KEY = /^[a-z][a-z0-9-]{0,63}$/u;
const DOCKER_ID = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const SOCKET = /^\/tmp\/devspace-ai-proof\/[0-9a-f-]{36}-[1-9][0-9]*\.sock$/u;
const MAX_FRAME = 64 * 1024;
const MAX_STREAM = 256 * 1024;

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

export function parseBootstrap(value) {
  if (!exactKeys(value, ["binding", "credential", "fixtureMode", "format", "socketPath"])
    || value.format !== "devspace.ai-supervisor-proof-bootstrap/v2"
    || typeof value.credential !== "string" || !/^[0-9a-f]{64}$/u.test(value.credential)
    || typeof value.socketPath !== "string" || !SOCKET.test(value.socketPath)
    || !["cooperative", "ignore-term", "setsid-child", "double-fork", "group-churn"]
      .includes(value.fixtureMode)) throw new Error("invalid-bootstrap");
  return { ...value, binding: parseBinding(value.binding) };
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
    || typeof value.pidNamespace !== "string" || !/^pid:\[[1-9][0-9]*\]$/u.test(value.pidNamespace)
    || !Array.isArray(value.nspid) || value.nspid.length < 1 || value.nspid.length > 8
    || !value.nspid.every(safePositive)) throw new Error("invalid-process-identity");
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
  const allPids = [parsed.provider.pid, ...parsed.descendants.map((item) => item.pid)];
  if (new Set(allPids).size !== allPids.length || parsed.provider.ppid !== parsed.supervisor.pid
    || parsed.descendantBoundary.pgid !== parsed.provider.pgid
    || parsed.descendantBoundary.sid !== parsed.provider.sid
    || parsed.descendantBoundary.pidNamespace !== parsed.provider.pidNamespace
    || parsed.sentinel.pgid === parsed.provider.pgid) throw new Error("invalid-ownership-cross-field");
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
  if (provider.ppid !== supervisor.pid || provider.pgid !== provider.pid || provider.sid !== provider.pid) return false;
  const children = descendants.filter((item) => item.ppid === provider.pid);
  const childPids = new Set(children.map((item) => item.pid));
  const allowed = new Set([provider.pid, ...descendants.map((item) => item.pid)]);
  return children.length >= 1 && descendants.some((item) => childPids.has(item.ppid))
    && descendants.every((item) => item.pgid === provider.pgid && item.sid === provider.sid)
    && groupMembers.some((item) => item.pid === provider.pid)
    && groupMembers.every((item) => allowed.has(item.pid) && item.pgid === provider.pgid && item.sid === provider.sid)
    && allowed.size === groupMembers.length;
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
  constructor({ maxFrameBytes = MAX_FRAME, maxStreamBytes = MAX_STREAM } = {}) {
    this.maxFrameBytes = maxFrameBytes; this.maxStreamBytes = maxStreamBytes;
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
    const promise = this.#tail.then(operation, operation);
    this.#tail = promise.then(() => undefined, () => undefined);
    this.#completed.set(requestId, { content, promise });
    if (this.#completed.size > 256) this.#completed.delete(this.#completed.keys().next().value);
    return promise;
  }
}
