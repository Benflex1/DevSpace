import { timingSafeEqual } from "node:crypto";

export const BINDING_KEYS = Object.freeze([
  "schemaVersion", "projectId", "workspaceId", "configurationRevisionId",
  "runtimePlanHash", "runtimeGeneration", "containerId", "aiSessionId",
  "profileId", "profileRevision", "processGeneration", "operationId", "dockerExecId"
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseBinding(value) {
  if (!plainObject(value) || Object.keys(value).sort().join("\0") !== [...BINDING_KEYS].sort().join("\0")) {
    throw new Error("invalid-binding-fields");
  }
  for (const key of BINDING_KEYS) {
    if ((key === "runtimeGeneration" || key === "processGeneration")
      ? !Number.isSafeInteger(value[key]) || value[key] < 1
      : typeof value[key] !== "string" || value[key].length < 1 || value[key].length > 256) {
      throw new Error(`invalid-binding-${key}`);
    }
  }
  if (value.schemaVersion !== "devspace.ai-supervisor-proof-binding/v1") throw new Error("invalid-binding-version");
  return Object.fromEntries(BINDING_KEYS.map((key) => [key, value[key]]));
}

export function parseBootstrap(value) {
  if (!plainObject(value) || Object.keys(value).sort().join("\0")
    !== ["binding", "credential", "format", "ignoreTerm", "socketPath"].sort().join("\0")
    || value.format !== "devspace.ai-supervisor-proof-bootstrap/v1"
    || typeof value.credential !== "string" || !/^[0-9a-f]{64}$/u.test(value.credential)
    || typeof value.socketPath !== "string" || !value.socketPath.startsWith("/tmp/devspace-ai-proof/")
    || typeof value.ignoreTerm !== "boolean") throw new Error("invalid-bootstrap");
  return { ...value, binding: parseBinding(value.binding) };
}

export function parseControlRequest(value) {
  if (!plainObject(value) || typeof value.action !== "string") throw new Error("invalid-control-request");
  const actions = new Set(["establish", "proof", "send", "interrupt", "malformed-provider", "exit-provider", "leak-inspect", "stop"]);
  const expectedKeys = ["action", "binding", "credential", "ownership", ...(value.action === "send" ? ["message"] : [])];
  if (!actions.has(value.action) || Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0")
    || typeof value.credential !== "string" || (!plainObject(value.ownership) && value.ownership !== null)
    || (value.action === "send" && !plainObject(value.message))) throw new Error("invalid-control-request");
  return { ...value, binding: parseBinding(value.binding) };
}

export function parseOwnershipRecord(value) {
  const keys = ["binding", "containerId", "credential", "format", "ownership", "socketPath", "supervisorExecId"];
  if (!plainObject(value) || Object.keys(value).sort().join("\0") !== keys.sort().join("\0")
    || value.format !== "devspace.ai-supervisor-proof-record/v1"
    || typeof value.credential !== "string" || !/^[0-9a-f]{64}$/u.test(value.credential)
    || typeof value.containerId !== "string" || typeof value.supervisorExecId !== "string"
    || typeof value.socketPath !== "string" || !plainObject(value.ownership)) throw new Error("invalid-ownership-record");
  return { ...value, binding: parseBinding(value.binding) };
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
  if (typeof text !== "string") throw new Error("invalid-proc-stat");
  const close = text.lastIndexOf(")");
  if (!text.startsWith("(") && !/^[1-9][0-9]* \(/u.test(text)) throw new Error("invalid-proc-stat");
  if (close < 3) throw new Error("invalid-proc-stat");
  const pid = Number(text.slice(0, text.indexOf(" ")));
  const fields = text.slice(close + 2).trim().split(/ +/u);
  const result = { pid, state: fields[0], ppid: Number(fields[1]), pgid: Number(fields[2]),
    sid: Number(fields[3]), startTime: fields[19] };
  if (![result.pid, result.ppid, result.pgid, result.sid].every(Number.isSafeInteger)
    || !/^[0-9]+$/u.test(result.startTime ?? "")) throw new Error("invalid-proc-stat");
  return result;
}

export function processIdentityEqual(left, right) {
  return plainObject(left) && plainObject(right)
    && ["pid", "ppid", "pgid", "sid", "startTime", "pidNamespace"].every((key) => left[key] === right[key])
    && Array.isArray(left.nspid) && Array.isArray(right.nspid)
    && left.nspid.length === right.nspid.length && left.nspid.every((value, index) => value === right.nspid[index]);
}

export function validateDescendantBoundary(supervisor, provider, descendants, groupMembers = [provider, ...descendants]) {
  if (provider.ppid !== supervisor.pid || provider.pgid !== provider.pid || provider.sid !== provider.pid) return false;
  const children = descendants.filter((item) => item.ppid === provider.pid);
  const childPids = new Set(children.map((item) => item.pid));
  const hasGrandchild = descendants.some((item) => childPids.has(item.ppid));
  const allowedPids = new Set([provider.pid, ...descendants.map((item) => item.pid)]);
  return children.length >= 1 && hasGrandchild && descendants.every((item) =>
    item.pid !== supervisor.pid && item.pgid === provider.pgid && item.sid === provider.sid
    && item.pidNamespace === provider.pidNamespace)
    && groupMembers.some((item) => item.pid === provider.pid)
    && groupMembers.every((item) => allowedPids.has(item.pid) && item.pgid === provider.pgid
      && item.sid === provider.sid && item.pidNamespace === provider.pidNamespace);
}

export function escalationDecision({ running, identityMatches, graceExpired }) {
  if (!running) return "already-exited";
  if (!identityMatches) return "reject";
  return graceExpired ? "force-group" : "graceful-group";
}

export function parseJsonLine(line) {
  if (typeof line !== "string" || !line.endsWith("\n") || line.slice(0, -1).includes("\n")) throw new Error("invalid-frame");
  const value = JSON.parse(line.slice(0, -1));
  if (!plainObject(value)) throw new Error("invalid-frame");
  return value;
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /credential|secret|token/iu.test(key) ? "<redacted>" : redact(item)]));
}

export function cleanupPlan({ containerId, recordPath }) {
  return [
    { kind: "remove-container", containerId },
    { kind: "remove-record", recordPath }
  ];
}
