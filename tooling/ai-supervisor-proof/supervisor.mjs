import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, readlink, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindingsEqual, credentialEqual, parseBootstrap, parseControlRequest, parseProcStat,
  processIdentityEqual, validateDescendantBoundary
} from "./core.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function identity(pid) {
  const parsed = parseProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const nspid = status.match(/^NSpid:\s+(.+)$/mu)?.[1].trim().split(/\s+/u).map(Number) ?? [pid];
  return { ...parsed, nspid, pidNamespace: await readlink(`/proc/${pid}/ns/pid`) };
}

async function descendants(rootPid) {
  const entries = (await readdir("/proc")).filter((entry) => /^[1-9][0-9]*$/u.test(entry)).map(Number);
  const identities = [];
  for (const pid of entries) {
    try { identities.push(await identity(pid)); } catch { /* Process exited during bounded /proc scan. */ }
  }
  const selected = []; const parents = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const candidate of identities) {
      if (!parents.has(candidate.pid) && parents.has(candidate.ppid)) {
        parents.add(candidate.pid); selected.push(candidate); changed = true;
      }
    }
  }
  return selected;
}

async function processGroupMembers(pgid) {
  const members = [];
  for (const entry of await readdir("/proc")) {
    if (!/^[1-9][0-9]*$/u.test(entry)) continue;
    try {
      const candidate = await identity(Number(entry));
      if (candidate.pgid === pgid) members.push(candidate);
    } catch { /* Process exited during bounded /proc scan. */ }
  }
  return members;
}

async function readBootstrap() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const { value: text, done } = await lines[Symbol.asyncIterator]().next();
  lines.close();
  if (done || Buffer.byteLength(text) > 32_768) throw new Error("bootstrap-too-large");
  return parseBootstrap(JSON.parse(text));
}

const bootstrap = await readBootstrap();
const socketDirectory = path.dirname(bootstrap.socketPath);
await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
await chmod(socketDirectory, 0o700);
await rm(bootstrap.socketPath, { force: true });

const provider = spawn(process.execPath, [
  fileURLToPath(new URL("./fixture-provider.mjs", import.meta.url)),
  ...(bootstrap.ignoreTerm ? ["--ignore-term"] : [])
], { detached: true, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });

const initialSupervisor = await identity(process.pid);
const initialProvider = await identity(provider.pid);
let initialDescendants = [];
for (let attempt = 0; attempt < 40; attempt += 1) {
  initialDescendants = await descendants(provider.pid);
  if (initialDescendants.length >= 2) break;
  await delay(25);
}
const initialGroupMembers = await processGroupMembers(initialProvider.pgid);
if (!validateDescendantBoundary(initialSupervisor, initialProvider, initialDescendants, initialGroupMembers)) {
  throw new Error("descendant-boundary-unproven");
}

const events = [];
const diagnostics = [];
let stdoutBuffer = "";
provider.stdout.setEncoding("utf8");
provider.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  while (stdoutBuffer.includes("\n")) {
    const index = stdoutBuffer.indexOf("\n");
    const line = stdoutBuffer.slice(0, index); stdoutBuffer = stdoutBuffer.slice(index + 1);
    try {
      const event = JSON.parse(line);
      if (event === null || typeof event !== "object" || Array.isArray(event)) throw new Error();
      events.push(event);
    } catch { events.push({ type: "protocol-error" }); diagnostics.push("provider-stdout-invalid-jsonl"); }
  }
});
provider.stderr.setEncoding("utf8");
provider.stderr.on("data", () => { diagnostics.push("provider-stderr"); });

const initialOwnership = {
  supervisor: initialSupervisor,
  provider: initialProvider,
  descendants: initialDescendants,
  groupMembers: initialGroupMembers,
  sentinel: await identity(1),
  descendantBoundary: { kind: "process-group-session", pgid: initialProvider.pgid, sid: initialProvider.sid,
    pidNamespace: initialProvider.pidNamespace }
};
if (initialOwnership.sentinel.pgid === initialProvider.pgid) throw new Error("sentinel-boundary-conflict");
const providerRunning = () => provider.exitCode === null && provider.signalCode === null;

async function currentProof() {
  const supervisor = await identity(process.pid);
  if (!processIdentityEqual(supervisor, initialSupervisor)) throw new Error("supervisor-identity-mismatch");
  if (!providerRunning()) return { ...initialOwnership, providerState: "exited", events, diagnostics };
  const currentProvider = await identity(provider.pid);
  const currentDescendants = await descendants(provider.pid);
  const currentGroupMembers = await processGroupMembers(provider.pid);
  if (!processIdentityEqual(currentProvider, initialProvider)
    || !validateDescendantBoundary(supervisor, currentProvider, currentDescendants, currentGroupMembers)) {
    throw new Error("provider-identity-mismatch");
  }
  return { supervisor, provider: currentProvider, descendants: currentDescendants, groupMembers: currentGroupMembers,
    descendantBoundary: initialOwnership.descendantBoundary, providerState: "running", events, diagnostics };
}

function claimsMatch(request) {
  return request.ownership !== null && processIdentityEqual(request.ownership.supervisor, initialOwnership.supervisor)
    && processIdentityEqual(request.ownership.provider, initialOwnership.provider)
    && request.ownership.descendantBoundary?.pgid === initialOwnership.descendantBoundary.pgid
    && request.ownership.descendantBoundary?.sid === initialOwnership.descendantBoundary.sid
    && request.ownership.descendantBoundary?.pidNamespace === initialOwnership.descendantBoundary.pidNamespace;
}

async function awaitEvent(predicate, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = events.findLast(predicate);
    if (found !== undefined) return found;
    await delay(20);
  }
  throw new Error("provider-response-timeout");
}

async function stopProvider() {
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
  if (providerRunning()) throw new Error("provider-stop-timeout");
  const descendantExited = (await Promise.all(initialDescendants.map(async (expected) => {
    try { return !processIdentityEqual(await identity(expected.pid), expected); } catch { return true; }
  }))).every(Boolean);
  if (!descendantExited) throw new Error("descendant-still-running");
  return { state: "stopped", signalSent: true, escalated, descendantExited };
}

async function handle(request) {
  let parsed;
  try { parsed = parseControlRequest(request); } catch { return { ok: false, code: "malformed-request" }; }
  request = parsed;
  if (!credentialEqual(bootstrap.credential, request.credential)
    || !bindingsEqual(bootstrap.binding, request.binding)) return { ok: false, code: "authentication-failed" };
  if (request.action !== "establish" && !claimsMatch(request)) return { ok: false, code: "ownership-claim-mismatch" };
  if (request.action === "establish" || request.action === "proof") return { ok: true, result: await currentProof() };
  if (request.action === "send") {
    await currentProof();
    provider.stdin.write(`${JSON.stringify(request.message)}\n`);
    return { ok: true, result: await awaitEvent((event) => event.operationId === request.message.operationId) };
  }
  if (request.action === "interrupt") {
    await currentProof();
    provider.stdin.write(`${JSON.stringify({ type: "interrupt" })}\n`);
    return { ok: true, result: await awaitEvent((event) => event.type === "interrupted") };
  }
  if (request.action === "malformed-provider") {
    provider.stdin.write('{"type":"malformed"}\n');
    return { ok: true, result: await awaitEvent((event) => event.type === "protocol-error") };
  }
  if (request.action === "exit-provider") {
    provider.stdin.write('{"type":"exit"}\n');
    await new Promise((resolve) => provider.once("exit", resolve));
    return { ok: true, result: { state: "exited" } };
  }
  if (request.action === "leak-inspect") {
    const proof = await currentProof();
    const pids = [1, proof.supervisor.pid, ...(proof.providerState === "running" ? [
      proof.provider.pid, ...proof.descendants.map((item) => item.pid)
    ] : [])];
    let credentialPresent = false;
    for (const pid of pids) {
      for (const name of ["cmdline", "environ"]) {
        try {
          const bytes = await readFile(`/proc/${pid}/${name}`);
          if (bytes.includes(Buffer.from(bootstrap.credential))) credentialPresent = true;
        } catch { /* Process exited during the leak inspection. */ }
      }
    }
    return { ok: true, result: { credentialPresent, inspectedProcessCount: pids.length } };
  }
  if (request.action === "stop") return { ok: true, result: await stopProvider() };
  return { ok: false, code: "unsupported-action" };
}

const server = createServer({ allowHalfOpen: true }, (socket) => {
  socket.setEncoding("utf8"); let input = "";
  socket.on("data", (chunk) => {
    input += chunk;
    if (Buffer.byteLength(input) > 65_536 || (input.match(/\n/gu)?.length ?? 0) > 1) socket.destroy();
  });
  socket.on("end", async () => {
    try {
      if (!input.endsWith("\n")) throw new Error("malformed-frame");
      socket.end(`${JSON.stringify(await handle(JSON.parse(input.slice(0, -1))))}\n`);
    } catch { socket.end('{"ok":false,"code":"malformed-frame"}\n'); }
  });
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(bootstrap.socketPath, resolve); });
await chmod(bootstrap.socketPath, 0o600);

async function cleanup() {
  if (providerRunning()) {
    try { await currentProof(); process.kill(-initialProvider.pgid, "SIGKILL"); } catch {
      /* Container removal remains the outer cleanup fence. */
    }
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(socketDirectory, { recursive: true, force: true });
}
process.once("SIGTERM", () => { void cleanup().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void cleanup().finally(() => process.exit(0)); });
process.stdout.write(`${JSON.stringify({ type: "supervisor-ready" })}\n`);
