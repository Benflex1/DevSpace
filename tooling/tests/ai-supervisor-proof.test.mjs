import assert from "node:assert/strict";
import test from "node:test";
import {
  BINDING_KEYS, bindingsEqual, cleanupPlan, credentialEqual, DockerMultiplexParser,
  escalationDecision, parseBinding, parseBootstrap, parseControlRequest, parseJsonLine,
  parseOwnershipRecord, parseProcStat, parseReadiness, processIdentityEqual, redact,
  SerializedRequestLedger, validateDescendantBoundary, validateStableTopology
} from "../ai-supervisor-proof/core.mjs";

const dockerId = "a".repeat(64);
const execId = "b".repeat(64);
const binding = {
  schemaVersion: "devspace.ai-supervisor-proof-binding/v1",
  projectId: "01990000-0000-7000-8000-000000000001",
  workspaceId: "01990000-0000-7000-8000-000000000002",
  configurationRevisionId: "01990000-0000-7000-8000-000000000003",
  runtimePlanHash: `sha256-runtime-plan-v1:${"c".repeat(64)}`,
  runtimeGeneration: 1,
  containerId: dockerId,
  aiSessionId: "01990000-0000-7000-8000-000000000004",
  profileId: "proof-profile",
  profileRevision: `sha256-ai-profile-v1:${"d".repeat(64)}`,
  processGeneration: 1,
  operationId: "01990000-0000-7000-8000-000000000005",
  dockerExecId: execId
};
assert.deepEqual(Object.keys(binding), [...BINDING_KEYS]);
const identity = (pid, ppid, pgid = 10, sid = 10) => ({
  pid, ppid, pgid, sid, startTime: String(1000 + pid),
  nspid: [100 + pid, pid], pidNamespace: "pid:[42]", state: "S"
});
const supervisor = identity(5, 1, 5, 5);
const provider = identity(10, 5);
const child = identity(11, 10);
const grandchild = identity(12, 11);
const sentinel = identity(1, 0, 1, 1);
const ownership = {
  supervisor, provider, descendants: [child, grandchild],
  groupMembers: [provider, child, grandchild], sentinel,
  descendantBoundary: {
    kind: "process-group-experiment", pgid: 10, sid: 10, pidNamespace: "pid:[42]"
  },
  dockerExecProcess: {
    outerPid: 999, bindingMethod: "authenticated-exact-exec-stdin-bootstrap"
  }
};
const credential = "e".repeat(64);
const socketPath = `/tmp/devspace-ai-proof/${binding.aiSessionId}-1.sock`;
const record = {
  format: "devspace.ai-supervisor-proof-record/v2",
  credential, socketPath, binding, ownership, containerId: dockerId, supervisorExecId: execId
};

test("realistic strict binding rejects missing, unknown, and invalid identifiers", () => {
  assert.deepEqual(parseBinding(binding), binding);
  const missing = { ...binding }; delete missing.workspaceId;
  assert.throws(() => parseBinding(missing), /invalid-binding/u);
  assert.throws(() => parseBinding({ ...binding, extra: true }), /invalid-binding/u);
  assert.throws(() => parseBinding({ ...binding, projectId: "fixture" }), /invalid-binding/u);
  assert.throws(() => parseBinding({ ...binding, containerId: "short" }), /invalid-binding/u);
  assert.throws(() => parseBinding({ ...binding, runtimeGeneration: Number.MAX_SAFE_INTEGER + 1 }),
    /invalid-binding/u);
  assert.equal(bindingsEqual(binding, { ...binding, profileRevision: `sha256-ai-profile-v1:${"f".repeat(64)}` }), false);
});

test("bootstrap, control request, and ownership records reject unknown and crossed fields", () => {
  const bootstrap = {
    format: "devspace.ai-supervisor-proof-bootstrap/v2",
    credential, socketPath, binding, fixtureMode: "cooperative"
  };
  assert.equal(parseBootstrap(bootstrap).credential, credential);
  assert.throws(() => parseBootstrap({ ...bootstrap, extra: true }), /invalid-bootstrap/u);
  const control = {
    action: "proof", credential, binding, ownership, payload: null,
    requestId: "01990000-0000-4000-8000-000000000006"
  };
  assert.equal(parseControlRequest(control).action, "proof");
  assert.throws(() => parseControlRequest({ ...control, requestId: "bad" }), /invalid-control-request/u);
  assert.equal(parseOwnershipRecord(record).containerId, dockerId);
  assert.throws(() => parseOwnershipRecord({ ...record, extra: true }), /invalid-ownership-record/u);
  assert.throws(() => parseOwnershipRecord({ ...record, containerId: "f".repeat(64) }),
    /ownership-record-binding-mismatch/u);
  assert.throws(() => parseOwnershipRecord({ ...record, supervisorExecId: "f".repeat(64) }),
    /ownership-record-binding-mismatch/u);
  assert.throws(() => parseOwnershipRecord({
    ...record, ownership: { ...ownership, provider: { ...provider, nspid: ["bad"] } }
  }), /invalid-process-identity/u);
});

test("credential comparison is constant-time shaped and strict on type, length, and bytes", () => {
  assert.equal(credentialEqual(credential, credential), true);
  assert.equal(credentialEqual(credential, "f".repeat(64)), false);
  assert.equal(credentialEqual(credential, "short"), false);
  assert.equal(credentialEqual(credential, null), false);
});

test("proc stat parsing rejects malformed and unsafe numeric identities", () => {
  const fields = ["S", "10", "20", "30", ...Array(15).fill("0"), "98765", "0"];
  const parsed = parseProcStat(`42 (fixture (worker)) ${fields.join(" ")}`);
  assert.deepEqual(
    { pid: parsed.pid, ppid: parsed.ppid, pgid: parsed.pgid, sid: parsed.sid, startTime: parsed.startTime },
    { pid: 42, ppid: 10, pgid: 20, sid: 30, startTime: "98765" }
  );
  assert.throws(() => parseProcStat(`42 (fixture) S x 20 30 ${Array(17).fill("0").join(" ")}`),
    /invalid-proc-stat/u);
  assert.throws(() => parseProcStat(`42 (fixture) S 10 20 30 ${Array(15).fill("0").join(" ")} 1e9`),
    /invalid-proc-stat/u);
});

test("coherent topology rejects escape, foreign member, mutation, and churn", () => {
  assert.equal(validateDescendantBoundary(supervisor, provider, [child, grandchild],
    [provider, child, grandchild]), true);
  assert.equal(validateDescendantBoundary(supervisor, provider, [
    child, { ...grandchild, pgid: 99, sid: 99 }
  ], [provider, child]), false);
  assert.equal(validateDescendantBoundary(supervisor, provider, [child, grandchild],
    [provider, child, grandchild, identity(99, 1)]), false);
  const snapshot = { supervisor, provider, descendants: [child, grandchild],
    groupMembers: [provider, child, grandchild] };
  assert.equal(validateStableTopology(snapshot, structuredClone(snapshot)), true);
  assert.equal(validateStableTopology(snapshot, {
    ...structuredClone(snapshot),
    descendants: [child, { ...grandchild, startTime: "9999" }]
  }), false);
  assert.equal(processIdentityEqual(provider, { ...provider, startTime: "9999" }), false);
});

function frame(kind, payload, reserved = [0, 0, 0]) {
  const bytes = Buffer.from(payload);
  const header = Buffer.alloc(8);
  header[0] = kind;
  header.set(reserved, 1);
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}
test("incremental Docker multiplex parser accepts valid split frames", () => {
  const parser = new DockerMultiplexParser();
  const bytes = Buffer.concat([frame(1, '{"type":"supervisor-ready"}\n'), frame(2, "private\n")]);
  const frames = [...parser.push(bytes.subarray(0, 5)), ...parser.push(bytes.subarray(5))];
  parser.finish();
  assert.equal(frames[0].kind, "stdout");
  assert.equal(frames[1].kind, "stderr");
});
test("Docker multiplex parser rejects kind, reserved, truncation, and excess", () => {
  assert.throws(() => new DockerMultiplexParser().push(frame(3, "x")), /kind-invalid/u);
  assert.throws(() => new DockerMultiplexParser().push(frame(1, "x", [1, 0, 0])), /reserved-invalid/u);
  const header = new DockerMultiplexParser(); header.push(Buffer.from([1, 0])); assert.throws(() => header.finish(), /header-truncated/u);
  const payload = new DockerMultiplexParser(); payload.push(frame(1, "abc").subarray(0, 9));
  assert.throws(() => payload.finish(), /payload-truncated/u);
  assert.throws(() => new DockerMultiplexParser({ maxFrameBytes: 1 }).push(frame(1, "ab")), /too-large/u);
});
test("readiness requires one exact stdout JSONL object and empty stderr", () => {
  assert.deepEqual(parseReadiness('{"type":"supervisor-ready"}\n', ""), { type: "supervisor-ready" });
  for (const [stdout, stderr] of [
    ["prefix supervisor-ready\n", ""],
    ['{"type":"supervisor-ready"}\n{"type":"supervisor-ready"}\n', ""],
    ['{"type":"other","value":"supervisor-ready"}\n', ""],
    ['{"type":"supervisor-ready"}', ""],
    ['{"type":"supervisor-ready"}\n', "diagnostic"]
  ]) assert.throws(() => parseReadiness(stdout, stderr), /readiness-invalid/u);
});

test("request ledger correlates duplicates, rejects conflicts, and serializes mutations", async () => {
  const ledger = new SerializedRequestLedger();
  const firstId = "01990000-0000-4000-8000-000000000010";
  const secondId = "01990000-0000-4000-8000-000000000011";
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = ledger.run(firstId, "stop", async () => { order.push("first-start"); await gate; order.push("first-end"); return "done"; });
  const duplicate = ledger.run(firstId, "stop", () => "must-not-run");
  const second = ledger.run(secondId, "interrupt", async () => { order.push("second"); return "next"; });
  assert.deepEqual(await ledger.run(firstId, "different", () => "bad"),
    { ok: false, code: "conflicting-request-id" });
  release();
  assert.equal(await first, "done");
  assert.equal(await duplicate, "done");
  assert.equal(await second, "next");
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});

test("framing, escalation, nested redaction, and cleanup planning fail closed", () => {
  assert.deepEqual(parseJsonLine('{"action":"proof"}\n'), { action: "proof" });
  assert.throws(() => parseJsonLine('{"action":"proof"}'), /invalid-frame/u);
  assert.equal(escalationDecision({
    running: true, identityMatches: false, boundaryValid: true, graceExpired: true
  }), "reject");
  assert.equal(escalationDecision({
    running: true, identityMatches: true, boundaryValid: false, graceExpired: true
  }), "reject");
  assert.equal(escalationDecision({
    running: true, identityMatches: true, boundaryValid: true, graceExpired: true
  }), "fixture-force-group");
  assert.deepEqual(redact({
    credential: "value", nested: { token: "value", safe: 1 }, list: [{ requestBody: "private" }]
  }), {
    credential: "<redacted>", nested: { token: "<redacted>", safe: 1 },
    list: [{ requestBody: "<redacted>" }]
  });
  assert.deepEqual(cleanupPlan({ containerId: dockerId, recordPath: "/tmp/devspace-ai-proof-fixture/a.json" }), [
    { kind: "remove-container", containerId: dockerId },
    { kind: "remove-record", recordPath: "/tmp/devspace-ai-proof-fixture/a.json" }
  ]);
  assert.throws(() => cleanupPlan({ containerId: "bad", recordPath: "/tmp/a" }), /invalid-cleanup-plan/u);
});
