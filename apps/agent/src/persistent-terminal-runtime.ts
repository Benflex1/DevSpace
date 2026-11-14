import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough, type Duplex, type Readable } from "node:stream";
import * as tar from "tar-stream";
import { DockerEngineClient, type DockerContainerInspection } from "./docker-runtime.js";

export const PERSISTENT_TERMINALS_PER_WORKSPACE_LIMIT = 8 as const;
export const PERSISTENT_TERMINAL_BACKEND_VERSION = 1 as const;
export const PERSISTENT_TMUX_VERSION = "3.7c" as const;
export const PERSISTENT_TMUX_HISTORY_LIMIT = 2_000 as const;
export const PERSISTENT_TMUX_INITIAL_COLUMNS = 80 as const;
export const PERSISTENT_TMUX_INITIAL_ROWS = 24 as const;
export const PERSISTENT_TMUX_MAX_COLUMNS = 240 as const;
export const PERSISTENT_TMUX_MAX_ROWS = 100 as const;
export const PERSISTENT_TMUX_OUTPUT_LIMIT_BYTES = 256 * 1024;
export const PERSISTENT_TMUX_BACKPRESSURE_BYTES = 256 * 1024;
const TMUX_CLIENT_RESOLUTION_TIMEOUT_MS = 5_000;
const TMUX_CLIENT_POLL_INTERVAL_MS = 50;

const TMUX_ARCHIVE_ROOT = "devspace-persistent-tmux-3.7c";
const TMUX_ASSET_ROOT = fileURLToPath(new URL("../assets/", import.meta.url));
const TMUX_BINARY_SHA256 = "7d0f1e85c5b11df7fe127ab90674c6a15663ad72a25fcf7fabadba6bbb0b29d5";
const XTERM_TERMINFO_SHA256 = "7f27e57e318f32605466c781de06fba0ff27f212667140cde50ff65498123f84";
const TMUX_TERMINFO_SHA256 = "b6b2e5fc2649b8248ff40572217a379a6228f20e90b4bac05521c80a7cdfbc9b";
const TMUX_CONFIG_SHA256 = "9446e0d17994f95dce01b42ef13344e81b494969b0f7830d418f8945f7d10513";
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_CONTAINER_COMMAND_TIMEOUT_MS = 30_000;
const TMUX_PANE_FORMAT = [
  "#{session_name}", "#{session_id}", "#{pane_id}", "#{pane_pid}", "#{pane_dead}",
  "#{pane_dead_status}", "#{window_panes}", "#{session_windows}"
].join("|");

export type PersistentTerminalOwnership = {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly terminalId: string;
  readonly processId: string;
  readonly containerId: string;
  readonly generation: number;
  readonly revisionId: string;
  readonly revisionHash: string;
  readonly runtimePlanHash: string;
  readonly harnessSessionId?: string;
  readonly harnessGeneration?: number;
  readonly harnessLeaseId?: string | null;
};

export type PersistentTerminalLaunch = {
  readonly command: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
};

export type TmuxPaneObservation = {
  readonly sessionName: string;
  readonly sessionId: string;
  readonly paneId: string;
  readonly panePid: number;
  readonly paneDead: boolean;
  readonly paneDeadStatus: number | null;
};

export type PersistentTmuxBinding = {
  readonly containerId: string;
  readonly uid: number;
  readonly gid: number;
  readonly artifactRoot: string;
  readonly binaryPath: string;
  readonly configPath: string;
  readonly terminfoPath: string;
  readonly socketDirectory: string;
  readonly socketPath: string;
  readonly environment: Readonly<Record<string, string>>;
};

export type PersistentTmuxCommandResult = {
  readonly execId: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export class PersistentTmuxIdentityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistentTmuxIdentityMismatchError";
  }
}

export type PersistentTmuxAttachment = {
  readonly execId: string;
  readonly clientPid: number;
  readonly clientName: string;
  readonly stream: Duplex;
};

type PersistentTmuxClientIdentity = {
  readonly clientPid: number;
  readonly clientName: string;
};

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Accept tmux's secure owner-only mode alongside the legacy rw-owner socket
 * modes. Group bits remain supported for compatibility, but other-user access
 * and every mode outside the previously accepted set stay forbidden.
 */
function isOwnedSecurePersistentTmuxSocketMetadata(
  metadata: string,
  uid: number,
  gid: number
): boolean {
  const fields = metadata.trim().split(" ");
  if (fields.length !== 3 || fields[0] !== "socket" || fields[2] !== `${uid}:${gid}`) return false;
  return /^(?:6[0-7]0|700)$/u.test(fields[1] ?? "");
}

async function verifiedAsset(relativePath: string, expectedDigest: string): Promise<Buffer> {
  const assetPath = path.join(TMUX_ASSET_ROOT, ...relativePath.split("/"));
  const bytes = await readFile(assetPath);
  if (bytes.length === 0 || digest(bytes) !== expectedDigest) throw new Error("persistent-tmux-bundled-asset-invalid");
  return bytes;
}

function appendArchiveEntry(pack: tar.Pack, header: tar.Header, bytes?: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const callback = (error?: Error | null) => error == null ? resolve() : reject(error);
    try {
      if (bytes === undefined) pack.entry(header, callback);
      else pack.entry({ ...header, size: bytes.length }, bytes, callback);
    } catch (error) {
      reject(error instanceof Error ? error : new Error("persistent-tmux-archive-entry-failed", { cause: error }));
    }
  });
}

function nativeBootstrapSessionName(sessionName: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionName)) throw new Error("persistent-terminal-session-name-invalid");
  return `bootstrap-${sessionName}`;
}

export async function buildPersistentTmuxArchive(uid: number, gid: number): Promise<Readable> {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error("persistent-tmux-execution-identity-invalid");
  }
  const [binary, configuration, xtermTerminfo, tmuxTerminfo] = await Promise.all([
    verifiedAsset("tmux-3.7c", TMUX_BINARY_SHA256),
    verifiedAsset("tmux.conf", TMUX_CONFIG_SHA256),
    verifiedAsset("terminfo/x/xterm-256color", XTERM_TERMINFO_SHA256),
    verifiedAsset("terminfo/t/tmux-256color", TMUX_TERMINFO_SHA256)
  ]);
  const archive = new PassThrough();
  const pack = tar.pack();
  pack.once("error", (error) => archive.destroy(error));
  archive.once("close", () => pack.destroy());
  pack.pipe(archive);
  void (async () => {
    const directories = [
      TMUX_ARCHIVE_ROOT,
      `${TMUX_ARCHIVE_ROOT}/terminfo`,
      `${TMUX_ARCHIVE_ROOT}/terminfo/x`,
      `${TMUX_ARCHIVE_ROOT}/terminfo/t`
    ];
    for (const name of directories) {
      await appendArchiveEntry(pack, {
        name: `${name}/`, type: "directory", mode: 0o555, uid, gid, mtime: new Date(0)
      });
    }
    await appendArchiveEntry(pack, {
      name: `${TMUX_ARCHIVE_ROOT}/tmux`, type: "file", mode: 0o555, uid, gid, mtime: new Date(0)
    }, binary);
    await appendArchiveEntry(pack, {
      name: `${TMUX_ARCHIVE_ROOT}/tmux.conf`, type: "file", mode: 0o400, uid, gid, mtime: new Date(0)
    }, configuration);
    await appendArchiveEntry(pack, {
      name: `${TMUX_ARCHIVE_ROOT}/terminfo/x/xterm-256color`, type: "file", mode: 0o444, uid, gid, mtime: new Date(0)
    }, xtermTerminfo);
    await appendArchiveEntry(pack, {
      name: `${TMUX_ARCHIVE_ROOT}/terminfo/t/tmux-256color`, type: "file", mode: 0o444, uid, gid, mtime: new Date(0)
    }, tmuxTerminfo);
    pack.finalize();
  })().catch((error: unknown) => {
    const failure = error instanceof Error ? error : new Error("persistent-tmux-archive-failed");
    pack.destroy(failure);
    archive.destroy(failure);
  });
  return archive;
}

export function persistentTmuxSessionName(terminalId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(terminalId)) {
    throw new Error("persistent-terminal-id-invalid");
  }
  return `ds-${terminalId}`;
}

export function persistentTerminalOwnershipMarker(identity: PersistentTerminalOwnership): string {
  const stableIdentity: unknown[] = [identity.projectId, identity.workspaceId, identity.terminalId, identity.processId,
    identity.containerId, identity.generation, identity.revisionId, identity.revisionHash, identity.runtimePlanHash];
  if (identity.harnessSessionId !== undefined) {
    stableIdentity.push(identity.harnessSessionId, identity.harnessGeneration ?? null, identity.harnessLeaseId ?? null);
  }
  return createHash("sha256").update(JSON.stringify(stableIdentity)).digest("hex");
}

function sessionEnvironmentNames(environment: Readonly<Record<string, string>> | undefined): string[] {
  if (environment === undefined) return [];
  const entries = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 256) throw new Error("persistent-terminal-session-environment-invalid");
  const names: string[] = [];
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || name === "DEVSPACE_TERMINAL_OWNER"
      || typeof value !== "string" || value.includes("\0")) {
      throw new Error("persistent-terminal-session-environment-invalid");
    }
    names.push(name);
  }
  return names;
}

export function parseTmuxPaneObservation(output: string): TmuxPaneObservation | null {
  const line = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (line.length === 0 || line.includes("\n") || line.includes("\r")) return null;
  const fields = line.split("|");
  if (fields.length !== 8) return null;
  const [sessionName, sessionId, paneId, rawPid, rawDead, rawStatus, rawPanes, rawWindows] = fields;
  if (sessionName === undefined || !/^[a-zA-Z0-9_-]{1,128}$/u.test(sessionName)
    || sessionId === undefined || !/^\$[0-9]+$/u.test(sessionId)
    || paneId === undefined || !/^%[0-9]+$/u.test(paneId)
    || rawPid === undefined || !/^[1-9][0-9]*$/u.test(rawPid)
    || rawDead === undefined || !["0", "1"].includes(rawDead)
    || rawStatus === undefined || !(rawStatus === "" || /^-?[0-9]+$/u.test(rawStatus))
    || rawPanes !== "1" || rawWindows !== "1") return null;
  const panePid = Number(rawPid);
  const paneDeadStatus = rawDead === "1" && rawStatus !== "" ? Number(rawStatus) : null;
  if (!Number.isSafeInteger(panePid) || panePid < 1
    || (paneDeadStatus !== null && !Number.isSafeInteger(paneDeadStatus))) return null;
  return { sessionName, sessionId, paneId, panePid, paneDead: rawDead === "1", paneDeadStatus };
}

export function parseTmuxPaneObservations(output: string): TmuxPaneObservation[] | null {
  if (output.length === 0) return [];
  const lines = output.endsWith("\n") ? output.slice(0, -1).split("\n") : output.split("\n");
  const parsed = lines.map(parseTmuxPaneObservation);
  return parsed.some((observation) => observation === null) ? null : parsed as TmuxPaneObservation[];
}

export function persistentTmuxBinding(containerId: string, uid: number, gid: number): PersistentTmuxBinding {
  if (!containerId || containerId.includes("\0") || !Number.isSafeInteger(uid) || uid < 0
    || !Number.isSafeInteger(gid) || gid < 0) throw new Error("persistent-tmux-execution-identity-invalid");
  const artifactRoot = `/opt/${TMUX_ARCHIVE_ROOT}`;
  const socketDirectory = `/tmp/devspace-persistent-tmux-${uid}`;
  return {
    containerId, uid, gid, artifactRoot,
    binaryPath: `${artifactRoot}/tmux`, configPath: `${artifactRoot}/tmux.conf`,
    terminfoPath: `${artifactRoot}/terminfo`, socketDirectory,
    socketPath: `${socketDirectory}/server.sock`,
    environment: {
      PATH: DEFAULT_PATH,
      TERM: "xterm-256color",
      TERMINFO: `${artifactRoot}/terminfo`,
      TMUX: "",
      TMUX_PANE: "",
      TMUX_TMPDIR: socketDirectory
    }
  };
}

function assertRunningContainer(inspection: DockerContainerInspection, containerId: string): void {
  if (inspection.Id !== containerId || inspection.State.Running !== true) {
    throw new Error("persistent-terminal-runtime-identity-unavailable");
  }
}

function parseNumericOutput(output: string, label: string, allowZero: boolean): number {
  const normalized = output.trim();
  if (!/^(0|[1-9][0-9]*)$/u.test(normalized)) throw new Error(`persistent-tmux-${label}-invalid`);
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || (!allowZero && value === 0)) throw new Error(`persistent-tmux-${label}-invalid`);
  return value;
}

function dockerMultiplexedOutput(raw: Buffer): { readonly stdout: string; readonly stderr: string } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    if (offset + 8 > raw.length) throw new Error("persistent-tmux-docker-output-truncated");
    const channel = raw[offset];
    if (channel !== 1 && channel !== 2 || raw[offset + 1] !== 0 || raw[offset + 2] !== 0 || raw[offset + 3] !== 0) {
      throw new Error("persistent-tmux-docker-output-invalid");
    }
    const byteLength = raw.readUInt32BE(offset + 4);
    const end = offset + 8 + byteLength;
    if (end > raw.length) throw new Error("persistent-tmux-docker-output-truncated");
    (channel === 1 ? stdout : stderr).push(raw.subarray(offset + 8, end));
    offset = end;
  }
  return { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

async function collectExecOutput(stream: Duplex, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("close", onEnd);
      stream.removeListener("error", onError);
      if (error === undefined) resolve(Buffer.concat(chunks, byteLength));
      else reject(error);
    };
    const onData = (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      byteLength += bytes.length;
      if (byteLength > maxBytes) {
        stream.destroy();
        finish(new Error("persistent-tmux-output-limit-exceeded"));
      } else chunks.push(bytes);
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    const timeout = setTimeout(() => {
      stream.destroy(new Error("persistent-tmux-command-timeout"));
      finish(new Error("persistent-tmux-command-timeout"));
    }, timeoutMs);
    timeout.unref();
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("close", onEnd);
    stream.once("error", onError);
    stream.resume();
  });
}

export class PersistentTmuxRuntime {
  private readonly verifiedContainers = new Set<string>();

  constructor(private readonly engine: DockerEngineClient) {}

  private async command(
    binding: PersistentTmuxBinding,
    command: readonly string[],
    input: { readonly tty?: boolean; readonly consoleSize?: { readonly columns: number; readonly rows: number } } = {}
  ): Promise<PersistentTmuxCommandResult> {
    const tty = input.tty ?? false;
    const execId = await this.engine.createExec(binding.containerId, {
      command, workingDirectory: "/", environment: binding.environment,
      attachStdin: tty, tty,
      ...(input.consoleSize === undefined ? {} : { consoleSize: input.consoleSize })
    });
    const stream = await this.engine.startExecAttached(execId, tty);
    try {
      const raw = await collectExecOutput(stream, PERSISTENT_TMUX_OUTPUT_LIMIT_BYTES,
        DEFAULT_CONTAINER_COMMAND_TIMEOUT_MS);
      if (tty) {
        const inspection = await this.engine.inspectExec(execId);
        if (inspection.ID !== execId || inspection.ContainerID !== binding.containerId) {
          throw new Error("persistent-tmux-exec-identity-mismatch");
        }
        if (inspection.Running || inspection.ExitCode === null) throw new Error("persistent-tmux-exec-still-running");
        return { execId, exitCode: inspection.ExitCode, stdout: raw.toString("utf8"), stderr: "" };
      }
      const output = dockerMultiplexedOutput(raw);
      const inspection = await this.engine.inspectExec(execId);
      if (inspection.ID !== execId || inspection.ContainerID !== binding.containerId) {
        throw new Error("persistent-tmux-exec-identity-mismatch");
      }
      if (inspection.Running || inspection.ExitCode === null) throw new Error("persistent-tmux-exec-still-running");
      return { execId, exitCode: inspection.ExitCode, ...output };
    } finally {
      if (!stream.destroyed) stream.destroy();
    }
  }

  private async commandResult(binding: PersistentTmuxBinding, command: readonly string[]): Promise<PersistentTmuxCommandResult> {
    return await this.command(binding, command);
  }

  async prepare(containerId: string): Promise<PersistentTmuxBinding> {
    const container = await this.engine.inspectContainer(containerId);
    assertRunningContainer(container, containerId);
    const uidResult = await this.commandResult(persistentTmuxBinding(containerId, 1, 0), ["id", "-u"]);
    if (uidResult.exitCode !== 0) throw new Error("persistent-tmux-execution-uid-unavailable");
    const uid = parseNumericOutput(uidResult.stdout, "execution-uid", true);
    const gidResult = await this.commandResult(persistentTmuxBinding(containerId, uid, 0), ["id", "-g"]);
    if (gidResult.exitCode !== 0) throw new Error("persistent-tmux-execution-gid-unavailable");
    const gid = parseNumericOutput(gidResult.stdout, "execution-gid", true);
    const binding = persistentTmuxBinding(containerId, uid, gid);
    if (await this.stagedAssetsMatch(binding)) {
      await this.ensureSocketDirectory(binding);
      const key = `${containerId}:${uid}:${gid}`;
      if (!this.verifiedContainers.has(key)) {
        await this.probe(binding);
        this.verifiedContainers.add(key);
      }
      return binding;
    }
    await this.engine.putContainerArchive(containerId, "/opt", await buildPersistentTmuxArchive(uid, gid), 120_000);
    if (!await this.stagedAssetsMatch(binding)) throw new Error("persistent-tmux-staged-assets-invalid");
    await this.ensureSocketDirectory(binding);
    await this.probe(binding);
    this.verifiedContainers.add(`${containerId}:${uid}:${gid}`);
    return binding;
  }

  private async stagedAssetsMatch(binding: PersistentTmuxBinding): Promise<boolean> {
    const hash = await this.commandResult(binding, ["sha256sum", "--", binding.binaryPath,
      `${binding.terminfoPath}/x/xterm-256color`, `${binding.terminfoPath}/t/tmux-256color`, binding.configPath]);
    if (hash.exitCode !== 0) return false;
    const hashes = hash.stdout.trim().split("\n").map((line) => /^([0-9a-f]{64})\s+(.+)$/u.exec(line));
    const expected = [
      [TMUX_BINARY_SHA256, binding.binaryPath],
      [XTERM_TERMINFO_SHA256, `${binding.terminfoPath}/x/xterm-256color`],
      [TMUX_TERMINFO_SHA256, `${binding.terminfoPath}/t/tmux-256color`],
      [TMUX_CONFIG_SHA256, binding.configPath]
    ] as const;
    if (hashes.length !== expected.length || hashes.some((match, index) => match?.[1] !== expected[index]?.[0]
      || match?.[2] !== expected[index]?.[1])) return false;
    const metadata = await this.commandResult(binding, ["stat", "-c", "%a %u:%g", binding.artifactRoot,
      binding.binaryPath, binding.configPath, `${binding.terminfoPath}/x/xterm-256color`, `${binding.terminfoPath}/t/tmux-256color`
    ]);
    const lines = metadata.stdout.trim().split("\n");
    if (metadata.exitCode !== 0 || lines.length !== 5) return false;
    const expectedModes = ["555", "555", "400", "444", "444"];
    if (lines.some((line, index) => line !== `${expectedModes[index]} ${binding.uid}:${binding.gid}`)) return false;
    const version = await this.commandResult(binding, [binding.binaryPath, "-V"]);
    return version.exitCode === 0 && version.stdout.trim() === `tmux ${PERSISTENT_TMUX_VERSION}`;
  }

  private async ensureSocketDirectory(binding: PersistentTmuxBinding): Promise<void> {
    const created = await this.commandResult(binding, ["mkdir", "-p", "-m", "0700", "--", binding.socketDirectory]);
    if (created.exitCode !== 0) throw new Error("persistent-tmux-socket-directory-unavailable");
    const metadata = await this.commandResult(binding, ["stat", "-c", "%a %u:%g", binding.socketDirectory]);
    if (metadata.exitCode !== 0 || metadata.stdout.trim() !== `700 ${binding.uid}:${binding.gid}`) {
      throw new Error("persistent-tmux-socket-directory-ownership-invalid");
    }
  }

  tmuxCommand(binding: PersistentTmuxBinding, command: readonly string[]): string[] {
    return [binding.binaryPath, "-S", binding.socketPath, "-f", binding.configPath, ...command];
  }

  newSessionCommand(
    binding: PersistentTmuxBinding,
    identity: PersistentTerminalOwnership,
    sessionName: string,
    launch?: PersistentTerminalLaunch
  ): string[] {
    return this.tmuxCommand(binding, [
      "new-session", "-d", "-s", sessionName,
      "-x", String(PERSISTENT_TMUX_INITIAL_COLUMNS), "-y", String(PERSISTENT_TMUX_INITIAL_ROWS),
      "-c", "/workspace", "-e", `DEVSPACE_TERMINAL_OWNER=${persistentTerminalOwnershipMarker(identity)}`,
      "--", ...(launch === undefined ? ["/bin/sh", "-i"] : [...launch.command])
    ]);
  }

  async createSessionExec(
    binding: PersistentTmuxBinding,
    identity: PersistentTerminalOwnership,
    sessionName: string,
    launch?: PersistentTerminalLaunch
  ): Promise<string> {
    const environment = { ...binding.environment, ...(launch?.environment ?? {}) };
    const environmentNames = launch === undefined ? [] : sessionEnvironmentNames(launch.environment);
    if (environmentNames.length > 0 && !await this.configureSessionEnvironmentForwarding(binding, environmentNames)) {
      // A new tmux server inherits the environment of the client that starts
      // it. Start it from the clean runtime environment before any Native
      // credentials are sent, then deliver those values only to the session.
      const bootstrapName = nativeBootstrapSessionName(sessionName);
      const bootstrap = await this.commandResult(binding, this.newSessionCommand(binding, identity, bootstrapName));
      if (bootstrap.exitCode !== 0) throw new Error("persistent-tmux-clean-bootstrap-failed");
      if (await this.lookupSession(binding, identity, bootstrapName, null, null) === null) {
        throw new PersistentTmuxIdentityMismatchError("persistent-tmux-clean-bootstrap-identity-unverified");
      }
      if (!await this.configureSessionEnvironmentForwarding(binding, environmentNames)) {
        throw new Error("persistent-tmux-clean-bootstrap-unverified");
      }
    }
    return await this.engine.createExec(binding.containerId, {
      command: this.newSessionCommand(binding, identity, sessionName, launch),
      workingDirectory: "/", environment, attachStdin: false, tty: false
    });
  }

  async startCreatedExec(binding: PersistentTmuxBinding, execId: string): Promise<PersistentTmuxCommandResult> {
    const stream = await this.engine.startExecAttached(execId, false);
    try {
      const raw = await collectExecOutput(stream, PERSISTENT_TMUX_OUTPUT_LIMIT_BYTES, DEFAULT_CONTAINER_COMMAND_TIMEOUT_MS);
      const output = dockerMultiplexedOutput(raw);
      const inspection = await this.engine.inspectExec(execId);
      if (inspection.ID !== execId || inspection.ContainerID !== binding.containerId) {
        throw new Error("persistent-tmux-exec-identity-mismatch");
      }
      if (inspection.Running || inspection.ExitCode === null) throw new Error("persistent-tmux-exec-still-running");
      return { execId, exitCode: inspection.ExitCode, ...output };
    } finally {
      if (!stream.destroyed) stream.destroy();
    }
  }

  async inspectExec(binding: PersistentTmuxBinding, execId: string): Promise<{
    readonly running: boolean; readonly exitCode: number | null;
  }> {
    const inspection = await this.engine.inspectExec(execId);
    if (inspection.ID !== execId || inspection.ContainerID !== binding.containerId) {
      throw new Error("persistent-tmux-exec-identity-mismatch");
    }
    return { running: inspection.Running, exitCode: inspection.ExitCode };
  }

  async lookupSession(
    binding: PersistentTmuxBinding,
    identity: PersistentTerminalOwnership,
    sessionName: string,
    knownSessionId: string | null,
    knownPaneId: string | null
  ): Promise<TmuxPaneObservation | null> {
    const socketExists = await this.commandResult(binding, ["test", "-e", binding.socketPath]);
    if (socketExists.exitCode === 1) return null;
    if (socketExists.exitCode !== 0) throw new PersistentTmuxIdentityMismatchError("persistent-tmux-socket-query-failed");
    const socketMetadata = await this.commandResult(binding, ["stat", "-c", "%F %a %u:%g", binding.socketPath]);
    if (socketMetadata.exitCode !== 0
      || !isOwnedSecurePersistentTmuxSocketMetadata(socketMetadata.stdout, binding.uid, binding.gid)) {
      throw new PersistentTmuxIdentityMismatchError("persistent-tmux-socket-ownership-invalid");
    }
    const panes = await this.commandResult(binding, this.tmuxCommand(binding, ["list-panes", "-a", "-F", TMUX_PANE_FORMAT]));
    if (panes.exitCode !== 0) throw new PersistentTmuxIdentityMismatchError("persistent-tmux-session-query-unproven");
    const observations = parseTmuxPaneObservations(panes.stdout);
    if (observations === null) throw new PersistentTmuxIdentityMismatchError("persistent-tmux-session-query-invalid");
    const matches = observations.filter((observation) => observation.sessionName === sessionName);
    if (matches.length === 0) return null;
    if (matches.length !== 1) throw new PersistentTmuxIdentityMismatchError("persistent-tmux-session-identity-mismatch");
    const observation = matches[0]!;
    if (knownSessionId !== null && observation.sessionId !== knownSessionId
      || knownPaneId !== null && observation.paneId !== knownPaneId) {
      throw new PersistentTmuxIdentityMismatchError("persistent-tmux-session-identity-mismatch");
    }
    const marker = await this.commandResult(binding,
      this.tmuxCommand(binding, ["show-environment", "-t", `=${sessionName}`, "DEVSPACE_TERMINAL_OWNER"]));
    const expectedMarker = `DEVSPACE_TERMINAL_OWNER=${persistentTerminalOwnershipMarker(identity)}`;
    if (marker.exitCode !== 0 || marker.stdout.trim() !== expectedMarker) {
      throw new PersistentTmuxIdentityMismatchError("persistent-tmux-session-owner-mismatch");
    }
    return observation;
  }

  async clearSessionEnvironment(
    binding: PersistentTmuxBinding,
    identity: PersistentTerminalOwnership,
    sessionName: string,
    variableNames: readonly string[],
    sessionExists = true
  ): Promise<void> {
    const socket = await this.commandResult(binding, ["test", "-S", binding.socketPath]);
    if (socket.exitCode === 1) return;
    if (socket.exitCode !== 0) throw new Error("persistent-tmux-session-environment-cleanup-failed");
    const metadata = await this.commandResult(binding, ["stat", "-c", "%F %a %u:%g", binding.socketPath]);
    if (metadata.exitCode !== 0 || !isOwnedSecurePersistentTmuxSocketMetadata(metadata.stdout, binding.uid, binding.gid)) {
      throw new PersistentTmuxIdentityMismatchError("persistent-tmux-socket-ownership-invalid");
    }
    for (const name of variableNames) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || name === "DEVSPACE_TERMINAL_OWNER") {
        throw new Error("persistent-terminal-session-environment-invalid");
      }
      if (sessionExists) {
        const clearedSession = await this.commandResult(binding, this.tmuxCommand(binding,
          ["set-environment", "-u", "-t", `=${sessionName}`, name]));
        if (clearedSession.exitCode !== 0) throw new Error("persistent-tmux-session-environment-cleanup-failed");
      }
      const clearedGlobal = await this.commandResult(binding, this.tmuxCommand(binding,
        ["set-environment", "-g", "-u", name]));
      if (clearedGlobal.exitCode !== 0) throw new Error("persistent-tmux-session-environment-cleanup-failed");
    }
    const reset = await this.commandResult(binding, this.tmuxCommand(binding,
      ["set-option", "-g", "update-environment", ""]));
    if (reset.exitCode !== 0) throw new Error("persistent-tmux-session-environment-cleanup-failed");
    const bootstrapName = nativeBootstrapSessionName(sessionName);
    const bootstrap = await this.lookupSession(binding, identity, bootstrapName, null, null);
    if (bootstrap !== null) {
      const removed = await this.commandResult(binding, this.tmuxCommand(binding,
        ["kill-session", "-t", `=${bootstrapName}`]));
      if (removed.exitCode !== 0) throw new Error("persistent-tmux-session-environment-cleanup-failed");
    }
  }

  async configureSessionEnvironmentForwarding(binding: PersistentTmuxBinding, variableNames: readonly string[]): Promise<boolean> {
    const names = [...new Set(variableNames)].sort();
    if (names.length > 256 || names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
      || name === "DEVSPACE_TERMINAL_OWNER")) {
      throw new Error("persistent-terminal-session-environment-invalid");
    }
    const socket = await this.commandResult(binding, ["test", "-S", binding.socketPath]);
    if (socket.exitCode === 1) return false;
    if (socket.exitCode !== 0) throw new Error("persistent-tmux-session-environment-forwarding-failed");
    const metadata = await this.commandResult(binding, ["stat", "-c", "%F %a %u:%g", binding.socketPath]);
    if (metadata.exitCode !== 0 || !isOwnedSecurePersistentTmuxSocketMetadata(metadata.stdout, binding.uid, binding.gid)) {
      throw new PersistentTmuxIdentityMismatchError("persistent-tmux-socket-ownership-invalid");
    }
    await this.setSessionEnvironmentForwarding(binding, names);
    return true;
  }

  async setSessionEnvironmentForwarding(
    binding: PersistentTmuxBinding,
    variableNames: readonly string[]
  ): Promise<void> {
    const names = [...new Set(variableNames)].sort();
    if (names.length > 256 || names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
      || name === "DEVSPACE_TERMINAL_OWNER")) {
      throw new Error("persistent-terminal-session-environment-invalid");
    }
    const configured = await this.commandResult(binding, this.tmuxCommand(binding,
      ["set-option", "-g", "update-environment", names.join(" ")]));
    if (configured.exitCode !== 0) throw new Error("persistent-tmux-session-environment-forwarding-failed");
  }

  async createAttachment(
    binding: PersistentTmuxBinding,
    sessionName: string,
    size: { readonly columns: number; readonly rows: number }
  ): Promise<PersistentTmuxAttachment> {
    if (!Number.isInteger(size.columns) || size.columns < 1 || size.columns > PERSISTENT_TMUX_MAX_COLUMNS
      || !Number.isInteger(size.rows) || size.rows < 1 || size.rows > PERSISTENT_TMUX_MAX_ROWS) {
      throw new Error("persistent-tmux-console-size-invalid");
    }
    const previousClients = await this.listClients(binding, sessionName);
    const command = this.tmuxCommand(binding, ["attach-session", "-d", "-t", `=${sessionName}`]);
    const execId = await this.engine.createExec(binding.containerId, {
      command, workingDirectory: "/", environment: binding.environment, attachStdin: true, tty: true,
      consoleSize: size
    });
    const inspection = await this.engine.inspectExec(execId);
    if (inspection.ID !== execId || inspection.ContainerID !== binding.containerId
      || inspection.Running || inspection.ExitCode !== null) {
      throw new Error("persistent-tmux-attachment-exec-identity-invalid");
    }
    const stream = await this.engine.startExecAttached(execId, true);
    try {
      const client = await this.waitForNewClient(binding, sessionName, previousClients);
      return { execId, clientPid: client.clientPid, clientName: client.clientName, stream };
    } catch (error) {
      if (!stream.destroyed) stream.destroy();
      throw error;
    }
  }

  private async listClients(binding: PersistentTmuxBinding, sessionName: string): Promise<PersistentTmuxClientIdentity[]> {
    const result = await this.commandResult(binding, this.tmuxCommand(binding, [
      "list-clients", "-t", `=${sessionName}`, "-F", "#{client_pid}|#{client_name}"
    ]));
    if (result.exitCode !== 0) throw new Error("persistent-tmux-client-query-unproven");
    const output = result.stdout.trim();
    if (output === "") return [];
    const clients = output.split(/\r?\n/u).map((line) => {
      const separator = line.indexOf("|");
      if (separator < 1 || separator !== line.lastIndexOf("|")) {
        throw new Error("persistent-tmux-client-identity-invalid");
      }
      const pidText = line.slice(0, separator);
      const clientName = line.slice(separator + 1);
      if (!/^[1-9][0-9]{0,9}$/u.test(pidText)
        || !(/^(?:\/dev\/pts\/[0-9]+|client-[1-9][0-9]{0,9})$/u.test(clientName))) {
        throw new Error("persistent-tmux-client-identity-invalid");
      }
      const clientPid = Number(pidText);
      if (!Number.isSafeInteger(clientPid)) throw new Error("persistent-tmux-client-identity-invalid");
      return { clientPid, clientName };
    });
    if (new Set(clients.map((client) => client.clientPid)).size !== clients.length
      || new Set(clients.map((client) => client.clientName)).size !== clients.length) {
      throw new Error("persistent-tmux-client-identity-ambiguous");
    }
    return clients;
  }

  private async waitForNewClient(
    binding: PersistentTmuxBinding,
    sessionName: string,
    previousClients: readonly PersistentTmuxClientIdentity[]
  ): Promise<PersistentTmuxClientIdentity> {
    const deadline = Date.now() + TMUX_CLIENT_RESOLUTION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const clients = await this.listClients(binding, sessionName);
      const newClients = clients.filter((client) => !previousClients.some((previous) =>
        previous.clientPid === client.clientPid && previous.clientName === client.clientName));
      if (clients.length === 1 && newClients.length === 1) return newClients[0]!;
      await new Promise<void>((resolve) => setTimeout(resolve, TMUX_CLIENT_POLL_INTERVAL_MS));
    }
    throw new Error("persistent-tmux-client-identity-unresolved");
  }

  async detachClient(binding: PersistentTmuxBinding, sessionName: string, clientPid: number, clientName: string): Promise<void> {
    if (!Number.isSafeInteger(clientPid) || clientPid < 1) throw new Error("persistent-tmux-client-identity-invalid");
    if (!/^(?:\/dev\/pts\/[0-9]+|client-[1-9][0-9]{0,9})$/u.test(clientName)) {
      throw new Error("persistent-tmux-client-identity-invalid");
    }
    const before = await this.listClients(binding, sessionName);
    if (!before.some((client) => client.clientPid === clientPid && client.clientName === clientName)) return;
    const detached = await this.commandResult(binding, this.tmuxCommand(binding, [
      "detach-client", "-t", clientName
    ]));
    const after = await this.listClients(binding, sessionName);
    if (!after.some((client) => client.clientPid === clientPid && client.clientName === clientName)) return;
    if (detached.exitCode !== 0) throw new Error("persistent-tmux-client-detach-unproven");
    throw new Error("persistent-tmux-client-remained-attached");
  }

  async resizeAttachment(execId: string, columns: number, rows: number): Promise<void> {
    if (!Number.isInteger(columns) || columns < 1 || columns > PERSISTENT_TMUX_MAX_COLUMNS
      || !Number.isInteger(rows) || rows < 1 || rows > PERSISTENT_TMUX_MAX_ROWS) {
      throw new Error("persistent-tmux-console-size-invalid");
    }
    await this.engine.resizeExec(execId, columns, rows);
  }

  async history(binding: PersistentTmuxBinding, sessionName: string): Promise<void> {
    const result = await this.commandResult(binding,
      this.tmuxCommand(binding, ["copy-mode", "-e", "-t", `=${sessionName}:0.0`]));
    if (result.exitCode !== 0) throw new Error("persistent-tmux-history-unavailable");
  }

  async live(binding: PersistentTmuxBinding, sessionName: string): Promise<void> {
    const target = `=${sessionName}:0.0`;
    const result = await this.commandResult(binding, this.tmuxCommand(binding, [
      "if-shell", "-F", "-t", target, "#{pane_in_mode}",
      `send-keys -X -t ${target} cancel`, `display-message -p -t ${target} live`
    ]));
    if (result.exitCode !== 0) throw new Error("persistent-tmux-live-view-unavailable");
  }

  async probe(binding: PersistentTmuxBinding): Promise<void> {
    const probeId = randomUUID().replaceAll("-", "").slice(0, 16);
    const probeSocket = `${binding.socketDirectory}/probe-${probeId}.sock`;
    const probeName = `probe-${probeId}`;
    const probeBinding: PersistentTmuxBinding = { ...binding, socketPath: probeSocket };
    try {
      const created = await this.commandResult(probeBinding, this.tmuxCommand(probeBinding, [
        "new-session", "-d", "-s", probeName, "-x", "80", "-y", "24", "-c", "/workspace", "--", "/bin/true"
      ]));
      if (created.exitCode !== 0) throw new Error("persistent-tmux-probe-session-failed");
      const socketMetadata = await this.commandResult(probeBinding, ["stat", "-c", "%F %a %u:%g", probeSocket]);
      if (socketMetadata.exitCode !== 0
        || !isOwnedSecurePersistentTmuxSocketMetadata(socketMetadata.stdout, binding.uid, binding.gid)) {
        throw new Error("persistent-tmux-probe-socket-invalid");
      }
      const command = this.tmuxCommand(probeBinding, ["attach-session", "-t", `=${probeName}`]);
      const execId = await this.engine.createExec(binding.containerId, {
        command, workingDirectory: "/", environment: binding.environment, attachStdin: true, tty: true,
        consoleSize: { columns: 80, rows: 24 }
      });
      const stream = await this.engine.startExecAttached(execId, true);
      try {
        const firstOutput = await new Promise<Buffer>((resolve, reject) => {
          let settled = false;
          const finish = (error?: Error, bytes?: Buffer) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            stream.removeListener("data", onData);
            stream.removeListener("error", onError);
            if (error === undefined && bytes !== undefined) resolve(bytes);
            else reject(error ?? new Error("persistent-tmux-probe-output-empty"));
          };
          const onData = (chunk: Buffer) => finish(undefined, Buffer.from(chunk));
          const onError = (error: Error) => finish(error);
          const timeout = setTimeout(() => finish(new Error("persistent-tmux-terminfo-probe-timeout")), 5_000);
          timeout.unref();
          stream.once("data", onData);
          stream.once("error", onError);
          stream.resume();
        });
        if (firstOutput.length < 1) throw new Error("persistent-tmux-terminfo-probe-empty");
      } finally {
        if (!stream.destroyed) stream.destroy();
      }
    } finally {
      await this.commandResult(probeBinding, this.tmuxCommand(probeBinding, ["kill-server"])).catch(() => undefined);
      await this.commandResult(binding, ["unlink", probeSocket]).catch(() => undefined);
    }
  }
}
