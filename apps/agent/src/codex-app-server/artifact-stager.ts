import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import type { CodexProbeRuntimeIdentity } from "@devspace/contracts";
import { readRegularFileNoFollow } from "../private-state.js";
import type { DockerEngineClient } from "../docker-runtime.js";
import {
  codexArtifactStagingDiagnostic,
  codexArtifactStagingTiming,
  type CodexArtifactStagingDiagnostic,
  type CodexArtifactStagingPhase,
  type CodexArtifactStagingTiming
} from "./artifact-staging-diagnostics.js";
import {
  codexExecutionArtifactClosureDigest,
  verifyStagedCodexExecutionArtifact,
  type CodexArtifactEntry,
  type StagedCodexExecutionArtifact
} from "./artifact-identity.js";

const PRIVATE_CONTAINER_ROOT = "/tmp/devspace-ai";
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_READBACK_BYTES = MAX_ENTRY_BYTES + 64;
const MAX_TREE_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_TREE_READBACK_BYTES = MAX_TREE_OUTPUT_BYTES + 64 * 1024;
const EXEC_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const MAX_ARTIFACT_TRANSFER_TIMEOUT_MS = 60_000;
const MIN_ARTIFACT_TRANSFER_RATE_BYTES_PER_SECOND = 16 * 1024 * 1024;
const ARTIFACT_READBACK_HEADER_BYTES = 32;
const ARTIFACT_READBACK_MAGIC = "DSARTF01";
const ARTIFACT_READBACK_VERSION = 1;
const ARTIFACT_TREE_HEADER_BYTES = 20;
const ARTIFACT_TREE_MAGIC = "DSARTL01";
const ARTIFACT_TREE_VERSION = 1;
const ARTIFACT_TREE_MAX_ENTRIES = 16_384;

export interface CodexLaunchArtifact {
  readonly staged: StagedCodexExecutionArtifact;
  readonly managedImageId: string;
  readonly probeRuntime: CodexProbeRuntimeIdentity;
  readonly profileRevision: string;
}

export interface CodexArtifactReadback {
  readonly kind: "file" | "symlink";
  readonly mode: number;
  readonly bytes: Buffer;
  readonly linkTarget: string | null;
}

export interface CodexArtifactTreeEntry {
  readonly kind: "directory" | "file" | "symlink" | "special";
  readonly relativePath: string;
}

export interface CodexArtifactStager {
  stageIntoRunningContainer(input: {
    readonly containerId: string;
    readonly staged: StagedCodexExecutionArtifact;
    readonly destinationRoot: string;
  }): Promise<{ readonly entrypointPath: string }>;
  stageIntoManagedProvider(input: {
    readonly containerId: string;
    readonly launchArtifact: CodexLaunchArtifact;
    readonly sessionId: string;
    readonly processGeneration: number;
  }): Promise<{
    readonly containerRoot: string;
    readonly entrypointPath: string;
    readonly artifactReadbackPath: string;
  }>;
}

export interface CodexArtifactStagerOptions {
  readonly docker: DockerEngineClient;
  readonly readbackHelperBytes: Uint8Array;
  readonly createId: () => string;
  /** Agent-private, bounded diagnostics for native harness artifact staging failures. */
  readonly onFailure?: (diagnostic: CodexArtifactStagingDiagnostic) => void;
  /** Agent-private, bounded phase timings; never contains artifact bytes or provider state. */
  readonly onTiming?: (timing: CodexArtifactStagingTiming) => void;
  /** Agent-private deterministic readback seam; production invokes the native helper. */
  readonly readbackEntry?: (input: {
    readonly containerId: string;
    readonly artifactRoot: string;
    readonly entry: CodexArtifactEntry;
    readonly readbackPath: string;
    readonly timeoutMs: number;
  }) => Promise<CodexArtifactReadback>;
  /** Agent-private deterministic tree-listing seam; production invokes the native helper. */
  readonly listArtifactTree?: (input: {
    readonly containerId: string;
    readonly artifactRoot: string;
    readonly readbackPath: string;
  }) => Promise<readonly CodexArtifactTreeEntry[] | null>;
  /** Agent-private deterministic timer seam for bounded exec deadlines. */
  readonly scheduleTimeout?: (callback: () => void, timeoutMs: number) => () => void;
}

export type { CodexArtifactStagingDiagnostic } from "./artifact-staging-diagnostics.js";

function normalizeArchitecture(value: string): string {
  return ({ x86_64: "amd64", x64: "amd64", x86: "386", i686: "386", aarch64: "arm64", arm64: "arm64" }[value] ?? value);
}

function safeId(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_-]/gu, "").slice(0, 96) || "codex";
}

function entryPath(root: string, entry: CodexArtifactEntry): string {
  const components = entry.relativePath.split("/");
  if (components.some((component) => component.length === 0 || component === "." || component === "..")) {
    throw new Error("codex-artifact-path-invalid");
  }
  return path.posix.join(root, ...components);
}

export function codexArtifactTransferTimeoutMs(byteLength: number): number {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) return EXEC_TIMEOUT_MS;
  const rate = BigInt(MIN_ARTIFACT_TRANSFER_RATE_BYTES_PER_SECOND);
  const transferBudgetSeconds = (BigInt(byteLength) + rate - 1n) / rate;
  const timeoutMs = BigInt(EXEC_TIMEOUT_MS) + transferBudgetSeconds * 1_000n;
  const maxTimeoutMs = BigInt(MAX_ARTIFACT_TRANSFER_TIMEOUT_MS);
  return Number(timeoutMs > maxTimeoutMs ? maxTimeoutMs : timeoutMs);
}

type ScheduleTimeout = (callback: () => void, timeoutMs: number) => () => void;

const scheduleRealTimeout: ScheduleTimeout = (callback, timeoutMs) => {
  const timer = setTimeout(callback, timeoutMs);
  return () => clearTimeout(timer);
};

async function waitForClose(
  stream: Duplex,
  timeoutMs = EXEC_TIMEOUT_MS,
  scheduleTimeout: ScheduleTimeout = scheduleRealTimeout
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cancelTimeout = scheduleTimeout(() => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(new Error("codex-artifact-exec-unproven"));
    }, timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      stream.removeListener("close", onClose);
      stream.removeListener("error", onError);
      if (error === undefined) resolve(); else reject(error);
    };
    const onClose = () => finish();
    const onError = () => finish(new Error("codex-artifact-exec-unproven"));
    stream.once("close", onClose);
    stream.once("error", onError);
    stream.resume();
  });
}

async function collectOutput(
  stream: Duplex,
  maxBytes = MAX_READBACK_BYTES + 16 * 1024,
  timeoutMs = EXEC_TIMEOUT_MS,
  scheduleTimeout: ScheduleTimeout = scheduleRealTimeout
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let cancelTimeout = () => {};
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      stream.removeAllListeners("data");
      stream.removeAllListeners("close");
      stream.removeAllListeners("error");
      if (error === undefined) resolve(Buffer.concat(chunks)); else reject(error);
    };
    cancelTimeout = scheduleTimeout(() => {
      stream.destroy();
      finish(new Error("codex-artifact-readback-timeout"));
    }, timeoutMs);
    stream.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        stream.destroy();
        finish(new Error("codex-artifact-readback-too-large"));
      } else chunks.push(bytes);
    });
    stream.once("close", () => finish());
    stream.once("error", () => finish(new Error("codex-artifact-readback-unproven")));
    stream.resume();
  });
}

function decodeDockerFrames(raw: Buffer): Buffer {
  const output: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    if (offset + 8 > raw.length) throw new Error("codex-artifact-readback-frame");
    const stream = raw[offset];
    const size = raw.readUInt32BE(offset + 4);
    if (stream !== 1 && stream !== 2 || offset + 8 + size > raw.length) throw new Error("codex-artifact-readback-frame");
    if (stream === 1) output.push(raw.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(output);
}

export function parseCodexArtifactReadback(raw: Buffer): CodexArtifactReadback {
  if (raw.length < ARTIFACT_READBACK_HEADER_BYTES
    || raw.subarray(0, ARTIFACT_READBACK_MAGIC.length).toString("ascii") !== ARTIFACT_READBACK_MAGIC
    || raw.readUInt32BE(8) !== ARTIFACT_READBACK_VERSION) {
    throw new Error("codex-artifact-readback-frame");
  }
  const kind = raw.readUInt32BE(12);
  const mode = raw.readUInt32BE(16);
  const byteLength = raw.readBigUInt64BE(24);
  if (byteLength > BigInt(MAX_ENTRY_BYTES) || byteLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("codex-artifact-readback-too-large");
  }
  const length = Number(byteLength);
  if (ARTIFACT_READBACK_HEADER_BYTES + length !== raw.length || (kind !== 1 && kind !== 2)) {
    throw new Error("codex-artifact-readback-frame");
  }
  const bytes = Buffer.from(raw.subarray(ARTIFACT_READBACK_HEADER_BYTES));
  if (kind === 1) return { kind: "file", mode, bytes, linkTarget: null };
  if (bytes.length === 0 || bytes.length > 4_096) throw new Error("codex-artifact-link-invalid");
  const linkTarget = bytes.toString("utf8");
  if (linkTarget.startsWith("/") || linkTarget.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("codex-artifact-link-invalid");
  }
  return { kind: "symlink", mode, bytes: Buffer.alloc(0), linkTarget };
}

export function parseCodexArtifactTree(raw: Buffer): readonly CodexArtifactTreeEntry[] | null {
  if (raw.length < ARTIFACT_TREE_HEADER_BYTES || raw.length > MAX_TREE_OUTPUT_BYTES
    || raw.subarray(0, ARTIFACT_TREE_MAGIC.length).toString("ascii") !== ARTIFACT_TREE_MAGIC
    || raw.readUInt32BE(8) !== ARTIFACT_TREE_VERSION) {
    throw new Error("codex-artifact-tree-frame");
  }
  const status = raw.readUInt32BE(12);
  const count = raw.readUInt32BE(16);
  if (count > ARTIFACT_TREE_MAX_ENTRIES) throw new Error("codex-artifact-tree-too-large");
  if (status === 1) {
    if (count !== 0 || raw.length !== ARTIFACT_TREE_HEADER_BYTES) throw new Error("codex-artifact-tree-frame");
    return null;
  }
  if (status !== 0) throw new Error("codex-artifact-tree-frame");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const result: CodexArtifactTreeEntry[] = [];
  const seen = new Set<string>();
  let offset = ARTIFACT_TREE_HEADER_BYTES;
  for (let index = 0; index < count; index += 1) {
    if (offset + 8 > raw.length) throw new Error("codex-artifact-tree-frame");
    const kindValue = raw.readUInt32BE(offset);
    const pathLength = raw.readUInt32BE(offset + 4);
    offset += 8;
    if (pathLength === 0 || pathLength > 16_384 || offset + pathLength > raw.length) {
      throw new Error("codex-artifact-tree-frame");
    }
    let relativePath: string;
    try { relativePath = decoder.decode(raw.subarray(offset, offset + pathLength)); }
    catch { throw new Error("codex-artifact-tree-frame"); }
    offset += pathLength;
    if (relativePath.startsWith("/") || relativePath.includes("\0")
      || relativePath.split("/").some((component) => component.length === 0 || component === "." || component === "..")
      || seen.has(relativePath)) {
      throw new Error("codex-artifact-tree-path-invalid");
    }
    const kind = ({ 1: "directory", 2: "file", 3: "symlink", 4: "special" } as const)[kindValue as 1 | 2 | 3 | 4];
    if (kind === undefined) throw new Error("codex-artifact-tree-frame");
    seen.add(relativePath);
    result.push({ kind, relativePath });
  }
  if (offset !== raw.length) throw new Error("codex-artifact-tree-frame");
  return result;
}

function sameEntry(expected: CodexArtifactEntry, actual: CodexArtifactReadback): boolean {
  if (expected.kind !== actual.kind || expected.mode !== actual.mode) return false;
  if (expected.kind === "symlink") return expected.linkTarget === actual.linkTarget && actual.bytes.length === 0;
  return expected.linkTarget === null && actual.linkTarget === null
    && expected.byteLength === actual.bytes.length
    && expected.sha256 === createHash("sha256").update(actual.bytes).digest("hex");
}

function artifactReadbackMismatch(): Error {
  return new Error("codex-artifact-readback-mismatch");
}

const stagingLocks = new Map<string, Promise<void>>();

async function withStagingLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = stagingLocks.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  const tail = previous.then(() => current);
  stagingLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (stagingLocks.get(key) === tail) stagingLocks.delete(key);
  }
}

function expectedArtifactTree(entries: readonly CodexArtifactEntry[]): ReadonlyMap<string, CodexArtifactTreeEntry["kind"]> {
  const expected = new Map<string, CodexArtifactTreeEntry["kind"]>();
  for (const entry of entries) {
    const components = entry.relativePath.split("/");
    for (let index = 1; index < components.length; index += 1) {
      const directory = components.slice(0, index).join("/");
      const existing = expected.get(directory);
      if (existing !== undefined && existing !== "directory") throw artifactReadbackMismatch();
      expected.set(directory, "directory");
    }
    const kind = entry.kind === "file" ? "file" : "symlink";
    if (expected.has(entry.relativePath)) throw artifactReadbackMismatch();
    expected.set(entry.relativePath, kind);
  }
  return expected;
}

function exactArtifactTree(
  actual: readonly CodexArtifactTreeEntry[],
  expected: ReadonlyMap<string, CodexArtifactTreeEntry["kind"]>
): boolean {
  if (actual.length !== expected.size) return false;
  return actual.every((entry) => expected.get(entry.relativePath) === entry.kind);
}

export function createCodexArtifactStager(options: CodexArtifactStagerOptions): CodexArtifactStager {
  const scheduleTimeout = options.scheduleTimeout ?? scheduleRealTimeout;

  async function assertManagedRuntime(containerId: string, launchArtifact: CodexLaunchArtifact): Promise<void> {
    const container = await options.docker.inspectContainer(containerId).catch(() => null);
    if (container === null || container.Id !== containerId || container.State.Running !== true
      || container.Image !== launchArtifact.managedImageId || container.Config.User !== launchArtifact.probeRuntime.containerUser) {
      throw new Error("codex-launch-runtime-mismatch");
    }
    const image = await options.docker.inspectImage(container.Image).catch(() => null);
    if (image === null || image.Id !== launchArtifact.managedImageId
      || image.Os !== launchArtifact.probeRuntime.operatingSystem
      || normalizeArchitecture(image.Architecture) !== normalizeArchitecture(launchArtifact.probeRuntime.architecture)) {
      throw new Error("codex-launch-runtime-mismatch");
    }
  }

  async function upload(
    containerId: string,
    targetPath: string,
    bytes: Buffer,
    mode: number,
    timeoutMs = EXEC_TIMEOUT_MS
  ): Promise<void> {
    const targetDirectory = path.posix.dirname(targetPath);
    const execId = await options.docker.createExec(containerId, {
      command: ["sh", "-c", 'set -eu; umask 077; mkdir -p -- "$DEVSPACE_TARGET_DIR"; set -C; cat > "$DEVSPACE_TARGET_PATH"; chmod "$DEVSPACE_TARGET_MODE" "$DEVSPACE_TARGET_PATH"'],
      workingDirectory: "/workspace",
      environment: { DEVSPACE_TARGET_DIR: targetDirectory, DEVSPACE_TARGET_PATH: targetPath, DEVSPACE_TARGET_MODE: mode.toString(8) },
      attachStdin: true, tty: false
    });
    const stream = await options.docker.startExecAttached(execId, false);
    stream.end(bytes);
    await waitForClose(stream, timeoutMs, scheduleTimeout);
    const inspection = await options.docker.inspectExec(execId).catch(() => null);
    if (inspection === null || inspection.Running || inspection.ExitCode !== 0) throw new Error("codex-artifact-upload-failed");
  }

  async function uploadSymlink(containerId: string, targetPath: string, linkTarget: string): Promise<void> {
    const execId = await options.docker.createExec(containerId, {
      command: ["sh", "-c", 'set -eu; umask 077; mkdir -p -- "$DEVSPACE_TARGET_DIR"; ln -s -- "$DEVSPACE_LINK_TARGET" "$DEVSPACE_TARGET_PATH"'],
      workingDirectory: "/workspace",
      environment: { DEVSPACE_TARGET_DIR: path.posix.dirname(targetPath), DEVSPACE_TARGET_PATH: targetPath, DEVSPACE_LINK_TARGET: linkTarget },
      attachStdin: false, tty: false
    });
    const stream = await options.docker.startExecAttached(execId, false);
    await waitForClose(stream, EXEC_TIMEOUT_MS, scheduleTimeout);
    const inspection = await options.docker.inspectExec(execId).catch(() => null);
    if (inspection === null || inspection.Running || inspection.ExitCode !== 0) throw new Error("codex-artifact-upload-failed");
  }

  async function readbackEntry(input: {
    readonly containerId: string;
    readonly artifactRoot: string;
    readonly entry: CodexArtifactEntry;
    readonly readbackPath: string;
  }): Promise<CodexArtifactReadback> {
    const timeoutMs = codexArtifactTransferTimeoutMs(input.entry.kind === "file" ? input.entry.byteLength : 0);
    const timedInput = { ...input, timeoutMs };
    if (options.readbackEntry !== undefined) return await options.readbackEntry(timedInput);
    const targetPath = entryPath(input.artifactRoot, input.entry);
    const execId = await options.docker.createExec(input.containerId, {
      command: [input.readbackPath], workingDirectory: "/workspace",
      environment: { DEVSPACE_ARTIFACT_ROOT: input.artifactRoot, DEVSPACE_ARTIFACT_TARGET: targetPath }, attachStdin: false, tty: false
    });
    const stream = await options.docker.startExecAttached(execId, false);
    const output = await collectOutput(stream, MAX_READBACK_BYTES + 16 * 1024, timeoutMs, scheduleTimeout);
    const inspection = await options.docker.inspectExec(execId).catch(() => null);
    if (inspection === null || inspection.Running || inspection.ExitCode !== 0) throw new Error("codex-artifact-readback-failed");
    return parseCodexArtifactReadback(decodeDockerFrames(output));
  }

  async function listArtifactTree(input: {
    readonly containerId: string;
    readonly artifactRoot: string;
    readonly readbackPath: string;
  }): Promise<readonly CodexArtifactTreeEntry[] | null> {
    if (options.listArtifactTree !== undefined) return await options.listArtifactTree(input);
    const execId = await options.docker.createExec(input.containerId, {
      command: [input.readbackPath], workingDirectory: "/workspace",
      environment: { DEVSPACE_ARTIFACT_ROOT: input.artifactRoot, DEVSPACE_ARTIFACT_MODE: "tree" },
      attachStdin: false, tty: false
    });
    const stream = await options.docker.startExecAttached(execId, false);
    const output = await collectOutput(stream, MAX_TREE_READBACK_BYTES, EXEC_TIMEOUT_MS, scheduleTimeout);
    const inspection = await options.docker.inspectExec(execId).catch(() => null);
    if (inspection === null || inspection.Running || inspection.ExitCode !== 0) {
      throw new Error("codex-artifact-tree-verification-unproven");
    }
    return parseCodexArtifactTree(decodeDockerFrames(output));
  }

  async function removeRemote(containerId: string, root: string): Promise<{ readonly elapsedMs: number; readonly error?: unknown }> {
    const startedAt = performance.now();
    try {
      const execId = await options.docker.createExec(containerId, {
        command: ["sh", "-c", 'rm -rf -- "$DEVSPACE_TARGET_DIR"'], workingDirectory: "/workspace",
        environment: { DEVSPACE_TARGET_DIR: root }, attachStdin: false, tty: false
      });
      const stream = await options.docker.startExecAttached(execId, false);
      await waitForClose(stream, CLEANUP_TIMEOUT_MS, scheduleTimeout);
      const inspection = await options.docker.inspectExec(execId).catch(() => null);
      if (inspection === null || inspection.Running || inspection.ExitCode !== 0) {
        return { elapsedMs: performance.now() - startedAt, error: new Error("codex-artifact-cleanup-unproven") };
      }
      return { elapsedMs: performance.now() - startedAt };
    } catch (error) {
      return { elapsedMs: performance.now() - startedAt, error };
    }
  }

  async function publishRemote(input: {
    readonly containerId: string;
    readonly stagingRoot: string;
    readonly destinationRoot: string;
    readonly backupRoot: string;
  }): Promise<void> {
    const script = [
      "set -eu",
      'if [ -e "$DEVSPACE_CACHE_DEST" ] || [ -L "$DEVSPACE_CACHE_DEST" ]; then mv -T -- "$DEVSPACE_CACHE_DEST" "$DEVSPACE_CACHE_BACKUP"; fi',
      'if ! mv -T -- "$DEVSPACE_CACHE_STAGE" "$DEVSPACE_CACHE_DEST"; then',
      '  if [ -e "$DEVSPACE_CACHE_BACKUP" ] || [ -L "$DEVSPACE_CACHE_BACKUP" ]; then mv -T -- "$DEVSPACE_CACHE_BACKUP" "$DEVSPACE_CACHE_DEST"; fi',
      "  exit 1",
      "fi",
      'if [ -e "$DEVSPACE_CACHE_BACKUP" ] || [ -L "$DEVSPACE_CACHE_BACKUP" ]; then rm -rf -- "$DEVSPACE_CACHE_BACKUP"; fi'
    ].join("\n");
    const execId = await options.docker.createExec(input.containerId, {
      command: ["sh", "-c", script], workingDirectory: "/workspace",
      environment: {
        DEVSPACE_CACHE_STAGE: input.stagingRoot,
        DEVSPACE_CACHE_DEST: input.destinationRoot,
        DEVSPACE_CACHE_BACKUP: input.backupRoot
      }, attachStdin: false, tty: false
    });
    const stream = await options.docker.startExecAttached(execId, false);
    await waitForClose(stream, EXEC_TIMEOUT_MS, scheduleTimeout);
    const inspection = await options.docker.inspectExec(execId).catch(() => null);
    if (inspection === null || inspection.Running || inspection.ExitCode !== 0) {
      throw new Error("codex-artifact-cache-publication-unproven");
    }
  }

  function reportFailure(diagnostic: CodexArtifactStagingDiagnostic): void {
    try { options.onFailure?.(diagnostic); }
    catch { /* private diagnostics must not change the staging outcome */ }
  }

  function reportTiming(input: {
    readonly phase: CodexArtifactStagingPhase;
    readonly containerId: string;
    readonly artifactLayout: StagedCodexExecutionArtifact["artifact"]["layout"];
    readonly startedAt: number;
    readonly outcome: "success" | "failure";
    readonly cacheState?: "hit" | "miss" | "repaired";
    readonly entryRelative?: string;
  }): void {
    try {
      options.onTiming?.(codexArtifactStagingTiming({
        phase: input.phase, containerId: input.containerId, artifactLayout: input.artifactLayout,
        elapsedMs: performance.now() - input.startedAt, outcome: input.outcome,
        ...(input.cacheState === undefined ? {} : { cacheState: input.cacheState }),
        ...(input.entryRelative === undefined ? {} : { entryRelative: input.entryRelative })
      }));
    } catch { /* private timings must not change the staging outcome */ }
  }

  return {
    async stageIntoRunningContainer(input: {
      containerId: string;
      staged: StagedCodexExecutionArtifact;
      destinationRoot: string;
    }) {
      const closureDigest = input.staged.artifact.closureDigest;
      if (!/^[a-f0-9]{64}$/u.test(closureDigest)
        || input.destinationRoot !== `/opt/devspace/codex-artifact/${closureDigest}`) {
        throw new Error("codex-artifact-path-invalid");
      }
      const artifactLayout = input.staged.artifact.layout;
      let phase: CodexArtifactStagingPhase = "staged-artifact-verification";
      let phaseStartedAt = performance.now();
      let entryRelative: string | undefined;
      let cacheState: "hit" | "miss" | "repaired" | undefined;
      const setPhase = (nextPhase: CodexArtifactStagingPhase, nextEntry?: string) => {
        phase = nextPhase;
        phaseStartedAt = performance.now();
        entryRelative = nextEntry;
      };
      try {
        await verifyStagedCodexExecutionArtifact(input.staged);
        reportTiming({ phase, containerId: input.containerId, artifactLayout, startedAt: phaseStartedAt, outcome: "success" });
      } catch (error) {
        reportTiming({ phase, containerId: input.containerId, artifactLayout, startedAt: phaseStartedAt, outcome: "failure" });
        reportFailure(codexArtifactStagingDiagnostic({
          phase, error, containerId: input.containerId, artifactLayout, elapsedMs: performance.now() - phaseStartedAt
        }));
        throw error;
      }
      return await withStagingLock(`${input.containerId}:${closureDigest}`, async () => {
        const attemptId = safeId(options.createId());
        const stagingRoot = `/opt/devspace/codex-artifact/.stage-${closureDigest}-${attemptId}`;
        const backupRoot = `/opt/devspace/codex-artifact/.previous-${closureDigest}-${attemptId}`;
        const helperRoot = `${PRIVATE_CONTAINER_ROOT}/codex-artifact-${safeId(input.containerId).slice(0, 24)}-${closureDigest.slice(0, 12)}-${attemptId}`;
        const artifactReadbackPath = `${helperRoot}/codex-artifact-readback`;
        const expectedTree = expectedArtifactTree(input.staged.artifact.entries.map((entry) => ({
          ...entry, relativePath: `artifact/${entry.relativePath}`
        })));
        let stagingRootOwned = false;
        let helperRootMayExist = false;
        let operationError: unknown;
        let failurePhase: CodexArtifactStagingPhase | undefined;
        let failureEntry: string | undefined;
        let failureElapsedMs: number | undefined;
        let resultPath: string | undefined;
        let cleanupElapsedMs = 0;

        const verifyCache = async (cacheRoot: string): Promise<"absent" | "exact" | "mismatch"> => {
          const tree = await listArtifactTree({
            containerId: input.containerId, artifactRoot: cacheRoot, readbackPath: artifactReadbackPath
          });
          if (tree === null) return "absent";
          if (!exactArtifactTree(tree, expectedTree)) return "mismatch";

          const actualEntries: CodexArtifactEntry[] = [];
          for (const entry of input.staged.artifact.entries) {
            const readStartedAt = performance.now();
            const actual = await readbackEntry({
              containerId: input.containerId, artifactRoot: `${cacheRoot}/artifact`, entry,
              readbackPath: artifactReadbackPath
            });
            reportTiming({ phase: "artifact-entry-readback", containerId: input.containerId, artifactLayout,
              startedAt: readStartedAt, outcome: "success", entryRelative: entry.relativePath });
            if (!sameEntry(entry, actual)) return "mismatch";
            actualEntries.push({
              relativePath: entry.relativePath, kind: actual.kind, mode: actual.mode,
              linkTarget: actual.linkTarget, byteLength: actual.kind === "file" ? actual.bytes.length : 0,
              sha256: actual.kind === "file" ? createHash("sha256").update(actual.bytes).digest("hex") : null
            });
          }
          const finalStartedAt = performance.now();
          const observedDigest = codexExecutionArtifactClosureDigest({
            layout: input.staged.artifact.layout, target: input.staged.artifact.target,
            packageVersion: input.staged.artifact.packageVersion, entries: actualEntries
          });
          reportTiming({ phase: "final-closure-verification", containerId: input.containerId, artifactLayout,
            startedAt: finalStartedAt, outcome: observedDigest === closureDigest ? "success" : "failure" });
          return observedDigest === closureDigest ? "exact" : "mismatch";
        };

        try {
          setPhase("readback-helper-upload");
          const helperStartedAt = phaseStartedAt;
          helperRootMayExist = true;
          await upload(input.containerId, artifactReadbackPath, Buffer.from(options.readbackHelperBytes), 0o700);
          reportTiming({ phase, containerId: input.containerId, artifactLayout, startedAt: helperStartedAt, outcome: "success" });

          setPhase("artifact-cache-verification");
          const cacheStartedAt = phaseStartedAt;
          const cacheResult = await verifyCache(input.destinationRoot);
          cacheState = cacheResult === "exact" ? "hit" : cacheResult === "mismatch" ? "repaired" : "miss";
          reportTiming({ phase, containerId: input.containerId, artifactLayout, startedAt: cacheStartedAt,
            outcome: "success", cacheState });
          if (cacheResult === "exact") {
            resultPath = entryPath(`${input.destinationRoot}/artifact`, input.staged.artifact.entrypoint);
          } else {
            const actualEntries: CodexArtifactEntry[] = [];
            const stagedArtifactRoot = `${stagingRoot}/artifact`;
            stagingRootOwned = true;
            for (const entry of input.staged.artifact.entries) {
              const targetPath = entryPath(stagedArtifactRoot, entry);
              setPhase("artifact-entry-upload", entry.relativePath);
              const uploadStartedAt = phaseStartedAt;
              if (entry.kind === "symlink") await uploadSymlink(input.containerId, targetPath, entry.linkTarget!);
              else {
                const read = await readRegularFileNoFollow(path.join(input.staged.stagingRoot, ...entry.relativePath.split("/")), MAX_ENTRY_BYTES);
                if (read.bytes.length !== entry.byteLength || createHash("sha256").update(read.bytes).digest("hex") !== entry.sha256) {
                  throw artifactReadbackMismatch();
                }
                await upload(input.containerId, targetPath, read.bytes, entry.mode,
                  codexArtifactTransferTimeoutMs(read.bytes.length));
              }
              reportTiming({ phase, containerId: input.containerId, artifactLayout, startedAt: uploadStartedAt,
                outcome: "success", cacheState, entryRelative: entry.relativePath });

              setPhase("artifact-entry-readback", entry.relativePath);
              const readbackStartedAt = phaseStartedAt;
              const actual = await readbackEntry({
                containerId: input.containerId, artifactRoot: stagedArtifactRoot, entry,
                readbackPath: artifactReadbackPath
              });
              if (!sameEntry(entry, actual)) throw artifactReadbackMismatch();
              reportTiming({ phase, containerId: input.containerId, artifactLayout, startedAt: readbackStartedAt,
                outcome: "success", cacheState, entryRelative: entry.relativePath });
              actualEntries.push({
                relativePath: entry.relativePath, kind: actual.kind, mode: actual.mode,
                linkTarget: actual.linkTarget, byteLength: actual.kind === "file" ? actual.bytes.length : 0,
                sha256: actual.kind === "file" ? createHash("sha256").update(actual.bytes).digest("hex") : null
              });
            }

            setPhase("final-closure-verification");
            const finalStartedAt = phaseStartedAt;
            const tree = await listArtifactTree({
              containerId: input.containerId, artifactRoot: stagingRoot, readbackPath: artifactReadbackPath
            });
            const observedDigest = codexExecutionArtifactClosureDigest({
              layout: input.staged.artifact.layout, target: input.staged.artifact.target,
              packageVersion: input.staged.artifact.packageVersion, entries: actualEntries
            });
            if (tree === null || !exactArtifactTree(tree, expectedTree) || observedDigest !== closureDigest) {
              throw artifactReadbackMismatch();
            }
            reportTiming({ phase, containerId: input.containerId, artifactLayout, startedAt: finalStartedAt,
              outcome: "success", cacheState });

            setPhase("artifact-cache-replacement");
            const publishStartedAt = phaseStartedAt;
            await publishRemote({
              containerId: input.containerId, stagingRoot, destinationRoot: input.destinationRoot, backupRoot
            });
            stagingRootOwned = false;
            resultPath = entryPath(`${input.destinationRoot}/artifact`, input.staged.artifact.entrypoint);
            reportTiming({ phase, containerId: input.containerId, artifactLayout, startedAt: publishStartedAt,
              outcome: "success", cacheState });
          }
        } catch (error) {
          operationError = error;
          failurePhase = phase;
          failureEntry = entryRelative;
          failureElapsedMs = performance.now() - phaseStartedAt;
          reportTiming({ phase, containerId: input.containerId, artifactLayout, startedAt: phaseStartedAt,
            outcome: "failure", ...(cacheState === undefined ? {} : { cacheState }),
            ...(entryRelative === undefined ? {} : { entryRelative }) });
        }

        if (stagingRootOwned) {
          setPhase("failure-cleanup");
          const cleanupStartedAt = phaseStartedAt;
          const cleanup = await removeRemote(input.containerId, stagingRoot);
          cleanupElapsedMs += cleanup.elapsedMs;
          reportTiming({ phase, containerId: input.containerId, artifactLayout, startedAt: cleanupStartedAt,
            outcome: cleanup.error === undefined ? "success" : "failure", ...(cacheState === undefined ? {} : { cacheState }) });
          if (cleanup.error !== undefined && operationError === undefined) operationError = cleanup.error;
          if (cleanup.error !== undefined) {
            if (failurePhase === undefined) {
              failurePhase = phase;
              failureElapsedMs = cleanup.elapsedMs;
            }
            reportFailure(codexArtifactStagingDiagnostic({
              phase, error: cleanup.error, containerId: input.containerId, artifactLayout, elapsedMs: cleanup.elapsedMs
            }));
          }
        }
        if (helperRootMayExist) {
          setPhase("artifact-cache-helper-cleanup");
          const cleanupStartedAt = phaseStartedAt;
          const cleanup = await removeRemote(input.containerId, helperRoot);
          cleanupElapsedMs += cleanup.elapsedMs;
          reportTiming({ phase, containerId: input.containerId, artifactLayout, startedAt: cleanupStartedAt,
            outcome: cleanup.error === undefined ? "success" : "failure", ...(cacheState === undefined ? {} : { cacheState }) });
          if (cleanup.error !== undefined && operationError === undefined) operationError = cleanup.error;
          if (cleanup.error !== undefined) {
            if (failurePhase === undefined) {
              failurePhase = phase;
              failureElapsedMs = cleanup.elapsedMs;
            }
            reportFailure(codexArtifactStagingDiagnostic({
              phase, error: cleanup.error, containerId: input.containerId, artifactLayout, elapsedMs: cleanup.elapsedMs
            }));
          }
        }
        if (operationError !== undefined) {
          reportFailure(codexArtifactStagingDiagnostic({
            phase: failurePhase ?? phase, error: operationError, containerId: input.containerId, artifactLayout,
            ...(failureEntry === undefined ? {} : { entryRelative: failureEntry }),
            elapsedMs: failureElapsedMs ?? performance.now() - phaseStartedAt,
            ...(cleanupElapsedMs === 0 ? {} : { cleanupElapsedMs })
          }));
          throw operationError instanceof Error ? operationError : new Error("codex-artifact-staging-failed");
        }
        if (resultPath === undefined) throw new Error("codex-artifact-cache-result-unavailable");
        return { entrypointPath: resultPath };
      });
    },
    async stageIntoManagedProvider(input) {
      const { launchArtifact } = input;
      await assertManagedRuntime(input.containerId, launchArtifact);
      await verifyStagedCodexExecutionArtifact(launchArtifact.staged);
      const containerRoot = `${PRIVATE_CONTAINER_ROOT}/${safeId(input.sessionId)}-${input.processGeneration}-${safeId(options.createId())}`;
      const artifactRoot = `${containerRoot}/artifact`;
      const artifactReadbackPath = `${containerRoot}/codex-artifact-readback`;
      try {
        await upload(input.containerId, artifactReadbackPath, Buffer.from(options.readbackHelperBytes), 0o700);
        const actualEntries: CodexArtifactEntry[] = [];
        for (const entry of launchArtifact.staged.artifact.entries) {
          const targetPath = entryPath(artifactRoot, entry);
          if (entry.kind === "symlink") {
            await uploadSymlink(input.containerId, targetPath, entry.linkTarget!);
          } else {
            const read = await readRegularFileNoFollow(path.join(launchArtifact.staged.stagingRoot, ...entry.relativePath.split("/")), MAX_ENTRY_BYTES);
            if (read.bytes.length !== entry.byteLength || createHash("sha256").update(read.bytes).digest("hex") !== entry.sha256) throw artifactReadbackMismatch();
            await upload(input.containerId, targetPath, read.bytes, entry.mode,
              codexArtifactTransferTimeoutMs(read.bytes.length));
          }
          const actual = await readbackEntry({ containerId: input.containerId, artifactRoot, entry, readbackPath: artifactReadbackPath });
          if (!sameEntry(entry, actual)) throw artifactReadbackMismatch();
          actualEntries.push({
            relativePath: entry.relativePath, kind: actual.kind, mode: actual.mode,
            linkTarget: actual.linkTarget, byteLength: actual.kind === "file" ? actual.bytes.length : 0,
            sha256: actual.kind === "file" ? createHash("sha256").update(actual.bytes).digest("hex") : null
          });
        }
        const closureDigest = codexExecutionArtifactClosureDigest({
          layout: launchArtifact.staged.artifact.layout, target: launchArtifact.staged.artifact.target,
          packageVersion: launchArtifact.staged.artifact.packageVersion, entries: actualEntries
        });
        if (closureDigest !== launchArtifact.staged.artifact.closureDigest) throw artifactReadbackMismatch();
        return {
          containerRoot,
          entrypointPath: entryPath(artifactRoot, launchArtifact.staged.artifact.entrypoint),
          artifactReadbackPath
        };
      } catch (error) {
        const cleanup = await removeRemote(input.containerId, containerRoot);
        if (cleanup.error !== undefined) {
          reportFailure(codexArtifactStagingDiagnostic({
            phase: "failure-cleanup", error: cleanup.error, containerId: input.containerId,
            artifactLayout: launchArtifact.staged.artifact.layout, elapsedMs: cleanup.elapsedMs
          }));
          throw new Error("codex-artifact-cleanup-unproven", { cause: error });
        }
        throw error;
      }
    }
  };
}
