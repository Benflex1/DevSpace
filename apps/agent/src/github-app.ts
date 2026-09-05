import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { createPrivateKey, createSign, randomUUID } from "node:crypto";
import path from "node:path";
import * as z from "zod";
import {
  githubAppInspectionSchema,
  githubConnectionIdSchema,
  githubDecimalIdSchema,
  githubInstallationInspectionSchema,
  githubInstallationRefreshDataSchema,
  githubInstallationVerifyDataSchema,
  githubRepositoryResolveDataSchema,
  githubRepositoryResolutionSchema,
  githubRepositorySchema,
  githubRepositoriesListDataSchema,
  githubRepositoryPageSchema,
  type GithubAppInspection,
  type GithubInstallationInspection,
  type GithubInstallationRefreshData,
  type GithubInstallationVerifyData,
  type GithubRepository,
  type GithubRepositoryResolution,
  type GithubRepositoryResolveData,
  type GithubRepositoriesListData,
  type GithubRepositoryPage
} from "@devspace/contracts";
import { durableJsonWriter, parseStrictJsonBytes, type AtomicJsonWriter } from "./private-state.js";

const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_KEY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const GITHUB_API_VERSION = "2022-11-28";
const MAX_INSTALLATION_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const CONSERVATIVE_UNKNOWN_MINT_LEASE_MS = 70 * 60 * 1000;
const githubTokenExpirySchema = z.string().datetime({ offset: true });
const bindingSchema = githubInstallationInspectionSchema.omit({ cleanupDegraded: true }).extend({ version: z.literal(1), cleanupDegraded: z.boolean() });
const configSchema = z.strictObject({
  version: z.literal(1), appId: githubDecimalIdSchema, expectedAccountId: githubDecimalIdSchema,
  expectedAccountType: z.enum(["User", "Organization"]),
  installationUrl: z.string().url().max(2_048).refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  })
});
const leaseSchema = z.strictObject({
  version: z.literal(1), connectionId: githubConnectionIdSchema, operationId: z.string().uuid(),
  expiresAt: z.string().datetime({ offset: true }), phase: z.enum(["minting", "active", "cleanup-degraded"]), createdAt: z.string().datetime({ offset: true })
});

export interface GithubHttpRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly authorization: string;
  readonly body?: unknown;
}
export interface GithubHttpResponse { readonly status: number; readonly body: unknown }
export type GithubHttpTransport = (request: GithubHttpRequest) => Promise<GithubHttpResponse>;

function failure(code: string): Error { return new Error(`github-${code}`); }
function safePrimaryFailure(error: unknown): Error {
  if (error instanceof Error && /^(?:github-(?:continuation-invalid|operation-failed|token-mint-failed|upstream-invalid|contents-permission-required|installation-unavailable|repository-not-authorized|git-authentication-failed))$/u.test(error.message)) return error;
  return failure("upstream-invalid");
}
interface GithubJsonNumber { readonly kind: "github-json-number"; readonly value: string }
function githubJsonNumber(value: string): GithubJsonNumber { return { kind: "github-json-number", value }; }
function decimal(value: unknown): string | null {
  if (record(value)?.kind === "github-json-number" && typeof record(value)?.value === "string") {
    const candidate = record(value)?.value;
    return githubDecimalIdSchema.safeParse(candidate).success ? candidate as string : null;
  }
  if (typeof value === "bigint") return value >= 0n ? value.toString(10) : null;
  if (typeof value === "string") return githubDecimalIdSchema.safeParse(value).success ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function filenameConnectionId(name: string): string {
  if (!name.endsWith(".json")) throw failure("private-state-invalid");
  const result = githubConnectionIdSchema.safeParse(name.slice(0, -5));
  if (!result.success) throw failure("private-state-invalid");
  return result.data;
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const stats = await lstat(directory, { bigint: true }).catch(() => null);
  const uid = process.getuid?.();
  if (stats === null || !stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o777n) !== 0o700n
    || (uid !== undefined && stats.uid !== BigInt(uid))) throw failure("private-state-invalid");
}

async function readPrivateFile(file: string, maxBytes: number, afterRead?: () => Promise<void> | void): Promise<Buffer> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw failure("private-state-invalid"); }
  try {
    const uid = process.getuid?.();
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || (before.mode & 0o7777n) !== 0o600n
      || before.size < 1n || before.size > BigInt(maxBytes) || (uid !== undefined && before.uid !== BigInt(uid))) throw failure("private-state-invalid");
    const byteLength = Number(before.size);
    const bytes = Buffer.allocUnsafe(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const result = await handle.read(bytes, offset, byteLength - offset, null);
      if (result.bytesRead === 0) throw failure("private-state-invalid");
      offset += result.bytesRead;
    }
    await afterRead?.();
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || (after.mode & 0o7777n) !== 0o600n
      || after.size < 1n || after.size > BigInt(maxBytes) || (uid !== undefined && after.uid !== BigInt(uid))
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mode !== after.mode || before.uid !== after.uid || before.nlink !== after.nlink
      || bytes.length !== Number(before.size)) throw failure("private-state-invalid");
    return bytes;
  } finally { await handle.close().catch(() => undefined); }
}

class GithubJsonParser {
  private offset = 0;
  constructor(private readonly text: string) {}
  parse(): unknown {
    const value = this.value(); this.space();
    if (this.offset !== this.text.length) throw failure("upstream-invalid");
    return value;
  }
  private space(): void { while (this.offset < this.text.length && /\s/u.test(this.text[this.offset]!)) this.offset += 1; }
  private value(): unknown {
    this.space();
    const character = this.text[this.offset];
    if (character === "{") return this.object();
    if (character === "[") return this.array();
    if (character === '"') return this.string();
    if (character === "t" && this.text.startsWith("true", this.offset)) { this.offset += 4; return true; }
    if (character === "f" && this.text.startsWith("false", this.offset)) { this.offset += 5; return false; }
    if (character === "n" && this.text.startsWith("null", this.offset)) { this.offset += 4; return null; }
    if (character === "-" || (character !== undefined && /[0-9]/u.test(character))) return this.number();
    throw failure("upstream-invalid");
  }
  private string(): string {
    const start = this.offset; this.offset += 1;
    let escaped = false;
    while (this.offset < this.text.length) {
      const character = this.text[this.offset]!;
      if (character.codePointAt(0)! < 0x20) throw failure("upstream-invalid");
      this.offset += 1;
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character === '"') {
        try { return JSON.parse(this.text.slice(start, this.offset)) as string; }
        catch { throw failure("upstream-invalid"); }
      }
    }
    throw failure("upstream-invalid");
  }
  private number(): GithubJsonNumber {
    const start = this.offset;
    if (this.text[this.offset] === "-") this.offset += 1;
    if (this.text[this.offset] === "0") this.offset += 1;
    else {
      if (this.text[this.offset] === undefined || !/[1-9]/u.test(this.text[this.offset]!)) throw failure("upstream-invalid");
      while (this.offset < this.text.length && /[0-9]/u.test(this.text[this.offset]!)) this.offset += 1;
    }
    if (this.text[this.offset] === ".") {
      this.offset += 1; if (this.text[this.offset] === undefined || !/[0-9]/u.test(this.text[this.offset]!)) throw failure("upstream-invalid");
      while (this.offset < this.text.length && /[0-9]/u.test(this.text[this.offset]!)) this.offset += 1;
    }
    if (this.text[this.offset] === "e" || this.text[this.offset] === "E") {
      this.offset += 1; if (this.text[this.offset] === "+" || this.text[this.offset] === "-") this.offset += 1;
      if (this.text[this.offset] === undefined || !/[0-9]/u.test(this.text[this.offset]!)) throw failure("upstream-invalid");
      while (this.offset < this.text.length && /[0-9]/u.test(this.text[this.offset]!)) this.offset += 1;
    }
    return githubJsonNumber(this.text.slice(start, this.offset));
  }
  private object(): Record<string, unknown> {
    this.offset += 1; const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>; this.space();
    if (this.text[this.offset] === "}") { this.offset += 1; return result; }
    while (true) {
      this.space(); if (this.text[this.offset] !== '"') throw failure("upstream-invalid");
      const key = this.string(); this.space(); if (this.text[this.offset] !== ":") throw failure("upstream-invalid");
      this.offset += 1; if (Object.hasOwn(result, key)) throw failure("upstream-invalid");
      result[key] = this.value(); this.space();
      if (this.text[this.offset] === "}") { this.offset += 1; return result; }
      if (this.text[this.offset] !== ",") throw failure("upstream-invalid"); this.offset += 1;
    }
  }
  private array(): unknown[] {
    this.offset += 1; const result: unknown[] = []; this.space();
    if (this.text[this.offset] === "]") { this.offset += 1; return result; }
    while (true) {
      result.push(this.value()); this.space();
      if (this.text[this.offset] === "]") { this.offset += 1; return result; }
      if (this.text[this.offset] !== ",") throw failure("upstream-invalid"); this.offset += 1;
    }
  }
}
function parseLosslessGithubJson(text: string): unknown { return new GithubJsonParser(text).parse(); }

function serializeGithubRequestBody(body: unknown): string {
  const exact = z.strictObject({ kind: z.literal("exact-repository-token"), repositoryId: githubDecimalIdSchema }).safeParse(body);
  if (exact.success) return `{"repository_ids":[${exact.data.repositoryId}],"permissions":{"contents":"read"}}`;
  const metadata = z.strictObject({ permissions: z.strictObject({ metadata: z.literal("read") }) }).safeParse(body);
  if (metadata.success) return '{"permissions":{"metadata":"read"}}';
  throw failure("upstream-invalid");
}
async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
async function readBoundedResponseBytes(response: Response): Promise<Buffer> {
  const rawContentLength = response.headers.get("content-length");
  const rawContentEncoding = response.headers.get("content-encoding");
  const encodedRepresentation = rawContentEncoding !== null && rawContentEncoding.trim().toLowerCase() !== "identity";
  let contentLength: number | null = null;
  if (rawContentLength !== null) {
    const normalized = rawContentLength.trim();
    if (!/^\d+$/u.test(normalized)) {
      await cancelResponse(response);
      throw failure("upstream-invalid");
    }
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed) || parsed > MAX_RESPONSE_BYTES) {
      await cancelResponse(response);
      throw failure("upstream-invalid");
    }
    contentLength = parsed;
  }
  if (response.body === null) {
    if (contentLength !== null && contentLength !== 0) throw failure("upstream-invalid");
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const value = result.value;
      if (value === undefined || value.byteLength > MAX_RESPONSE_BYTES - total) {
        await reader.cancel().catch(() => undefined);
        throw failure("upstream-invalid");
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } catch (error) {
    if (error instanceof Error && error.message === "github-upstream-invalid") throw error;
    throw failure("upstream-invalid");
  }
  if (!encodedRepresentation && contentLength !== null && total !== contentLength) throw failure("upstream-invalid");
  return Buffer.concat(chunks, total);
}
const defaultTransport: GithubHttpTransport = async (request) => {
  const response = await fetch(`https://api.github.com${request.path}`, {
    method: request.method,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/vnd.github+json", "Accept-Encoding": "identity", Authorization: request.authorization, "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...(request.body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(request.body === undefined ? {} : { body: serializeGithubRequestBody(request.body) })
  });
  const bytes = await readBoundedResponseBytes(response);
  let body: unknown = {};
  if (bytes.length !== 0) {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw failure("upstream-invalid"); }
    try { body = parseLosslessGithubJson(text); } catch { throw failure("upstream-invalid"); }
  }
  return { status: response.status, body };
};

function jwt(privateKey: Buffer, appId: string, now: Date): string {
  const issuedAt = Math.floor(now.valueOf() / 1000) - 30;
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: appId })).toString("base64url");
  const input = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256"); signer.update(input); signer.end();
  return `${input}.${signer.sign(privateKey).toString("base64url")}`;
}

function safeRepository(value: unknown): GithubRepository {
  const repository = record(value); const owner = record(repository?.owner);
  if (repository === null || owner === null || typeof owner.login !== "string" || typeof repository.name !== "string"
    || typeof repository.full_name !== "string" || typeof repository.default_branch !== "string"
    || typeof repository.private !== "boolean" || typeof repository.archived !== "boolean" || typeof repository.disabled !== "boolean") {
    throw failure("upstream-invalid");
  }
  try {
    return githubRepositorySchema.parse({
      repositoryId: decimal(repository.id), ownerLogin: owner.login, name: repository.name,
      fullName: repository.full_name, cleanHttpsUrl: `https://github.com/${owner.login}/${repository.name}.git`,
      defaultBranch: repository.default_branch, private: repository.private, archived: repository.archived, disabled: repository.disabled
    });
  } catch { throw failure("upstream-invalid"); }
}

function exactScopedRepository(value: unknown, repositoryId: string): GithubRepository {
  const body = record(value); const repositories = body?.repositories;
  const selection = body?.repository_selection;
  const permissions = record(body?.permissions);
  if (selection !== "selected" || permissions === null || permissions.contents !== "read"
    || Object.entries(permissions).some(([name, level]) => name !== "contents" && !(name === "metadata" && level === "read"))) {
    throw failure("repository-not-authorized");
  }
  if (!Array.isArray(repositories) || repositories.length !== 1) throw failure("repository-not-authorized");
  const repository = safeRepository(repositories[0]);
  if (repository.repositoryId !== repositoryId) throw failure("repository-not-authorized");
  return repository;
}

export interface GithubAppAuthority {
  inspectApp(): Promise<GithubAppInspection>;
  verifyInstallation(input: GithubInstallationVerifyData): Promise<GithubInstallationInspection>;
  refreshInstallation(input: GithubInstallationRefreshData): Promise<GithubInstallationInspection>;
  inspectInstallation(connectionId: string): Promise<GithubInstallationInspection>;
  listRepositories(input: GithubRepositoriesListData): Promise<GithubRepositoryPage>;
  resolveRepository(input: GithubRepositoryResolveData): Promise<GithubRepositoryResolution>;
  withExactRepositoryToken<T>(input: GithubRepositoryResolveData, operation: (token: string, repository: GithubRepository) => Promise<T>, operationId?: string): Promise<{ readonly value: T; readonly cleanupDegraded: boolean }>;
  /** Agent-private test seam; never part of the server contract. */
  persistBindingForTest(binding: GithubInstallationInspection): Promise<void>;
}

export async function createGithubAppAuthority(options: {
  stateRoot: string; transport?: GithubHttpTransport; now?: () => Date; createId?: () => string;
  writer?: AtomicJsonWriter;
  removeLease?: (filePath: string) => Promise<void>;
  privateReadAfterRead?: (filePath: string) => Promise<void> | void;
}): Promise<GithubAppAuthority> {
  const appRoot = path.join(path.resolve(options.stateRoot), "github-app");
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const transport = options.transport ?? defaultTransport;
  const writer = options.writer ?? durableJsonWriter;
  const removeLease = options.removeLease ?? unlink;
  const bindingsRoot = path.join(appRoot, "installations");
  const leasesRoot = path.join(appRoot, "token-leases");
  const locks = new Map<string, Promise<void>>();
  const leaseBlocks = new Map<string, number>();
  const degradedBindings = new Set<string>();
  const recoveredUncertainConnections = new Set<string>();
  const ownedLeaseConnections = new Set<string>();
  const configured = await lstat(appRoot).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw failure("private-state-invalid");
  });
  let config: z.infer<typeof configSchema> | null = null;
  let privateKey: Buffer | null = null;
  if (configured) try {
    await assertPrivateDirectory(appRoot);
    const configPath = path.join(appRoot, "config.json");
    const configBytes = await readPrivateFile(configPath, MAX_CONFIG_BYTES, () => options.privateReadAfterRead?.(configPath));
    config = parseStrictJsonBytes(configBytes, configPath, configSchema);
    const keyPath = path.join(appRoot, "private-key.pem");
    privateKey = await readPrivateFile(keyPath, MAX_KEY_BYTES, () => options.privateReadAfterRead?.(keyPath));
    const parsedKey = createPrivateKey(privateKey);
    if (parsedKey.type !== "private" || (parsedKey.asymmetricKeyType !== "rsa" && parsedKey.asymmetricKeyType !== "rsa-pss")) {
      throw failure("private-state-invalid");
    }
    for (const directory of [bindingsRoot, leasesRoot]) {
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      await assertPrivateDirectory(directory);
    }
    const bindingIds = new Set<string>();
    for (const name of await readdir(bindingsRoot)) {
      const filenameId = filenameConnectionId(name);
      if (bindingIds.has(filenameId)) throw failure("private-state-invalid");
      bindingIds.add(filenameId);
      const file = path.join(bindingsRoot, name);
      const bytes = await readPrivateFile(file, MAX_CONFIG_BYTES, () => options.privateReadAfterRead?.(file));
      const binding = parseStrictJsonBytes(bytes, file, bindingSchema);
      if (binding.connectionId !== filenameId) throw failure("private-state-invalid");
    }
    const leaseIds = new Set<string>();
    for (const name of await readdir(leasesRoot)) {
      const filenameId = filenameConnectionId(name);
      if (leaseIds.has(filenameId)) throw failure("private-state-invalid");
      const file = path.join(leasesRoot, name);
      const bytes = await readPrivateFile(file, MAX_CONFIG_BYTES, () => options.privateReadAfterRead?.(file));
      const lease = parseStrictJsonBytes(bytes, file, leaseSchema);
      if (lease.connectionId !== filenameId) throw failure("private-state-invalid");
      leaseIds.add(filenameId);
      recoveredUncertainConnections.add(filenameId);
      const expiresAt = new Date(lease.expiresAt).valueOf();
      if (!Number.isFinite(expiresAt)) throw failure("private-state-invalid");
      if (expiresAt > now().valueOf()) leaseBlocks.set(filenameId, expiresAt);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("github-")) throw error;
    else throw failure("private-state-invalid");
  }
  const requireConfig = () => {
    if (!configured || config === null || privateKey === null) throw failure("app-unconfigured");
    return { config, privateKey };
  };
  const bindingFile = (connectionId: string) => path.join(bindingsRoot, `${githubConnectionIdSchema.parse(connectionId)}.json`);
  const leaseFile = (connectionId: string) => path.join(leasesRoot, `${githubConnectionIdSchema.parse(connectionId)}.json`);
  const persist = async (binding: GithubInstallationInspection) => writer.write(bindingFile(binding.connectionId), { version: 1, ...binding });
  const readBinding = async (expectedConnectionId: string) => {
    requireConfig();
    const connection = githubConnectionIdSchema.safeParse(expectedConnectionId);
    if (!connection.success) throw failure("private-state-invalid");
    const file = bindingFile(connection.data);
    const entry = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw failure("private-state-invalid");
    });
    if (entry === null) throw failure("connection-not-found");
    const bytes = await readPrivateFile(file, MAX_CONFIG_BYTES, () => options.privateReadAfterRead?.(file));
    const value = parseStrictJsonBytes(bytes, file, bindingSchema);
    if (value.connectionId !== connection.data) throw failure("private-state-invalid");
    const { version: _version, ...inspection } = value;
    return githubInstallationInspectionSchema.parse(inspection);
  };
  const readLease = async (expectedConnectionId: string) => {
    const connection = githubConnectionIdSchema.safeParse(expectedConnectionId);
    if (!connection.success) throw failure("private-state-invalid");
    const file = leaseFile(connection.data);
    const bytes = await readPrivateFile(file, MAX_CONFIG_BYTES, () => options.privateReadAfterRead?.(file));
    const lease = parseStrictJsonBytes(bytes, file, leaseSchema);
    if (lease.connectionId !== connection.data) throw failure("private-state-invalid");
    return lease;
  };
  const readLeaseIfPresent = async (expectedConnectionId: string) => {
    const file = leaseFile(expectedConnectionId);
    const entry = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw failure("private-state-invalid");
    });
    return entry === null ? null : await readLease(expectedConnectionId);
  };
  const inspectEffective = async (connectionId: string) => {
    const binding = await readBinding(connectionId);
    const lease = await readLeaseIfPresent(connectionId);
    const leaseUncertain = !ownedLeaseConnections.has(connectionId) && lease !== null;
    if (!degradedBindings.has(connectionId) && !recoveredUncertainConnections.has(connectionId) && !leaseUncertain) return binding;
    return { ...binding, status: "degraded" as const, cleanupDegraded: true };
  };
  const writeLease = async (file: string, value: { connectionId: string; operationId: string; expiresAt: string; phase: "minting" | "active" | "cleanup-degraded"; createdAt: string }) => {
    await writer.write(file, { version: 1, ...value });
  };
  const locked = async <T>(connectionId: string, action: () => Promise<T>): Promise<T> => {
    const previous = locks.get(connectionId) ?? Promise.resolve(); let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; }); locks.set(connectionId, current); await previous;
    ownedLeaseConnections.add(connectionId);
    try { return await action(); } finally {
      ownedLeaseConnections.delete(connectionId);
      release();
      if (locks.get(connectionId) === current) locks.delete(connectionId);
    }
  };
  const liveBinding = async (connectionId: string, installationId: string, preserveExisting: boolean): Promise<GithubInstallationInspection> => {
    const current = requireConfig();
    const existing = await readBinding(connectionId).catch((error: unknown) => {
      if (error instanceof Error && error.message === "github-connection-not-found") return null;
      throw error instanceof Error ? error : failure("private-state-invalid");
    });
    const appToken = jwt(current.privateKey, current.config.appId, now());
    const appResponse = await transport({ method: "GET", path: "/app", authorization: `Bearer ${appToken}` });
    const app = record(appResponse.body);
    if (appResponse.status !== 200 || decimal(app?.id) !== current.config.appId) throw failure("authority-invalid");
    const response = await transport({ method: "GET", path: `/app/installations/${installationId}`, authorization: `Bearer ${appToken}` });
    const installation = record(response.body); const account = record(installation?.account);
    if (response.status !== 200) throw failure("installation-unavailable");
    if (decimal(installation?.id) !== installationId || decimal(installation?.app_id) !== current.config.appId
      || decimal(account?.id) !== current.config.expectedAccountId || account?.type !== current.config.expectedAccountType
      || typeof account?.login !== "string" || account.login.length < 1 || account.login.length > 255
      || (installation?.repository_selection !== "all" && installation?.repository_selection !== "selected")) throw failure("authority-invalid");
    if (installation?.suspended_at !== null) throw failure("installation-unavailable");
    const permissionsRaw = record(installation.permissions); const permissions: Record<string, "read" | "write"> = {};
    if (permissionsRaw === null || Object.entries(permissionsRaw).length > 64) throw failure("authority-invalid");
    for (const [name, level] of Object.entries(permissionsRaw)) {
      if (!/^[a-z_]{1,64}$/u.test(name) || (level !== "read" && level !== "write")) throw failure("authority-invalid");
      permissions[name] = level;
    }
    if (permissions.metadata !== "read" && permissions.metadata !== "write") throw failure("authority-invalid");
    if (existing !== null && existing.installationId !== installationId && preserveExisting) throw failure("installation-conflict");
    const cleanupDegraded = existing?.cleanupDegraded === true || degradedBindings.has(connectionId) || recoveredUncertainConnections.has(connectionId);
    const binding = githubInstallationInspectionSchema.parse({ connectionId, installationId,
      accountId: current.config.expectedAccountId, accountType: current.config.expectedAccountType, accountLogin: account.login,
      repositorySelection: installation.repository_selection, permissions, status: cleanupDegraded ? "degraded" : "connected",
      verifiedAt: now().toISOString(), cleanupDegraded });
    await persist(binding);
    return await inspectEffective(connectionId);
  };
  const runTokenTransaction = async <T>(input: {
    readonly connectionId: string;
    readonly operationId?: string;
    readonly body: unknown;
    readonly validateMint?: (body: unknown) => void;
    readonly classifyMintFailure?: (status: number, body: unknown) => Error | null;
    readonly operation: (token: string) => Promise<T>;
  }): Promise<{ readonly value: T; readonly cleanupDegraded: boolean }> => await locked(input.connectionId, async () => {
    const binding = await readBinding(input.connectionId);
    const current = requireConfig();
    const leasePath = leaseFile(input.connectionId);
    const currentTime = now().valueOf();
    const inProcessExpiry = leaseBlocks.get(input.connectionId);
    if (inProcessExpiry !== undefined) {
      if (inProcessExpiry > currentTime) throw failure("token-lease-active");
      leaseBlocks.delete(input.connectionId);
    }
    const leaseEntry = await lstat(leasePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw failure("private-state-invalid");
    });
    if (leaseEntry !== null) {
      const existingLease = await readLease(input.connectionId);
      const existingExpiry = new Date(existingLease.expiresAt).valueOf();
      if (existingExpiry > currentTime) {
        leaseBlocks.set(input.connectionId, existingExpiry);
        throw failure("token-lease-active");
      }
      try { await removeLease(leasePath); } catch {
        leaseBlocks.set(input.connectionId, existingExpiry);
        throw failure("token-lease-active");
      }
    }
    const createdAt = now().toISOString(); const operationId = input.operationId ?? createId();
    const conservativeExpiryMs = currentTime + CONSERVATIVE_UNKNOWN_MINT_LEASE_MS;
    let guardExpiryMs = conservativeExpiryMs;
    const guardExpiresAt = () => new Date(guardExpiryMs).toISOString();
    try { await writeLease(leasePath, { connectionId: input.connectionId, operationId, expiresAt: guardExpiresAt(), phase: "minting", createdAt }); }
    catch { leaseBlocks.set(input.connectionId, conservativeExpiryMs); throw failure("private-state-invalid"); }
    leaseBlocks.set(input.connectionId, conservativeExpiryMs);

    let token: string | null = null; let mintState: "token" | "definitive-rejection" | "uncertain" = "uncertain";
    let value: T | undefined; let primaryError: Error | null = null;
    try {
      const appToken = jwt(current.privateKey, current.config.appId, now());
      let minted: GithubHttpResponse;
      try { minted = await transport({ method: "POST", path: `/app/installations/${binding.installationId}/access_tokens`, authorization: `Bearer ${appToken}`, body: input.body }); }
      catch { primaryError = failure("token-mint-failed"); throw primaryError; }
      const mintedBody = record(minted.body);
      const candidateToken = typeof mintedBody?.token === "string" && mintedBody.token.length > 0 && mintedBody.token.length <= 16 * 1024 ? mintedBody.token : null;
      if (minted.status === 201) {
        const mintedExpiry = typeof mintedBody?.expires_at === "string" && githubTokenExpirySchema.safeParse(mintedBody.expires_at).success ? Date.parse(mintedBody.expires_at) : Number.NaN;
        if (candidateToken === null || !Number.isFinite(mintedExpiry) || mintedExpiry <= currentTime
          || mintedExpiry > currentTime + MAX_INSTALLATION_TOKEN_LIFETIME_MS + 5 * 60 * 1000) primaryError = failure("token-mint-failed");
        else {
          token = candidateToken; mintState = "token"; guardExpiryMs = mintedExpiry;
          try { await writeLease(leasePath, { connectionId: input.connectionId, operationId, expiresAt: guardExpiresAt(), phase: "active", createdAt }); leaseBlocks.set(input.connectionId, mintedExpiry); }
          catch { primaryError = failure("token-mint-failed"); token = candidateToken; mintState = "uncertain"; guardExpiryMs = conservativeExpiryMs; leaseBlocks.set(input.connectionId, conservativeExpiryMs); }
        }
      } else if ([400, 401, 403, 404, 422].includes(minted.status) && record(minted.body) !== null
        && typeof record(minted.body)?.message === "string" && (record(minted.body)?.message as string).length <= 512) {
        mintState = "definitive-rejection";
        primaryError = input.classifyMintFailure?.(minted.status, minted.body) ?? failure("token-mint-failed");
      } else {
        if (candidateToken !== null) token = candidateToken;
        primaryError = failure("token-mint-failed"); mintState = "uncertain";
      }
      if (mintState === "token" && token !== null && primaryError === null) {
        try { input.validateMint?.(mintedBody); value = await input.operation(token); }
        catch (error) { primaryError = safePrimaryFailure(error); }
      }
    } catch (error) { if (primaryError === null) primaryError = safePrimaryFailure(error); }

    let revocation: "succeeded" | "failed" | "not-needed" | "uncertain" = "uncertain";
    if (token !== null) {
      try { revocation = (await transport({ method: "DELETE", path: "/installation/token", authorization: `Bearer ${token}` })).status === 204 ? "succeeded" : "failed"; }
      catch { revocation = "uncertain"; }
    } else if (mintState === "definitive-rejection") revocation = "not-needed";
    token = null; // eslint-disable-line no-useless-assignment -- explicitly drop credential authority before returning
    let leaseSettled = false;
    if (revocation === "succeeded" || revocation === "not-needed") {
      try { await removeLease(leasePath); leaseSettled = true; leaseBlocks.delete(input.connectionId); }
      catch { leaseBlocks.set(input.connectionId, guardExpiryMs); }
    } else {
      try { await writeLease(leasePath, { connectionId: input.connectionId, operationId, expiresAt: guardExpiresAt(), phase: "cleanup-degraded", createdAt }); } catch { /* conservative lease remains */ }
      leaseBlocks.set(input.connectionId, guardExpiryMs);
    }
    let cleanupDegraded = !leaseSettled;
    if (!leaseSettled) {
      recoveredUncertainConnections.add(input.connectionId);
      try { await persist({ ...binding, status: "degraded", cleanupDegraded: true }); } catch { degradedBindings.add(input.connectionId); }
      cleanupDegraded = true;
    } else if (value === undefined && (binding.status === "degraded" || binding.cleanupDegraded || degradedBindings.has(input.connectionId) || recoveredUncertainConnections.has(input.connectionId))) {
      try { await persist({ ...binding, status: "degraded", cleanupDegraded: true }); }
      catch {
        degradedBindings.add(input.connectionId);
        recoveredUncertainConnections.add(input.connectionId);
        guardExpiryMs = Math.max(guardExpiryMs, now().valueOf() + CONSERVATIVE_UNKNOWN_MINT_LEASE_MS);
        leaseBlocks.set(input.connectionId, guardExpiryMs);
        try { await writeLease(leasePath, { connectionId: input.connectionId, operationId, expiresAt: guardExpiresAt(), phase: "cleanup-degraded", createdAt }); } catch { /* in-memory barrier remains fail-closed */ }
      }
      cleanupDegraded = true;
    } else if (value !== undefined && (binding.status === "degraded" || binding.cleanupDegraded || degradedBindings.has(input.connectionId) || recoveredUncertainConnections.has(input.connectionId))) {
      try { await persist({ ...binding, status: "connected", cleanupDegraded: false }); degradedBindings.delete(input.connectionId); recoveredUncertainConnections.delete(input.connectionId); }
      catch {
        degradedBindings.add(input.connectionId); recoveredUncertainConnections.add(input.connectionId); cleanupDegraded = true;
        guardExpiryMs = Math.max(guardExpiryMs, now().valueOf() + CONSERVATIVE_UNKNOWN_MINT_LEASE_MS);
        leaseBlocks.set(input.connectionId, guardExpiryMs);
        try { await writeLease(leasePath, { connectionId: input.connectionId, operationId, expiresAt: guardExpiresAt(), phase: "cleanup-degraded", createdAt }); } catch { /* in-memory barrier remains fail-closed */ }
      }
    }
    if (primaryError !== null) throw primaryError;
    if (value === undefined) throw failure("operation-failed");
    return { value, cleanupDegraded };
  });
  return {
    inspectApp: async () => await Promise.resolve(githubAppInspectionSchema.parse(configured && config !== null
      ? { configured: true, appId: config.appId, expectedAccountId: config.expectedAccountId, expectedAccountType: config.expectedAccountType, installationUrl: config.installationUrl }
      : { configured: false, appId: null, expectedAccountId: null, expectedAccountType: null, installationUrl: null })),
    verifyInstallation: async (raw) => {
      const input = githubInstallationVerifyDataSchema.parse(raw);
      const existing = await readBinding(input.connectionId).catch((error: unknown) => {
        if (error instanceof Error && error.message === "github-connection-not-found") return null;
        throw error instanceof Error ? error : failure("private-state-invalid");
      });
      if (existing !== null) {
        if (existing.installationId !== input.installationId) throw failure("installation-conflict");
        return await liveBinding(input.connectionId, input.installationId, true);
      }
      return await liveBinding(input.connectionId, input.installationId, false);
    },
    refreshInstallation: async (raw) => {
      const input = githubInstallationRefreshDataSchema.parse(raw);
      const existing = await readBinding(input.connectionId);
      return await liveBinding(input.connectionId, existing.installationId, true);
    },
    inspectInstallation: inspectEffective,
    persistBindingForTest: persist,
    resolveRepository: async (raw) => {
      const input = githubRepositoryResolveDataSchema.parse(raw);
      await liveBinding(input.connectionId, (await readBinding(input.connectionId)).installationId, true);
      const result = await runTokenTransaction({
        connectionId: input.connectionId,
        body: { permissions: { metadata: "read" } },
        operation: async (token) => {
          for (let page = 1; page <= 1_000; page += 1) {
            const response = await transport({ method: "GET", path: `/installation/repositories?per_page=100&page=${page}`, authorization: `Bearer ${token}` });
            const responseBody = record(response.body);
            if (response.status !== 200 || !Array.isArray(responseBody?.repositories) || responseBody.repositories.length > 100) throw failure("upstream-invalid");
            const repository = responseBody.repositories.map((candidate) => safeRepository(candidate)).find((candidate) => candidate.repositoryId === input.repositoryId);
            if (repository !== undefined) return repository;
            if (responseBody.repositories.length < 100) break;
          }
          throw failure("repository-not-authorized");
        }
      });
      return githubRepositoryResolutionSchema.parse({ repository: result.value, cleanupDegraded: result.cleanupDegraded });
    },
    withExactRepositoryToken: async <T>(raw: GithubRepositoryResolveData,
      operation: (token: string, repository: GithubRepository) => Promise<T>, operationId?: string) => {
      const input = githubRepositoryResolveDataSchema.parse(raw);
      const binding = await liveBinding(input.connectionId, (await readBinding(input.connectionId)).installationId, true);
      if (binding.permissions.contents !== "read" && binding.permissions.contents !== "write") throw failure("contents-permission-required");
      let scopedRepository: GithubRepository | undefined;
      const result = await runTokenTransaction<T>({
        connectionId: input.connectionId,
        ...(operationId === undefined ? {} : { operationId }),
        body: { kind: "exact-repository-token", repositoryId: input.repositoryId },
        classifyMintFailure: (status) => status === 404 ? failure("installation-unavailable")
          : status === 403 || status === 422 ? failure("repository-not-authorized") : null,
        validateMint: (body) => { scopedRepository = exactScopedRepository(body, input.repositoryId); },
        operation: async (token) => scopedRepository === undefined ? Promise.reject(failure("repository-not-authorized")) : await operation(token, scopedRepository)
      });
      return result;
    },
    listRepositories: async (raw) => {
      const input = githubRepositoriesListDataSchema.parse(raw);
      // Listing is the retained, safe metadata snapshot.  The browser's explicit
      // Refresh GitHub access action and every authenticated Git operation perform
      // the live App/installation proof; a stale snapshot must never authorize Git.
      const result = await runTokenTransaction({
        connectionId: input.connectionId,
        body: { permissions: { metadata: "read" } },
        operation: async (token) => {
          let page = 1;
          if (input.continuation !== undefined) {
            try { page = Number(Buffer.from(input.continuation, "base64url").toString("ascii")); } catch { throw failure("continuation-invalid"); }
          }
          if (!Number.isInteger(page) || page < 1 || page > 1_000_000) throw failure("continuation-invalid");
          const listed = await transport({ method: "GET", path: `/installation/repositories?per_page=${input.pageSize}&page=${page}`, authorization: `Bearer ${token}` });
          const listedBody = record(listed.body);
          if (listed.status !== 200 || !Array.isArray(listedBody?.repositories) || listedBody.repositories.length > input.pageSize) throw failure("upstream-invalid");
          const repositories = listedBody.repositories.map((rawRepository) => safeRepository(rawRepository));
          return githubRepositoryPageSchema.parse({ repositories,
            continuation: repositories.length === input.pageSize ? Buffer.from(String(page + 1), "ascii").toString("base64url") : null,
            cleanupDegraded: false });
        }
      });
      return { ...result.value, cleanupDegraded: result.cleanupDegraded };
    },
  };
}
