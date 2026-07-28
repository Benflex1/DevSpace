import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, readlink, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindingsEqual, credentialEqual, parseBootstrap, parseControlRequest, parseJsonLine,
  parseProcStat, processIdentityEqual, SerializedRequestLedger,
  validateDescendantBoundary, validateStableTopology
} from "./core.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const MAX_CLIENTS = 4;
const CLIENT_IDLE_MS = 2_000;
const RESPONSE_LIMIT = 64 * 1024;

async function identity(pid) {
  const parsed = parseProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const rawNspid = status.match(/^NSpid:\s+(.+)$/mu)?.[1];
  if (rawNspid === undefined) throw new Error("nspid-unavailable");
  const nspid = rawNspid.trim().split(/\s+/u).map(Number);
  return { ...parsed, nspid, pidNamespace: await readlink(`/proc/${pid}/ns/pid`) };
}

async function processSnapshot(rootPid, providerPgid) {
  const identities = [];
  for (const entry of await readdir("/proc")) {
    if (!/^[1-9][0-9]*$/u.test(entry)) continue;
    try { identities.push(await identity(Number(entry))); } catch { /* Bounded non-atomic scan. */ }
  }
  identities.sort((left, right) => left.pid - right.pid);
  const descendants = [];
  const tree = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const candidate of identities) {
      if (!tree.has(candidate.pid) && tree.has(candidate.ppid)) {
        tree.add(candidate.pid); descendants.push(candidate); changed = true;
      }
    }
  }
  const groupMembers = identities.filter((item) => item.pgid === providerPgid);
  return { descendants, groupMembers };
}

async function stableProof(supervisorPid, providerPid, expectedSupervisor, expectedProvider) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const supervisor = await identity(supervisorPid);
    const provider = await identity(providerPid);
    const first = { supervisor, provider, ...await processSnapshot(providerPid, provider.pgid) };
    await delay(20);
    const secondSupervisor = await identity(supervisorPid);
    const secondProvider = await identity(providerPid);
    const second = {
      supervisor: secondSupervisor,
      provider: secondProvider,
      ...await processSnapshot(providerPid, secondProvider.pgid)
    };
    if (processIdentityEqual(supervisor, expectedSupervisor)
      && processIdentityEqual(provider, expectedProvider)
      && validateStableTopology(first, second)) return second;
  }
  throw new Error("process-topology-unstable-or-escaped");
}

async function readBootstrap() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const { value: text, done } = await lines[Symbol.asyncIterator]().next();
  lines.close();
  if (done || Buffer.byteLength(text) > 32_768) throw new Error("bootstrap-invalid");
  return parseBootstrap(JSON.parse(text));
}

const bootstrap = await readBootstrap();
const socketDirectory = path.dirname(bootstrap.socketPath);
await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
await chmod(socketDirectory, 0o700);
await rm(bootstrap.socketPath, { force: true });

const fixtureArguments = [
  fileURLToPath(new URL("./fixture-provider.mjs", import.meta.url)),
  `--mode=${bootstrap.fixtureMode}`
];
const provider = spawn(process.execPath, fixtureArguments, {
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
  env: { PATH: process.env.PATH ?? "" }
});

const initialSupervisor = await identity(process.pid);
const initialProvider = await identity(provider.pid);
let initialProof;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    initialProof = await stableProof(
      process.pid, provider.pid, initialSupervisor, initialProvider
    );
    if (initialProof.descendants.length >= 2) break;
  } catch { /* Fixture descendants may still be starting. */ }
  await delay(25);
}
if (initialProof === undefined || initialProof.descendants.length < 2
  || !validateDescendantBoundary(
    initialProof.supervisor, initialProof.provider,
    initialProof.descendants, initialProof.groupMembers
  )) throw new Error("fixture-process-group-unproven");
if (bootstrap.fixtureMode === "group-churn") throw new Error("fixture-process-group-topology-churn");

const initialOwnership = {
  ...initialProof,
  sentinel: await identity(1),
  descendantBoundary: {
    kind: "process-group-experiment",
    pgid: initialProvider.pgid,
    sid: initialProvider.sid,
    pidNamespace: initialProvider.pidNamespace
  }
};
if (initialOwnership.sentinel.pgid === initialProvider.pgid) {
  throw new Error("sentinel-boundary-conflict");
}

let eventSequence = 0;
let pendingMalformedRequestId = null;
const events = [];
const diagnostics = [];
let stdoutBuffer = "";
provider.stdout.setEncoding("utf8");
provider.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  while (stdoutBuffer.includes("\n")) {
    const index = stdoutBuffer.indexOf("\n");
    const line = stdoutBuffer.slice(0, index);
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    try {
      const event = JSON.parse(line);
      if (event === null || typeof event !== "object" || Array.isArray(event)) throw new Error();
      events.push({ ...event, sequence: ++eventSequence });
    } catch {
      events.push({
        type: "protocol-error", requestId: pendingMalformedRequestId, sequence: ++eventSequence
      });
      pendingMalformedRequestId = null;
      diagnostics.push("provider-stdout-invalid-jsonl");
    }
  }
});
provider.stderr.setEncoding("utf8");
provider.stderr.on("data", () => diagnostics.push("provider-private-diagnostic"));

const providerRunning = () => provider.exitCode === null && provider.signalCode === null;
async function currentProof() {
  if (!processIdentityEqual(await identity(process.pid), initialSupervisor)) {
    throw new Error("supervisor-identity-mismatch");
  }
  if (!providerRunning()) return { ownership: initialOwnership, providerState: "exited", eventSequence };
  const proof = await stableProof(process.pid, provider.pid, initialSupervisor, initialProvider);
  return {
    ownership: { ...initialOwnership, ...proof },
    providerState: "running",
    eventSequence
  };
}

function claimsMatch(ownership) {
  return processIdentityEqual(ownership.supervisor, initialOwnership.supervisor)
    && processIdentityEqual(ownership.provider, initialOwnership.provider)
    && ownership.descendantBoundary.kind === "process-group-experiment"
    && ownership.descendantBoundary.pgid === initialOwnership.descendantBoundary.pgid
    && ownership.descendantBoundary.sid === initialOwnership.descendantBoundary.sid
    && ownership.descendantBoundary.pidNamespace === initialOwnership.descendantBoundary.pidNamespace;
}

async function awaitEvent(requestId, baseline, type, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = events.find((event) => event.sequence > baseline
      && event.requestId === requestId && event.type === type);
    if (found !== undefined) return found;
    await delay(20);
  }
  throw new Error("provider-response-timeout");
}

const mutationLedger = new SerializedRequestLedger(256);
function serializeMutation(request, operation) {
  const canonical = JSON.stringify({ action: request.action, payload: request.payload });
  return mutationLedger.run(request.requestId, canonical, operation);
}

async function fixtureStop() {
  if (!providerRunning()) return { state: "already-exited", signalSent: false };
  await currentProof();
  process.kill(-initialProvider.pgid, "SIGTERM");
  const deadline = Date.now() + 300;
  while (providerRunning() && Date.now() < deadline) await delay(20);
  let escalated = false;
  if (providerRunning()) {
    await currentProof();
    process.kill(-initialProvider.pgid, "SIGKILL");
    escalated = true;
  }
  const exitDeadline = Date.now() + 1_000;
  while (providerRunning() && Date.now() < exitDeadline) await delay(20);
  if (providerRunning()) throw new Error("fixture-stop-timeout");
  return { state: "stopped", signalSent: true, escalated, authority: "fixture-process-group-experiment" };
}

async function handle(rawRequest) {
  let request;
  try { request = parseControlRequest(rawRequest); } catch { return { ok: false, code: "malformed-request" }; }
  if (!credentialEqual(bootstrap.credential, request.credential)
    || !bindingsEqual(bootstrap.binding, request.binding)) {
    return { ok: false, code: "authentication-failed" };
  }
  if (request.action !== "establish" && !claimsMatch(request.ownership)) {
    return { ok: false, code: "ownership-claim-mismatch" };
  }
  if (request.action === "establish" || request.action === "proof") {
    return { ok: true, result: await currentProof() };
  }
  return serializeMutation(request, async () => {
    if (request.action === "send") {
      await currentProof();
      const baseline = eventSequence;
      provider.stdin.write(`${JSON.stringify({
        type: "operation", requestId: request.requestId, operationId: request.payload.operationId,
        value: request.payload.value
      })}\n`);
      return { ok: true, result: await awaitEvent(request.requestId, baseline, "echo") };
    }
    if (request.action === "interrupt") {
      await currentProof();
      const baseline = eventSequence;
      provider.stdin.write(`${JSON.stringify({ type: "interrupt", requestId: request.requestId })}\n`);
      return { ok: true, result: await awaitEvent(request.requestId, baseline, "interrupted") };
    }
    if (request.action === "malformed-provider") {
      const baseline = eventSequence;
      pendingMalformedRequestId = request.requestId;
      provider.stdin.write(`${JSON.stringify({ type: "malformed", requestId: request.requestId })}\n`);
      return { ok: true, result: await awaitEvent(request.requestId, baseline, "protocol-error") };
    }
    if (request.action === "exit-provider") {
      provider.stdin.write(`${JSON.stringify({ type: "exit", requestId: request.requestId })}\n`);
      await new Promise((resolve) => provider.once("exit", resolve));
      return { ok: true, result: { state: "exited" } };
    }
    if (request.action === "leak-inspect") {
      const proof = await currentProof();
      const pids = [1, proof.ownership.supervisor.pid, ...(proof.providerState === "running"
        ? [proof.ownership.provider.pid, ...proof.ownership.descendants.map((item) => item.pid)] : [])];
      let credentialPresent = false;
      for (const pid of pids) {
        for (const name of ["cmdline", "environ"]) {
          try {
            if ((await readFile(`/proc/${pid}/${name}`)).includes(Buffer.from(bootstrap.credential))) {
              credentialPresent = true;
            }
          } catch { /* Process exited during inspection. */ }
        }
      }
      return { ok: true, result: { credentialPresent, inspectedProcessCount: pids.length } };
    }
    if (request.action === "fixture-stop") return { ok: true, result: await fixtureStop() };
    return { ok: false, code: "unsupported-action" };
  });
}

let activeClients = 0;
const server = createServer({ allowHalfOpen: true }, (socket) => {
  if (activeClients >= MAX_CLIENTS) {
    socket.destroy();
    return;
  }
  activeClients += 1;
  let input = "";
  let answered = false;
  socket.setEncoding("utf8");
  socket.setTimeout(CLIENT_IDLE_MS, () => socket.destroy());
  socket.on("data", (chunk) => {
    input += chunk;
    if (Buffer.byteLength(input) > 65_536 || (input.match(/\n/gu)?.length ?? 0) > 1) socket.destroy();
  });
  socket.on("end", async () => {
    if (answered) return;
    answered = true;
    let response;
    try { response = await handle(parseJsonLine(input)); } catch { response = { ok: false, code: "control-failure" }; }
    const encoded = `${JSON.stringify(response)}\n`;
    socket.end(Buffer.byteLength(encoded) <= RESPONSE_LIMIT
      ? encoded : '{"ok":false,"code":"response-too-large"}\n');
  });
  socket.on("close", () => { activeClients -= 1; });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(bootstrap.socketPath, resolve);
});
await chmod(bootstrap.socketPath, 0o600);

let cleanupPromise;
function cleanup() {
  cleanupPromise ??= (async () => {
    if (providerRunning()) {
      try { process.kill(-initialProvider.pgid, "SIGKILL"); } catch { /* Container deletion is outer fence. */ }
    }
    await new Promise((resolve) => server.close(resolve));
    await rm(socketDirectory, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => { void cleanup().then(() => { process.exitCode = 0; }); });
}
process.stdout.write('{"type":"supervisor-ready"}\n');
