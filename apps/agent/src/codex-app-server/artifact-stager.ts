import { createHash } from "node:crypto";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { CodexProbeRuntimeIdentity } from "@devspace/contracts";
import { readRegularFileNoFollow } from "../private-state.js";
import type { DockerEngineClient } from "../docker-runtime.js";
import {
  codexExecutionArtifactClosureDigest,
  verifyStagedCodexExecutionArtifact,
  type CodexArtifactEntry,
  type StagedCodexExecutionArtifact
} from "./artifact-identity.js";

const PRIVATE_CONTAINER_ROOT = "/tmp/devspace-ai";
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_READBACK_BYTES = MAX_ENTRY_BYTES + 64;
const EXEC_TIMEOUT_MS = 10_000;
const ARTIFACT_READBACK_HEADER_BYTES = 32;
const ARTIFACT_READBACK_MAGIC = "DSARTF01";
const ARTIFACT_READBACK_VERSION = 1;

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

export interface CodexArtifactStager {
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
  /** Agent-private deterministic readback seam; production invokes the native helper. */
  readonly readbackEntry?: (input: {
    readonly containerId: string;
    readonly artifactRoot: string;
    readonly entry: CodexArtifactEntry;
    readonly readbackPath: string;
  }) => Promise<CodexArtifactReadback>;
}

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

async function waitForClose(stream: Duplex): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(new Error("codex-artifact-exec-unproven"));
    }, EXEC_TIMEOUT_MS);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

async function collectOutput(stream: Duplex): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeAllListeners("data");
      stream.removeAllListeners("close");
      stream.removeAllListeners("error");
      if (error === undefined) resolve(Buffer.concat(chunks)); else reject(error);
    };
    const timer = setTimeout(() => {
      stream.destroy();
      finish(new Error("codex-artifact-readback-timeout"));
    }, EXEC_TIMEOUT_MS);
    stream.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_READBACK_BYTES + 16 * 1024) {
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

export function createCodexArtifactStager(options: CodexArtifactStagerOptions): CodexArtifactStager {
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

  async function upload(containerId: string, targetPath: string, bytes: Buffer, mode: number): Promise<void> {
    const targetDirectory = path.posix.dirname(targetPath);
    const execId = await options.docker.createExec(containerId, {
      command: ["sh", "-c", 'umask 077; mkdir -p -- "$DEVSPACE_TARGET_DIR"; cat > "$DEVSPACE_TARGET_PATH"; chmod "$DEVSPACE_TARGET_MODE" "$DEVSPACE_TARGET_PATH"'],
      workingDirectory: "/workspace",
      environment: { DEVSPACE_TARGET_DIR: targetDirectory, DEVSPACE_TARGET_PATH: targetPath, DEVSPACE_TARGET_MODE: mode.toString(8) },
      attachStdin: true, tty: false
    });
    const stream = await options.docker.startExecAttached(execId, false);
    stream.end(bytes);
    await waitForClose(stream);
    const inspection = await options.docker.inspectExec(execId).catch(() => null);
    if (inspection === null || inspection.Running || inspection.ExitCode !== 0) throw new Error("codex-artifact-upload-failed");
  }

  async function uploadSymlink(containerId: string, targetPath: string, linkTarget: string): Promise<void> {
    const execId = await options.docker.createExec(containerId, {
      command: ["sh", "-c", 'umask 077; mkdir -p -- "$DEVSPACE_TARGET_DIR"; ln -s -- "$DEVSPACE_LINK_TARGET" "$DEVSPACE_TARGET_PATH"'],
      workingDirectory: "/workspace",
      environment: { DEVSPACE_TARGET_DIR: path.posix.dirname(targetPath), DEVSPACE_TARGET_PATH: targetPath, DEVSPACE_LINK_TARGET: linkTarget },
      attachStdin: false, tty: false
    });
    const stream = await options.docker.startExecAttached(execId, false);
    await waitForClose(stream);
    const inspection = await options.docker.inspectExec(execId).catch(() => null);
    if (inspection === null || inspection.Running || inspection.ExitCode !== 0) throw new Error("codex-artifact-upload-failed");
  }

  async function readbackEntry(input: {
    readonly containerId: string;
    readonly artifactRoot: string;
    readonly entry: CodexArtifactEntry;
    readonly readbackPath: string;
  }): Promise<CodexArtifactReadback> {
    if (options.readbackEntry !== undefined) return await options.readbackEntry(input);
    const targetPath = entryPath(input.artifactRoot, input.entry);
    const execId = await options.docker.createExec(input.containerId, {
      command: [input.readbackPath], workingDirectory: "/workspace",
      environment: { DEVSPACE_ARTIFACT_ROOT: input.artifactRoot, DEVSPACE_ARTIFACT_TARGET: targetPath }, attachStdin: false, tty: false
    });
    const stream = await options.docker.startExecAttached(execId, false);
    const output = await collectOutput(stream);
    const inspection = await options.docker.inspectExec(execId).catch(() => null);
    if (inspection === null || inspection.Running || inspection.ExitCode !== 0) throw new Error("codex-artifact-readback-failed");
    return parseCodexArtifactReadback(decodeDockerFrames(output));
  }

  async function removeRemote(containerId: string, root: string): Promise<void> {
    try {
      const execId = await options.docker.createExec(containerId, {
        command: ["sh", "-c", 'rm -rf -- "$DEVSPACE_TARGET_DIR"'], workingDirectory: "/workspace",
        environment: { DEVSPACE_TARGET_DIR: root }, attachStdin: false, tty: false
      });
      const stream = await options.docker.startExecAttached(execId, false);
      await waitForClose(stream);
    } catch { /* provider cleanup remains the final best effort */ }
  }

  return {
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
            await upload(input.containerId, targetPath, read.bytes, entry.mode);
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
        await removeRemote(input.containerId, containerRoot);
        throw error;
      }
    }
  };
}
