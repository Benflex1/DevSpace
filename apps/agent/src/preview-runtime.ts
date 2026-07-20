import { readdir, unlink } from "node:fs/promises";
import { v7 as uuidv7 } from "uuid";
import path from "node:path";
import * as z from "zod";
import {
  previewHostnameSchema, previewInspectionDataSchema, uuidV7Schema, type PreviewInspectionData, type AgentSnapshotResource,
  type ActivatePreviewData
} from "@devspace/contracts";
import {
  composePreviewHostname, createApprovedPreviewBase, createApprovedPreviewBaseRegistry,
  validateDnsLabel, validatePreviewHostnamePattern, type ApprovedPreviewBaseRegistry, type DnsLabel
} from "@devspace/security";
import type { ProjectOptionsV1 } from "@devspace/project-options";
import {
  DOCKER_LOOPBACK_HOST, DockerEngineClient, DockerEngineError,
  type DockerContainerInspection, type DockerListedContainer
} from "./docker-runtime.js";
import {
  runtimePreviewBindingSchema, type RuntimeAssociation, type RuntimeOwnership,
  type RuntimePreviewBinding, WorkspaceRuntimeManager
} from "./workspace-runtime.js";
import {
  durableJsonWriter, establishPinnedDirectory, readStrictJson, type AtomicJsonWriter
} from "./private-state.js";
import type { PreviewGatewayAdapterContract as PrivatePreviewGatewayAdapter } from "@devspace/gateway-caddy";

const previewKeySchema = z.string().regex(/^[a-z][a-z0-9-]*$/u);
const hostnameSchema = z.string().min(1).max(253).refine((value) => value.split(".").every((label) =>
  label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)));

export interface PreviewGatewayProbeRequest {
  /** The lease ID is opaque to the probe and resolves only inside the gateway host. */
  readonly leaseId: string;
  readonly path: string;
  readonly acceptedStatuses: readonly number[];
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  readonly webSocketForwarding: boolean;
}
export type PreviewGatewayProbeResult =
  | { readonly kind: "response"; readonly statusCode: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "infrastructure"; readonly message: string };
export interface PreviewGatewayProbe {
  probe(input: PreviewGatewayProbeRequest): Promise<PreviewGatewayProbeResult>;
}

export interface PreviewGatewayRoute {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly previewId: string;
  readonly revisionId: string;
  readonly generation: number;
  readonly hostname: string;
  readonly approvedBaseId: string;
  readonly leaseId: string;
  readonly hostIp: "127.0.0.1";
  readonly hostPort: number;
  readonly webSocketForwarding: boolean;
}

export interface PreviewWorkspaceIdentity {
  readonly projectSlug: string;
  readonly workspaceSlug: string;
}
export type PreviewWorkspaceIdentityResolver = (projectId: string, workspaceId: string) => Promise<PreviewWorkspaceIdentity | null>;

/** The Agent-facing structural seam for the active private gateway adapter. */
export type PreviewGatewayAdapter = PrivatePreviewGatewayAdapter;

/** Used until the Checkpoint 3 gateway adapter is installed. It is fail-closed. */
export class UnavailablePreviewGatewayProbe implements PreviewGatewayProbe {
  probe(_input: PreviewGatewayProbeRequest): Promise<PreviewGatewayProbeResult> {
    return Promise.resolve({ kind: "infrastructure", message: "The private gateway-host probe is unavailable." });
  }
}

export type PreviewRuntimeErrorCode =
  | "PREVIEW_NOT_DEFINED" | "RESOURCE_NOT_FOUND" | "RUNTIME_POLICY_VIOLATION"
  | "PREVIEW_DOMAIN_NOT_APPROVED" | "WORKSPACE_STATE_CONFLICT"
  | "ROOTLESS_RUNTIME_UNAVAILABLE" | "GATEWAY_UPDATE_FAILED";

export class PreviewRuntimeError extends Error {
  constructor(readonly code: PreviewRuntimeErrorCode, message: string,
    readonly details: { readonly revisionId?: string; readonly previewKey?: string; readonly previewId?: string } = {}) {
    super(message); this.name = "PreviewRuntimeError";
  }
}

const previewLeaseSchema = z.strictObject({
  version: z.literal(1), leaseId: uuidV7Schema, operationId: uuidV7Schema,
  projectId: uuidV7Schema, workspaceId: uuidV7Schema, revisionId: uuidV7Schema,
  revisionHash: z.string().regex(/^sha256-jcs-v1:[0-9a-f]{64}$/u),
  runtimePlanHash: z.string().regex(/^sha256-jcs-v1:[0-9a-f]{64}$/u), generation: z.number().int().positive(),
  previewKey: previewKeySchema, containerPort: z.number().int().min(1).max(65535),
  hostIp: z.literal(DOCKER_LOOPBACK_HOST), hostPort: z.number().int().min(1).max(65535),
  containerId: z.string().min(1).nullable(), state: z.enum(["reserved", "owned"])
});
type PreviewLease = z.infer<typeof previewLeaseSchema>;

const previewStateSchema = z.strictObject({
  version: z.literal(1), previewId: uuidV7Schema, projectId: uuidV7Schema, workspaceId: uuidV7Schema,
  previewKey: previewKeySchema, revisionId: uuidV7Schema,
  revisionHash: z.string().regex(/^sha256-jcs-v1:[0-9a-f]{64}$/u),
  runtimePlanHash: z.string().regex(/^sha256-jcs-v1:[0-9a-f]{64}$/u),
  generation: z.number().int().positive(), hostname: hostnameSchema,
  domainBaseId: z.string().min(1).max(64).default("unknown"),
  containerPort: z.number().int().min(1).max(65535), healthPath: z.string().regex(/^\//u),
  healthStatuses: z.array(z.number().int().min(100).max(599)).min(1), startupTimeoutSeconds: z.number().int().positive(),
  webSocketForwarding: z.boolean(), leaseId: uuidV7Schema, containerId: z.string().min(1).nullable(),
  desiredState: z.enum(["inactive", "active"]),
  observedState: z.enum(["inactive", "starting", "healthy", "unhealthy", "stopping", "failed", "lost"]),
  routePresent: z.boolean(), attempt: z.number().int().nonnegative(),
  nextAttemptAt: z.number().int().nonnegative(), lastStatusCode: z.number().int().nullable(),
  lastError: z.string().max(256).nullable(), operationId: uuidV7Schema.nullable()
});
type PreviewState = z.infer<typeof previewStateSchema>;

export interface PreviewLeasePolicy {
  readonly firstPort: number;
  readonly lastPort: number;
}

function boundedPort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be a positive base-10 integer.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > 65535) throw new Error(`${name} is outside the valid port range.`);
  return result;
}

export function readPreviewLeasePolicy(environment: NodeJS.ProcessEnv = process.env): PreviewLeasePolicy {
  const firstPort = boundedPort(environment.DEVSPACE_PREVIEW_LEASE_FIRST_PORT, 40_000, "DEVSPACE_PREVIEW_LEASE_FIRST_PORT");
  const lastPort = boundedPort(environment.DEVSPACE_PREVIEW_LEASE_LAST_PORT, 49_999, "DEVSPACE_PREVIEW_LEASE_LAST_PORT");
  if (firstPort > lastPort) throw new Error("Preview lease port range is inconsistent.");
  return { firstPort, lastPort };
}

/** Parses the same closed administrator-owned registry used by the Web. */
export function readPreviewBaseRegistry(environment: Readonly<Record<string, string | undefined>> = process.env): ApprovedPreviewBaseRegistry {
  const raw = environment.DEVSPACE_PREVIEW_BASES?.trim();
  if (raw === undefined || raw === "") {
    const empty = createApprovedPreviewBaseRegistry([]);
    if (!empty.ok) throw new Error("The default preview-base registry is invalid.");
    return empty.value;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("DEVSPACE_PREVIEW_BASES must be valid JSON."); }
  if (!Array.isArray(parsed)) throw new Error("DEVSPACE_PREVIEW_BASES must be a JSON array.");
  const bases = parsed.map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null
      || typeof (candidate as { id?: unknown }).id !== "string"
      || typeof (candidate as { domain?: unknown }).domain !== "string") {
      throw new Error(`DEVSPACE_PREVIEW_BASES[${index}] must contain string id and domain fields.`);
    }
    const result = createApprovedPreviewBase((candidate as { id: string }).id, (candidate as { domain: string }).domain);
    if (!result.ok) throw new Error(`DEVSPACE_PREVIEW_BASES[${index}] is invalid: ${result.error.code}.`);
    return result.value;
  });
  const domains = new Set<string>();
  for (const base of bases) {
    if (domains.has(base.domain)) throw new Error(`DEVSPACE_PREVIEW_BASES contains duplicate domain: ${base.domain}.`);
    domains.add(base.domain);
  }
  const registry = createApprovedPreviewBaseRegistry(bases);
  if (!registry.ok) throw new Error(`DEVSPACE_PREVIEW_BASES is invalid: ${registry.error.code}.`);
  return registry.value;
}

function previewPath(root: string, previewId: string): string {
  return path.join(root, `${uuidV7Schema.parse(previewId)}.json`);
}
function leasePath(root: string, leaseId: string): string {
  return path.join(root, `${uuidV7Schema.parse(leaseId)}.json`);
}
function sameAssociation(left: PreviewLease | PreviewState, right: RuntimeAssociation): boolean {
  return left.projectId === right.projectId && left.workspaceId === right.workspaceId
    && left.revisionId === right.revisionId && left.revisionHash === right.revisionHash
    && left.runtimePlanHash === right.runtimePlanHash && left.generation === right.generation;
}
function safeLabel(value: string, field: string): DnsLabel {
  const result = validateDnsLabel(value, field);
  if (!result.ok) throw new PreviewRuntimeError("PREVIEW_DOMAIN_NOT_APPROVED", `The preview ${field} is not a valid DNS label.`);
  return result.value;
}

function compositionValues(pattern: string, values: {
  readonly project: DnsLabel;
  readonly workspace: DnsLabel;
  readonly preview: DnsLabel;
  readonly shortId: DnsLabel;
}) {
  return Object.fromEntries(Object.entries(values).filter(([name]) => pattern.includes(`{${name}}`))) as Partial<typeof values>;
}

export class PreviewLeaseAllocator {
  private readonly leasesRoot: string;
  private operationTail: Promise<void> = Promise.resolve();
  constructor(
    stateRoot: string,
    private readonly engine: DockerEngineClient,
    private readonly policy: PreviewLeasePolicy = readPreviewLeasePolicy(),
    private readonly writer: AtomicJsonWriter = durableJsonWriter,
    private readonly createId: () => string = uuidv7
  ) { this.leasesRoot = path.join(path.resolve(stateRoot), "preview-leases"); }

  async initialize(): Promise<void> {
    await establishPinnedDirectory(this.leasesRoot);
    for (const name of await readdir(this.leasesRoot)) {
      if (!name.endsWith(".json")) throw new Error("unexpected-preview-lease-entry");
      const record = await readStrictJson(path.join(this.leasesRoot, name), previewLeaseSchema);
      if (name !== `${record.leaseId}.json`) throw new Error("preview-lease-filename-mismatch");
    }
  }
  private async all(): Promise<PreviewLease[]> {
    return await Promise.all((await readdir(this.leasesRoot)).filter((name) => name.endsWith(".json")).map(async (name) =>
      await readStrictJson(path.join(this.leasesRoot, name), previewLeaseSchema)));
  }
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
  private async inspectContainers(): Promise<DockerContainerInspection[]> {
    let listed: readonly DockerListedContainer[];
    try { listed = await this.engine.listContainers(); }
    catch { throw new PreviewRuntimeError("ROOTLESS_RUNTIME_UNAVAILABLE", "The dedicated rootless Docker runtime is unavailable."); }
    const inspected: DockerContainerInspection[] = [];
    for (const entry of listed) {
      try { inspected.push(await this.engine.inspectContainer(entry.Id)); }
      catch (error) { if (!(error instanceof DockerEngineError && error.statusCode === 404)) throw error; }
    }
    return inspected;
  }
  private usesHostPort(container: DockerContainerInspection, hostPort: number): boolean {
    const bindings = container.HostConfig.PortBindings ?? {};
    return Object.values(bindings).some((entries) => entries?.some((entry) => entry !== null &&
      Number(entry.HostPort) === hostPort));
  }
  private hasExactBinding(container: DockerContainerInspection, containerPort: number, hostPort: number): boolean {
    const entries = (container.HostConfig.PortBindings ?? {})[`${containerPort}/tcp`];
    return entries?.some((entry) => entry !== null && entry.HostIp === DOCKER_LOOPBACK_HOST
      && Number(entry.HostPort) === hostPort) ?? false;
  }
  private async reconcileDetachedLeases(): Promise<void> {
    const records = await this.all();
    const containers = await this.inspectContainers();
    for (const record of records) {
      if (record.containerId !== null) {
        try {
          const container = await this.engine.inspectContainer(record.containerId);
          const exact = this.hasExactBinding(container, record.containerPort, record.hostPort);
          if (!exact && container.State.Running === false) {
            // Keep a retained stopped container's reservation even when drift is observed.
            continue;
          }
        } catch (error) {
          if (error instanceof DockerEngineError && error.statusCode === 404) await unlink(leasePath(this.leasesRoot, record.leaseId));
        }
        continue;
      }
      const candidate = containers.find((container) => {
        const labels = container.Config.Labels ?? {};
        return labels["devspace.managed"] === "true"
          && labels["devspace.project-id"] === record.projectId
          && labels["devspace.workspace-id"] === record.workspaceId
          && labels["devspace.revision-id"] === record.revisionId
          && labels["devspace.runtime-generation"] === String(record.generation)
          && labels["devspace.creation-operation-id"] === record.operationId
          && this.hasExactBinding(container, record.containerPort, record.hostPort);
      });
      if (candidate !== undefined) {
        await this.writer.write(leasePath(this.leasesRoot, record.leaseId), previewLeaseSchema.parse({
          ...record, containerId: candidate.Id, state: "owned"
        }));
      }
    }
  }
  async reserveWorkspaceLeases(association: RuntimeAssociation, options: ProjectOptionsV1, operationId: string): Promise<RuntimePreviewBinding[]> {
    uuidV7Schema.parse(operationId);
    return await this.withLock(async () => {
      const targets = options.previews.filter((preview) => preview.target.kind === "workspace")
        .sort((left, right) => left.key.localeCompare(right.key));
      const declaredPorts = new Set(options.developmentEnvironment.ports.map((port) => port.containerPort));
      for (const target of targets) {
        if (!declaredPorts.has(target.containerPort)) {
          throw new PreviewRuntimeError("RUNTIME_POLICY_VIOLATION", `Preview ${target.key} targets an undeclared workspace port.`, {
            previewKey: target.key
          });
        }
      }
      await this.reconcileDetachedLeases();
      const records = await this.all();
      const containers = await this.inspectContainers();
      const usedPorts = new Set<number>();
      for (const record of records) usedPorts.add(record.hostPort);
      for (const container of containers) {
        for (let port = this.policy.firstPort; port <= this.policy.lastPort; port += 1) {
          if (this.usesHostPort(container, port)) usedPorts.add(port);
        }
      }
      const result: RuntimePreviewBinding[] = [];
      for (const target of targets) {
        const existing = records.find((record) => sameAssociation(record, association)
          && record.previewKey === target.key && record.containerPort === target.containerPort);
        if (existing !== undefined) {
          if (existing.containerId === null && existing.operationId !== operationId) {
            throw new PreviewRuntimeError("WORKSPACE_STATE_CONFLICT", `Preview lease ${target.key} is reserved by another runtime operation.`);
          }
          result.push({ leaseId: existing.leaseId, previewKey: existing.previewKey, containerPort: existing.containerPort,
            hostIp: existing.hostIp, hostPort: existing.hostPort });
          continue;
        }
        let hostPort = this.policy.firstPort;
        while (hostPort <= this.policy.lastPort && usedPorts.has(hostPort)) hostPort += 1;
        if (hostPort > this.policy.lastPort) throw new PreviewRuntimeError("WORKSPACE_STATE_CONFLICT", "The preview loopback lease range is exhausted.");
        const record = previewLeaseSchema.parse({ version: 1, leaseId: this.createId(), operationId, ...association,
          previewKey: target.key, containerPort: target.containerPort, hostIp: DOCKER_LOOPBACK_HOST,
          hostPort, containerId: null, state: "reserved" });
        await this.writer.write(leasePath(this.leasesRoot, record.leaseId), record);
        records.push(record); usedPorts.add(hostPort);
        result.push({ leaseId: record.leaseId, previewKey: record.previewKey, containerPort: record.containerPort,
          hostIp: record.hostIp, hostPort: record.hostPort });
      }
      return result;
    });
  }
  async leasesFor(association: RuntimeAssociation): Promise<PreviewLease[]> {
    await this.reconcileDetachedLeases();
    return (await this.all()).filter((record) => sameAssociation(record, association));
  }
  async resolveLease(leaseId: string): Promise<{ readonly leaseId: string; readonly hostIp: "127.0.0.1"; readonly hostPort: number } | null> {
    const parsedLeaseId = uuidV7Schema.safeParse(leaseId);
    if (!parsedLeaseId.success) return null;
    const record = (await this.all()).find((candidate) => candidate.leaseId === parsedLeaseId.data);
    if (record === undefined || record.state !== "owned" || record.containerId === null) return null;
    return { leaseId: record.leaseId, hostIp: record.hostIp, hostPort: record.hostPort };
  }
  async bindContainer(association: RuntimeAssociation, containerId: string, bindings: readonly RuntimePreviewBinding[]): Promise<void> {
    await this.withLock(async () => {
      for (const binding of bindings) {
        const file = leasePath(this.leasesRoot, binding.leaseId);
        const record = await readStrictJson(file, previewLeaseSchema);
        if (!sameAssociation(record, association) || record.previewKey !== binding.previewKey
          || record.containerPort !== binding.containerPort || record.hostPort !== binding.hostPort) {
          throw new PreviewRuntimeError("WORKSPACE_STATE_CONFLICT", "The preview lease does not match exact runtime ownership.");
        }
        await this.writer.write(file, previewLeaseSchema.parse({ ...record, containerId, state: "owned" }));
      }
    });
  }
  async releaseOperationLeases(association: RuntimeAssociation, operationId: string): Promise<void> {
    await this.withLock(async () => {
      await this.reconcileDetachedLeases();
      for (const record of await this.all()) {
        if (!sameAssociation(record, association) || record.operationId !== operationId || record.containerId !== null) continue;
        await unlink(leasePath(this.leasesRoot, record.leaseId));
      }
    });
  }
  async releaseIfContainerRemoved(leaseId: string): Promise<boolean> {
    const file = leasePath(this.leasesRoot, leaseId);
    try {
      const record = await readStrictJson(file, previewLeaseSchema);
      if (record.containerId === null) return false;
      await this.engine.inspectContainer(record.containerId);
      return false;
    } catch (error) {
      if (error instanceof DockerEngineError && error.statusCode === 404) {
        await unlink(file).catch((unlinkError: NodeJS.ErrnoException) => { if (unlinkError.code !== "ENOENT") throw unlinkError; });
        return true;
      }
      throw error;
    }
  }
}

export interface PreviewRuntimeClock { now(): number }

export class PreviewRuntimeManager {
  private readonly previewsRoot: string;
  readonly leases: PreviewLeaseAllocator;
  constructor(
    stateRoot: string,
    private readonly engine: DockerEngineClient,
    private readonly runtime: WorkspaceRuntimeManager,
    private readonly previewBaseRegistry: ApprovedPreviewBaseRegistry = readPreviewBaseRegistry(),
    writer: AtomicJsonWriter = durableJsonWriter,
    probe: PreviewGatewayProbe = new UnavailablePreviewGatewayProbe(),
    private readonly createId: () => string = uuidv7,
    private readonly clock: PreviewRuntimeClock = { now: () => Date.now() },
    leasePolicy: PreviewLeasePolicy = readPreviewLeasePolicy(),
    private readonly gateway: PreviewGatewayAdapter | null = null,
    private readonly workspaceIdentity: PreviewWorkspaceIdentityResolver = () => Promise.resolve(null)
  ) {
    this.previewsRoot = path.join(path.resolve(stateRoot), "previews");
    this.leases = new PreviewLeaseAllocator(stateRoot, engine, leasePolicy, writer, createId);
    this.writer = writer;
    this.probe = gateway ?? probe;
  }
  private readonly writer: AtomicJsonWriter;
  private readonly probe: PreviewGatewayProbe;
  async initialize(): Promise<void> {
    await establishPinnedDirectory(this.previewsRoot);
    await this.leases.initialize();
    for (const name of await readdir(this.previewsRoot)) {
      if (!name.endsWith(".json")) throw new Error("unexpected-preview-state-entry");
      const record = await readStrictJson(path.join(this.previewsRoot, name), previewStateSchema);
      if (name !== `${record.previewId}.json`) throw new Error("preview-state-filename-mismatch");
    }
  }
  private async load(previewId: string): Promise<PreviewState | null> {
    try { return await readStrictJson(previewPath(this.previewsRoot, previewId), previewStateSchema); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private async save(record: PreviewState): Promise<void> {
    await this.writer.write(previewPath(this.previewsRoot, record.previewId), previewStateSchema.parse(record));
  }
  private route(record: PreviewState, lease: PreviewLease): PreviewGatewayRoute {
    return { projectId: record.projectId, workspaceId: record.workspaceId, previewId: record.previewId,
      revisionId: record.revisionId, generation: record.generation, hostname: record.hostname,
      approvedBaseId: record.domainBaseId,
      leaseId: lease.leaseId, hostIp: lease.hostIp, hostPort: lease.hostPort,
      webSocketForwarding: record.webSocketForwarding };
  }
  private association(record: PreviewState): RuntimeAssociation {
    return { projectId: record.projectId, workspaceId: record.workspaceId, revisionId: record.revisionId,
      revisionHash: record.revisionHash, runtimePlanHash: record.runtimePlanHash, generation: record.generation };
  }
  private async removeRoute(record: PreviewState): Promise<void> {
    if (this.gateway === null) return;
    // Route removal is fenced by the durable resource identity, not by the
    // lease record. A missing/released lease must not prevent removal of a
    // stale route that still points at the old host port.
    await this.gateway.removeRoute({
      projectId: record.projectId, workspaceId: record.workspaceId, previewId: record.previewId,
      revisionId: record.revisionId, generation: record.generation, hostname: record.hostname
    });
  }
  private config(options: ProjectOptionsV1, previewKey: string, revisionId?: string) {
    const preview = options.previews.find((candidate) => candidate.key === previewKey);
    if (preview === undefined) throw new PreviewRuntimeError("PREVIEW_NOT_DEFINED", `Preview ${previewKey} is not defined by the exact revision.`, {
      ...(revisionId === undefined ? {} : { revisionId }), previewKey
    });
    if (preview.target.kind === "service") {
      throw new PreviewRuntimeError("RUNTIME_POLICY_VIOLATION", `Preview ${previewKey} uses the unsupported-runtime-policy service target.`, {
        previewKey
      });
    }
    const declared = options.developmentEnvironment.ports.some((port) => port.containerPort === preview.containerPort);
    if (!declared) throw new PreviewRuntimeError("RUNTIME_POLICY_VIOLATION", `Preview ${previewKey} targets an undeclared workspace port.`, {
      previewKey
    });
    return preview;
  }
  private validatePersistedHostname(input: Pick<ActivatePreviewData, "hostname" | "projectSlug" | "workspaceSlug">,
    previewId: string, preview: ProjectOptionsV1["previews"][number]): string {
    const persisted = previewHostnameSchema.safeParse(input.hostname);
    if (!persisted.success) throw new PreviewRuntimeError("PREVIEW_DOMAIN_NOT_APPROVED", "The persisted preview hostname is malformed.", {
      previewId
    });
    const pattern = validatePreviewHostnamePattern(preview.hostnamePattern);
    if (!pattern.ok) throw new PreviewRuntimeError("PREVIEW_DOMAIN_NOT_APPROVED", "The configured preview hostname pattern is not approved.", {
      previewId
    });
    const result = composePreviewHostname(pattern.value, compositionValues(preview.hostnamePattern, {
      project: safeLabel(input.projectSlug, "project"),
      workspace: safeLabel(input.workspaceSlug, "workspace"),
      preview: safeLabel(preview.key, "preview"),
      shortId: safeLabel(previewId.slice(0, 8), "shortId")
    }), preview.domainBaseId, this.previewBaseRegistry);
    if (!result.ok) throw new PreviewRuntimeError("PREVIEW_DOMAIN_NOT_APPROVED", `The preview hostname is not approved: ${result.error.code}.`, {
      previewId
    });
    if (result.value !== persisted.data) {
      throw new PreviewRuntimeError("PREVIEW_DOMAIN_NOT_APPROVED", "The persisted preview hostname does not match the exact preview configuration.", {
        previewId
      });
    }
    return persisted.data;
  }
  private observation(record: PreviewState): PreviewInspectionData {
    return previewInspectionDataSchema.parse({ projectId: record.projectId, workspaceId: record.workspaceId,
      previewId: record.previewId, previewKey: record.previewKey, desiredState: record.desiredState,
      observedState: record.observedState, routePresent: record.routePresent, hostname: record.hostname });
  }
  private async markRuntimeLoss(record: PreviewState, error: unknown): Promise<PreviewState> {
    let routePresent = record.routePresent;
    let routeError: string | null = null;
    if (record.routePresent) {
      try { await this.removeRoute(record); routePresent = false; }
      catch (removalError) { routeError = removalError instanceof Error ? removalError.message.slice(0, 256) : "preview-route-removal-failed"; }
    }
    const next = { ...record, routePresent,
      observedState: "lost" as const, containerId: null,
      lastError: routeError ?? (error instanceof Error ? error.message.slice(0, 256) : "exact-runtime-unavailable") };
    await this.save(next);
    return next;
  }
  private async healthAttempt(record: PreviewState, association: RuntimeAssociation, force: boolean): Promise<PreviewState> {
    const now = this.clock.now();
    if (!force && now < record.nextAttemptAt) return record;
    let ownership: RuntimeOwnership;
    try { ownership = await this.runtime.exactRunningOwnership(association); }
    catch (error) { return await this.markRuntimeLoss(record, error); }
    const lease = (await this.leases.leasesFor(association)).find((candidate) => candidate.leaseId === record.leaseId);
    const binding = ownership.previewBindings.find((candidate) => candidate.leaseId === record.leaseId);
    if (lease === undefined || binding === undefined || lease.containerId !== ownership.developmentContainer.id
      || binding.hostIp !== DOCKER_LOOPBACK_HOST || binding.hostPort !== lease.hostPort) {
      return await this.markRuntimeLoss(record, new Error("preview-runtime-generation-or-lease-mismatch"));
    }
    const attempt = record.attempt + 1;
    const timeoutMs = record.startupTimeoutSeconds * 1000;
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<PreviewGatewayProbeResult>((resolve) => {
      timeout = setTimeout(() => { controller.abort(); resolve({ kind: "timeout" }); }, timeoutMs);
      timeout.unref();
    });
    let result: PreviewGatewayProbeResult;
    try {
      result = await Promise.race([this.probe.probe({ leaseId: record.leaseId, path: record.healthPath,
        acceptedStatuses: record.healthStatuses, deadlineMs: timeoutMs, signal: controller.signal,
        webSocketForwarding: record.webSocketForwarding }), deadline]);
    } catch (error) {
      result = { kind: "infrastructure", message: error instanceof Error ? error.message : "gateway-probe-failed" };
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
    const nextAttemptAt = this.clock.now() + Math.min(30_000, 250 * 2 ** Math.min(attempt - 1, 7));
    if (result.kind === "response" && record.healthStatuses.includes(result.statusCode)) {
      if (this.gateway !== null) {
        try { await this.gateway.ensureRoute(this.route(record, lease)); }
        catch (error) {
          let routePresent: boolean;
          let routeError: string | null = null;
          try { await this.removeRoute(record); routePresent = false; }
          catch (removalError) { routeError = removalError instanceof Error ? removalError.message.slice(0, 256) : "preview-route-removal-failed"; routePresent = true; }
          const next = { ...record, observedState: "failed" as const, routePresent,
            attempt, nextAttemptAt, lastStatusCode: result.statusCode,
            lastError: routeError ?? (error instanceof Error ? error.message.slice(0, 256) : "gateway-route-update-failed"),
            containerId: ownership.developmentContainer.id };
          await this.save(next); return next;
        }
      }
      const next = { ...record, observedState: "healthy" as const, routePresent: this.gateway !== null,
        attempt, nextAttemptAt, lastStatusCode: result.statusCode, lastError: null, containerId: ownership.developmentContainer.id };
      await this.save(next); return next;
    }
    let routePresent = record.routePresent;
    let routeError: string | null = null;
    if (record.routePresent) {
      try { await this.removeRoute(record); routePresent = false; }
      catch (removalError) { routeError = removalError instanceof Error ? removalError.message.slice(0, 256) : "preview-route-removal-failed"; }
    }
    const targetNotListening = result.kind === "infrastructure" && result.message === "The loopback preview target is unavailable.";
    if (result.kind === "infrastructure" && !targetNotListening) {
      const next = { ...record, observedState: "failed" as const, routePresent: false as const,
        attempt, nextAttemptAt, lastStatusCode: null, lastError: result.message.slice(0, 256), containerId: ownership.developmentContainer.id };
      await this.save({ ...next, routePresent, lastError: routeError ?? next.lastError }); return { ...next, routePresent, lastError: routeError ?? next.lastError };
    }
    const next = { ...record, observedState: "unhealthy" as const, routePresent,
      attempt, nextAttemptAt, lastStatusCode: result.kind === "response" ? result.statusCode : null,
      lastError: result.kind === "timeout" ? "health-attempt-timeout"
        : targetNotListening ? "health-target-not-listening" : "health-status-not-accepted",
      containerId: ownership.developmentContainer.id };
    await this.save({ ...next, lastError: routeError ?? next.lastError }); return { ...next, lastError: routeError ?? next.lastError };
  }
  async reserveWorkspaceLeases(association: RuntimeAssociation, options: ProjectOptionsV1, operationId: string): Promise<RuntimePreviewBinding[]> {
    return await this.leases.reserveWorkspaceLeases(association, options, operationId);
  }
  async bindRuntimeContainer(association: RuntimeAssociation, containerId: string, bindings: readonly RuntimePreviewBinding[]): Promise<void> {
    await this.leases.bindContainer(association, containerId, bindings);
  }
  async releaseOperationLeases(association: RuntimeAssociation, operationId: string): Promise<void> {
    await this.leases.releaseOperationLeases(association, operationId);
  }
  async resolvePreviewLease(leaseId: string): Promise<{ readonly leaseId: string; readonly hostIp: "127.0.0.1"; readonly hostPort: number } | null> {
    return await this.leases.resolveLease(leaseId);
  }
  async activate(input: ActivatePreviewData,
    association: RuntimeAssociation, options: ProjectOptionsV1, operationId: string): Promise<void> {
    uuidV7Schema.parse(input.projectId); uuidV7Schema.parse(input.workspaceId); uuidV7Schema.parse(input.previewId);
    previewKeySchema.parse(input.previewKey); uuidV7Schema.parse(operationId);
    if (input.projectId !== association.projectId || input.workspaceId !== association.workspaceId
      || input.revisionId !== association.revisionId) {
      throw new PreviewRuntimeError("WORKSPACE_STATE_CONFLICT", "The preview request does not match exact workspace ownership.");
    }
    const preview = this.config(options, input.previewKey, association.revisionId);
    const hostname = this.validatePersistedHostname(input, input.previewId, preview);
    const workspace = await this.workspaceIdentity(association.projectId, association.workspaceId);
    if (workspace === null || workspace.projectSlug !== input.projectSlug || workspace.workspaceSlug !== input.workspaceSlug) {
      throw new PreviewRuntimeError("WORKSPACE_STATE_CONFLICT", "The preview request does not match the Agent-owned workspace identity.");
    }
    const existing = await this.load(input.previewId);
    if (existing !== null) {
      if (!sameAssociation(existing, association) || existing.previewKey !== input.previewKey || existing.containerPort !== preview.containerPort) {
        throw new PreviewRuntimeError("WORKSPACE_STATE_CONFLICT", "The preview identity is bound to another revision or workspace.");
      }
      if (existing.operationId === operationId && existing.desiredState === "active") return;
    }
    const leases = await this.leases.leasesFor(association);
    const lease = leases.find((candidate) => candidate.previewKey === input.previewKey && candidate.containerPort === preview.containerPort);
    if (lease === undefined) throw new PreviewRuntimeError("WORKSPACE_STATE_CONFLICT", "The exact runtime has no reserved lease for this preview.");
    const state = previewStateSchema.parse(existing ?? { version: 1, previewId: input.previewId, projectId: association.projectId,
      workspaceId: association.workspaceId, previewKey: input.previewKey, revisionId: association.revisionId,
      revisionHash: association.revisionHash, runtimePlanHash: association.runtimePlanHash, generation: association.generation,
      hostname, domainBaseId: preview.domainBaseId, containerPort: preview.containerPort, healthPath: preview.healthPath, healthStatuses: [...preview.healthStatuses],
      startupTimeoutSeconds: preview.startupTimeoutSeconds, webSocketForwarding: preview.webSocketForwarding,
      leaseId: lease.leaseId, containerId: lease.containerId, desiredState: "active", observedState: "starting",
      routePresent: false, attempt: 0, nextAttemptAt: 0, lastStatusCode: null, lastError: null, operationId });
    const activated = { ...state, hostname, domainBaseId: preview.domainBaseId, desiredState: "active" as const,
      observedState: "starting" as const, routePresent: false, operationId };
    await this.save(activated);
    await this.healthAttempt(activated, association, true);
  }
  async deactivate(input: { projectId: string; workspaceId: string; revisionId: string; previewId: string }, operationId: string): Promise<void> {
    uuidV7Schema.parse(input.projectId); uuidV7Schema.parse(input.workspaceId); uuidV7Schema.parse(input.revisionId);
    const state = await this.load(input.previewId);
    if (state === null || state.projectId !== input.projectId || state.workspaceId !== input.workspaceId
      || state.revisionId !== input.revisionId) {
      throw new PreviewRuntimeError("RESOURCE_NOT_FOUND", "The preview is not owned by this workspace.");
    }
    if (state.operationId === operationId && state.desiredState === "inactive") return;
    if (state.routePresent) {
      try { await this.removeRoute(state); }
      catch (error) {
        throw new PreviewRuntimeError("GATEWAY_UPDATE_FAILED", error instanceof Error ? error.message : "The preview route could not be removed.", {
          previewId: state.previewId
        });
      }
    }
    await this.save({ ...state, desiredState: "inactive", observedState: "inactive", routePresent: false, operationId, nextAttemptAt: 0 });
  }
  async inspect(input: { projectId: string; workspaceId: string; revisionId: string; previewId: string }): Promise<PreviewInspectionData> {
    uuidV7Schema.parse(input.projectId); uuidV7Schema.parse(input.workspaceId); uuidV7Schema.parse(input.revisionId);
    const loaded = await this.load(input.previewId);
    if (loaded === null || loaded.projectId !== input.projectId || loaded.workspaceId !== input.workspaceId
      || loaded.revisionId !== input.revisionId) {
      throw new PreviewRuntimeError("RESOURCE_NOT_FOUND", "The preview is not owned by this workspace.");
    }
    let state: PreviewState = loaded;
    if (state.routePresent && this.gateway !== null) {
      const lease = (await this.leases.leasesFor(this.association(state))).find((candidate) => candidate.leaseId === state.leaseId);
      if (lease === undefined || !(await this.gateway.inspectRoute(this.route(state, lease))).present) {
        await this.save({ ...state, routePresent: false });
        state = { ...state, routePresent: false };
      }
    }
    const next = state.desiredState === "active" ? await this.healthAttempt(state, {
      projectId: state.projectId, workspaceId: state.workspaceId, revisionId: state.revisionId,
      revisionHash: state.revisionHash, runtimePlanHash: state.runtimePlanHash, generation: state.generation
    }, state.routePresent === false && loaded.routePresent) : state;
    return this.observation(next);
  }
  async workspaceStopped(association: RuntimeAssociation): Promise<void> {
    for (const record of await this.allStates()) {
      if (!sameAssociation(record, association) || record.desiredState !== "active") continue;
      let routePresent = record.routePresent;
      let lastError = record.lastError;
      if (record.routePresent) {
        try { await this.removeRoute(record); routePresent = false; }
        catch (error) { lastError = error instanceof Error ? error.message.slice(0, 256) : "preview-route-removal-failed"; }
      }
      await this.save({ ...record, observedState: "inactive", routePresent, containerId: record.containerId, lastError });
    }
  }
  async workspaceStarted(association: RuntimeAssociation): Promise<void> {
    for (const record of await this.allStates()) {
      if (!sameAssociation(record, association) || record.desiredState !== "active") continue;
      await this.healthAttempt(record, association, true);
    }
  }
  async reconcileRoutes(): Promise<void> {
    if (this.gateway === null) return;
    const desired: PreviewGatewayRoute[] = [];
    for (const record of await this.allStates()) {
      if (record.desiredState !== "active") continue;
      const next = await this.healthAttempt(record, this.association(record), true);
      if (next.observedState !== "healthy" || !next.routePresent) continue;
      const lease = (await this.leases.leasesFor(this.association(next))).find((candidate) => candidate.leaseId === next.leaseId);
      if (lease !== undefined) desired.push(this.route(next, lease));
    }
    await this.gateway.reconcileRoutes(desired);
  }
  private async allStates(): Promise<PreviewState[]> {
    return await Promise.all((await readdir(this.previewsRoot)).filter((name) => name.endsWith(".json")).map(async (name) =>
      await readStrictJson(path.join(this.previewsRoot, name), previewStateSchema)));
  }
  async snapshotResources(): Promise<AgentSnapshotResource[]> {
    return (await this.allStates()).map((record) => ({ type: "preview" as const, observation: this.observation(record) }));
  }
}

export { previewLeaseSchema, previewStateSchema, runtimePreviewBindingSchema };
