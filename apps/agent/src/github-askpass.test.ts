import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createGithubAskpassBroker } from "./github-askpass.js";
import { protectedGitInvocation } from "./managed-workspaces.js";

const roots: string[] = [];
const servers: https.Server[] = [];
const connectionId = "018f0d84-7b39-7cc3-9d4a-0675d9162a11";
const repositoryId = "9007199254740993";
const operationId = "018f0d84-7b39-7cc3-9d4a-0675d9162a12";
const executionId = "018f0d84-7b39-7cc3-9d4a-0675d9162a13";
const originUrl = "https://github.com/org/private-repo.git";

beforeAll(() => {
  execFileSync(process.execPath, [path.resolve("tooling/build-github-askpass-helper.mjs")], { stdio: "ignore" });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
afterAll(async () => { await rm(path.resolve("apps/agent/dist/native/devspace-git-askpass"), { force: true }); });

async function privateRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
}

async function runHelper(helperPath: string, capability: string, prompt: string, extraEnvironment: Record<string, string> = {}) {
  return await runHelpers(helperPath, capability, [prompt], extraEnvironment);
}

async function runHelpers(helperPath: string, capability: string, prompts: readonly string[], extraEnvironment: Record<string, string> = {}) {
  const command = prompts.map((_, index) => `"$DEVSPACE_HELPER" "$DEVSPACE_ASKPASS_PROMPT_${index}"`).join("; status=$?; if [ $status -ne 0 ]; then exit $status; fi; ");
  return await new Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      detached: true,
      env: { ...process.env, DEVSPACE_HELPER: helperPath, DEVSPACE_GIT_ASKPASS_CAPABILITY: capability,
        ...Object.fromEntries(prompts.map((prompt, index) => [`DEVSPACE_ASKPASS_PROMPT_${index}`, prompt])), ...extraEnvironment },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

async function registration(broker: ReturnType<typeof createGithubAskpassBroker>, token = "private-canary") {
  await broker.start();
  return broker.register({ connectionId, repositoryId, operationId, executionId, originUrl, token, deadlineAt: new Date(Date.now() + 30_000) });
}

async function sendRawFrame(socketPath: string, payload: Buffer): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = createConnection(socketPath);
    const finish = () => { socket.destroy(); resolve(); };
    socket.once("error", finish);
    socket.once("close", finish);
    socket.write(payload);
  });
}

describe("GitHub askpass broker", () => {
  test("prefers a safe XDG runtime directory and removes its socket deterministically", async () => {
    const xdg = await privateRoot("devspace-xdg-");
    const fallback = await privateRoot("devspace-run-");
    const broker = createGithubAskpassBroker({ runtimeBases: [xdg, fallback], helperPath: "/trusted/helper" });
    await broker.start();
    expect(broker.runtimeDirectory?.startsWith(`${xdg}${path.sep}`)).toBe(true);
    expect(broker.socketPath?.startsWith(`${xdg}${path.sep}`)).toBe(true);
    await broker.stop();
    expect(broker.socketPath).toBeNull();
    expect(broker.runtimeDirectory).toBeNull();
  });

  test("uses a short approved fallback for long runtime/state paths", async () => {
    const longBase = await privateRoot(`devspace-${"x".repeat(90)}-`);
    const fallback = await privateRoot("devspace-short-");
    const broker = createGithubAskpassBroker({ runtimeBases: [longBase, fallback], helperPath: "/trusted/helper" });
    await broker.start();
    expect(broker.runtimeDirectory?.startsWith(`${fallback}${path.sep}devspace-askpass-`)).toBe(true);
    expect(Buffer.byteLength(broker.socketPath ?? "")).toBeLessThanOrEqual(100);
    await broker.stop();
  });

  test.each(["EROFS", "EACCES"])("falls through a candidate-local %s runtime error", async (code) => {
    const first = await privateRoot("devspace-runtime-first-");
    const second = await privateRoot("devspace-runtime-second-");
    const realMkdir = mkdir;
    const broker = createGithubAskpassBroker({
      runtimeBases: [first, second],
      mkdir: async (directory, options) => {
        if (directory.startsWith(first)) throw Object.assign(new Error(code), { code });
        return await realMkdir(directory, options);
      },
      helperPath: "/trusted/helper"
    });
    await broker.start();
    expect(broker.runtimeDirectory?.startsWith(`${second}${path.sep}devspace-askpass-`)).toBe(true);
    await broker.stop();
  });

  test("reports deterministic unavailability after all candidate-local availability errors", async () => {
    const first = await privateRoot("devspace-runtime-first-");
    const second = await privateRoot("devspace-runtime-second-");
    const broker = createGithubAskpassBroker({
      runtimeBases: [first, second],
      mkdir: () => Promise.reject(Object.assign(new Error("read-only"), { code: "EROFS" })),
      helperPath: "/trusted/helper"
    });
    await expect(broker.start()).rejects.toThrow("askpass-runtime-unavailable");
    expect(broker.socketPath).toBeNull();
  });

  test("fails closed on an unsafe runtime-base symlink instead of skipping it", async () => {
    const target = await privateRoot("devspace-runtime-target-");
    const symlinkBase = `${target}-link`;
    const fallback = await privateRoot("devspace-runtime-fallback-");
    await symlink(target, symlinkBase);
    roots.push(symlinkBase);
    const broker = createGithubAskpassBroker({ runtimeBases: [symlinkBase, fallback], helperPath: "/trusted/helper" });
    await expect(broker.start()).rejects.toThrow("askpass-runtime-base-unsafe");
  });

  test("serializes concurrent startup and permits a later retry after startup failure", async () => {
    const base = await privateRoot("devspace-runtime-retry-");
    let unavailable = true;
    const realMkdir = mkdir;
    const broker = createGithubAskpassBroker({
      runtimeBases: [base],
      mkdir: async (directory, options) => {
        if (unavailable) throw Object.assign(new Error("read-only"), { code: "EROFS" });
        return await realMkdir(directory, options);
      },
      helperPath: "/trusted/helper"
    });
    const failures = await Promise.allSettled([broker.ensureStarted(), broker.ensureStarted(), broker.ensureStarted()]);
    expect(failures.every((result) => result.status === "rejected")).toBe(true);
    unavailable = false;
    await Promise.all([broker.ensureStarted(), broker.ensureStarted()]);
    expect(broker.socketPath).not.toBeNull();
    await broker.stop();
  });

  test("removes only an owner-private stale socket after identity recheck", async () => {
    const base = await privateRoot("devspace-stale-");
    const suffix = "ab".repeat(16);
    const staleDirectory = path.join(base, `devspace-askpass-${suffix}`);
    await mkdir(staleDirectory, { mode: 0o700 });
    const staleSocket = path.join(staleDirectory, "broker.sock");
    const listener = await new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
      const value = createServer();
      value.once("error", reject);
      value.listen(staleSocket, () => resolve(value));
    });
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const broker = createGithubAskpassBroker({ runtimeBases: [base], randomBytes: () => Buffer.from(suffix, "hex"), helperPath: "/trusted/helper" });
    await broker.start();
    expect(broker.socketPath).toBe(staleSocket);
    await broker.stop();
  });

  test("does not unlink an active unexpected socket during startup failure cleanup", async () => {
    const base = await privateRoot("devspace-active-socket-");
    const suffix = "cd".repeat(16);
    const runtime = path.join(base, `devspace-askpass-${suffix}`);
    await mkdir(runtime, { mode: 0o700 });
    const socketPath = path.join(runtime, "broker.sock");
    const listener = await new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
      const value = createServer();
      value.once("error", reject);
      value.listen(socketPath, () => resolve(value));
    });
    const broker = createGithubAskpassBroker({ runtimeBases: [base], randomBytes: () => Buffer.from(suffix, "hex"), helperPath: "/trusted/helper" });
    try {
      await expect(broker.start()).rejects.toThrow("askpass-socket-active");
      await expect(stat(socketPath)).resolves.toBeDefined();
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  test("serves one username and one password only through the native helper", async () => {
    const base = await privateRoot("devspace-broker-");
    const broker = createGithubAskpassBroker({ runtimeBases: [base] });
    const capability = await registration(broker, "private-canary");
    const common = { ...capability.environment, DEVSPACE_EXECUTION_ID: executionId };
    const prompts = [`Username for '${originUrl}': `, `Password for '${originUrl}': `, `Password for '${originUrl}': `];
    const result = await runHelpers(capability.helperPath, capability.capability, prompts, common);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("x-access-tokenprivate-canary");
    expect(result.stderr).toBe("");
    broker.settle(capability.capability);
    await broker.stop();
  });

  test.each([
    ["password before username", [`Password for '${originUrl}': `]],
    ["duplicate username", [`Username for '${originUrl}': `, `Username for '${originUrl}': `]],
    ["duplicate password", [`Username for '${originUrl}': `, `Password for '${originUrl}': `, `Password for '${originUrl}': `]]
  ])("rejects %s according to the exact prompt state machine", async (_label, prompts) => {
    const base = await privateRoot("devspace-prompt-state-");
    const broker = createGithubAskpassBroker({ runtimeBases: [base] });
    const capability = await registration(broker);
    const result = await runHelpers(capability.helperPath, capability.capability, prompts, {
      ...capability.environment, DEVSPACE_EXECUTION_ID: executionId
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(_label === "duplicate username" ? "x-access-token" : _label === "duplicate password" ? "x-access-tokenprivate-canary" : "");
    expect(result.stderr).toBe("");
    await broker.stop();
  });

  test.each([
    ["wrong capability", "0".repeat(64), `Username for '${originUrl}': `, {}],
    ["wrong execution", "registered", `Username for '${originUrl}': `, { DEVSPACE_GIT_ASKPASS_EXECUTION_ID: "018f0d84-7b39-7cc3-9d4a-0675d9162a14" }],
    ["unknown prompt", "registered", "Password for 'https://github.com/org/other.git': ", {}]
  ])("rejects %s without emitting credentials", async (_label, capabilityValue, prompt, overrides) => {
    const base = await privateRoot("devspace-reject-");
    const broker = createGithubAskpassBroker({ runtimeBases: [base] });
    const capability = await registration(broker);
    const result = await runHelper(capability.helperPath, capabilityValue === "registered" ? capability.capability : capabilityValue, prompt, {
      ...capability.environment,
      DEVSPACE_GIT_ASKPASS_CAPABILITY: capabilityValue === "registered" ? capability.capability : capabilityValue,
      DEVSPACE_EXECUTION_ID: executionId,
      ...overrides
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    await broker.stop();
  });

  test("rejects malformed and oversized protocol frames without a credential response", async () => {
    const base = await privateRoot("devspace-frame-");
    const broker = createGithubAskpassBroker({ runtimeBases: [base] });
    await broker.start();
    const socketPath = broker.socketPath!;
    const oversized = Buffer.alloc(4); oversized.writeUInt32BE(128 * 1024 + 1, 0);
    await sendRawFrame(socketPath, oversized);
    const malformed = Buffer.alloc(8); malformed.writeUInt32BE(4, 0); malformed.write("nope", 4, "ascii");
    await sendRawFrame(socketPath, malformed);
    await broker.stop();
  });

  test("rejects a capability after its deadline", async () => {
    const base = await privateRoot("devspace-expiry-");
    let clock = 1_000;
    const broker = createGithubAskpassBroker({ runtimeBases: [base], now: () => clock });
    await broker.start();
    const capability = broker.register({ connectionId, repositoryId, operationId, executionId, originUrl,
      token: "private-canary", deadlineAt: new Date(clock + 100) });
    clock += 101;
    const result = await runHelper(capability.helperPath, capability.capability, `Username for '${originUrl}': `, {
      ...capability.environment, DEVSPACE_EXECUTION_ID: executionId
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    await broker.stop();
  });

  test("delivers a credential to the real Git executable over authenticated HTTPS without exposing it", async () => {
    const root = await privateRoot("devspace-git-auth-");
    const certificate = path.join(root, "cert.pem"); const privateKey = path.join(root, "key.pem");
    execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", privateKey,
      "-out", certificate, "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-days", "1"]);
    const source = path.join(root, "source"); const repository = path.join(root, "repository.git");
    execFileSync("/usr/bin/git", ["init", "-b", "main", source]);
    execFileSync("/usr/bin/git", ["-C", source, "config", "user.name", "DevSpace Test"]);
    execFileSync("/usr/bin/git", ["-C", source, "config", "user.email", "devspace@example.invalid"]);
    await writeFile(path.join(source, "README.md"), "authenticated fixture\n", "utf8");
    execFileSync("/usr/bin/git", ["-C", source, "add", "README.md"]);
    execFileSync("/usr/bin/git", ["-C", source, "commit", "-m", "fixture"]);
    execFileSync("/usr/bin/git", ["clone", "--bare", source, repository]);
    execFileSync("/usr/bin/git", ["--git-dir", repository, "update-server-info"]);
    const canary = "private-installation-canary";
    let credentialAccepted = false;
    const server = https.createServer({ key: await readFile(privateKey), cert: await readFile(certificate) }, (request, response) => {
      const expected = `Basic ${Buffer.from(`x-access-token:${canary}`).toString("base64")}`;
      if (request.headers.authorization !== expected) { response.writeHead(401, { "www-authenticate": "Basic realm=devspace" }).end(); return; }
      credentialAccepted = true;
      void (async () => {
        try {
          const pathname = decodeURIComponent(new URL(request.url ?? "/", "https://origin.invalid").pathname);
          const target = path.resolve(root, `.${pathname}`);
          if (!target.startsWith(`${root}${path.sep}`)) { response.writeHead(404).end(); return; }
          const details = await stat(target);
          response.writeHead(200, { "content-length": details.size, "content-type": "text/plain" });
          createReadStream(target).pipe(response);
        } catch { response.writeHead(404).end(); }
      })().catch(() => { response.writeHead(500).end(); });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("fixture address missing");
    const repositoryUrl = `https://127.0.0.1:${address.port}/repository.git`;
    const brokerRoot = await privateRoot("devspace-git-broker-");
    const broker = createGithubAskpassBroker({ runtimeBases: [brokerRoot] });
    await broker.start();
    const capability = broker.register({ connectionId, repositoryId, operationId, executionId, originUrl: repositoryUrl, token: canary,
      deadlineAt: new Date(Date.now() + 30_000) });
    const invocation = protectedGitInvocation(["-c", `http.sslCAInfo=${certificate}`, "ls-remote", "--", repositoryUrl, "HEAD"], { capability });
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("/usr/bin/git", invocation.args, {
        detached: true,
        env: { ...process.env, GIT_ASKPASS: "/tmp/hostile-askpass", SSH_ASKPASS: "/tmp/hostile-ssh-askpass",
          GIT_SSH: "/tmp/hostile-git-ssh", GIT_SSH_COMMAND: "sh -c hostile", GIT_PROXY_COMMAND: "/tmp/hostile-proxy",
          GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "/tmp/hostile-helper",
          GIT_CONFIG_GLOBAL: "/tmp/hostile-global", GIT_CONFIG_SYSTEM: "/tmp/hostile-system", GIT_TRACE_CURL: "1",
          ...invocation.env }, stdio: ["ignore", "pipe", "pipe"]
      });
      const stdout: Buffer[] = []; const stderr: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk)); child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject); child.once("close", (status) => resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    });
    expect(result.status).toBe(0);
    expect(credentialAccepted).toBe(true);
    expect(result.stdout).not.toContain(canary); expect(result.stderr).not.toContain(canary);
    expect(repositoryUrl).not.toContain(canary);
    expect(JSON.stringify(invocation.args)).not.toContain(canary);
    expect(JSON.stringify(invocation.env)).not.toContain(canary);
    expect(JSON.stringify(capability)).not.toContain(canary);
    expect(execFileSync("/usr/bin/git", ["--git-dir", repository, "config", "--list"], { encoding: "utf8" })).not.toContain(canary);
    broker.settle(capability.capability); await broker.stop();
  });
});
