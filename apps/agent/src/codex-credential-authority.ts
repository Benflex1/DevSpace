import { constants } from "node:fs";
import { chmod, mkdir, open, lstat, rename, rm } from "node:fs/promises";
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

export interface CodexCredentialAuthority {
  /** Agent-private paths; these are not part of any Web or browser projection. */
  readonly authorityDir: string;
  readonly authPath: string;
  readonly leaseDir: string;
  readonly reauthMarkerPath: string;
  read(): Promise<ValidatedCodexAuthority>;
  inspect(): Promise<void>;
  acquire(metadata: CodexCredentialLeaseMetadata): Promise<CodexCredentialLease>;
  synchronizeStaged(input: { docker: DockerReadbackClient; containerId: string; stagedAuthPath: string }): Promise<void>;
  replaceDurable(bytes: Uint8Array, options?: { readonly failAfterWrite?: () => void }): Promise<void>;
  markReauthenticationRequired(): Promise<void>;
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
  if (topLevelKeys.some((key) => !["auth_mode", "last_refresh", "tokens"].includes(key))) throw safeError("authority-fields");
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

async function readNoFollowFile(filePath: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw safeError("authority-file");
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || (before.mode & 0o777n) !== 0o600n || before.nlink !== 1n ||
      (expectedUid() !== null && before.uid !== expectedUid()) || before.size === 0n || before.size > BigInt(CODEX_AUTH_MAX_BYTES)) {
      throw safeError("authority-file");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) throw safeError("authority-file");
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

async function readStagedAuth(input: { docker: DockerReadbackClient; containerId: string; stagedAuthPath: string }): Promise<Buffer> {
  const execId = await input.docker.createExec(input.containerId, {
    command: ["sh", "-c", "set -eu; test -f \"$DEVSPACE_TARGET_FILE\"; test ! -L \"$DEVSPACE_TARGET_FILE\"; stat -c '%F %a %s' -- \"$DEVSPACE_TARGET_FILE\"; cat -- \"$DEVSPACE_TARGET_FILE\""],
    workingDirectory: "/workspace", environment: { DEVSPACE_TARGET_FILE: input.stagedAuthPath }, attachStdin: false, tty: false
  });
  const stream = await input.docker.startExecAttached(execId, false);
  const framed = decodeDockerFrames(await readDockerOutput(stream));
  const newline = framed.indexOf(10);
  if (newline < 0) throw safeError("staged-file");
  const metadata = framed.subarray(0, newline).toString("utf8").split(" ");
  const bytes = framed.subarray(newline + 1);
  if (metadata.length !== 4 || metadata[0] !== "regular" || metadata[1] !== "file" || metadata[2] !== "600") {
    throw safeError("staged-file");
  }
  const size = Number(metadata[metadata.length - 1]);
  if (!Number.isSafeInteger(size) || size <= 0 || size > CODEX_AUTH_MAX_BYTES || bytes.length !== size) throw safeError("staged-file");
  const inspection = await input.docker.inspectExec(execId);
  if (inspection.Running || inspection.ExitCode !== 0) throw safeError("staged-file");
  return bytes;
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
  constructor(readonly authorityDir: string) {
    this.authPath = path.join(authorityDir, CODEX_AUTH_FILE);
    this.leaseDir = path.join(authorityDir, CODEX_LEASE_DIRECTORY);
    this.reauthMarkerPath = path.join(authorityDir, CODEX_REAUTH_MARKER);
  }
  async read(): Promise<ValidatedCodexAuthority> {
    await assertPrivateDirectory(this.authorityDir);
    return validateCodexChatGptAuthority(await readNoFollowFile(this.authPath));
  }
  async inspect(): Promise<void> {
    await assertPrivateDirectory(this.authorityDir);
    if (await existsAsAnyPath(this.leaseDir) || await existsAsAnyPath(this.reauthMarkerPath)) throw safeError("credential-unavailable");
    await this.read();
  }
  async acquire(metadata: CodexCredentialLeaseMetadata): Promise<CodexCredentialLease> {
    await assertPrivateDirectory(this.authorityDir);
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
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        let currentMetadata: string;
        let handle;
        try {
          handle = await open(leaseMetadataPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          currentMetadata = (await handle.readFile()).toString("utf8");
        } catch {
          return;
        } finally {
          await handle?.close().catch(() => undefined);
        }
        if (currentMetadata !== leaseMetadata) return;
        await rm(this.leaseDir, { recursive: true, force: true });
      }
    };
  }
  async synchronizeStaged(input: { docker: DockerReadbackClient; containerId: string; stagedAuthPath: string }): Promise<void> {
    const first = await readStagedAuth(input);
    const second = await readStagedAuth(input);
    if (!first.equals(second)) throw safeError("staged-unstable");
    validateCodexChatGptAuthority(first);
    await this.replaceDurable(first);
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
}

export function createCodexCredentialAuthority(stateRoot: string): CodexCredentialAuthority {
  return new FileCodexCredentialAuthority(codexAuthorityDirectoryForStateRoot(stateRoot));
}

export { readStagedAuth };
