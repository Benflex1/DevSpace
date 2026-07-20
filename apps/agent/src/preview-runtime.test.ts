import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  createApprovedPreviewBase, createApprovedPreviewBaseRegistry
} from "@devspace/security";
import { compileRuntimePlanV1, hashRuntimePlanV1, parseProjectOptionsV1 } from "@devspace/project-options";
import {
  DockerEngineClient, DockerEngineError, type DockerContainerInspection, type DockerListedContainer, type DockerNetworkInspection
} from "./docker-runtime.js";
import { PreviewRuntimeManager, type PreviewGatewayAdapter, type PreviewGatewayProbe, type PreviewGatewayProbeRequest,
  type PreviewGatewayProbeResult, type PreviewGatewayRoute } from "./preview-runtime.js";
import { WorkspaceRuntimeManager, type RuntimeAssociation } from "./workspace-runtime.js";

const ids = {
  projectId: "018f1f34-7000-7000-8000-000000000001",
  workspaceId: "018f1f34-7000-7000-8000-000000000002",
  revisionId: "018f1f34-7000-7000-8000-000000000003",
  previewId: "018f1f34-7000-7000-8000-000000000004",
  operationId: "018f1f34-7000-7000-8000-000000000005"
} as const;
const base = createApprovedPreviewBase("local", "preview.example.com");
if (!base.ok) throw new Error("preview base fixture is invalid");
const registry = createApprovedPreviewBaseRegistry([base.value]);
const approvedRegistry = registry.ok ? registry.value : (() => { throw new Error("preview registry fixture is invalid"); })();

const rawOptions = {
  schemaVersion: 1,
  developmentEnvironment: {
    source: { kind: "image", imageReference: "node:24-bookworm" },
    ports: [{ name: "web", containerPort: 3000 }]
  },
  previews: [{ key: "web", displayName: "Web", target: { kind: "workspace" }, containerPort: 3000,
    domainBaseId: "local", hostnamePattern: "{project}-{workspace}-{preview}-{shortId}",
    healthPath: "/health", healthStatuses: [200], startupTimeoutSeconds: 1, webSocketForwarding: true }]
};
const options = parseProjectOptionsV1(rawOptions);
const plan = compileRuntimePlanV1(options);
const association: RuntimeAssociation = { projectId: ids.projectId, workspaceId: ids.workspaceId, revisionId: ids.revisionId,
  revisionHash: `sha256-jcs-v1:${"1".repeat(64)}`,
  runtimePlanHash: hashRuntimePlanV1(plan), generation: 1 };
const activation = {
  ...ids,
  revisionId: ids.revisionId,
  previewKey: "web",
  hostname: "project-workspace-web-018f1f34.preview.example.com",
  projectSlug: "project",
  workspaceSlug: "workspace"
} as const;

class FakeEngine extends DockerEngineClient {
  readonly networks = new Map<string, DockerNetworkInspection>();
  readonly containers = new Map<string, DockerContainerInspection>();
  private networkNumber = 0;
  private containerNumber = 0;
  createCalls = 0;
  constructor() { super("/fixture/rootless.sock"); }
  override assertRootlessAvailable(): Promise<void> { return Promise.resolve(); }
  override listContainers(): Promise<readonly DockerListedContainer[]> {
    return Promise.resolve([...this.containers.values()].map((container) => ({ Id: container.Id, Names: [container.Name],
      Labels: container.Config.Labels, State: container.State.Status, Status: container.State.Status })));
  }
  override createNetwork(name: string, labels: Record<string, string>): Promise<string> {
    const id = `network-${++this.networkNumber}`;
    this.networks.set(id, { Id: id, Name: name, Labels: { ...labels } });
    return Promise.resolve(id);
  }
  override inspectNetwork(id: string): Promise<DockerNetworkInspection> {
    const network = this.networks.get(id) ?? [...this.networks.values()].find((candidate) => candidate.Name === id);
    return network === undefined ? Promise.reject(new DockerEngineError(404, "missing")) : Promise.resolve(network);
  }
  override ensureImage(): Promise<void> { return Promise.resolve(); }
  override createContainer(name: string, input: Parameters<DockerEngineClient["createContainer"]>[1]): Promise<string> {
    this.createCalls += 1;
    const network = [...this.networks.values()].find((candidate) => candidate.Name === input.networkName);
    if (network === undefined) return Promise.reject(new DockerEngineError(404, "network missing"));
    const id = `container-${++this.containerNumber}`;
    const portBindings = Object.fromEntries(Object.entries(input.portBindings ?? {}).map(([key, values]) => [key,
      values.map((value) => ({ HostIp: value.HostIp, HostPort: value.HostPort }))]));
    this.containers.set(id, { Id: id, Name: `/${name}`, Config: { Labels: { ...input.labels }, WorkingDir: "/workspace" },
      State: { Running: false, Status: "created" }, HostConfig: { Privileged: false, PublishAllPorts: false,
        PidMode: "", IpcMode: "private", UTSMode: "", UsernsMode: "", CgroupnsMode: "private",
        NetworkMode: input.networkName, PortBindings: portBindings, Devices: [], NanoCpus: input.cpuMillicores * 1_000_000,
        Memory: input.memoryBytes, PidsLimit: input.pidLimit, CapAdd: [], CapDrop: [], SecurityOpt: ["no-new-privileges:true"],
        AutoRemove: false, ReadonlyRootfs: false, RestartPolicy: { Name: "no", MaximumRetryCount: 0 } },
      NetworkSettings: { Networks: { [input.networkName]: { NetworkID: "" } } },
      Mounts: [{ Type: "bind", Source: input.worktreePath, Destination: "/workspace", RW: true, Propagation: "rprivate" }] });
    return Promise.resolve(id);
  }
  override inspectContainer(id: string): Promise<DockerContainerInspection> {
    const container = this.containers.get(id) ?? [...this.containers.values()].find((candidate) => candidate.Name.replace(/^\//u, "") === id);
    return container === undefined ? Promise.reject(new DockerEngineError(404, "missing")) : Promise.resolve(container);
  }
  override startContainer(id: string): Promise<void> {
    const container = this.containers.get(id); if (container === undefined) return Promise.reject(new DockerEngineError(404, "missing"));
    const networkName = container.HostConfig.NetworkMode;
    const network = [...this.networks.values()].find((candidate) => candidate.Name === networkName)!;
    container.State = { Running: true, Status: "running" };
    container.NetworkSettings.Networks = { [networkName]: { NetworkID: network.Id } };
    return Promise.resolve();
  }
  override stopContainer(id: string): Promise<void> {
    const container = this.containers.get(id); if (container === undefined) return Promise.reject(new DockerEngineError(404, "missing"));
    container.State = { Running: false, Status: "exited" }; return Promise.resolve();
  }
}

class Probe implements PreviewGatewayProbe {
  readonly requests: PreviewGatewayProbeRequest[] = [];
  constructor(private readonly results: PreviewGatewayProbeResult[]) {}
  async probe(input: PreviewGatewayProbeRequest): Promise<PreviewGatewayProbeResult> {
    this.requests.push(input);
    return this.results.shift() ?? { kind: "response", statusCode: 200 };
  }
}

class Gateway implements PreviewGatewayAdapter {
  readonly routes: PreviewGatewayRoute[] = [];
  async probe(_input: PreviewGatewayProbeRequest): Promise<PreviewGatewayProbeResult> {
    return { kind: "response", statusCode: 200 };
  }
  async ensureRoute(route: PreviewGatewayRoute): Promise<void> {
    this.routes.splice(0, this.routes.length, ...this.routes.filter((candidate) => candidate.hostname !== route.hostname), route);
  }
  async replaceRoute(route: PreviewGatewayRoute): Promise<void> { await this.ensureRoute(route); }
  async removeRoute(route: PreviewGatewayRoute): Promise<void> {
    const retained = this.routes.filter((candidate) => candidate.hostname !== route.hostname);
    this.routes.splice(0, this.routes.length, ...retained);
  }
  async inspectRoute(route: PreviewGatewayRoute): Promise<{ present: boolean; status: "present" | "absent"; route?: PreviewGatewayRoute }> {
    const current = this.routes.find((candidate) => candidate.hostname === route.hostname);
    return current === undefined ? { present: false, status: "absent" } : { present: true, status: "present", route: current };
  }
  async reconcileRoutes(routes: readonly PreviewGatewayRoute[]): Promise<void> {
    this.routes.splice(0, this.routes.length, ...routes);
  }
}

async function fixture(probe: PreviewGatewayProbe = new Probe([{ kind: "response", statusCode: 200 }]), gateway: Gateway | null = null) {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-runtime-"));
  const state = path.join(root, "state");
  await mkdir(path.join(state, "ownership", "runtimes"), { recursive: true });
  await mkdir(path.join(state, "runtime-creations"), { recursive: true });
  const worktree = path.join(root, "worktree"); await mkdir(worktree);
  const engine = new FakeEngine();
  let runtimeTime = 0;
  const runtime = new WorkspaceRuntimeManager(state, engine, {
    cpuMillicores: 2_000, memoryBytes: 1024 * 1024 * 1024, pidLimit: 256,
    stabilizationDurationMs: 1, stabilizationIntervalMs: 1, stabilizationTimeoutMs: 10
  }, undefined, { now: () => runtimeTime, sleep: async (milliseconds) => { runtimeTime += milliseconds; } });
  const clock = { value: 0, now(): number { return this.value; } };
  const manager = new PreviewRuntimeManager(state, engine, runtime, approvedRegistry, undefined, probe, uuidv7, clock,
    { firstPort: 40_000, lastPort: 40_001 }, gateway);
  await manager.initialize();
  const bindings = await manager.reserveWorkspaceLeases(association, options, ids.operationId);
  await runtime.start(association, plan, worktree, ids.operationId, bindings);
  const ownership = await runtime.exactRunningOwnership(association);
  await manager.bindRuntimeContainer(association, ownership.developmentContainer.id, bindings);
  return { root, state, engine, runtime, manager, bindings, clock, worktree };
}

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

describe("Agent preview runtime policy", () => {
  test("keeps a running workspace with no application listener in the health-waiting state", async () => {
    const probe = new Probe([{ kind: "response", statusCode: 503 }]);
    const fixtureValue = await fixture(probe); cleanup.push(fixtureValue.root);
    await fixtureValue.manager.activate(activation, association, options, ids.operationId);
    const inspection = await fixtureValue.manager.inspect({ ...ids });
    expect(inspection.observedState).toBe("unhealthy");
    expect(inspection.routePresent).toBe(false);
    expect(inspection.hostname).toBe(activation.hostname);
  });

  test("classifies an exact loopback target with no listener as Waiting, not infrastructure loss", async () => {
    const probe = new Probe([{ kind: "infrastructure", message: "The loopback preview target is unavailable." }]);
    const fixtureValue = await fixture(probe); cleanup.push(fixtureValue.root);
    await fixtureValue.manager.activate(activation, association, options, ids.operationId);
    await expect(fixtureValue.manager.inspect({ ...ids })).resolves.toMatchObject({ observedState: "unhealthy", routePresent: false });
  });

  test("accepts configured status codes and preserves WebSocket probe metadata", async () => {
    const probe = new Probe([{ kind: "response", statusCode: 200 }]);
    const fixtureValue = await fixture(probe); cleanup.push(fixtureValue.root);
    await fixtureValue.manager.activate(activation, association, options, ids.operationId);
    await expect(fixtureValue.manager.inspect({ ...ids })).resolves.toMatchObject({ observedState: "healthy", routePresent: false });
    expect(probe.requests[0]).toMatchObject({ leaseId: fixtureValue.bindings[0]!.leaseId, path: "/health", webSocketForwarding: true });
    expect(probe.requests[0]).not.toHaveProperty("host");
    expect(probe.requests[0]).not.toHaveProperty("port");
  });

  test("does not retry before the bounded backoff and can become healthy on a later attempt", async () => {
    const probe = new Probe([{ kind: "response", statusCode: 503 }, { kind: "response", statusCode: 200 }]);
    const fixtureValue = await fixture(probe); cleanup.push(fixtureValue.root);
    await fixtureValue.manager.activate(activation, association, options, ids.operationId);
    await fixtureValue.manager.inspect({ ...ids });
    expect(probe.requests).toHaveLength(1);
    fixtureValue.clock.value = 251;
    await expect(fixtureValue.manager.inspect({ ...ids })).resolves.toMatchObject({ observedState: "healthy" });
    expect(probe.requests).toHaveLength(2);
  });

  test("bounds one health attempt by startupTimeoutSeconds", async () => {
    const probe: PreviewGatewayProbe = { probe: async () => await new Promise<PreviewGatewayProbeResult>(() => undefined) };
    const fixtureValue = await fixture(probe); cleanup.push(fixtureValue.root);
    const started = Date.now();
    await fixtureValue.manager.activate(activation, association, options, ids.operationId);
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(fixtureValue.manager.inspect({ ...ids })).resolves.toMatchObject({ observedState: "unhealthy" });
  });

  test("rejects service targets before any Docker or probe side effect", async () => {
    const probe = new Probe([]);
    const fixtureValue = await fixture(probe); cleanup.push(fixtureValue.root);
    const serviceOptions = parseProjectOptionsV1({ ...rawOptions,
      services: [{ key: "api", imageReference: "node:24", ports: [{ name: "http", containerPort: 4000 }] }],
      previews: [{ ...rawOptions.previews[0]!, target: { kind: "service", serviceKey: "api" }, containerPort: 4000 }]
    });
    await expect(fixtureValue.manager.activate(activation, association, serviceOptions, ids.operationId))
      .rejects.toMatchObject({ code: "RUNTIME_POLICY_VIOLATION", message: expect.stringContaining("unsupported-runtime-policy") });
    expect(fixtureValue.engine.createCalls).toBe(1);
    expect(probe.requests).toHaveLength(0);
  });

  test("retains a stopped container lease and releases it only after exact removal", async () => {
    const fixtureValue = await fixture(); cleanup.push(fixtureValue.root);
    const firstPort = fixtureValue.bindings[0]!.hostPort;
    await fixtureValue.runtime.stop(association);
    await fixtureValue.manager.workspaceStopped(association);
    const secondAssociation = { ...association, workspaceId: "018f1f34-7000-7000-8000-000000000006" };
    const second = await fixtureValue.manager.reserveWorkspaceLeases(secondAssociation, options, "018f1f34-7000-7000-8000-000000000007");
    expect(second[0]!.hostPort).not.toBe(firstPort);
    fixtureValue.engine.containers.clear();
    await expect(fixtureValue.manager.leases.releaseIfContainerRemoved(fixtureValue.bindings[0]!.leaseId)).resolves.toBe(true);
    const thirdAssociation = { ...association, workspaceId: "018f1f34-7000-7000-8000-000000000008" };
    const third = await fixtureValue.manager.reserveWorkspaceLeases(thirdAssociation, options, "018f1f34-7000-7000-8000-000000000009");
    expect(third[0]!.hostPort).toBe(firstPort);
  });

  test("intentional runtime stop removes route eligibility without recording unexplained runtime loss", async () => {
    const gateway = new Gateway();
    const fixtureValue = await fixture(undefined, gateway); cleanup.push(fixtureValue.root);
    await fixtureValue.manager.activate(activation, association, options, ids.operationId);
    expect(gateway.routes).toHaveLength(1);
    await fixtureValue.runtime.stop(association);
    await fixtureValue.manager.workspaceStopped(association);
    expect(gateway.routes).toEqual([]);
    expect((await fixtureValue.manager.snapshotResources())[0]).toMatchObject({
      type: "preview", observation: { desiredState: "active", observedState: "inactive", routePresent: false }
    });
  });

  test("Agent restart reconstructs only the exact desired route and rejects a stale generation", async () => {
    const gateway = new Gateway();
    const fixtureValue = await fixture(undefined, gateway); cleanup.push(fixtureValue.root);
    await fixtureValue.manager.activate(activation, association, options, ids.operationId);
    const expected = gateway.routes[0];
    expect(expected).toBeDefined();
    gateway.routes.splice(0, gateway.routes.length, { ...expected!, hostPort: expected!.hostPort + 1 });
    const restarted = new PreviewRuntimeManager(fixtureValue.state, fixtureValue.engine, fixtureValue.runtime, approvedRegistry,
      undefined, new Probe([{ kind: "response", statusCode: 200 }]), uuidv7, fixtureValue.clock,
      { firstPort: 40_000, lastPort: 40_001 }, gateway);
    await restarted.initialize();
    await restarted.reconcileRoutes();
    expect(gateway.routes).toEqual([expected]);
    const container = [...fixtureValue.engine.containers.values()][0]!;
    container.Config.Labels["devspace.runtime-generation"] = "2";
    await restarted.reconcileRoutes();
    expect(gateway.routes).toEqual([]);
  });

  test("loses route eligibility when the exact runtime generation drifts", async () => {
    const fixtureValue = await fixture(); cleanup.push(fixtureValue.root);
    await fixtureValue.manager.activate(activation, association, options, ids.operationId);
    const container = [...fixtureValue.engine.containers.values()][0]!;
    container.Config.Labels["devspace.runtime-generation"] = "2";
    fixtureValue.clock.value = 251;
    await expect(fixtureValue.manager.inspect({ ...ids })).resolves.toMatchObject({ observedState: "lost", routePresent: false });
  });

  test("rejects a hostname that is arbitrary or inconsistent with the exact revision", async () => {
    const fixtureValue = await fixture(); cleanup.push(fixtureValue.root);
    await expect(fixtureValue.manager.activate({ ...activation, hostname: "arbitrary.example.net" }, association, options, ids.operationId))
      .rejects.toMatchObject({ code: "PREVIEW_DOMAIN_NOT_APPROVED" });
    await expect(fixtureValue.manager.activate({ ...activation, projectSlug: "other" }, association, options, ids.operationId))
      .rejects.toMatchObject({ code: "PREVIEW_DOMAIN_NOT_APPROVED" });
  });

  test("rejects a stale preview revision before creating preview state", async () => {
    const fixtureValue = await fixture(); cleanup.push(fixtureValue.root);
    await expect(fixtureValue.manager.activate({ ...activation, revisionId: "018f1f34-7000-7000-8000-000000000006" }, association, options, ids.operationId))
      .rejects.toMatchObject({ code: "WORKSPACE_STATE_CONFLICT" });
  });
});
