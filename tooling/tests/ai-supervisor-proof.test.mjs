import assert from "node:assert/strict";
import test from "node:test";
import {
  BINDING_KEYS, bindingsEqual, cleanupPlan, credentialEqual, escalationDecision,
  parseBinding, parseBootstrap, parseControlRequest, parseJsonLine, parseOwnershipRecord, parseProcStat, processIdentityEqual, redact,
  validateDescendantBoundary
} from "../ai-supervisor-proof/core.mjs";

const binding = Object.fromEntries(BINDING_KEYS.map((key) => [key,
  key === "runtimeGeneration" || key === "processGeneration" ? 1
    : key === "schemaVersion" ? "devspace.ai-supervisor-proof-binding/v1" : `${key}-fixture`]));
const identity = { pid: 10, ppid: 1, pgid: 10, sid: 10, startTime: "1234",
  nspid: [100, 10], pidNamespace: "pid:[42]", state: "S" };

test("strict binding rejects missing, unknown, and mutated identities", () => {
  assert.deepEqual(parseBinding(binding), binding);
  assert.throws(() => parseBinding({ ...binding, extra: true }), /invalid-binding-fields/u);
  const missing = { ...binding }; delete missing.workspaceId;
  assert.throws(() => parseBinding(missing), /invalid-binding-fields/u);
  assert.equal(bindingsEqual(binding, { ...binding, profileRevision: "different" }), false);
});

test("bootstrap, control, and ownership records are strict", () => {
  const credential = "a".repeat(64);
  assert.equal(parseBootstrap({ format: "devspace.ai-supervisor-proof-bootstrap/v1", credential,
    socketPath: "/tmp/devspace-ai-proof/session.sock", binding, ignoreTerm: false }).credential, credential);
  assert.throws(() => parseBootstrap({ format: "devspace.ai-supervisor-proof-bootstrap/v1", credential,
    socketPath: "/tmp/devspace-ai-proof/session.sock", binding, ignoreTerm: false, extra: true }), /invalid-bootstrap/u);
  assert.equal(parseControlRequest({ action: "proof", credential, binding, ownership: {} }).action, "proof");
  assert.throws(() => parseControlRequest({ action: "proof", credential, binding, ownership: {}, extra: true }),
    /invalid-control-request/u);
  const record = { format: "devspace.ai-supervisor-proof-record/v1", credential,
    socketPath: "/tmp/devspace-ai-proof/session.sock", binding, ownership: {}, containerId: "container",
    supervisorExecId: "exec" };
  assert.equal(parseOwnershipRecord(record).containerId, "container");
  assert.throws(() => parseOwnershipRecord({ ...record, format: "wrong" }), /invalid-ownership-record/u);
});

test("credential comparison accepts exact values and rejects wrong types, lengths, and bytes", () => {
  const credential = "a".repeat(64);
  assert.equal(credentialEqual(credential, credential), true);
  assert.equal(credentialEqual(credential, "b".repeat(64)), false);
  assert.equal(credentialEqual(credential, "short"), false);
  assert.equal(credentialEqual(credential, null), false);
});

test("proc stat parser handles spaces and parentheses in comm", () => {
  const fields = ["S", "10", "20", "30", "0", "0", "0", "0", "0", "0", "0", "0",
    "0", "0", "0", "0", "0", "0", "0", "98765", "0"];
  const parsed = parseProcStat(`42 (fixture (worker)) ${fields.join(" ")}`);
  assert.deepEqual({ pid: parsed.pid, ppid: parsed.ppid, pgid: parsed.pgid, sid: parsed.sid,
    startTime: parsed.startTime }, { pid: 42, ppid: 10, pgid: 20, sid: 30, startTime: "98765" });
});

test("process start identity and descendant boundary require every stable field", () => {
  assert.equal(processIdentityEqual(identity, { ...identity }), true);
  assert.equal(processIdentityEqual(identity, { ...identity, startTime: "1235" }), false);
  const supervisor = { ...identity, pid: 5, pgid: 5, sid: 5 };
  const provider = { ...identity, ppid: 5 };
  assert.equal(validateDescendantBoundary(supervisor, provider, [
    { ...identity, pid: 11, ppid: 10 }, { ...identity, pid: 12, ppid: 11 }
  ]), true);
  assert.equal(validateDescendantBoundary(supervisor, provider, [
    { ...identity, pid: 11, ppid: 10 }, { ...identity, pid: 12, ppid: 11, pgid: 99 }
  ]), false);
  assert.equal(validateDescendantBoundary(supervisor, provider, [
    { ...identity, pid: 11, ppid: 10 }, { ...identity, pid: 12, ppid: 11 }
  ], [provider, { ...identity, pid: 11, ppid: 10 }, { ...identity, pid: 12, ppid: 11 },
    { ...identity, pid: 99, ppid: 1 }]), false);
});

test("framing, escalation, redaction, and cleanup planning fail closed", () => {
  assert.deepEqual(parseJsonLine('{"action":"proof"}\n'), { action: "proof" });
  assert.throws(() => parseJsonLine('{"action":"proof"}'), /invalid-frame/u);
  assert.equal(escalationDecision({ running: true, identityMatches: false, graceExpired: true }), "reject");
  assert.equal(escalationDecision({ running: true, identityMatches: true, graceExpired: true }), "force-group");
  assert.deepEqual(redact({ credential: "value", nested: { token: "value", safe: 1 } }),
    { credential: "<redacted>", nested: { token: "<redacted>", safe: 1 } });
  assert.deepEqual(cleanupPlan({ containerId: "container", recordPath: "/tmp/record" }), [
    { kind: "remove-container", containerId: "container" },
    { kind: "remove-record", recordPath: "/tmp/record" }
  ]);
});
