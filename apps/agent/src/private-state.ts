import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod";

export const fileIdentitySchema = z.strictObject({
  device: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
  inode: z.string().regex(/^(?:0|[1-9][0-9]*)$/u)
});
export type FileIdentity = z.infer<typeof fileIdentitySchema>;

export type IdentityComparison = "exact" | "device-only-rebind" | "mismatch";

export class PrivateStateCorruptionError extends Error {
  constructor(readonly statePath: string, readonly reason: string) {
    super(`Agent-private state is corrupt: ${reason}`);
    this.name = "PrivateStateCorruptionError";
  }
}

export function identityOf(stats: BigIntStats): FileIdentity {
  return { device: stats.dev.toString(10), inode: stats.ino.toString(10) };
}

export function identitiesEqual(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

/** Classifies a persisted identity against a freshly observed live identity.
 *
 * The device-only case is intentionally a classification for finalized
 * ownership recovery only. Callers performing live validation and mutation
 * must continue to use identitiesEqual().
 */
export function comparePersistedIdentity(persisted: FileIdentity, current: FileIdentity): IdentityComparison {
  if (identitiesEqual(persisted, current)) return "exact";
  if (persisted.inode === current.inode && persisted.device !== current.device) return "device-only-rebind";
  return "mismatch";
}

export async function lstatIdentity(target: string): Promise<{ stats: BigIntStats; identity: FileIdentity } | null> {
  try {
    const stats = await lstat(target, { bigint: true });
    return { stats, identity: identityOf(stats) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Reads a private regular file through a no-follow descriptor and verifies the
 * descriptor identity/size remained stable for the complete read. Callers
 * that need a stronger content identity should hash the returned bytes.
 */
export async function readRegularFileNoFollow(
  target: string,
  maxBytes: number
): Promise<{ readonly bytes: Buffer; readonly stats: BigIntStats; readonly identity: FileIdentity }> {
  const descriptor = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await descriptor.stat({ bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new PrivateStateCorruptionError(target, "expected a regular file");
    if (before.size > BigInt(maxBytes)) throw new PrivateStateCorruptionError(target, "private file exceeds the read bound");
    const bytes = await descriptor.readFile();
    const after = await descriptor.stat({ bigint: true });
    if (!identitiesEqual(identityOf(before), identityOf(after)) || before.size !== after.size || BigInt(bytes.length) !== after.size) {
      throw new PrivateStateCorruptionError(target, "private file changed during read");
    }
    return { bytes, stats: after, identity: identityOf(after) };
  } finally {
    await descriptor.close();
  }
}

export interface PinnedDirectory {
  readonly path: string;
  readonly identity: FileIdentity;
}

/** Pins an administrator-provisioned directory without creating any filesystem object. */
export async function pinExistingDirectory(configuredPath: string): Promise<PinnedDirectory> {
  const absolute = path.resolve(configuredPath);
  const entry = await lstatIdentity(absolute);
  if (entry === null) {
    throw new PrivateStateCorruptionError(absolute, "configured directory must be provisioned before Agent startup");
  }
  if (!entry.stats.isDirectory() || entry.stats.isSymbolicLink()) {
    throw new PrivateStateCorruptionError(absolute, "configured directory is not an accepted real directory");
  }
  if (await realpath(absolute) !== absolute) {
    throw new PrivateStateCorruptionError(absolute, "configured directory is not an exact real directory");
  }
  return { path: absolute, identity: entry.identity };
}

/** Establishes an Agent-owned child directory beneath an already pinned configured root. */
export async function establishPinnedDirectory(configuredPath: string): Promise<PinnedDirectory> {
  const absolute = path.resolve(configuredPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const components = absolute.slice(parsed.root.length).split(path.sep).filter((component) => component !== "");
  for (const component of components) {
    const candidate = path.join(current, component);
    let entry = await lstatIdentity(candidate);
    if (entry === null) {
      const parent = await lstatIdentity(current);
      if (parent === null || !parent.stats.isDirectory() || parent.stats.isSymbolicLink()) {
        throw new PrivateStateCorruptionError(current, "directory parent is not an accepted real directory");
      }
      try { await mkdir(candidate, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      entry = await lstatIdentity(candidate);
    }
    if (entry === null || !entry.stats.isDirectory() || entry.stats.isSymbolicLink()) {
      throw new PrivateStateCorruptionError(candidate, "configured directory path contains an unsupported filesystem object");
    }
    current = candidate;
  }
  const finalEntry = await lstatIdentity(absolute);
  if (finalEntry === null || !finalEntry.stats.isDirectory() || finalEntry.stats.isSymbolicLink()
    || await realpath(absolute) !== absolute) {
    throw new PrivateStateCorruptionError(absolute, "configured directory is not an exact real directory");
  }
  return { path: absolute, identity: finalEntry.identity };
}

export interface AtomicJsonWriter {
  write(filePath: string, value: unknown): Promise<void>;
}

export const durableJsonWriter: AtomicJsonWriter = {
  async write(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    let created = false;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      created = true;
      const temporaryFile = await open(temporary, "r");
      try { await temporaryFile.sync(); } finally { await temporaryFile.close(); }
      await rename(temporary, filePath);
      created = false;
      const directory = await open(path.dirname(filePath), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      if (created) await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
};

export async function readStrictJson<Schema extends z.ZodType>(filePath: string, schema: Schema): Promise<z.infer<Schema>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new PrivateStateCorruptionError(filePath, "invalid JSON");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new PrivateStateCorruptionError(filePath, "runtime schema validation failed");
  return result.data;
}

/** Parses the exact bytes already read through a validated private descriptor. */
export function parseStrictJsonBytes<Schema extends z.ZodType>(bytes: Uint8Array, filePath: string, schema: Schema): z.infer<Schema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PrivateStateCorruptionError(filePath, "invalid JSON");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new PrivateStateCorruptionError(filePath, "runtime schema validation failed");
  return result.data;
}

export function assertContained(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return resolved;
  throw new Error("managed-path-escaped-root");
}
