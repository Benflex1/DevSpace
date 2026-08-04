import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { createPrivateKey, createSign, randomUUID } from "node:crypto";
import path from "node:path";
import * as z from "zod";
import {
  githubAppInspectionSchema,
  githubDecimalIdSchema,
  githubInstallationInspectionSchema,
  githubInstallationVerifyDataSchema,
  githubRepositoriesListDataSchema,
  githubRepositoryPageSchema,
  type GithubAppInspection,
  type GithubInstallationInspection,
  type GithubInstallationVerifyData,
  type GithubRepositoriesListData,
  type GithubRepositoryPage
} from "@devspace/contracts";
import { durableJsonWriter, readStrictJson } from "./private-state.js";

const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_KEY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const GITHUB_API_VERSION = "2022-11-28";
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
  version: z.literal(1), connectionId: z.string().uuid(), operationId: z.string().uuid(),
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
function decimal(value: unknown): string | null {
  if (typeof value === "bigint") return value >= 0n ? value.toString(10) : null;
  if (typeof value === "string") return githubDecimalIdSchema.safeParse(value).success ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const stats = await lstat(directory, { bigint: true }).catch(() => null);
  const uid = process.getuid?.();
  if (stats === null || !stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o777n) !== 0o700n
    || (uid !== undefined && stats.uid !== BigInt(uid))) throw failure("private-state-invalid");
}

async function readPrivateFile(file: string, maxBytes: number): Promise<Buffer> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw failure("private-state-invalid"); }
  try {
    const uid = process.getuid?.();
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || (before.mode & 0o7777n) !== 0o600n
      || before.size < 1n || before.size > BigInt(maxBytes) || (uid !== undefined && before.uid !== BigInt(uid))) throw failure("private-state-invalid");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.length !== Number(before.size)) throw failure("private-state-invalid");
    return bytes;
  } finally { await handle.close().catch(() => undefined); }
}

function parseLosslessGithubJson(text: string): unknown {
  return JSON.parse(text.replace(/("(?:id|app_id)"\s*:\s*)([0-9]{1,32})(?=\s*[,}])/gu, "$1\"$2\""));
}
const defaultTransport: GithubHttpTransport = async (request) => {
  const response = await fetch(`https://api.github.com${request.path}`, {
    method: request.method,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/vnd.github+json", Authorization: request.authorization, "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...(request.body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw failure("upstream-invalid");
  let body: unknown = {};
  if (text !== "") try { body = parseLosslessGithubJson(text); } catch { throw failure("upstream-invalid"); }
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

export interface GithubAppAuthority {
  inspectApp(): Promise<GithubAppInspection>;
  verifyInstallation(input: GithubInstallationVerifyData): Promise<GithubInstallationInspection>;
  inspectInstallation(connectionId: string): Promise<GithubInstallationInspection>;
  listRepositories(input: GithubRepositoriesListData): Promise<GithubRepositoryPage>;
  /** Agent-private test seam; never part of the server contract. */
  persistBindingForTest(binding: GithubInstallationInspection): Promise<void>;
}

export async function createGithubAppAuthority(options: {
  stateRoot: string; transport?: GithubHttpTransport; now?: () => Date; createId?: () => string;
}): Promise<GithubAppAuthority> {
  const appRoot = path.join(path.resolve(options.stateRoot), "github-app");
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const transport = options.transport ?? defaultTransport;
  const bindingsRoot = path.join(appRoot, "installations");
  const leasesRoot = path.join(appRoot, "token-leases");
  const locks = new Map<string, Promise<void>>();
  const configured = await lstat(appRoot).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw failure("private-state-invalid");
  });
  let config: z.infer<typeof configSchema> | null = null;
  let privateKey: Buffer | null = null;
  if (configured) try {
    await assertPrivateDirectory(appRoot);
    const configBytes = await readPrivateFile(path.join(appRoot, "config.json"), MAX_CONFIG_BYTES);
    config = configSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(configBytes)));
    privateKey = await readPrivateFile(path.join(appRoot, "private-key.pem"), MAX_KEY_BYTES);
    const parsedKey = createPrivateKey(privateKey);
    if (parsedKey.type !== "private" || (parsedKey.asymmetricKeyType !== "rsa" && parsedKey.asymmetricKeyType !== "rsa-pss")) {
      throw failure("private-state-invalid");
    }
    for (const directory of [bindingsRoot, leasesRoot]) {
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      await assertPrivateDirectory(directory);
    }
    for (const name of await readdir(bindingsRoot)) {
      if (!/^[0-9a-f-]{36}\.json$/u.test(name)) throw failure("private-state-invalid");
      await readPrivateFile(path.join(bindingsRoot, name), MAX_CONFIG_BYTES);
      await readStrictJson(path.join(bindingsRoot, name), bindingSchema);
    }
    for (const name of await readdir(leasesRoot)) {
      if (!/^[0-9a-f-]{36}\.json$/u.test(name)) throw failure("private-state-invalid");
      await readPrivateFile(path.join(leasesRoot, name), MAX_CONFIG_BYTES);
      await readStrictJson(path.join(leasesRoot, name), leaseSchema);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("github-")) throw error;
    else throw failure("private-state-invalid");
  }
  const requireConfig = () => {
    if (!configured || config === null || privateKey === null) throw failure("app-unconfigured");
    return { config, privateKey };
  };
  const bindingFile = (connectionId: string) => path.join(bindingsRoot, `${githubInstallationVerifyDataSchema.shape.connectionId.parse(connectionId)}.json`);
  const leaseFile = (connectionId: string) => path.join(leasesRoot, `${githubInstallationVerifyDataSchema.shape.connectionId.parse(connectionId)}.json`);
  const persist = async (binding: GithubInstallationInspection) => durableJsonWriter.write(bindingFile(binding.connectionId), { version: 1, ...binding });
  const inspect = async (connectionId: string) => {
    requireConfig();
    const file = bindingFile(connectionId);
    const entry = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw failure("private-state-invalid");
    });
    if (entry === null) throw failure("connection-not-found");
    await readPrivateFile(file, MAX_CONFIG_BYTES);
    const value = await readStrictJson(file, bindingSchema).catch(() => { throw failure("private-state-invalid"); });
    const { version: _version, ...inspection } = value;
    return githubInstallationInspectionSchema.parse(inspection);
  };
  const locked = async <T>(connectionId: string, action: () => Promise<T>): Promise<T> => {
    const previous = locks.get(connectionId) ?? Promise.resolve(); let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; }); locks.set(connectionId, current); await previous;
    try { return await action(); } finally { release(); if (locks.get(connectionId) === current) locks.delete(connectionId); }
  };
  return {
    inspectApp: async () => await Promise.resolve(githubAppInspectionSchema.parse(configured && config !== null
      ? { configured: true, appId: config.appId, expectedAccountId: config.expectedAccountId, expectedAccountType: config.expectedAccountType, installationUrl: config.installationUrl }
      : { configured: false, appId: null, expectedAccountId: null, expectedAccountType: null, installationUrl: null })),
    verifyInstallation: async (raw) => {
      const input = githubInstallationVerifyDataSchema.parse(raw); const current = requireConfig();
      const existing = await inspect(input.connectionId).catch((error: unknown) => {
        if (error instanceof Error && error.message === "github-connection-not-found") return null;
        throw error instanceof Error ? error : failure("private-state-invalid");
      });
      if (existing !== null) {
        if (existing.installationId !== input.installationId) throw failure("installation-conflict");
        return existing;
      }
      const appToken = jwt(current.privateKey, current.config.appId, now());
      const appResponse = await transport({ method: "GET", path: "/app", authorization: `Bearer ${appToken}` });
      const app = record(appResponse.body);
      if (appResponse.status !== 200 || decimal(app?.id) !== current.config.appId) throw failure("authority-invalid");
      const response = await transport({ method: "GET", path: `/app/installations/${input.installationId}`, authorization: `Bearer ${appToken}` });
      const installation = record(response.body); const account = record(installation?.account);
      if (response.status !== 200 || decimal(installation?.id) !== input.installationId || decimal(installation?.app_id) !== current.config.appId
        || decimal(account?.id) !== current.config.expectedAccountId || account?.type !== current.config.expectedAccountType
        || typeof account?.login !== "string" || account.login.length < 1 || account.login.length > 255 || installation?.suspended_at !== null
        || (installation?.repository_selection !== "all" && installation?.repository_selection !== "selected")) throw failure("authority-invalid");
      const permissionsRaw = record(installation.permissions); const permissions: Record<string, "read" | "write"> = {};
      if (permissionsRaw === null || Object.entries(permissionsRaw).length > 64) throw failure("authority-invalid");
      for (const [name, level] of Object.entries(permissionsRaw)) {
        if (!/^[a-z_]{1,64}$/u.test(name) || (level !== "read" && level !== "write")) throw failure("authority-invalid");
        permissions[name] = level;
      }
      const binding = githubInstallationInspectionSchema.parse({ connectionId: input.connectionId, installationId: input.installationId,
        accountId: current.config.expectedAccountId, accountType: current.config.expectedAccountType, accountLogin: account.login,
        repositorySelection: installation.repository_selection, permissions, status: "connected", verifiedAt: now().toISOString(), cleanupDegraded: false });
      await persist(binding); return binding;
    },
    inspectInstallation: inspect,
    persistBindingForTest: persist,
    listRepositories: async (raw) => {
      const input = githubRepositoriesListDataSchema.parse(raw);
      return await locked(input.connectionId, async () => {
        const binding = await inspect(input.connectionId); const current = requireConfig();
        const leasePath = leaseFile(input.connectionId);
        const leaseEntry = await lstat(leasePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw failure("private-state-invalid");
        });
        const existingLease = leaseEntry === null ? null : await (async () => {
          await readPrivateFile(leasePath, MAX_CONFIG_BYTES);
          return await readStrictJson(leasePath, leaseSchema).catch(() => { throw failure("private-state-invalid"); });
        })();
        if (existingLease !== null) {
          if (new Date(existingLease.expiresAt).valueOf() > now().valueOf()) throw failure("token-lease-active");
          await unlink(leasePath);
        }
        const createdAt = now().toISOString(); const operationId = createId();
        await durableJsonWriter.write(leasePath, { version: 1, connectionId: input.connectionId, operationId,
          expiresAt: new Date(now().valueOf() + 60 * 60 * 1000).toISOString(), phase: "minting", createdAt });
        let token: string | null = null; let expiresAt = new Date(now().valueOf() + 60 * 60 * 1000).toISOString();
        let primaryPage: GithubRepositoryPage | null = null; let primaryError: Error | null = null;
        try {
          const appToken = jwt(current.privateKey, current.config.appId, now());
          const minted = await transport({ method: "POST", path: `/app/installations/${binding.installationId}/access_tokens`, authorization: `Bearer ${appToken}`, body: { permissions: { metadata: "read" } } });
          const mintedBody = record(minted.body);
          const mintedExpiry = typeof mintedBody?.expires_at === "string" ? Date.parse(mintedBody.expires_at) : Number.NaN;
          if (minted.status !== 201 || typeof mintedBody?.token !== "string" || mintedBody.token.length < 1
            || !Number.isFinite(mintedExpiry) || mintedExpiry <= now().valueOf() || mintedExpiry > now().valueOf() + 65 * 60 * 1000) {
            throw failure("token-mint-failed");
          }
          token = mintedBody.token; expiresAt = new Date(mintedExpiry).toISOString();
          await durableJsonWriter.write(leasePath, { version: 1, connectionId: input.connectionId, operationId, expiresAt, phase: "active", createdAt });
          const page = input.continuation === undefined ? 1 : Number(Buffer.from(input.continuation, "base64url").toString("ascii"));
          if (!Number.isInteger(page) || page < 1 || page > 1_000_000) throw failure("continuation-invalid");
          const listed = await transport({ method: "GET", path: `/installation/repositories?per_page=${input.pageSize}&page=${page}`, authorization: `Bearer ${token}` });
          const listedBody = record(listed.body);
          if (listed.status !== 200 || !Array.isArray(listedBody?.repositories) || listedBody.repositories.length > input.pageSize) throw failure("upstream-invalid");
          const repositories = listedBody.repositories.map((rawRepository) => {
            const repository = record(rawRepository); const owner = record(repository?.owner); const repositoryId = decimal(repository?.id);
            if (repositoryId === null || typeof owner?.login !== "string" || typeof repository?.name !== "string" || typeof repository.full_name !== "string"
              || typeof repository.default_branch !== "string" || typeof repository.private !== "boolean" || typeof repository.archived !== "boolean" || typeof repository.disabled !== "boolean") throw failure("upstream-invalid");
            return { repositoryId, ownerLogin: owner.login, name: repository.name, fullName: repository.full_name,
              cleanHttpsUrl: `https://github.com/${owner.login}/${repository.name}.git`, defaultBranch: repository.default_branch,
              private: repository.private, archived: repository.archived, disabled: repository.disabled };
          });
          primaryPage = githubRepositoryPageSchema.parse({ repositories,
            continuation: repositories.length === input.pageSize ? Buffer.from(String(page + 1), "ascii").toString("base64url") : null, cleanupDegraded: false });
        } catch (error) { primaryError = error instanceof Error ? error : failure("operation-failed"); }
        let revoked = token === null;
        if (token !== null) {
          try { revoked = (await transport({ method: "DELETE", path: "/installation/token", authorization: `Bearer ${token}` })).status === 204; }
          catch { revoked = false; }
        }
        token = null; // eslint-disable-line no-useless-assignment -- explicitly drop credential authority before returning
        if (revoked) await unlink(leasePath).catch(() => undefined);
        else {
          await durableJsonWriter.write(leasePath, { version: 1, connectionId: input.connectionId, operationId, expiresAt, phase: "cleanup-degraded", createdAt });
          await persist({ ...binding, status: "degraded", cleanupDegraded: true });
        }
        if (primaryError !== null) throw primaryError;
        if (primaryPage === null) throw failure("operation-failed");
        return revoked ? primaryPage : { ...primaryPage, cleanupDegraded: true };
      });
    }
  };
}
