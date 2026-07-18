import { readdir } from "node:fs/promises";
import path from "node:path";
import * as z from "zod";
import { projectOptionsRevisionHashSchema, uuidV7Schema } from "@devspace/contracts";
import {
  canonicalizeRuntimePlanV1, compileRuntimePlanV1, hashRuntimePlanV1, parseRuntimePlanV1,
  type RuntimePlanV1
} from "@devspace/project-options";
import {
  DockerEngineClient, DockerEngineError, effectiveRuntimeResources, type RuntimePolicy
} from "./docker-runtime.js";
import { durableJsonWriter, readStrictJson, type AtomicJsonWriter } from "./private-state.js";

const dockerIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/u);
const dockerNameSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/u);
const labelsSchema = z.record(z.string(), z.string());
const absolutePathSchema = z.string().refine((value) => path.isAbsolute(value), "Expected an absolute path");

export const runtimeOwnershipSchema = z.strictObject({
  version: z.literal(1),
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  revisionId: uuidV7Schema,
  revisionHash: projectOptionsRevisionHashSchema,
  runtimePlanHash: projectOptionsRevisionHashSchema,
  generation: z.number().int().positive(),
  worktreePath: absolutePathSchema,
  resources: z.strictObject({ cpuMillicores: z.number().int().positive(), memoryBytes: z.number().int().positive(), pidLimit: z.number().int().positive() }),
  network: z.strictObject({ id: dockerIdSchema, name: dockerNameSchema, labels: labelsSchema }),
  developmentContainer: z.strictObject({ id: dockerIdSchema, name: dockerNameSchema, labels: labelsSchema })
});
export type RuntimeOwnership = z.infer<typeof runtimeOwnershipSchema>;

export const runtimeCreationSchema = z.strictObject({
  version: z.literal(1),
  operationId: uuidV7Schema,
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  revisionId: uuidV7Schema,
  revisionHash: projectOptionsRevisionHashSchema,
  runtimePlanHash: projectOptionsRevisionHashSchema,
  generation: z.number().int().positive(),
  worktreePath: absolutePathSchema,
  resources: z.strictObject({ cpuMillicores: z.number().int().positive(), memoryBytes: z.number().int().positive(), pidLimit: z.number().int().positive() }),
  networkName: dockerNameSchema,
  containerName: dockerNameSchema,
  networkId: dockerIdSchema.nullable(),
  containerId: dockerIdSchema.nullable(),
  phase: z.enum(["reserved", "network-created", "container-created", "ownership-committed"])
}).superRefine((record, context) => {
  const valid = record.phase === "reserved" ? record.networkId === null && record.containerId === null
    : record.phase === "network-created" ? record.networkId !== null && record.containerId === null
      : record.networkId !== null && record.containerId !== null;
  if (!valid) context.addIssue({ code: "custom", message: "Runtime creation phase and Docker IDs are inconsistent." });
});
export type RuntimeCreation = z.infer<typeof runtimeCreationSchema>;

export interface RuntimeAssociation {
  readonly projectId: string; readonly workspaceId: string; readonly revisionId: string;
  readonly revisionHash: string; readonly runtimePlanHash: string; readonly generation: number;
}
export interface RuntimeObservation {
  readonly observedState: "absent" | "starting" | "running" | "stopping" | "stopped" | "failed" | "lost";
  readonly serviceState: "absent" | "starting" | "running" | "stopping" | "stopped" | "failed" | "lost";
  readonly errorCode: string | null;
  readonly containerIdentity: string | null;
}

function suffix(id: string): string { return id.replaceAll("-", ""); }
function resourceNames(workspaceId: string, generation: number) {
  const opaque = suffix(workspaceId);
  return { network: `devspace-${opaque}-g${generation}-network`, container: `devspace-${opaque}-g${generation}-development` };
}
function labels(association: RuntimeAssociation, role: "network" | "development-container", operationId: string): Record<string, string> {
  return {
    "devspace.managed": "true", "devspace.project-id": association.projectId,
    "devspace.workspace-id": association.workspaceId, "devspace.revision-id": association.revisionId,
    "devspace.runtime-plan-hash": association.runtimePlanHash,
    "devspace.runtime-generation": String(association.generation), "devspace.resource-role": role,
    "devspace.creation-operation-id": uuidV7Schema.parse(operationId)
  };
}
function equalLabels(actual: Record<string, string>, expected: Record<string, string>): boolean {
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}
function associationMatches(record: RuntimeOwnership, expected: RuntimeAssociation): boolean {
  return record.projectId === expected.projectId && record.workspaceId === expected.workspaceId
    && record.revisionId === expected.revisionId && record.revisionHash === expected.revisionHash
    && record.runtimePlanHash === expected.runtimePlanHash && record.generation === expected.generation;
}

export class WorkspaceRuntimeError extends Error {
  constructor(readonly code: "ROOTLESS_RUNTIME_UNAVAILABLE" | "RUNTIME_POLICY_VIOLATION" | "WORKSPACE_STATE_CONFLICT", message: string) {
    super(message); this.name = "WorkspaceRuntimeError";
  }
}

export class WorkspaceRuntimeManager {
  private readonly ownershipRoot: string;
  private readonly creationRoot: string;
  private creationOperation: ((operationId: string) => {
    readonly operationName: string; readonly request: unknown;
    readonly state?: "accepted" | "running" | "succeeded" | "failed";
  } | undefined) | null = null;
  constructor(
    stateRoot: string,
    private readonly engine: DockerEngineClient,
    private readonly policy: RuntimePolicy,
    private readonly writer: AtomicJsonWriter = durableJsonWriter,
    private readonly lifecycle: { now(): number; sleep(milliseconds: number): Promise<void> } = {
      now: () => Date.now(), sleep: async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds))
    }
  ) {
    this.ownershipRoot = path.join(path.resolve(stateRoot), "ownership", "runtimes");
    this.creationRoot = path.join(path.resolve(stateRoot), "runtime-creations");
  }

  private ownershipPath(workspaceId: string): string {
    return path.join(this.ownershipRoot, `${uuidV7Schema.parse(workspaceId)}.json`);
  }
  private creationPath(workspaceId: string): string {
    return path.join(this.creationRoot, `${uuidV7Schema.parse(workspaceId)}.json`);
  }

  async validateStateTree(): Promise<void> {
    for (const name of await readdir(this.ownershipRoot)) {
      if (!name.endsWith(".json")) throw new Error("unexpected-runtime-ownership-entry");
      const record = await readStrictJson(path.join(this.ownershipRoot, name), runtimeOwnershipSchema);
      if (name !== `${record.workspaceId}.json`) throw new Error("runtime-ownership-filename-mismatch");
    }
    for (const name of await readdir(this.creationRoot)) {
      if (!name.endsWith(".json")) throw new Error("unexpected-runtime-creation-entry");
      const record = await readStrictJson(path.join(this.creationRoot, name), runtimeCreationSchema);
      if (name !== `${record.workspaceId}.json`) throw new Error("runtime-creation-filename-mismatch");
    }
  }

  async validateCreationJournalBindings(findOperation: (operationId: string) => {
    readonly operationName: string; readonly request: unknown;
    readonly state?: "accepted" | "running" | "succeeded" | "failed";
  } | undefined): Promise<void> {
    for (const name of await readdir(this.creationRoot)) {
      const record = await readStrictJson(path.join(this.creationRoot, name), runtimeCreationSchema);
      const operation = findOperation(record.operationId);
      if (name !== `${record.workspaceId}.json` || operation?.operationName !== "workspace.start"
        || JSON.stringify(operation.request) !== JSON.stringify({ projectId: record.projectId, workspaceId: record.workspaceId })) {
        throw new Error("runtime-creation-record-is-not-bound-to-its-durable-operation");
      }
    }
    this.creationOperation = findOperation;
  }

  async status(): Promise<"available" | "unavailable"> {
    try { await this.engine.assertRootlessAvailable(); return "available"; }
    catch { return "unavailable"; }
  }

  async exactRunningOwnership(expected: RuntimeAssociation): Promise<RuntimeOwnership> {
    const record = await this.load(expected.workspaceId);
    if (record === null || !associationMatches(record, expected)) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The exact Agent-owned workspace runtime is unavailable.");
    }
    const inspected = await this.inspectOwned(record);
    if (!inspected.running) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The exact Agent-owned development container is not running.");
    }
    return record;
  }

  private async load(workspaceId: string): Promise<RuntimeOwnership | null> {
    try { return await readStrictJson(this.ownershipPath(workspaceId), runtimeOwnershipSchema); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  private async loadCreation(workspaceId: string): Promise<RuntimeCreation | null> {
    try { return await readStrictJson(this.creationPath(workspaceId), runtimeCreationSchema); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  private async saveCreation(record: RuntimeCreation): Promise<void> {
    await this.writer.write(this.creationPath(record.workspaceId), runtimeCreationSchema.parse(record));
  }

  private validateNetwork(network: Awaited<ReturnType<DockerEngineClient["inspectNetwork"]>>,
    expected: { id?: string; name: string; labels: Record<string, string> }): void {
    if ((expected.id !== undefined && network.Id !== expected.id) || network.Name !== expected.name
      || !equalLabels(network.Labels ?? {}, expected.labels)) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The workspace network no longer matches exact Agent ownership.");
    }
  }

  private validateContainer(container: Awaited<ReturnType<DockerEngineClient["inspectContainer"]>>, record: RuntimeOwnership,
    networkIdentity: "materialized" | "operation-owned-pre-activation" = "materialized"): void {
    const devices = container.HostConfig.Devices ?? [];
    const portBindings = container.HostConfig.PortBindings ?? {};
    const capAdd = [...(container.HostConfig.CapAdd ?? [])].sort();
    const capDrop = [...(container.HostConfig.CapDrop ?? [])].sort();
    const securityOptions = [...(container.HostConfig.SecurityOpt ?? [])]
      .map((option) => option.replace(/^no-new-privileges[=:]true$/u, "no-new-privileges:true")).sort();
    const networks = container.NetworkSettings.Networks ?? {};
    const networkNames = Object.keys(networks);
    const attached = networks[record.network.name];
    const networkIdentityMatches = attached?.NetworkID === record.network.id
      || (networkIdentity === "operation-owned-pre-activation" && attached?.NetworkID === ""
        && container.State.Running === false && container.State.Status === "created");
    if (container.Id !== record.developmentContainer.id
      || container.Name.replace(/^\//u, "") !== record.developmentContainer.name
      || !equalLabels(container.Config.Labels ?? {}, record.developmentContainer.labels)
      || container.Config.WorkingDir !== "/workspace"
      || container.HostConfig.Privileged !== false || container.HostConfig.PublishAllPorts !== false
      || container.HostConfig.PidMode !== "" || container.HostConfig.IpcMode !== "private"
      || container.HostConfig.UTSMode !== "" || container.HostConfig.UsernsMode !== ""
      || container.HostConfig.CgroupnsMode !== "private"
      || container.HostConfig.AutoRemove !== false || container.HostConfig.ReadonlyRootfs !== false
      || container.HostConfig.RestartPolicy.Name !== "no" || container.HostConfig.RestartPolicy.MaximumRetryCount !== 0
      || container.HostConfig.NetworkMode !== record.network.name
      || networkNames.length !== 1 || networkNames[0] !== record.network.name || !networkIdentityMatches
      || Object.keys(portBindings).length !== 0 || devices.length !== 0
      || container.HostConfig.NanoCpus !== record.resources.cpuMillicores * 1_000_000
      || container.HostConfig.Memory !== record.resources.memoryBytes
      || container.HostConfig.PidsLimit !== record.resources.pidLimit
      || capAdd.length !== 0 || capDrop.length !== 0
      || JSON.stringify(securityOptions) !== JSON.stringify(["no-new-privileges:true"])
      || container.Mounts.length !== 1 || container.Mounts[0]?.Type !== "bind"
      || path.resolve(container.Mounts[0].Source) !== record.worktreePath
      || container.Mounts[0].Destination !== "/workspace" || container.Mounts[0].RW !== true
      || container.Mounts[0].Propagation !== "rprivate"
      || container.Mounts.some((mount) => mount.Source.includes("docker.sock") || mount.Destination.includes("docker.sock"))) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The retained development container no longer satisfies exact Agent ownership and runtime policy.");
    }
  }

  private async inspectOwned(record: RuntimeOwnership): Promise<{ running: boolean }> {
    return await this.inspectExact(record, "materialized");
  }

  private async inspectCreationOwned(creation: RuntimeCreation): Promise<{ running: boolean }> {
    return await this.inspectExact(this.ownershipFromCreation(creation), "operation-owned-pre-activation");
  }

  private async inspectExact(record: RuntimeOwnership,
    networkIdentity: "materialized" | "operation-owned-pre-activation"): Promise<{ running: boolean }> {
    try {
      const [network, container] = await Promise.all([
        this.engine.inspectNetwork(record.network.id), this.engine.inspectContainer(record.developmentContainer.id)
      ]);
      this.validateNetwork(network, record.network);
      this.validateContainer(container, record, networkIdentity);
      return { running: container.State.Running };
    } catch (error) {
      if (error instanceof WorkspaceRuntimeError) throw error;
      if (error instanceof DockerEngineError && error.statusCode === 404) {
        throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "An Agent-owned Docker runtime resource is missing.");
      }
      if (error instanceof DockerEngineError) throw error;
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "Docker inspection returned an invalid owned-resource representation.");
    }
  }

  private creationMatches(record: RuntimeCreation, association: RuntimeAssociation, worktreePath: string,
    resources: RuntimeOwnership["resources"], names: ReturnType<typeof resourceNames>): boolean {
    return record.projectId === association.projectId && record.workspaceId === association.workspaceId
      && record.revisionId === association.revisionId && record.revisionHash === association.revisionHash
      && record.runtimePlanHash === association.runtimePlanHash && record.generation === association.generation
      && record.worktreePath === path.resolve(worktreePath) && JSON.stringify(record.resources) === JSON.stringify(resources)
      && record.networkName === names.network && record.containerName === names.container;
  }

  private ownershipFromCreation(creation: RuntimeCreation): RuntimeOwnership {
    if (creation.networkId === null || creation.containerId === null) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "Runtime creation is not ready for ownership finalization.");
    }
    const association: RuntimeAssociation = creation;
    return runtimeOwnershipSchema.parse({ version: 1, projectId: creation.projectId, workspaceId: creation.workspaceId,
      revisionId: creation.revisionId, revisionHash: creation.revisionHash, runtimePlanHash: creation.runtimePlanHash,
      generation: creation.generation, worktreePath: creation.worktreePath, resources: creation.resources,
      network: { id: creation.networkId, name: creation.networkName, labels: labels(association, "network", creation.operationId) },
      developmentContainer: { id: creation.containerId, name: creation.containerName,
        labels: labels(association, "development-container", creation.operationId) } });
  }

  private async inspectOptionalNetwork(reference: string): Promise<Awaited<ReturnType<DockerEngineClient["inspectNetwork"]>> | null> {
    try { return await this.engine.inspectNetwork(reference); }
    catch (error) { if (error instanceof DockerEngineError && error.statusCode === 404) return null; throw error; }
  }

  private async inspectOptionalContainer(reference: string): Promise<Awaited<ReturnType<DockerEngineClient["inspectContainer"]>> | null> {
    try { return await this.engine.inspectContainer(reference); }
    catch (error) { if (error instanceof DockerEngineError && error.statusCode === 404) return null; throw error; }
  }

  private async recoverCreationEvidence(creationInput: RuntimeCreation): Promise<RuntimeCreation> {
    let creation = creationInput;
    const association: RuntimeAssociation = creation;
    const networkLabels = labels(association, "network", creation.operationId);
    const containerLabels = labels(association, "development-container", creation.operationId);
    if (creation.phase === "reserved") {
      const network = await this.inspectOptionalNetwork(creation.networkName);
      if (network !== null) {
        this.validateNetwork(network, { name: creation.networkName, labels: networkLabels });
        creation = runtimeCreationSchema.parse({ ...creation, networkId: network.Id, phase: "network-created" });
        await this.saveCreation(creation);
      }
    }
    if (creation.phase === "network-created") {
      const network = await this.inspectOptionalNetwork(creation.networkId!);
      if (network !== null) this.validateNetwork(network, { id: creation.networkId!, name: creation.networkName, labels: networkLabels });
      else if (await this.inspectOptionalNetwork(creation.networkName) !== null) {
        throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The operation-owned workspace network was replaced.");
      }
      const container = await this.inspectOptionalContainer(creation.containerName);
      if (container !== null) {
        if (network === null) throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "A development container exists without its exact operation-owned network.");
        const provisional = runtimeOwnershipSchema.parse({ ...this.ownershipFromCreation(runtimeCreationSchema.parse({
          ...creation, containerId: container.Id, phase: "container-created"
        })) });
        if (!equalLabels(container.Config.Labels ?? {}, containerLabels)) {
          throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The derived development container name is occupied by an unrelated resource.");
        }
        this.validateContainer(container, provisional, "operation-owned-pre-activation");
        creation = runtimeCreationSchema.parse({ ...creation, containerId: container.Id, phase: "container-created" });
        await this.saveCreation(creation);
      }
    }
    if (creation.phase === "container-created" || creation.phase === "ownership-committed") {
      await this.inspectCreationOwned(creation);
    }
    return creation;
  }

  private async stabilize(record: RuntimeOwnership): Promise<void> {
    const startedAt = this.lifecycle.now();
    const deadline = startedAt + this.policy.stabilizationTimeoutMs;
    let continuouslyRunningSince: number | null = null;
    for (;;) {
      const observation = await this.inspectOwned(record);
      const observedAt = this.lifecycle.now();
      if (!observation.running) {
        throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The development container exited during lifecycle stabilization.");
      }
      continuouslyRunningSince ??= observedAt;
      if (observedAt - continuouslyRunningSince >= this.policy.stabilizationDurationMs) return;
      if (observedAt >= deadline) {
        throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The development container did not stabilize before the runtime timeout.");
      }
      await this.lifecycle.sleep(Math.min(this.policy.stabilizationIntervalMs, deadline - observedAt));
    }
  }

  async inspect(association: RuntimeAssociation): Promise<RuntimeObservation> {
    const record = await this.load(association.workspaceId);
    if (record === null) {
      const creation = await this.loadCreation(association.workspaceId);
      if (creation === null) return { observedState: "absent", serviceState: "absent", errorCode: null, containerIdentity: null };
      if (creation.projectId !== association.projectId || creation.workspaceId !== association.workspaceId
        || creation.revisionId !== association.revisionId || creation.revisionHash !== association.revisionHash
        || creation.runtimePlanHash !== association.runtimePlanHash || creation.generation !== association.generation) {
        return { observedState: "lost", serviceState: "lost", errorCode: "WORKSPACE_STATE_CONFLICT", containerIdentity: null };
      }
      try {
        await this.engine.assertRootlessAvailable();
        const recovered = await this.recoverCreationEvidence(creation);
        const operationState = this.creationOperation?.(recovered.operationId)?.state;
        if (operationState === "failed") {
          return { observedState: "stopped", serviceState: "stopped", errorCode: null, containerIdentity: recovered.containerId };
        }
        if (operationState === "succeeded") {
          return { observedState: "lost", serviceState: "lost", errorCode: "WORKSPACE_STATE_CONFLICT", containerIdentity: null };
        }
        return { observedState: "starting", serviceState: "starting", errorCode: null, containerIdentity: recovered.containerId };
      } catch (error) {
        if (error instanceof WorkspaceRuntimeError) return { observedState: "lost", serviceState: "lost", errorCode: error.code, containerIdentity: null };
        return { observedState: "failed", serviceState: "failed", errorCode: "ROOTLESS_RUNTIME_UNAVAILABLE", containerIdentity: null };
      }
    }
    if (!associationMatches(record, association)) {
      return { observedState: "lost", serviceState: "lost", errorCode: "WORKSPACE_STATE_CONFLICT", containerIdentity: null };
    }
    try {
      await this.engine.assertRootlessAvailable();
      const creation = await this.loadCreation(association.workspaceId);
      let recoveredCreation: RuntimeCreation | null = null;
      if (creation !== null) {
        const names = resourceNames(association.workspaceId, association.generation);
        if (!this.creationMatches(creation, association, record.worktreePath, record.resources, names)) {
          throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "Runtime creation evidence conflicts with authoritative ownership.");
        }
        const recovered = await this.recoverCreationEvidence(creation);
        recoveredCreation = recovered;
        if (recovered.networkId !== record.network.id || recovered.containerId !== record.developmentContainer.id) {
          throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "Runtime creation Docker IDs conflict with authoritative ownership.");
        }
        if (recovered.phase !== "ownership-committed") {
          await this.saveCreation(runtimeCreationSchema.parse({ ...recovered, phase: "ownership-committed" }));
        }
      }
      const inspected = recoveredCreation === null ? await this.inspectOwned(record) : await this.inspectCreationOwned(recoveredCreation);
      return { observedState: inspected.running ? "running" : "stopped", serviceState: inspected.running ? "running" : "stopped",
        errorCode: null, containerIdentity: record.developmentContainer.id };
    } catch (error) {
      if (error instanceof WorkspaceRuntimeError) return { observedState: "lost", serviceState: "lost", errorCode: error.code, containerIdentity: null };
      return { observedState: "failed", serviceState: "failed", errorCode: "ROOTLESS_RUNTIME_UNAVAILABLE", containerIdentity: null };
    }
  }

  async start(association: RuntimeAssociation, planInput: unknown, worktreePath: string, operationId: string): Promise<RuntimeObservation> {
    uuidV7Schema.parse(operationId);
    const plan = parseRuntimePlanV1(planInput);
    if (hashRuntimePlanV1(plan) !== association.runtimePlanHash) {
      throw new WorkspaceRuntimeError("RUNTIME_POLICY_VIOLATION", "The registered runtime plan hash does not match the workspace.");
    }
    let resources;
    try { resources = effectiveRuntimeResources(plan, this.policy); }
    catch { throw new WorkspaceRuntimeError("RUNTIME_POLICY_VIOLATION", "Requested resources exceed administrator runtime policy."); }
    try { await this.engine.assertRootlessAvailable(); }
    catch { throw new WorkspaceRuntimeError("ROOTLESS_RUNTIME_UNAVAILABLE", "The dedicated rootless Docker runtime is unavailable."); }
    const names = resourceNames(association.workspaceId, association.generation);
    const resolvedWorktree = path.resolve(worktreePath);
    let record = await this.load(association.workspaceId);
    if (record !== null) {
      if (!associationMatches(record, association) || record.worktreePath !== resolvedWorktree
        || JSON.stringify(record.resources) !== JSON.stringify(resources)) {
        throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The retained runtime belongs to another revision, plan, policy, worktree, or generation.");
      }
      const creation = await this.loadCreation(association.workspaceId);
      let recoveredCreation: RuntimeCreation | null = null;
      if (creation !== null) {
        if (!this.creationMatches(creation, association, resolvedWorktree, resources, names)) {
          throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The retained runtime creation record does not match authoritative ownership.");
        }
        const recovered = await this.recoverCreationEvidence(creation);
        recoveredCreation = recovered;
        if (recovered.networkId !== record.network.id || recovered.containerId !== record.developmentContainer.id) {
          throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "Runtime creation evidence conflicts with authoritative ownership.");
        }
        if (recovered.phase !== "ownership-committed") {
          await this.saveCreation(runtimeCreationSchema.parse({ ...recovered, phase: "ownership-committed" }));
        }
      }
      if (recoveredCreation === null) await this.inspectOwned(record);
      else await this.inspectCreationOwned(recoveredCreation);
      await this.engine.startContainer(record.developmentContainer.id);
      await this.stabilize(record);
      return { observedState: "running", serviceState: "running", errorCode: null, containerIdentity: record.developmentContainer.id };
    }
    let creation = await this.loadCreation(association.workspaceId);
    if (creation === null) {
      creation = runtimeCreationSchema.parse({ version: 1, operationId, ...association, worktreePath: resolvedWorktree,
        resources, networkName: names.network, containerName: names.container,
        networkId: null, containerId: null, phase: "reserved" });
      await this.saveCreation(creation);
    } else if (!this.creationMatches(creation, association, resolvedWorktree, resources, names)) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "An incomplete runtime creation belongs to another operation identity.");
    }
    creation = await this.recoverCreationEvidence(creation);
    const networkLabels = labels(association, "network", creation.operationId);
    const containerLabels = labels(association, "development-container", creation.operationId);
    if (creation.phase === "reserved") {
      let networkId: string;
      try { networkId = await this.engine.createNetwork(names.network, networkLabels); }
      catch { throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The derived workspace network name is unavailable or collided."); }
      creation = runtimeCreationSchema.parse({ ...creation, networkId, phase: "network-created" });
      await this.saveCreation(creation);
    } else if (creation.phase === "network-created") {
      const network = await this.inspectOptionalNetwork(creation.networkId!);
      if (network === null) {
        if (await this.inspectOptionalNetwork(creation.networkName) !== null) {
          throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The operation-owned workspace network was replaced.");
        }
        let networkId: string;
        try { networkId = await this.engine.createNetwork(names.network, networkLabels); }
        catch { throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The missing operation-owned workspace network could not be safely recreated."); }
        creation = runtimeCreationSchema.parse({ ...creation, networkId, phase: "network-created" });
        await this.saveCreation(creation);
      } else this.validateNetwork(network, { id: creation.networkId!, name: creation.networkName, labels: networkLabels });
    }
    if (creation.phase === "network-created") {
      await this.engine.ensureImage(plan.developmentContainer.source.imageReference);
      let containerId: string;
      try {
        containerId = await this.engine.createContainer(names.container, {
        imageReference: plan.developmentContainer.source.imageReference, worktreePath,
        user: plan.developmentContainer.containerUser, environment: plan.developmentContainer.environment,
        networkName: names.network, labels: containerLabels, ...resources
      });
      } catch {
        throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The development container could not be created safely.");
      }
      creation = runtimeCreationSchema.parse({ ...creation, containerId, phase: "container-created" });
      await this.saveCreation(creation);
    }
    creation = await this.recoverCreationEvidence(creation);
    record = this.ownershipFromCreation(creation);
    await this.inspectCreationOwned(creation);
    await this.writer.write(this.ownershipPath(association.workspaceId), record);
    creation = runtimeCreationSchema.parse({ ...creation, phase: "ownership-committed" });
    await this.saveCreation(creation);
    await this.inspectCreationOwned(creation);
    await this.engine.startContainer(record.developmentContainer.id);
    await this.stabilize(record);
    return { observedState: "running", serviceState: "running", errorCode: null, containerIdentity: record.developmentContainer.id };
  }

  async stop(association: RuntimeAssociation): Promise<RuntimeObservation> {
    try { await this.engine.assertRootlessAvailable(); }
    catch { throw new WorkspaceRuntimeError("ROOTLESS_RUNTIME_UNAVAILABLE", "The dedicated rootless Docker runtime is unavailable."); }
    const record = await this.load(association.workspaceId);
    if (record === null || !associationMatches(record, association)) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "No exact Agent-owned runtime is available to stop.");
    }
    await this.inspectOwned(record);
    await this.engine.stopContainer(record.developmentContainer.id);
    const stopped = await this.inspectOwned(record);
    if (stopped.running) throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The development container did not stop.");
    return { observedState: "stopped", serviceState: "stopped", errorCode: null, containerIdentity: record.developmentContainer.id };
  }
}

export function verifyRuntimePlanAgainstOptions(options: unknown, canonicalPlan: string, planHash: string): RuntimePlanV1 {
  const independentlyCompiled = compileRuntimePlanV1(options);
  if (canonicalizeRuntimePlanV1(independentlyCompiled) !== canonicalPlan || hashRuntimePlanV1(independentlyCompiled) !== planHash) {
    throw new WorkspaceRuntimeError("RUNTIME_POLICY_VIOLATION", "The runtime plan does not match the retained Project Options revision.");
  }
  return independentlyCompiled;
}
