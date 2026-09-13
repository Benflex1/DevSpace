import { once } from "node:events";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import path from "node:path";
import { readlink } from "node:fs/promises";
import type {
  CodexProbeRuntimeIdentity
} from "@devspace/contracts";
import type { WorkspaceExecutionContext } from "../managed-workspaces.js";
import { readRegularFileNoFollow } from "../private-state.js";
import {
  DockerEngineClient,
  type DockerContainerInspection,
  type DockerImageInspection
} from "../docker-runtime.js";
import {
  verifyStagedCodexExecutionArtifact,
  type CodexArtifactEntry,
  type StagedCodexExecutionArtifact
} from "./artifact-identity.js";

const PROBE_ROOT = "/opt/devspace-codex-probe";
const PROBE_HOME = "/tmp/devspace-codex-home";
const PROBE_STATE = "/tmp/devspace-codex-state";
const PROBE_CPU_MILLICORES = 1_000;
const PROBE_MEMORY_BYTES = 2_147_483_648;
const PROBE_PID_LIMIT = 64;
const PROBE_COMMAND_TIMEOUT_MS = 30_000;
const PROBE_TOTAL_TIMEOUT_MS = 90_000;
const PROBE_OUTPUT_MAX_BYTES = 1 * 1024 * 1024;
const PROBE_SCHEMA_FILE_MAX_BYTES = 8 * 1024 * 1024;
const PROBE_SCHEMA_TOTAL_MAX_BYTES = 32 * 1024 * 1024;
const PROBE_SCHEMA_FILE_MAX_COUNT = 32;
const PROBE_ENTRY_MAX_BYTES = 512 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;
const TAR_ZERO_BLOCKS = 2;

export interface CodexProbeResult {
  readonly runtime: CodexProbeRuntimeIdentity;
  readonly versionOutput: string;
  readonly schemaFiles: ReadonlyMap<string, Uint8Array>;
}

export interface CodexProbeRuntime {
  inspect?(input: {
    readonly managedContainerId: string;
    readonly stagedArtifact: StagedCodexExecutionArtifact;
    readonly workspaceContext: WorkspaceExecutionContext;
  }): Promise<CodexProbeRuntimeIdentity>;
  probe(input: {
    readonly managedContainerId: string;
    readonly stagedArtifact: StagedCodexExecutionArtifact;
    readonly workspaceContext: WorkspaceExecutionContext;
  }): Promise<CodexProbeResult>;
}

function probeError(): Error {
  return new Error("CODEX_PROBE_RUNTIME_UNAVAILABLE");
}

function schemaError(): Error {
  return new Error("CODEX_SCHEMA_DISCOVERY_FAILED");
}

function architectureCompatible(artifactArchitecture: string, imageArchitecture: string): boolean {
  const normalize = (value: string): string => ({
    x86_64: "amd64", x64: "amd64", x86: "386", i686: "386", aarch64: "arm64", arm64: "arm64"
  }[value] ?? value);
  return normalize(artifactArchitecture) === normalize(imageArchitecture);
}

function assertManagedImage(container: DockerContainerInspection, image: DockerImageInspection, input: {
  readonly managedContainerId: string;
  readonly workspaceContext: WorkspaceExecutionContext;
}): { readonly imageId: string; readonly user: string } {
  if (input.workspaceContext.ownership.developmentContainer.id !== input.managedContainerId
    || container.Id !== input.managedContainerId || container.State.Running !== true
    || typeof container.Image !== "string" || !/^sha256:[0-9a-f]{32,}$/u.test(container.Image)
    || image.Id !== container.Image || image.Os !== "linux" || container.Config.User === undefined) {
    throw probeError();
  }
  return { imageId: container.Image, user: container.Config.User };
}

function tarString(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw probeError();
  bytes.copy(buffer, offset);
}

function tarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8);
  if (text.length > length - 1) throw probeError();
  buffer.write(text.padStart(length - 1, "0") + "\0", offset, length, "ascii");
}

function tarHeader(entry: CodexArtifactEntry): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  const components = entry.relativePath.split("/");
  const name = components.at(-1) ?? "";
  const prefix = components.slice(0, -1).join("/");
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw probeError();
  tarString(header, 0, 100, name);
  tarOctal(header, 100, 8, entry.mode);
  tarOctal(header, 108, 8, 0);
  tarOctal(header, 116, 8, 0);
  tarOctal(header, 124, 12, entry.byteLength);
  tarOctal(header, 136, 12, 0);
  header[156] = entry.kind === "symlink" ? 0x32 : 0x30;
  if (entry.linkTarget !== null) tarString(header, 157, 100, entry.linkTarget);
  tarString(header, 257, 6, "ustar\0");
  tarString(header, 263, 2, "00");
  tarString(header, 345, 155, prefix);
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

async function writeChunk(stream: Duplex, bytes: Buffer): Promise<void> {
  if (stream.write(bytes)) return;
  await once(stream, "drain");
}

function entryPath(staged: StagedCodexExecutionArtifact, entry: CodexArtifactEntry): string {
  return path.join(staged.stagingRoot, ...entry.relativePath.split("/"));
}

async function writeArtifactArchive(stream: Duplex, staged: StagedCodexExecutionArtifact): Promise<void> {
  for (const entry of staged.artifact.entries) {
    await writeChunk(stream, tarHeader(entry));
    if (entry.kind === "file") {
      const read = await readRegularFileNoFollow(entryPath(staged, entry), PROBE_ENTRY_MAX_BYTES);
      if (read.bytes.length !== entry.byteLength || sha256(read.bytes) !== entry.sha256) throw probeError();
      await writeChunk(stream, read.bytes);
      const padding = (TAR_BLOCK_BYTES - (read.bytes.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
      if (padding > 0) await writeChunk(stream, Buffer.alloc(padding));
    } else if (await readlink(entryPath(staged, entry), "utf8") !== entry.linkTarget) {
      throw probeError();
    }
  }
  await writeChunk(stream, Buffer.alloc(TAR_BLOCK_BYTES * TAR_ZERO_BLOCKS));
  stream.end();
}

async function collectRawDockerOutput(stream: Duplex, maxBytes: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      stream.removeAllListeners("data");
      stream.removeAllListeners("error");
      stream.removeAllListeners("close");
      if (error === undefined) resolve(Buffer.concat(chunks));
      else reject(error);
    };
    stream.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        stream.destroy();
        finish(probeError());
      } else chunks.push(bytes);
    });
    stream.once("error", () => finish(probeError()));
    stream.once("close", () => finish());
    stream.resume();
  });
}

function decodeDockerOutput(raw: Buffer): { readonly stdout: Buffer; readonly stderr: Buffer } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    if (offset + 8 > raw.length) throw probeError();
    const stream = raw[offset];
    const size = raw.readUInt32BE(offset + 4);
    if (offset + 8 + size > raw.length || (stream !== 1 && stream !== 2)) throw probeError();
    const payload = raw.subarray(offset + 8, offset + 8 + size);
    (stream === 1 ? stdout : stderr).push(payload);
    offset += 8 + size;
  }
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

async function runCommand(input: {
  readonly docker: DockerEngineClient;
  readonly containerId: string;
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly attachStdin: boolean;
  readonly inputWriter?: (stream: Duplex) => Promise<void>;
  readonly outputMaxBytes: number;
  readonly deadline: number;
}): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer }> {
  const execId = await input.docker.createExec(input.containerId, {
    command: input.command, workingDirectory: PROBE_ROOT, environment: input.environment,
    attachStdin: input.attachStdin, tty: false
  });
  const stream = await input.docker.startExecAttached(execId, false);
  const output = collectRawDockerOutput(stream, input.outputMaxBytes);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timed = new Promise<Buffer>((_, reject) => {
      const remaining = Math.min(PROBE_COMMAND_TIMEOUT_MS, input.deadline - Date.now());
      if (remaining <= 0) { reject(probeError()); return; }
      timeout = setTimeout(() => reject(probeError()), remaining);
    });
    const withInput = (async () => {
      if (input.inputWriter !== undefined) await input.inputWriter(stream);
      return await output;
    })();
    const raw = await Promise.race([withInput, timed]);
    const inspection = await input.docker.inspectExec(execId);
    if (inspection.Running || inspection.ExitCode !== 0) throw probeError();
    return decodeDockerOutput(raw);
  } catch (error) {
    stream.destroy();
    throw error instanceof Error && error.message.startsWith("CODEX_") ? error : probeError();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function tarNumber(buffer: Buffer, offset: number, length: number): number {
  const text = buffer.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/u, "").trim();
  if (!/^[0-7]+$/u.test(text)) throw schemaError();
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw schemaError();
  return value;
}

function tarName(header: Buffer): string {
  const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
  const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/u, "");
  return prefix.length === 0 ? name : `${prefix}/${name}`;
}

function collectSchemaFiles(raw: Buffer): ReadonlyMap<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let total = 0;
  while (offset + TAR_BLOCK_BYTES <= raw.length) {
    const header = raw.subarray(offset, offset + TAR_BLOCK_BYTES);
    offset += TAR_BLOCK_BYTES;
    if (header.every((byte) => byte === 0)) break;
    const name = tarName(header).replace(/^output\//u, "");
    const size = tarNumber(header, 124, 12);
    const type = header[156];
    const padded = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (offset + padded > raw.length || name.length > 256) throw schemaError();
    if (type === 0x35) {
      offset += padded;
      continue;
    }
    if (type !== 0x30 || !/^(?:stable|experimental)\/[A-Za-z0-9._-]+\.json$/u.test(name)
      || size > PROBE_SCHEMA_FILE_MAX_BYTES || files.has(name) || files.size >= PROBE_SCHEMA_FILE_MAX_COUNT) {
      throw schemaError();
    }
    total += size;
    if (total > PROBE_SCHEMA_TOTAL_MAX_BYTES) throw schemaError();
    files.set(name, Buffer.from(raw.subarray(offset, offset + size)));
    offset += padded;
  }
  if (offset > raw.length) throw schemaError();
  return files;
}

function probeEnvironment(): Readonly<Record<string, string>> {
  return { CODEX_HOME: PROBE_HOME, HOME: PROBE_HOME, TMPDIR: PROBE_STATE };
}

const expectedProbeTmpfs = Object.freeze({
  [PROBE_ROOT]: "rw,nosuid,nodev,size=1g",
  [PROBE_HOME]: "rw,nosuid,nodev,noexec,size=16m",
  [PROBE_STATE]: "rw,nosuid,nodev,noexec,size=16m"
});

function verifyProbeContainer(container: DockerContainerInspection, image: DockerImageInspection, user: string): void {
  const host = container.HostConfig;
  const networks = container.NetworkSettings.Networks ?? {};
  if (container.Config.WorkingDir !== "/"
    || JSON.stringify(container.Config.Entrypoint) !== JSON.stringify(["/bin/sh", "-c"])
    || JSON.stringify(container.Config.Cmd) !== JSON.stringify(["exec sleep 2147483647"])
    || container.Config.User !== user
    || host.NetworkMode !== "none" || host.Privileged !== false || host.ReadonlyRootfs !== true
    || host.PublishAllPorts !== false || host.PidsLimit !== 64 || host.NanoCpus !== 1_000_000_000
    || host.Memory !== 2_147_483_648 || host.MemorySwap !== 2_147_483_648
    || host.AutoRemove !== false || host.Devices === null || host.Devices.length !== 0
    || host.CapAdd === null || host.CapAdd.length !== 0 || JSON.stringify(host.CapDrop) !== JSON.stringify(["ALL"])
    || JSON.stringify(host.SecurityOpt) !== JSON.stringify(["no-new-privileges:true"])
    || (host.Binds ?? []).length !== 0 || (host.Mounts ?? []).length !== 0
    || JSON.stringify(host.Tmpfs) !== JSON.stringify(expectedProbeTmpfs)
    || container.Mounts.length !== 0 || Object.keys(networks).length !== 0
    || Object.keys(host.PortBindings ?? {}).length !== 0) {
    throw probeError();
  }
  if (image.Config.Entrypoint !== undefined && JSON.stringify(image.Config.Entrypoint) === JSON.stringify(container.Config.Entrypoint)) {
    throw probeError();
  }
  if (image.Config.Cmd !== undefined && JSON.stringify(image.Config.Cmd) === JSON.stringify(container.Config.Cmd)) {
    throw probeError();
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifyRemoteArtifact(docker: DockerEngineClient, containerId: string, staged: StagedCodexExecutionArtifact, deadline: number): Promise<void> {
  const fileEntries = staged.artifact.entries.filter((entry) => entry.kind === "file");
  for (let index = 0; index < fileEntries.length; index += 64) {
    const batch = fileEntries.slice(index, index + 64);
    const output = await runCommand({
      docker, containerId, command: ["sha256sum", "--", ...batch.map((entry) => `${PROBE_ROOT}/${entry.relativePath}`)],
      environment: probeEnvironment(), attachStdin: false, outputMaxBytes: PROBE_OUTPUT_MAX_BYTES, deadline
    });
    const lines = output.stdout.toString("utf8").trim().split("\n").filter((line) => line.length > 0);
    if (lines.length !== batch.length) throw probeError();
    for (const [lineIndex, line] of lines.entries()) {
      const match = /^(?<digest>[0-9a-f]{64})\s+(?<file>.+)$/u.exec(line);
      const expected = batch[lineIndex];
      if (match === null || match.groups === undefined || expected === undefined
        || match.groups.digest !== expected.sha256 || match.groups.file !== `${PROBE_ROOT}/${expected.relativePath}`) {
        throw probeError();
      }
    }
  }
  for (const entry of staged.artifact.entries.filter((candidate) => candidate.kind === "symlink")) {
    const output = await runCommand({
      docker, containerId, command: ["readlink", "--", `${PROBE_ROOT}/${entry.relativePath}`],
      environment: probeEnvironment(), attachStdin: false, outputMaxBytes: PROBE_OUTPUT_MAX_BYTES, deadline
    });
    if (output.stdout.toString("utf8").trimEnd() !== entry.linkTarget) throw probeError();
  }
}

class DockerCodexProbeRuntime implements CodexProbeRuntime {
  constructor(private readonly docker: DockerEngineClient, private readonly createId: () => string) {}

  private async inspectEvidence(input: {
    readonly managedContainerId: string;
    readonly stagedArtifact: StagedCodexExecutionArtifact;
    readonly workspaceContext: WorkspaceExecutionContext;
  }): Promise<{ readonly runtime: CodexProbeRuntimeIdentity; readonly image: DockerImageInspection; readonly user: string }> {
    const managed = await this.docker.inspectContainer(input.managedContainerId);
    if (managed.Image === undefined) throw probeError();
    const image = await this.docker.inspectImage(managed.Image);
    const authority = assertManagedImage(managed, image, input);
    if (!architectureCompatible(input.stagedArtifact.artifact.target.architecture, image.Architecture)) throw probeError();
    return {
      runtime: { imageId: authority.imageId, operatingSystem: image.Os, architecture: image.Architecture,
        containerUser: authority.user, policyVersion: "codex-probe-runtime-v1" }, image, user: authority.user
    };
  }

  async inspect(input: {
    readonly managedContainerId: string;
    readonly stagedArtifact: StagedCodexExecutionArtifact;
    readonly workspaceContext: WorkspaceExecutionContext;
  }): Promise<CodexProbeRuntimeIdentity> {
    await verifyStagedCodexExecutionArtifact(input.stagedArtifact);
    return (await this.inspectEvidence(input)).runtime;
  }

  async probe(input: {
    readonly managedContainerId: string;
    readonly stagedArtifact: StagedCodexExecutionArtifact;
    readonly workspaceContext: WorkspaceExecutionContext;
  }): Promise<CodexProbeResult> {
    await verifyStagedCodexExecutionArtifact(input.stagedArtifact);
    const evidence = await this.inspectEvidence(input);
    const runtime = evidence.runtime;
    const image = evidence.image;
    const authority = { imageId: runtime.imageId, user: evidence.user };
    const probeName = `devspace-codex-probe-${this.createId().replaceAll("-", "")}`;
    let containerId: string | null = null;
    let result: CodexProbeResult | null = null;
    let primaryError: Error | null = null;
    const deadline = Date.now() + PROBE_TOTAL_TIMEOUT_MS;
    try {
      containerId = await this.docker.createProbeContainer(probeName, {
        imageId: authority.imageId,
        user: authority.user,
        labels: { "devspace.managed": "true", "devspace.resource-role": "codex-compatibility-probe" },
        environment: probeEnvironment(),
        cpuMillicores: PROBE_CPU_MILLICORES, memoryBytes: PROBE_MEMORY_BYTES, pidLimit: PROBE_PID_LIMIT
      });
      const createdProbe = await this.docker.inspectContainer(containerId);
      verifyProbeContainer(createdProbe, image, authority.user);
      await this.docker.startContainer(containerId);
      await runCommand({
        docker: this.docker, containerId, command: ["/bin/sh", "-c", "tar -xpf - -C /opt/devspace-codex-probe"],
        environment: {}, attachStdin: true,
        inputWriter: async (stream) => await writeArtifactArchive(stream, input.stagedArtifact), outputMaxBytes: PROBE_OUTPUT_MAX_BYTES, deadline
      });
      await verifyRemoteArtifact(this.docker, containerId, input.stagedArtifact, deadline);
      const version = await runCommand({
        docker: this.docker, containerId, command: [
          `${PROBE_ROOT}/${input.stagedArtifact.artifact.entrypoint.relativePath}`, "--version"
        ], environment: probeEnvironment(), attachStdin: false, outputMaxBytes: PROBE_OUTPUT_MAX_BYTES, deadline
      });
      const versionOutput = new TextDecoder("utf-8", { fatal: true }).decode(version.stdout).trim();
      if (versionOutput.length === 0 || versionOutput.length > 256) throw probeError();
      for (const surface of ["stable", "experimental"] as const) {
        const command = [
          `${PROBE_ROOT}/${input.stagedArtifact.artifact.entrypoint.relativePath}`, "app-server", "generate-json-schema",
          ...(surface === "experimental" ? ["--experimental"] : []), "--out", `${PROBE_ROOT}/output/${surface}`
        ];
        await runCommand({ docker: this.docker, containerId, command, environment: probeEnvironment(), attachStdin: false, outputMaxBytes: PROBE_OUTPUT_MAX_BYTES, deadline });
      }
      const archive = await runCommand({
        docker: this.docker, containerId,
        command: ["/bin/sh", "-c", "tar -cf - -C /opt/devspace-codex-probe output"],
        environment: probeEnvironment(), attachStdin: false, outputMaxBytes: PROBE_SCHEMA_TOTAL_MAX_BYTES + 64 * 1024, deadline
      });
      result = { runtime, versionOutput, schemaFiles: collectSchemaFiles(archive.stdout) };
    } catch (error) {
      primaryError = error instanceof Error && error.message.startsWith("CODEX_") ? error : probeError();
    } finally {
      if (containerId !== null) {
        let cleanupFailed = false;
        try { await this.docker.stopContainer(containerId); } catch { cleanupFailed = true; }
        try { await this.docker.removeContainer(containerId); } catch { cleanupFailed = true; }
        if (cleanupFailed) primaryError = probeError();
      }
    }
    if (primaryError !== null) throw primaryError;
    if (result === null) throw probeError();
    return result;
  }
}

export function createCodexProbeRuntime(input: { readonly docker: DockerEngineClient; readonly createId: () => string }): CodexProbeRuntime {
  return new DockerCodexProbeRuntime(input.docker, input.createId);
}
