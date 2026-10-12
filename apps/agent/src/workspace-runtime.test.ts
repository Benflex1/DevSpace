import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  canonicalizeRuntimePlanV1, compileRuntimePlanV1, hashRuntimePlanV1
} from "@devspace/project-options";
import {
  classifyHarnessSlotMount,
  runtimeCreationSchema,
  runtimeOwnershipSchema,
  verifyRuntimePlanAgainstOptions,
  WorkspaceRuntimeManager
} from "./workspace-runtime.js";
import { DockerEngineClient, DockerEngineError, type DockerContainerInspection, type DockerNetworkInspection } from "./docker-runtime.js";
import { durableJsonWriter, type AtomicJsonWriter } from "./private-state.js";

const options = {
  schemaVersion: 1,
  developmentEnvironment: { source: { kind: "image", imageReference: "node:24-bookworm" } }
};
const directories: string[] = [];
afterEach(async () => await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true }))));

class FakeEngine extends DockerEngineClient {
  readonly networks = new Map<string, DockerNetworkInspection>();
  readonly containers = new Map<string, DockerContainerInspection>();
  readonly names = new Set<string>();
  lastContainerInput: Parameters<DockerEngineClient["createContainer"]>[1] | null = null;
  cleanupInput: Parameters<DockerEngineClient["createHarnessHomeCleanupContainer"]>[1] | null = null;
  cleanupContainerId: string | null = null;
  networkCreates = 0;
  containerCreates = 0;
  imageFailures = 0;
  containerCreateFailures = 0;
  containerRemovalFailuresAfterRemove = 0;
  networkRemovalFailuresAfterRemove = 0;
  runningInspections = 0;
  readonly networkIdsBeforeStart: string[] = [];
  onRunningInspect: ((inspection: number, container: DockerContainerInspection) => void) | null = null;
  constructor() { super("/fixture/rootless.sock"); }
  override assertRootlessAvailable(): Promise<void> { return Promise.resolve(); }
  override ensureImage(): Promise<void> {
    if (this.imageFailures > 0) { this.imageFailures -= 1; return Promise.reject(new DockerEngineError(500, "pull failed")); }
    return Promise.resolve();
  }
  override createNetwork(name: string, labels: Record<string, string>): Promise<string> {
    if (this.names.has(name)) throw new DockerEngineError(409, "collision");
    this.networkCreates += 1;
    const id = `network-${this.networkCreates}`; this.names.add(name);
    this.networks.set(id, { Id: id, Name: name, Labels: { ...labels } }); return Promise.resolve(id);
  }
  override inspectNetwork(id: string): Promise<DockerNetworkInspection> {
    const value = this.networks.get(id) ?? [...this.networks.values()].find((network) => network.Name === id);
    return value === undefined ? Promise.reject(new DockerEngineError(404, "missing")) : Promise.resolve(value);
  }
  override removeNetwork(id: string): Promise<void> {
    const network = this.networks.get(id);
    if (network === undefined) throw new DockerEngineError(404, "missing");
    this.networks.delete(id); this.names.delete(network.Name); this.removedNetworkIds.push(id);
    if (this.networkRemovalFailuresAfterRemove > 0) {
      this.networkRemovalFailuresAfterRemove -= 1;
      throw new Error("simulated-crash-after-network-removal");
    }
    return Promise.resolve();
  }
  override createContainer(name: string, input: Parameters<DockerEngineClient["createContainer"]>[1]): Promise<string> {
    if (this.names.has(name)) throw new DockerEngineError(409, "collision");
    if (this.containerCreateFailures > 0) { this.containerCreateFailures -= 1; throw new DockerEngineError(500, "create failed"); }
    this.containerCreates += 1;
    const id = `container-${this.containerCreates}`; this.names.add(name); this.lastContainerInput = input;
    const network = [...this.networks.values()].find((candidate) => candidate.Name === input.networkName);
    if (network === undefined) throw new DockerEngineError(404, "network missing");
    this.containers.set(id, { Id: id, Name: `/${name}`, Image: `sha256:${"1".repeat(64)}`,
      Config: { Labels: { ...input.labels }, Image: input.imageReference, User: input.user ?? "", WorkingDir: "/workspace" },
      State: { Running: false, Status: "created" }, HostConfig: { Privileged: false, PublishAllPorts: false,
        PidMode: "", IpcMode: "private", UTSMode: "", UsernsMode: "", CgroupnsMode: "private",
        NetworkMode: input.networkName,
        PortBindings: Object.fromEntries(Object.entries(input.portBindings ?? {}).map(([key, values]) => [key,
          values.map((value) => ({ HostIp: value.HostIp, HostPort: value.HostPort }))])), Devices: [],
        NanoCpus: input.cpuMillicores * 1_000_000, Memory: input.memoryBytes, PidsLimit: input.pidLimit,
        CapAdd: [], CapDrop: [], SecurityOpt: ["no-new-privileges:true"], AutoRemove: false, ReadonlyRootfs: false,
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 } },
      NetworkSettings: { Networks: { [input.networkName]: { NetworkID: "" } } },
      Mounts: [
        { Type: "bind", Source: input.worktreePath, Destination: "/workspace", RW: true, Propagation: "rprivate" },
        ...(input.harnessSlotPath === undefined ? [] : [{
          Type: "bind", Source: input.harnessSlotPath, Destination: "/opt/devspace/harness-home", RW: true, Propagation: "rprivate"
        }])
      ] });
    return Promise.resolve(id);
  }
  override createHarnessHomeCleanupContainer(name: string, input: Parameters<DockerEngineClient["createHarnessHomeCleanupContainer"]>[1]): Promise<string> {
    this.cleanupInput = input;
    const id = `cleanup-${this.containers.size + 1}`;
    this.cleanupContainerId = id;
    this.containers.set(id, { Id: id, Name: `/${name}`, Image: input.imageId,
      Config: { Labels: { "devspace.managed": "true", "devspace.resource": "harness-home-cleanup",
        "devspace.workspace-id": input.workspaceId }, Image: input.imageId, User: "0", WorkingDir: "/" },
      State: { Running: false, Status: "created", ExitCode: 0 },
      HostConfig: { Privileged: false, PublishAllPorts: false, PidMode: "", IpcMode: "private", UTSMode: "",
        UsernsMode: "", CgroupnsMode: "private", NetworkMode: "none", PortBindings: {}, Devices: [],
        NanoCpus: 500_000_000, Memory: 128 * 1024 * 1024, PidsLimit: 16, CapAdd: [], CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"], AutoRemove: false, ReadonlyRootfs: true,
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 } }, NetworkSettings: { Networks: {} }, Mounts: [] });
    return Promise.resolve(id);
  }
  override inspectContainer(id: string): Promise<DockerContainerInspection> {
    const value = this.containers.get(id) ?? [...this.containers.values()].find((container) => container.Name.replace(/^\//u, "") === id);
    if (value?.State.Running === true) {
      this.runningInspections += 1;
      this.onRunningInspect?.(this.runningInspections, value);
    }
    return value === undefined || !this.containers.has(value.Id)
      ? Promise.reject(new DockerEngineError(404, "missing")) : Promise.resolve(value);
  }
  override startContainer(id: string): Promise<void> { const value = this.containers.get(id); if (value === undefined) throw new DockerEngineError(404, "missing");
    if (id === this.cleanupContainerId) { this.containers.set(id, { ...value, State: { Running: false, Status: "exited", ExitCode: 0 } }); return Promise.resolve(); }
    this.networkIdsBeforeStart.push(value.NetworkSettings.Networks?.[value.HostConfig.NetworkMode]?.NetworkID ?? "missing");
    const network = [...this.networks.values()].find((candidate) => candidate.Name === value.HostConfig.NetworkMode);
    if (network === undefined) throw new DockerEngineError(404, "network missing");
    this.containers.set(id, { ...value, State: { Running: true, Status: "running" },
      NetworkSettings: { Networks: { [network.Name]: { NetworkID: network.Id } } } }); return Promise.resolve(); }
  override stopContainer(id: string): Promise<void> { const value = this.containers.get(id); if (value === undefined) throw new DockerEngineError(404, "missing");
    this.containers.set(id, { ...value, State: { Running: false, Status: "exited" } }); return Promise.resolve(); }
  override removeContainer(id: string): Promise<void> {
    const value = this.containers.get(id);
    if (value === undefined) throw new DockerEngineError(404, "missing");
    this.containers.delete(id);
    this.names.delete(value.Name.replace(/^\//u, ""));
    this.removedContainerIds.push(id);
    if (this.containerRemovalFailuresAfterRemove > 0) {
      this.containerRemovalFailuresAfterRemove -= 1;
      throw new Error("simulated-crash-after-container-removal");
    }
    return Promise.resolve();
  }
  readonly removedContainerIds: string[] = [];
  readonly removedNetworkIds: string[] = [];
}

const association = { projectId: "018f1f34-7000-7000-8000-000000000001", workspaceId: "018f1f34-7000-7000-8000-000000000002",
  revisionId: "018f1f34-7000-7000-8000-000000000003", revisionHash: `sha256-jcs-v1:${"1".repeat(64)}`,
  runtimePlanHash: "", generation: 1 };
const operationId = "018f1f34-7000-7000-8000-000000000010";

class FakeLifecycle {
  current = 0;
  readonly sleeps: number[] = [];
  now = () => this.current;
  sleep = (milliseconds: number) => { this.sleeps.push(milliseconds); this.current += milliseconds; return Promise.resolve(); };
}

async function runtimeFixture(writer: AtomicJsonWriter = durableJsonWriter) {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-runtime-manager-")); directories.push(root);
  await Promise.all(["ownership/runtimes", "runtime-creations"].map(async (relative) =>
    await mkdir(path.join(root, "state", relative), { recursive: true })));
  const worktree = path.join(root, "worktree"); await mkdir(worktree);
  const engine = new FakeEngine();
  const lifecycle = new FakeLifecycle();
  const policy = { cpuMillicores: 2000, memoryBytes: 1024 * 1024 * 1024, pidLimit: 256,
    stabilizationDurationMs: 20, stabilizationIntervalMs: 10, stabilizationTimeoutMs: 50 };
  const manager = new WorkspaceRuntimeManager(path.join(root, "state"), engine, policy, writer, lifecycle);
  const plan = compileRuntimePlanV1(options);
  return { root, engine, manager, lifecycle, worktree, plan, policy,
    association: { ...association, runtimePlanHash: hashRuntimePlanV1(plan) } };
}

async function start(fixture: Awaited<ReturnType<typeof runtimeFixture>>, id = operationId) {
  return await fixture.manager.start(fixture.association, fixture.plan, fixture.worktree, id);
}

function faultingWriter(match: (file: string, value: unknown) => boolean, timing: "before" | "after"): AtomicJsonWriter {
  let armed = true;
  return { async write(file, value) {
    const fail = armed && match(file, value);
    if (fail && timing === "before") { armed = false; throw new Error("simulated-crash-before-durable-write"); }
    await durableJsonWriter.write(file, value);
    if (fail) { armed = false; throw new Error("simulated-crash-after-durable-write"); }
  } };
}

function phaseIs(phase: string) {
  return (_file: string, value: unknown) => (value as { phase?: string }).phase === phase;
}

function restart(fixture: Awaited<ReturnType<typeof runtimeFixture>>, writer: AtomicJsonWriter = durableJsonWriter) {
  fixture.manager = new WorkspaceRuntimeManager(path.join(fixture.root, "state"), fixture.engine, fixture.policy, writer, fixture.lifecycle);
}

function onlyContainer(fixture: Awaited<ReturnType<typeof runtimeFixture>>): DockerContainerInspection {
  const container = [...fixture.engine.containers.values()][0];
  if (container === undefined) throw new Error("test container missing");
  return container;
}

async function expectSingleStack(fixture: Awaited<ReturnType<typeof runtimeFixture>>): Promise<void> {
  await expect(start(fixture, "018f1f34-7000-7000-8000-000000000012")).resolves.toMatchObject({ observedState: "running" });
  expect(fixture.engine.networkCreates).toBe(1);
  expect(fixture.engine.containerCreates).toBe(1);
  expect(fixture.engine.networks).toHaveLength(1);
  expect(fixture.engine.containers).toHaveLength(1);
  const creation = runtimeCreationSchema.parse(JSON.parse(await readFile(
    path.join(fixture.root, "state/runtime-creations", `${fixture.association.workspaceId}.json`), "utf8")) as unknown);
  expect(creation.phase).toBe("ownership-committed");
  const ownership = runtimeOwnershipSchema.parse(JSON.parse(await readFile(
    path.join(fixture.root, "state/ownership/runtimes", `${fixture.association.workspaceId}.json`), "utf8")) as unknown);
  expect(ownership.network.id).toBe(creation.networkId);
  expect(ownership.developmentContainer.id).toBe(creation.containerId);
}

describe("Agent-independent runtime-plan verification", () => {
  test("accepts only the exact independently compiled canonical plan and hash", () => {
    const plan = compileRuntimePlanV1(options);
    const canonical = canonicalizeRuntimePlanV1(plan);
    const hash = hashRuntimePlanV1(plan);
    expect(verifyRuntimePlanAgainstOptions(options, canonical, hash)).toEqual(plan);
    const tampered = canonical.replace("node:24-bookworm", "node:22-bookworm");
    expect(() => verifyRuntimePlanAgainstOptions(options, tampered, hash)).toThrow("does not match");
    expect(() => verifyRuntimePlanAgainstOptions(options, canonical, `sha256-jcs-v1:${"0".repeat(64)}`)).toThrow("does not match");
  });
});

describe("exact Docker runtime ownership", () => {
  test("creates one exact stack and stop/start reuses generation and container", async () => {
    const fixture = await runtimeFixture();
    await expect(start(fixture)).resolves.toMatchObject({ observedState: "running" });
    expect(fixture.engine.networks).toHaveLength(1); expect(fixture.engine.containers).toHaveLength(1);
    expect(fixture.engine.lastContainerInput?.worktreePath).toBe(fixture.worktree);
    expect(fixture.engine.lastContainerInput?.networkName).toMatch(/^devspace-/u);
    expect(JSON.stringify(fixture.engine.lastContainerInput)).not.toContain("docker.sock");
    expect(fixture.engine.networkIdsBeforeStart).toEqual([""]);
    const network = [...fixture.engine.networks.values()][0]!;
    expect(onlyContainer(fixture).NetworkSettings.Networks?.[network.Name]?.NetworkID).toBe(network.Id);
    await expect(fixture.manager.stop(fixture.association)).resolves.toMatchObject({ observedState: "stopped" });
    await expect(start(fixture, "018f1f34-7000-7000-8000-000000000011")).resolves.toMatchObject({ observedState: "running" });
    expect(fixture.engine.networks).toHaveLength(1); expect(fixture.engine.containers).toHaveLength(1);
  });

  test.each(["container", "network"] as const)("retirement retry reconciles interruption after %s removal", async (boundary) => {
    const fixture = await runtimeFixture();
    await start(fixture);
    await fixture.manager.stop(fixture.association);
    if (boundary === "container") fixture.engine.containerRemovalFailuresAfterRemove = 1;
    else fixture.engine.networkRemovalFailuresAfterRemove = 1;
    const ownershipPath = path.join(fixture.root, "state/ownership/runtimes", `${fixture.association.workspaceId}.json`);
    const creationPath = path.join(fixture.root, "state/runtime-creations", `${fixture.association.workspaceId}.json`);
    const afterContainerAbsent = boundary === "container"
      ? () => Promise.reject(new Error("simulated-interruption-after-container-absence"))
      : () => Promise.resolve();
    await expect(fixture.manager.retireForRevisionAdoption(fixture.association, afterContainerAbsent, () => undefined)).rejects.toThrow();
    await expect(readFile(ownershipPath, "utf8")).resolves.toContain(fixture.association.revisionId);
    await expect(readFile(creationPath, "utf8")).resolves.toContain(fixture.association.revisionId);
    expect(fixture.engine.containers).toHaveLength(0);
    if (boundary === "container") expect(fixture.engine.networks).toHaveLength(1);
    else expect(fixture.engine.networks).toHaveLength(0);

    restart(fixture);
    await fixture.manager.retireForRevisionAdoption(fixture.association, () => Promise.resolve(), () => undefined);
    await expect(readFile(ownershipPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(creationPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.engine.containers).toHaveLength(0);
    expect(fixture.engine.networks).toHaveLength(0);
    expect(fixture.engine.removedContainerIds).toHaveLength(1);
    expect(fixture.engine.removedNetworkIds).toHaveLength(1);
  });

  test("refuses unowned runtime resources at canonical names without deleting them", async () => {
    const fixture = await runtimeFixture();
    await start(fixture);
    const ownershipPath = path.join(fixture.root, "state/ownership/runtimes", `${fixture.association.workspaceId}.json`);
    const creationPath = path.join(fixture.root, "state/runtime-creations", `${fixture.association.workspaceId}.json`);
    await rm(ownershipPath, { force: true });
    await rm(creationPath, { force: true });

    await expect(fixture.manager.retireForRevisionAdoption(fixture.association, () => Promise.resolve(), () => undefined))
      .rejects.toMatchObject({ code: "WORKSPACE_STATE_CONFLICT" });
    expect(fixture.engine.containers).toHaveLength(1);
    expect(fixture.engine.networks).toHaveLength(1);
    expect(fixture.engine.removedContainerIds).toEqual([]);
    expect(fixture.engine.removedNetworkIds).toEqual([]);
  });

  test("accepts image labels while rejecting unrecorded DevSpace ownership labels", async () => {
    const fixture = await runtimeFixture();
    await start(fixture);
    const container = onlyContainer(fixture);
    container.Config.Labels["org.opencontainers.image.title"] = "Git-enabled test image";
    container.Config.Labels["dev.containers.features"] = "git";
    await expect(fixture.manager.inspect(fixture.association)).resolves.toMatchObject({ observedState: "running" });

    container.Config.Labels["devspace.unrecorded-owner"] = "foreign";
    await expect(fixture.manager.inspect(fixture.association)).resolves.toMatchObject({ observedState: "lost" });
  });

  test("clears a private slot with a restricted helper bound to the exact stopped workspace owner", async () => {
    const fixture = await runtimeFixture();
    await start(fixture);
    await fixture.manager.stop(fixture.association);

    await expect(fixture.manager.clearHarnessHomeSlot(fixture.association.workspaceId)).resolves.toBeUndefined();

    expect(fixture.engine.cleanupInput).toEqual({
      imageId: `sha256:${"1".repeat(64)}`,
      workspaceId: fixture.association.workspaceId,
      slotHostPath: path.join(fixture.root, "state", "harness-slots", fixture.association.workspaceId)
    });
    expect(fixture.engine.removedContainerIds).toContain(fixture.engine.cleanupContainerId);
  }, 10_000);

  test("fails closed on name collision and never adopts the colliding resource", async () => {
    const fixture = await runtimeFixture();
    fixture.engine.names.add(`devspace-${fixture.association.workspaceId.replaceAll("-", "")}-g1-network`);
    await expect(start(fixture)).rejects.toMatchObject({ code: "WORKSPACE_STATE_CONFLICT" });
    expect(fixture.engine.containers).toHaveLength(0);
  });

  test("reports mismatched, missing, wrong-revision, and wrong-plan resources as lost", async () => {
    const fixture = await runtimeFixture();
    await start(fixture);
    const container = [...fixture.engine.containers.values()][0]!;
    container.Config.Labels["devspace.runtime-generation"] = "2";
    await expect(fixture.manager.inspect(fixture.association)).resolves.toMatchObject({ observedState: "lost" });
    container.Config.Labels["devspace.runtime-generation"] = "1";
    await expect(fixture.manager.inspect({ ...fixture.association, revisionId: "018f1f34-7000-7000-8000-000000000004" })).resolves.toMatchObject({ observedState: "lost" });
    await expect(fixture.manager.inspect({ ...fixture.association, runtimePlanHash: `sha256-jcs-v1:${"2".repeat(64)}` })).resolves.toMatchObject({ observedState: "lost" });
    fixture.engine.containers.clear();
    await expect(fixture.manager.inspect(fixture.association)).resolves.toMatchObject({ observedState: "lost" });
  });

  test.each<readonly [string, (container: DockerContainerInspection) => void]>([
    ["an unexpected second network", (container) => { container.NetworkSettings.Networks!.unexpected = { NetworkID: "foreign-network" }; }],
    ["a missing expected network", (container) => { container.NetworkSettings.Networks = {}; }],
    ["an empty materialized network identity", (container) => { container.NetworkSettings.Networks![container.HostConfig.NetworkMode] = { NetworkID: "" }; }],
    ["a substituted materialized network identity", (container) => { container.NetworkSettings.Networks![container.HostConfig.NetworkMode] = { NetworkID: "foreign-network" }; }],
    ["a changed CPU limit", (container) => { container.HostConfig.NanoCpus += 1; }],
    ["a changed memory limit", (container) => { container.HostConfig.Memory += 1; }],
    ["a changed PID limit", (container) => { container.HostConfig.PidsLimit = 1; }],
    ["host IPC", (container) => { container.HostConfig.IpcMode = "host"; }],
    ["host UTS", (container) => { container.HostConfig.UTSMode = "host"; }],
    ["an added capability", (container) => { container.HostConfig.CapAdd = ["SYS_ADMIN"]; }],
    ["a changed capability drop set", (container) => { container.HostConfig.CapDrop = ["NET_RAW"]; }],
    ["removed no-new-privileges", (container) => { container.HostConfig.SecurityOpt = []; }],
    ["an unexpected security option", (container) => { container.HostConfig.SecurityOpt = ["no-new-privileges:true", "seccomp=unconfined"]; }],
    ["automatic removal", (container) => { container.HostConfig.AutoRemove = true; }],
    ["an automatic restart policy", (container) => { container.HostConfig.RestartPolicy = { Name: "always", MaximumRetryCount: 0 }; }],
    ["a missing effective inspect field", (container) => { delete (container.HostConfig as Partial<typeof container.HostConfig>).RestartPolicy; }],
    ["mount drift", (container) => { container.Mounts[0]!.Source = "/tmp/other"; }],
    ["shared bind propagation", (container) => { container.Mounts[0]!.Propagation = "shared"; }],
    ["a Docker socket mount", (container) => { container.Mounts.push({ Type: "bind", Source: "/run/docker.sock", Destination: "/var/run/docker.sock", RW: true, Propagation: "rprivate" }); }],
    ["host networking", (container) => { container.HostConfig.NetworkMode = "host"; }],
    ["host PID", (container) => { container.HostConfig.PidMode = "host"; }],
    ["privileged mode", (container) => { container.HostConfig.Privileged = true; }],
    ["an attached device", (container) => { container.HostConfig.Devices = [{}]; }],
    ["published ports", (container) => { container.HostConfig.PortBindings = { "3000/tcp": [{ HostPort: "3000" }] }; }]
  ])("rejects exact-ID labeled containers with %s", async (_name, drift) => {
    const fixture = await runtimeFixture(); await start(fixture);
    drift(onlyContainer(fixture));
    await expect(fixture.manager.inspect(fixture.association)).resolves.toMatchObject({ observedState: "lost" });
  });

  test("refuses to stop a drifted exact container", async () => {
    const fixture = await runtimeFixture(); await start(fixture);
    onlyContainer(fixture).HostConfig.SecurityOpt = [];
    await expect(fixture.manager.stop(fixture.association)).rejects.toMatchObject({ code: "WORKSPACE_STATE_CONFLICT" });
    expect(onlyContainer(fixture).State.Running).toBe(true);
  });
});

describe("crash-safe Docker runtime creation", () => {
  test.each([
    ["after reserved is durable", phaseIs("reserved"), "after" as const],
    ["after network create before its ID is durable", phaseIs("network-created"), "before" as const],
    ["after network-created is durable", phaseIs("network-created"), "after" as const],
    ["after container create before its ID is durable", phaseIs("container-created"), "before" as const],
    ["after container-created is durable", phaseIs("container-created"), "after" as const]
  ])("recovers %s without duplicate resources", async (_name, match, timing) => {
    const fixture = await runtimeFixture(faultingWriter(match, timing));
    await expect(start(fixture)).rejects.toThrow("simulated-crash");
    restart(fixture);
    await expectSingleStack(fixture);
  });

  test("recovers an image pull failure using the exact operation-owned network", async () => {
    const fixture = await runtimeFixture(); fixture.engine.imageFailures = 1;
    await expect(start(fixture)).rejects.toBeDefined();
    expect(fixture.engine.networks).toHaveLength(1); expect(fixture.engine.containers).toHaveLength(0);
    restart(fixture); await expectSingleStack(fixture);
  });

  test("startup validation and inspection recognize exact incomplete creation evidence without adoption", async () => {
    const fixture = await runtimeFixture(); fixture.engine.imageFailures = 1;
    await expect(start(fixture)).rejects.toBeDefined();
    restart(fixture);
    await expect(fixture.manager.validateStateTree()).resolves.toBeUndefined();
    await expect(fixture.manager.inspect(fixture.association)).resolves.toMatchObject({ observedState: "starting" });
    await expectSingleStack(fixture);
  });

  test("startup accepts only creation evidence bound to the exact durable start operation", async () => {
    const fixture = await runtimeFixture(faultingWriter(phaseIs("reserved"), "after"));
    await expect(start(fixture)).rejects.toThrow("simulated-crash");
    await expect(fixture.manager.validateCreationJournalBindings((id) => id === operationId
      ? { operationName: "workspace.start", request: { projectId: fixture.association.projectId, workspaceId: fixture.association.workspaceId } }
      : undefined)).resolves.toBeUndefined();
    await expect(fixture.manager.validateCreationJournalBindings(() => ({ operationName: "workspace.start",
      request: { projectId: fixture.association.projectId, workspaceId: "018f1f34-7000-7000-8000-000000000099" } })))
      .rejects.toThrow("not-bound");
  });

  test("recovers a container-create failure using the exact operation-owned network", async () => {
    const fixture = await runtimeFixture(); fixture.engine.containerCreateFailures = 1;
    await expect(start(fixture)).rejects.toMatchObject({ code: "WORKSPACE_STATE_CONFLICT" });
    expect(fixture.engine.networks).toHaveLength(1); expect(fixture.engine.containers).toHaveLength(0);
    restart(fixture); await expectSingleStack(fixture);
  });

  test("distinguishes an active start from a failed recoverable creation across restart and retry", async () => {
    const fixture = await runtimeFixture();
    let originalState: "running" | "failed" = "running";
    const findOperation = (id: string) => id === operationId ? {
      operationName: "workspace.start", state: originalState,
      request: { projectId: fixture.association.projectId, workspaceId: fixture.association.workspaceId }
    } : undefined;
    await fixture.manager.validateCreationJournalBindings(findOperation);
    fixture.engine.containerCreateFailures = 1;
    await expect(start(fixture)).rejects.toMatchObject({ code: "WORKSPACE_STATE_CONFLICT" });
    expect(fixture.engine.networks).toHaveLength(1); expect(fixture.engine.containers).toHaveLength(0);
    await expect(fixture.manager.inspect(fixture.association)).resolves.toMatchObject({ observedState: "starting" });

    originalState = "failed";
    await expect(fixture.manager.inspect(fixture.association)).resolves.toMatchObject({ observedState: "stopped" });
    restart(fixture);
    await fixture.manager.validateCreationJournalBindings(findOperation);
    await expect(fixture.manager.inspect(fixture.association)).resolves.toMatchObject({ observedState: "stopped" });

    const retryOperationId = "018f1f34-7000-7000-8000-000000000013";
    await expect(start(fixture, retryOperationId)).resolves.toMatchObject({ observedState: "running" });
    expect(fixture.engine.networkCreates).toBe(1); expect(fixture.engine.containerCreates).toBe(1);
    expect(onlyContainer(fixture).Config.Labels["devspace.creation-operation-id"]).toBe(operationId);
  });

  test("recovers when authoritative ownership committed before the creation phase transition", async () => {
    const writer = faultingWriter((file) => file.includes("ownership/runtimes/"), "after");
    const fixture = await runtimeFixture(writer);
    await expect(start(fixture)).rejects.toThrow("simulated-crash-after-durable-write");
    expect(fixture.engine.networks).toHaveLength(1); expect(fixture.engine.containers).toHaveLength(1);
    restart(fixture);
    await expect(fixture.manager.inspect(fixture.association)).resolves.toMatchObject({ observedState: "stopped" });
    const reconciled = runtimeCreationSchema.parse(JSON.parse(await readFile(
      path.join(fixture.root, "state/runtime-creations", `${fixture.association.workspaceId}.json`), "utf8")) as unknown);
    expect(reconciled.phase).toBe("ownership-committed");
    await expectSingleStack(fixture);
  });

  test("rejects an unrelated same-name network during reserved recovery", async () => {
    const fixture = await runtimeFixture(faultingWriter(phaseIs("reserved"), "after"));
    await expect(start(fixture)).rejects.toThrow("simulated-crash");
    const name = `devspace-${fixture.association.workspaceId.replaceAll("-", "")}-g1-network`;
    fixture.engine.networks.set("foreign-network", { Id: "foreign-network", Name: name, Labels: { foreign: "true" } });
    fixture.engine.names.add(name); restart(fixture);
    await expect(start(fixture)).rejects.toMatchObject({ code: "WORKSPACE_STATE_CONFLICT" });
  });

  test("rejects an unrelated same-name container during recovery", async () => {
    const fixture = await runtimeFixture(); fixture.engine.imageFailures = 1;
    await expect(start(fixture)).rejects.toBeDefined();
    const network = [...fixture.engine.networks.values()][0]!;
    const name = `devspace-${fixture.association.workspaceId.replaceAll("-", "")}-g1-development`;
    fixture.engine.containers.set("foreign-container", { Id: "foreign-container", Name: `/${name}`,
      Config: { Labels: { foreign: "true" }, WorkingDir: "/workspace" }, State: { Running: false, Status: "created" },
      HostConfig: { Privileged: false, PublishAllPorts: false, PidMode: "", IpcMode: "private",
        UTSMode: "", UsernsMode: "", CgroupnsMode: "private", NetworkMode: network.Name,
        PortBindings: {}, Devices: [], NanoCpus: 2_000_000_000, Memory: 1024 * 1024 * 1024, PidsLimit: 256,
        CapAdd: [], CapDrop: [], SecurityOpt: ["no-new-privileges:true"], AutoRemove: false, ReadonlyRootfs: false,
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 } },
      NetworkSettings: { Networks: { [network.Name]: { NetworkID: network.Id } } },
      Mounts: [{ Type: "bind", Source: fixture.worktree, Destination: "/workspace", RW: true, Propagation: "rprivate" }] });
    fixture.engine.names.add(name); restart(fixture);
    await expect(start(fixture)).rejects.toMatchObject({ code: "WORKSPACE_STATE_CONFLICT" });
  });

  test("rejects an exact recorded network whose labels drift", async () => {
    const fixture = await runtimeFixture(); fixture.engine.imageFailures = 1;
    await expect(start(fixture)).rejects.toBeDefined();
    [...fixture.engine.networks.values()][0]!.Labels["devspace.runtime-generation"] = "2";
    restart(fixture);
    await expect(start(fixture)).rejects.toMatchObject({ code: "WORKSPACE_STATE_CONFLICT" });
  });
});

describe("bounded development-container stabilization", () => {
  test("succeeds only after continuous exact running observations span the window", async () => {
    const fixture = await runtimeFixture();
    await expect(start(fixture)).resolves.toMatchObject({ observedState: "running" });
    expect(fixture.lifecycle.current).toBe(fixture.policy.stabilizationDurationMs);
    expect(fixture.engine.runningInspections).toBe(4);
  });

  test.each([
    ["exits immediately", 1],
    ["exits after one successful inspection", 2],
    ["cannot execute the fixed keepalive", 1]
  ])("fails when the container %s", async (_name, exitAt) => {
    const fixture = await runtimeFixture();
    fixture.engine.onRunningInspect = (inspection, container) => {
      if (inspection === exitAt) container.State = { Running: false, Status: "exited" };
    };
    await expect(start(fixture)).rejects.toThrow("exited during lifecycle stabilization");
  });

  test("fails truthfully when the container becomes unavailable during stabilization", async () => {
    const fixture = await runtimeFixture();
    fixture.engine.onRunningInspect = (inspection, container) => {
      if (inspection === 2) fixture.engine.containers.delete(container.Id);
    };
    await expect(start(fixture)).rejects.toMatchObject({ code: "WORKSPACE_STATE_CONFLICT" });
  });

  test("fails when effective configuration drifts during stabilization", async () => {
    const fixture = await runtimeFixture();
    fixture.engine.onRunningInspect = (inspection, container) => {
      if (inspection === 2) container.HostConfig.Memory += 1;
    };
    await expect(start(fixture)).rejects.toMatchObject({ code: "WORKSPACE_STATE_CONFLICT" });
  });

  test("classifies pre-slice, exact, and mismatched harness slot mounts", () => {
    const worktree = "/srv/worktree";
    const slot = "/agent/harness-slots/ws";
    const workspaceMount = { Type: "bind", Source: worktree, Destination: "/workspace", RW: true, Propagation: "rprivate" };
    expect(classifyHarnessSlotMount({
      mounts: [workspaceMount], worktreePath: worktree, slotHostPath: slot
    })).toEqual({ state: "missing" });
    expect(classifyHarnessSlotMount({
      mounts: [
        workspaceMount,
        { Type: "bind", Source: slot, Destination: "/opt/devspace/harness-home", RW: true, Propagation: "rprivate" }
      ],
      worktreePath: worktree, slotHostPath: slot
    })).toEqual({ state: "present-and-exact" });
    expect(classifyHarnessSlotMount({
      mounts: [
        workspaceMount,
        { Type: "bind", Source: "/wrong", Destination: "/opt/devspace/harness-home", RW: true, Propagation: "rprivate" }
      ],
      worktreePath: worktree, slotHostPath: slot
    })).toEqual({ state: "mismatch" });
  });

  const unrelatedOperationId = "018f1f34-7000-7000-8000-0000000000b0";

  function originalStart(fixture: Awaited<ReturnType<typeof runtimeFixture>>) {
    return (id: string) => id === operationId ? {
      operationName: "workspace.start",
      request: { projectId: fixture.association.projectId, workspaceId: fixture.association.workspaceId }
    } : undefined;
  }

  async function preSliceRuntime(fixture: Awaited<ReturnType<typeof runtimeFixture>>) {
    await start(fixture);
    await fixture.manager.validateCreationJournalBindings(originalStart(fixture));
    const container = onlyContainer(fixture);
    const networkId = Object.values(container.NetworkSettings.Networks ?? {})[0]?.NetworkID;
    if (networkId === undefined) throw new Error("network missing");
    const networkLabels = { ...fixture.engine.networks.get(networkId)!.Labels };
    fixture.engine.containers.set(container.Id, {
      ...container,
      Mounts: container.Mounts.filter((mount) => mount.Destination === "/workspace")
    });
    const sidecarId = "sidecar-preserved";
    fixture.engine.containers.set(sidecarId, {
      ...container,
      Id: sidecarId,
      Name: "/devspace-sidecar",
      Mounts: []
    });
    fixture.engine.names.add("devspace-sidecar");
    return { container, networkId, networkLabels, sidecarId };
  }

  test("replaces only the development container and keeps the original creation operation", async () => {
    const fixture = await runtimeFixture();
    const before = await preSliceRuntime(fixture);
    await expect(fixture.manager.recreateIfSlotMissing(
      fixture.association, fixture.plan, fixture.worktree, [], originalStart(fixture)
    )).resolves.toEqual({ state: "present-and-exact" });
    expect(fixture.engine.networkCreates).toBe(1);
    expect(fixture.engine.networks.get(before.networkId)?.Labels).toEqual(before.networkLabels);
    expect(before.networkLabels["devspace.creation-operation-id"]).toBe(operationId);
    expect(fixture.engine.removedContainerIds).toEqual([before.container.Id]);
    expect(fixture.engine.containers.has(before.sidecarId)).toBe(true);
    expect(fixture.engine.containers.has(before.container.Id)).toBe(false);
    const creation = runtimeCreationSchema.parse(JSON.parse(await readFile(
      path.join(fixture.root, "state/runtime-creations", `${fixture.association.workspaceId}.json`), "utf8")) as unknown);
    expect(creation.operationId).toBe(operationId);
    expect(creation.phase).toBe("ownership-committed");
    expect(creation.networkId).toBe(before.networkId);
    expect(creation.containerId).not.toBe(before.container.Id);
    const ownership = runtimeOwnershipSchema.parse(JSON.parse(await readFile(
      path.join(fixture.root, "state/ownership/runtimes", `${fixture.association.workspaceId}.json`), "utf8")) as unknown);
    expect(ownership.developmentContainer.id).toBe(creation.containerId);
    expect(ownership.developmentContainer.labels["devspace.creation-operation-id"]).toBe(operationId);
    expect(ownership.network.labels).toEqual(before.networkLabels);
    await expect(fixture.manager.validateCreationJournalBindings(originalStart(fixture))).resolves.toBeUndefined();
    await expect(fixture.manager.validateCreationJournalBindings(() => undefined)).rejects.toThrow(/not-bound-to-its-durable-operation/u);
    const replacement = [...fixture.engine.containers.values()].find((item) => item.Id === creation.containerId);
    expect(replacement?.Mounts.map((mount) => mount.Destination).sort()).toEqual(["/opt/devspace/harness-home", "/workspace"]);
    expect(replacement?.HostConfig.NetworkMode).toBe(before.networkLabels ? ownership.network.name : ownership.network.name);
  });

  test.each([
    ["planned", "before the old container is removed"],
    ["previous-removed", "after the old container is removed"],
    ["replacement-created", "after the replacement exists but before ownership commit"]
  ] as const)("retries slot replacement interrupted %s", async (phase, _description) => {
    const fixture = await runtimeFixture(faultingWriter(
      (file, value) => file.includes("harness-slot-replacements") && (value as { phase?: string }).phase === phase,
      "after"
    ));
    await preSliceRuntime(fixture);
    const beforeNetworks = fixture.engine.networkCreates;
    await expect(fixture.manager.recreateIfSlotMissing(
      fixture.association, fixture.plan, fixture.worktree, [], originalStart(fixture)
    )).rejects.toThrow(/simulated-crash-after-durable-write/u);
    expect(fixture.engine.networkCreates).toBe(beforeNetworks);
    restart(fixture);
    await fixture.manager.validateCreationJournalBindings(originalStart(fixture));
    await expect(fixture.manager.recreateIfSlotMissing(
      fixture.association, fixture.plan, fixture.worktree, [], originalStart(fixture)
    )).resolves.toEqual({ state: "present-and-exact" });
    expect(fixture.engine.networkCreates).toBe(1);
    expect(fixture.engine.containers.size).toBe(2);
  });

  test("does not adopt a foreign container that reuses the development name", async () => {
    const fixture = await runtimeFixture();
    const before = await preSliceRuntime(fixture);
    const devName = before.container.Name.replace(/^\//u, "");
    fixture.engine.containers.delete(before.container.Id);
    fixture.engine.names.delete(devName);
    fixture.engine.containers.set("foreign", {
      ...before.container,
      Id: "foreign",
      Name: `/${devName}`,
      Config: { ...before.container.Config, Labels: { ...before.container.Config.Labels, "devspace.creation-operation-id": unrelatedOperationId } },
      Mounts: before.container.Mounts
    });
    fixture.engine.names.add(devName);
    const replacement = {
      version: 1, ...fixture.association, worktreePath: path.resolve(fixture.worktree),
      resources: { cpuMillicores: 2000, memoryBytes: 1024 * 1024 * 1024, pidLimit: 256 },
      previewBindings: [], originalOperationId: operationId, networkId: before.networkId,
      networkName: `devspace-${fixture.association.workspaceId.replaceAll("-", "")}-g1-network`,
      previousContainerId: null, replacementContainerId: null, phase: "previous-removed"
    };
    await mkdir(path.join(fixture.root, "state/harness-slot-replacements"), { recursive: true });
    await writeFile(path.join(fixture.root, "state/harness-slot-replacements", `${fixture.association.workspaceId}.json`),
      `${JSON.stringify(replacement)}\n`);
    await expect(fixture.manager.recreateIfSlotMissing(
      fixture.association, fixture.plan, fixture.worktree, [], originalStart(fixture)
    )).rejects.toMatchObject({ code: "WORKSPACE_STATE_CONFLICT" });
    expect(fixture.engine.containers.has("foreign")).toBe(true);
    expect(fixture.engine.networkCreates).toBe(1);
    expect(fixture.engine.networks.get(before.networkId)?.Labels).toEqual(before.networkLabels);
  });

  test("recovers the stranded acceptance state onto the original creation operation", async () => {
    const fixture = await runtimeFixture();
    const before = await preSliceRuntime(fixture);
    await rm(path.join(fixture.root, "state/ownership/runtimes", `${fixture.association.workspaceId}.json`));
    fixture.engine.containers.delete(before.container.Id);
    fixture.engine.names.delete(before.container.Name.replace(/^\//u, ""));
    const creation = runtimeCreationSchema.parse(JSON.parse(await readFile(
      path.join(fixture.root, "state/runtime-creations", `${fixture.association.workspaceId}.json`), "utf8")) as unknown);
    await writeFile(path.join(fixture.root, "state/runtime-creations", `${fixture.association.workspaceId}.json`),
      `${JSON.stringify({ ...creation, operationId: unrelatedOperationId, networkId: null, containerId: null, phase: "reserved" })}\n`);
    await expect(fixture.manager.recreateIfSlotMissing(
      fixture.association, fixture.plan, fixture.worktree, [], originalStart(fixture)
    )).resolves.toEqual({ state: "present-and-exact" });
    const recovered = runtimeCreationSchema.parse(JSON.parse(await readFile(
      path.join(fixture.root, "state/runtime-creations", `${fixture.association.workspaceId}.json`), "utf8")) as unknown);
    expect(recovered.operationId).toBe(operationId);
    expect(recovered.networkId).toBe(before.networkId);
    expect(recovered.phase).toBe("ownership-committed");
    expect(fixture.engine.networkCreates).toBe(1);
    expect(fixture.engine.networks.get(before.networkId)?.Labels["devspace.creation-operation-id"]).toBe(operationId);
    await expect(fixture.manager.validateCreationJournalBindings(originalStart(fixture))).resolves.toBeUndefined();
    restart(fixture);
    await expect(fixture.manager.validateCreationJournalBindings(originalStart(fixture))).resolves.toBeUndefined();
  });

  test("new workspace containers receive the harness slot and inspect as present-and-exact", async () => {
    const fixture = await runtimeFixture();
    await expect(start(fixture)).resolves.toMatchObject({
      observedState: "running",
      harnessSlotMount: { state: "present-and-exact" }
    });
    expect(fixture.engine.lastContainerInput?.harnessSlotPath).toBe(
      path.join(fixture.root, "state", "harness-slots", fixture.association.workspaceId)
    );
    expect(onlyContainer(fixture).Mounts.map((mount) => mount.Destination).sort()).toEqual([
      "/opt/devspace/harness-home", "/workspace"
    ]);
  });
});
