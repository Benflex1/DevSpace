import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { DockerEngineClient, DockerEngineError, type DockerContainerInspection, type DockerNetworkInspection } from "../docker-runtime.js";
import { durableJsonWriter } from "../private-state.js";
import type { ManagedWorkspaces, WorkspaceExecutionContext } from "../managed-workspaces.js";
import type { NativeCodexPty } from "./native-pty.js";
import { CodexSplitRuntime, type CodexSplitRuntimeAssembly, type CodexSplitRuntimeDependencies } from "./split-runtime.js";
import { parseCodexSplitRuntimeRecord } from "./runtime-record.js";
import type { CodexCodeModeHostHandle } from "./code-mode-host.js";
import type { CodexNativeAppServerHandle } from "./native-app-server.js";

const projectId = "018f0f00-0000-7000-8000-000000000001";
const workspaceId = "018f0f00-0000-7000-8000-000000000002";
const firstSessionId = "018f0f00-0000-7000-8000-000000000021";
const secondSessionId = "018f0f00-0000-7000-8000-000000000022";

const context = {
  projectId, workspaceId, revisionId: "018f0f00-0000-7000-8000-000000000003",
  revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`, runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
  ownership: {
    version: 1, projectId, workspaceId, revisionId: "018f0f00-0000-7000-8000-000000000003",
    revisionHash: `sha256-jcs-v1:${"a".repeat(64)}`, runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    worktreePath: "/managed/workspace", resources: { cpuMillicores: 1000, memoryBytes: 1024, pidLimit: 64 }, previewBindings: [],
    network: { id: "development-network", name: "development-network", labels: {} },
    developmentContainer: { id: "development-container", name: "development-container", labels: {} }
  },
  options: {}
} as unknown as WorkspaceExecutionContext;

const home = { accountBinding: "owner-default" as const, homePath: "/agent/codex-home", mountTarget: "/codex-home" as const,
  identity: { device: "1", inode: "2" }, ownerUid: 1000, ownerGid: 1000 };
const network = {
  execution: { role: "execution" as const, workspaceId, generation: 1, id: "execution-id", name: "execution-network",
    controlAlias: "codex-control" as const, executorAlias: "codex-executor" as const, internal: true as const,
    defaultRoute: false as const, publishedPorts: [] as const },
  controlEgress: { role: "control-egress" as const, workspaceId, generation: 1, id: "egress-id", name: "control-egress",
    controlAlias: "codex-control" as const, executorAttached: false as const, internal: false as const, defaultRoute: true as const,
    publishedPorts: [] as const, defaultBridgeUsed: false as const }
};
const executorName = `devspace-codex-${workspaceId.replaceAll("-", "")}-g1-executor`;
const controlName = `devspace-codex-${workspaceId.replaceAll("-", "")}-g1-control`;
const endpoint = { endpointUrl: "ws://codex-executor:4545", endpointHost: "codex-executor" as const, endpointPort: 4545,
  security: "private-network-only" as const, authenticationEvidence: "absent" as const, credential: null,
  workspaceId, generation: 1, executionNetworkId: "execution-id" };
const remote = {
  environment: { CODEX_HOME: "/codex-home", HOME: "/codex-home", CODEX_EXEC_SERVER_URL: endpoint.endpointUrl },
  launchArguments: [] as const,
  managedPolicy: { mechanism: "0.153.4-managed-requirements" as const, requirementsPath: "/agent/policy.toml",
    mountTarget: "/etc/codex/requirements.toml" as const, environment: { CODEX_HOME: "/codex-home", HOME: "/codex-home", CODEX_EXEC_SERVER_URL: endpoint.endpointUrl },
    forbiddenPaths: [] as const, projectLayerOverrideProof: "cannot-override" as const },
  endpoint, environmentId: "remote" as const, logicalCwd: "/workspace" as const, workspaceRoots: ["/workspace"] as ["/workspace"],
  localEnvironmentAvailable: false as const, unifiedExecRequired: true as const,
  codeMode: {
    enabled: true as const,
    hostEnabled: true as const,
    disableInProcessFallback: true as const,
    remoteHostUrl: "http://codex-code-mode-host:4546"
  }
};

function pty(execId: string): NativeCodexPty {
  return { containerId: "control-id", execId, command: ["/opt/devspace/codex-launcher/codex"], logicalArgv: ["codex"], workingDirectory: "/workspace",
    stream: new PassThrough(), resize: () => Promise.resolve(),
    inspect: () => Promise.resolve({ ID: execId, Running: true, ExitCode: null, ContainerID: "control-id", Pid: 10 }) };
}

function assembly(): CodexSplitRuntimeAssembly {
  return {
    home,
    network,
    artifact: {
      packageVersion: "0.153.4", closureDigest: "a".repeat(64), mountTarget: "/opt/devspace/codex",
      entrypointPath: "/opt/devspace/codex/bin/codex", launcherPath: "/opt/devspace/codex-launcher/codex",
      launcherSourceRoot: "/managed/codex-launchers/a", launcherSourcePath: "/managed/codex-launchers/a/codex",
      staged: {} as never
    },
    executor: { containerId: "executor-id", containerName: executorName, endpointHost: "codex-executor", endpointPort: 4545,
      controlEgressAttached: false, policy: {
        imageId: `sha256:${"b".repeat(64)}`, imageReference: "node@sha256:" + "b".repeat(64), imageArchitecture: "amd64",
        projectId, workspaceId, generation: 1, executionNetwork: network.execution
      } } as never,
    transport: endpoint,
    server: { executorContainerId: "executor-id", execId: "server-exec", endpoint, serverPid: 11 },
    codeModeHost: {
      executorContainerId: "executor-id", execId: "code-mode-exec", endpoint: {
        host: "codex-code-mode-host", port: 4546, url: "http://codex-code-mode-host:4546",
        listenUrl: "grpc://0.0.0.0:4546", networkId: "execution-id"
      }, serverPid: 12, transportSecurity: "private-network-only"
    } satisfies CodexCodeModeHostHandle,
    appServer: {
      controlContainerId: "control-id", execId: "app-server-exec", serverPid: 13,
      socketPath: "/codex-home/app-server-control/app-server-control.sock",
      socketIdentity: { device: "1", inode: "6" }, homeIdentity: "1:2",
      codeModeHostUrl: "http://codex-code-mode-host:4546", transportSecurity: "private-network-only"
    } satisfies CodexNativeAppServerHandle,
    remote,
    control: { containerId: "control-id", containerName: controlName, imageId: `sha256:${"c".repeat(64)}`, policy: { remote, home, network } } as never
  };
}

function docker(events: string[], options: { readonly missing?: ReadonlySet<string>; readonly foreignNetwork?: string } = {}): DockerEngineClient {
  return new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override assertRootlessAvailable(): Promise<void> { events.push("rootless"); return Promise.resolve(); }
    override inspectNetwork(id: string): Promise<DockerNetworkInspection> {
      if (options.missing?.has(id)) return Promise.reject(new DockerEngineError(404, "missing"));
      const isExecution = id === network.execution.id;
      return Promise.resolve({ Id: id, Name: isExecution ? network.execution.name : network.controlEgress.name,
        Labels: { "devspace.managed": "true", "devspace.codex-split": "true", "devspace.project-id": projectId,
          "devspace.workspace-id": workspaceId, "devspace.runtime-generation": "1",
          "devspace.resource-role": options.foreignNetwork === id ? "foreign" : isExecution ? "execution" : "control-egress" },
        Driver: "bridge", Internal: isExecution ? true : false, Attachable: false, Ingress: false, EnableIPv6: false, Options: {},
        Containers: isExecution
          ? Object.fromEntries(([["executor-id", { Name: executorName }], ["control-id", { Name: controlName }]] as const)
            .filter(([memberId]) => !options.missing?.has(memberId)))
          : (options.missing?.has("control-id") ? {} : { "control-id": { Name: controlName } }) } as DockerNetworkInspection);
    }
    override inspectContainer(id: string): Promise<DockerContainerInspection> {
      if (options.missing?.has(id)) return Promise.reject(new DockerEngineError(404, "missing"));
      const isControl = id === "control-id";
      return Promise.resolve({ Id: id, Name: isControl ? `/${controlName}` : `/${executorName}`, State: { Running: true, Status: "running" },
        Config: { Labels: { "devspace.managed": "true", "devspace.codex-split": "true",
          "devspace.workspace-id": workspaceId, "devspace.runtime-generation": "1",
          "devspace.resource-role": isControl ? "codex-control" : "codex-split-executor" } },
        NetworkSettings: { Networks: isControl
          ? { [network.execution.name]: { NetworkID: network.execution.id }, [network.controlEgress.name]: { NetworkID: network.controlEgress.id } }
          : { [network.execution.name]: { NetworkID: network.execution.id } } } } as unknown as DockerContainerInspection);
    }
    override stopContainer(id: string): Promise<void> { events.push(`stop:${id}`); return Promise.resolve(); }
    override removeContainer(id: string): Promise<void> { events.push(`remove:${id}`); return Promise.resolve(); }
    override removeNetwork(id: string): Promise<void> { events.push(`remove-network:${id}`); return Promise.resolve(); }
  }();
}

function dependencies(events: string[], startPty: (sessionId: string | null) => Promise<NativeCodexPty>): CodexSplitRuntimeDependencies {
  return {
    buildAssembly() { events.push("assembly"); return Promise.resolve(assembly()); },
    startPty(input) { events.push(`pty:${input.resumeSessionId ?? "new"}`); return startPty(input.resumeSessionId); },
    now: () => "2026-09-16T10:00:00.000Z"
  };
}

const roots: string[] = [];
afterEach(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(events: string[], startPty: (sessionId: string | null) => Promise<NativeCodexPty> = (id) => Promise.resolve(pty(id ?? "new-exec"))) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "devspace-codex-split-runtime-"));
  roots.push(stateRoot);
  const managed = {
    executionContext: () => { events.push("context"); return Promise.resolve(context); },
    codexExecutorGitBinding: () => { events.push("git"); return Promise.resolve({
      projectId, workspaceId, worktreePath: "/managed/workspace", repositoryPath: "/managed/repository", administrationPath: "/managed/admin",
      worktreeIdentity: { device: "1", inode: "3" }, repositoryIdentity: { device: "1", inode: "4" }, administrationIdentity: { device: "1", inode: "5" }
    }); }
  } as unknown as ManagedWorkspaces;
  const engine = docker(events);
  const runtime = new CodexSplitRuntime({ managed, docker: engine, stateRoot, controlImageReference: "registry.example/codex-control@sha256:abc", codexExecutablePath: "/agent/codex" }, dependencies(events, startPty));
  return { runtime, stateRoot, managed, docker: engine };
}

test("orders rootless and managed authority before split assembly and persists only opaque runtime state", async () => {
  const events: string[] = [];
  const value = await fixture(events);
  const result = await value.runtime.ensure({ projectId, workspaceId });
  expect(events.slice(0, 4)).toEqual(["rootless", "context", "git", "assembly"]);
  expect(result).toMatchObject({ projectId, workspaceId, executor: { id: "executor-id" }, control: { id: "control-id" } });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("/agent/codex-home");
  expect(serialized).not.toContain("CODEX_HOME");
  expect(serialized).not.toContain("registry.example");
});

test("persists both executor services and the native app-server provenance", async () => {
  const events: string[] = [];
  const value = await fixture(events);
  const result = await value.runtime.ensure({ projectId, workspaceId });
  expect(result).toMatchObject({
    version: 2,
    execServer: { executorContainerId: "executor-id", execId: "server-exec", serverPid: 11 },
    codeModeHost: { executorContainerId: "executor-id", execId: "code-mode-exec", serverPid: 12 },
    control: { id: "control-id", homeIdentity: home.identity, appServer: {
      controlContainerId: "control-id", execId: "app-server-exec", serverPid: 13,
      socketPath: "/codex-home/app-server-control/app-server-control.sock"
    } }
  });
  const persisted = JSON.parse((await readFile(path.join(value.stateRoot, "codex-split", `${workspaceId}.json`))).toString("utf8")) as unknown;
  expect(parseCodexSplitRuntimeRecord(persisted)).toEqual(result);
});

test("reattaches a current record without falling back to a partial assembly", async () => {
  const events: string[] = [];
  const value = await fixture(events);
  const first = await value.runtime.ensure({ projectId, workspaceId });
  const reattached = new CodexSplitRuntime({
    managed: value.managed, docker: value.docker, stateRoot: value.stateRoot,
    controlImageReference: "registry.example/codex-control@sha256:abc", codexExecutablePath: "/agent/codex"
  }, {
    reattachAssembly: ({ record }) => {
      events.push(`reattach:${record.version}`);
      return Promise.resolve(assembly());
    },
    buildAssembly: () => Promise.reject(new Error("unexpected-rebuild"))
  });
  const second = await reattached.ensure({ projectId, workspaceId });
  expect(second).toEqual(first);
  expect(events).toContain("reattach:2");
});

test("allows distinct live native sessions, rejects only duplicate live resume, and never starts local execution", async () => {
  const events: string[] = [];
  const value = await fixture(events, (id) => Promise.resolve(pty(id === firstSessionId ? "exec-1" : "exec-2")));
  await value.runtime.ensure({ projectId, workspaceId });
  await value.runtime.startResume({ projectId, workspaceId, nativeSessionId: firstSessionId, columns: 80, rows: 24 });
  await value.runtime.startResume({ projectId, workspaceId, nativeSessionId: secondSessionId, columns: 80, rows: 24 });
  await expect(value.runtime.startResume({ projectId, workspaceId, nativeSessionId: firstSessionId, columns: 80, rows: 24 }))
    .rejects.toThrow("session-live");
  expect(events.filter((entry) => entry.startsWith("local:")).length).toBe(0);
});

test("executor loss fails closed and does not create a control project mount", async () => {
  const events: string[] = [];
  const value = await fixture(events);
  const runtime = value.runtime;
  await runtime.ensure({ projectId, workspaceId });
  const controlMounts = (await runtime.ensure({ projectId, workspaceId })).control;
  expect(controlMounts).toMatchObject({ id: "control-id", homeBinding: "owner-default", appServer: { execId: "app-server-exec" } });
  expect(events.filter((entry) => entry.startsWith("local:")).length).toBe(0);
});

test("stop tears down only the split resources while preserving managed/home state", async () => {
  const events: string[] = [];
  const value = await fixture(events);
  await value.runtime.ensure({ projectId, workspaceId });
  await value.runtime.stop({ projectId, workspaceId });
  expect(events).toContain("stop:control-id");
  expect(events).toContain("stop:executor-id");
  expect(events).toContain("remove-network:execution-id");
  expect(events).toContain("remove-network:egress-id");
});

test("rebuilds only the split runtime when a current recorded Docker resource is gone", async () => {
  const events: string[] = [];
  const value = await fixture(events);
  await value.runtime.ensure({ projectId, workspaceId });

  const reattachedRuntime = new CodexSplitRuntime({
    managed: value.managed, docker: docker(events, { missing: new Set(["executor-id"]) }), stateRoot: value.stateRoot,
    controlImageReference: "registry.example/codex-control@sha256:abc", codexExecutablePath: "/agent/codex"
  }, {
    reattachAssembly: () => Promise.reject(new DockerEngineError(404, "missing")),
    buildAssembly: () => { events.push("rebuild"); return Promise.resolve(assembly()); },
    now: () => "2026-09-16T10:00:00.000Z"
  });

  await expect(reattachedRuntime.ensure({ projectId, workspaceId })).resolves.toMatchObject({ executor: { id: "executor-id" } });
  expect(events).toContain("remove:control-id");
  expect(events).toContain("remove-network:egress-id");
  expect(events).toContain("remove-network:execution-id");
  expect(events).toContain("rebuild");
});

test("does not delete or rebuild when a recorded split network is not owned", async () => {
  const events: string[] = [];
  const value = await fixture(events);
  await value.runtime.ensure({ projectId, workspaceId });
  const reattachedRuntime = new CodexSplitRuntime({
    managed: value.managed, docker: docker(events, { foreignNetwork: network.execution.id }), stateRoot: value.stateRoot,
    controlImageReference: "registry.example/codex-control@sha256:abc", codexExecutablePath: "/agent/codex"
  }, {
    reattachAssembly: () => Promise.reject(new DockerEngineError(404, "missing")),
    buildAssembly: () => { events.push("rebuild"); return Promise.resolve(assembly()); }
  });

  await expect(reattachedRuntime.ensure({ projectId, workspaceId })).rejects.toThrow("codex-split-runtime-network-ownership");
  expect(events).not.toContain("rebuild");
  expect(events).not.toContain("remove-network:execution-id");
});

test("invalidates an incompatible split record and rebuilds only after its resources are gone", async () => {
  const events: string[] = [];
  const value = await fixture(events);
  const current = await value.runtime.ensure({ projectId, workspaceId });
  await durableJsonWriter.write(path.join(value.stateRoot, "codex-split", `${workspaceId}.json`), {
    ...current,
    unsupportedNewField: "incompatible experimental record"
  });

  const reattachedRuntime = new CodexSplitRuntime({
    managed: value.managed,
    docker: docker(events, { missing: new Set(["execution-id", "egress-id", "executor-id", "control-id"]) }),
    stateRoot: value.stateRoot,
    controlImageReference: "registry.example/codex-control@sha256:abc",
    codexExecutablePath: "/agent/codex"
  }, {
    buildAssembly: () => { events.push("rebuild"); return Promise.resolve(assembly()); }
  });

  await expect(reattachedRuntime.ensure({ projectId, workspaceId })).resolves.toMatchObject({ workspaceId });
  expect(events).toContain("rebuild");
});
