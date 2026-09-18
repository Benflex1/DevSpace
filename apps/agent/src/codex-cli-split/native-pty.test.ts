import net from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  startNativeCodexPty
} from "./native-pty.js";
import type { CodexControlSidecarBinding } from "./control-sidecar.js";
import { DockerEngineClient, type DockerExecInspection, type DockerProcessTable } from "../docker-runtime.js";
import { lstatIdentity } from "../private-state.js";
import type { CodexNativeAppServerHandle } from "./native-app-server.js";

const sessionId = "018f0f00-0000-7000-8000-000000000010";
const endpoint = {
  endpointUrl: "ws://codex-executor:4545", endpointHost: "codex-executor" as const, endpointPort: 4545,
  security: "private-network-only" as const, authenticationEvidence: "absent" as const, credential: null,
  workspaceId: "018f0f00-0000-7000-8000-000000000002", generation: 1, executionNetworkId: "execution-id"
};
const environment = {
  CODEX_HOME: "/codex-home", HOME: "/codex-home", CODEX_EXEC_SERVER_URL: endpoint.endpointUrl
};
const remote = {
  environment, launchArguments: [] as const,
  managedPolicy: {
    mechanism: "0.153.4-managed-requirements" as const,
    requirementsPath: "/etc/codex/requirements.toml", mountTarget: "/etc/codex/requirements.toml" as const,
    managedConfigPath: "/etc/codex/managed_config.toml", managedConfigMountTarget: "/etc/codex/managed_config.toml" as const,
    environment, forbiddenPaths: [] as const, projectLayerOverrideProof: "cannot-override" as const
  },
  endpoint, environmentId: "remote", logicalCwd: "/workspace" as const, workspaceRoots: ["/workspace"] as ["/workspace"],
  localEnvironmentAvailable: false as const, unifiedExecRequired: true as const,
  codeMode: {
    enabled: true as const, hostEnabled: true as const, disableInProcessFallback: true as const,
    remoteHostUrl: "http://codex-code-mode-host:4546"
  }
};
let control!: CodexControlSidecarBinding;
let appServer!: CodexNativeAppServerHandle;
let socketServer!: net.Server;
let fixtureRoot!: string;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join("/tmp", "devspace-native-pty-"));
  const homePath = path.join(fixtureRoot, "codex-home");
  const socketPath = path.join(homePath, "app-server-control", "app-server-control.sock");
  await mkdir(path.dirname(socketPath), { recursive: true });
  socketServer = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    socketServer.once("error", reject);
    socketServer.listen(socketPath, () => resolve());
  });
  const home = await lstatIdentity(homePath);
  const socket = await lstatIdentity(socketPath);
  if (home === null || socket === null) throw new Error("pty-fixture-state");
  control = {
    containerId: "control-id", containerName: "codex-control", imageId: `sha256:${"a".repeat(64)}`,
    policy: {
      remote, environment, home: {
        accountBinding: "owner-default", homePath, mountTarget: "/codex-home", identity: home.identity,
        ownerUid: 0, ownerGid: 0
      },
      nativeAppServerSocketPath: "/codex-home/app-server-control/app-server-control.sock",
      workingDirectory: "/workspace" as const,
      physicalWorkspaceMounts: [] as const, physicalGitMounts: [] as const,
      artifact: { launcherPath: "/opt/devspace/codex-launcher/codex" },
      network: {}, mounts: [], networkAttachments: [], forwardingDisabled: true as const, proxyProcesses: [] as const
    }
  } as unknown as CodexControlSidecarBinding;
  appServer = {
    controlContainerId: "control-id", execId: "app-server-exec", serverPid: 321,
    socketPath: "/codex-home/app-server-control/app-server-control.sock", socketIdentity: socket.identity,
    homeIdentity: `${home.identity.device}:${home.identity.inode}`,
    codeModeHostUrl: "http://codex-code-mode-host:4546", transportSecurity: "private-network-only"
  };
});

afterAll(async () => {
  await new Promise<void>((resolve) => socketServer.close(() => resolve()));
  await rm(fixtureRoot, { recursive: true, force: true });
});

class NativePtyDockerFixture extends DockerEngineClient {
  override inspectExec(id: string): Promise<DockerExecInspection> {
    return Promise.resolve(inspection(id));
  }
  override topContainer(): Promise<DockerProcessTable> {
    return Promise.resolve({ titles: ["PID", "ARGS"], processes: [["321", "codex app-server --listen unix:// --code-mode-host http://codex-code-mode-host:4546"]] });
  }
}

function startPty(input: Omit<Parameters<typeof startNativeCodexPty>[0], "appServer">): ReturnType<typeof startNativeCodexPty> {
  return startNativeCodexPty({ ...input, appServer });
}

function inspection(id: string): DockerExecInspection {
  return { ID: id, Running: true, ExitCode: null, ContainerID: "control-id", Pid: 321 };
}

test("attaches a raw native TUI PTY with exact remote CWD and no input relay", async () => {
  const calls: Array<{ readonly kind: string; readonly value: unknown }> = [];
  const stream = new PassThrough();
  const docker = new class extends NativePtyDockerFixture {
    constructor() { super("/fixture.sock"); }
    override createExec(containerId: string, input: Parameters<DockerEngineClient["createExec"]>[1]): Promise<string> {
      calls.push({ kind: "create", value: { containerId, input } }); return Promise.resolve("exec-id");
    }
    override startExecAttached(execId: string, tty: boolean): Promise<PassThrough> {
      calls.push({ kind: "start", value: { execId, tty } }); return Promise.resolve(stream);
    }
    override resizeExec(execId: string, columns: number, rows: number): Promise<void> {
      calls.push({ kind: "resize", value: { execId, columns, rows } }); return Promise.resolve();
    }
    override inspectExec(execId: string): Promise<DockerExecInspection> {
      calls.push({ kind: "inspect", value: execId }); return Promise.resolve(inspection(execId));
    }
  }();
  const pty = await startPty({
    docker, control, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: null,
    environment, columns: 120, rows: 40
  });
  expect(pty).toMatchObject({ containerId: "control-id", execId: "exec-id", command: ["/opt/devspace/codex-launcher/codex"], logicalArgv: ["codex"], workingDirectory: "/workspace", stream });
  expect(calls).toEqual([
    { kind: "inspect", value: "app-server-exec" },
    { kind: "create", value: { containerId: "control-id", input: {
      command: ["/opt/devspace/codex-launcher/codex"], workingDirectory: "/workspace", environment,
      attachStdin: true, tty: true
    } } },
    { kind: "start", value: { execId: "exec-id", tty: true } },
    { kind: "resize", value: { execId: "exec-id", columns: 120, rows: 40 } }
  ]);
  await pty.resize(100, 30);
  expect(calls.at(-1)).toEqual({ kind: "resize", value: { execId: "exec-id", columns: 100, rows: 30 } });
  await expect(pty.inspect()).resolves.toMatchObject({ ID: "exec-id", ContainerID: "control-id" });
  expect(calls.at(-1)).toEqual({ kind: "inspect", value: "exec-id" });
});

test("uses only the native resume argv and rejects local or hidden execution inputs", async () => {
  const calls: unknown[] = [];
  const docker = new class extends NativePtyDockerFixture {
    constructor() { super("/fixture.sock"); }
    override createExec(_containerId: string, input: Parameters<DockerEngineClient["createExec"]>[1]): Promise<string> {
      calls.push(input); return Promise.resolve("exec-id");
    }
    override startExecAttached(): Promise<PassThrough> { return Promise.resolve(new PassThrough()); }
    override resizeExec(): Promise<void> { return Promise.resolve(); }
  }();
  const pty = await startPty({
    docker, control, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: sessionId,
    environment, columns: 80, rows: 24
  });
  expect((calls[0] as { readonly command: readonly string[] }).command).toEqual([
    "/opt/devspace/codex-launcher/codex", "resume", sessionId
  ]);
  await expect(pty.resize(0, 24)).rejects.toThrow("native-pty-size");
  await expect(startPty({
    docker, control, executablePath: "/bin/sh" as unknown as "/opt/devspace/codex-launcher/codex", resumeSessionId: null, environment, columns: 80, rows: 24
  })).rejects.toThrow("native-pty-executable");
  await expect(startPty({
    docker, control, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: "not-a-uuid", environment, columns: 80, rows: 24
  })).rejects.toThrow("native-pty-session");
  await expect(startPty({
    docker, control, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: null,
    environment: { ...environment, DEVSPACE_PROMPT: "hidden" }, columns: 80, rows: 24
  })).rejects.toThrow("native-pty-environment");
  await expect(startPty({
    docker, control, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: null,
    environment, columns: 80, rows: 24, prompt: "run this" } as unknown as Parameters<typeof startNativeCodexPty>[0]
  )).rejects.toThrow("native-pty-input");
  expect(JSON.stringify(calls)).not.toContain("dangerously-bypass-approvals-and-sandbox");
});

test("rejects the legacy notify CLI override instead of treating it as daemon-reuse evidence", async () => {
  const docker = new class extends NativePtyDockerFixture {
    constructor() { super("/fixture.sock"); }
    override createExec(): Promise<string> { return Promise.resolve("exec-id"); }
    override startExecAttached(): Promise<PassThrough> { return Promise.resolve(new PassThrough()); }
    override resizeExec(): Promise<void> { return Promise.resolve(); }
  }();
  const invalid = {
    ...control,
    policy: { ...control.policy, remote: { ...remote, launchArguments: ["-c", "notify=[]"] as const } }
  } as unknown as CodexControlSidecarBinding;
  await expect(startPty({
    docker, control: invalid, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: null,
    environment, columns: 80, rows: 24
  })).rejects.toThrow("native-pty-remote-policy");
});

test("rejects a missing remote-only policy before creating a PTY", async () => {
  const docker = new class extends NativePtyDockerFixture {
    constructor() { super("/fixture.sock"); }
    override createExec(): Promise<string> { throw new Error("must-not-create"); }
  }();
  const invalid = {
    ...control,
    policy: { ...control.policy, remote: { ...remote, localEnvironmentAvailable: true as unknown as false } }
  } as unknown as CodexControlSidecarBinding;
  await expect(startPty({
    docker, control: invalid, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: null,
    environment, columns: 80, rows: 24
  })).rejects.toThrow("native-pty-remote-policy");
});

test("classifies Docker exec creation failures at the create boundary", async () => {
  const docker = new class extends NativePtyDockerFixture {
    constructor() { super("/fixture.sock"); }
    override createExec(): Promise<string> { return Promise.reject(new Error("docker-create")); }
  }();
  await expect(startPty({
    docker, control, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: null,
    environment, columns: 80, rows: 24
  })).rejects.toThrow("native-pty-exec-create");
});

test("classifies Docker attach failures at the attach boundary", async () => {
  const docker = new class extends NativePtyDockerFixture {
    constructor() { super("/fixture.sock"); }
    override createExec(): Promise<string> { return Promise.resolve("exec-id"); }
    override startExecAttached(): Promise<PassThrough> { return Promise.reject(new Error("docker-attach")); }
  }();
  await expect(startPty({
    docker, control, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: null,
    environment, columns: 80, rows: 24
  })).rejects.toThrow("native-pty-attach");
});

test("classifies Docker resize failures at the resize boundary", async () => {
  const docker = new class extends NativePtyDockerFixture {
    constructor() { super("/fixture.sock"); }
    override createExec(): Promise<string> { return Promise.resolve("exec-id"); }
    override startExecAttached(): Promise<PassThrough> { return Promise.resolve(new PassThrough()); }
    override resizeExec(): Promise<void> { return Promise.reject(new Error("docker-resize")); }
  }();
  await expect(startPty({
    docker, control, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: null,
    environment, columns: 80, rows: 24
  })).rejects.toThrow("native-pty-resize");
});

test("classifies Docker exec inspection failures as exec-state failures", async () => {
  let inspectCount = 0;
  const docker = new class extends NativePtyDockerFixture {
    constructor() { super("/fixture.sock"); }
    override createExec(): Promise<string> { return Promise.resolve("exec-id"); }
    override startExecAttached(): Promise<PassThrough> { return Promise.resolve(new PassThrough()); }
    override resizeExec(): Promise<void> { return Promise.resolve(); }
    override inspectExec(id: string): Promise<DockerExecInspection> {
      inspectCount += 1;
      return inspectCount === 1 ? Promise.resolve(inspection(id)) : Promise.reject(new Error("docker-inspect"));
    }
  }();
  const pty = await startPty({
    docker, control, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: null,
    environment, columns: 80, rows: 24
  });
  await expect(pty.inspect()).rejects.toThrow("native-pty-exec-state");
});

test("classifies subsequent Docker resize failures at the resize boundary", async () => {
  let resizeCount = 0;
  const docker = new class extends NativePtyDockerFixture {
    constructor() { super("/fixture.sock"); }
    override createExec(): Promise<string> { return Promise.resolve("exec-id"); }
    override startExecAttached(): Promise<PassThrough> { return Promise.resolve(new PassThrough()); }
    override resizeExec(): Promise<void> {
      resizeCount += 1;
      return resizeCount === 1 ? Promise.resolve() : Promise.reject(new Error("docker-resize"));
    }
  }();
  const pty = await startPty({
    docker, control, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: null,
    environment, columns: 80, rows: 24
  });
  await expect(pty.resize(100, 30)).rejects.toThrow("native-pty-resize");
});

test("classifies an invalid attached stream at the stream boundary", async () => {
  const docker = new class extends NativePtyDockerFixture {
    constructor() { super("/fixture.sock"); }
    override createExec(): Promise<string> { return Promise.resolve("exec-id"); }
    override startExecAttached(): Promise<PassThrough> {
      return Promise.resolve(undefined as unknown as PassThrough);
    }
  }();
  await expect(startPty({
    docker, control, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: null,
    environment, columns: 80, rows: 24
  })).rejects.toThrow("native-pty-stream");
});

test("classifies an attached stream identity mismatch as an exec-state failure", async () => {
  let inspectCount = 0;
  const docker = new class extends NativePtyDockerFixture {
    constructor() { super("/fixture.sock"); }
    override createExec(): Promise<string> { return Promise.resolve("exec-id"); }
    override startExecAttached(): Promise<PassThrough> { return Promise.resolve(new PassThrough()); }
    override resizeExec(): Promise<void> { return Promise.resolve(); }
    override inspectExec(id: string): Promise<DockerExecInspection> {
      inspectCount += 1;
      return inspectCount === 1
        ? Promise.resolve(inspection(id))
        : Promise.resolve({ ID: "other-exec", Running: false, ExitCode: 0, ContainerID: "control-id" });
    }
  }();
  const pty = await startPty({
    docker, control, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: null,
    environment, columns: 80, rows: 24
  });
  await expect(pty.inspect()).rejects.toThrow("native-pty-exec-state");
});
