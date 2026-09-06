import { spawn, spawnSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { sourceInspectionDataSchema } from "@devspace/contracts";
import { createAgentServer, unlinkOwnedSocket, type AgentServerOptions } from "./server.js";
import { GitInspectionUnavailableError } from "./git-inspector.js";

const id = "018f0f00-0000-7000-8000-000000000001";
const now = new Date("2026-07-17T12:00:00.000Z");
const directories: string[] = [];
const runningServers: Array<ReturnType<typeof createAgentServer>> = [];
const foreignListeners: net.Server[] = [];
afterEach(async () => {
  await Promise.all(runningServers.splice(0).map(async (server) => { await server.stop().catch(() => undefined); }));
  await Promise.all(foreignListeners.splice(0).map(async (server) => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const protocolHeaders = {
  "X-DevSpace-Protocol-Version": "1",
  "X-DevSpace-Request-Id": id,
  "X-DevSpace-Sent-At": now.toISOString(),
  "content-type": "application/json; charset=utf-8"
};

async function tempSocket(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-socket-"));
  directories.push(directory);
  return path.join(directory, "agent.sock");
}

async function request(socketPath: string, input: { method: string; path: string; headers?: Record<string, string>; body?: string }) {
  return await new Promise<{ status: number; raw: string; body: { error?: { code?: string } } }>((resolve, reject) => {
    const call = http.request({ socketPath, method: input.method, path: input.path, headers: input.headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, raw, body: JSON.parse(raw) as { error?: { code?: string } } });
      });
    });
    call.on("error", reject);
    if (input.body !== undefined) call.write(input.body);
    call.end();
  });
}

function agent(socketPath: string, inspect = vi.fn(() => Promise.resolve(sourceInspectionDataSchema.parse({
  sourceKind: "remote", isGitRepository: true, defaultBranch: "main", headCommit: null
}))), extra: Omit<Partial<AgentServerOptions>, "socketPath" | "now" | "createId" | "gitInspector"> = {}) {
  const server = createAgentServer({ socketPath, now: () => now, createId: () => id, gitInspector: { inspect }, ...extra });
  runningServers.push(server);
  return { server, inspect };
}

test("clean startup creates a socket and normal shutdown removes only its own socket", async () => {
  const socketPath = await tempSocket();
  const { server } = agent(socketPath);
  await server.start();
  expect((await lstat(socketPath)).isSocket()).toBe(true);
  await server.stop();
  await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("optionally starts and stops the private preview lease resolver with the Agent", async () => {
  const socketPath = await tempSocket();
  const resolverPath = path.join(path.dirname(socketPath), "lease-resolver.sock");
  const { server } = agent(socketPath, undefined, { previewLeaseResolverSocketPath: resolverPath });
  await server.start();
  expect((await lstat(resolverPath)).isSocket()).toBe(true);
  await server.stop();
  await expect(lstat(resolverPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a proven stale socket is removed before startup", async () => {
  const socketPath = await tempSocket();
  const helper = spawn(process.execPath, [path.resolve("apps/agent/test/fixtures/socket-listener.mjs"), socketPath], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    helper.stdout.once("data", () => resolve());
    helper.once("error", reject);
  });
  helper.kill("SIGKILL");
  await new Promise<void>((resolve) => helper.once("close", () => resolve()));
  expect((await lstat(socketPath)).isSocket()).toBe(true);
  const { server } = agent(socketPath);
  await server.start();
  expect((await lstat(socketPath)).isSocket()).toBe(true);
});

test("an active Agent prevents a second startup without removing the first socket", async () => {
  const socketPath = await tempSocket();
  const first = agent(socketPath).server;
  const second = agent(socketPath).server;
  await first.start();
  await expect(second.start()).rejects.toThrow(/active listener/u);
  expect((await request(socketPath, { method: "GET", path: "/v1/health", headers: protocolHeaders })).status).toBe(200);
});

test("a non-socket path is refused and never deleted", async () => {
  const socketPath = await tempSocket();
  await writeFile(socketPath, "sentinel", "utf8");
  const { server } = agent(socketPath);
  await expect(server.start()).rejects.toThrow(/non-socket/u);
  expect(await readFile(socketPath, "utf8")).toBe("sentinel");
});

test("preserves an unrelated regular file at the exact private bind path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-private-file-")); directories.push(directory);
  const publicPath = path.join(directory, "public.sock");
  const privatePath = path.join(directory, "private.sock");
  const content = Buffer.from("private-bind-sentinel\nbyte-for-byte\n", "utf8");
  await writeFile(privatePath, content);
  const { server } = agent(publicPath, undefined, { privateSocketPath: privatePath });
  await expect(server.start()).rejects.toThrow();
  const stats = await lstat(privatePath);
  expect(stats.isFile()).toBe(true);
  expect(await readFile(privatePath)).toEqual(content);
});

test.each([
  ["directory", async (socketPath: string) => { await mkdir(socketPath); }],
  ["symlink", async (socketPath: string) => { await symlink("missing-target", socketPath); }],
  ["fifo", (socketPath: string) => {
    const result = spawnSync("/usr/bin/mkfifo", [socketPath]);
    if (result.status !== 0) throw new Error(`mkfifo failed: ${result.stderr.toString()}`);
    return Promise.resolve();
  }]
])("refuses a pre-existing private %s without deleting it", async (_kind, arrange) => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-private-")); directories.push(directory);
  const publicPath = path.join(directory, "public.sock");
  const privatePath = path.join(directory, "private.sock");
  await arrange(privatePath);
  const { server } = agent(publicPath, undefined, { privateSocketPath: privatePath });
  await expect(server.start()).rejects.toThrow();
  expect((await lstat(privatePath)).isSocket()).toBe(false);
});

test("refuses a pre-existing private Unix socket without unlinking it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-private-")); directories.push(directory);
  const publicPath = path.join(directory, "public.sock");
  const privatePath = path.join(directory, "private.sock");
  const foreign = net.createServer(); foreignListeners.push(foreign);
  await new Promise<void>((resolve, reject) => { foreign.once("error", reject); foreign.listen(privatePath, resolve); });
  const before = await lstat(privatePath);
  const { server } = agent(publicPath, undefined, { privateSocketPath: privatePath });
  await expect(server.start()).rejects.toThrow();
  const after = await lstat(privatePath);
  expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
});

test("records ownership after a successful private bind and cleans it on publication failure", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-private-")); directories.push(directory);
  const publicPath = path.join(directory, "public.sock");
  const privatePath = path.join(directory, "private.sock");
  let captured: { dev: bigint; ino: bigint } | undefined;
  const server = createAgentServer({
    socketPath: publicPath, privateSocketPath: privatePath, now: () => now, createId: () => id,
    publishSocket: async (privateName) => {
      const stats = await lstat(privateName);
      captured = { dev: BigInt(stats.dev), ino: BigInt(stats.ino) };
      throw new Error("forced publication failure");
    }, gitInspector: { inspect: () => Promise.reject(new Error("must not run")) }
  });
  runningServers.push(server);
  await expect(server.start()).rejects.toThrow("forced publication failure");
  expect(captured).toBeDefined();
  await expect(lstat(privatePath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(publicPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("private path replacement remains untouched by identity-checked cleanup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-agent-private-")); directories.push(directory);
  const privatePath = path.join(directory, "private.sock");
  const owner = net.createServer();
  await new Promise<void>((resolve, reject) => { owner.once("error", reject); owner.listen(privatePath, resolve); });
  const ownedStats = await lstat(privatePath);
  const ownership = { dev: BigInt(ownedStats.dev), ino: BigInt(ownedStats.ino) };
  await unlink(privatePath);
  await writeFile(privatePath, "replacement", "utf8");
  await unlinkOwnedSocket(privatePath, ownership);
  expect(await readFile(privatePath, "utf8")).toBe("replacement");
  await new Promise<void>((resolve) => owner.close(() => resolve()));
});

test("public classification refuses directory, symlink, FIFO, and preserves each entry", async () => {
  const cases: Array<[string, (socketPath: string) => Promise<void>]> = [
    ["directory", async (socketPath) => { await mkdir(socketPath); }],
    ["symlink", async (socketPath) => { await symlink("missing-target", socketPath); }],
    ["fifo", (socketPath) => {
      const result = spawnSync("/usr/bin/mkfifo", [socketPath]);
      if (result.status !== 0) throw new Error(`mkfifo failed: ${result.stderr.toString()}`);
      return Promise.resolve();
    }]
  ];
  for (const [kind, arrange] of cases) {
    const directory = await mkdtemp(path.join(tmpdir(), `devspace-agent-public-${kind}-`)); directories.push(directory);
    const publicPath = path.join(directory, "agent.sock");
    await arrange(publicPath);
    const server = agent(publicPath).server;
    await expect(server.start()).rejects.toThrow(/non-socket/u);
    expect((await lstat(publicPath)).isSocket()).toBe(false);
  }
});

test("a live non-Agent listener is active or unprobeable and is never replaced", async () => {
  const activeDirectory = await mkdtemp(path.join(tmpdir(), "devspace-agent-public-live-")); directories.push(activeDirectory);
  const activePath = path.join(activeDirectory, "agent.sock");
  let activeConnection: net.Socket | undefined;
  const active = net.createServer((socket) => { activeConnection = socket; socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"); });
  await new Promise<void>((resolve, reject) => { active.once("error", reject); active.listen(activePath, resolve); });
  const activeAgent = agent(activePath).server;
  await expect(activeAgent.start()).rejects.toThrow(/active listener/u);
  expect((await lstat(activePath)).isSocket()).toBe(true);
  activeConnection?.destroy();
  await new Promise<void>((resolve) => active.close(() => resolve()));

  const hangingDirectory = await mkdtemp(path.join(tmpdir(), "devspace-agent-public-hanging-")); directories.push(hangingDirectory);
  const hangingPath = path.join(hangingDirectory, "agent.sock");
  let hangingConnection: net.Socket | undefined;
  const hanging = net.createServer((socket) => { hangingConnection = socket; socket.destroy(); });
  await new Promise<void>((resolve, reject) => { hanging.once("error", reject); hanging.listen(hangingPath, resolve); });
  const hangingAgent = agent(hangingPath).server;
  await expect(hangingAgent.start()).rejects.toThrow(/Unable to prove|unprobeable/u);
  expect((await lstat(hangingPath)).isSocket()).toBe(true);
  hangingConnection?.destroy();
  await new Promise<void>((resolve) => hanging.close(() => resolve()));
});

test("publication and identity-verification failures preserve unrelated public entries", async () => {
  const failureDirectory = await mkdtemp(path.join(tmpdir(), "devspace-agent-public-failure-")); directories.push(failureDirectory);
  const publicPath = path.join(failureDirectory, "agent.sock");
  const privatePath = path.join(failureDirectory, "private.sock");
  const foreignContent = "foreign-public";
  const failedPublication = createAgentServer({
    socketPath: publicPath, privateSocketPath: privatePath, now: () => now, createId: () => id,
    publishSocket: async (_privateName, publicName) => { await writeFile(publicName, foreignContent, "utf8"); throw new Error("forced link failure"); }
  });
  runningServers.push(failedPublication);
  await expect(failedPublication.start()).rejects.toThrow("forced link failure");
  expect(await readFile(publicPath, "utf8")).toBe(foreignContent);
  await expect(lstat(privatePath)).rejects.toMatchObject({ code: "ENOENT" });

  const identityDirectory = await mkdtemp(path.join(tmpdir(), "devspace-agent-public-identity-")); directories.push(identityDirectory);
  const identityPublic = path.join(identityDirectory, "agent.sock");
  const identityPrivate = path.join(identityDirectory, "private.sock");
  const identityFailure = createAgentServer({
    socketPath: identityPublic, privateSocketPath: identityPrivate, now: () => now, createId: () => id,
    publishSocket: async (privateName, publicName) => {
      await link(privateName, publicName);
      await unlink(publicName);
      await writeFile(publicName, foreignContent, "utf8");
    }
  });
  runningServers.push(identityFailure);
  await expect(identityFailure.start()).rejects.toThrow(/changed|socket/u);
  expect(await readFile(identityPublic, "utf8")).toBe(foreignContent);
  await expect(lstat(identityPrivate)).rejects.toMatchObject({ code: "ENOENT" });
});

test("shutdown leaves a replacement socket untouched", async () => {
  const socketPath = await tempSocket();
  const { server } = agent(socketPath);
  await server.start();
  await unlink(socketPath);
  const replacement = net.createServer();
  await new Promise<void>((resolve, reject) => { replacement.once("error", reject); replacement.listen(socketPath, resolve); });
  const identity = await lstat(socketPath);
  await server.stop();
  const after = await lstat(socketPath);
  expect([after.dev, after.ino]).toEqual([identity.dev, identity.ino]);
  await new Promise<void>((resolve, reject) => replacement.close((error) => error === undefined ? resolve() : reject(error)));
});

test("URL policy, unknown headers, and unexpected inspector errors fail safely", async () => {
  const socketPath = await tempSocket();
  const { server, inspect } = agent(socketPath);
  await server.start();
  const secret = "review-secret";
  for (const url of [`https://example.com/repo.git?access_token=${secret}`, "ssh://git@example.com/repo.git"]) {
    const body = JSON.stringify({ data: { source: { kind: "remote", url } } });
    const response = await request(socketPath, { method: "POST", path: "/v1/projects/inspect-source", headers: { ...protocolHeaders, "content-length": String(Buffer.byteLength(body)) }, body });
    expect(response.status).toBe(422);
    expect(response.body.error?.code).toBe("RUNTIME_POLICY_VIOLATION");
    expect(response.raw).not.toContain(secret);
  }
  expect(inspect).not.toHaveBeenCalled();
  const unknown = await request(socketPath, { method: "GET", path: "/v1/health", headers: { ...protocolHeaders, "X-DevSpace-Unknown": "value" } });
  expect(unknown.status).toBe(400);
  expect(unknown.body.error?.code).toBe("REQUEST_INVALID");

  await server.stop();
  const failing = createAgentServer({ socketPath, now: () => now, createId: () => id, gitInspector: { inspect: () => Promise.reject(new Error(`internal ${secret}`)) } });
  runningServers.push(failing);
  await failing.start();
  const body = JSON.stringify({ data: { source: { kind: "remote", url: "https://example.com/repo.git" } } });
  const failure = await request(socketPath, { method: "POST", path: "/v1/projects/inspect-source", headers: { ...protocolHeaders, "content-length": String(Buffer.byteLength(body)) }, body });
  expect(failure.status).toBe(500);
  expect(failure.body.error?.code).toBe("AGENT_INTERNAL_ERROR");
  expect(failure.raw).not.toContain(secret);
});

test.each([
  ["remote-source", 503, "SOURCE_UNAVAILABLE"],
  ["timeout", 503, "SOURCE_UNAVAILABLE"],
  ["spawn", 500, "AGENT_INTERNAL_ERROR"],
  ["process-management", 500, "AGENT_INTERNAL_ERROR"],
  ["output-limit", 500, "AGENT_INTERNAL_ERROR"]
] as const)("projects source inspection classifies bounded Git failure %s safely", async (reason, status, code) => {
  const socketPath = await tempSocket();
  const { server } = agent(socketPath, vi.fn(() => Promise.reject(new GitInspectionUnavailableError(reason))));
  await server.start();
  const body = JSON.stringify({ data: { source: { kind: "remote", url: "https://example.com/repo.git" } } });
  const response = await request(socketPath, {
    method: "POST", path: "/v1/projects/inspect-source",
    headers: { ...protocolHeaders, "content-length": String(Buffer.byteLength(body)) }, body
  });
  expect(response.status).toBe(status);
  expect(response.body.error?.code).toBe(code);
});
