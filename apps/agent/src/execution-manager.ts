import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  TERMINAL_FAILURE_CLOSE_CODE,
  TERMINAL_MAX_PAYLOAD_BYTES,
  TERMINAL_NORMAL_CLOSE_CODE,
  TERMINAL_POST_EXIT_REPLAY_RETENTION_MS,
  TERMINAL_PROTOCOL_ERROR_CLOSE_CODE,
  decodeTerminalClientFrame,
  encodeTerminalAgentFrame,
  f10ProcessInspectionDataSchema,
  processInspectionDataSchema,
  configurationKeySchema,
  uuidV7Schema,
  type AgentExecutionFailure,
  type AgentSnapshotResource,
  type ProcessInspectionData,
  type StartTaskData,
  type TerminalIdentityData
} from "@devspace/contracts";
import type { ProjectOptionsV1 } from "@devspace/project-options";
import * as z from "zod";
import type WebSocket from "ws";
import { DockerEngineClient, DockerEngineError, DockerEngineTransportError } from "./docker-runtime.js";
import { AgentExecutionError, ManagedWorkspaces, type WorkspaceExecutionContext } from "./managed-workspaces.js";
import { durableJsonWriter, establishPinnedDirectory, readStrictJson, type AtomicJsonWriter } from "./private-state.js";

const REPLAY_LIMIT_BYTES = 64 * 1024;
const TERMINAL_REPLAY_DRAIN_WAIT_MS = 1_000;
const ATTACHMENT_BACKPRESSURE_BYTES = 256 * 1024;
const RECOVERED_HARNESS_POLL_INITIAL_MS = 250;
const RECOVERED_HARNESS_POLL_MAX_MS = 2_000;

const executionRecordSchema = z.strictObject({
  version: z.literal(1),
  kind: z.enum(["task", "terminal"]),
  executionRole: z.enum(["terminal", "harness", "task"]).optional(),
  harnessSessionId: uuidV7Schema.nullable().optional(),
  harnessGeneration: z.number().int().positive().nullable().optional(),
  harnessLeaseId: z.string().min(1).nullable().optional(),
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  processId: uuidV7Schema,
  terminalId: uuidV7Schema.nullable(),
  taskRunId: uuidV7Schema.nullable(),
  taskKey: z.string().nullable(),
  successExitCodes: z.array(z.number().int()),
  revisionId: uuidV7Schema,
  revisionHash: z.string(),
  runtimePlanHash: z.string(),
  generation: z.number().int().positive(),
  containerId: z.string().min(1),
  execId: z.string().min(1).nullable(),
  operationId: uuidV7Schema.nullable().default(null),
  // start-intent is private recovery evidence: Docker exec start is ambiguous
  // across an Agent crash, so the exact retained exec is inspected before any
  // retry is considered.
  creationPhase: z.enum(["reserved", "exec-created", "start-intent", "started"]),
  desiredState: z.enum(["running", "stopped"]),
  observedState: z.enum(["queued", "starting", "running", "stopping", "exited", "failed", "killed", "lost"]),
  terminalState: z.enum(["creating", "active", "disconnected", "closing", "closed", "failed", "lost"]).nullable(),
  exitCode: z.number().int().nullable(),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  finishedAt: z.string().datetime({ offset: true }).nullable()
});
type StoredExecutionRecord = z.infer<typeof executionRecordSchema>;
type ExecutionRole = "terminal" | "harness" | "task";
type ExecutionRecord = StoredExecutionRecord & {
  executionRole: ExecutionRole;
  harnessSessionId: string | null;
  harnessGeneration: number | null;
  harnessLeaseId: string | null;
};

export type HarnessProcessObservation = "running" | "terminated" | "definitely-gone" | "unproven";
export type HarnessRecoveryReport = {
  readonly processId: string;
  readonly workspaceId: string;
  readonly sessionId: string | null;
  readonly processGeneration: number | null;
  readonly leaseId: string | null;
  readonly observation: HarnessProcessObservation;
};

const legacyHarnessSessionSchema = z.object({
  workspaceId: uuidV7Schema,
  harnessId: configurationKeySchema,
  processId: uuidV7Schema,
  state: z.enum(["live", "stopped", "lost"]),
  leaseId: z.string().nullable(),
  processGeneration: z.number().int().positive()
});
const legacyLeaseSchema = z.object({
  leaseId: z.string().min(1),
  harnessId: configurationKeySchema,
  workspaceId: uuidV7Schema,
  aiSessionId: uuidV7Schema,
  processGeneration: z.number().int().positive()
});
const legacySlotMetaSchema = z.object({
  harnessId: configurationKeySchema,
  workspaceId: uuidV7Schema,
  leaseId: z.string().min(1),
  dirty: z.boolean()
});

function normalizeExecutionRecord(record: StoredExecutionRecord): ExecutionRecord {
  const executionRole = record.executionRole ?? (record.kind === "task" ? "task" : "terminal");
  return {
    ...record,
    executionRole,
    harnessSessionId: record.harnessSessionId ?? null,
    harnessGeneration: record.harnessGeneration ?? null,
    harnessLeaseId: record.harnessLeaseId ?? null
  };
}

export type HarnessRecoveryIdentity = {
  readonly processId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly processGeneration: number;
  readonly leaseId: string | null;
};

type LiveExecution = {
  record: ExecutionRecord;
  stream: Duplex | null;
  attachment: WebSocket | null;
  attachmentReserved: boolean;
  attachmentCleanup: Promise<void> | null;
  replay: Buffer;
  resizeFailureReported: boolean;
  terminalReplayExpiresAt: number | null;
  terminalReplayClaimed: boolean;
  terminalReplayTimer: NodeJS.Timeout | null;
  terminalReplayComplete: boolean;
  terminalReplayWaiters: Set<() => void>;
};

function failure(code: AgentExecutionFailure["code"], message: string, details: Record<string, unknown>): AgentExecutionError {
  return new AgentExecutionError({ code, message, retryable: code === "ROOTLESS_RUNTIME_UNAVAILABLE", details } as AgentExecutionFailure);
}

function processNotFound(processId: string): AgentExecutionError {
  return failure("RESOURCE_NOT_FOUND", "The process was not found.", { resource: { type: "process", id: processId } });
}

function terminalNotFound(terminalId: string): AgentExecutionError {
  return failure("RESOURCE_NOT_FOUND", "The terminal was not found.", { resource: { type: "terminal", id: terminalId } });
}

function taskDefinition(options: ProjectOptionsV1, taskKey: string) {
  const task = options.tasks.find((candidate) => candidate.key === taskKey);
  if (task === undefined) throw failure("TASK_NOT_DEFINED", "The configured task does not exist.", { taskKey });
  if (task.interactive || task.longRunning || task.timeoutSeconds !== null || task.concurrencyPolicy === "replace") {
    throw failure("RUNTIME_POLICY_VIOLATION", "This configured task uses execution controls deferred to M2.", {
      policy: "task-action-rejected"
    });
  }
  const environment: Record<string, string> = {};
  for (const [name, binding] of Object.entries(task.command.environment)) {
    if (binding.kind !== "literal") {
      throw failure("RUNTIME_POLICY_VIOLATION", "The task has an unresolved environment binding.", { policy: "task-action-rejected" });
    }
    environment[name] = binding.value;
  }
  const workingDirectory = path.posix.resolve("/workspace", task.command.workingDirectory);
  if (workingDirectory !== "/workspace" && !workingDirectory.startsWith("/workspace/")) {
    throw failure("RUNTIME_POLICY_VIOLATION", "The task working directory escapes the workspace.", { policy: "task-action-rejected" });
  }
  return { task, environment, workingDirectory };
}

export function isSuccessfulTaskExitCode(successExitCodes: readonly number[], exitCode: number): boolean {
  return successExitCodes.includes(exitCode);
}

export function harnessExecutionAdmissionUncertain(error: unknown): boolean {
  return error instanceof TaskStartRecoveryRequiredError;
}

export class TaskStartRecoveryRequiredError extends Error {
  constructor() {
    super("The task start boundary is ambiguous; the exact retained exec must be inspected before the operation can complete.");
    this.name = "TaskStartRecoveryRequiredError";
  }
}

export type HarnessExecutionSettlement = {
  readonly processId: string;
  readonly terminalId: string;
  readonly observedState: "exited" | "failed" | "killed" | "lost";
  readonly exitCode: number | null;
};

export type HarnessAdmissionIdentity = {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly processId: string;
  readonly terminalId: string;
  readonly sessionId: string;
  readonly processGeneration: number;
  readonly leaseId: string | null;
};

export type HarnessAdmissionReconciliation =
  | "attachable-running"
  | "running-without-stream"
  | "settled"
  | "uncertain";

export type HarnessAdmissionPhaseRunner = <T>(
  phase: "workspace-runtime-validation" | "executable-probe" | "docker-exec-creation",
  operation: () => Promise<T>
) => Promise<T>;

export type TerminalResizeFailureDiagnostic = {
  readonly processId: string;
  readonly terminalId: string;
  readonly columns: number;
  readonly rows: number;
  readonly failureClass: "docker-http" | "docker-transport" | "unknown";
  readonly failureCode: number | null;
};

export class ExecutionManager {
  private readonly recordsRoot: string;
  private readonly stateRoot: string;
  private readonly recoveryReports: HarnessRecoveryReport[] = [];
  private readonly executions = new Map<string, LiveExecution>();
  private readonly harnessProcessIds = new Set<string>();
  private readonly settledHarnessProcessIds = new Set<string>();

  constructor(
    stateRoot: string,
    private readonly managed: ManagedWorkspaces,
    private readonly engine: DockerEngineClient,
    private readonly writer: AtomicJsonWriter = durableJsonWriter,
    private readonly now: () => Date = () => new Date(),
    private readonly hooks: {
      readonly onHarnessSettled?: (event: HarnessExecutionSettlement) => void | Promise<void>;
      readonly onHarnessRecovered?: (event: HarnessRecoveryIdentity) => void | Promise<void>;
      readonly onTerminalResizeFailure?: (event: TerminalResizeFailureDiagnostic) => void;
    } = {}
  ) {
    this.recordsRoot = path.join(path.resolve(stateRoot), "ownership", "executions");
    this.stateRoot = path.resolve(stateRoot);
  }

  harnessRecoveryReports(): readonly HarnessRecoveryReport[] {
    return [...this.recoveryReports];
  }

  async initialize(): Promise<void> {
    await establishPinnedDirectory(this.recordsRoot);
    this.recoveryReports.length = 0;
    for (const name of await readdir(this.recordsRoot)) {
      if (!name.endsWith(".json")) throw new Error("unexpected-execution-ownership-entry");
      const stored = await readStrictJson(path.join(this.recordsRoot, name), executionRecordSchema);
      if (name !== `${stored.processId}.json`) throw new Error("execution-ownership-filename-mismatch");
      const adopted = await this.adoptLegacyHarness(stored);
      if (adopted.kind === "ambiguous") {
        await this.retainUnclassifiedTerminalAsLost(stored);
        continue;
      }
      const normalized = normalizeExecutionRecord(stored);
      const record = adopted.kind === "harness"
        ? {
          ...normalized,
          executionRole: "harness" as const,
          harnessSessionId: adopted.sessionId,
          harnessGeneration: adopted.processGeneration,
          harnessLeaseId: adopted.leaseId
        }
        : normalized;
      const live: LiveExecution = { record, stream: null, attachment: null, attachmentReserved: false,
        attachmentCleanup: null, replay: Buffer.alloc(0), resizeFailureReported: false,
        terminalReplayExpiresAt: null, terminalReplayClaimed: false, terminalReplayTimer: null,
        terminalReplayComplete: true, terminalReplayWaiters: new Set() };
      this.executions.set(record.processId, live);
      if (adopted.kind === "harness" && (stored.executionRole !== "harness"
        || stored.harnessSessionId !== adopted.sessionId || stored.harnessGeneration !== adopted.processGeneration
        || stored.harnessLeaseId !== adopted.leaseId)) {
        await this.persist(live);
      }
      const pendingRecoveredHarness = record.executionRole === "harness"
        && record.terminalState === "lost";
      const completedHarnessPendingSettlement = record.executionRole === "harness"
        && ["exited", "failed", "killed"].includes(record.observedState)
        && await this.privateHarnessSettlementPending(record);
      if (["queued", "starting", "running", "stopping"].includes(record.observedState)
        || pendingRecoveredHarness || completedHarnessPendingSettlement) {
        if (record.executionRole === "harness") {
          await this.reconcileRecoveredHarness(live);
        } else if (record.creationPhase === "reserved") {
          continue;
        } else if (record.kind === "terminal") {
          live.record = { ...live.record, desiredState: "stopped", observedState: "lost", terminalState: "lost",
            exitCode: null, finishedAt: null };
          await this.persist(live);
        } else {
          await this.refresh(live);
          if (["running", "stopping"].includes(live.record.observedState)) this.monitorRecovered(live);
        }
      }
    }
  }

  private async retainUnclassifiedTerminalAsLost(stored: StoredExecutionRecord): Promise<void> {
    if (stored.kind !== "terminal" || !["queued", "starting", "running", "stopping"].includes(stored.observedState)) return;
    const retained: StoredExecutionRecord = {
      ...stored,
      desiredState: "stopped",
      observedState: "lost",
      terminalState: "lost",
      exitCode: null,
      finishedAt: null
    };
    const live: LiveExecution = {
      record: normalizeExecutionRecord(retained), stream: null, attachment: null, attachmentReserved: false,
      attachmentCleanup: null, replay: Buffer.alloc(0), resizeFailureReported: false,
      terminalReplayExpiresAt: null, terminalReplayClaimed: false, terminalReplayTimer: null,
      terminalReplayComplete: true, terminalReplayWaiters: new Set()
    };
    this.executions.set(stored.processId, live);
    // Preserve the legacy shape so a later startup can still reconcile it if
    // the private harness evidence becomes readable.
    await this.writer.write(this.recordPath(stored.processId), executionRecordSchema.parse(retained));
  }

  private async adoptLegacyHarness(stored: StoredExecutionRecord): Promise<
    { kind: "ambiguous" } | { kind: "harness"; sessionId: string; processGeneration: number; leaseId: string | null }
      | { kind: "ordinary" }
  > {
    if (stored.kind === "task") return stored.executionRole === "harness" ? { kind: "ambiguous" } : { kind: "ordinary" };
    if (stored.executionRole === "terminal" || stored.executionRole === "task") return { kind: "ordinary" };
    if (stored.executionRole === "harness" && typeof stored.harnessSessionId === "string"
      && typeof stored.harnessGeneration === "number") {
      return {
        kind: "harness",
        sessionId: stored.harnessSessionId,
        processGeneration: stored.harnessGeneration,
        leaseId: stored.harnessLeaseId ?? null
      };
    }
    const sessionsRoot = path.join(this.stateRoot, "harness-sessions");
    let names: string[];
    try { names = await readdir(sessionsRoot); }
    catch { return stored.executionRole === "harness" ? { kind: "ambiguous" } : { kind: "ordinary" }; }
    const matches: Array<{ sessionId: string; session: z.infer<typeof legacyHarnessSessionSchema> }> = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const sessionId = name.slice(0, -".json".length);
      if (!uuidV7Schema.safeParse(sessionId).success) return { kind: "ambiguous" };
      let session: z.infer<typeof legacyHarnessSessionSchema>;
      try { session = legacyHarnessSessionSchema.parse(await readStrictJson(path.join(sessionsRoot, name), legacyHarnessSessionSchema)); }
      catch { return { kind: "ambiguous" }; }
      if (session.processId !== stored.processId || !(session.state === "live" || (session.state === "lost" && session.leaseId !== null))) continue;
      matches.push({ sessionId, session });
    }
    if (matches.length === 0) return stored.executionRole === "harness" ? { kind: "ambiguous" } : { kind: "ordinary" };
    if (matches.length !== 1) return { kind: "ambiguous" };
    const { sessionId, session } = matches[0]!;
    if (stored.kind !== "terminal" || stored.terminalId === null || stored.taskRunId !== null || stored.taskKey !== null
      || session.workspaceId !== stored.workspaceId || session.leaseId === null
      || (stored.harnessSessionId !== undefined && stored.harnessSessionId !== null && stored.harnessSessionId !== sessionId)
      || (stored.harnessGeneration !== undefined && stored.harnessGeneration !== null && stored.harnessGeneration !== session.processGeneration)
      || (stored.harnessLeaseId !== undefined && stored.harnessLeaseId !== null && stored.harnessLeaseId !== session.leaseId)) return { kind: "ambiguous" };
    let lease: z.infer<typeof legacyLeaseSchema>;
    let meta: z.infer<typeof legacySlotMetaSchema>;
    try {
      lease = legacyLeaseSchema.parse(await readStrictJson(path.join(this.stateRoot, "harness-homes", session.harnessId, ".lease", "metadata.json"), legacyLeaseSchema));
      meta = legacySlotMetaSchema.parse(await readStrictJson(path.join(this.stateRoot, "harness-meta", `${session.workspaceId}.json`), legacySlotMetaSchema));
    } catch { return { kind: "ambiguous" }; }
    if (lease.aiSessionId !== sessionId || lease.workspaceId !== session.workspaceId || lease.harnessId !== session.harnessId
      || lease.processGeneration !== session.processGeneration || lease.leaseId !== session.leaseId) return { kind: "ambiguous" };
    if (meta.workspaceId !== session.workspaceId || meta.harnessId !== session.harnessId || meta.leaseId !== session.leaseId || meta.dirty !== true) {
      return { kind: "ambiguous" };
    }
    if (stored.containerId.length < 1 || stored.execId === null) return { kind: "ambiguous" };
    return { kind: "harness", sessionId, processGeneration: session.processGeneration, leaseId: session.leaseId };
  }

  private async privateHarnessSettlementPending(record: ExecutionRecord): Promise<boolean> {
    if (record.harnessSessionId === null || record.harnessGeneration === null) return false;
    try {
      const session = await readStrictJson(
        path.join(this.stateRoot, "harness-sessions", `${uuidV7Schema.parse(record.harnessSessionId)}.json`),
        legacyHarnessSessionSchema
      );
      return session.processId === record.processId && session.workspaceId === record.workspaceId
        && session.processGeneration === record.harnessGeneration && session.leaseId === record.harnessLeaseId
        && (session.state === "live" || (session.state === "lost" && session.leaseId !== null));
    } catch {
      return false;
    }
  }

  private async containerCannotRun(containerId: string): Promise<boolean> {
    try {
      const inspection = await this.engine.inspectContainer(containerId);
      if (inspection.Id !== containerId) return false;
      return inspection.State?.Running === false;
    } catch (error) {
      return error instanceof DockerEngineError && error.statusCode === 404;
    }
  }

  private async harnessObservation(live: LiveExecution): Promise<HarnessProcessObservation> {
    if (live.record.execId === null) return "unproven";
    try {
      const inspection = await this.engine.inspectExec(live.record.execId);
      if (inspection.ID !== live.record.execId || inspection.ContainerID !== live.record.containerId) return "unproven";
      if (inspection.ExitCode !== null) return "terminated";
      if (await this.containerCannotRun(live.record.containerId)) return "definitely-gone";
      return inspection.Running ? "running" : "unproven";
    } catch (error) {
      if (error instanceof DockerEngineError && error.statusCode === 404) {
        return await this.containerCannotRun(live.record.containerId) ? "definitely-gone" : "unproven";
      }
      return "unproven";
    }
  }

  private async reconcileRecoveredHarness(live: LiveExecution): Promise<void> {
    const observation = await this.harnessObservation(live);
    this.recoveryReports.push({
      processId: live.record.processId,
      workspaceId: live.record.workspaceId,
      sessionId: live.record.harnessSessionId,
      processGeneration: live.record.harnessGeneration,
      leaseId: live.record.harnessLeaseId,
      observation
    });
    this.harnessProcessIds.add(live.record.processId);
    live.record = { ...live.record, terminalState: "lost", exitCode: null, finishedAt: null };
    if (observation === "running") {
      live.record = { ...live.record, observedState: "running" };
      await this.persist(live);
      this.monitorRecovered(live);
      return;
    }
    if (observation === "terminated" || observation === "definitely-gone") {
      live.record = { ...live.record, desiredState: "stopped", observedState: "lost", terminalState: "lost", finishedAt: null };
      await this.persist(live);
      await this.notifyHarnessRecovered(live).catch(() => undefined);
      if (!this.settledHarnessProcessIds.has(live.record.processId) && live.record.execId !== null) this.monitorRecovered(live);
      return;
    }
    live.record = { ...live.record, observedState: "lost" };
    await this.persist(live);
    if (live.record.execId !== null) this.monitorRecovered(live);
  }

  private recordPath(processId: string): string { return path.join(this.recordsRoot, `${uuidV7Schema.parse(processId)}.json`); }
  private async persist(live: LiveExecution): Promise<void> {
    await this.writer.write(this.recordPath(live.record.processId), executionRecordSchema.parse(live.record));
  }

  private assertContext(record: ExecutionRecord, context: WorkspaceExecutionContext): void {
    if (record.projectId !== context.projectId || record.workspaceId !== context.workspaceId
      || record.revisionId !== context.revisionId || record.revisionHash !== context.revisionHash
      || record.runtimePlanHash !== context.runtimePlanHash || record.generation !== context.generation
      || record.containerId !== context.ownership.developmentContainer.id) {
      throw failure("PROCESS_IDENTITY_MISMATCH", "The process no longer matches exact runtime ownership.", { processId: record.processId });
    }
  }

  private async inspectOwned(live: LiveExecution): Promise<Awaited<ReturnType<DockerEngineClient["inspectExec"]>>> {
    if (live.record.execId === null) {
      throw failure("PROCESS_IDENTITY_MISMATCH", "The execution has no durably retained Docker exec identity.", {
        processId: live.record.processId
      });
    }
    const context = await this.managed.executionContext(live.record.projectId, live.record.workspaceId);
    this.assertContext(live.record, context);
    const inspection = await this.engine.inspectExec(live.record.execId);
    if (inspection.ID !== live.record.execId || inspection.ContainerID !== live.record.containerId) {
      throw failure("PROCESS_IDENTITY_MISMATCH", "The Docker exec identity no longer matches the retained process.", { processId: live.record.processId });
    }
    return inspection;
  }

  private async refresh(live: LiveExecution): Promise<void> {
    const recoveredHarnessLost = live.record.executionRole === "harness" && live.record.terminalState === "lost";
    if (recoveredHarnessLost && this.settledHarnessProcessIds.has(live.record.processId)) return;
    if (!["queued", "starting", "running", "stopping"].includes(live.record.observedState) && !recoveredHarnessLost) return;
    if (live.record.creationPhase !== "started") return;
    if (recoveredHarnessLost) {
      const observation = await this.harnessObservation(live);
      if (observation === "running") {
        live.record = { ...live.record, observedState: "running", exitCode: null, finishedAt: null };
        await this.persist(live);
        return;
      }
      if (observation === "unproven") {
        live.record = { ...live.record, observedState: "lost", exitCode: null, finishedAt: null };
        await this.persist(live);
        return;
      }
      live.record = { ...live.record, desiredState: "stopped", observedState: "lost", terminalState: "lost", finishedAt: null };
      await this.persist(live);
      await this.notifyHarnessRecovered(live).catch(() => undefined);
      return;
    }
    try {
      const inspection = await this.inspectOwned(live);
      if (inspection.Running) return;
      // Docker reports a created, never-started exec with a null ExitCode. A
      // started exec that has terminated has an exact, non-null exit code.
      if (inspection.ExitCode === null) return;
      const stopped = live.record.desiredState === "stopped";
      const successful = isSuccessfulTaskExitCode(live.record.successExitCodes, inspection.ExitCode);
      live.record = { ...live.record, observedState: stopped ? "killed" : successful ? "exited" : "failed",
        exitCode: inspection.ExitCode, finishedAt: this.now().toISOString(), terminalState: live.record.kind === "terminal" ? "closed" : null };
      await this.persist(live);
      this.retainTerminalReplay(live);
      await this.notifyHarnessSettled(live).catch(() => undefined);
      if (live.attachment !== null && live.attachment.readyState === live.attachment.OPEN) {
        live.attachment.send(encodeTerminalAgentFrame({ type: "exit", exitCode: inspection.ExitCode }), { binary: true });
        live.attachment.close(TERMINAL_NORMAL_CLOSE_CODE);
      }
    } catch (error) {
      if (error instanceof AgentExecutionError && error.failure.code === "WORKSPACE_STATE_CONFLICT") {
        live.record = { ...live.record, observedState: "lost", exitCode: null, finishedAt: null,
          terminalState: live.record.kind === "terminal" ? "lost" : null };
        await this.persist(live);
        return;
      }
      if (error instanceof DockerEngineError && error.statusCode === 404) {
        live.record = { ...live.record, observedState: "lost", exitCode: null, finishedAt: null,
          terminalState: live.record.kind === "terminal" ? "lost" : null };
        await this.persist(live);
        return;
      }
      throw error;
    }
  }

  private monitorRecovered(live: LiveExecution): void {
    let delayMs = RECOVERED_HARNESS_POLL_INITIAL_MS;
    const poll = async () => {
      await this.refresh(live).catch(() => undefined);
      const recoveredHarnessPending = live.record.executionRole === "harness" && live.record.terminalState === "lost"
        && !this.settledHarnessProcessIds.has(live.record.processId);
      if (["running", "stopping"].includes(live.record.observedState) || recoveredHarnessPending) {
        setTimeout(() => { poll().catch(() => undefined); }, delayMs).unref();
        if (recoveredHarnessPending) delayMs = Math.min(delayMs * 2, RECOVERED_HARNESS_POLL_MAX_MS);
      }
    };
    setTimeout(() => { poll().catch(() => undefined); }, delayMs).unref();
    if (live.record.executionRole === "harness" && live.record.terminalState === "lost") {
      delayMs = Math.min(delayMs * 2, RECOVERED_HARNESS_POLL_MAX_MS);
    }
  }

  private attachStream(live: LiveExecution, stream: Duplex): void {
    live.stream = stream;
    live.terminalReplayComplete = false;
    stream.on("data", (chunk: Buffer) => {
      if (live.record.kind !== "terminal") return;
      const data = Buffer.from(chunk);
      live.replay = Buffer.concat([live.replay, data]).subarray(-REPLAY_LIMIT_BYTES);
      const socket = live.attachment;
      if (socket === null || socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > ATTACHMENT_BACKPRESSURE_BYTES) {
        socket.close(TERMINAL_FAILURE_CLOSE_CODE, "Terminal relay backpressure limit reached.");
        return;
      }
      for (let offset = 0; offset < data.length; offset += TERMINAL_MAX_PAYLOAD_BYTES) {
        socket.send(encodeTerminalAgentFrame({ type: "output", data: data.subarray(offset, offset + TERMINAL_MAX_PAYLOAD_BYTES) }), { binary: true });
      }
    });
    stream.once("close", () => { this.completeTerminalReplay(live); void this.refresh(live).catch(() => undefined); });
    stream.once("end", () => { this.completeTerminalReplay(live); void this.refresh(live).catch(() => undefined); });
    stream.once("error", () => { this.completeTerminalReplay(live); void this.refresh(live).catch(() => undefined); });
    stream.resume();
  }

  private async createExec(context: WorkspaceExecutionContext, input: {
    kind: "task" | "terminal"; executionRole: ExecutionRole; harnessSessionId: string | null;
    harnessGeneration: number | null; harnessLeaseId: string | null;
    processId: string; terminalId: string | null; taskRunId: string | null;
    taskKey: string | null; successExitCodes: readonly number[]; command: readonly string[];
    workingDirectory: string; environment: Record<string, string>; attachStdin: boolean; tty: boolean;
    operationId: string | null;
  }): Promise<LiveExecution> {
    if (this.executions.has(input.processId)) throw failure("RESOURCE_STATE_CONFLICT", "The process identity is already in use.", {
      resource: { type: "process", id: input.processId }, action: "start"
    });
    const record: ExecutionRecord = {
      version: 1, kind: input.kind, executionRole: input.executionRole, harnessSessionId: input.harnessSessionId,
      harnessGeneration: input.harnessGeneration, harnessLeaseId: input.harnessLeaseId,
      projectId: context.projectId, workspaceId: context.workspaceId,
      processId: input.processId, terminalId: input.terminalId, taskRunId: input.taskRunId, taskKey: input.taskKey,
      successExitCodes: [...input.successExitCodes], revisionId: context.revisionId, revisionHash: context.revisionHash,
      runtimePlanHash: context.runtimePlanHash, generation: context.generation,
      containerId: context.ownership.developmentContainer.id, execId: null, operationId: input.operationId,
      creationPhase: "reserved", desiredState: "running", observedState: "queued",
      terminalState: input.kind === "terminal" ? "creating" : null,
      exitCode: null, startedAt: null, finishedAt: null
    };
    const live: LiveExecution = { record, stream: null, attachment: null, attachmentReserved: false,
      attachmentCleanup: null, replay: Buffer.alloc(0), resizeFailureReported: false,
      terminalReplayExpiresAt: null, terminalReplayClaimed: false, terminalReplayTimer: null,
      terminalReplayComplete: true, terminalReplayWaiters: new Set() };
    // The exact request/operation binding is durable before Docker sees a side effect.
    await this.persist(live);
    this.executions.set(record.processId, live);
    try {
      const execId = await this.engine.createExec(context.ownership.developmentContainer.id, {
        command: input.command, workingDirectory: input.workingDirectory,
        environment: input.environment,
        attachStdin: input.attachStdin, tty: input.tty,
        ...(input.tty ? { consoleSize: { columns: 80, rows: 24 } } : {})
      });
      const reserved = live.record;
      live.record = { ...reserved, execId, creationPhase: "exec-created", observedState: "starting" };
      try { await this.persist(live); }
      catch (error) { live.record = reserved; throw error; }
      await this.startReservedExec(live, input.tty);
      return live;
    } catch (error) {
      if (live.record.creationPhase === "reserved") {
        live.record = { ...live.record, desiredState: "stopped", observedState: "failed",
          terminalState: live.record.kind === "terminal" ? "failed" : null, finishedAt: this.now().toISOString() };
        await this.persist(live).catch(() => undefined);
      }
      throw error;
    }
  }

  private async startReservedExec(live: LiveExecution, tty: boolean): Promise<void> {
    if (live.record.execId === null || live.record.creationPhase === "reserved") {
      throw new Error("execution-side-effect-evidence-missing");
    }
    if (live.record.creationPhase === "started") return;
    const execId = live.record.execId;
    if (live.record.creationPhase === "exec-created") {
      const execCreated = live.record;
      live.record = { ...execCreated, creationPhase: "start-intent", observedState: "starting" };
      try { await this.persist(live); }
      catch (error) { live.record = execCreated; throw error; }
    }
    let stream: Duplex;
    try { stream = await this.engine.startExecAttached(execId, tty); }
    catch { throw new TaskStartRecoveryRequiredError(); }
    // Attach the bounded terminal buffer before inspecting the exec. A short
    // process can write its complete error and exit between start and inspect.
    if (tty && live.record.kind === "terminal") this.attachStream(live, stream);
    let inspection: Awaited<ReturnType<DockerEngineClient["inspectExec"]>>;
    try {
      inspection = await this.engine.inspectExec(execId);
      for (let attempts = 0; !inspection.Running && inspection.ExitCode === null && attempts < 10; attempts += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        inspection = await this.engine.inspectExec(execId);
      }
    } catch {
      // Keep a usable harness PTY when only the follow-up inspection failed.
      // The exact retained stream is the only supported way to attach again.
      if (live.record.executionRole !== "harness") stream.destroy();
      throw new TaskStartRecoveryRequiredError();
    }
    if (inspection.ContainerID !== live.record.containerId) {
      stream.destroy();
      throw failure("RUNTIME_POLICY_VIOLATION", "The Docker exec did not establish an exact observable execution.", {
        policy: live.record.kind === "task" ? "task-action-rejected" : "terminal-action-rejected"
      });
    }
    // A successful attached start is exact launch evidence even if the command
    // completed before the first inspect. Preserve that terminal observation;
    // never turn a completed task back into a second start attempt.
    await this.persistStartedObservation(live, inspection.Running ? null : inspection.ExitCode, stream);
  }

  private async persistStartedObservation(live: LiveExecution, exitCode: number | null, stream: Duplex | null): Promise<void> {
    const previous = live.record;
    const startedAt = previous.startedAt ?? this.now().toISOString();
    const terminal = exitCode !== null;
    live.record = { ...previous, creationPhase: "started", observedState: terminal
      ? isSuccessfulTaskExitCode(previous.successExitCodes, exitCode) ? "exited" : "failed" : "running",
      terminalState: live.record.kind === "terminal" ? terminal ? "closed" : "disconnected" : null,
      exitCode: terminal ? exitCode : null,
      startedAt,
      finishedAt: terminal ? this.now().toISOString() : null };
    try { await this.persist(live); }
    catch {
      live.record = previous;
      if (stream !== null && live.record.executionRole !== "harness") stream.destroy();
      throw new TaskStartRecoveryRequiredError();
    }
    if (live.record.kind === "terminal") {
      if (stream !== null && live.stream !== stream) this.attachStream(live, stream);
      if (terminal && (stream !== null || live.stream !== null)) this.retainTerminalReplay(live);
    } else if (stream !== null) {
      stream.destroy();
    }
    if (terminal) {
      // Settlement failure must not turn a started exec into a second launch.
      // flushHarnessSettlements retries until the hook succeeds once.
      await this.notifyHarnessSettled(live).catch(() => undefined);
    }
  }

  private async notifyHarnessRecovered(live: LiveExecution): Promise<boolean> {
    if (live.record.executionRole !== "harness" || live.record.harnessSessionId === null
      || live.record.harnessGeneration === null) return false;
    if (this.settledHarnessProcessIds.has(live.record.processId)) return true;
    this.settledHarnessProcessIds.add(live.record.processId);
    try {
      await this.hooks.onHarnessRecovered?.({
        processId: live.record.processId,
        workspaceId: live.record.workspaceId,
        sessionId: live.record.harnessSessionId,
        processGeneration: live.record.harnessGeneration,
        leaseId: live.record.harnessLeaseId
      });
      return true;
    } catch {
      this.settledHarnessProcessIds.delete(live.record.processId);
      throw new Error("harness-recovery-failed");
    }
  }

  private async notifyHarnessSettled(live: LiveExecution): Promise<void> {
    if (live.record.executionRole !== "harness" && !this.harnessProcessIds.has(live.record.processId)) return;
    if (live.record.terminalId === null) return;
    // A restart loss stays lost. Clean PTY exit is the only path that settles stopped.
    if (live.record.terminalState === "lost") return;
    if (!["exited", "failed", "killed"].includes(live.record.observedState)) return;
    if (this.settledHarnessProcessIds.has(live.record.processId)) return;
    this.settledHarnessProcessIds.add(live.record.processId);
    try {
      await this.hooks.onHarnessSettled?.({
        processId: live.record.processId,
        terminalId: live.record.terminalId,
        observedState: live.record.observedState as HarnessExecutionSettlement["observedState"],
        exitCode: live.record.exitCode
      });
    } catch {
      this.settledHarnessProcessIds.delete(live.record.processId);
      throw new Error("harness-settlement-failed");
    }
  }

  private activeTask(taskKey: string, workspaceId: string): LiveExecution[] {
    return [...this.executions.values()].filter((live) => live.record.kind === "task"
      && live.record.workspaceId === workspaceId && live.record.taskKey === taskKey
      && ["queued", "starting", "running", "stopping"].includes(live.record.observedState));
  }

  async startTask(input: StartTaskData, operationId: string | null = null): Promise<void> {
    const existing = this.executions.get(input.processId);
    if (existing !== undefined && existing.record.kind === "task" && existing.record.operationId === operationId) {
      if (existing.record.projectId !== input.projectId || existing.record.workspaceId !== input.workspaceId
        || existing.record.taskRunId !== input.taskRunId || existing.record.taskKey !== input.taskKey) {
        throw failure("PROCESS_IDENTITY_MISMATCH", "The operation ID is bound to a different task execution.", {
          processId: input.processId
        });
      }
      // Start success is the durable creation phase, not the task's later lifecycle outcome.
      if (existing.record.creationPhase === "started") return;
      if (existing.record.observedState === "failed") {
        throw failure("RESOURCE_STATE_CONFLICT", "This exact task start already failed and will not be rescheduled.", {
          resource: { type: "process", id: input.processId }, action: "start"
        });
      }
      const context = await this.managed.executionContext(input.projectId, input.workspaceId);
      this.assertContext(existing.record, context);
      const { task, environment, workingDirectory } = taskDefinition(context.options, input.taskKey);
      if (existing.record.creationPhase === "reserved") {
        const execId = await this.engine.createExec(existing.record.containerId, {
          command: [task.command.executable, ...task.command.args],
          workingDirectory,
          environment,
          attachStdin: false, tty: false
        });
        existing.record = { ...existing.record, execId, creationPhase: "exec-created", observedState: "starting" };
        await this.persist(existing);
      } else if (existing.record.execId !== null) {
        let inspection: Awaited<ReturnType<DockerEngineClient["inspectExec"]>>;
        try { inspection = await this.engine.inspectExec(existing.record.execId); }
        catch {
          if (existing.record.creationPhase === "start-intent") throw new TaskStartRecoveryRequiredError();
          throw new Error("retained-exec-inspection-failed-before-start-intent");
        }
        if (inspection.ID !== existing.record.execId || inspection.ContainerID !== existing.record.containerId) {
          throw failure("PROCESS_IDENTITY_MISMATCH", "The retained Docker exec no longer belongs to the task start.", {
            processId: input.processId
          });
        }
        if (inspection.Running) {
          await this.persistStartedObservation(existing, null, null);
          this.monitorRecovered(existing);
          return;
        }
        if (inspection.ExitCode !== null) {
          await this.persistStartedObservation(existing, inspection.ExitCode, null);
          return;
        }
      }
      await this.startReservedExec(existing, false);
      return;
    }
    const context = await this.managed.executionContext(input.projectId, input.workspaceId);
    const { task, environment, workingDirectory } = taskDefinition(context.options, input.taskKey);
    const active = this.activeTask(task.key, input.workspaceId);
    if (task.concurrencyPolicy === "reject" && active.length > 0) {
      throw failure("RESOURCE_STATE_CONFLICT", "The task already has an active run.", { resource: { type: "task-run", id: input.taskRunId }, action: "start" });
    }
    await this.createExec(context, {
      kind: "task", executionRole: "task", harnessSessionId: null, harnessGeneration: null, harnessLeaseId: null,
      processId: input.processId, terminalId: null, taskRunId: input.taskRunId, taskKey: task.key,
      successExitCodes: task.successExitCodes,
      command: [task.command.executable, ...task.command.args],
      workingDirectory, environment, attachStdin: false, tty: false, operationId
    });
  }

  async createTerminal(input: TerminalIdentityData): Promise<void> {
    const context = await this.managed.executionContext(input.projectId, input.workspaceId);
    const existing = [...this.executions.values()].find((live) => live.record.terminalId === input.terminalId);
    if (existing !== undefined) throw failure("RESOURCE_STATE_CONFLICT", "The terminal identity is already in use.", {
      resource: { type: "terminal", id: input.terminalId }, action: "create"
    });
    await this.createExec(context, {
      kind: "terminal", executionRole: "terminal", harnessSessionId: null, harnessGeneration: null, harnessLeaseId: null,
      processId: input.terminalId, terminalId: input.terminalId, taskRunId: null, taskKey: null,
      successExitCodes: [0], command: ["/bin/sh"], workingDirectory: "/workspace",
      environment: { TERM: "xterm-256color" }, attachStdin: true, tty: true, operationId: null
    });
  }

  async createHarness(input: {
    projectId: string;
    workspaceId: string;
    processId: string;
    terminalId: string;
    command: readonly string[];
    environment: Readonly<Record<string, string>>;
    sessionId: string;
    processGeneration: number;
    leaseId: string | null;
    measureAdmissionPhase?: HarnessAdmissionPhaseRunner;
  }): Promise<void> {
    const harnessSessionId = uuidV7Schema.parse(input.sessionId);
    if (!Number.isInteger(input.processGeneration) || input.processGeneration < 1) {
      throw new Error("harness-process-generation-invalid");
    }
    const measureAdmissionPhase: HarnessAdmissionPhaseRunner = input.measureAdmissionPhase
      ?? ((_phase, operation) => operation());
    const context = await measureAdmissionPhase("workspace-runtime-validation", async () =>
      await this.managed.executionContext(input.projectId, input.workspaceId));
    const existing = [...this.executions.values()].find((live) => live.record.terminalId === input.terminalId);
    if (existing !== undefined) throw failure("RESOURCE_STATE_CONFLICT", "The terminal identity is already in use.", {
      resource: { type: "terminal", id: input.terminalId }, action: "create"
    });
    this.harnessProcessIds.add(input.processId);
    await measureAdmissionPhase("docker-exec-creation", async () => await this.createExec(context, {
      kind: "terminal", executionRole: "harness", harnessSessionId, harnessGeneration: input.processGeneration,
      harnessLeaseId: input.leaseId,
      processId: input.processId, terminalId: input.terminalId, taskRunId: null, taskKey: null,
      successExitCodes: [0], command: [...input.command], workingDirectory: "/workspace",
      environment: { TERM: "xterm-256color", ...input.environment }, attachStdin: true, tty: true, operationId: null
    }));
  }

  async reconcileHarnessAdmission(input: HarnessAdmissionIdentity): Promise<HarnessAdmissionReconciliation> {
    const live = this.executions.get(uuidV7Schema.parse(input.processId));
    if (live === undefined) {
      throw failure("PROCESS_IDENTITY_MISMATCH", "The retained harness process was not found.", { processId: input.processId });
    }
    const record = live.record;
    if (record.kind !== "terminal" || record.executionRole !== "harness"
      || record.projectId !== input.projectId || record.workspaceId !== input.workspaceId
      || record.processId !== input.processId || record.terminalId !== input.terminalId
      || record.harnessSessionId !== input.sessionId || record.harnessGeneration !== input.processGeneration
      || record.harnessLeaseId !== input.leaseId || record.execId === null) {
      throw failure("PROCESS_IDENTITY_MISMATCH", "The retained process does not match this exact harness admission.", {
        processId: input.processId
      });
    }

    let context: WorkspaceExecutionContext;
    try {
      context = await this.managed.executionContext(input.projectId, input.workspaceId);
    } catch {
      return "uncertain";
    }
    this.assertContext(record, context);

    let inspection: Awaited<ReturnType<DockerEngineClient["inspectExec"]>>;
    try { inspection = await this.engine.inspectExec(record.execId); }
    catch { return "uncertain"; }
    if (inspection.ID !== record.execId || inspection.ContainerID !== record.containerId) {
      throw failure("PROCESS_IDENTITY_MISMATCH", "The retained Docker exec no longer matches this harness admission.", {
        processId: input.processId
      });
    }

    if (inspection.Running && inspection.ExitCode === null) {
      const stream = live.stream;
      if (stream !== null && !stream.destroyed && !stream.closed && stream.readable && !stream.readableEnded
        && stream.writable && !stream.writableEnded) {
        try { await this.persistStartedObservation(live, null, null); }
        catch { return "uncertain"; }
        return "attachable-running";
      }

      const previous = live.record;
      live.record = {
        ...previous,
        creationPhase: "started",
        desiredState: "running",
        observedState: "running",
        terminalState: "lost",
        exitCode: null,
        startedAt: previous.startedAt ?? this.now().toISOString(),
        finishedAt: null
      };
      try { await this.persist(live); }
      catch {
        live.record = previous;
        return "uncertain";
      }
      this.harnessProcessIds.add(record.processId);
      this.monitorRecovered(live);
      return "running-without-stream";
    }

    if (!inspection.Running && inspection.ExitCode !== null) {
      try { await this.persistStartedObservation(live, inspection.ExitCode, null); }
      catch { return "uncertain"; }
      return await this.privateHarnessSettlementPending(live.record) ? "uncertain" : "settled";
    }

    // In particular, start-intent + Running=false + ExitCode=null does not
    // prove that the original Docker start request had no side effect.
    return "uncertain";
  }

  private findProcess(projectId: string, workspaceId: string, processId: string): LiveExecution {
    const live = this.executions.get(uuidV7Schema.parse(processId));
    if (live === undefined) throw processNotFound(processId);
    if (live.record.projectId !== projectId || live.record.workspaceId !== workspaceId) {
      throw failure("PROCESS_IDENTITY_MISMATCH", "The process identity does not belong to this workspace.", { processId });
    }
    return live;
  }

  async inspect(projectId: string, workspaceId: string, processId: string): Promise<ProcessInspectionData> {
    const live = this.findProcess(projectId, workspaceId, processId);
    await this.refresh(live);
    return processInspectionDataSchema.parse({
      projectId, workspaceId, processId, kind: live.record.kind, desiredState: live.record.desiredState,
      observedState: live.record.observedState, exitCode: live.record.exitCode,
      startedAt: live.record.startedAt, finishedAt: live.record.finishedAt
    });
  }

  stop(projectId: string, workspaceId: string, processId: string): Promise<void> {
    this.findProcess(projectId, workspaceId, processId);
    return Promise.reject(failure("RESOURCE_STATE_CONFLICT", "This execution cannot be stopped safely in M1; stop the workspace runtime instead.", {
      resource: { type: "process", id: processId }, action: "stop"
    }));
  }

  closeTerminal(input: TerminalIdentityData): Promise<void> {
    const live = [...this.executions.values()].find((candidate) => candidate.record.terminalId === input.terminalId);
    if (live === undefined) throw terminalNotFound(input.terminalId);
    if (live.record.projectId !== input.projectId || live.record.workspaceId !== input.workspaceId) throw terminalNotFound(input.terminalId);
    return Promise.reject(failure("RESOURCE_STATE_CONFLICT", "A terminal cannot be forcefully closed safely in M1; detach instead.", {
      resource: { type: "terminal", id: input.terminalId }, action: "close"
    }));
  }

  stopWorkspace(projectId: string, workspaceId: string): Promise<void> {
    // The exact container lifecycle reclaims every exec when the workspace runtime stops.
    // M1 deliberately does not attempt to signal individual task or terminal descendants.
    void projectId; void workspaceId;
    return Promise.resolve();
  }

  shutdownTransports(): void {
    for (const live of this.executions.values()) {
      live.attachment?.close(1012, "Agent restarting.");
      live.stream?.destroy();
      live.stream = null;
    }
  }

  private requestAttachmentClose(socket: WebSocket): void {
    if (socket.readyState === socket.CLOSED) return;
    const candidate = socket as WebSocket & { terminate?: () => void };
    try {
      if (typeof candidate.terminate === "function") candidate.terminate();
      else socket.close(TERMINAL_FAILURE_CLOSE_CODE, "Terminal attachment cleanup.");
    } catch { /* close/error callbacks remain the authoritative finalizer */ }
  }

  private async waitForAttachmentClosed(socket: WebSocket): Promise<void> {
    if (socket.readyState === socket.CLOSED) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      socket.once("close", finish);
      const timeout = setTimeout(finish, 1_000);
      timeout.unref();
      this.requestAttachmentClose(socket);
      if (socket.readyState === socket.CLOSED) finish();
    });
  }

  private reportTerminalResizeFailure(live: LiveExecution, columns: number, rows: number, error: unknown): void {
    if (live.resizeFailureReported || live.record.terminalId === null) return;
    live.resizeFailureReported = true;
    let failureClass: TerminalResizeFailureDiagnostic["failureClass"] = "unknown";
    let failureCode: number | null = null;
    if (error instanceof DockerEngineError && Number.isInteger(error.statusCode)
      && error.statusCode >= 100 && error.statusCode <= 599) {
      failureClass = "docker-http";
      failureCode = error.statusCode;
    } else if (error instanceof DockerEngineTransportError) {
      failureClass = "docker-transport";
    }
    try {
      this.hooks.onTerminalResizeFailure?.({
        processId: live.record.processId,
        terminalId: live.record.terminalId,
        columns,
        rows,
        failureClass,
        failureCode
      });
    } catch {
      // Diagnostics must not turn a failed browser resize into a terminal failure.
    }
  }

  private retainTerminalReplay(live: LiveExecution): void {
    if (live.record.kind !== "terminal" || live.record.terminalState !== "closed"
      || live.terminalReplayExpiresAt !== null) return;
    live.terminalReplayExpiresAt = Date.now() + TERMINAL_POST_EXIT_REPLAY_RETENTION_MS;
    live.terminalReplayTimer = setTimeout(() => {
      live.replay = Buffer.alloc(0);
      live.terminalReplayExpiresAt = null;
      live.terminalReplayTimer = null;
    }, TERMINAL_POST_EXIT_REPLAY_RETENTION_MS);
    live.terminalReplayTimer.unref();
  }

  private completeTerminalReplay(live: LiveExecution): void {
    if (live.terminalReplayComplete) return;
    live.terminalReplayComplete = true;
    for (const wake of live.terminalReplayWaiters) wake();
    live.terminalReplayWaiters.clear();
  }

  private async waitForTerminalReplay(live: LiveExecution): Promise<void> {
    if (live.terminalReplayComplete || live.terminalReplayExpiresAt === null) return;
    const waitMs = Math.min(TERMINAL_REPLAY_DRAIN_WAIT_MS, Math.max(0, live.terminalReplayExpiresAt - Date.now()));
    if (waitMs === 0) return;
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        live.terminalReplayWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      live.terminalReplayWaiters.add(finish);
    });
  }

  private sendTerminalReplay(socket: WebSocket, replay: Buffer): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(encodeTerminalAgentFrame({ type: "ready" }), { binary: true });
    for (let offset = 0; offset < replay.length; offset += TERMINAL_MAX_PAYLOAD_BYTES) {
      socket.send(encodeTerminalAgentFrame({ type: "output", data: replay.subarray(offset, offset + TERMINAL_MAX_PAYLOAD_BYTES) }), { binary: true });
    }
  }

  reserveTerminalAttachment(terminalId: string): { attach(socket: WebSocket): Promise<void>; release(): void } {
    const live = [...this.executions.values()].find((candidate) => candidate.record.terminalId === uuidV7Schema.parse(terminalId));
    if (live === undefined) throw terminalNotFound(terminalId);
    const postExitReplay = live.record.terminalState === "closed"
      && live.terminalReplayExpiresAt !== null && Date.now() < live.terminalReplayExpiresAt
      && !live.terminalReplayClaimed;
    if (live.attachmentReserved || live.attachment !== null || live.attachmentCleanup !== null
      || (!postExitReplay && !["active", "disconnected"].includes(live.record.terminalState ?? ""))) {
      throw failure("RESOURCE_STATE_CONFLICT", "The terminal cannot accept another attachment.", {
        resource: { type: "terminal", id: terminalId }, action: "attach"
      });
    }
    live.attachmentReserved = true;
    let claimed = false;
    return {
      release: () => { if (!claimed) live.attachmentReserved = false; },
      attach: async (socket) => {
        claimed = true; live.attachmentReserved = false;
        if (postExitReplay) {
          live.terminalReplayClaimed = true;
          await this.waitForTerminalReplay(live);
          if (live.terminalReplayExpiresAt === null || Date.now() >= live.terminalReplayExpiresAt) {
            socket.close(TERMINAL_NORMAL_CLOSE_CODE);
            return;
          }
          const replay = live.replay;
          this.sendTerminalReplay(socket, replay);
          if (socket.readyState === socket.OPEN) {
            socket.send(encodeTerminalAgentFrame({ type: "exit", exitCode: live.record.exitCode }), { binary: true });
            socket.close(TERMINAL_NORMAL_CLOSE_CODE);
          }
          live.replay = Buffer.alloc(0);
          if (live.terminalReplayTimer !== null) clearTimeout(live.terminalReplayTimer);
          live.terminalReplayTimer = null;
          live.terminalReplayExpiresAt = null;
          return;
        }
        live.attachment = socket;
        let finishSetup!: () => void;
        const setupComplete = new Promise<void>((resolve) => { finishSetup = resolve; });
        let lostRequested = false;
        let finalization: Promise<void> | null = null;
        const finalizeAttachment = (lose: boolean): Promise<void> => {
          if (lose) lostRequested = true;
          this.requestAttachmentClose(socket);
          if (finalization !== null) return finalization;
          const cleanup = (async () => {
            await setupComplete;
            try {
              if (lostRequested) {
                live.record = { ...live.record, desiredState: "stopped", observedState: "lost",
                  terminalState: "lost", exitCode: null, finishedAt: null };
              } else if (live.record.terminalState === "active") {
                live.record = { ...live.record, terminalState: "disconnected" };
              }
              await this.persist(live);
            } catch {
              live.record = { ...live.record, desiredState: "stopped", observedState: "lost",
                terminalState: "lost", exitCode: null, finishedAt: null };
              await this.persist(live).catch(() => undefined);
            } finally {
              await this.waitForAttachmentClosed(socket);
              if (live.attachment === socket) live.attachment = null;
            }
          })();
          finalization = cleanup;
          live.attachmentCleanup = cleanup;
          void cleanup.finally(() => {
            if (live.attachmentCleanup === cleanup) live.attachmentCleanup = null;
          }).catch(() => undefined);
          return cleanup;
        };
        // Install cleanup before persistence or protocol work can fail.
        socket.once("close", () => { void finalizeAttachment(false).catch(() => undefined); });
        socket.once("error", () => { void finalizeAttachment(false).catch(() => undefined); });
        let attachError: Error | null = null;
        try {
          live.record = { ...live.record, terminalState: "active" }; await this.persist(live);
        socket.send(encodeTerminalAgentFrame({ type: "ready" }), { binary: true });
        if (live.replay.length > 0) {
          for (let offset = 0; offset < live.replay.length; offset += TERMINAL_MAX_PAYLOAD_BYTES) {
            socket.send(encodeTerminalAgentFrame({ type: "output", data: live.replay.subarray(offset, offset + TERMINAL_MAX_PAYLOAD_BYTES) }), { binary: true });
          }
        }
        socket.on("message", (data, isBinary) => {
          if (!isBinary || !(data instanceof Buffer) || data.length > TERMINAL_MAX_PAYLOAD_BYTES + 1) {
            socket.close(TERMINAL_PROTOCOL_ERROR_CLOSE_CODE, "Invalid terminal frame."); return;
          }
          const decoded = decodeTerminalClientFrame(data);
          if (!decoded.ok) { socket.close(TERMINAL_PROTOCOL_ERROR_CLOSE_CODE, decoded.error); return; }
          if (decoded.frame.type === "detach") { socket.close(TERMINAL_NORMAL_CLOSE_CODE); return; }
          if (decoded.frame.type === "resize") {
            if (live.record.execId === null) { socket.close(TERMINAL_FAILURE_CLOSE_CODE, "Terminal execution identity is unavailable."); return; }
            const { columns, rows } = decoded.frame;
            void this.engine.resizeExec(live.record.execId, columns, rows)
              .catch((error: unknown) => this.reportTerminalResizeFailure(live, columns, rows, error));
            return;
          }
          if (live.stream === null || live.stream.destroyed || live.stream.writableLength > ATTACHMENT_BACKPRESSURE_BYTES) {
            socket.close(TERMINAL_FAILURE_CLOSE_CODE, "Terminal input backpressure limit reached."); return;
          }
          live.stream.write(decoded.frame.data);
        });
        } catch (error) {
          attachError = error instanceof Error ? error : new Error("terminal-attachment-failed");
          void finalizeAttachment(true).catch(() => undefined);
        } finally {
          finishSetup();
        }
        if (attachError !== null) {
          await finalizeAttachment(true).catch(() => undefined);
          throw attachError;
        }
      }
    };
  }

  async flushHarnessSettlements(): Promise<void> {
    for (const live of this.executions.values()) {
      await this.notifyHarnessSettled(live);
    }
  }

  snapshotResources(): AgentSnapshotResource[] {
    const resources: AgentSnapshotResource[] = [];
    for (const live of this.executions.values()) {
      resources.push({ type: "process", observation: f10ProcessInspectionDataSchema.parse({
        projectId: live.record.projectId, workspaceId: live.record.workspaceId, processId: live.record.processId,
        kind: live.record.kind, desiredState: live.record.desiredState, observedState: live.record.observedState,
        exitCode: live.record.exitCode, startedAt: live.record.startedAt, finishedAt: live.record.finishedAt
      }) });
      if (live.record.kind === "terminal" && live.record.terminalId !== null && live.record.terminalState !== null) {
        resources.push({ type: "terminal", identity: { projectId: live.record.projectId, workspaceId: live.record.workspaceId,
          terminalId: live.record.terminalId }, state: live.record.terminalState });
      }
    }
    return resources;
  }
}
