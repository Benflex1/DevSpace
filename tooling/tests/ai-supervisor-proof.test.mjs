import assert from "node:assert/strict";
import test from "node:test";
import {
  beginProofShutdown, BINDING_KEYS, bindingsEqual, classifyCgroupProbe, CleanupLifecycle,
  cleanupPlan, credentialEqual, deriveSocketPath, DockerMultiplexParser, escalationDecision,
  isProofOperationAborted, parseBinding, parseBootstrap, parseControlRequest, parseJsonLine,
  parseOwnershipRecord, parseProcStat, parseReadiness, parseReadinessFrames,
  processIdentityEqual, ProofOperationFence, redact, SerializedRequestLedger,
  spawnConfigurationContainsSecret, validateDescendantBoundary, validateStableTopology
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
  assert.equal(deriveSocketPath(binding), socketPath);
  assert.throws(() => parseOwnershipRecord({
    ...record,
    socketPath: "/tmp/devspace-ai-proof/01990000-0000-7000-8000-000000000099-1.sock"
  }), /ownership-record-binding-mismatch/u);
  assert.throws(() => parseOwnershipRecord({
    ...record,
    socketPath: `/tmp/devspace-ai-proof/${binding.aiSessionId}-2.sock`
  }), /ownership-record-binding-mismatch/u);
});

test("ownership parsing rejects semantically inconsistent topology before use", () => {
  const mutations = [
    ["provider-parent", (value) => { value.ownership.provider.ppid = 99; }],
    ["provider-group", (value) => { value.ownership.provider.pgid = 99; }],
    ["escaped-pgid", (value) => { value.ownership.descendants[0].pgid = 99; }],
    ["escaped-sid", (value) => { value.ownership.descendants[0].sid = 99; }],
    ["crossed-namespace", (value) => { value.ownership.descendants[0].pidNamespace = "pid:[99]"; }],
    ["altered-parent", (value) => { value.ownership.descendants[1].ppid = 1; }],
    ["inconsistent-member", (value) => {
      value.ownership.groupMembers[1] = {
        ...value.ownership.groupMembers[1],
        startTime: "9999"
      };
    }],
    ["foreign-member", (value) => { value.ownership.groupMembers.push(identity(99, 1)); }],
    ["duplicate-pid", (value) => {
      value.ownership.descendants[1].pid = value.ownership.descendants[0].pid;
      value.ownership.descendants[1].nspid = [...value.ownership.descendants[0].nspid];
    }],
    ["missing-descendant", (value) => {
      value.ownership.descendants.pop();
      value.ownership.groupMembers.pop();
    }]
  ];
  for (const [name, mutation] of mutations) {
    const crossed = structuredClone(record);
    mutation(crossed);
    assert.throws(() => parseOwnershipRecord(crossed), /invalid-ownership/u, name);
  }
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
test("readiness framing rejects trailing partial and additional frames", () => {
  const ready = frame(1, '{"type":"supervisor-ready"}\n');
  const partialHeader = new DockerMultiplexParser();
  const parsedReady = partialHeader.push(Buffer.concat([ready, Buffer.from([1, 0])]));
  assert.deepEqual(parseReadinessFrames(parsedReady), { type: "supervisor-ready" });
  assert.throws(() => partialHeader.assertBoundary(), /header-truncated/u);

  const partialPayload = new DockerMultiplexParser();
  partialPayload.push(Buffer.concat([ready, frame(1, "abc").subarray(0, 9)]));
  assert.throws(() => partialPayload.assertBoundary(), /payload-truncated/u);

  assert.throws(() => parseReadinessFrames([
    { kind: "stdout", payload: Buffer.from('{"type":"supervisor-ready"}\n') },
    { kind: "stdout", payload: Buffer.from("{}\n") }
  ]), /framing-invalid/u);
  assert.throws(() => parseReadinessFrames([
    { kind: "stderr", payload: Buffer.from('{"type":"supervisor-ready"}\n') }
  ]), /framing-invalid/u);
});
test("Docker multiplex parser enforces a total frame-count boundary including empty frames", () => {
  const parser = new DockerMultiplexParser({ maxFrameCount: 2 });
  assert.equal(parser.push(Buffer.concat([frame(1, ""), frame(2, "")])).length, 2);
  parser.assertBoundary();
  assert.throws(() => parser.push(frame(1, "")), /frame-count-exceeded/u);
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

test("request IDs remain tombstoned and capacity fails closed beyond the old eviction boundary", async () => {
  const ledger = new SerializedRequestLedger(256);
  let effects = 0;
  const firstId = "01990000-0000-4000-8000-000000000000";
  const first = await ledger.run(firstId, "interrupt", async () => ++effects);
  for (let index = 1; index < 256; index += 1) {
    const id = `01990000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    await ledger.run(id, `operation-${index}`, async () => ++effects);
  }
  assert.equal(effects, 256);
  assert.equal(await ledger.run(firstId, "interrupt", async () => ++effects), first);
  assert.deepEqual(await ledger.run(firstId, "conflict", async () => ++effects),
    { ok: false, code: "conflicting-request-id" });
  assert.deepEqual(await ledger.run(
    "01990000-0000-4000-8000-000000009999", "new", async () => ++effects
  ), { ok: false, code: "request-ledger-capacity-reached" });
  assert.equal(effects, 256);
});

test("cleanup incorporates late creation and rejects registration while closing", async () => {
  const removed = [];
  let resolveCreation;
  const creation = new Promise((resolve) => { resolveCreation = resolve; });
  const lifecycle = new CleanupLifecycle({
    removeContainer: async (id) => removed.push(id),
    removeRoot: async () => {},
    audit: async () => {}
  });
  const tracked = lifecycle.trackCreation(creation);
  const cleaning = lifecycle.cleanup();
  assert.equal(lifecycle.state, "closing");
  assert.throws(() => lifecycle.registerRoot("/tmp/devspace-ai-proof-late"), /cleanup-in-progress/u);
  resolveCreation("late-container");
  assert.equal(await tracked, "late-container");
  await cleaning;
  assert.deepEqual(removed, ["late-container"]);
  assert.equal(lifecycle.state, "closed");
  await lifecycle.cleanup();
  assert.deepEqual(removed, ["late-container"]);
});

test("signal transition fences the next helper mutation and every awaited side-effect stage", async () => {
  const removed = [];
  const cleanup = new CleanupLifecycle({
    removeContainer: async (id) => removed.push(id),
    removeRoot: async () => {},
    audit: async () => {}
  });
  const controller = new AbortController();
  const counters = new Map();
  const fence = new ProofOperationFence(cleanup, controller.signal, counters);
  const effects = {
    createExec: 0, startExec: 0, socketConnect: 0, providerInput: 0, signalControl: 0
  };
  const guardedHelper = async (action = "send") => {
    const execId = await fence.run("create-exec", async () => {
      effects.createExec += 1;
      return "exec";
    });
    await fence.run("start-exec", async () => {
      assert.equal(execId, "exec");
      effects.startExec += 1;
    });
    await fence.run("socket-connect", async () => { effects.socketConnect += 1; });
    await fence.run("provider-input", async () => {
      effects.providerInput += 1;
      if (action === "fixture-stop") effects.signalControl += 1;
    });
  };

  await guardedHelper();
  assert.deepEqual(effects, {
    createExec: 1, startExec: 1, socketConnect: 1, providerInput: 1, signalControl: 0
  });

  let releaseContinuation;
  const paused = new Promise((resolve) => { releaseContinuation = resolve; });
  const continuation = (async () => {
    await paused;
    return guardedHelper("fixture-stop");
  })();
  const firstShutdown = beginProofShutdown(cleanup, controller);
  const secondShutdown = beginProofShutdown(cleanup, controller);
  assert.equal(firstShutdown, secondShutdown);
  assert.equal(cleanup.state, "closing");
  releaseContinuation();
  await assert.rejects(continuation, isProofOperationAborted);
  await firstShutdown;
  assert.deepEqual(effects, {
    createExec: 1, startExec: 1, socketConnect: 1, providerInput: 1, signalControl: 0
  });
  assert.equal(cleanup.state, "closed");
});

test("in-flight guarded stages cannot advance after cleanup begins", async () => {
  for (const [pausedStage, forbiddenStage] of [
    ["create-exec", "start-exec"],
    ["start-exec", "provider-input"],
    ["recovery-inspect", "socket-connect"]
  ]) {
    const cleanup = new CleanupLifecycle({
      removeContainer: async () => {},
      removeRoot: async () => {},
      audit: async () => {}
    });
    const controller = new AbortController();
    const counters = new Map();
    const fence = new ProofOperationFence(cleanup, controller.signal, counters);
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const operation = fence.run(pausedStage, () => pending);
    const shutdown = beginProofShutdown(cleanup, controller);
    release("completed-remotely");
    await assert.rejects(operation, isProofOperationAborted);
    await assert.rejects(
      fence.run(forbiddenStage, async () => "must-not-run"),
      isProofOperationAborted
    );
    await shutdown;
    assert.equal(counters.get(pausedStage), 1);
    assert.equal(counters.has(forbiddenStage), false);
  }
});

test("spawn configuration secret checks cover argv and environment", () => {
  const secret = "e".repeat(64);
  assert.equal(spawnConfigurationContainsSecret(["worker", "--fixed"], { SAFE: "yes" }, secret), false);
  assert.equal(spawnConfigurationContainsSecret(["worker", secret], { SAFE: "yes" }, secret), true);
  assert.equal(spawnConfigurationContainsSecret(["worker"], { PRIVATE: secret }, secret), true);
});

test("cgroup probe classification conditions the executable verdict", () => {
  const current = {
    version: 2,
    namespace: "cgroup:[42]",
    path: "0::/",
    mountReadOnly: true,
    controllers: ["cpu", "memory", "pids"],
    subtreeControl: [],
    delegatedChild: false,
    childCreation: "read-only",
    killPresent: true,
    killWritable: false,
    rootlessWritableCgroup: "rejected-by-rootless-user-namespace"
  };
  assert.equal(classifyCgroupProbe(current).outcome, "BLOCKED");
  assert.equal(classifyCgroupProbe({ ...current, version: 1, path: "2:cpu:/" }).outcome,
    "ENVIRONMENT_CHANGED_REVIEW_REQUIRED");
  assert.equal(classifyCgroupProbe({
    ...current, mountReadOnly: false, delegatedChild: true, childCreation: "created"
  }).outcome, "ENVIRONMENT_CHANGED_REVIEW_REQUIRED");
  assert.equal(classifyCgroupProbe({
    ...current, mountReadOnly: false, killWritable: true
  }).outcome, "ENVIRONMENT_CHANGED_REVIEW_REQUIRED");
  assert.equal(classifyCgroupProbe({
    ...current, rootlessWritableCgroup: "started"
  }).outcome, "ENVIRONMENT_CHANGED_REVIEW_REQUIRED");
  assert.equal(classifyCgroupProbe({ ...current, controllers: "cpu memory" }).outcome,
    "PROBE_FAILED");
  assert.equal(classifyCgroupProbe({
    ...current, delegatedChild: true, childCreation: "read-only"
  }).outcome, "PROBE_FAILED");
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
