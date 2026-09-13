import { spawn, type ChildProcess } from "node:child_process";
import { open, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { utcTimestampMsSchema, uuidV7Schema } from "@devspace/contracts";
import { v7 as uuidv7 } from "uuid";
import * as z from "zod";
import {
  PrivateStateCorruptionError,
  durableJsonWriter,
  readStrictJson,
  type AtomicJsonWriter
} from "./private-state.js";

const executionRoleSchema = z.enum(["store-clone", "project-fetch", "project-push", "workspace-branch-update", "workspace-add"]);
export type ExternalExecutionRole = z.infer<typeof executionRoleSchema>;
const processIdentitySchema = z.strictObject({
  pid: z.number().int().min(2), processGroupId: z.number().int().min(2), startTimeTicks: z.string().regex(/^[0-9]+$/u)
});
const markerCommon = {
  version: z.literal(1), operationId: uuidV7Schema, projectId: uuidV7Schema, executionId: uuidV7Schema,
  role: executionRoleSchema, createdAt: utcTimestampMsSchema, deadlineAt: utcTimestampMsSchema
};
const reservedMarkerSchema = z.strictObject({ ...markerCommon, phase: z.literal("reserved") });
const launchCommittedMarkerSchema = z.strictObject({ ...markerCommon, phase: z.literal("launch-committed") });
const runningMarkerSchema = z.strictObject({ ...markerCommon, phase: z.literal("running"), process: processIdentitySchema });
export const externalExecutionMarkerSchema = z.union([reservedMarkerSchema, launchCommittedMarkerSchema, runningMarkerSchema]).superRefine((marker, context) => {
  if (new Date(marker.deadlineAt).getTime() <= new Date(marker.createdAt).getTime()) {
    context.addIssue({ code: "custom", message: "Execution deadline must follow its creation time." });
  }
});
export type ExternalExecutionMarker = z.infer<typeof externalExecutionMarkerSchema>;
export type LinuxProcessIdentity = z.infer<typeof processIdentitySchema> & { executionId: string | null };

export function isExactLinuxProcessIdentity(
  recorded: z.infer<typeof processIdentitySchema>, observed: Omit<LinuxProcessIdentity, "executionId">
): boolean {
  return recorded.pid === observed.pid && recorded.processGroupId === observed.processGroupId
    && recorded.startTimeTicks === observed.startTimeTicks;
}

const POLL_MS = 25;
const TERMINATION_GRACE_MS = 150;
const IDENTITY_OBSERVATION_WINDOW_MS = 250;
const TRANSIENT_PROCESS_OBSERVATION_CODES = new Set(["EACCES", "ENOENT", "EPERM", "ESRCH"]);

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function parseLinuxProcStat(pid: number, contents: string): Omit<LinuxProcessIdentity, "executionId"> {
  const close = contents.lastIndexOf(")");
  if (close < 0) throw new Error("proc-stat-invalid");
  const prefix = contents.slice(0, contents.indexOf(" "));
  const fields = contents.slice(close + 2).trim().split(/\s+/u);
  const parsedPid = Number(prefix);
  const processGroupId = Number(fields[2]);
  const startTimeTicks = fields[19];
  if (parsedPid !== pid || !Number.isSafeInteger(processGroupId) || processGroupId <= 1
    || startTimeTicks === undefined || !/^[0-9]+$/u.test(startTimeTicks)) throw new Error("proc-stat-invalid");
  return { pid, processGroupId, startTimeTicks };
}

async function readLinuxProcess(pid: number): Promise<LinuxProcessIdentity | null> {
  try {
    const [statContents, environment] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"), readFile(`/proc/${pid}/environ`)
    ]);
    const identity = parseLinuxProcStat(pid, statContents);
    const execution = environment.toString("utf8").split("\0")
      .find((entry) => entry.startsWith("DEVSPACE_EXECUTION_ID="));
    return { ...identity, executionId: execution?.slice("DEVSPACE_EXECUTION_ID=".length) ?? null };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

async function findExecutionProcesses(executionId: string): Promise<LinuxProcessIdentity[]> {
  const matches: LinuxProcessIdentity[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^[1-9][0-9]*$/u.test(name)) continue;
    const identity = await readLinuxProcess(Number(name)).catch((error: NodeJS.ErrnoException) => {
      if (["EACCES", "EPERM"].includes(error.code ?? "")) return null;
      throw error;
    });
    if (identity?.executionId === executionId) matches.push(identity);
  }
  return matches;
}

export interface ExternalExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

type ChildCompletionResult = { readonly code: number | null; readonly signal: NodeJS.Signals | null };
type ChildCompletionSignal =
  | { readonly kind: "completed"; readonly result: ChildCompletionResult }
  | { readonly kind: "error"; readonly error: unknown };
type IdentityObservation =
  | { readonly kind: "observation"; readonly observed: LinuxProcessIdentity | null }
  | { readonly kind: "observation-error"; readonly error: unknown };
type IdentityRaceOutcome = IdentityObservation | ChildCompletionSignal | { readonly kind: "retry" };
type RetryOutcome = ChildCompletionSignal | { readonly kind: "retry" };

export class ExternalExecutionFence {
  private corruption: PrivateStateCorruptionError | null = null;
  private readonly markers = new Map<string, ExternalExecutionMarker>();
  private readonly settlingProjects = new Map<string, Promise<void>>();

  constructor(
    private readonly root: string,
    private readonly writer: AtomicJsonWriter = durableJsonWriter,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = uuidv7
  ) {}

  get isHealthy(): boolean { return this.corruption === null; }
  get corruptionReason(): string | null { return this.corruption?.message ?? null; }

  private markerPath(operationId: string): string { return path.join(this.root, `${uuidV7Schema.parse(operationId)}.json`); }
  private outputPath(executionId: string, stream: "stdout" | "stderr"): string {
    return path.join(this.root, `${uuidV7Schema.parse(executionId)}.${stream}`);
  }
  private assertHealthy(): void { if (this.corruption !== null) throw this.corruption; }
  private fail(marker: ExternalExecutionMarker, reason: string): never {
    const corruption = new PrivateStateCorruptionError(this.markerPath(marker.operationId), reason);
    this.corruption ??= corruption;
    throw corruption;
  }

  async initialize(): Promise<void> {
    this.corruption = null;
    this.markers.clear();
    this.settlingProjects.clear();
    for (const name of await readdir(this.root)) {
      if (!name.endsWith(".json")) continue;
      try {
        const marker = await readStrictJson(path.join(this.root, name), externalExecutionMarkerSchema);
        if (name !== `${marker.operationId}.json`) throw new PrivateStateCorruptionError(path.join(this.root, name), "execution filename mismatch");
        this.markers.set(marker.operationId, marker);
      } catch (error) {
        this.corruption ??= error instanceof PrivateStateCorruptionError
          ? error
          : new PrivateStateCorruptionError(path.join(this.root, name), "execution marker validation failed");
      }
    }
  }

  private async persist(marker: ExternalExecutionMarker): Promise<void> {
    this.assertHealthy();
    await this.writer.write(this.markerPath(marker.operationId), marker);
    this.markers.set(marker.operationId, marker);
  }

  private async retire(marker: ExternalExecutionMarker, removeOutputs = true): Promise<void> {
    await unlink(this.markerPath(marker.operationId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    const directory = await open(this.root, "r");
    try { await directory.sync(); } finally { await directory.close(); }
    if (removeOutputs) await this.removeOutputs(marker.executionId);
    this.markers.delete(marker.operationId);
  }

  private async removeOutputs(executionId: string): Promise<void> {
    await Promise.all(["stdout", "stderr"].map(async (stream) => await unlink(
      this.outputPath(executionId, stream as "stdout" | "stderr")
    ).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; })));
  }

  private validateProcesses(marker: ExternalExecutionMarker, processes: LinuxProcessIdentity[]): void {
    const groups = new Set(processes.map((identity) => identity.processGroupId));
    if (groups.size > 1) this.fail(marker, "execution token is present in multiple process groups");
    if (marker.phase === "running") {
      if (processes.length > 0 && groups.values().next().value !== marker.process.processGroupId) {
        this.fail(marker, "execution process group identity is inconsistent");
      }
      const recorded = processes.find((identity) => identity.pid === marker.process.pid);
      if (recorded !== undefined && !isExactLinuxProcessIdentity(marker.process, recorded)) {
        this.fail(marker, "execution PID start-time identity is inconsistent");
      }
    }
  }

  private async confirmLaunchCommitted(marker: z.infer<typeof launchCommittedMarkerSchema>): Promise<z.infer<typeof runningMarkerSchema>> {
    const processes = await findExecutionProcesses(marker.executionId);
    this.validateProcesses(marker, processes);
    if (processes.length === 0) {
      this.fail(marker, "external execution launch is indeterminate; administrator reconciliation is required");
    }
    const leader = processes.find((identity) => identity.pid === identity.processGroupId) ?? processes[0]!;
    const running = runningMarkerSchema.parse({ ...marker, phase: "running", process: {
      pid: leader.pid, processGroupId: leader.processGroupId, startTimeTicks: leader.startTimeTicks
    } });
    await this.persist(running);
    return running;
  }

  private async signalExact(marker: z.infer<typeof runningMarkerSchema>, signal: NodeJS.Signals): Promise<void> {
    const processes = await findExecutionProcesses(marker.executionId);
    this.validateProcesses(marker, processes);
    if (processes.length === 0) return;
    const owner = await readLinuxProcess(marker.process.pid);
    if (owner !== null && owner.executionId === marker.executionId
      && owner.startTimeTicks !== marker.process.startTimeTicks) this.fail(marker, "execution PID was reused");
    try { process.kill(-marker.process.processGroupId, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }

  private async terminateExact(marker: z.infer<typeof runningMarkerSchema>): Promise<void> {
    await this.signalExact(marker, "SIGTERM");
    await delay(TERMINATION_GRACE_MS);
    if ((await findExecutionProcesses(marker.executionId)).length > 0) await this.signalExact(marker, "SIGKILL");
  }

  private async waitForMarker(markerInput: ExternalExecutionMarker, removeOutputs = true): Promise<void> {
    if (markerInput.phase === "reserved") { await this.retire(markerInput); return; }
    const marker = markerInput.phase === "launch-committed"
      ? await this.confirmLaunchCommitted(markerInput)
      : markerInput;
    for (;;) {
      const processes = await findExecutionProcesses(marker.executionId);
      this.validateProcesses(marker, processes);
      if (processes.length === 0) { await this.retire(marker, removeOutputs); return; }
      if (this.now().getTime() >= new Date(marker.deadlineAt).getTime()) {
        await this.terminateExact(marker);
      }
      await delay(POLL_MS);
    }
  }

  private async settleInterruptedPush(marker: ExternalExecutionMarker): Promise<void> {
    try {
      if (marker.phase === "reserved") {
        await this.retire(marker);
        return;
      }
      const processes = await findExecutionProcesses(marker.executionId);
      this.validateProcesses(marker, processes);
      if (processes.length === 0) {
        await this.retire(marker);
        return;
      }
      const running = marker.phase === "launch-committed"
        ? await this.confirmLaunchCommitted(marker)
        : marker;
      await this.waitForMarker(running);
    } catch (error) {
      this.corruption ??= error instanceof PrivateStateCorruptionError
        ? error
        : new PrivateStateCorruptionError(this.markerPath(marker.operationId), "interrupted push marker settlement failed");
    }
  }

  private queueInterruptedPushSettlement(marker: ExternalExecutionMarker): void {
    this.markers.delete(marker.operationId);
    const previous = this.settlingProjects.get(marker.projectId) ?? Promise.resolve();
    const current = previous.then(() => this.settleInterruptedPush(marker)).finally(() => {
      if (this.settlingProjects.get(marker.projectId) === current) this.settlingProjects.delete(marker.projectId);
    });
    this.settlingProjects.set(marker.projectId, current);
    void current.catch(() => undefined);
  }

  async awaitProject(projectId: string): Promise<void> {
    this.assertHealthy();
    await this.settlingProjects.get(projectId);
    this.assertHealthy();
    for (const marker of [...this.markers.values()].filter((candidate) => candidate.projectId === projectId)) {
      await this.waitForMarker(marker);
    }
  }

  validateJournalBindings(findOperation: (operationId: string) => {
    readonly operationName: string; readonly request: unknown; readonly state: string;
    readonly failure?: { readonly code?: string } | null;
  } | undefined): void {
    this.assertHealthy();
    for (const marker of this.markers.values()) {
      const operation = findOperation(marker.operationId);
      const requestProjectId = operation?.request !== null && typeof operation?.request === "object"
        && "projectId" in operation.request ? (operation.request as { projectId?: unknown }).projectId : undefined;
      const expectedOperation = marker.role === "store-clone" ? "project.managed-store.create"
        : marker.role === "project-fetch" ? "project.fetch"
        : marker.role === "project-push" ? "project.push" : "workspace.create";
      const interruptedPush = marker.role === "project-push" && operation?.operationName === "project.push"
        && operation.state === "failed" && operation.failure?.code === "GITHUB_PUSH_OUTCOME_UNCERTAIN";
      if (interruptedPush) {
        this.queueInterruptedPushSettlement(marker);
        continue;
      }
      if (operation === undefined || operation.operationName !== expectedOperation || requestProjectId !== marker.projectId
        || (operation.state !== "accepted" && operation.state !== "running")) {
        this.fail(marker, "execution marker is not bound to its nonterminal durable journal operation");
      }
    }
  }

  async runGit(input: {
    readonly operationId: string;
    readonly projectId: string;
    readonly role: ExternalExecutionRole;
    /** An operation-local execution identity may be allocated before spawn so an askpass capability can bind to it. */
    readonly executionId?: string;
    readonly args: readonly string[];
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly env: NodeJS.ProcessEnv;
    /** Runs while the launch fence is held, immediately before the child is spawned. */
    readonly beforeSpawn?: () => Promise<() => void>;
  }): Promise<ExternalExecutionResult> {
    await this.awaitProject(input.projectId);
    const executionId = input.executionId ?? this.createId();
    const createdAt = this.now();
    let marker: ExternalExecutionMarker = reservedMarkerSchema.parse({
      version: 1, phase: "reserved", operationId: input.operationId, projectId: input.projectId,
      executionId, role: input.role, createdAt: createdAt.toISOString(),
      deadlineAt: new Date(createdAt.getTime() + input.timeoutMs).toISOString()
    });
    await this.persist(marker);
    const stdoutPath = this.outputPath(executionId, "stdout");
    const stderrPath = this.outputPath(executionId, "stderr");
    const [stdoutFile, stderrFile] = await Promise.all([
      open(stdoutPath, "wx", 0o600), open(stderrPath, "wx", 0o600)
    ]);
    marker = launchCommittedMarkerSchema.parse({ ...marker, phase: "launch-committed" });
    await this.persist(marker);
    let child: ChildProcess;
    let releaseLaunchFence: (() => void) | undefined;
    try {
      releaseLaunchFence = await input.beforeSpawn?.();
      child = spawn("/usr/bin/git", [...input.args], {
        shell: false, detached: true, stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
        env: { ...input.env, DEVSPACE_EXECUTION_ID: executionId, DEVSPACE_OPERATION_ID: input.operationId }
      });
    } catch (error) {
      releaseLaunchFence?.();
      await Promise.all([stdoutFile.close(), stderrFile.close()]);
      await this.retire(marker);
      throw error;
    }
    let completionState: ChildCompletionSignal | null = null;
    const completion = new Promise<ChildCompletionResult>((resolve, reject) => {
      child.once("error", (error) => {
        if (completionState === null) completionState = { kind: "error", error };
        reject(error);
      });
      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        const result = { code, signal };
        if (completionState === null) completionState = { kind: "completed", result };
        resolve(result);
      });
    });
    const completionSignal: Promise<ChildCompletionSignal> = completion.then(
      (result) => ({ kind: "completed", result }),
      (error: unknown) => ({ kind: "error" as const, error })
    );
    releaseLaunchFence?.();
    const outputHandlesClosed = Promise.all([stdoutFile.close(), stderrFile.close()]);
    const pid = child.pid;
    if (pid === undefined || pid <= 1) {
      await outputHandlesClosed;
      await this.retire(marker);
      throw new Error("git-spawn-identity-missing");
    }
    let identity: LinuxProcessIdentity | null = null;
    let terminalBeforeIdentity = false;
    const identityDeadlineMs = Math.min(
      new Date(marker.deadlineAt).getTime(), this.now().getTime() + IDENTITY_OBSERVATION_WINDOW_MS
    );
    const useTerminalCompletion = (): boolean => {
      const settled = completionState;
      if (settled?.kind === "completed") {
        terminalBeforeIdentity = true;
        return true;
      }
      if (settled?.kind === "error") throw settled.error;
      return false;
    };
    try {
      for (;;) {
        const remainingMs = identityDeadlineMs - this.now().getTime();
        if (remainingMs <= 0) this.fail(marker, "spawned Git process identity is inconsistent");
        const observation: Promise<IdentityObservation> = readLinuxProcess(pid).then(
          (observed) => ({ kind: "observation" as const, observed }),
          (error: unknown) => ({ kind: "observation-error" as const, error })
        );
        const outcome: IdentityRaceOutcome = await Promise.race<IdentityRaceOutcome>([
          observation,
          completionSignal,
          delay(Math.min(POLL_MS, remainingMs)).then(() => ({ kind: "retry" as const }))
        ]);
        if (outcome.kind === "completed") {
          terminalBeforeIdentity = true;
          break;
        }
        if (outcome.kind === "error") throw outcome.error;
        if (outcome.kind === "retry") {
          if (useTerminalCompletion()) break;
          continue;
        }
        if (outcome.kind === "observation-error") {
          if (useTerminalCompletion()) break;
          const code = (outcome.error as NodeJS.ErrnoException).code;
          if (!TRANSIENT_PROCESS_OBSERVATION_CODES.has(code ?? "")) throw outcome.error;
        } else if (outcome.observed !== null) {
          if (outcome.observed.processGroupId !== pid) {
            if (useTerminalCompletion()) break;
            this.fail(marker, "spawned Git process identity is inconsistent");
          }
          if (outcome.observed.executionId === executionId) {
            identity = outcome.observed;
            break;
          }
          if (outcome.observed.executionId !== null) {
            if (useTerminalCompletion()) break;
            this.fail(marker, "spawned Git process identity is inconsistent");
          }
        }
        if (useTerminalCompletion()) break;
        const retryRemainingMs = identityDeadlineMs - this.now().getTime();
        if (retryRemainingMs <= 0) this.fail(marker, "spawned Git process identity is inconsistent");
        const retryOutcome: RetryOutcome = await Promise.race<RetryOutcome>([
          completionSignal,
          delay(Math.min(POLL_MS, retryRemainingMs)).then(() => ({ kind: "retry" as const }))
        ]);
        if (retryOutcome.kind === "completed") {
          terminalBeforeIdentity = true;
          break;
        }
        if (retryOutcome.kind === "error") throw retryOutcome.error;
      }
    } catch (error) {
      await outputHandlesClosed.catch(() => undefined);
      throw error;
    }
    await outputHandlesClosed;
    if (terminalBeforeIdentity) {
      let remainingProcesses: LinuxProcessIdentity[];
      try {
        remainingProcesses = await findExecutionProcesses(executionId);
      } catch (error) {
        this.fail(marker, `execution-token descendants could not be verified: ${error instanceof Error ? error.message : "unknown error"}`);
      }
      if (remainingProcesses.length > 0) {
        this.fail(marker, "execution-token descendants remain after terminal child without exact identity proof");
      }
    } else if (identity !== null) {
      marker = runningMarkerSchema.parse({ ...marker, phase: "running", process: {
        pid, processGroupId: identity.processGroupId, startTimeTicks: identity.startTimeTicks
      } });
      await this.persist(marker);
    }
    let timedOut = false;
    const deadlineTimer = marker.phase === "running" ? setTimeout(() => {
      timedOut = true;
      void this.terminateExact(marker).catch((error) => { this.corruption ??= error instanceof PrivateStateCorruptionError
        ? error : new PrivateStateCorruptionError(this.markerPath(marker.operationId), "execution timeout termination failed"); });
    }, Math.max(0, new Date(marker.deadlineAt).getTime() - this.now().getTime())) : undefined;
    const sizeMonitor = setInterval(() => {
      void Promise.all([stat(stdoutPath), stat(stderrPath)]).then(([stdout, stderr]) => {
        if (stdout.size + stderr.size > input.maxOutputBytes && marker.phase === "running") {
          void this.terminateExact(marker).catch(() => undefined);
        }
      }).catch(() => undefined);
    }, POLL_MS);
    let completed;
    try { completed = await completion; }
    finally { clearInterval(sizeMonitor); if (deadlineTimer !== undefined) clearTimeout(deadlineTimer); }
    if (marker.phase === "running") await this.waitForMarker(marker, false);
    else await this.retire(marker, false);
    const [stdout, stderr] = await Promise.all([
      readFile(stdoutPath, "utf8").catch(() => ""), readFile(stderrPath, "utf8").catch(() => "")
    ]);
    await this.removeOutputs(executionId);
    return { ...completed, stdout: stdout.slice(0, input.maxOutputBytes), stderr: stderr.slice(0, input.maxOutputBytes), timedOut };
  }
}
