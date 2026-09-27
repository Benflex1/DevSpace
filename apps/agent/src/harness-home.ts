import { constants as fsConstants, type Dirent } from "node:fs";
import { chmod, lstat, mkdir, open, readlink, readdir, rename, rm, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { configurationKeySchema, uuidV7Schema } from "@devspace/contracts";
import * as z from "zod";
import {
  durableJsonWriter,
  establishPinnedDirectory,
  readRegularFileNoFollow,
  readStrictJson
} from "./private-state.js";

export const HARNESS_HOME_MAX_DEPTH = 16;
export const HARNESS_HOME_MAX_ENTRIES = 4096;
export const HARNESS_HOME_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const HARNESS_HOME_MAX_TREE_BYTES = 256 * 1024 * 1024;
export const HARNESS_SLOT_CONTAINER_PATH = "/opt/devspace/harness-home" as const;

export class HarnessHomeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HarnessHomeError";
  }
}

const leaseMetadataSchema = z.strictObject({
  leaseId: z.string().min(1),
  harnessId: configurationKeySchema,
  workspaceId: uuidV7Schema,
  aiSessionId: uuidV7Schema,
  processGeneration: z.number().int().positive(),
  acquiredAt: z.string().min(1)
});
type LeaseMetadata = z.infer<typeof leaseMetadataSchema>;

const slotMetaSchema = z.strictObject({
  harnessId: configurationKeySchema,
  workspaceId: uuidV7Schema,
  leaseId: z.string().min(1),
  dirty: z.boolean()
});
type SlotMeta = z.infer<typeof slotMetaSchema>;

export type RecoveredSlot = {
  readonly workspaceId: string;
  readonly harnessId: string;
};

export interface HarnessHomeStore {
  acquireLease(input: {
    harnessId: string;
    workspaceId: string;
    aiSessionId: string;
    processGeneration: number;
  }): Promise<{ leaseId: string }>;
  materialize(input: {
    workspaceId: string;
    harnessId: string;
    leaseId: string;
  }): Promise<{ containerPath: "/opt/devspace/harness-home"; slotHostPath: string }>;
  writeBackAndClear(input: { workspaceId: string; leaseId: string }): Promise<void>;
  releaseLease(input: { harnessId: string; leaseId: string }): Promise<void>;
  recoverDirtySlots(): Promise<readonly RecoveredSlot[]>;
  reapStaleLeases(): Promise<void>;
  persistentHomePath(harnessId: string): string;
}

function requireHarnessId(value: string): string {
  const parsed = configurationKeySchema.safeParse(value);
  if (!parsed.success) throw new HarnessHomeError("HARNESS_ID_INVALID", "The harness id is not a configuration key.");
  return parsed.data;
}

function requireUuid(value: string, field: string): string {
  const parsed = uuidV7Schema.safeParse(value);
  if (!parsed.success) throw new HarnessHomeError("HARNESS_IDENTITY_INVALID", `The ${field} is not a UUIDv7.`);
  return parsed.data;
}

function leaseDir(homePath: string): string {
  return path.join(homePath, ".lease");
}

function leaseMetadataPath(homePath: string): string {
  return path.join(leaseDir(homePath), "metadata.json");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureDirectory(target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);
}

async function emptyDirectory(target: string): Promise<void> {
  if (!await pathExists(target)) {
    await ensureDirectory(target);
    return;
  }
  for (const entry of await readdir(target, { withFileTypes: true })) {
    await rm(path.join(target, entry.name), { recursive: true, force: true });
  }
}

async function readLease(homePath: string): Promise<LeaseMetadata | null> {
  const file = leaseMetadataPath(homePath);
  if (!await pathExists(file)) return null;
  return readStrictJson(file, leaseMetadataSchema);
}

async function writeLease(homePath: string, metadata: LeaseMetadata): Promise<void> {
  const dir = leaseDir(homePath);
  await mkdir(dir, { mode: 0o700 });
  const handle = await open(leaseMetadataPath(homePath), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function rejectUnsupported(reason: string): never {
  throw new HarnessHomeError("HARNESS_HOME_UNSUPPORTED", reason);
}

async function walkCopy(sourceRoot: string, destinationRoot: string, skip: ReadonlySet<string>): Promise<void> {
  let entries = 0;
  let totalBytes = 0;
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > HARNESS_HOME_MAX_DEPTH) rejectUnsupported("directory depth exceeds the bound");
    const source = relative === "" ? sourceRoot : path.join(sourceRoot, relative);
    const destination = relative === "" ? destinationRoot : path.join(destinationRoot, relative);
    const stats = await lstat(source);
    if (stats.isSymbolicLink()) {
      entries += 1;
      if (entries > HARNESS_HOME_MAX_ENTRIES) rejectUnsupported("entry count exceeds the bound");
      const target = await readlink(source);
      const targetBytes = Buffer.byteLength(target, "utf8");
      if (targetBytes > 4_096) rejectUnsupported("symbolic link target exceeds the bound");
      totalBytes += targetBytes;
      if (totalBytes > HARNESS_HOME_MAX_TREE_BYTES) rejectUnsupported("tree exceeds the size bound");
      await ensureDirectory(path.dirname(destination));
      // Retain the link itself without resolving its target on the host.
      await symlink(target, destination);
      return;
    }
    if (stats.isSocket() || stats.isFIFO() || stats.isBlockDevice() || stats.isCharacterDevice()) {
      rejectUnsupported("special files are not allowed");
    }
    if (stats.isDirectory()) {
      entries += 1;
      if (entries > HARNESS_HOME_MAX_ENTRIES) rejectUnsupported("entry count exceeds the bound");
      if (relative !== "") await ensureDirectory(destination);
      const children = await readdir(source, { withFileTypes: true });
      for (const child of children) {
        if (relative === "" && skip.has(child.name)) continue;
        if (child.name === "." || child.name === ".." || child.name.includes("\0") || child.name.includes("/")) {
          rejectUnsupported("illegal path component");
        }
        await visit(relative === "" ? child.name : path.join(relative, child.name), depth + 1);
      }
      return;
    }
    if (!stats.isFile()) rejectUnsupported("unsupported filesystem object");
    entries += 1;
    if (entries > HARNESS_HOME_MAX_ENTRIES) rejectUnsupported("entry count exceeds the bound");
    if (stats.size > HARNESS_HOME_MAX_FILE_BYTES) rejectUnsupported("file exceeds the size bound");
    totalBytes += Number(stats.size);
    if (totalBytes > HARNESS_HOME_MAX_TREE_BYTES) rejectUnsupported("tree exceeds the size bound");
    const { bytes } = await readRegularFileNoFollow(source, HARNESS_HOME_MAX_FILE_BYTES);
    await ensureDirectory(path.dirname(destination));
    const handle = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  await ensureDirectory(destinationRoot);
  await visit("", 0);
}

async function rotatePayload(homePath: string, incomingPath: string): Promise<void> {
  const previousPath = `${homePath}.previous`;
  await rm(previousPath, { recursive: true, force: true });
  await ensureDirectory(previousPath);
  const current = await readdir(homePath, { withFileTypes: true });
  for (const entry of current) {
    if (entry.name === ".lease") continue;
    await rename(path.join(homePath, entry.name), path.join(previousPath, entry.name));
  }
  const incoming = await readdir(incomingPath, { withFileTypes: true });
  for (const entry of incoming) {
    await rename(path.join(incomingPath, entry.name), path.join(homePath, entry.name));
  }
  await rm(incomingPath, { recursive: true, force: true });
  await rm(previousPath, { recursive: true, force: true });
}

export function createHarnessHomeStore(stateRoot: string): HarnessHomeStore {
  const root = path.resolve(stateRoot);
  const homesRoot = path.join(root, "harness-homes");
  const slotsRoot = path.join(root, "harness-slots");
  const metaRoot = path.join(root, "harness-meta");
  const leaseLocks = new Map<string, Promise<void>>();

  const persistentHomePath = (harnessId: string): string => path.join(homesRoot, requireHarnessId(harnessId));
  const slotHostPath = (workspaceId: string): string => path.join(slotsRoot, requireUuid(workspaceId, "workspaceId"));
  const metaPath = (workspaceId: string): string => path.join(metaRoot, `${requireUuid(workspaceId, "workspaceId")}.json`);

  const readMeta = async (workspaceId: string): Promise<SlotMeta | null> => {
    const file = metaPath(workspaceId);
    if (!await pathExists(file)) return null;
    return readStrictJson(file, slotMetaSchema);
  };

  const writeMeta = async (meta: SlotMeta): Promise<void> => {
    await durableJsonWriter.write(metaPath(meta.workspaceId), meta);
  };

  const requireLease = async (harnessId: string, leaseId: string, workspaceId?: string): Promise<LeaseMetadata> => {
    const metadata = await readLease(persistentHomePath(harnessId));
    if (metadata === null || metadata.leaseId !== leaseId || metadata.harnessId !== harnessId) {
      throw new HarnessHomeError("HARNESS_HOME_IN_USE", "The harness home lease does not match.");
    }
    if (workspaceId !== undefined && metadata.workspaceId !== workspaceId) {
      throw new HarnessHomeError("HARNESS_HOME_IN_USE", "The harness home lease belongs to another workspace.");
    }
    return metadata;
  };

  const hasFinalizedLease = async (harnessId: string, leaseId: string): Promise<boolean> => {
    let entries: Dirent[];
    try { entries = await readdir(metaRoot, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    let matches = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return false;
      const meta = await readStrictJson(path.join(metaRoot, entry.name), slotMetaSchema);
      if (meta.harnessId === harnessId && meta.leaseId === leaseId) {
        if (meta.dirty) return false;
        matches += 1;
      }
    }
    return matches === 1;
  };

  const withLeaseLock = async <T>(harnessId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = leaseLocks.get(harnessId) ?? Promise.resolve();
    let unlock!: () => void;
    const held = new Promise<void>((resolve) => { unlock = resolve; });
    const queued = previous.then(() => held);
    leaseLocks.set(harnessId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
      if (leaseLocks.get(harnessId) === queued) leaseLocks.delete(harnessId);
    }
  };

  return {
    persistentHomePath,
    async acquireLease(input) {
      const harnessId = requireHarnessId(input.harnessId);
      return withLeaseLock(harnessId, async () => {
        const workspaceId = requireUuid(input.workspaceId, "workspaceId");
        const aiSessionId = requireUuid(input.aiSessionId, "aiSessionId");
        if (!Number.isInteger(input.processGeneration) || input.processGeneration < 1) {
          throw new HarnessHomeError("HARNESS_IDENTITY_INVALID", "processGeneration must be a positive integer.");
        }
        await establishPinnedDirectory(homesRoot);
        const homePath = persistentHomePath(harnessId);
        await ensureDirectory(homePath);
        const existing = await readLease(homePath);
        if (existing !== null) {
          if (
            existing.workspaceId === workspaceId
            && existing.aiSessionId === aiSessionId
            && existing.processGeneration === input.processGeneration
          ) {
            return { leaseId: existing.leaseId };
          }
          throw new HarnessHomeError("HARNESS_HOME_IN_USE", "The Codex home/profile is already active in another workspace.");
        }
        await establishPinnedDirectory(metaRoot);
        for (const entry of await readdir(metaRoot, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) {
            throw new HarnessHomeError("HARNESS_HOME_IN_USE", "Harness slot ownership metadata is not exact.");
          }
          const meta = await readStrictJson(path.join(metaRoot, entry.name), slotMetaSchema);
          if (meta.harnessId === harnessId && meta.dirty) {
            throw new HarnessHomeError("HARNESS_HOME_IN_USE", "A dirty harness slot still owns this persistent home.");
          }
        }
        const leaseId = randomUUID();
        try {
          await writeLease(homePath, {
            leaseId,
            harnessId,
            workspaceId,
            aiSessionId,
            processGeneration: input.processGeneration,
            acquiredAt: new Date().toISOString()
          });
        } catch {
          throw new HarnessHomeError("HARNESS_HOME_IN_USE", "The Codex home/profile is already active in another workspace.");
        }
        return { leaseId };
      });
    },
    async materialize(input) {
      const harnessId = requireHarnessId(input.harnessId);
      const workspaceId = requireUuid(input.workspaceId, "workspaceId");
      await requireLease(harnessId, input.leaseId, workspaceId);
      await establishPinnedDirectory(slotsRoot);
      await establishPinnedDirectory(metaRoot);
      const slot = slotHostPath(workspaceId);
      await emptyDirectory(slot);
      await walkCopy(persistentHomePath(harnessId), slot, new Set([".lease"]));
      await writeMeta({ harnessId, workspaceId, leaseId: input.leaseId, dirty: true });
      return { containerPath: HARNESS_SLOT_CONTAINER_PATH, slotHostPath: slot };
    },
    async writeBackAndClear(input) {
      const workspaceId = requireUuid(input.workspaceId, "workspaceId");
      const meta = await readMeta(workspaceId);
      if (meta === null || meta.leaseId !== input.leaseId) {
        throw new HarnessHomeError("HARNESS_HOME_IN_USE", "The slot is not owned by this lease.");
      }
      if (!meta.dirty) {
        // A previous writeback completed before a crash but its caller did not
        // persist the released lease. The clean owner marker makes this retry
        // a slot clear, never a second copy into the persistent home.
        await emptyDirectory(slotHostPath(workspaceId));
        return;
      }
      await requireLease(meta.harnessId, input.leaseId, workspaceId);
      const slot = slotHostPath(workspaceId);
      const homePath = persistentHomePath(meta.harnessId);
      const incoming = `${homePath}.incoming`;
      await rm(incoming, { recursive: true, force: true });
      try {
        await walkCopy(slot, incoming, new Set([".lease"]));
        await rotatePayload(homePath, incoming);
      } catch (error) {
        await rm(incoming, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      await writeMeta({ ...meta, dirty: false });
      await emptyDirectory(slot);
    },
    async releaseLease(input) {
      const harnessId = requireHarnessId(input.harnessId);
      return withLeaseLock(harnessId, async () => {
        const homePath = persistentHomePath(harnessId);
        const current = await readLease(homePath);
        if (current === null || current.leaseId !== input.leaseId) {
          if (await hasFinalizedLease(harnessId, input.leaseId)) {
            // The old lease was already released after its exact slot was made
            // clean. Do not remove a newer lease that may now own this home.
            if (current === null) await rm(leaseDir(homePath), { recursive: true, force: true });
            return;
          }
          throw new HarnessHomeError("HARNESS_HOME_IN_USE", "The harness home lease does not match.");
        }
        await requireLease(harnessId, input.leaseId);
        await rm(leaseDir(homePath), { recursive: true, force: true });
      });
    },
    async recoverDirtySlots() {
      await establishPinnedDirectory(metaRoot);
      const recovered: RecoveredSlot[] = [];
      for (const name of await readdir(metaRoot)) {
        if (!name.endsWith(".json")) continue;
        const meta = await readStrictJson(path.join(metaRoot, name), slotMetaSchema);
        if (!meta.dirty) continue;
        await this.writeBackAndClear({ workspaceId: meta.workspaceId, leaseId: meta.leaseId });
        recovered.push({ workspaceId: meta.workspaceId, harnessId: meta.harnessId });
      }
      return recovered;
    },
    async reapStaleLeases() {
      await establishPinnedDirectory(homesRoot);
      let homes: Dirent[];
      try { homes = await readdir(homesRoot, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of homes) {
        if (!entry.isDirectory()) continue;
        const homePath = path.join(homesRoot, entry.name);
        const metadata = await readLease(homePath);
        if (metadata === null) continue;
        const meta = await readMeta(metadata.workspaceId);
        if (meta !== null && meta.dirty) continue;
        await rm(leaseDir(homePath), { recursive: true, force: true });
      }
    }
  };
}
