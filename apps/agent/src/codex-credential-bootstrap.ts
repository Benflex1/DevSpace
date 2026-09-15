import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  DockerEngineClient,
  type DockerCodexBootstrapContainerInput,
  type DockerContainerInspection
} from "./docker-runtime.js";
import {
  CODEX_STAGED_READBACK_HELPER_SHA256,
  CODEX_NATIVE_HELPER_PLATFORM
} from "./codex-native-helper-identity.js";
import {
  createCodexCredentialAuthority,
  readStagedAuth,
  type CodexCredentialAuthority
} from "./codex-credential-authority.js";
import {
  resolveCodexExecutionArtifact,
  stageCodexExecutionArtifact,
  verifyStagedCodexExecutionArtifact,
  type StagedCodexExecutionArtifact
} from "./codex-app-server/artifact-identity.js";
import { createCodexJsonlTransport } from "./codex-app-server/transport.js";
import { architectureCompatible } from "./codex-app-server/probe-runtime.js";
import { establishPinnedDirectory, readRegularFileNoFollow } from "./private-state.js";

export { buildCodexBootstrapContainerInput } from "./docker-runtime.js";

const DEFAULT_BOOTSTRAP_IMAGE = "node:24-bookworm";
const BOOTSTRAP_CPU_MILLICORES = 1_000;
const BOOTSTRAP_MEMORY_BYTES = 512 * 1024 * 1024;
const BOOTSTRAP_PID_LIMIT = 128;
const BOOTSTRAP_REQUEST_TIMEOUT_MS = 15_000;
const BOOTSTRAP_LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const BOOTSTRAP_AUTH_WAIT_TIMEOUT_MS = 10_000;
const BOOTSTRAP_AUTH_POLL_MS = 100;
const BOOTSTRAP_MAX_DEVICE_URL_BYTES = 2_048;
const BOOTSTRAP_MAX_DEVICE_CODE_BYTES = 256;
const BOOTSTRAP_HELPER_CONTAINER_PATH = "/opt/codex-home/.devspace-staged-readback";
const BOOTSTRAP_HOME_CONTAINER_PATH = "/opt/codex-home";
const BOOTSTRAP_IMAGE_ARCHITECTURE = "amd64";
const BOOTSTRAP_TARGET_ARCHITECTURE = "amd64";

export type CodexBootstrapDeviceCode = Readonly<{
  readonly verificationUrl: string;
  readonly userCode: string;
}>;

export interface CodexCredentialBootstrapInput {
  readonly stateRoot: string;
  readonly configuredCodexPath: string;
  readonly docker: DockerEngineClient;
  readonly createId: () => string;
  readonly imageReference?: string;
  readonly reauthenticate?: boolean;
  readonly onDeviceCode: (details: CodexBootstrapDeviceCode) => Promise<void> | void;
  readonly helperPath?: string;
  readonly loginTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type CodexCredentialBootstrapResult = Readonly<{
  readonly imageId: string;
  readonly artifactClosureDigest: string;
  readonly helperSha256: string;
}>;

function bootstrapError(code: string): Error {
  return new Error(`codex-bootstrap-${code}`);
}

function safeId(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_-]/gu, "").slice(0, 72) || "codex";
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function boundedString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) return null;
  return value;
}

function normalizeArchitecture(value: string): string {
  const base = value.split("-", 1)[0] ?? value;
  return ({ x86_64: "amd64", x64: "amd64", x86: "386", i686: "386", aarch64: "arm64", arm64: "arm64" }[base] ?? base);
}

function packagedReadbackHelperPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "native", "codex-staged-readback");
}

async function readTrustedReadbackHelper(helperPath: string): Promise<Buffer> {
  let read;
  try { read = await readRegularFileNoFollow(helperPath, 4 * 1024 * 1024); }
  catch { throw bootstrapError("readback-helper-unavailable"); }
  if ((read.stats.mode & 0o111n) === 0n) throw bootstrapError("readback-helper-unavailable");
  const digest = createHash("sha256").update(read.bytes).digest("hex");
  if (digest !== CODEX_STAGED_READBACK_HELPER_SHA256) throw bootstrapError("readback-helper-integrity");
  return read.bytes;
}

async function existsAsAnyPath(target: string): Promise<boolean> {
  try { await lstat(target); return true; } catch { return false; }
}

async function assertRemovablePrivateDirectory(target: string, parent: string): Promise<void> {
  const absolute = path.resolve(target);
  const expectedParent = path.resolve(parent);
  const relative = path.relative(expectedParent, absolute);
  if (relative.length === 0 || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw bootstrapError("cleanup-unproven");
  }
  let stats;
  try { stats = await lstat(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw bootstrapError("cleanup-unproven");
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw bootstrapError("cleanup-unproven");
}

async function removePrivateDirectory(target: string, parent: string): Promise<void> {
  await assertRemovablePrivateDirectory(target, parent);
  if (await existsAsAnyPath(target)) {
    try { await rm(target, { recursive: true, force: false }); }
    catch { throw bootstrapError("cleanup-unproven"); }
  }
}

function expectedBootstrapMounts(input: DockerCodexBootstrapContainerInput): ReadonlyArray<{
  readonly Type: string; readonly Source: string; readonly Destination: string; readonly RW: boolean;
}> {
  return [
    { Type: "bind", Source: path.resolve(input.artifactRoot), Destination: "/opt/codex", RW: false },
    { Type: "bind", Source: path.resolve(input.codexHomePath), Destination: "/opt/codex-home", RW: true }
  ];
}

function verifyBootstrapContainer(
  container: DockerContainerInspection,
  input: DockerCodexBootstrapContainerInput,
  imageId: string
): void {
  const host = container.HostConfig;
  const expectedMounts = expectedBootstrapMounts(input);
  const mounts = container.Mounts.map((mount) => ({ Type: mount.Type, Source: mount.Source, Destination: mount.Destination, RW: mount.RW }))
    .sort((left, right) => left.Destination.localeCompare(right.Destination));
  const sortedExpected = [...expectedMounts].sort((left, right) => left.Destination.localeCompare(right.Destination));
  if (container.Id.length === 0 || container.Image !== imageId
    || container.Config.WorkingDir !== "/" || JSON.stringify(container.Config.Entrypoint) !== JSON.stringify(["/bin/sh", "-c"])
    || JSON.stringify(container.Config.Cmd) !== JSON.stringify(["exec sleep 2147483647"])
    || container.Config.User !== "" || JSON.stringify(mounts) !== JSON.stringify(sortedExpected)
    || (host.Binds ?? []).length !== 0 || (host.Mounts ?? []).length !== expectedMounts.length
    || JSON.stringify(host.Tmpfs) !== JSON.stringify({ "/tmp": "rw,nosuid,nodev,noexec,size=64m" })
    || host.NetworkMode !== "bridge" || host.Privileged !== false || host.PidMode !== ""
    || host.IpcMode !== "private" || host.UTSMode !== "" || host.UsernsMode !== "" || host.CgroupnsMode !== "private"
    || host.PortBindings === null || Object.keys(host.PortBindings).length !== 0 || host.PublishAllPorts !== false
    || host.AutoRemove !== false || host.ReadonlyRootfs !== true || host.RestartPolicy.Name !== "no"
    || host.Devices === null || host.Devices.length !== 0 || host.CapAdd === null || host.CapAdd.length !== 0
    || JSON.stringify(host.CapDrop) !== JSON.stringify(["ALL"])
    || JSON.stringify(host.SecurityOpt) !== JSON.stringify(["no-new-privileges:true"])
    || host.NanoCpus !== input.cpuMillicores * 1_000_000 || host.Memory !== input.memoryBytes
    || host.MemorySwap !== input.memoryBytes || host.PidsLimit !== input.pidLimit) {
    throw bootstrapError("container-policy-mismatch");
  }
}

async function waitForAttachedClose(stream: Duplex): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(bootstrapError("docker-exec-timeout"));
    }, BOOTSTRAP_REQUEST_TIMEOUT_MS);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener("close", onClose);
      stream.removeListener("error", onError);
      if (error === undefined) resolve(); else reject(error);
    };
    const onClose = () => finish();
    const onError = () => finish(bootstrapError("docker-exec-failed"));
    stream.once("close", onClose);
    stream.once("error", onError);
    stream.resume();
  });
}

async function uploadPrivateFile(docker: DockerEngineClient, containerId: string, targetPath: string, bytes: Buffer): Promise<void> {
  const execId = await docker.createExec(containerId, {
    command: ["sh", "-c", 'umask 077; cat > "$DEVSPACE_TARGET_PATH"; chmod 0700 "$DEVSPACE_TARGET_PATH"'],
    workingDirectory: "/", environment: { DEVSPACE_TARGET_PATH: targetPath }, attachStdin: true, tty: false
  });
  const stream = await docker.startExecAttached(execId, false);
  const closed = waitForAttachedClose(stream);
  stream.end(bytes);
  await closed;
  const inspection = await docker.inspectExec(execId).catch(() => null);
  if (inspection === null || inspection.Running || inspection.ExitCode !== 0) throw bootstrapError("helper-upload");
}

type RpcPending = Readonly<{
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}>;

function rpcRequest(
  transport: ReturnType<typeof createCodexJsonlTransport>,
  pending: Map<number, RpcPending>,
  nextId: number,
  method: string,
  params: Readonly<Record<string, unknown>>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(nextId);
      reject(bootstrapError("login-request-timeout"));
    }, BOOTSTRAP_REQUEST_TIMEOUT_MS);
    pending.set(nextId, { resolve, reject, timer });
    try { transport.write({ id: nextId, method, params }); }
    catch (error) {
      clearTimeout(timer);
      pending.delete(nextId);
      reject(error instanceof Error ? error : bootstrapError("login-request"));
    }
  });
}

async function runDeviceLogin(input: {
  readonly docker: DockerEngineClient;
  readonly containerId: string;
  readonly executablePath: string;
  readonly onDeviceCode: (details: CodexBootstrapDeviceCode) => Promise<void> | void;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const execId = await input.docker.createExec(input.containerId, {
    command: [input.executablePath, "app-server", "--stdio"], workingDirectory: "/",
    environment: { CODEX_HOME: BOOTSTRAP_HOME_CONTAINER_PATH, HOME: BOOTSTRAP_HOME_CONTAINER_PATH, TMPDIR: "/tmp" },
    attachStdin: true, tty: false
  });
  const stream = await input.docker.startExecAttached(execId, false);
  const pending = new Map<number, RpcPending>();
  let nextId = 1;
  let completionResolve: (() => void) | null = null;
  let completionReject: ((error: Error) => void) | null = null;
  let completionSettled = false;
  const completion = new Promise<void>((resolve, reject) => {
    completionResolve = resolve;
    completionReject = reject;
  });
  // Cleanup can cancel before the device callback returns. Keep that internal
  // rejection observed even when the login request never reaches its await.
  void completion.catch(() => undefined);
  const rejectAll = (error: Error): void => {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      pending.delete(id);
      request.reject(error);
    }
    if (!completionSettled) {
      completionSettled = true;
      completionReject?.(error);
    }
  };
  const transport = createCodexJsonlTransport({
    stream,
    onMessage: (message) => {
      const id = typeof message.id === "number" && Number.isSafeInteger(message.id) ? message.id : null;
      if (id !== null) {
        const request = pending.get(id);
        if (request !== undefined) {
          pending.delete(id);
          clearTimeout(request.timer);
          if (Object.hasOwn(message, "error")) request.reject(bootstrapError("login-request"));
          else request.resolve(message.result);
        }
      }
      if (message.method !== "account/login/completed") return;
      const params = objectRecord(message.params);
      if (params === null || typeof params.success !== "boolean") {
        if (!completionSettled) { completionSettled = true; completionReject?.(bootstrapError("login-failed")); }
      } else if (params.success) {
        if (!completionSettled) { completionSettled = true; completionResolve?.(); }
      } else if (!completionSettled) {
        completionSettled = true;
        completionReject?.(bootstrapError("login-failed"));
      }
    },
    onProtocolFailure: () => rejectAll(bootstrapError("protocol")),
    maxJsonMessageBytes: 1_114_112,
    maxFramePayloadBytes: 1_122_304,
    maxPartialBufferBytes: 1_122_312
  });
  stream.on("data", (chunk: Buffer) => { transport.receiveDockerData(chunk); });
  stream.on("error", () => rejectAll(bootstrapError("docker-stream")));
  stream.on("close", () => { if (!completionSettled) rejectAll(bootstrapError("docker-stream")); });
  const abortHandler = () => rejectAll(bootstrapError("cancelled"));
  input.signal?.addEventListener("abort", abortHandler, { once: true });
  const deadline = Date.now() + input.timeoutMs;
  const remaining = (): number => Math.max(1, deadline - Date.now());
  let loginTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (input.signal?.aborted) throw bootstrapError("cancelled");
    const initialized = await rpcRequest(transport, pending, nextId++, "initialize", {
      clientInfo: { name: "devspace-codex-bootstrap", title: "DevSpace Codex credential bootstrap", version: "1.0.0" },
      capabilities: { experimentalApi: true }
    });
    if (objectRecord(initialized) === null) throw bootstrapError("login-protocol");
    transport.write({ method: "initialized" });
    const started = objectRecord(await rpcRequest(transport, pending, nextId++, "account/login/start", { type: "chatgptDeviceCode" }));
    if (started === null) throw bootstrapError("login-protocol");
    const verificationUrl = boundedString(started.verificationUrl, BOOTSTRAP_MAX_DEVICE_URL_BYTES);
    const userCode = boundedString(started.userCode, BOOTSTRAP_MAX_DEVICE_CODE_BYTES);
    if (verificationUrl === null || userCode === null) throw bootstrapError("login-protocol");
    let parsedUrl: URL;
    try { parsedUrl = new URL(verificationUrl); } catch { throw bootstrapError("login-protocol"); }
    if (parsedUrl.protocol !== "https:") throw bootstrapError("login-protocol");
    await input.onDeviceCode({ verificationUrl, userCode });
    const timeout = new Promise<never>((_, reject) => {
      loginTimeout = setTimeout(() => reject(bootstrapError("login-timeout")), remaining());
    });
    await Promise.race([completion, timeout]);
  } finally {
    if (loginTimeout !== undefined) clearTimeout(loginTimeout);
    input.signal?.removeEventListener("abort", abortHandler);
    transport.destroy();
    rejectAll(bootstrapError("login-stopped"));
    await input.docker.inspectExec(execId).catch(() => undefined);
  }
}

async function waitForStagedAuth(input: {
  readonly docker: DockerEngineClient;
  readonly containerId: string;
  readonly stagedAuthPath: string;
  readonly readbackHelperPath: string;
}): Promise<void> {
  const deadline = Date.now() + BOOTSTRAP_AUTH_WAIT_TIMEOUT_MS;
  while (true) {
    try {
      await readStagedAuth({ ...input, workingDirectory: "/" });
      return;
    } catch {
      if (Date.now() >= deadline) throw bootstrapError("authority-readback");
      await new Promise<void>((resolve) => setTimeout(resolve, BOOTSTRAP_AUTH_POLL_MS));
    }
  }
}

function authorityPathParent(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), "codex-auth");
}

async function ensureAuthorityDirectory(authority: CodexCredentialAuthority): Promise<void> {
  await establishPinnedDirectory(authority.authorityDir);
  await chmod(authority.authorityDir, 0o700);
}

export function codexBootstrapArchitectureCompatible(target: { readonly os: string; readonly architecture: string }, imageArchitecture: string): boolean {
  return target.os === "linux"
    && normalizeArchitecture(target.architecture) === BOOTSTRAP_TARGET_ARCHITECTURE
    && normalizeArchitecture(imageArchitecture) === BOOTSTRAP_IMAGE_ARCHITECTURE
    && architectureCompatible(target.architecture, imageArchitecture);
}

function checkSupportedArchitecture(staged: StagedCodexExecutionArtifact, imageArchitecture: string): void {
  if (!codexBootstrapArchitectureCompatible(staged.artifact.target, imageArchitecture)) {
    throw bootstrapError(`unsupported-architecture-${CODEX_NATIVE_HELPER_PLATFORM}`);
  }
}

export async function bootstrapCodexCredential(input: CodexCredentialBootstrapInput): Promise<CodexCredentialBootstrapResult> {
  const stateRoot = path.resolve(input.stateRoot);
  const authority = createCodexCredentialAuthority(stateRoot);
  await ensureAuthorityDirectory(authority);
  const lease = await authority.acquire({
    aiSessionId: "codex-credential-bootstrap", workspaceId: "codex-credential-bootstrap", processGeneration: 1
  });
  let staged: StagedCodexExecutionArtifact | null = null;
  let homePath: string | null = null;
  let containerId: string | null = null;
  let operationError: unknown = null;
  let imageId = "";
  let helperSha256 = CODEX_STAGED_READBACK_HELPER_SHA256;
  const reauthenticate = input.reauthenticate === true;
  try {
    const authorityExists = await existsAsAnyPath(authority.authPath);
    const markerExists = await existsAsAnyPath(authority.reauthMarkerPath);
    if (authorityExists && !reauthenticate) throw bootstrapError("authority-exists-use-reauth");
    if (markerExists && !reauthenticate) throw bootstrapError("reauthentication-required");

    const artifact = await resolveCodexExecutionArtifact(input.configuredCodexPath);
    staged = await stageCodexExecutionArtifact({ artifact, stateRoot });
    await verifyStagedCodexExecutionArtifact(staged);
    const helperPath = input.helperPath ?? packagedReadbackHelperPath();
    const helperBytes = await readTrustedReadbackHelper(helperPath);
    helperSha256 = createHash("sha256").update(helperBytes).digest("hex");
    const imageReference = input.imageReference ?? DEFAULT_BOOTSTRAP_IMAGE;
    await input.docker.ensureImage(imageReference);
    const image = await input.docker.inspectImage(imageReference);
    if (!/^sha256:[0-9a-f]{32,}$/u.test(image.Id) || image.Os !== "linux") throw bootstrapError("image-unavailable");
    checkSupportedArchitecture(staged, image.Architecture);
    imageId = image.Id;
    homePath = await mkdtemp(path.join(stateRoot, ".codex-bootstrap-home-"));
    await chmod(homePath, 0o700);
    const containerInput: DockerCodexBootstrapContainerInput = {
      imageId, artifactRoot: staged.stagingRoot, codexHomePath: homePath,
      labels: { "devspace.private-purpose": "codex-credential-bootstrap", "devspace.policy": "isolated-device-login-v1" },
      cpuMillicores: BOOTSTRAP_CPU_MILLICORES, memoryBytes: BOOTSTRAP_MEMORY_BYTES, pidLimit: BOOTSTRAP_PID_LIMIT
    };
    const containerName = `devspace-codex-credential-bootstrap-${safeId(input.createId())}`;
    containerId = await input.docker.createCodexBootstrapContainer(containerName, containerInput);
    const created = await input.docker.inspectContainer(containerId);
    verifyBootstrapContainer(created, containerInput, imageId);
    await input.docker.startContainer(containerId);
    await uploadPrivateFile(input.docker, containerId, BOOTSTRAP_HELPER_CONTAINER_PATH, helperBytes);
    const executablePath = path.posix.join("/opt/codex", staged.artifact.entrypoint.relativePath);
    await runDeviceLogin({
      docker: input.docker, containerId, executablePath, onDeviceCode: input.onDeviceCode,
      timeoutMs: input.loginTimeoutMs ?? BOOTSTRAP_LOGIN_TIMEOUT_MS,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    await waitForStagedAuth({ docker: input.docker, containerId, stagedAuthPath: `${BOOTSTRAP_HOME_CONTAINER_PATH}/auth.json`, readbackHelperPath: BOOTSTRAP_HELPER_CONTAINER_PATH });
    await authority.synchronizeStaged({
      docker: input.docker, containerId, stagedAuthPath: `${BOOTSTRAP_HOME_CONTAINER_PATH}/auth.json`,
      readbackHelperPath: BOOTSTRAP_HELPER_CONTAINER_PATH, workingDirectory: "/"
    });
    if (markerExists) await authority.clearReauthenticationRequired();
    // The lease intentionally remains held until the replacement and its
    // cleanup are complete. read() validates the newly durable authority
    // here; inspect() runs after the lease is released below.
    await authority.read();
  } catch (error) {
    operationError = error;
  } finally {
    const cleanupErrors: Error[] = [];
    if (containerId !== null) {
      try { await input.docker.stopContainer(containerId); } catch { /* force removal below remains required */ }
      try { await input.docker.removeContainer(containerId); } catch { cleanupErrors.push(bootstrapError("container-cleanup")); }
    }
    if (homePath !== null) {
      try { await removePrivateDirectory(homePath, stateRoot); } catch (error) { cleanupErrors.push(error instanceof Error ? error : bootstrapError("cleanup-unproven")); }
    }
    if (staged !== null) {
      try { await removePrivateDirectory(staged.stagingRoot, path.join(stateRoot, "codex-artifacts")); }
      catch (error) { cleanupErrors.push(error instanceof Error ? error : bootstrapError("cleanup-unproven")); }
    }
    try { await lease.release(); } catch { cleanupErrors.push(bootstrapError("lease-release")); }
    if (operationError === null && cleanupErrors.length > 0) operationError = cleanupErrors[0];
  }
  if (operationError instanceof Error) throw operationError;
  if (operationError !== null) throw bootstrapError("failed");
  await authority.inspect();
  return { imageId, artifactClosureDigest: staged?.artifact.closureDigest ?? "", helperSha256 };
}

export function codexBootstrapStateRootFromManagedRoot(managedRoot: string): string {
  return path.join(path.resolve(managedRoot), "state");
}

export function codexBootstrapAuthorityParent(stateRoot: string): string {
  return authorityPathParent(stateRoot);
}
