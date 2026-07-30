import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import * as z from "zod";
import {
  aiAfterSequenceSchema,
  acknowledgeAiEventsDataSchema,
  canonicalAiEventSchema,
  type CanonicalAiEvent,
  uuidV7Schema
} from "@devspace/contracts";
import { v7 as uuidv7 } from "uuid";

export const MAX_RETAINED_OUTBOX_EVENTS = 2_048;
export const ACKNOWLEDGED_RETENTION_TAIL = 512;
/** Complete active-turn and provider-generation finalization reserve. */
export const PROVIDER_FINALIZATION_EVENT_RESERVE = 2;
export const ACTIVE_TURN_EVENT_RESERVE = 4;
export const TERMINAL_EVENT_RESERVE = PROVIDER_FINALIZATION_EVENT_RESERVE + ACTIVE_TURN_EVENT_RESERVE;
const PROVIDER_STARTUP_EVENT_BUDGET = 2;
const OUTBOX_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_MANIFEST_BYTES = 4 * 1024;
const MAX_OUTBOX_BYTES = 4 * 1024 * 1024 * 1024;
const OUTBOX_FORMAT = "devspace.ai-outbox-state/v1" as const;

const manifestSchema = z.strictObject({
  format: z.literal(OUTBOX_FORMAT),
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  aiSessionId: uuidV7Schema,
  acknowledgedThrough: aiAfterSequenceSchema,
  acknowledgedEventId: uuidV7Schema.nullable()
}).superRefine((value, context) => {
  if ((value.acknowledgedThrough === 0) !== (value.acknowledgedEventId === null)) {
    context.addIssue({ code: "custom", path: ["acknowledgedEventId"], message: "Acknowledgement pair is inconsistent." });
  }
});

export type AiSessionOutboxBinding = Readonly<Pick<z.infer<typeof acknowledgeAiEventsDataSchema>, "projectId" | "workspaceId" | "aiSessionId">>;
export type AiEventAcknowledgement = z.infer<typeof acknowledgeAiEventsDataSchema>;
export type AiSessionOutboxManifest = z.infer<typeof manifestSchema>;
export type AiOutboxErrorCode = "AI_IDENTITY_MISMATCH" | "AI_EVENT_SEQUENCE_CONFLICT" | "AI_EVENT_GAP" | "AI_OUTBOX_UNAVAILABLE";

export class AiOutboxError extends Error {
  constructor(readonly code: AiOutboxErrorCode) {
    super(code);
    this.name = "AiOutboxError";
  }
}

type OutboxAppendInput = Readonly<{
  readonly turnId: string | null;
  readonly eventType: string;
  readonly payload: unknown;
  readonly profile: CanonicalAiEvent["profile"];
  readonly processGeneration: number;
  readonly kind?: "normal" | "turn-finalization" | "provider-finalization" | "terminal";
}>;

type TurnStartInput = Readonly<{
  readonly turnId: string;
  readonly profile: CanonicalAiEvent["profile"];
  readonly processGeneration: number;
  readonly content: { readonly kind: "text"; readonly text: string };
}>;

export type AiSessionOutboxFaultHooks = Readonly<{
  readonly beforeAppend?: (input: Readonly<{ eventType: string; turnId: string | null; processGeneration: number }>) => void | Promise<void>;
  readonly beforeAppendWrite?: (pathname: string) => void | Promise<void>;
  readonly beforeAppendSync?: (pathname: string) => void | Promise<void>;
  readonly beforeAtomicRename?: (pathname: string) => void | Promise<void>;
}>;

type FileIdentity = Readonly<{ readonly dev: bigint; readonly ino: bigint }>;
type PrivateStats = Stats;

function unavailable(): AiOutboxError { return new AiOutboxError("AI_OUTBOX_UNAVAILABLE"); }
function identityMismatch(): AiOutboxError { return new AiOutboxError("AI_IDENTITY_MISMATCH"); }
function sequenceConflict(): AiOutboxError { return new AiOutboxError("AI_EVENT_SEQUENCE_CONFLICT"); }
function eventGap(): AiOutboxError { return new AiOutboxError("AI_EVENT_GAP"); }

function expectedUid(): bigint | null {
  const uid = process.getuid?.();
  return uid === undefined ? null : BigInt(uid);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fileIdentity(stats: PrivateStats): FileIdentity {
  return { dev: BigInt(stats.dev), ino: BigInt(stats.ino) };
}

function assertPrivateStats(stats: PrivateStats, maxBytes: number): void {
  if (!stats.isFile() || (stats.mode & 0o777) !== PRIVATE_FILE_MODE || stats.nlink !== 1 ||
    (expectedUid() !== null && BigInt(stats.uid) !== expectedUid()) || stats.size > maxBytes) throw unavailable();
}

function assertPrivateDirectoryStats(stats: PrivateStats): void {
  if (!stats.isDirectory() || (stats.mode & 0o777) !== OUTBOX_DIRECTORY_MODE ||
    (expectedUid() !== null && BigInt(stats.uid) !== expectedUid())) throw unavailable();
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await handle.sync();
  } catch {
    throw unavailable();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensureOutboxDirectory(stateRoot: string): Promise<string> {
  const directory = path.join(path.resolve(stateRoot), "ai-events");
  try {
    await mkdir(directory, { recursive: true, mode: OUTBOX_DIRECTORY_MODE });
    const stats = await lstat(directory);
    assertPrivateDirectoryStats(stats);
    return directory;
  } catch (error) {
    if (error instanceof AiOutboxError) throw error;
    throw unavailable();
  }
}

async function exists(pathname: string): Promise<boolean> {
  try { await lstat(pathname); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw unavailable();
  }
}

async function readPrivateFile(pathname: string, maxBytes: number): Promise<Buffer> {
  let handle;
  try {
    handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    assertPrivateStats(before, maxBytes);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    assertPrivateStats(after, maxBytes);
    if (!sameIdentity(fileIdentity(before), fileIdentity(after)) || before.size !== after.size || bytes.length !== after.size) throw unavailable();
    return bytes;
  } catch (error) {
    if (error instanceof AiOutboxError) throw error;
    throw unavailable();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseUtf8Json(bytes: Buffer): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw unavailable();
  }
}

function parseManifest(bytes: Buffer): AiSessionOutboxManifest {
  if (bytes.length === 0) throw unavailable();
  try { return manifestSchema.parse(parseUtf8Json(bytes)); }
  catch (error) {
    if (error instanceof AiOutboxError) throw error;
    throw unavailable();
  }
}

function serializeManifest(manifest: AiSessionOutboxManifest): Buffer {
  const text = JSON.stringify(manifest);
  if (text.includes("\n") || text.includes("\r") || text.includes("\0")) throw unavailable();
  const bytes = Buffer.from(`${text}\n`, "utf8");
  if (bytes.length > MAX_MANIFEST_BYTES) throw unavailable();
  return bytes;
}

function parseOutbox(bytes: Buffer, sessionId: string): CanonicalAiEvent[] {
  if (bytes.length === 0) return [];
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw unavailable(); }
  if (!text.endsWith("\n")) throw unavailable();
  const lines = text.slice(0, -1).split("\n");
  const events: CanonicalAiEvent[] = [];
  const ids = new Set<string>();
  for (const line of lines) {
    if (line.length === 0 || line.includes("\r") || line.includes("\0")) throw unavailable();
    try {
      const event = canonicalAiEventSchema.parse(JSON.parse(line));
      if (event.sessionId !== sessionId || ids.has(event.eventId)) throw unavailable();
      ids.add(event.eventId);
      events.push(event);
    } catch (error) {
      if (error instanceof AiOutboxError) throw error;
      throw unavailable();
    }
  }
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.sequence !== events[index - 1]!.sequence + 1) throw unavailable();
  }
  return events;
}

function serializeEvent(event: CanonicalAiEvent): Buffer {
  const text = JSON.stringify(event);
  if (text.includes("\n") || text.includes("\r") || text.includes("\0")) throw unavailable();
  return Buffer.from(`${text}\n`, "utf8");
}

async function createPrivateFile(pathname: string, bytes: Buffer): Promise<void> {
  let handle;
  try {
    handle = await open(pathname, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    await handle.writeFile(bytes);
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof AiOutboxError) throw error;
    throw unavailable();
  }
  try {
    const stats = await lstat(pathname);
    assertPrivateStats(stats, Math.max(MAX_MANIFEST_BYTES, MAX_OUTBOX_BYTES));
    await syncDirectory(path.dirname(pathname));
  } catch (error) {
    if (error instanceof AiOutboxError) throw error;
    throw unavailable();
  }
}

async function atomicReplace(pathname: string, bytes: Buffer, beforeRename?: (pathname: string) => void | Promise<void>): Promise<void> {
  const directory = path.dirname(pathname);
  await ensureOutboxDirectory(path.dirname(directory));
  let previous: FileIdentity | null = null;
  try {
    const stats = await lstat(pathname);
    assertPrivateStats(stats, Math.max(MAX_MANIFEST_BYTES, MAX_OUTBOX_BYTES));
    previous = fileIdentity(stats);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof AiOutboxError) throw error;
      throw unavailable();
    }
  }
  const temporary = path.join(directory, `.${path.basename(pathname)}.tmp-${process.pid}-${uuidv7()}`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    await handle.writeFile(bytes);
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = undefined;
    let current: FileIdentity | null = null;
    try {
      const currentStats = await lstat(pathname);
      assertPrivateStats(currentStats, Math.max(MAX_MANIFEST_BYTES, MAX_OUTBOX_BYTES));
      current = fileIdentity(currentStats);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if ((previous === null) !== (current === null) || (previous !== null && current !== null && !sameIdentity(previous, current))) throw unavailable();
    await beforeRename?.(pathname);
    let verified: FileIdentity | null = null;
    try {
      const verifiedStats = await lstat(pathname);
      assertPrivateStats(verifiedStats, Math.max(MAX_MANIFEST_BYTES, MAX_OUTBOX_BYTES));
      verified = fileIdentity(verifiedStats);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if ((previous === null) !== (verified === null) || (previous !== null && verified !== null && !sameIdentity(previous, verified))) throw unavailable();
    await rename(temporary, pathname);
    const replaced = await lstat(pathname);
    assertPrivateStats(replaced, Math.max(MAX_MANIFEST_BYTES, MAX_OUTBOX_BYTES));
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof AiOutboxError) throw error;
    throw unavailable();
  }
}

function validateBinding(binding: AiSessionOutboxBinding): AiSessionOutboxBinding {
  try {
    return acknowledgeAiEventsDataSchema.pick({ projectId: true, workspaceId: true, aiSessionId: true }).parse({
      projectId: binding.projectId, workspaceId: binding.workspaceId, aiSessionId: binding.aiSessionId
    });
  } catch { throw identityMismatch(); }
}

function validateAcknowledgement(input: AiEventAcknowledgement): AiEventAcknowledgement {
  try { return acknowledgeAiEventsDataSchema.parse(input); }
  catch { throw sequenceConflict(); }
}

export function outboxPathForAiSession(stateRoot: string, sessionId: string): string {
  return path.join(path.resolve(stateRoot), "ai-events", `${uuidV7Schema.parse(sessionId)}.jsonl`);
}

export function manifestPathForAiSession(stateRoot: string, sessionId: string): string {
  return path.join(path.resolve(stateRoot), "ai-events", `${uuidV7Schema.parse(sessionId)}.state.json`);
}

export class AiSessionOutbox {
  private readonly listeners = new Set<(event: CanonicalAiEvent) => void>();
  private chain: Promise<void> = Promise.resolve();
  private eventsValue: CanonicalAiEvent[];
  private manifestValue: AiSessionOutboxManifest;
  private byteSize: number;
  private providerReservationOwned = false;
  private providerFinalizationSlotsRemaining = 0;
  private activeTurnReservationOwned = false;
  private activeTurnSlotsRemaining = 0;

  private constructor(
    private readonly stateRoot: string,
    readonly binding: AiSessionOutboxBinding,
    manifest: AiSessionOutboxManifest,
    events: CanonicalAiEvent[],
    byteSize: number,
    private readonly createId: () => string,
    private readonly now: () => Date,
    private readonly faultHooks: AiSessionOutboxFaultHooks
  ) {
    this.manifestValue = manifest;
    this.eventsValue = events;
    this.byteSize = byteSize;
  }

  static async open(options: {
    readonly stateRoot: string;
    readonly binding?: AiSessionOutboxBinding;
    readonly sessionId?: string;
    readonly createId?: () => string;
    readonly now?: () => Date;
    readonly faultHooks?: AiSessionOutboxFaultHooks;
  }): Promise<AiSessionOutbox> {
    const stateRoot = path.resolve(options.stateRoot);
    const expectedSessionId = options.binding?.aiSessionId ?? options.sessionId;
    if (expectedSessionId === undefined) throw unavailable();
    let sessionId: string;
    try { sessionId = uuidV7Schema.parse(expectedSessionId); }
    catch { throw unavailable(); }
    await ensureOutboxDirectory(stateRoot);
    const outboxPath = outboxPathForAiSession(stateRoot, sessionId);
    const manifestPath = manifestPathForAiSession(stateRoot, sessionId);
    const outboxExists = await exists(outboxPath);
    const manifestExists = await exists(manifestPath);
    if (!outboxExists && !manifestExists) {
      if (options.binding === undefined) throw unavailable();
      const binding = validateBinding(options.binding);
      const manifest = manifestSchema.parse({ format: OUTBOX_FORMAT, ...binding, acknowledgedThrough: 0, acknowledgedEventId: null });
      await createPrivateFile(outboxPath, Buffer.alloc(0));
      await createPrivateFile(manifestPath, serializeManifest(manifest));
      return new AiSessionOutbox(stateRoot, binding, manifest, [], 0, options.createId ?? uuidv7, options.now ?? (() => new Date()), options.faultHooks ?? {});
    }
    if (!outboxExists || !manifestExists) throw unavailable();
    const manifest = parseManifest(await readPrivateFile(manifestPath, MAX_MANIFEST_BYTES));
    const binding = validateBinding(options.binding ?? manifest);
    if (manifest.projectId !== binding.projectId || manifest.workspaceId !== binding.workspaceId || manifest.aiSessionId !== binding.aiSessionId) throw unavailable();
    const bytes = await readPrivateFile(outboxPath, MAX_OUTBOX_BYTES);
    const events = parseOutbox(bytes, sessionId);
    if (events.length > MAX_RETAINED_OUTBOX_EVENTS) throw unavailable();
    validateRetainedBoundary(events, manifest);
    return new AiSessionOutbox(stateRoot, binding, manifest, events, bytes.length, options.createId ?? uuidv7, options.now ?? (() => new Date()), options.faultHooks ?? {});
  }

  get events(): readonly CanonicalAiEvent[] { return this.eventsValue; }
  get nextSequence(): number { return (this.eventsValue.at(-1)?.sequence ?? 0) + 1; }
  get acknowledgedThrough(): number { return this.manifestValue.acknowledgedThrough; }
  get acknowledgedEventId(): string | null { return this.manifestValue.acknowledgedEventId; }

  async append(input: OutboxAppendInput): Promise<CanonicalAiEvent> {
    return await this.enqueue(async () => {
      await this.compactLocked();
      return await this.appendLocked(input, false);
    });
  }

  async reserveProviderGeneration(): Promise<void> {
    await this.enqueue(async () => {
      await this.compactLocked();
      if (this.providerReservationOwned || this.activeTurnReservationOwned
        || this.eventsValue.length + PROVIDER_STARTUP_EVENT_BUDGET + PROVIDER_FINALIZATION_EVENT_RESERVE > MAX_RETAINED_OUTBOX_EVENTS) {
        throw unavailable();
      }
      this.providerReservationOwned = true;
      this.providerFinalizationSlotsRemaining = PROVIDER_FINALIZATION_EVENT_RESERVE;
    });
  }

  async releaseProviderGeneration(): Promise<void> {
    await this.enqueue(() => {
      if (!this.providerReservationOwned || this.providerFinalizationSlotsRemaining !== 0 || this.activeTurnReservationOwned) throw unavailable();
      this.providerReservationOwned = false;
    });
  }

  async cancelProviderGenerationReservation(): Promise<void> {
    await this.enqueue(() => {
      if (!this.providerReservationOwned || this.providerFinalizationSlotsRemaining !== PROVIDER_FINALIZATION_EVENT_RESERVE
        || this.activeTurnReservationOwned) throw unavailable();
      this.providerReservationOwned = false;
      this.providerFinalizationSlotsRemaining = 0;
    });
  }

  async beginTurn(input: TurnStartInput): Promise<readonly [CanonicalAiEvent, CanonicalAiEvent]> {
    return await this.enqueue(async () => {
      await this.compactLocked();
      if (!this.providerReservationOwned || this.activeTurnReservationOwned
        || this.eventsValue.length + 2 + ACTIVE_TURN_EVENT_RESERVE + this.providerFinalizationSlotsRemaining > MAX_RETAINED_OUTBOX_EVENTS) {
        throw unavailable();
      }
      this.activeTurnReservationOwned = true;
      this.activeTurnSlotsRemaining = ACTIVE_TURN_EVENT_RESERVE;
      const accepted = await this.appendLocked({ turnId: input.turnId, eventType: "turn.accepted", payload: { content: input.content }, profile: input.profile, processGeneration: input.processGeneration, kind: "normal" }, true);
      const started = await this.appendLocked({ turnId: input.turnId, eventType: "turn.started", payload: {}, profile: input.profile, processGeneration: input.processGeneration, kind: "normal" }, true);
      return [accepted, started];
    });
  }

  async finishTurn(): Promise<void> {
    await this.enqueue(() => {
      if (!this.activeTurnReservationOwned) return;
      this.activeTurnReservationOwned = false;
      this.activeTurnSlotsRemaining = 0;
    });
  }

  async acknowledge(input: AiEventAcknowledgement): Promise<AiEventAcknowledgement> {
    return await this.enqueue(async () => {
      const acknowledgement = validateAcknowledgement(input);
      if (acknowledgement.projectId !== this.binding.projectId || acknowledgement.workspaceId !== this.binding.workspaceId || acknowledgement.aiSessionId !== this.binding.aiSessionId) throw identityMismatch();
      if (acknowledgement.throughSequence > (this.eventsValue.at(-1)?.sequence ?? 0)) throw sequenceConflict();
      const exact = this.eventsValue.find((event) => event.sequence === acknowledgement.throughSequence);
      if (exact === undefined || exact.eventId !== acknowledgement.throughEventId) throw sequenceConflict();
      if (acknowledgement.throughSequence > this.manifestValue.acknowledgedThrough) {
        const next = manifestSchema.parse({ ...this.manifestValue, acknowledgedThrough: acknowledgement.throughSequence, acknowledgedEventId: acknowledgement.throughEventId });
        await atomicReplace(manifestPathForAiSession(this.stateRoot, this.binding.aiSessionId), serializeManifest(next), this.faultHooks.beforeAtomicRename);
        this.manifestValue = next;
        await this.compactLocked();
      } else if (acknowledgement.throughSequence === this.manifestValue.acknowledgedThrough && this.hasRemovableAcknowledgedEntries()) {
        await this.compactLocked();
      }
      return acknowledgement;
    });
  }

  async replay(afterSequence: number): Promise<CanonicalAiEvent[]> {
    return await this.enqueue(() => {
      try { aiAfterSequenceSchema.parse(afterSequence); }
      catch { throw eventGap(); }
      const first = this.eventsValue[0]?.sequence ?? 1;
      if (afterSequence < first - 1) throw eventGap();
      return this.eventsValue.filter((event) => event.sequence > afterSequence);
    });
  }

  async subscribe(afterSequence: number, listener: (event: CanonicalAiEvent) => void): Promise<() => void> {
    return await this.enqueue(() => {
      try { aiAfterSequenceSchema.parse(afterSequence); }
      catch { throw eventGap(); }
      const first = this.eventsValue[0]?.sequence ?? 1;
      if (afterSequence < first - 1) throw eventGap();
      for (const event of this.eventsValue.filter((candidate) => candidate.sequence > afterSequence)) {
        try { listener(event); } catch { /* a consumer cannot invalidate durable state */ }
      }
      this.listeners.add(listener);
      return () => { this.listeners.delete(listener); };
    });
  }

  private async appendLocked(input: OutboxAppendInput, preflighted: boolean): Promise<CanonicalAiEvent> {
    if (!preflighted) {
      let reservedAfterAppend = this.providerFinalizationSlotsRemaining + this.activeTurnSlotsRemaining;
      if (input.kind === "turn-finalization") {
        if (!this.activeTurnReservationOwned || this.activeTurnSlotsRemaining === 0) throw unavailable();
        reservedAfterAppend -= 1;
      } else if (input.kind === "provider-finalization") {
        if (!this.providerReservationOwned || this.providerFinalizationSlotsRemaining === 0) throw unavailable();
        reservedAfterAppend -= 1;
      } else if (input.kind === "terminal") {
        reservedAfterAppend = 0;
      }
      const limit = MAX_RETAINED_OUTBOX_EVENTS - reservedAfterAppend;
      if (this.eventsValue.length + 1 > limit) throw unavailable();
    }
    const sequence = this.nextSequence;
    let event: CanonicalAiEvent;
    try {
      event = canonicalAiEventSchema.parse({ schemaVersion: "devspace.ai-event/v1", eventId: this.createId(), sessionId: this.binding.aiSessionId,
        turnId: input.turnId, sequence, observedAt: this.now().toISOString(), profile: input.profile,
        processGeneration: input.processGeneration, eventType: input.eventType, payload: input.payload });
    } catch { throw unavailable(); }
    const bytes = serializeEvent(event);
    if (this.byteSize + bytes.length > MAX_OUTBOX_BYTES) throw unavailable();
    let handle;
    try {
      await this.faultHooks.beforeAppend?.({
        eventType: input.eventType,
        turnId: input.turnId,
        processGeneration: input.processGeneration
      });
      handle = await open(outboxPathForAiSession(this.stateRoot, this.binding.aiSessionId), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
      const before = await handle.stat();
      assertPrivateStats(before, MAX_OUTBOX_BYTES);
      if (before.size !== this.byteSize) throw unavailable();
      await this.faultHooks.beforeAppendWrite?.(outboxPathForAiSession(this.stateRoot, this.binding.aiSessionId));
      await handle.writeFile(bytes);
      await this.faultHooks.beforeAppendSync?.(outboxPathForAiSession(this.stateRoot, this.binding.aiSessionId));
      await handle.sync();
      const after = await handle.stat();
      assertPrivateStats(after, MAX_OUTBOX_BYTES);
      if (!sameIdentity(fileIdentity(before), fileIdentity(after)) || after.size !== before.size + bytes.length) throw unavailable();
      await handle.close();
      handle = undefined;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error instanceof AiOutboxError) throw error;
      throw unavailable();
    }
    this.byteSize += bytes.length;
    this.eventsValue.push(event);
    if (input.kind === "turn-finalization") this.activeTurnSlotsRemaining -= 1;
    if (input.kind === "provider-finalization") this.providerFinalizationSlotsRemaining -= 1;
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* delivery errors never poison the durable chain */ }
    }
    return event;
  }

  private hasRemovableAcknowledgedEntries(): boolean {
    return this.eventsValue.some((event) => event.sequence <= this.manifestValue.acknowledgedThrough && event.sequence <= this.manifestValue.acknowledgedThrough - ACKNOWLEDGED_RETENTION_TAIL);
  }

  private async compactLocked(): Promise<void> {
    if (!this.hasRemovableAcknowledgedEntries()) return;
    const threshold = this.manifestValue.acknowledgedThrough - ACKNOWLEDGED_RETENTION_TAIL;
    const retained = this.eventsValue.filter((event) => event.sequence > threshold || event.sequence > this.manifestValue.acknowledgedThrough);
    if (retained.length === this.eventsValue.length) return;
    const bytes = Buffer.from(retained.map(serializeEvent).join(""), "utf8");
    await atomicReplace(outboxPathForAiSession(this.stateRoot, this.binding.aiSessionId), bytes, this.faultHooks.beforeAtomicRename);
    this.eventsValue = retained;
    this.byteSize = bytes.length;
  }

  private async enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const current = this.chain.then(operation);
    this.chain = current.then(() => undefined, () => undefined);
    return await current;
  }
}

function validateRetainedBoundary(events: CanonicalAiEvent[], manifest: AiSessionOutboxManifest): void {
  const last = events.at(-1)?.sequence ?? 0;
  if (last < manifest.acknowledgedThrough) throw unavailable();
  if (manifest.acknowledgedThrough === 0) {
    if (events[0] !== undefined && events[0].sequence !== 1) throw unavailable();
    return;
  }
  const acknowledged = events.find((event) => event.sequence === manifest.acknowledgedThrough);
  if (acknowledged === undefined || acknowledged.eventId !== manifest.acknowledgedEventId) throw unavailable();
  const first = events[0]?.sequence;
  if (first === undefined || first > Math.max(1, manifest.acknowledgedThrough - ACKNOWLEDGED_RETENTION_TAIL + 1)) throw unavailable();
  const firstUnacknowledged = events.findIndex((event) => event.sequence > manifest.acknowledgedThrough);
  if (firstUnacknowledged >= 0 && events[firstUnacknowledged]!.sequence !== manifest.acknowledgedThrough + 1) throw unavailable();
}

export async function createAiSessionOutbox(options: {
  readonly stateRoot: string;
  readonly binding: AiSessionOutboxBinding;
  readonly createId?: () => string;
  readonly now?: () => Date;
  readonly faultHooks?: AiSessionOutboxFaultHooks;
}): Promise<AiSessionOutbox> {
  return await AiSessionOutbox.open(options);
}

export async function openExistingAiSessionOutbox(options: {
  readonly stateRoot: string;
  readonly sessionId: string;
  readonly createId?: () => string;
  readonly now?: () => Date;
  readonly faultHooks?: AiSessionOutboxFaultHooks;
}): Promise<AiSessionOutbox> {
  return await AiSessionOutbox.open(options);
}
