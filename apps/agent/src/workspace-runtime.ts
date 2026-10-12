import { mkdir, readdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import * as z from "zod";
import { projectOptionsRevisionHashSchema, uuidV7Schema } from "@devspace/contracts";
import {
  canonicalizeRuntimePlanV1, compileRuntimePlanV1, hashRuntimePlanV1, parseRuntimePlanV1,
  type RuntimePlanV1
} from "@devspace/project-options";
import {
  DockerEngineClient, DockerEngineError, dockerPortBindingsEqual, effectiveRuntimeResources,
  type DockerPortBindings, type RuntimePolicy
} from "./docker-runtime.js";
import { durableJsonWriter, readStrictJson, type AtomicJsonWriter } from "./private-state.js";

const dockerIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/u);
const dockerNameSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/u);
const labelsSchema = z.record(z.string(), z.string());
const absolutePathSchema = z.string().refine((value) => path.isAbsolute(value), "Expected an absolute path");
const HARNESS_SLOT_CLEANUP_TIMEOUT_MS = 10_000;
export const runtimePreviewBindingSchema = z.strictObject({
  leaseId: uuidV7Schema,
  previewKey: z.string().regex(/^[a-z][a-z0-9-]*$/u),
  containerPort: z.number().int().min(1).max(65535),
  hostIp: z.literal("127.0.0.1"),
  hostPort: z.number().int().min(1).max(65535)
});
const runtimePreviewBindingsSchema = z.array(runtimePreviewBindingSchema).superRefine((bindings, context) => {
  const keys = new Set<string>();
  for (const [index, binding] of bindings.entries()) {
    if (keys.has(binding.previewKey)) context.addIssue({ code: "custom", path: [index, "previewKey"], message: "Duplicate preview key" });
    keys.add(binding.previewKey);
  }
});
export type RuntimePreviewBinding = z.infer<typeof runtimePreviewBindingSchema>;

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
  previewBindings: runtimePreviewBindingsSchema.default([]),
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
  previewBindings: runtimePreviewBindingsSchema.default([]),
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

const harnessSlotReplacementSchema = z.strictObject({
  version: z.literal(1),
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  revisionId: uuidV7Schema,
  revisionHash: projectOptionsRevisionHashSchema,
  runtimePlanHash: projectOptionsRevisionHashSchema,
  generation: z.number().int().positive(),
  worktreePath: absolutePathSchema,
  resources: z.strictObject({ cpuMillicores: z.number().int().positive(), memoryBytes: z.number().int().positive(), pidLimit: z.number().int().positive() }),
  previewBindings: runtimePreviewBindingsSchema.default([]),
  originalOperationId: uuidV7Schema,
  networkId: dockerIdSchema,
  networkName: dockerNameSchema,
  previousContainerId: dockerIdSchema.nullable(),
  replacementContainerId: dockerIdSchema.nullable(),
  phase: z.enum(["planned", "previous-removed", "replacement-created"])
}).superRefine((record, context) => {
  const valid = record.phase === "planned"
    ? record.previousContainerId !== null && record.replacementContainerId === null
    : record.phase === "previous-removed"
      ? record.replacementContainerId === null
      : record.replacementContainerId !== null;
  if (!valid) context.addIssue({ code: "custom", message: "Harness slot replacement phase is inconsistent." });
});
type HarnessSlotReplacement = z.infer<typeof harnessSlotReplacementSchema>;

export interface RuntimeAssociation {
  readonly projectId: string; readonly workspaceId: string; readonly revisionId: string;
  readonly revisionHash: string; readonly runtimePlanHash: string; readonly generation: number;
}
export type HarnessSlotMountObservation =
  | { readonly state: "present-and-exact" }
  | { readonly state: "missing" }
  | { readonly state: "mismatch" };

export interface RuntimeObservation {
  readonly observedState: "absent" | "starting" | "running" | "stopping" | "stopped" | "failed" | "lost";
  readonly serviceState: "absent" | "starting" | "running" | "stopping" | "stopped" | "failed" | "lost";
  readonly errorCode: string | null;
  readonly containerIdentity: string | null;
  readonly harnessSlotMount?: HarnessSlotMountObservation;
}

const HARNESS_SLOT_DESTINATION = "/opt/devspace/harness-home";

export function classifyHarnessSlotMount(input: {
  readonly mounts: readonly { Type: string; Source: string; Destination: string; RW: boolean; Propagation: string }[];
  readonly worktreePath: string;
  readonly slotHostPath: string;
}): HarnessSlotMountObservation {
  const workspace = input.mounts.filter((mount) => mount.Destination === "/workspace");
  const slot = input.mounts.filter((mount) => mount.Destination === HARNESS_SLOT_DESTINATION);
  const extras = input.mounts.filter((mount) => mount.Destination !== "/workspace" && mount.Destination !== HARNESS_SLOT_DESTINATION);
  const workspaceExact = workspace.length === 1
    && workspace[0]!.Type === "bind"
    && path.resolve(workspace[0]!.Source) === path.resolve(input.worktreePath)
    && workspace[0]!.RW === true
    && workspace[0]!.Propagation === "rprivate";
  if (!workspaceExact || extras.length > 0 || workspace.length !== 1) return { state: "mismatch" };
  if (slot.length === 0 && input.mounts.length === 1) return { state: "missing" };
  const expectedSlot = path.resolve(input.slotHostPath);
  const slotExact = slot.length === 1
    && slot[0]!.Type === "bind"
    && path.resolve(slot[0]!.Source) === expectedSlot
    && slot[0]!.RW === true
    && slot[0]!.Propagation === "rprivate";
  if (slotExact && input.mounts.length === 2) return { state: "present-and-exact" };
  return { state: "mismatch" };
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
function containerLabelsMatch(actual: Record<string, string>, expected: Record<string, string>): boolean {
  // Docker inspection merges image labels into the container label map; keep the DevSpace authority namespace exact.
  const devspaceLabels = Object.fromEntries(Object.entries(actual).filter(([key]) => key.startsWith("devspace.")));
  return equalLabels(devspaceLabels, expected);
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
    private readonly stateRoot: string,
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

  harnessSlotHostPath(workspaceId: string): string {
    return path.join(path.resolve(this.stateRoot), "harness-slots", uuidV7Schema.parse(workspaceId));
  }

  async observeHarnessSlot(workspaceId: string): Promise<HarnessSlotMountObservation> {
    const record = await this.load(workspaceId);
    if (record === null) return { state: "missing" };
    try {
      return await this.slotMountFor(record);
    } catch {
      return { state: "missing" };
    }
  }

  async clearHarnessHomeSlot(workspaceIdInput: string): Promise<void> {
    const workspaceId = uuidV7Schema.parse(workspaceIdInput);
    try { await this.engine.assertRootlessAvailable(); }
    catch { throw new WorkspaceRuntimeError("ROOTLESS_RUNTIME_UNAVAILABLE", "The dedicated rootless Docker runtime is unavailable."); }
    const record = await this.load(workspaceId);
    if (record === null) throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The exact Agent-owned workspace runtime is unavailable.");
    let container: Awaited<ReturnType<DockerEngineClient["inspectContainer"]>>;
    try {
      const [network, inspected] = await Promise.all([
        this.engine.inspectNetwork(record.network.id), this.engine.inspectContainer(record.developmentContainer.id)
      ]);
      this.validateNetwork(network, record.network);
      this.validateContainer(inspected, record);
      const slot = classifyHarnessSlotMount({ mounts: inspected.Mounts, worktreePath: record.worktreePath,
        slotHostPath: this.harnessSlotHostPath(workspaceId) });
      if (slot.state !== "present-and-exact") throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The retained container does not own the exact harness slot.");
      container = inspected;
    } catch (error) {
      if (error instanceof WorkspaceRuntimeError) throw error;
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The exact workspace container could not be verified for private-slot cleanup.");
    }
    if (container.Image === undefined || !/^sha256:[0-9a-f]{64}$/u.test(container.Image)) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The exact workspace image could not be verified for private-slot cleanup.");
    }
    const helperName = `devspace-harness-cleanup-${workspaceId}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    let helperId: string;
    try {
      helperId = await this.engine.createHarnessHomeCleanupContainer(helperName, {
        imageId: container.Image,
        workspaceId,
        slotHostPath: this.harnessSlotHostPath(workspaceId)
      });
    } catch {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "A bounded private-slot cleanup task could not be created.");
    }
    let operationError: unknown;
    try {
      await this.engine.startContainer(helperId);
      const deadline = this.lifecycle.now() + HARNESS_SLOT_CLEANUP_TIMEOUT_MS;
      for (;;) {
        const observation = await this.engine.inspectContainer(helperId);
        if (!observation.State.Running) {
          if (observation.State.Status !== "exited" || observation.State.ExitCode !== 0) {
            throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The bounded private-slot cleanup task did not complete successfully.");
          }
          break;
        }
        if (this.lifecycle.now() >= deadline) {
          throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The bounded private-slot cleanup task exceeded its time limit.");
        }
        await this.lifecycle.sleep(100);
      }
    } catch (error) {
      operationError = error;
    }
    let removalError: unknown;
    try { await this.engine.removeContainer(helperId); } catch (error) { removalError = error; }
    if (operationError instanceof Error) throw operationError;
    if (operationError !== undefined) {
      throw new Error(
        typeof operationError === "string" ? operationError : "The bounded private-slot cleanup task failed.",
        { cause: operationError }
      );
    }
    if (removalError !== undefined) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The completed private-slot cleanup task could not be removed.");
    }
  }

  async recoverOutstandingHarnessSlotReplacements(loadPlan: (creation: RuntimeCreation) => Promise<{
    plan: RuntimePlanV1; worktreePath: string;
  } | null>, findOperation: (operationId: string) => {
    readonly operationName: string; readonly request: unknown;
  } | undefined): Promise<void> {
    let names: string[];
    try { names = await readdir(this.creationRoot); } catch { return; }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const workspaceId = name.slice(0, -".json".length);
      const creation = await this.loadCreation(workspaceId);
      if (creation === null || creation.phase !== "reserved" || await this.load(workspaceId) !== null) continue;
      const loaded = await loadPlan(creation);
      if (loaded === null) continue;
      const networkName = resourceNames(creation.workspaceId, creation.generation).network;
      const network = await this.inspectOptionalNetwork(networkName);
      const retainedOperation = network?.Labels?.["devspace.creation-operation-id"];
      if (network === null || retainedOperation === undefined || retainedOperation === creation.operationId) continue;
      await this.recreateIfSlotMissing({
        projectId: creation.projectId, workspaceId: creation.workspaceId, revisionId: creation.revisionId,
        revisionHash: creation.revisionHash, runtimePlanHash: creation.runtimePlanHash, generation: creation.generation
      }, loaded.plan, loaded.worktreePath, creation.previewBindings, findOperation);
    }
  }

  async recreateIfSlotMissing(
    association: RuntimeAssociation,
    planInput: RuntimePlanV1,
    worktreePath: string,
    previewBindings: readonly RuntimePreviewBinding[] = [],
    findOperation?: (operationId: string) => {
      readonly operationName: string; readonly request: unknown;
    } | undefined
  ): Promise<HarnessSlotMountObservation> {
    if (findOperation !== undefined) this.creationOperation = findOperation;
    const plan = parseRuntimePlanV1(planInput);
    if (hashRuntimePlanV1(plan) !== association.runtimePlanHash) {
      throw new WorkspaceRuntimeError("RUNTIME_POLICY_VIOLATION", "The registered runtime plan hash does not match the workspace.");
    }
    const resources = effectiveRuntimeResources(plan, this.policy);
    const resolvedWorktree = path.resolve(worktreePath);
    const names = resourceNames(association.workspaceId, association.generation);
    const declaredPorts = plan.developmentContainer.ports.map((port) => port.containerPort);
    const pending = await this.loadHarnessSlotReplacement(association.workspaceId);
    if (pending !== null) {
      this.assertReplacementAssociation(pending, association, resolvedWorktree, resources);
      return await this.convergeHarnessSlotReplacement(pending, association, plan, names, declaredPorts);
    }
    const ownership = await this.load(association.workspaceId);
    if (ownership !== null) {
      if (!associationMatches(ownership, association) || ownership.worktreePath !== resolvedWorktree
        || JSON.stringify(ownership.resources) !== JSON.stringify(resources)
        || (previewBindings.length > 0 && JSON.stringify(ownership.previewBindings) !== JSON.stringify(previewBindings))) {
        throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The retained runtime does not match the requested workspace association.");
      }
      await this.inspectOwned(ownership);
      const slot = await this.slotMountFor(ownership);
      if (slot.state === "present-and-exact") return slot;
      if (slot.state !== "missing") {
        throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The development container mount does not match the harness slot contract.");
      }
      const originalOperationId = this.originalCreationOperation(ownership);
      this.assertOriginalWorkspaceStart(originalOperationId, association);
      const creation = await this.loadCreation(association.workspaceId);
      if (creation !== null && (creation.operationId !== originalOperationId
        || !this.creationMatches(creation, association, resolvedWorktree, resources, names, ownership.previewBindings))) {
        throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "Runtime creation evidence does not match the retained workspace.");
      }
      const replacement = harnessSlotReplacementSchema.parse({
        version: 1, ...association, worktreePath: resolvedWorktree, resources, previewBindings: ownership.previewBindings,
        originalOperationId, networkId: ownership.network.id, networkName: ownership.network.name,
        previousContainerId: ownership.developmentContainer.id, replacementContainerId: null, phase: "planned"
      });
      await this.saveHarnessSlotReplacement(replacement);
      return await this.convergeHarnessSlotReplacement(replacement, association, plan, names, declaredPorts);
    }
    return await this.recoverStrandedHarnessSlot(association, plan, resolvedWorktree, resources, names, declaredPorts, previewBindings);
  }

  private replacementPath(workspaceId: string): string {
    return path.join(path.resolve(this.stateRoot), "harness-slot-replacements", `${uuidV7Schema.parse(workspaceId)}.json`);
  }

  private async loadHarnessSlotReplacement(workspaceId: string): Promise<HarnessSlotReplacement | null> {
    try { return harnessSlotReplacementSchema.parse(await readStrictJson(this.replacementPath(workspaceId), harnessSlotReplacementSchema)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  private async saveHarnessSlotReplacement(record: HarnessSlotReplacement): Promise<void> {
    await this.writer.write(this.replacementPath(record.workspaceId), harnessSlotReplacementSchema.parse(record));
  }

  private assertReplacementAssociation(record: HarnessSlotReplacement, association: RuntimeAssociation, worktreePath: string,
    resources: RuntimeOwnership["resources"]): void {
    if (record.projectId !== association.projectId || record.workspaceId !== association.workspaceId
      || record.revisionId !== association.revisionId || record.revisionHash !== association.revisionHash
      || record.runtimePlanHash !== association.runtimePlanHash || record.generation !== association.generation
      || record.worktreePath !== worktreePath || JSON.stringify(record.resources) !== JSON.stringify(resources)) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The harness slot replacement belongs to another runtime.");
    }
  }

  private assertOriginalWorkspaceStart(operationId: string, association: RuntimeAssociation): void {
    const operation = this.creationOperation?.(operationId);
    if (operation?.operationName !== "workspace.start"
      || JSON.stringify(operation.request) !== JSON.stringify({ projectId: association.projectId, workspaceId: association.workspaceId })) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The retained workspace network is not bound to its original workspace start.");
    }
  }

  private originalCreationOperation(record: RuntimeOwnership): string {
    const networkOperation = record.network.labels["devspace.creation-operation-id"];
    const containerOperation = record.developmentContainer.labels["devspace.creation-operation-id"];
    if (networkOperation === undefined || networkOperation !== containerOperation || !uuidV7Schema.safeParse(networkOperation).success) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The retained network and development container do not share one creation operation.");
    }
    const expectedNetwork = labels(record, "network", networkOperation);
    const expectedContainer = labels(record, "development-container", networkOperation);
    if (!equalLabels(record.network.labels, expectedNetwork) || !equalLabels(record.developmentContainer.labels, expectedContainer)) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The retained runtime labels are not the original creation authority.");
    }
    return networkOperation;
  }

  private provedNetworkOperation(network: { Name: string; Labels?: Record<string, string> }, association: RuntimeAssociation,
    names: ReturnType<typeof resourceNames>): string {
    const actual = network.Labels ?? {};
    const operationId = actual["devspace.creation-operation-id"];
    if (typeof operationId !== "string" || !uuidV7Schema.safeParse(operationId).success || network.Name !== names.network) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The retained workspace network does not prove exact runtime ownership.");
    }
    if (!equalLabels(actual, labels(association, "network", operationId))) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The retained workspace network does not prove exact runtime ownership.");
    }
    return operationId;
  }

  private async recoverStrandedHarnessSlot(
    association: RuntimeAssociation,
    plan: RuntimePlanV1,
    resolvedWorktree: string,
    resources: RuntimeOwnership["resources"],
    names: ReturnType<typeof resourceNames>,
    declaredPorts: readonly number[],
    previewBindings: readonly RuntimePreviewBinding[]
  ): Promise<HarnessSlotMountObservation> {
    const creation = await this.loadCreation(association.workspaceId);
    if (creation === null || creation.phase !== "reserved") {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The workspace runtime cannot be recovered without exact creation evidence.");
    }
    if (!this.creationMatches(creation, association, resolvedWorktree, resources, names, previewBindings.length === 0 ? creation.previewBindings : previewBindings)) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The reserved runtime creation does not match this workspace.");
    }
    const network = await this.inspectOptionalNetwork(names.network);
    if (network === null) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The canonical workspace network is not available.");
    }
    const originalOperationId = this.provedNetworkOperation(network, association, names);
    this.assertOriginalWorkspaceStart(originalOperationId, association);
    if (creation.operationId !== originalOperationId && creation.phase !== "reserved") {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The runtime creation record is not a recoverable reconciliation attempt.");
    }
    const occupying = await this.inspectOptionalContainer(names.container);
    if (occupying !== null) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "A development container already occupies the retained runtime name.");
    }
    const rebound = runtimeCreationSchema.parse({
      ...creation, operationId: originalOperationId, networkId: network.Id, containerId: null, phase: "network-created",
      previewBindings: creation.previewBindings
    });
    await this.saveCreation(rebound);
    const replacement = harnessSlotReplacementSchema.parse({
      version: 1, ...association, worktreePath: resolvedWorktree, resources, previewBindings: creation.previewBindings,
      originalOperationId, networkId: network.Id, networkName: network.Name,
      previousContainerId: null, replacementContainerId: null, phase: "previous-removed"
    });
    await this.saveHarnessSlotReplacement(replacement);
    return await this.convergeHarnessSlotReplacement(replacement, association, plan, names, declaredPorts);
  }

  private async convergeHarnessSlotReplacement(
    replacement: HarnessSlotReplacement,
    association: RuntimeAssociation,
    plan: RuntimePlanV1,
    names: ReturnType<typeof resourceNames>,
    declaredPorts: readonly number[]
  ): Promise<HarnessSlotMountObservation> {
    const network = await this.engine.inspectNetwork(replacement.networkId);
    this.provedNetworkOperation(network, association, names);
    if (network.Id !== replacement.networkId || network.Name !== replacement.networkName
      || network.Labels?.["devspace.creation-operation-id"] !== replacement.originalOperationId) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The retained workspace network changed during slot reconciliation.");
    }
    let current = replacement;
    if (current.phase === "planned") {
      if (current.previousContainerId === null) {
        throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The previous development container identity is missing.");
      }
      try { await this.engine.stopContainer(current.previousContainerId); } catch { /* already stopped */ }
      try { await this.engine.removeContainer(current.previousContainerId); } catch { /* already removed */ }
      current = harnessSlotReplacementSchema.parse({ ...current, phase: "previous-removed" });
      await this.saveHarnessSlotReplacement(current);
    }
    if (current.phase === "previous-removed") {
      const expectedLabels = labels(association, "development-container", current.originalOperationId);
      const occupying = await this.inspectOptionalContainer(names.container);
      let replacementContainerId: string;
      if (occupying !== null) {
        if (!containerLabelsMatch(occupying.Config.Labels ?? {}, expectedLabels)) {
          throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The development container name is occupied by an unrelated resource.");
        }
        const slot = classifyHarnessSlotMount({
          mounts: occupying.Mounts, worktreePath: current.worktreePath,
          slotHostPath: this.harnessSlotHostPath(association.workspaceId)
        });
        if (slot.state !== "present-and-exact") {
          throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "An existing development container does not have the exact harness slot.");
        }
        replacementContainerId = occupying.Id;
      } else {
        await this.engine.ensureImage(plan.developmentContainer.source.imageReference);
        const harnessSlotPath = this.harnessSlotHostPath(association.workspaceId);
        await mkdir(harnessSlotPath, { recursive: true, mode: 0o700 });
        replacementContainerId = await this.engine.createContainer(names.container, {
          imageReference: plan.developmentContainer.source.imageReference, worktreePath: current.worktreePath, harnessSlotPath,
          user: plan.developmentContainer.containerUser, environment: plan.developmentContainer.environment,
          networkName: names.network, labels: expectedLabels, ...current.resources,
          portBindings: Object.fromEntries(current.previewBindings.map((binding) => [
            `${binding.containerPort}/tcp`, [{ HostIp: binding.hostIp, HostPort: String(binding.hostPort) }]
          ])), declaredContainerPorts: declaredPorts
        });
      }
      current = harnessSlotReplacementSchema.parse({ ...current, replacementContainerId, phase: "replacement-created" });
      await this.saveHarnessSlotReplacement(current);
    }
    if (current.replacementContainerId === null) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The replacement development container was not created.");
    }
    const created = runtimeCreationSchema.parse({
      version: 1, operationId: current.originalOperationId, ...association, worktreePath: current.worktreePath,
      resources: current.resources, previewBindings: current.previewBindings, networkName: current.networkName,
      containerName: names.container, networkId: current.networkId, containerId: current.replacementContainerId,
      phase: "container-created"
    });
    const existingCreation = await this.loadCreation(association.workspaceId);
    if (existingCreation !== null && existingCreation.operationId !== current.originalOperationId) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "Runtime creation evidence does not match the original workspace start.");
    }
    await this.inspectCreationOwned(created);
    const ownership = this.ownershipFromCreation(created);
    await this.writer.write(this.ownershipPath(association.workspaceId), ownership);
    const committed = runtimeCreationSchema.parse({ ...created, phase: "ownership-committed" });
    if (existingCreation !== null) await this.saveCreation(committed);
    if ((await this.engine.inspectContainer(ownership.developmentContainer.id)).State.Running !== true) {
      await this.engine.startContainer(ownership.developmentContainer.id);
    }
    await this.stabilize(ownership);
    const slot = await this.slotMountFor(ownership);
    if (slot.state !== "present-and-exact") {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The replacement development container does not have the exact harness slot.");
    }
    await unlink(this.replacementPath(association.workspaceId)).catch(() => undefined);
    return slot;
  }

  private async slotMountFor(record: RuntimeOwnership): Promise<HarnessSlotMountObservation> {
    const container = await this.engine.inspectContainer(record.developmentContainer.id);
    return classifyHarnessSlotMount({
      mounts: container.Mounts,
      worktreePath: record.worktreePath,
      slotHostPath: this.harnessSlotHostPath(record.workspaceId)
    });
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

  validatePlanPolicy(planInput: unknown): void {
    const plan = parseRuntimePlanV1(planInput);
    try { effectiveRuntimeResources(plan, this.policy); }
    catch { throw new WorkspaceRuntimeError("RUNTIME_POLICY_VIOLATION", "Requested resources exceed administrator runtime policy."); }
  }

  async assertRootlessRuntimeAvailable(): Promise<void> {
    try { await this.engine.assertRootlessAvailable(); }
    catch { throw new WorkspaceRuntimeError("ROOTLESS_RUNTIME_UNAVAILABLE", "The dedicated rootless Docker runtime is unavailable."); }
  }

  /**
   * Removes only resources represented by exact Agent ownership evidence. Both
   * ownership records are retained until Docker confirms the recorded IDs and
   * their canonical names are absent. The callback releases dependent leases
   * after container absence is established and before ownership is cleared.
   */
  async retireForRevisionAdoption(association: RuntimeAssociation,
    afterContainerAbsent: (ownership: RuntimeOwnership) => Promise<void>,
    onIrreversibleEffect: () => void): Promise<void> {
    await this.assertRootlessRuntimeAvailable();

    let ownership = await this.load(association.workspaceId);
    const hadCommittedOwnership = ownership !== null;
    const creation = await this.loadCreation(association.workspaceId);
    if (ownership === null && creation === null) {
      const names = resourceNames(association.workspaceId, association.generation);
      if (await this.inspectOptionalContainer(names.container) !== null || await this.inspectOptionalNetwork(names.network) !== null) {
        throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "A runtime resource exists without exact Agent ownership evidence.");
      }
      return;
    }
    if (ownership !== null && !associationMatches(ownership, association)) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The retained runtime belongs to another configuration revision.");
    }
    if (creation !== null) {
      if (creation.projectId !== association.projectId || creation.workspaceId !== association.workspaceId
        || creation.revisionId !== association.revisionId || creation.revisionHash !== association.revisionHash
        || creation.runtimePlanHash !== association.runtimePlanHash || creation.generation !== association.generation
        || creation.containerId === null || creation.networkId === null) {
        throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The retained runtime creation evidence is incomplete or belongs to another revision.");
      }
      const fromCreation = this.ownershipFromCreation(creation);
      if (ownership !== null && (ownership.network.id !== fromCreation.network.id
        || ownership.developmentContainer.id !== fromCreation.developmentContainer.id)) {
        throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "Runtime ownership records disagree about exact Docker resource IDs.");
      }
      ownership ??= fromCreation;
    }
    if (ownership === null) throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The exact Agent-owned runtime could not be established.");

    const [container, network] = await Promise.all([
      this.inspectOptionalContainer(ownership.developmentContainer.id),
      this.inspectOptionalNetwork(ownership.network.id)
    ]);
    if (container !== null) {
      this.validateContainer(container, ownership, hadCommittedOwnership ? "materialized" : "operation-owned-pre-activation");
      if (container.State.Running) {
        throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The development container is still running.");
      }
    } else if (await this.inspectOptionalContainer(ownership.developmentContainer.name) !== null) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The development container name is occupied by a resource with a different ID.");
    }
    if (network !== null) this.validateNetwork(network, ownership.network);
    else if (await this.inspectOptionalNetwork(ownership.network.name) !== null) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The workspace network name is occupied by a resource with a different ID.");
    }

    if (container !== null) {
      onIrreversibleEffect();
      await this.engine.removeContainer(ownership.developmentContainer.id);
    }
    if (await this.inspectOptionalContainer(ownership.developmentContainer.id) !== null
      || await this.inspectOptionalContainer(ownership.developmentContainer.name) !== null) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The exact development container has not been confirmed absent.");
    }
    onIrreversibleEffect();
    await afterContainerAbsent(ownership);

    if (network !== null) {
      onIrreversibleEffect();
      await this.engine.removeNetwork(ownership.network.id);
    }
    if (await this.inspectOptionalNetwork(ownership.network.id) !== null
      || await this.inspectOptionalNetwork(ownership.network.name) !== null) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The exact workspace network has not been confirmed absent.");
    }

    // Keep the primary ownership record until the creation journal is gone so
    // a restart can always derive and recheck the exact resource IDs.
    onIrreversibleEffect();
    await this.unlinkIfPresent(this.creationPath(association.workspaceId));
    await this.unlinkIfPresent(this.ownershipPath(association.workspaceId));
  }

  private async unlinkIfPresent(file: string): Promise<void> {
    try { await unlink(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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
    const expectedByPort = new Map<string, Array<{ HostIp: string; HostPort: string }>>();
    for (const binding of record.previewBindings) {
      const key = `${binding.containerPort}/tcp`;
      const values = expectedByPort.get(key) ?? [];
      values.push({ HostIp: binding.hostIp, HostPort: String(binding.hostPort) });
      expectedByPort.set(key, values);
    }
    const expectedPortBindings: DockerPortBindings = Object.fromEntries(expectedByPort);
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
      || !containerLabelsMatch(container.Config.Labels ?? {}, record.developmentContainer.labels)
      || container.Config.WorkingDir !== "/workspace"
      || container.HostConfig.Privileged !== false || container.HostConfig.PublishAllPorts !== false
      || container.HostConfig.PidMode !== "" || container.HostConfig.IpcMode !== "private"
      || container.HostConfig.UTSMode !== "" || container.HostConfig.UsernsMode !== ""
      || container.HostConfig.CgroupnsMode !== "private"
      || container.HostConfig.AutoRemove !== false || container.HostConfig.ReadonlyRootfs !== false
      || container.HostConfig.RestartPolicy.Name !== "no" || container.HostConfig.RestartPolicy.MaximumRetryCount !== 0
      || container.HostConfig.NetworkMode === "host" || container.HostConfig.NetworkMode !== record.network.name
      || networkNames.length !== 1 || networkNames[0] !== record.network.name || !networkIdentityMatches
      || !dockerPortBindingsEqual(portBindings, expectedPortBindings) || devices.length !== 0
      || container.HostConfig.NanoCpus !== record.resources.cpuMillicores * 1_000_000
      || container.HostConfig.Memory !== record.resources.memoryBytes
      || container.HostConfig.PidsLimit !== record.resources.pidLimit
      || capAdd.length !== 0 || capDrop.length !== 0
      || JSON.stringify(securityOptions) !== JSON.stringify(["no-new-privileges:true"])
      || container.Mounts.some((mount) => mount.Source.includes("docker.sock") || mount.Destination.includes("docker.sock"))
      || classifyHarnessSlotMount({
        mounts: container.Mounts,
        worktreePath: record.worktreePath,
        slotHostPath: this.harnessSlotHostPath(record.workspaceId)
      }).state === "mismatch") {
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
    resources: RuntimeOwnership["resources"], names: ReturnType<typeof resourceNames>,
    previewBindings: readonly RuntimePreviewBinding[] = record.previewBindings): boolean {
    return record.projectId === association.projectId && record.workspaceId === association.workspaceId
      && record.revisionId === association.revisionId && record.revisionHash === association.revisionHash
      && record.runtimePlanHash === association.runtimePlanHash && record.generation === association.generation
      && record.worktreePath === path.resolve(worktreePath) && JSON.stringify(record.resources) === JSON.stringify(resources)
      && record.networkName === names.network && record.containerName === names.container
      && JSON.stringify(record.previewBindings) === JSON.stringify(previewBindings);
  }

  private ownershipFromCreation(creation: RuntimeCreation): RuntimeOwnership {
    if (creation.networkId === null || creation.containerId === null) {
      throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "Runtime creation is not ready for ownership finalization.");
    }
    const association: RuntimeAssociation = creation;
    return runtimeOwnershipSchema.parse({ version: 1, projectId: creation.projectId, workspaceId: creation.workspaceId,
      revisionId: creation.revisionId, revisionHash: creation.revisionHash, runtimePlanHash: creation.runtimePlanHash,
      generation: creation.generation, worktreePath: creation.worktreePath, resources: creation.resources,
      previewBindings: creation.previewBindings,
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
        if (!containerLabelsMatch(container.Config.Labels ?? {}, containerLabels)) {
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
      return {
        observedState: inspected.running ? "running" : "stopped",
        serviceState: inspected.running ? "running" : "stopped",
        harnessSlotMount: await this.slotMountFor(record),
        errorCode: null, containerIdentity: record.developmentContainer.id };
    } catch (error) {
      if (error instanceof WorkspaceRuntimeError) return { observedState: "lost", serviceState: "lost", errorCode: error.code, containerIdentity: null };
      return { observedState: "failed", serviceState: "failed", errorCode: "ROOTLESS_RUNTIME_UNAVAILABLE", containerIdentity: null };
    }
  }

  async start(association: RuntimeAssociation, planInput: unknown, worktreePath: string, operationId: string,
    requestedPreviewBindings: readonly RuntimePreviewBinding[] = []): Promise<RuntimeObservation> {
    uuidV7Schema.parse(operationId);
    const plan = parseRuntimePlanV1(planInput);
    const previewBindings = runtimePreviewBindingsSchema.parse(requestedPreviewBindings);
    const declaredPorts = plan.developmentContainer.ports.map((port) => port.containerPort);
    if (previewBindings.some((binding) => !declaredPorts.includes(binding.containerPort))) {
      throw new WorkspaceRuntimeError("RUNTIME_POLICY_VIOLATION", "A preview port is not declared by the exact runtime plan.");
    }
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
        || JSON.stringify(record.resources) !== JSON.stringify(resources)
        || JSON.stringify(record.previewBindings) !== JSON.stringify(previewBindings)) {
        throw new WorkspaceRuntimeError("WORKSPACE_STATE_CONFLICT", "The retained runtime belongs to another revision, plan, policy, worktree, or generation.");
      }
      const creation = await this.loadCreation(association.workspaceId);
      let recoveredCreation: RuntimeCreation | null = null;
      if (creation !== null) {
        if (!this.creationMatches(creation, association, resolvedWorktree, resources, names, previewBindings)) {
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
      return {
        observedState: "running", serviceState: "running", errorCode: null,
        containerIdentity: record.developmentContainer.id, harnessSlotMount: await this.slotMountFor(record)
      };
    }
    let creation = await this.loadCreation(association.workspaceId);
    if (creation === null) {
      creation = runtimeCreationSchema.parse({ version: 1, operationId, ...association, worktreePath: resolvedWorktree,
        resources, previewBindings, networkName: names.network, containerName: names.container,
        networkId: null, containerId: null, phase: "reserved" });
      await this.saveCreation(creation);
    } else if (!this.creationMatches(creation, association, resolvedWorktree, resources, names, previewBindings)) {
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
        const harnessSlotPath = this.harnessSlotHostPath(association.workspaceId);
        await mkdir(harnessSlotPath, { recursive: true, mode: 0o700 });
        containerId = await this.engine.createContainer(names.container, {
        imageReference: plan.developmentContainer.source.imageReference, worktreePath, harnessSlotPath,
        user: plan.developmentContainer.containerUser, environment: plan.developmentContainer.environment,
        networkName: names.network, labels: containerLabels, ...resources,
        portBindings: Object.fromEntries(previewBindings.map((binding) => [
          `${binding.containerPort}/tcp`, [{ HostIp: binding.hostIp, HostPort: String(binding.hostPort) }]
        ])), declaredContainerPorts: declaredPorts
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
    return {
      observedState: "running", serviceState: "running", errorCode: null,
      containerIdentity: record.developmentContainer.id, harnessSlotMount: await this.slotMountFor(record)
    };
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
