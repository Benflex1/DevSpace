import net from "node:net";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { DockerEngineClient, type DockerExecInspection } from "../docker-runtime.js";
import { ensureNativeCodexHome, type CodexNativeHomeBinding } from "./native-home.js";
import type { CodexControlSidecarPolicy } from "./control-sidecar.js";
import type { CodexSplitArtifactCapabilities } from "./artifact.js";
import type { CodexCodeModeHostEndpoint } from "./code-mode-host.js";
import {
  APP_SERVER_CONTROL_SOCKET_PATH,
  assertCodexNativeAppServerReady,
  buildCodexNativeAppServerPolicy,
  reattachCodexNativeAppServer,
  startCodexNativeAppServer,
  type CodexNativeAppServerPolicy
} from "./native-app-server.js";

const roots: string[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const artifact: CodexSplitArtifactCapabilities = {
  nativeCliPath: "/opt/devspace/codex/bin/codex",
  execServerCapability: "codex-0.153.4-exec-server",
  appServerCapability: "codex-0.153.4-app-server",
  codeModeHostPath: "/opt/devspace/codex/bin/codex-code-mode-host",
  codeModeHostCapability: "codex-0.153.4-code-mode-host",
  closureDigest: "a".repeat(64)
};
const codeModeHost: CodexCodeModeHostEndpoint = {
  host: "codex-code-mode-host",
  port: 4546,
  url: "http://codex-code-mode-host:4546",
  listenUrl: "grpc://0.0.0.0:4546",
  networkId: "execution-network-id"
};

async function homeFixture(): Promise<CodexNativeHomeBinding> {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-native-app-server-"));
  roots.push(root);
  const homePath = path.join(root, "codex-home");
  return await ensureNativeCodexHome({
    homePath,
    ownerUid: process.getuid?.() ?? 0,
    ownerGid: process.getgid?.() ?? 0
  });
}

function control(home: CodexNativeHomeBinding): CodexControlSidecarPolicy {
  return {
    containerId: "not-in-policy",
    imageReference: "node:24-bookworm",
    home,
    nativeAppServerSocketPath: APP_SERVER_CONTROL_SOCKET_PATH,
    artifact: {
      staged: { stagingRoot: "/srv/codex", artifact: { entrypoint: { relativePath: "bin/codex" } } }
    },
    remote: {
      environment: { CODEX_HOME: "/codex-home", HOME: "/codex-home", CODEX_EXEC_SERVER_URL: "ws://codex-executor:4545" },
      launchArguments: [],
      managedPolicy: { requirementsPath: "/srv/requirements.toml" },
      endpoint: { endpointUrl: "ws://codex-executor:4545" },
      environmentId: "remote",
      logicalCwd: "/workspace",
      workspaceRoots: ["/workspace"],
      localEnvironmentAvailable: false,
      unifiedExecRequired: true,
      codeMode: {
        enabled: true,
        hostEnabled: true,
        disableInProcessFallback: true,
        remoteHostUrl: codeModeHost.url
      }
    },
    forwardingDisabled: true,
    proxyProcesses: [],
    physicalWorkspaceMounts: [],
    physicalGitMounts: []
  } as unknown as CodexControlSidecarPolicy;
}

function inspection(id: string, containerId: string, overrides: Partial<DockerExecInspection> = {}): DockerExecInspection {
  return { ID: id, Running: true, ExitCode: null, ContainerID: containerId, Pid: 72, ...overrides };
}

async function socketServer(socketPath: string): Promise<net.Server> {
  await mkdir(path.dirname(socketPath), { recursive: true });
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  servers.push(server);
  return server;
}

function dockerFixture(policy: CodexNativeAppServerPolicy, inspections: readonly DockerExecInspection[] = []): DockerEngineClient {
  let inspectionIndex = 0;
  return new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override createExec(): Promise<string> { return Promise.resolve("app-server-exec"); }
    override startExecAttached(): Promise<PassThrough> {
      void socketServer(path.join(policy.controlHomePath, "app-server-control", "app-server-control.sock")).catch(() => undefined);
      return Promise.resolve(new PassThrough());
    }
    override inspectExec(id: string): Promise<DockerExecInspection> {
      const observed = inspections[ Math.min(inspectionIndex++, Math.max(inspections.length - 1, 0)) ]
        ?? inspection(id, policy.controlContainerId);
      return Promise.resolve({ ...observed, ID: id, ContainerID: policy.controlContainerId });
    }
  }();
}

test("builds the exact default-socket native app-server command", async () => {
  const home = await homeFixture();
  const result = buildCodexNativeAppServerPolicy({ control: control(home), artifact, codeModeHost });
  expect(result.socketPath).toBe(APP_SERVER_CONTROL_SOCKET_PATH);
  expect(result.command).toEqual([
    "/opt/devspace/codex-launcher/codex", "app-server", "--listen", "unix://", "--code-mode-host", codeModeHost.url
  ]);
  expect(result.projectMounts).toEqual([]);
  expect(result.gitMounts).toEqual([]);
  expect(result.workingDirectory).toBe("/workspace");
  expect(result.homeIdentity).toBe(`${home.identity.device}:${home.identity.inode}`);
});

test("starts and validates a native app-server on the private home socket", async () => {
  const home = await homeFixture();
  const policy = buildCodexNativeAppServerPolicy({ control: control(home), artifact, codeModeHost });
  const handle = await startCodexNativeAppServer({ docker: dockerFixture(policy), policy, deadlineMs: 100, pollIntervalMs: 1 });
  expect(handle).toMatchObject({
    controlContainerId: policy.controlContainerId,
    execId: "app-server-exec",
    socketPath: APP_SERVER_CONTROL_SOCKET_PATH,
    homeIdentity: policy.homeIdentity,
    codeModeHostUrl: codeModeHost.url,
    serverPid: 72,
    transportSecurity: "private-network-only"
  });
  await expect(assertCodexNativeAppServerReady({ docker: dockerFixture(policy), handle, policy })).resolves.toBeUndefined();
});

test("waits through a Docker exec transition before accepting the app-server", async () => {
  const home = await homeFixture();
  const policy = buildCodexNativeAppServerPolicy({ control: control(home), artifact, codeModeHost });
  const docker = dockerFixture(policy, [
    inspection("app-server-exec", policy.controlContainerId, { Running: false, ExitCode: null }),
    inspection("app-server-exec", policy.controlContainerId)
  ]);
  let now = 0;
  await expect(startCodexNativeAppServer({
    docker,
    policy,
    deadlineMs: 10,
    pollIntervalMs: 1,
    now: () => now,
    sleep: (milliseconds) => { now += milliseconds; return Promise.resolve(); }
  })).resolves.toMatchObject({ serverPid: 72 });
});

test("waits through a running exec with a transitional zero pid", async () => {
  const home = await homeFixture();
  const policy = buildCodexNativeAppServerPolicy({ control: control(home), artifact, codeModeHost });
  const docker = dockerFixture(policy, [
    inspection("app-server-exec", policy.controlContainerId, { Pid: 0 }),
    inspection("app-server-exec", policy.controlContainerId, { Pid: 72 })
  ]);
  let now = 0;
  await expect(startCodexNativeAppServer({
    docker,
    policy,
    deadlineMs: 10,
    pollIntervalMs: 1,
    now: () => now,
    sleep: (milliseconds) => { now += milliseconds; return Promise.resolve(); }
  })).resolves.toMatchObject({ serverPid: 72 });
});

test("rejects a missing or mismatched remote Code Mode host", async () => {
  const home = await homeFixture();
  expect(() => buildCodexNativeAppServerPolicy({
    control: control(home), artifact, codeModeHost: { ...codeModeHost, url: "http://wrong:1" }
  })).toThrow("codex-app-server-code-mode-host");
  const invalidControl = {
    ...control(home),
    remote: {
      ...control(home).remote,
      codeMode: {
        enabled: true,
        hostEnabled: false,
        disableInProcessFallback: true,
        remoteHostUrl: codeModeHost.url
      }
    }
  } as unknown as CodexControlSidecarPolicy;
  expect(() => buildCodexNativeAppServerPolicy({
    control: invalidControl,
    artifact,
    codeModeHost
  })).toThrow("codex-app-server-code-mode-host");
});

test("rejects foreign, symlink-swapped, and ambiguous live socket state", async () => {
  const home = await homeFixture();
  const policy = buildCodexNativeAppServerPolicy({ control: control(home), artifact, codeModeHost });
  const socketPath = path.join(home.homePath, "app-server-control", "app-server-control.sock");
  await mkdir(path.dirname(socketPath), { recursive: true });
  await symlink("/tmp/foreign", socketPath);
  await expect(startCodexNativeAppServer({ docker: dockerFixture(policy), policy })).rejects.toThrow("codex-app-server-socket-foreign");
  await rm(socketPath);
  await socketServer(socketPath);
  await expect(startCodexNativeAppServer({ docker: dockerFixture(policy), policy })).rejects.toThrow("codex-app-server-socket-foreign");
});

test("reattach requires the same home/socket/process identity", async () => {
  const home = await homeFixture();
  const policy = buildCodexNativeAppServerPolicy({ control: control(home), artifact, codeModeHost });
  const docker = dockerFixture(policy);
  const handle = await startCodexNativeAppServer({ docker, policy, deadlineMs: 100, pollIntervalMs: 1 });
  await expect(reattachCodexNativeAppServer({ docker, handle, policy })).resolves.toBeUndefined();
  await expect(reattachCodexNativeAppServer({
    docker,
    handle: { ...handle, homeIdentity: "foreign" },
    policy
  })).rejects.toThrow("codex-app-server-identity");
});

test("rejects a server that exits or never creates the default socket", async () => {
  const home = await homeFixture();
  const policy = buildCodexNativeAppServerPolicy({ control: control(home), artifact, codeModeHost });
  const docker = new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override createExec(): Promise<string> { return Promise.resolve("app-server-exec"); }
    override startExecAttached(): Promise<PassThrough> { return Promise.resolve(new PassThrough()); }
    override inspectExec(): Promise<DockerExecInspection> {
      return Promise.resolve(inspection("app-server-exec", policy.controlContainerId, { Running: false, ExitCode: 1, Pid: 72 }));
    }
  }();
  await expect(startCodexNativeAppServer({ docker, policy, deadlineMs: 2, pollIntervalMs: 1 })).rejects.toThrow("codex-app-server-exited-before-ready");
});

test("classifies a running app-server inspection without a positive pid", async () => {
  const home = await homeFixture();
  const policy = buildCodexNativeAppServerPolicy({ control: control(home), artifact, codeModeHost });
  const docker = new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override createExec(): Promise<string> { return Promise.resolve("app-server-exec"); }
    override startExecAttached(): Promise<PassThrough> { return Promise.resolve(new PassThrough()); }
    override inspectExec(): Promise<DockerExecInspection> {
      return Promise.resolve(inspection("app-server-exec", policy.controlContainerId, { Pid: -1 }));
    }
  }();
  const failure = await startCodexNativeAppServer({ docker, policy, deadlineMs: 2, pollIntervalMs: 1 })
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({ message: "codex-app-server-process" });
  expect((failure as Error & { readonly cause?: Error }).cause).toMatchObject({ message: "server-pid-invalid" });
});

test("reports an app-server that exits while its socket is becoming ready", async () => {
  const home = await homeFixture();
  const policy = buildCodexNativeAppServerPolicy({ control: control(home), artifact, codeModeHost });
  let inspections = 0;
  const docker = new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override createExec(): Promise<string> { return Promise.resolve("app-server-exec"); }
    override startExecAttached(): Promise<PassThrough> { return Promise.resolve(new PassThrough()); }
    override inspectExec(): Promise<DockerExecInspection> {
      inspections += 1;
      return Promise.resolve(inspections === 1
        ? inspection("app-server-exec", policy.controlContainerId)
        : inspection("app-server-exec", policy.controlContainerId, { Running: false, ExitCode: 1, Pid: 72 }));
    }
  }();
  const failure = await startCodexNativeAppServer({ docker, policy, deadlineMs: 2, pollIntervalMs: 1 }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ message: "codex-app-server-exited-before-ready" });
  expect((failure as Error & { readonly cause?: Error }).cause).toMatchObject({ message: "exit-1" });
});
