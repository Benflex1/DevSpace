import { constants, type BigIntStats } from "node:fs";
import { chmod, mkdir, open, lstat, readdir, rename, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import path from "node:path";
import type { DockerEngineClient } from "./docker-runtime.js";

export const CODEX_AUTH_MAX_BYTES = 64 * 1024;
export const CODEX_AUTH_CREDENTIAL_SOURCE_IDENTITY = "agent-owned-persistent-codex-auth-v1" as const;
export const CODEX_AUTHORITY_POLICY_VERSION = "persistent-codex-authority-v1" as const;
export const CODEX_CREDENTIAL_LEASE_POLICY_VERSION = "exclusive-codex-lease-v1" as const;
export const CODEX_STAGED_WRITEBACK_POLICY_VERSION = "validated-atomic-codex-writeback-v1" as const;

const CODEX_AUTHORITY_DIRECTORY = "codex-auth/codex";
const CODEX_AUTH_FILE = "auth.json";
const CODEX_LEASE_DIRECTORY = ".lease";
const CODEX_REAUTH_MARKER = "reauth-required";
const CODEX_READ_TIMEOUT_MS = 5_000;
const CODEX_LEASE_MODE = 0o700;
const CODEX_FILE_MODE = 0o600;

type AuthorityDocument = Readonly<{
  auth_mode: "chatgpt";
  tokens: Readonly<{
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id?: string | null;
  }>;
  last_refresh: string;
}>;

export type ValidatedCodexAuthority = Readonly<{
  readonly bytes: Buffer;
  readonly document: AuthorityDocument;
}>;

export type CodexCredentialLeaseMetadata = Readonly<{
  aiSessionId: string;
  workspaceId: string;
  processGeneration: number;
}>;

export interface CodexCredentialLease {
  release(): Promise<void>;
}

type DockerReadbackClient = Pick<DockerEngineClient, "createExec" | "startExecAttached" | "inspectExec">;
type StagedReadbackInput = Readonly<{
  readonly docker: DockerReadbackClient;
  readonly containerId: string;
  readonly stagedAuthPath: string;
  readonly readbackHelperPath: string;
  readonly workingDirectory?: string;
}>;

export type LeaseFileSystem = Readonly<{
  readonly rename: (oldPath: string, newPath: string) => Promise<void>;
  readonly remove: (target: string) => Promise<void>;
  readonly lstat: (target: string) => Promise<void>;
  readonly syncDirectory: (directory: string) => Promise<void>;
}>;

export type CodexCredentialAuthorityOptions = Readonly<{
  /** Agent-private deterministic filesystem seam; production uses the real fs operations. */
  readonly leaseFileSystem?: Partial<LeaseFileSystem>;
  /** Agent-private deterministic descriptor-read seam; the server never supplies these hooks. */
  readonly persistentReadTestHooks?: Readonly<{
    readonly transformAfterSnapshot?: (snapshot: PersistentFileSnapshot) => PersistentFileSnapshot;
    readonly transformBytes?: (bytes: Buffer) => Buffer;
  }>;
}>;

type PersistentFileSnapshot = Readonly<{
  readonly regularFile: boolean;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly nlink: bigint;
}>;

export type StagedSnapshot = Readonly<{
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly nlink: bigint;
  readonly executionUid: bigint;
}>;

export type StagedReadbackProof = Readonly<{
  readonly before: StagedSnapshot;
  readonly bytes: Buffer;
  readonly after: StagedSnapshot;
}>;

const STAGED_READBACK_MAGIC = Buffer.from("DSAUTH01", "ascii");
const STAGED_READBACK_VERSION = 1;
const STAGED_READBACK_HEADER_BYTES = 20;
const STAGED_READBACK_SNAPSHOT_BYTES = 56;
const STAGED_READBACK_METADATA_BYTES = STAGED_READBACK_SNAPSHOT_BYTES * 2;

export interface CodexCredentialAuthority {
  /** Agent-private paths; these are not part of any Web or browser projection. */
  readonly authorityDir: string;
  readonly authPath: string;
  readonly leaseDir: string;
  readonly reauthMarkerPath: string;
  read(): Promise<ValidatedCodexAuthority>;
  inspect(): Promise<void>;
  acquire(metadata: CodexCredentialLeaseMetadata): Promise<CodexCredentialLease>;
  synchronizeStaged(input: StagedReadbackInput): Promise<void>;
  replaceDurable(bytes: Uint8Array, options?: { readonly failAfterWrite?: () => void }): Promise<void>;
  markReauthenticationRequired(): Promise<void>;
  /** Clears the deliberate reauthentication gate only after a new authority is durable. */
  clearReauthenticationRequired(): Promise<void>;
}

export function codexAuthorityDirectoryForStateRoot(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), CODEX_AUTHORITY_DIRECTORY);
}

function safeError(code: string): Error {
  return new Error(`codex-${code}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw safeError(code);
  return value;
}

function validateJwtShape(value: unknown): string {
  const jwt = requireNonEmptyString(value, "authority-token");
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) throw safeError("authority-token");
  try {
    JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    throw safeError("authority-token");
  }
  return jwt;
}

export function validateCodexChatGptAuthority(input: string | Uint8Array): ValidatedCodexAuthority {
  const bytes = Buffer.from(input);
  if (bytes.length === 0 || bytes.length > CODEX_AUTH_MAX_BYTES) throw safeError("authority-file");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw safeError("authority-utf8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw safeError("authority-json");
  }
  if (!isObject(parsed)) throw safeError("authority-structure");
  const topLevelKeys = Object.keys(parsed).sort();
  if (topLevelKeys.some((key) => !["OPENAI_API_KEY", "auth_mode", "last_refresh", "tokens"].includes(key))) throw safeError("authority-fields");
  if (Object.hasOwn(parsed, "OPENAI_API_KEY") && parsed.OPENAI_API_KEY !== null) throw safeError("authority-fields");
  if (!topLevelKeys.includes("last_refresh")) throw safeError("authority-last-refresh");
  if (!topLevelKeys.includes("auth_mode") || !topLevelKeys.includes("tokens")) throw safeError("authority-structure");
  if (parsed.auth_mode !== "chatgpt") throw safeError("authority-auth-mode");
  const lastRefresh = requireNonEmptyString(parsed.last_refresh, "authority-last-refresh");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(lastRefresh) || Number.isNaN(Date.parse(lastRefresh))) {
    throw safeError("authority-last-refresh");
  }
  if (!isObject(parsed.tokens)) throw safeError("authority-tokens");
  const tokenKeys = Object.keys(parsed.tokens).sort();
  const allowedTokenKeys = ["account_id", "access_token", "id_token", "refresh_token"];
  if (tokenKeys.some((key) => !allowedTokenKeys.includes(key))) throw safeError("authority-token-fields");
  const tokens = parsed.tokens;
  const idToken = validateJwtShape(tokens.id_token);
  const accessToken = requireNonEmptyString(tokens.access_token, "authority-token");
  const refreshToken = requireNonEmptyString(tokens.refresh_token, "authority-token");
  const accountId = tokens.account_id === undefined || tokens.account_id === null
    ? tokens.account_id : requireNonEmptyString(tokens.account_id, "authority-token");
  const document: AuthorityDocument = {
    auth_mode: "chatgpt",
    tokens: { id_token: idToken, access_token: accessToken, refresh_token: refreshToken, ...(accountId === undefined ? {} : { account_id: accountId }) },
    last_refresh: lastRefresh
  };
  return { bytes, document };
}

function expectedUid(): bigint | null {
  const uid = process.getuid?.();
  return uid === undefined ? null : BigInt(uid);
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  let stats;
  try { stats = await lstat(directory, { bigint: true }); } catch { throw safeError("authority-directory"); }
  if (!stats.isDirectory() || (stats.mode & 0o777n) !== 0o700n || (expectedUid() !== null && stats.uid !== expectedUid())) {
    throw safeError("authority-directory");
  }
}

function persistentFileSnapshot(stats: BigIntStats): PersistentFileSnapshot {
  return {
    regularFile: stats.isFile(),
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mode: stats.mode,
    uid: stats.uid,
    nlink: stats.nlink
  };
}

function validPersistentFileSnapshot(snapshot: PersistentFileSnapshot, uid: bigint | null): boolean {
  return snapshot.regularFile && (snapshot.mode & 0o7777n) === 0o600n
    && (uid === null || snapshot.uid === uid) && snapshot.nlink === 1n
    && snapshot.size > 0n && snapshot.size <= BigInt(CODEX_AUTH_MAX_BYTES);
}

async function readNoFollowFile(
  filePath: string,
  hooks: CodexCredentialAuthorityOptions["persistentReadTestHooks"]
): Promise<Buffer> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw safeError("authority-file");
  }
  try {
    const uid = expectedUid();
    const before = persistentFileSnapshot(await handle.stat({ bigint: true }));
    if (!validPersistentFileSnapshot(before, uid)) throw safeError("authority-file");
    const readBytes = await handle.readFile();
    const bytes = hooks?.transformBytes?.(readBytes) ?? readBytes;
    const observedAfter = persistentFileSnapshot(await handle.stat({ bigint: true }));
    const after = hooks?.transformAfterSnapshot?.(observedAfter) ?? observedAfter;
    if (!validPersistentFileSnapshot(after, uid)
      || after.regularFile !== before.regularFile || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mode !== before.mode || after.uid !== before.uid || after.nlink !== before.nlink
      || bytes.length !== Number(before.size)) throw safeError("authority-file");
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("codex-")) throw error;
    throw safeError("authority-file");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function existsAsAnyPath(filePath: string): Promise<boolean> {
  try { await lstat(filePath); return true; } catch { return false; }
}

async function assertAbsentUsing(filePath: string, check: (target: string) => Promise<void>): Promise<void> {
  try { await check(filePath); throw safeError("credential-lease-release"); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("codex-")) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw safeError("credential-lease-release");
  }
}

async function hasLeaseControl(authorityDir: string, leaseDir: string): Promise<boolean> {
  if (await existsAsAnyPath(leaseDir)) return true;
  try {
    const entries = await readdir(authorityDir);
    return entries.some((entry) => entry.startsWith(".lease-release-"));
  } catch {
    return true;
  }
}

async function readExactLeaseMetadata(metadataPath: string, expected: string): Promise<void> {
  let handle;
  try {
    handle = await open(metadataPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    const expectedBytes = Buffer.from(expected, "utf8");
    if (!before.isFile() || (before.mode & 0o777n) !== 0o600n || before.nlink !== 1n ||
      (expectedUid() !== null && before.uid !== expectedUid()) || before.size !== BigInt(expectedBytes.length)) {
      throw safeError("credential-lease-release");
    }
    const current = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (current.length !== expectedBytes.length || !current.equals(expectedBytes)
      || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mode !== before.mode || after.uid !== before.uid || after.nlink !== before.nlink) {
      throw safeError("credential-lease-release");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("codex-")) throw error;
    throw safeError("credential-lease-release");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readDockerOutput(stream: Duplex): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let total = 0;
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      stream.destroy(); reject(safeError("staged-read-timeout"));
    }, CODEX_READ_TIMEOUT_MS);
    const done = (error?: Error) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      stream.removeAllListeners("data"); stream.removeAllListeners("error"); stream.removeAllListeners("close");
      if (error !== undefined) reject(error); else resolve(Buffer.concat(chunks));
      chunks = [];
    };
    stream.on("data", (chunk: Buffer) => {
      const value = Buffer.from(chunk);
      total += value.length;
      if (total > CODEX_AUTH_MAX_BYTES + 512) { stream.destroy(); done(safeError("staged-read-size")); return; }
      chunks.push(value);
    });
    stream.once("error", () => done(safeError("staged-read")));
    stream.once("close", () => done());
    stream.resume();
  });
}

function decodeDockerFrames(input: Buffer): Buffer {
  const output: Buffer[] = [];
  let offset = 0;
  while (offset < input.length) {
    if (offset + 8 > input.length) throw safeError("staged-read");
    const size = input.readUInt32BE(offset + 4);
    if (offset + 8 + size > input.length) throw safeError("staged-read");
    if (input[offset] === 1) output.push(input.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(output);
}

function readU64(input: Buffer, offset: number): bigint {
  if (offset + 8 > input.length) throw safeError("staged-read");
  return input.readBigUInt64BE(offset);
}

function readStagedSnapshot(input: Buffer, offset: number): StagedSnapshot {
  return {
    dev: readU64(input, offset), ino: readU64(input, offset + 8), size: readU64(input, offset + 16),
    mode: readU64(input, offset + 24), uid: readU64(input, offset + 32), nlink: readU64(input, offset + 40),
    executionUid: readU64(input, offset + 48)
  };
}

function decodePrivateStagedReadback(input: Buffer): StagedReadbackProof {
  if (input.length < STAGED_READBACK_HEADER_BYTES || !input.subarray(0, STAGED_READBACK_MAGIC.length).equals(STAGED_READBACK_MAGIC)
    || input.readUInt32BE(8) !== STAGED_READBACK_VERSION || input.readUInt32BE(12) !== STAGED_READBACK_METADATA_BYTES) {
    throw safeError("staged-read");
  }
  const byteLength = input.readUInt32BE(16);
  const expectedLength = STAGED_READBACK_HEADER_BYTES + STAGED_READBACK_METADATA_BYTES + byteLength;
  if (byteLength === 0 || byteLength > CODEX_AUTH_MAX_BYTES || expectedLength !== input.length) throw safeError("staged-file");
  const before = readStagedSnapshot(input, STAGED_READBACK_HEADER_BYTES);
  const after = readStagedSnapshot(input, STAGED_READBACK_HEADER_BYTES + STAGED_READBACK_SNAPSHOT_BYTES);
  const bytes = input.subarray(STAGED_READBACK_HEADER_BYTES + STAGED_READBACK_METADATA_BYTES);
  const validSnapshot = (snapshot: StagedSnapshot) =>
    (snapshot.mode & 0o170000n) === 0o100000n && (snapshot.mode & 0o7777n) === 0o600n
    && snapshot.uid === snapshot.executionUid && snapshot.nlink === 1n && snapshot.size > 0n
    && snapshot.size <= BigInt(CODEX_AUTH_MAX_BYTES);
  if (!validSnapshot(before) || !validSnapshot(after) || before.executionUid !== after.executionUid
    || bytes.length !== Number(before.size) || after.dev !== before.dev || after.ino !== before.ino
    || after.size !== before.size || after.mode !== before.mode || after.uid !== before.uid || after.nlink !== before.nlink) {
    throw safeError("staged-file");
  }
  return { before, bytes: Buffer.from(bytes), after };
}

async function readStagedAuth(input: StagedReadbackInput): Promise<StagedReadbackProof> {
  const execId = await input.docker.createExec(input.containerId, {
    command: [input.readbackHelperPath],
    workingDirectory: input.workingDirectory ?? "/workspace", environment: { DEVSPACE_TARGET_FILE: input.stagedAuthPath }, attachStdin: false, tty: false
  });
  const stream = await input.docker.startExecAttached(execId, false);
  const output = await readDockerOutput(stream);
  let inspection;
  try { inspection = await input.docker.inspectExec(execId); } catch { throw safeError("staged-file"); }
  if (inspection.Running || inspection.ExitCode !== 0) throw safeError("staged-file");
  return decodePrivateStagedReadback(decodeDockerFrames(output));
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  }
}

class FileCodexCredentialAuthority implements CodexCredentialAuthority {
  readonly authPath: string;
  readonly leaseDir: string;
  readonly reauthMarkerPath: string;
  private readonly leaseFileSystem: LeaseFileSystem;
  constructor(readonly authorityDir: string, private readonly options: CodexCredentialAuthorityOptions = {}) {
    this.authPath = path.join(authorityDir, CODEX_AUTH_FILE);
    this.leaseDir = path.join(authorityDir, CODEX_LEASE_DIRECTORY);
    this.reauthMarkerPath = path.join(authorityDir, CODEX_REAUTH_MARKER);
    this.leaseFileSystem = {
      rename: options.leaseFileSystem?.rename ?? (async (oldPath, newPath) => { await rename(oldPath, newPath); }),
      remove: options.leaseFileSystem?.remove ?? (async (target) => { await rm(target, { recursive: true, force: false }); }),
      lstat: options.leaseFileSystem?.lstat ?? (async (target) => { await lstat(target); }),
      syncDirectory: options.leaseFileSystem?.syncDirectory ?? syncDirectory
    };
  }
  async read(): Promise<ValidatedCodexAuthority> {
    await assertPrivateDirectory(this.authorityDir);
    return validateCodexChatGptAuthority(await readNoFollowFile(this.authPath, this.options.persistentReadTestHooks));
  }
  async inspect(): Promise<void> {
    await assertPrivateDirectory(this.authorityDir);
    if (await hasLeaseControl(this.authorityDir, this.leaseDir) || await existsAsAnyPath(this.reauthMarkerPath)) throw safeError("credential-unavailable");
    await this.read();
  }
  async acquire(metadata: CodexCredentialLeaseMetadata): Promise<CodexCredentialLease> {
    await assertPrivateDirectory(this.authorityDir);
    if (await hasLeaseControl(this.authorityDir, this.leaseDir)) throw safeError("credential-lease-unavailable");
    try {
      await mkdir(this.leaseDir, { mode: CODEX_LEASE_MODE });
    } catch {
      throw safeError("credential-lease-unavailable");
    }
    const leaseMetadata = JSON.stringify({ leaseId: randomUUID(), aiSessionId: metadata.aiSessionId, workspaceId: metadata.workspaceId, processGeneration: metadata.processGeneration, acquiredAt: new Date().toISOString(), pid: process.pid });
    const leaseMetadataPath = path.join(this.leaseDir, "metadata.json");
    try {
      const handle = await open(leaseMetadataPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, CODEX_FILE_MODE);
      try { await handle.writeFile(leaseMetadata, "utf8"); await handle.sync(); } finally { await handle.close(); }
    } catch {
      await rm(this.leaseDir, { recursive: true, force: true }).catch(() => undefined);
      throw safeError("credential-lease-unavailable");
    }
    let releaseState: "owned" | "renamed" | "released" = "owned";
    let releasePath: string | null = null;
    let renameSynchronized = false;
    let removalSynchronized = false;
    let removalObserved = false;
    return {
      release: async () => {
        if (releaseState === "released") return;
        if (releaseState === "owned") {
          await readExactLeaseMetadata(leaseMetadataPath, leaseMetadata);
          releasePath = path.join(this.authorityDir, `.lease-release-${randomUUID()}`);
          try {
            await this.leaseFileSystem.rename(this.leaseDir, releasePath);
            releaseState = "renamed";
          } catch {
            let leaseStillExists = false;
            let ownedReleaseExists = false;
            try { await this.leaseFileSystem.lstat(this.leaseDir); leaseStillExists = true; } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw safeError("credential-lease-release");
            }
            try { await this.leaseFileSystem.lstat(releasePath); ownedReleaseExists = true; } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw safeError("credential-lease-release");
            }
            if (!leaseStillExists && ownedReleaseExists) releaseState = "renamed";
            else { releasePath = null; throw safeError("credential-lease-release"); }
          }
        }
        if (releasePath === null || releaseState !== "renamed") throw safeError("credential-lease-release");
        if (!renameSynchronized) {
          try { await this.leaseFileSystem.syncDirectory(this.authorityDir); }
          catch { throw safeError("credential-lease-release"); }
          renameSynchronized = true;
        }
        try { await this.leaseFileSystem.lstat(this.leaseDir); throw safeError("credential-lease-release"); }
        catch (error) {
          if (error instanceof Error && error.message.startsWith("codex-")) throw error;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw safeError("credential-lease-release");
        }
        if (!removalSynchronized) {
          let ownedReleaseExists = true;
          try { await this.leaseFileSystem.lstat(releasePath); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") ownedReleaseExists = false;
            else throw safeError("credential-lease-release");
          }
          if (ownedReleaseExists) {
            try { await this.leaseFileSystem.remove(releasePath); removalObserved = true; }
            catch {
              let stillExists = false;
              try { await this.leaseFileSystem.lstat(releasePath); stillExists = true; }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw safeError("credential-lease-release");
              }
              if (stillExists) throw safeError("credential-lease-release");
              removalObserved = true;
              throw safeError("credential-lease-release");
            }
          }
          if (removalObserved) {
            try { await this.leaseFileSystem.syncDirectory(this.authorityDir); }
            catch { throw safeError("credential-lease-release"); }
          }
          removalSynchronized = true;
        }
        try {
          await assertAbsentUsing(this.leaseDir, this.leaseFileSystem.lstat);
          await assertAbsentUsing(releasePath, this.leaseFileSystem.lstat);
        } catch { throw safeError("credential-lease-release"); }
        releaseState = "released";
      }
    };
  }
  async synchronizeStaged(input: StagedReadbackInput): Promise<void> {
    const first = await readStagedAuth(input);
    const second = await readStagedAuth(input);
    const sameSnapshot = (left: StagedSnapshot, right: StagedSnapshot) => left.dev === right.dev && left.ino === right.ino
      && left.size === right.size && left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink
      && left.executionUid === right.executionUid;
    if (!first.bytes.equals(second.bytes) || !sameSnapshot(first.before, second.before) || !sameSnapshot(first.after, second.after)) {
      throw safeError("staged-unstable");
    }
    validateCodexChatGptAuthority(first.bytes);
    await this.replaceDurable(first.bytes);
  }
  async replaceDurable(bytes: Uint8Array, options: { readonly failAfterWrite?: () => void } = {}): Promise<void> {
    validateCodexChatGptAuthority(bytes);
    await assertPrivateDirectory(this.authorityDir);
    const temporaryPath = path.join(this.authorityDir, `.${CODEX_AUTH_FILE}.tmp-${process.pid}-${randomUUID()}`);
    let handle;
    try {
      handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, CODEX_FILE_MODE);
      await handle.writeFile(bytes);
      await chmod(temporaryPath, CODEX_FILE_MODE);
      await handle.sync();
      options.failAfterWrite?.();
      await handle.close(); handle = undefined;
      await rename(temporaryPath, this.authPath);
      await syncDirectory(this.authorityDir);
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof Error && error.message.startsWith("injected-")) throw error;
      throw safeError("authority-write");
    }
  }
  async markReauthenticationRequired(): Promise<void> {
    await assertPrivateDirectory(this.authorityDir);
    try {
      const handle = await open(this.reauthMarkerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, CODEX_FILE_MODE);
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw safeError("reauth-marker");
    }
  }
  async clearReauthenticationRequired(): Promise<void> {
    await assertPrivateDirectory(this.authorityDir);
    let stats;
    try { stats = await lstat(this.reauthMarkerPath, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw safeError("reauth-marker");
    }
    if (!stats.isFile() || (stats.mode & 0o7777n) !== 0o600n
      || (expectedUid() !== null && stats.uid !== expectedUid()) || stats.nlink !== 1n) {
      throw safeError("reauth-marker");
    }
    try { await unlink(this.reauthMarkerPath); }
    catch { throw safeError("reauth-marker"); }
    try { await syncDirectory(this.authorityDir); }
    catch { throw safeError("reauth-marker"); }
    if (await existsAsAnyPath(this.reauthMarkerPath)) throw safeError("reauth-marker");
  }
}

export function createCodexCredentialAuthority(stateRoot: string, options: CodexCredentialAuthorityOptions = {}): CodexCredentialAuthority {
  return new FileCodexCredentialAuthority(codexAuthorityDirectoryForStateRoot(stateRoot), options);
}

export { readStagedAuth };
