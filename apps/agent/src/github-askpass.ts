import { chmod, lstat, mkdir, readFile, rmdir, unlink } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import net, { type Socket, type Server } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { githubConnectionIdSchema, githubDecimalIdSchema, uuidV7Schema } from "@devspace/contracts";
import * as z from "zod";

const FRAME_MAX_BYTES = 128 * 1024;
const PROMPT_MAX_BYTES = 8 * 1024;
const TOKEN_MAX_BYTES = 16 * 1024;
const SOCKET_PATH_MAX_BYTES = 100;
const FRAME_HEADER_BYTES = 4;
const REQUEST_MAGIC = Buffer.from("DSASKP01", "ascii");
const RESPONSE_MAGIC = Buffer.from("DSASKR01", "ascii");
const PROTOCOL_VERSION = 1;
const runtimeDirectorySchema = z.string().min(1).max(4_096).refine((value) => path.isAbsolute(value));
const capabilitySchema = z.string().length(64).regex(/^[0-9a-f]{64}$/u);

type SocketIdentity = { readonly dev: bigint; readonly ino: bigint; readonly uid: number };
type ProcessGroupIdentity = { readonly processGroupId: number; readonly startTimeTicks: string };

export interface AskpassBrokerRegistrationInput {
  readonly connectionId: string;
  readonly repositoryId: string;
  readonly operationId: string;
  readonly executionId: string;
  readonly originUrl: string;
  readonly token: string;
  readonly deadlineAt: Date;
}

export interface AskpassCapability {
  readonly capability: string;
  readonly socketPath: string;
  readonly helperPath: string;
  readonly executionId: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface GithubAskpassBroker {
  readonly socketPath: string | null;
  readonly runtimeDirectory: string | null;
  readonly helperPath: string;
  ensureStarted(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  register(input: AskpassBrokerRegistrationInput): AskpassCapability;
  settle(capability: string): void;
}

export interface GithubAskpassBrokerOptions {
  /** Test seam; production selection is XDG_RUNTIME_DIR, /run/user/<uid>, then /tmp. */
  readonly runtimeBases?: readonly string[];
  /** Test seam for candidate-local filesystem availability faults. */
  readonly mkdir?: (directory: string, options: { readonly mode: number }) => Promise<unknown>;
  readonly helperPath?: string;
  readonly randomBytes?: (size: number) => Buffer;
  readonly now?: () => number;
}

interface Registration extends AskpassBrokerRegistrationInput {
  readonly capability: string;
  promptState: "awaiting-username" | "awaiting-password" | "complete";
  processGroup: ProcessGroupIdentity | null;
}

const RUNTIME_AVAILABILITY_ERRNOS = new Set(["EACCES", "ENODEV", "ENETDOWN", "ENOENT", "ENOTDIR", "EPERM", "EROFS"]);

function isRuntimeAvailabilityError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && typeof (error as { readonly code?: unknown }).code === "string"
    && RUNTIME_AVAILABILITY_ERRNOS.has((error as { readonly code: string }).code);
}

function protocolError(reason = "askpass-protocol-invalid"): Error { return new Error(reason); }
function ownerUid(): number | null {
  const uid = process.getuid?.();
  return uid === undefined ? null : uid;
}
function currentUid(): number {
  const uid = ownerUid();
  if (uid === null) throw new Error("askpass-owner-identity-unavailable");
  return uid;
}
function identity(stats: Awaited<ReturnType<typeof lstat>>): SocketIdentity {
  const uid = ownerUid();
  if (uid === null) throw new Error("askpass-owner-identity-unavailable");
  return { dev: BigInt(stats.dev), ino: BigInt(stats.ino), uid: Number(stats.uid) };
}
function sameIdentity(left: SocketIdentity, right: SocketIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}
function isPrivateDirectory(stats: Awaited<ReturnType<typeof lstat>>, uid: number): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink() && (Number(stats.mode) & 0o7777) === 0o700 && Number(stats.uid) === uid;
}
function isOwnedSocket(stats: Awaited<ReturnType<typeof lstat>>, uid: number): boolean {
  return stats.isSocket() && !stats.isSymbolicLink() && Number(stats.uid) === uid;
}
function boundedString(value: string, maxBytes: number): boolean {
  return Buffer.byteLength(value, "utf8") > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function frame(payload: Buffer): Buffer {
  if (payload.length > FRAME_MAX_BYTES) throw protocolError();
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function encodeResponse(credential: string): Buffer {
  const value = Buffer.from(credential, "utf8");
  if (value.length > TOKEN_MAX_BYTES) throw protocolError();
  const payload = Buffer.alloc(8 + 4 + 4 + 4 + value.length);
  RESPONSE_MAGIC.copy(payload, 0);
  payload.writeUInt32BE(PROTOCOL_VERSION, 8);
  payload.writeUInt32BE(0, 12);
  payload.writeUInt32BE(value.length, 16);
  value.copy(payload, 20);
  return frame(payload);
}

function decodeRequest(payload: Buffer): {
  readonly capability: string;
  readonly executionId: string;
  readonly pid: number;
  readonly processGroupId: number;
  readonly prompt: string;
} {
  if (payload.length < 8 + 4 + 4 + 4 + 2 + 2 + 4) throw protocolError("decode-short");
  if (!payload.subarray(0, 8).equals(REQUEST_MAGIC) || payload.readUInt32BE(8) !== PROTOCOL_VERSION) throw protocolError("decode-header");
  const pid = payload.readUInt32BE(12);
  const processGroupId = payload.readUInt32BE(16);
  const capabilityLength = payload.readUInt16BE(20);
  const executionLength = payload.readUInt16BE(22);
  const promptLength = payload.readUInt32BE(24);
  if (pid <= 1 || processGroupId <= 1 || capabilityLength !== 64 || executionLength < 1 || executionLength > 128
    || promptLength < 1 || promptLength > PROMPT_MAX_BYTES) throw protocolError("decode-fields");
  const expectedLength = 28 + capabilityLength + executionLength + promptLength;
  if (expectedLength !== payload.length) throw protocolError("decode-length");
  const capability = payload.subarray(28, 28 + capabilityLength).toString("ascii");
  const executionId = payload.subarray(28 + capabilityLength, 28 + capabilityLength + executionLength).toString("utf8");
  const prompt = payload.subarray(28 + capabilityLength + executionLength).toString("utf8");
  try { capabilitySchema.parse(capability); uuidV7Schema.parse(executionId); } catch { throw protocolError("decode-identity"); }
  if (!boundedString(prompt, PROMPT_MAX_BYTES)) throw protocolError("decode-prompt");
  return { capability, executionId, pid, processGroupId, prompt };
}

function constantTimeCapabilityEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "ascii");
  const b = Buffer.from(right, "ascii");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readLinuxProcessGroup(pid: number, claimedProcessGroupId: number): Promise<ProcessGroupIdentity> {
  try {
    process.kill(pid, 0);
    process.kill(-claimedProcessGroupId, 0);
    const processStat = await readFile(`/proc/${pid}/stat`, "utf8");
    const processClose = processStat.lastIndexOf(")");
    const processFields = processStat.slice(processClose + 2).trim().split(/\s+/u);
    const parsedPid = Number(processStat.slice(0, processStat.indexOf(" ")));
    const processGroupId = Number(processFields[2]);
    const groupStat = await readFile(`/proc/${claimedProcessGroupId}/stat`, "utf8");
    const groupClose = groupStat.lastIndexOf(")");
    const groupFields = groupStat.slice(groupClose + 2).trim().split(/\s+/u);
    const parsedGroupPid = Number(groupStat.slice(0, groupStat.indexOf(" ")));
    const groupLeaderProcessGroupId = Number(groupFields[2]);
    const groupStartTimeTicks = groupFields[19];
    if (processClose < 0 || groupClose < 0 || parsedPid !== pid || parsedGroupPid !== claimedProcessGroupId
      || processGroupId !== claimedProcessGroupId || groupLeaderProcessGroupId !== claimedProcessGroupId
      || !Number.isSafeInteger(processGroupId) || processGroupId <= 1
      || !Number.isSafeInteger(groupLeaderProcessGroupId) || groupLeaderProcessGroupId <= 1
      || groupStartTimeTicks === undefined || !/^[0-9]+$/u.test(groupStartTimeTicks)) throw protocolError("process-group");
    return { processGroupId, startTimeTicks: groupStartTimeTicks };
  } catch { throw protocolError("process-group"); }
}

function expectedPrompts(originUrl: string): { readonly username: string; readonly passwords: readonly string[] } {
  const parsed = new URL(originUrl);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw protocolError();
  }
  const clean = parsed.toString();
  const withUsername = new URL(clean);
  withUsername.username = "x-access-token";
  return {
    username: `Username for '${clean}': `,
    passwords: [`Password for '${clean}': `, `Password for '${withUsername.toString()}': `]
  };
}

async function safeRuntimeBase(directory: string, uid: number): Promise<"available" | "unavailable"> {
  const parsed = runtimeDirectorySchema.safeParse(directory);
  if (!parsed.success) throw new Error("askpass-runtime-base-invalid");
  let stats: Awaited<ReturnType<typeof lstat>>;
  try { stats = await lstat(directory); }
  catch (error) {
    if (isRuntimeAvailabilityError(error)) return "unavailable";
    throw error;
  }
  if (!isPrivateDirectory(stats, uid)) throw new Error("askpass-runtime-base-unsafe");
  return "available";
}

async function createRuntimeDirectory(options: GithubAskpassBrokerOptions, uid: number): Promise<{ path: string; identity: SocketIdentity }> {
  const random = options.randomBytes ?? randomBytes;
  const createDirectory = options.mkdir ?? (async (directory: string, mkdirOptions: { readonly mode: number }) => await mkdir(directory, mkdirOptions));
  const environmentBase = process.env.XDG_RUNTIME_DIR;
  const defaultBases = [
    ...(environmentBase === undefined ? [] : [environmentBase]),
    `/run/user/${uid}`,
    "/tmp"
  ];
  const bases = options.runtimeBases ?? defaultBases;
  const suffix = random(16).toString("hex");
  let shortPathSeen = false;
  let availabilityErrorSeen = false;
  for (const base of bases) {
    if (base !== "/tmp") {
      const baseState = await safeRuntimeBase(base, uid);
      if (baseState === "unavailable") { availabilityErrorSeen = true; continue; }
    }
    const directory = path.join(base, `devspace-askpass-${suffix}`);
    const socket = path.join(directory, "broker.sock");
    if (Buffer.byteLength(socket) > SOCKET_PATH_MAX_BYTES) { shortPathSeen = true; continue; }
    try {
      await createDirectory(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const existing = await lstat(directory).catch(() => null);
        if (existing === null || !isPrivateDirectory(existing, uid)) throw new Error("askpass-runtime-directory-ownership-invalid", { cause: error });
        return { path: directory, identity: identity(existing) };
      }
      if (isRuntimeAvailabilityError(error)) { availabilityErrorSeen = true; continue; }
      throw error;
    }
    let stats: Awaited<ReturnType<typeof lstat>>;
    try { stats = await lstat(directory); }
    catch (error) {
      if (isRuntimeAvailabilityError(error)) {
        availabilityErrorSeen = true;
        await rmdir(directory).catch(() => undefined);
        continue;
      }
      throw error;
    }
    if (!isPrivateDirectory(stats, uid)) {
      await rmdir(directory).catch(() => undefined);
      throw new Error("askpass-runtime-directory-ownership-invalid");
    }
    return { path: directory, identity: identity(stats) };
  }
  throw new Error(availabilityErrorSeen ? "askpass-runtime-unavailable" : shortPathSeen ? "askpass-runtime-socket-path-too-long" : "askpass-runtime-unavailable");
}

async function probeExistingSocket(socketPath: string): Promise<"active" | "stale" | "absent"> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (result: "active" | "stale" | "absent") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(200, () => finish("stale"));
    socket.once("connect", () => finish("active"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") finish("absent");
      else if (error.code === "ECONNREFUSED") finish("stale");
      else if (!settled) { settled = true; socket.destroy(); reject(error); }
    });
  });
}

async function removeStaleSocket(socketPath: string, uid: number): Promise<void> {
  const before = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (before === null) return;
  if (!isOwnedSocket(before, uid)) throw new Error("askpass-socket-ownership-invalid");
  const captured = identity(before);
  const state = await probeExistingSocket(socketPath);
  if (state === "active") throw new Error("askpass-socket-active");
  if (state === "absent") return;
  const current = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current === null) return;
  if (!isOwnedSocket(current, uid) || !sameIdentity(captured, identity(current))) throw new Error("askpass-socket-changed");
  await unlink(socketPath);
}

function trustedHelperPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/native/devspace-git-askpass");
}

export function createGithubAskpassBroker(options: GithubAskpassBrokerOptions = {}): GithubAskpassBroker {
  const helperPath = options.helperPath ?? trustedHelperPath();
  const now = options.now ?? Date.now;
  const registrations = new Map<string, Registration>();
  let server: Server | null = null;
  let runtime: { path: string; identity: SocketIdentity } | null = null;
  let socketPath: string | null = null;
  let socketIdentity: SocketIdentity | null = null;
  let startPromise: Promise<void> | null = null;

  const handleConnection = (socket: Socket): void => {
    let bytes = Buffer.alloc(0);
    let settled = false;
    let frameHandled = false;
    const reject = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
    };
    socket.setTimeout(500, reject);
    socket.on("error", reject);
    const handleFrame = async (): Promise<void> => {
      if (settled || frameHandled) return;
      frameHandled = true;
      settled = true;
      try {
        if (bytes.length < FRAME_HEADER_BYTES) throw protocolError();
        const length = bytes.readUInt32BE(0);
        if (length > FRAME_MAX_BYTES || bytes.length !== FRAME_HEADER_BYTES + length) throw protocolError();
        const request = decodeRequest(bytes.subarray(FRAME_HEADER_BYTES));
        const registration = registrations.get(request.capability);
        if (registration === undefined) throw new Error("registration");
        if (!constantTimeCapabilityEquals(request.capability, registration.capability)) throw new Error("capability");
        if (now() >= registration.deadlineAt.valueOf()) throw new Error("deadline");
        if (request.executionId !== registration.executionId) throw new Error("execution");
        const group = await readLinuxProcessGroup(request.pid, request.processGroupId);
        if (registration.processGroup === null) registration.processGroup = group;
        else if (registration.processGroup.processGroupId !== group.processGroupId || registration.processGroup.startTimeTicks !== group.startTimeTicks) throw new Error("process-group");
        const prompts = expectedPrompts(registration.originUrl);
        const isUsername = request.prompt === prompts.username;
        const isPassword = prompts.passwords.includes(request.prompt);
        if (!isUsername && !isPassword) throw new Error("prompt");
        if (registration.promptState === "awaiting-username" && !isUsername) throw new Error("password-before-username");
        if (registration.promptState === "awaiting-password" && !isPassword) throw new Error("username-duplicate");
        if (registration.promptState === "complete") throw new Error("credential-prompt-complete");
        registration.promptState = isUsername ? "awaiting-password" : "complete";
        socket.end(encodeResponse(isUsername ? "x-access-token" : registration.token));
      } catch {
        socket.destroy();
      }
    };
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > FRAME_HEADER_BYTES + FRAME_MAX_BYTES) return reject();
      if (bytes.length >= FRAME_HEADER_BYTES) {
        const length = bytes.readUInt32BE(0);
        if (length > FRAME_MAX_BYTES) return reject();
        if (bytes.length > FRAME_HEADER_BYTES + length) return reject();
        if (bytes.length === FRAME_HEADER_BYTES + length) void handleFrame().catch(() => undefined);
      }
    });
    socket.on("end", () => { if (!frameHandled) reject(); });
  };

  const startBroker = async (): Promise<void> => {
    if (server !== null) return;
    const uid = currentUid();
    runtime = await createRuntimeDirectory(options, uid);
    socketPath = path.join(runtime.path, "broker.sock");
    let created: Server | null = null;
    let socketPublished = false;
    try {
      await removeStaleSocket(socketPath, uid);
      created = net.createServer({ allowHalfOpen: true }, handleConnection);
      await new Promise<void>((resolve, reject) => {
        created?.once("error", reject);
        created?.listen(socketPath!, () => { created?.off("error", reject); socketPublished = true; resolve(); });
      });
      await chmod(socketPath, 0o700);
      const stats = await lstat(socketPath);
      if (!isOwnedSocket(stats, uid)) throw new Error("askpass-socket-ownership-invalid");
      socketIdentity = identity(stats);
      server = created;
    } catch (error) {
      created?.close();
      if (socketPath !== null) {
        const current = await lstat(socketPath).catch((socketError: NodeJS.ErrnoException) => {
          if (socketError.code === "ENOENT") return null;
          return null;
        });
        if (socketPublished && current !== null && isOwnedSocket(current, uid)
          && (socketIdentity === null || sameIdentity(socketIdentity, identity(current)))) {
          await unlink(socketPath).catch(() => undefined);
        }
      }
      if (runtime !== null) {
        const current = await lstat(runtime.path).catch(() => null);
        if (current !== null && isPrivateDirectory(current, uid) && sameIdentity(runtime.identity, identity(current))) {
          await rmdir(runtime.path).catch(() => undefined);
        }
      }
      runtime = null;
      socketPath = null;
      socketIdentity = null;
      throw error;
    }
  };
  const ensureStarted = async (): Promise<void> => {
    if (server !== null) return;
    if (startPromise === null) {
      startPromise = startBroker().catch((error: unknown) => {
        startPromise = null;
        throw error;
      });
    }
    await startPromise;
  };

  return {
    get socketPath() { return socketPath; },
    get runtimeDirectory() { return runtime?.path ?? null; },
    helperPath,
    ensureStarted,
    async start() { await ensureStarted(); },
    async stop() {
      const pendingStart = startPromise;
      if (pendingStart !== null) await pendingStart.catch(() => undefined);
      for (const capability of registrations.keys()) registrations.delete(capability);
      const activeServer = server;
      server = null;
      if (activeServer !== null) await new Promise<void>((resolve) => activeServer.close(() => resolve()));
      if (socketPath !== null && socketIdentity !== null) {
        const current = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (current !== null && (!isOwnedSocket(current, currentUid()) || !sameIdentity(socketIdentity, identity(current)))) {
          throw new Error("askpass-socket-changed");
        }
        if (current !== null) await unlink(socketPath);
      }
      if (runtime !== null) {
        const current = await lstat(runtime.path);
        if (!isPrivateDirectory(current, currentUid()) || !sameIdentity(runtime.identity, identity(current))) throw new Error("askpass-runtime-directory-changed");
        await rmdir(runtime.path);
      }
      socketIdentity = null;
      socketPath = null;
      runtime = null;
      startPromise = null;
    },
    register(input) {
      if (server === null || socketPath === null) throw new Error("askpass-broker-not-started");
      const connectionId = githubConnectionIdSchema.parse(input.connectionId);
      const repositoryId = githubDecimalIdSchema.parse(input.repositoryId);
      const operationId = uuidV7Schema.parse(input.operationId);
      const executionId = uuidV7Schema.parse(input.executionId);
      if (!boundedString(input.token, TOKEN_MAX_BYTES) || !Number.isFinite(input.deadlineAt.valueOf()) || input.deadlineAt.valueOf() <= now()) throw new Error("askpass-capability-invalid");
      expectedPrompts(input.originUrl);
      const capability = randomBytes(32).toString("hex");
      registrations.set(capability, { ...input, connectionId, repositoryId, operationId, executionId, capability, promptState: "awaiting-username", processGroup: null });
      return {
        capability, socketPath, helperPath, executionId,
        environment: {
          DEVSPACE_GIT_ASKPASS_SOCKET: socketPath,
          DEVSPACE_GIT_ASKPASS_CAPABILITY: capability,
          DEVSPACE_GIT_ASKPASS_EXECUTION_ID: executionId
        }
      };
    },
    settle(capability) { if (capabilitySchema.safeParse(capability).success) registrations.delete(capability); }
  };
}
