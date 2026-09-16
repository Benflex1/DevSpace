import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { DockerEngineClient, type DockerContainerInspection, type DockerNetworkInspection } from "../docker-runtime.js";
import type { ManagedWorkspaces, WorkspaceExecutionContext } from "../managed-workspaces.js";
import type { NativeCodexPty } from "./native-pty.js";
import { CodexSplitRuntime, type CodexSplitRuntimeAssembly, type CodexSplitRuntimeDependencies } from "./split-runtime.js";

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
const endpoint = { endpointUrl: "ws://codex-executor:4545", endpointHost: "codex-executor" as const, endpointPort: 4545,
  security: "private-network-only" as const, authenticationEvidence: "absent" as const, credential: null,
  workspaceId, generation: 1, executionNetworkId: "execution-id" };
const remote = {
  environment: { CODEX_HOME: "/codex-home", HOME: "/codex-home", CODEX_EXEC_SERVER_URL: endpoint.endpointUrl },
  launchArguments: ["-c", "notify=[]"] as const,
  managedPolicy: { mechanism: "0.153.4-managed-requirements" as const, requirementsPath: "/agent/policy.toml",
    mountTarget: "/etc/codex/requirements.toml" as const, environment: { CODEX_HOME: "/codex-home", HOME: "/codex-home", CODEX_EXEC_SERVER_URL: endpoint.endpointUrl },
    forbiddenPaths: [] as const, projectLayerOverrideProof: "cannot-override" as const },
  endpoint, environmentId: "remote" as const, logicalCwd: "/workspace" as const, workspaceRoots: ["/workspace"] as ["/workspace"],
  localEnvironmentAvailable: false as const, unifiedExecRequired: true as const
};

function pty(execId: string): NativeCodexPty {
  return { containerId: "control-id", execId, command: ["/opt/devspace/codex-launcher/codex"], workingDirectory: "/workspace",
    stream: new PassThrough(), resize: () => Promise.resolve(),
    inspect: () => Promise.resolve({ ID: execId, Running: true, ExitCode: null, ContainerID: "control-id", Pid: 10 }) };
}

function assembly(): CodexSplitRuntimeAssembly {
  return {
    home,
    network,
    artifact: {} as never,
    executor: { containerId: "executor-id", containerName: "executor", endpointHost: "codex-executor", endpointPort: 4545,
      controlEgressAttached: false, policy: { imageId: `sha256:${"b".repeat(64)}`, workspaceId, generation: 1, executionNetwork: network.execution } } as never,
    transport: endpoint,
    server: { executorContainerId: "executor-id", execId: "server-exec", endpoint, serverPid: 11 },
    remote,
    control: { containerId: "control-id", containerName: "control", imageId: `sha256:${"c".repeat(64)}`, policy: { remote, home, network } } as never
  };
}

function docker(events: string[]): DockerEngineClient {
  return new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override assertRootlessAvailable(): Promise<void> { events.push("rootless"); return Promise.resolve(); }
    override inspectNetwork(id: string): Promise<DockerNetworkInspection> {
      const isExecution = id === network.execution.id;
      return Promise.resolve({ Id: id, Name: isExecution ? network.execution.name : network.controlEgress.name,
        Labels: { "devspace.managed": "true", "devspace.codex-split": "true",
          "devspace.resource-role": isExecution ? "execution" : "control-egress" },
        Containers: isExecution
          ? { "executor-id": { Name: "executor" }, "control-id": { Name: "control" } }
          : { "control-id": { Name: "control" } } } as DockerNetworkInspection);
    }
    override inspectContainer(id: string): Promise<DockerContainerInspection> {
      const isControl = id === "control-id";
      return Promise.resolve({ Id: id, Config: { Labels: { "devspace.managed": "true", "devspace.codex-split": "true",
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
  const runtime = new CodexSplitRuntime({ managed, docker: docker(events), stateRoot, controlImageReference: "registry.example/codex-control@sha256:abc", codexExecutablePath: "/agent/codex" }, dependencies(events, startPty));
  return { runtime, stateRoot };
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
  expect(controlMounts).toEqual({ id: "control-id", homeBinding: "owner-default" });
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
