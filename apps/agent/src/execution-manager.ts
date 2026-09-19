import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  TERMINAL_FAILURE_CLOSE_CODE,
  TERMINAL_MAX_PAYLOAD_BYTES,
  TERMINAL_NORMAL_CLOSE_CODE,
  TERMINAL_PROTOCOL_ERROR_CLOSE_CODE,
  decodeTerminalClientFrame,
  encodeTerminalAgentFrame,
  f10ProcessInspectionDataSchema,
  processInspectionDataSchema,
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
import { DockerEngineClient, DockerEngineError } from "./docker-runtime.js";
import { AgentExecutionError, ManagedWorkspaces, type WorkspaceExecutionContext } from "./managed-workspaces.js";
import { durableJsonWriter, establishPinnedDirectory, readStrictJson, type AtomicJsonWriter } from "./private-state.js";

const REPLAY_LIMIT_BYTES = 64 * 1024;
const ATTACHMENT_BACKPRESSURE_BYTES = 256 * 1024;

const executionRecordSchema = z.strictObject({
  version: z.literal(1),
  kind: z.enum(["task", "terminal"]),
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
type ExecutionRecord = z.infer<typeof executionRecordSchema>;

type LiveExecution = {
  record: ExecutionRecord;
  stream: Duplex | null;
  attachment: WebSocket | null;
  attachmentReserved: boolean;
  attachmentCleanup: Promise<void> | null;
  replay: Buffer;
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

export class TaskStartRecoveryRequiredError extends Error {
  constructor() {
    super("The task start boundary is ambiguous; the exact retained exec must be inspected before the operation can complete.");
    this.name = "TaskStartRecoveryRequiredError";
  }
}

export class ExecutionManager {
  private readonly recordsRoot: string;
  private readonly executions = new Map<string, LiveExecution>();

  constructor(
    stateRoot: string,
    private readonly managed: ManagedWorkspaces,
    private readonly engine: DockerEngineClient,
    private readonly writer: AtomicJsonWriter = durableJsonWriter,
    private readonly now: () => Date = () => new Date()
  ) {
    this.recordsRoot = path.join(path.resolve(stateRoot), "ownership", "executions");
  }

  async initialize(): Promise<void> {
    await establishPinnedDirectory(this.recordsRoot);
    for (const name of await readdir(this.recordsRoot)) {
      if (!name.endsWith(".json")) throw new Error("unexpected-execution-ownership-entry");
      const record = await readStrictJson(path.join(this.recordsRoot, name), executionRecordSchema);
      if (name !== `${record.processId}.json`) throw new Error("execution-ownership-filename-mismatch");
      const live: LiveExecution = { record, stream: null, attachment: null, attachmentReserved: false,
        attachmentCleanup: null, replay: Buffer.alloc(0) };
      this.executions.set(record.processId, live);
      if (["queued", "starting", "running", "stopping"].includes(record.observedState)) {
        if (record.creationPhase === "reserved") continue;
        if (record.kind === "terminal") {
          live.record = { ...record, desiredState: "stopped", observedState: "lost", terminalState: "lost",
            exitCode: null, finishedAt: null };
          await this.persist(live);
        } else {
          await this.refresh(live);
          if (["running", "stopping"].includes(live.record.observedState)) {
            if (["running", "stopping"].includes(live.record.observedState)) this.monitorRecovered(live);
          }
        }
      }
    }
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
    if (!["queued", "starting", "running", "stopping"].includes(live.record.observedState)) return;
    if (live.record.creationPhase !== "started") return;
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
    const poll = async () => {
      await this.refresh(live).catch(() => undefined);
      if (["running", "stopping"].includes(live.record.observedState)) setTimeout(() => { poll().catch(() => undefined); }, 250).unref();
    };
    setTimeout(() => { poll().catch(() => undefined); }, 250).unref();
  }

  private attachStream(live: LiveExecution, stream: Duplex): void {
    live.stream = stream;
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
    stream.once("close", () => { void this.refresh(live).catch(() => undefined); });
    stream.once("end", () => { void this.refresh(live).catch(() => undefined); });
    stream.once("error", () => { void this.refresh(live).catch(() => undefined); });
    stream.resume();
  }

  private async createExec(context: WorkspaceExecutionContext, input: {
    kind: "task" | "terminal"; processId: string; terminalId: string | null; taskRunId: string | null;
    taskKey: string | null; successExitCodes: readonly number[]; command: readonly string[];
    workingDirectory: string; environment: Record<string, string>; attachStdin: boolean; tty: boolean;
    operationId: string | null;
  }): Promise<LiveExecution> {
    if (this.executions.has(input.processId)) throw failure("RESOURCE_STATE_CONFLICT", "The process identity is already in use.", {
      resource: { type: "process", id: input.processId }, action: "start"
    });
    const record: ExecutionRecord = {
      version: 1, kind: input.kind, projectId: context.projectId, workspaceId: context.workspaceId,
      processId: input.processId, terminalId: input.terminalId, taskRunId: input.taskRunId, taskKey: input.taskKey,
      successExitCodes: [...input.successExitCodes], revisionId: context.revisionId, revisionHash: context.revisionHash,
      runtimePlanHash: context.runtimePlanHash, generation: context.generation,
      containerId: context.ownership.developmentContainer.id, execId: null, operationId: input.operationId,
      creationPhase: "reserved", desiredState: "running", observedState: "queued",
      terminalState: input.kind === "terminal" ? "creating" : null,
      exitCode: null, startedAt: null, finishedAt: null
    };
    const live: LiveExecution = { record, stream: null, attachment: null, attachmentReserved: false,
      attachmentCleanup: null, replay: Buffer.alloc(0) };
    // The exact request/operation binding is durable before Docker sees a side effect.
    await this.persist(live);
    this.executions.set(record.processId, live);
    try {
      const execId = await this.engine.createExec(context.ownership.developmentContainer.id, {
        command: input.command, workingDirectory: input.workingDirectory,
        environment: input.environment,
        attachStdin: input.attachStdin, tty: input.tty
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
    let inspection: Awaited<ReturnType<DockerEngineClient["inspectExec"]>>;
    try {
      inspection = await this.engine.inspectExec(execId);
      for (let attempts = 0; !inspection.Running && inspection.ExitCode === null && attempts < 10; attempts += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        inspection = await this.engine.inspectExec(execId);
      }
    } catch {
      stream.destroy();
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
      stream?.destroy();
      throw new TaskStartRecoveryRequiredError();
    }
    if (!terminal && stream !== null) this.attachStream(live, stream);
    else stream?.destroy();
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
      kind: "task", processId: input.processId, terminalId: null, taskRunId: input.taskRunId, taskKey: task.key,
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
      kind: "terminal", processId: input.terminalId, terminalId: input.terminalId, taskRunId: null, taskKey: null,
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
  }): Promise<void> {
    const context = await this.managed.executionContext(input.projectId, input.workspaceId);
    const existing = [...this.executions.values()].find((live) => live.record.terminalId === input.terminalId);
    if (existing !== undefined) throw failure("RESOURCE_STATE_CONFLICT", "The terminal identity is already in use.", {
      resource: { type: "terminal", id: input.terminalId }, action: "create"
    });
    await this.createExec(context, {
      kind: "terminal", processId: input.processId, terminalId: input.terminalId, taskRunId: null, taskKey: null,
      successExitCodes: [0], command: [...input.command], workingDirectory: "/workspace",
      environment: { TERM: "xterm-256color", ...input.environment }, attachStdin: true, tty: true, operationId: null
    });
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

  reserveTerminalAttachment(terminalId: string): { attach(socket: WebSocket): Promise<void>; release(): void } {
    const live = [...this.executions.values()].find((candidate) => candidate.record.terminalId === uuidV7Schema.parse(terminalId));
    if (live === undefined) throw terminalNotFound(terminalId);
    if (live.attachmentReserved || live.attachment !== null || live.attachmentCleanup !== null
      || !["active", "disconnected"].includes(live.record.terminalState ?? "")) {
      throw failure("RESOURCE_STATE_CONFLICT", "The terminal cannot accept another attachment.", {
        resource: { type: "terminal", id: terminalId }, action: "attach"
      });
    }
    live.attachmentReserved = true;
    let claimed = false;
    return {
      release: () => { if (!claimed) live.attachmentReserved = false; },
      attach: async (socket) => {
        claimed = true; live.attachmentReserved = false; live.attachment = socket;
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
            void this.engine.resizeExec(live.record.execId, decoded.frame.columns, decoded.frame.rows)
              .catch(() => undefined);
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
