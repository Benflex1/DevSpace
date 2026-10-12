import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  agentApiV1EndpointByOperation,
  agentExecutionFailureSchema,
  agentOperationObservationSchema,
  utcTimestampMsSchema,
  uuidV7Schema,
  type AgentExecutionFailure,
  type AgentOperationObservation
} from "@devspace/contracts";
import * as z from "zod";
import {
  PrivateStateCorruptionError,
  durableJsonWriter,
  pinExistingDirectory,
  identitiesEqual,
  identityOf,
  readStrictJson,
  type AtomicJsonWriter,
  type FileIdentity
} from "./private-state.js";

export const supportedMutationNames = [
  "configuration-revision.register",
  "configuration-runtime-plan.register",
  "project.managed-store.create",
  "project.fetch",
  "project.push",
  "project.git.stage",
  "project.git.unstage",
  "project.git.commit",
  "workspace.create",
  "workspace.start",
  "workspace.stop",
  "workspace.revision.adopt",
  "task.start",
  "process.stop",
  "terminal.create",
  "terminal.close",
  "preview.activate",
  "preview.deactivate"
] as const;
export type SupportedMutationName = (typeof supportedMutationNames)[number];

const operationNameSchema = z.enum(supportedMutationNames);
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const journalRecordSchema = z.strictObject({
  version: z.literal(1),
  operationId: uuidV7Schema,
  operationName: operationNameSchema,
  requestFingerprint: fingerprintSchema,
  request: z.unknown(),
  state: z.enum(["accepted", "running", "succeeded", "failed"]),
  acceptedAt: utcTimestampMsSchema,
  updatedAt: utcTimestampMsSchema,
  failure: agentExecutionFailureSchema.nullable()
}).superRefine((record, context) => {
  const endpoint = agentApiV1EndpointByOperation[record.operationName];
  const requestResult = endpoint.requestDataSchema.safeParse(record.request);
  if (!requestResult.success) context.addIssue({ code: "custom", path: ["request"], message: "Request does not match operation" });
  if ((record.state === "failed") !== (record.failure !== null)) {
    context.addIssue({ code: "custom", path: ["failure"], message: "Failure must exist exactly for failed state" });
  }
  if (new Date(record.updatedAt).valueOf() < new Date(record.acceptedAt).valueOf()) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "Journal time cannot precede acceptance" });
  }
  if (record.failure !== null) {
    const applicable = endpoint.errors.some((error) => error.code === record.failure?.code);
    if (!applicable) context.addIssue({ code: "custom", path: ["failure", "code"], message: "Failure is not applicable to operation" });
  }
});
export type JournalRecord = z.infer<typeof journalRecordSchema>;

export class OperationConflictError extends Error {
  constructor(readonly reason: "operation-name-mismatch" | "request-mismatch") {
    super("The operation ID is already bound to different intent.");
    this.name = "OperationConflictError";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export class OperationJournal {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly records = new Map<string, JournalRecord>();
  private corruption: PrivateStateCorruptionError | null = null;
  private rootIdentity: FileIdentity | null = null;

  constructor(
    private readonly root: string,
    private readonly now: () => Date,
    private readonly writer: AtomicJsonWriter = durableJsonWriter
  ) {}

  get isHealthy(): boolean { this.refreshRootHealth(); return this.corruption === null; }
  get corruptionReason(): string | null { return this.corruption?.message ?? null; }

  async initialize(): Promise<void> {
    this.records.clear();
    this.corruption = null;
    this.rootIdentity = null;
    try {
      const established = await pinExistingDirectory(this.root);
      this.rootIdentity = established.identity;
    } catch (error) {
      this.corruption = error instanceof PrivateStateCorruptionError
        ? error
        : new PrivateStateCorruptionError(this.root, "journal root establishment failed");
    }
    if (this.corruption !== null) return;
    const names = await readdir(this.root);
    for (const name of names) {
      const match = /^([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u.exec(name);
      if (match?.[1] === undefined) {
        this.corruption ??= new PrivateStateCorruptionError(path.join(this.root, name), "invalid journal filename");
        continue;
      }
      try {
        const record = await readStrictJson(path.join(this.root, name), journalRecordSchema);
        if (record.operationId !== match[1] || record.requestFingerprint !== fingerprint(record.request)) {
          throw new PrivateStateCorruptionError(path.join(this.root, name), "filename, identity, or request fingerprint mismatch");
        }
        this.records.set(record.operationId, record);
      } catch (error) {
        this.corruption ??= error instanceof PrivateStateCorruptionError
          ? error
          : new PrivateStateCorruptionError(path.join(this.root, name), "journal load failed");
      }
    }
    if (this.corruption === null) await this.terminalizeInterruptedPushes();
    if (this.corruption === null) await this.terminalizeInterruptedLocalGitMutations();
  }

  private async terminalizeInterruptedPushes(): Promise<void> {
    for (const record of [...this.records.values()]) {
      if (record.operationName !== "project.push" || (record.state !== "accepted" && record.state !== "running")) continue;
      const next = journalRecordSchema.parse({ ...record, state: "failed", updatedAt: this.now().toISOString(), failure: {
        code: "GITHUB_PUSH_OUTCOME_UNCERTAIN",
        message: "The push outcome is uncertain after Agent interruption. Inspect the remote branch before explicitly retrying.",
        retryable: false,
        details: {}
      }});
      try {
        await this.writer.write(this.file(record.operationId), next);
      } catch {
        this.corruption ??= new PrivateStateCorruptionError(this.file(record.operationId), "push uncertainty terminalization failed");
        return;
      }
      this.records.set(record.operationId, next);
    }
  }

  private async terminalizeInterruptedLocalGitMutations(): Promise<void> {
    const localGitMutationNames: ReadonlySet<string> = new Set([
      "project.git.stage",
      "project.git.unstage",
      "project.git.commit"
    ] as const);
    for (const record of [...this.records.values()]) {
      if (!localGitMutationNames.has(record.operationName) || record.state !== "running") continue;
      const next = journalRecordSchema.parse({ ...record, state: "failed", updatedAt: this.now().toISOString(), failure: {
        code: "GIT_MUTATION_OUTCOME_UNCERTAIN",
        message: "The Git mutation outcome is uncertain after Agent interruption. Inspect the repository state before explicitly continuing.",
        retryable: false,
        details: {}
      }});
      try {
        await this.writer.write(this.file(record.operationId), next);
      } catch {
        this.corruption ??= new PrivateStateCorruptionError(this.file(record.operationId), "local Git mutation uncertainty terminalization failed");
        return;
      }
      this.records.set(record.operationId, next);
    }
  }

  private refreshRootHealth(capture = false): void {
    if (this.corruption !== null) return;
    try {
      const stats = lstatSync(this.root, { bigint: true });
      const identity = identityOf(stats);
      if (!stats.isDirectory() || stats.isSymbolicLink() || realpathSync(this.root) !== path.resolve(this.root)
        || (!capture && (this.rootIdentity === null || !identitiesEqual(identity, this.rootIdentity)))) {
        this.corruption = new PrivateStateCorruptionError(this.root, "journal root identity is invalid or was replaced");
        return;
      }
      if (capture) this.rootIdentity = identity;
    } catch {
      this.corruption = new PrivateStateCorruptionError(this.root, "journal root is unavailable");
    }
  }

  private assertHealthy(): void {
    this.refreshRootHealth();
    if (this.corruption !== null) throw this.corruption;
  }

  private file(operationId: string): string {
    return path.join(this.root, `${uuidV7Schema.parse(operationId)}.json`);
  }

  private async locked<T>(operationId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(operationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(operationId, current);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.locks.get(operationId) === current) this.locks.delete(operationId);
    }
  }

  async accept(operationId: string, operationName: SupportedMutationName, request: unknown): Promise<JournalRecord> {
    return await this.locked(operationId, async () => {
      this.assertHealthy();
      const existing = this.records.get(operationId);
      if (existing !== undefined) {
        if (existing.operationName !== operationName) throw new OperationConflictError("operation-name-mismatch");
        const parsedRequest = agentApiV1EndpointByOperation[operationName].requestDataSchema.parse(request);
        const requestFingerprint = fingerprint(parsedRequest);
        if (existing.requestFingerprint !== requestFingerprint) throw new OperationConflictError("request-mismatch");
        return existing;
      }
      const parsedRequest = agentApiV1EndpointByOperation[operationName].requestDataSchema.parse(request);
      const requestFingerprint = fingerprint(parsedRequest);
      const timestamp = this.now().toISOString();
      const record = journalRecordSchema.parse({
        version: 1, operationId, operationName, requestFingerprint, request: parsedRequest,
        state: "accepted", acceptedAt: timestamp, updatedAt: timestamp, failure: null
      });
      await this.writer.write(this.file(operationId), record);
      this.records.set(operationId, record);
      return record;
    });
  }

  private async transition(operationId: string, state: JournalRecord["state"], failure: AgentExecutionFailure | null): Promise<JournalRecord> {
    return await this.locked(operationId, async () => {
      this.assertHealthy();
      const current = this.records.get(operationId);
      if (current === undefined) throw new PrivateStateCorruptionError(this.file(operationId), "transition target is missing");
      if (current.state === "succeeded" || current.state === "failed") return current;
      const next = journalRecordSchema.parse({ ...current, state, updatedAt: this.now().toISOString(), failure });
      await this.writer.write(this.file(operationId), next);
      this.records.set(operationId, next);
      return next;
    });
  }

  async markRunning(operationId: string): Promise<JournalRecord> { return await this.transition(operationId, "running", null); }
  async succeed(operationId: string): Promise<JournalRecord> { return await this.transition(operationId, "succeeded", null); }
  async fail(operationId: string, failure: AgentExecutionFailure): Promise<JournalRecord> {
    return await this.transition(operationId, "failed", failure);
  }

  resumable(): JournalRecord[] {
    this.assertHealthy();
    return [...this.records.values()].filter((record) => record.state === "accepted" || record.state === "running");
  }

  get(operationId: string): JournalRecord | undefined {
    this.assertHealthy();
    return this.records.get(operationId);
  }

  observations(): AgentOperationObservation[] {
    this.assertHealthy();
    return [...this.records.values()].map((record) => agentOperationObservationSchema.parse({
      operationId: record.operationId,
      state: record.state,
      updatedAt: record.updatedAt,
      failure: record.failure
    }));
  }
}
