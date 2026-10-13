import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Readable, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar-stream";
import { afterEach, expect, onTestFailed, test } from "vitest";
import { collectStreamUntilEof, errorMessage, ProbeProgress } from "./persistent-terminal-probe-diagnostics.js";
import { DockerEngineClient, DockerEngineError } from "./docker-runtime.js";

const dockerSocketPath = process.env.DEVSPACE_TEST_DOCKER_SOCKET_PATH;
const tmuxBinaryPath = process.env.DEVSPACE_TEST_TMUX_BINARY_PATH;
const tmuxTerminfoPath = process.env.DEVSPACE_TEST_TMUX_TERMINFO_PATH;
const tmuxArchiveSha256 = "cc56bd1cc873eb6089c615f0496b072385bda8a6d944069f38564a5d49c128aa";
const tmuxBinarySha256 = "7d0f1e85c5b11df7fe127ab90674c6a15663ad72a25fcf7fabadba6bbb0b29d5";
const testImages = ["node:24-bookworm", "node:24-bookworm-slim"] as const;
const testUser = "1000:1000";
const commandTimeoutMs = 15_000;
const streamTimeoutMs = 20_000;
const dockerOperationTimeoutMs = 35_000;
const diagnosticOperationTimeoutMs = 35_000;

interface ActiveFixture {
  readonly engine: DockerEngineClient;
  readonly runId: string;
  readonly progress: ProbeProgress;
  readonly containerIds: Set<string>;
  readonly attachments: Set<Duplex>;
  readonly commandStreams: Set<Duplex>;
  readonly temporaryRoots: Set<string>;
  readonly execs: Map<string, string>;
  readonly attachmentExecIds: Set<string>;
  readonly diagnosticExecIds: Set<string>;
  latestExecId: string | null;
  failureCheckpoint: { readonly lastCheckpoint: string | null; readonly lastCompletedCheckpoint: string | null } | null;
}

interface DockerCommandResult {
  readonly execId: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface TmuxAttachment {
  readonly execId: string;
  readonly stream: import("node:stream").Duplex;
  readonly chunks: Buffer[];
  byteLength: number;
  streamError: unknown;
}

interface TerminfoEntry {
  readonly relativePath: string;
  readonly bytes: Buffer;
}

let activeFixture: ActiveFixture | null = null;

function fixtureFor(containerId?: string): ActiveFixture {
  const fixture = activeFixture;
  if (fixture === null || (containerId !== undefined && !fixture.containerIds.has(containerId))) {
    throw new Error("rootless-tmux-active-container-fixture-missing");
  }
  return fixture;
}

function chunkBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("rootless-tmux-stream-chunk-invalid");
}

function decodeDockerFrames(input: Buffer): { readonly stdout: string; readonly stderr: string } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  while (offset < input.length) {
    if (input.length - offset < 8) throw new Error("rootless-tmux-docker-frame-truncated");
    const stream = input[offset];
    const length = input.readUInt32BE(offset + 4);
    const end = offset + 8 + length;
    if ((stream !== 1 && stream !== 2) || end > input.length) throw new Error("rootless-tmux-docker-frame-invalid");
    (stream === 1 ? stdout : stderr).push(input.subarray(offset + 8, end));
    offset = end;
  }
  return { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

async function containerCommand(
  engine: DockerEngineClient,
  containerId: string,
  command: readonly string[],
  environment: Readonly<Record<string, string>> = {},
  operationName?: string
): Promise<DockerCommandResult> {
  const fixture = activeFixture;
  if (fixture === null || !fixture.containerIds.has(containerId)) throw new Error("rootless-tmux-active-container-fixture-missing");
  const name = operationName ?? `container.command:${command.slice(0, 3).join(" ")}`;
  const execId = await fixture.progress.run(`${name}.exec-create`, dockerOperationTimeoutMs, () => engine.createExec(containerId, {
    command, workingDirectory: "/", environment, attachStdin: false, tty: false
  }));
  fixture.latestExecId = execId;
  fixture.execs.set(execId, name);
  for (const existing of fixture.diagnosticExecIds) {
    if (!fixture.attachmentExecIds.has(existing)) fixture.diagnosticExecIds.delete(existing);
  }
  fixture.diagnosticExecIds.add(execId);
  fixture.progress.record(`${name}.exec-created`, "info", { containerId, execId, command });

  let stream: Duplex | null = null;
  try {
    stream = await fixture.progress.run(`${name}.attach-stream`, dockerOperationTimeoutMs,
      () => engine.startExecAttached(execId, false));
    fixture.commandStreams.add(stream);
    const framedOutput = await fixture.progress.run(`${name}.collect-output-eof`, streamTimeoutMs + 2_000,
      () => collectStreamUntilEof(stream!, `${name}.exec-${execId}`, streamTimeoutMs), () => stream?.destroy());
    const output = decodeDockerFrames(framedOutput);
    const inspection = await fixture.progress.run(`${name}.inspect-final-exec`, dockerOperationTimeoutMs,
      () => engine.inspectExec(execId));
    fixture.progress.record(`${name}.exec-finished`, "info", {
      containerId, execId, running: inspection.Running, exitCode: inspection.ExitCode
    });
    if (inspection.Running || inspection.ExitCode === null) {
      throw new Error(`rootless-tmux-docker-exec-did-not-finish:${execId}:running=${inspection.Running}:exitCode=${inspection.ExitCode}`);
    }
    return { execId, ...output, exitCode: inspection.ExitCode };
  } finally {
    if (stream !== null) {
      if (!stream.destroyed) stream.destroy();
      fixture.commandStreams.delete(stream);
    }
  }
}

async function commandOkay(
  engine: DockerEngineClient,
  containerId: string,
  command: readonly string[],
  operationName?: string
): Promise<string> {
  const result = await containerCommand(engine, containerId, command, {}, operationName);
  if (result.exitCode !== 0) {
    throw new Error(`rootless-tmux-container-command-failed:${operationName ?? command[0] ?? "unknown"}:${result.execId}:${result.exitCode}:${result.stderr.slice(0, 300)}`);
  }
  return result.stdout;
}

async function createWritableRootlessTmuxContainer(
  engine: DockerEngineClient,
  name: string,
  input: {
    readonly imageReference: string;
    readonly user: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly cpuMillicores: number;
    readonly memoryBytes: number;
    readonly pidLimit: number;
  }
): Promise<string> {
  const requestBody = Buffer.from(JSON.stringify({
    Image: input.imageReference,
    Entrypoint: ["/bin/sh", "-c"],
    Cmd: ["exec sleep 2147483647"],
    WorkingDir: "/",
    User: input.user,
    Env: [],
    Labels: { ...input.labels },
    ExposedPorts: {},
    HostConfig: {
      Binds: [],
      Mounts: [],
      Tmpfs: {
        "/opt/devspace-codex-probe": "rw,nosuid,nodev,exec,size=1g",
        "/tmp/devspace-codex-home": "rw,nosuid,nodev,noexec,size=16m",
        "/tmp/devspace-codex-state": "rw,nosuid,nodev,noexec,size=16m"
      },
      NetworkMode: "none",
      PortBindings: {},
      PublishAllPorts: false,
      Privileged: false,
      PidMode: "",
      IpcMode: "private",
      UTSMode: "",
      UsernsMode: "",
      CgroupnsMode: "private",
      AutoRemove: false,
      ReadonlyRootfs: false,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      CapAdd: [],
      CapDrop: ["ALL"],
      Devices: [],
      SecurityOpt: ["no-new-privileges:true"],
      NanoCpus: input.cpuMillicores * 1_000_000,
      Memory: input.memoryBytes,
      MemorySwap: input.memoryBytes,
      PidsLimit: input.pidLimit
    }
  }));
  const responseBody = await new Promise<Buffer>((resolve, reject) => {
    const request = httpRequest({
      socketPath: engine.socketPath,
      method: "POST",
      path: `/containers/create?name=${encodeURIComponent(name)}`,
      headers: { "content-type": "application/json", "content-length": String(requestBody.length) }
    }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 16 * 1024) {
          response.destroy(new Error("rootless-tmux-container-create-response-too-large"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once("end", () => {
        const result = Buffer.concat(chunks);
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(new DockerEngineError(statusCode, result.toString("utf8").slice(0, 512)));
          return;
        }
        resolve(result);
      });
      response.once("error", reject);
    });
    request.setTimeout(30_000, () => request.destroy(new Error("rootless-tmux-container-create-timeout")));
    request.once("error", reject);
    request.end(requestBody);
  });
  const created = JSON.parse(responseBody.toString("utf8")) as { readonly Id?: unknown };
  if (typeof created.Id !== "string" || !/^[a-f0-9]{64}$/u.test(created.Id)) {
    throw new Error("rootless-tmux-container-id-invalid");
  }
  return created.Id;
}

async function collectFiles(root: string, relativePath = ""): Promise<readonly TerminfoEntry[]> {
  const entries: TerminfoEntry[] = [];
  for (const item of await readdir(path.join(root, relativePath), { withFileTypes: true })) {
    const child = path.posix.join(relativePath, item.name);
    if (item.isDirectory()) entries.push(...await collectFiles(root, child));
    else if (item.isFile()) entries.push({ relativePath: child, bytes: await readFile(path.join(root, child)) });
  }
  return entries;
}

function appendArchiveEntry(pack: tar.Pack, header: tar.Header, bytes?: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (bytes === undefined) pack.entry(header, (error) => error == null ? resolve() : reject(error));
    else pack.entry({ ...header, size: bytes.length }, bytes, (error) => error == null ? resolve() : reject(error));
  });
}

function artifactArchive(runId: string): Readable {
  if (tmuxBinaryPath === undefined || tmuxTerminfoPath === undefined) {
    throw new Error("rootless-tmux-artifact-paths-are-required");
  }
  const archive = tar.pack();
  void (async () => {
    const directoryName = `persistent-tmux-${runId}`;
    const binary = await readFile(tmuxBinaryPath);
    const binaryHash = createHash("sha256").update(binary).digest("hex");
    if (binaryHash !== tmuxBinarySha256) throw new Error(`rootless-tmux-binary-hash-mismatch:${binaryHash}`);
    const terminfoEntries = await collectFiles(tmuxTerminfoPath);
    const selectedEntries = ["xterm-256color", "tmux-256color"].map((name) => {
      const entry = terminfoEntries.find((candidate) => path.posix.basename(candidate.relativePath) === name);
      if (entry === undefined || entry.bytes.length === 0) throw new Error(`rootless-tmux-terminfo-entry-missing:${name}`);
      return entry;
    });

    const directories = new Set([directoryName, `${directoryName}/terminfo`]);
    for (const entry of selectedEntries) {
      const parts = entry.relativePath.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        directories.add(`${directoryName}/terminfo/${parts.slice(0, index).join("/")}`);
      }
    }
    for (const directory of [...directories].sort((left, right) => left.split("/").length - right.split("/").length)) {
      await appendArchiveEntry(archive, {
        name: `${directory}/`, type: "directory", mode: 0o700, uid: 1000, gid: 1000, mtime: new Date(0)
      });
    }
    await appendArchiveEntry(archive, {
      name: `${directoryName}/tmux`, type: "file", mode: 0o755, uid: 1000, gid: 1000, mtime: new Date(0)
    }, binary);
    const config = Buffer.from([
      'set-option -g default-terminal "tmux-256color"',
      "set-option -g history-limit 2000",
      "set-option -g status off",
      "set-option -g remain-on-exit on",
      ""
    ].join("\n"));
    await appendArchiveEntry(archive, {
      name: `${directoryName}/tmux.conf`, type: "file", mode: 0o600, uid: 1000, gid: 1000, mtime: new Date(0)
    }, config);
    for (const entry of selectedEntries) {
      await appendArchiveEntry(archive, {
        name: `${directoryName}/terminfo/${entry.relativePath}`, type: "file", mode: 0o644,
        uid: 1000, gid: 1000, mtime: new Date(0)
      }, entry.bytes);
    }
    archive.finalize();
  })().catch((error: unknown) => {
    archive.destroy(error instanceof Error ? error : new Error("rootless-tmux-artifact-archive-failed"));
  });
  return archive;
}

async function writeArtifactArchiveFile(runId: string, archivePath: string, signal: AbortSignal): Promise<void> {
  await pipeline(artifactArchive(runId), createWriteStream(archivePath, { flags: "wx", mode: 0o600 }), { signal });
}

async function validateArtifactArchive(
  archiveBytes: Buffer,
  runId: string,
  signal: AbortSignal
): Promise<{ readonly entryCount: number; readonly binaryBytes: number }> {
  if (tmuxBinaryPath === undefined || tmuxTerminfoPath === undefined) {
    throw new Error("rootless-tmux-artifact-paths-are-required");
  }
  const directoryName = `persistent-tmux-${runId}`;
  const binary = await readFile(tmuxBinaryPath);
  const terminfoEntries = await collectFiles(tmuxTerminfoPath);
  const selectedEntries = ["xterm-256color", "tmux-256color"].map((name) => {
    const entry = terminfoEntries.find((candidate) => path.posix.basename(candidate.relativePath) === name);
    if (entry === undefined || entry.bytes.length === 0) throw new Error(`rootless-tmux-terminfo-entry-missing:${name}`);
    return entry;
  });
  const directories = new Set([directoryName, `${directoryName}/terminfo`]);
  for (const entry of selectedEntries) {
    const parts = entry.relativePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(`${directoryName}/terminfo/${parts.slice(0, index).join("/")}`);
    }
  }
  const config = Buffer.from([
    'set-option -g default-terminal "tmux-256color"',
    "set-option -g history-limit 2000",
    "set-option -g status off",
    "set-option -g remain-on-exit on",
    ""
  ].join("\n"));
  const expected = new Map<string, { readonly type: string; readonly mode: number; readonly bytes: Buffer }>();
  for (const directory of directories) {
    expected.set(`${directory}/`, { type: "directory", mode: 0o700, bytes: Buffer.alloc(0) });
  }
  expected.set(`${directoryName}/tmux`, { type: "file", mode: 0o755, bytes: binary });
  expected.set(`${directoryName}/tmux.conf`, { type: "file", mode: 0o600, bytes: config });
  for (const entry of selectedEntries) {
    expected.set(`${directoryName}/terminfo/${entry.relativePath}`, { type: "file", mode: 0o644, bytes: entry.bytes });
  }

  const extract = tar.extract();
  const observed = new Set<string>();
  extract.on("entry", (header, body, next) => {
    void (async () => {
      const expectedEntry = expected.get(header.name);
      if (expectedEntry === undefined || observed.has(header.name)
        || header.type !== expectedEntry.type || header.mode !== expectedEntry.mode
        || header.uid !== 1000 || header.gid !== 1000 || header.size !== expectedEntry.bytes.length) {
        throw new Error(`rootless-tmux-archive-entry-metadata-mismatch:${header.name}`);
      }
      const chunks: Buffer[] = [];
      let byteLength = 0;
      for await (const value of body) {
        const bytes = chunkBuffer(value as unknown);
        byteLength += bytes.length;
        if (byteLength > expectedEntry.bytes.length) throw new Error(`rootless-tmux-archive-entry-oversized:${header.name}`);
        chunks.push(bytes);
      }
      const actualBytes = Buffer.concat(chunks, byteLength);
      if (!actualBytes.equals(expectedEntry.bytes)) throw new Error(`rootless-tmux-archive-entry-content-mismatch:${header.name}`);
      observed.add(header.name);
      next();
    })().catch((error: unknown) => extract.destroy(error instanceof Error ? error : new Error("rootless-tmux-archive-validation-failed")));
  });
  await pipeline(Readable.from([archiveBytes]), extract, { signal });
  if (observed.size !== expected.size) {
    throw new Error(`rootless-tmux-archive-entry-count-mismatch:${observed.size}:${expected.size}`);
  }
  return { entryCount: observed.size, binaryBytes: binary.length };
}

test.skipIf(tmuxBinaryPath === undefined || tmuxTerminfoPath === undefined)(
  "probe archive is written, reaches EOF, and extracts with expected content and ownership",
  async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "devspace-tmux-archive-test-"));
    const runId = `local-${randomUUID()}`;
    const archivePath = path.join(temporaryRoot, "tmux-artifacts.tar");
    const writeAbort = new AbortController();
    const validateAbort = new AbortController();
    const progress = new ProbeProgress("local-tmux-archive-test");
    try {
      await progress.run("archive.local.write-and-eof", 2_000,
        () => writeArtifactArchiveFile(runId, archivePath, writeAbort.signal),
        () => writeAbort.abort(new Error("rootless-tmux-local-archive-generation-timeout")));
      const archiveFile = await stat(archivePath);
      expect(archiveFile.mode & 0o777).toBe(0o600);
      expect(archiveFile.size).toBeGreaterThan(2_200_000);
      const archiveBytes = await readFile(archivePath);
      const validated = await progress.run("archive.local.extract-and-validate", 2_000,
        () => validateArtifactArchive(archiveBytes, runId, validateAbort.signal),
        () => validateAbort.abort(new Error("rootless-tmux-local-archive-extract-timeout")));
      expect(validated).toMatchObject({ entryCount: 8, binaryBytes: 2_232_808 });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
  8_000
);

test("tmux feasibility container uses a writable rootfs with isolated execution limits", async () => {
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(process.cwd(), ".tmp/tmux-container-fixture-"));
  const socketPath = path.join(temporaryRoot, "docker.sock");
  let requestBody: Record<string, unknown> | null = null;
  let listening = false;
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.once("end", () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ Id: "a".repeat(64) }));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        listening = true;
        resolve();
      });
    });
    await expect(createWritableRootlessTmuxContainer(new DockerEngineClient(socketPath), "devspace-tmux-fixture", {
      imageReference: "node:24-bookworm",
      user: testUser,
      labels: { "devspace.test": "persistent-tmux-feasibility" },
      cpuMillicores: 500,
      memoryBytes: 512 * 1024 * 1024,
      pidLimit: 64
    })).resolves.toBe("a".repeat(64));

    expect(requestBody).toMatchObject({
      Image: "node:24-bookworm",
      User: "1000:1000",
      HostConfig: {
        ReadonlyRootfs: false,
        NetworkMode: "none",
        Binds: [],
        Mounts: [],
        Privileged: false,
        CapAdd: [],
        CapDrop: ["ALL"],
        Devices: [],
        SecurityOpt: ["no-new-privileges:true"],
        NanoCpus: 500_000_000,
        Memory: 512 * 1024 * 1024,
        MemorySwap: 512 * 1024 * 1024,
        PidsLimit: 64
      }
    });
  } finally {
    if (listening) await new Promise<void>((resolve, reject) => server.close((error) => error == null ? resolve() : reject(error)));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function waitFor<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  message: string,
  checkpoint: string
): Promise<T> {
  const progress = fixtureFor().progress;
  progress.record(checkpoint, "started", { timeoutMs: commandTimeoutMs });
  const deadline = Date.now() + commandTimeoutMs;
  let value = await progress.run(`${checkpoint}.read`, dockerOperationTimeoutMs, read);
  while (!matches(value) && Date.now() < deadline) {
    await delay(50);
    value = await progress.run(`${checkpoint}.read`, dockerOperationTimeoutMs, read);
  }
  if (!matches(value)) {
    progress.record(checkpoint, "failed", { error: message, lastCompletedCheckpoint: progress.lastCompletedCheckpoint });
    throw new Error(message);
  }
  progress.record(checkpoint, "completed");
  return value;
}

function attachmentText(attachment: TmuxAttachment): string {
  return Buffer.concat(attachment.chunks).toString("utf8");
}

async function waitForAttachmentText(attachment: TmuxAttachment, marker: string, checkpoint: string): Promise<string> {
  const fixture = fixtureFor();
  return await fixture.progress.run(checkpoint, commandTimeoutMs + 1_000, async () => {
    const deadline = Date.now() + commandTimeoutMs;
    while (!attachmentText(attachment).includes(marker) && Date.now() < deadline) {
      if (attachment.streamError !== null && attachment.streamError !== undefined) {
        throw new Error(`rootless-tmux-attachment-stream-failed:${errorMessage(attachment.streamError)}`);
      }
      if (attachment.stream.destroyed) throw new Error(`rootless-tmux-attachment-closed-before:${marker}`);
      await delay(25);
    }
    const text = attachmentText(attachment);
    if (!text.includes(marker)) throw new Error(`rootless-tmux-attachment-marker-timeout:${marker}`);
    return text;
  }, () => attachment.stream.destroy());
}

async function writeAttachment(attachment: TmuxAttachment, text: string, checkpoint: string): Promise<void> {
  await fixtureFor().progress.run(checkpoint, 10_000, () => new Promise<void>((resolve, reject) => {
    attachment.stream.write(Buffer.from(`${text}\r`, "utf8"), (error) => error == null ? resolve() : reject(error));
  }), () => attachment.stream.destroy());
}

async function startAttachment(
  engine: DockerEngineClient,
  containerId: string,
  binaryPath: string,
  socketPath: string,
  configPath: string,
  terminfoPath: string,
  sessionName: string,
  columns: number,
  rows: number
): Promise<TmuxAttachment> {
  const fixture = fixtureFor(containerId);
  const execId = await fixture.progress.run("tmux.attachment.exec-create", dockerOperationTimeoutMs, () => engine.createExec(containerId, {
    command: [binaryPath, "-S", socketPath, "-f", configPath, "attach-session", "-t", sessionName],
    workingDirectory: "/",
    environment: { TERM: "xterm-256color", TERMINFO: terminfoPath, TMUX_TMPDIR: path.posix.dirname(socketPath) },
    attachStdin: true,
    tty: true,
    consoleSize: { columns, rows }
  }));
  fixture.latestExecId = execId;
  fixture.execs.set(execId, "tmux.attach");
  fixture.attachmentExecIds.add(execId);
  fixture.diagnosticExecIds.add(execId);
  fixture.progress.record("tmux.attachment.exec-created", "info", { containerId, execId, sessionName, columns, rows });
  const stream = await fixture.progress.run("tmux.attachment.stream-establish", dockerOperationTimeoutMs,
    () => engine.startExecAttached(execId, true));
  fixture.progress.record("tmux.attachment.stream-established", "completed", { containerId, execId });
  const attachment: TmuxAttachment = { execId, stream, chunks: [], byteLength: 0, streamError: null };
  stream.on("data", (value: unknown) => {
    const bytes = chunkBuffer(value);
    attachment.chunks.push(bytes);
    attachment.byteLength += bytes.length;
    while (attachment.byteLength > 1024 * 1024 && attachment.chunks.length > 1) {
      attachment.byteLength -= attachment.chunks.shift()?.length ?? 0;
    }
  });
  stream.on("error", (error: unknown) => { attachment.streamError = error; });
  activeFixture?.attachments.add(stream);
  stream.once("close", () => activeFixture?.attachments.delete(stream));
  return attachment;
}

async function paneIdentity(engine: DockerEngineClient, containerId: string, binaryPath: string, socketPath: string, configPath: string, sessionName: string): Promise<string> {
  return (await commandOkay(engine, containerId, [
    binaryPath, "-S", socketPath, "-f", configPath, "display-message", "-p", "-t", sessionName,
    "#{session_id}|#{pane_id}|#{pane_pid}|#{pane_width}x#{pane_height}"
  ], "tmux.pane-identity")).trim();
}

async function cleanupContainer(fixture: ActiveFixture, containerId: string): Promise<void> {
  const container = await fixture.progress.run("cleanup.container.inspect", dockerOperationTimeoutMs,
    () => fixture.engine.inspectContainer(containerId));
  if (container.Config.Labels["devspace.test"] !== "persistent-tmux-feasibility"
    || container.Config.Labels["devspace.test-run"] !== fixture.runId) {
    throw new Error("rootless-tmux-refusing-to-remove-unowned-container");
  }
  if (container.State.Running) {
    await fixture.progress.run("cleanup.container.stop", dockerOperationTimeoutMs,
      () => fixture.engine.stopContainer(containerId));
  }
  await fixture.progress.run("cleanup.container.remove", dockerOperationTimeoutMs,
    () => fixture.engine.removeContainer(containerId));
  try {
    await fixture.progress.run("cleanup.container.verify-removed", dockerOperationTimeoutMs,
      () => fixture.engine.inspectContainer(containerId));
    throw new Error("rootless-tmux-container-removal-not-observed");
  } catch (error) {
    if (!(error instanceof DockerEngineError) || error.statusCode !== 404) throw error;
  }
  fixture.containerIds.delete(containerId);
}

async function captureDiagnosticState(fixture: ActiveFixture, reason: string, error?: unknown): Promise<void> {
  const failedAtCheckpoint = fixture.progress.lastCheckpoint;
  const lastCompletedCheckpoint = fixture.progress.lastCompletedCheckpoint;
  fixture.failureCheckpoint = { lastCheckpoint: failedAtCheckpoint, lastCompletedCheckpoint };
  fixture.progress.record("diagnostic.snapshot", "info", {
    reason,
    ...(error === undefined ? {} : { error: errorMessage(error) }),
    failedAtCheckpoint,
    lastCompletedCheckpoint,
    containerIds: [...fixture.containerIds],
    execIds: [...fixture.diagnosticExecIds].map((execId) => ({ execId, operation: fixture.execs.get(execId) ?? "unknown" }))
  });

  for (const containerId of fixture.containerIds) {
    try {
      const container = await fixture.progress.run("diagnostic.container.inspect", diagnosticOperationTimeoutMs,
        () => fixture.engine.inspectContainer(containerId));
      fixture.progress.record("diagnostic.container.state", "info", {
        containerId,
        image: container.Config.Image,
        user: container.Config.User,
        running: container.State.Running,
        status: container.State.Status,
        exitCode: container.State.ExitCode
      });
    } catch (inspectError) {
      fixture.progress.record("diagnostic.container.state-unavailable", "failed", {
        containerId, error: errorMessage(inspectError)
      });
    }
  }

  await Promise.all([...fixture.diagnosticExecIds].map(async (execId) => {
    try {
      const execution = await fixture.progress.run("diagnostic.exec.inspect", diagnosticOperationTimeoutMs,
        () => fixture.engine.inspectExec(execId));
      fixture.progress.record("diagnostic.exec.state", "info", {
        execId,
        operation: fixture.execs.get(execId) ?? "unknown",
        containerId: execution.ContainerID,
        running: execution.Running,
        exitCode: execution.ExitCode
      });
    } catch (inspectError) {
      fixture.progress.record("diagnostic.exec.state-unavailable", "failed", {
        execId, operation: fixture.execs.get(execId) ?? "unknown", error: errorMessage(inspectError)
      });
    }
  }));
}

afterEach(async () => {
  const fixture = activeFixture;
  if (fixture === null) return;
  let cleanupError: unknown;
  await captureDiagnosticState(fixture, "before-disposable-container-cleanup");
  fixture.progress.record("cleanup.begin", "info", {
    lastCompletedCheckpoint: fixture.progress.lastCompletedCheckpoint,
    containerIds: [...fixture.containerIds]
  });
  for (const stream of fixture.commandStreams) stream.destroy();
  for (const attachment of fixture.attachments) attachment.destroy();
  for (const containerId of fixture.containerIds) {
    try { await cleanupContainer(fixture, containerId); }
    catch (error) {
      if (error instanceof DockerEngineError && error.statusCode === 404) {
        fixture.containerIds.delete(containerId);
        continue;
      }
      cleanupError ??= error;
    }
  }
  for (const temporaryRoot of fixture.temporaryRoots) {
    try {
      await fixture.progress.run("cleanup.archive-temporary-root", 10_000,
        () => rm(temporaryRoot, { recursive: true, force: true }));
      fixture.temporaryRoots.delete(temporaryRoot);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  fixture.progress.record("cleanup.finished", cleanupError === undefined ? "completed" : "failed", {
    remainingContainerIds: [...fixture.containerIds],
    ...(cleanupError === undefined ? {} : { error: errorMessage(cleanupError) })
  });
  activeFixture = null;
  if (cleanupError !== undefined) {
    throw cleanupError instanceof Error ? cleanupError : new Error("rootless-tmux-fixture-cleanup-failed", { cause: cleanupError });
  }
}, 90_000);

test.skipIf(dockerSocketPath === undefined || tmuxBinaryPath === undefined || tmuxTerminfoPath === undefined)
  .each(testImages)("real rootless Docker preserves the tmux shell across disposable exec clients (%s)", async (imageReference) => {
    if (dockerSocketPath === undefined || tmuxBinaryPath === undefined || tmuxTerminfoPath === undefined) {
      throw new Error("DEVSPACE_TEST_DOCKER_SOCKET_PATH and pinned tmux artifact paths are required; no Docker socket fallback is permitted.");
    }
    const startedAt = performance.now();
    const engine = new DockerEngineClient(dockerSocketPath);
    const runId = randomUUID();
    const progress = new ProbeProgress(imageReference, process.env.DEVSPACE_TEST_TMUX_PROGRESS_FILE);
    const fixture: ActiveFixture = {
      engine,
      runId,
      progress,
      containerIds: new Set(),
      attachments: new Set(),
      commandStreams: new Set(),
      temporaryRoots: new Set(),
      execs: new Map(),
      attachmentExecIds: new Set(),
      diagnosticExecIds: new Set(),
      latestExecId: null,
      failureCheckpoint: null
    };
    activeFixture = fixture;
    progress.record("probe.started", "info", { runId, dockerSocketPath });
    onTestFailed(({ task }) => {
      const result = task.result as unknown as {
        readonly state?: string;
        readonly errors?: readonly { readonly name?: string; readonly message?: string; readonly stack?: string }[];
      } | undefined;
      progress.record("probe.test-failed", "failed", {
        state: result?.state,
        lastCompletedCheckpoint: fixture.failureCheckpoint?.lastCompletedCheckpoint ?? progress.lastCompletedCheckpoint,
        lastCheckpoint: fixture.failureCheckpoint?.lastCheckpoint ?? progress.lastCheckpoint,
        errors: (result?.errors ?? []).map((error) => ({
          name: error.name,
          message: error.message,
          stack: error.stack?.slice(0, 2_000)
        }))
      });
    });
    await progress.run("docker.daemon.assert-rootless", dockerOperationTimeoutMs, () => engine.assertRootlessAvailable());
    await progress.run("docker.image.ensure", dockerOperationTimeoutMs, () => engine.ensureImage(imageReference));
    const image = await progress.run("docker.image.inspect", dockerOperationTimeoutMs, () => engine.inspectImage(imageReference));
    expect(image).toMatchObject({ Os: "linux", Architecture: "amd64" });
    progress.record("docker.image.verified", "info", { imageReference, imageId: image.Id, architecture: image.Architecture });

    const role = imageReference.endsWith("-slim") ? "slim" : "bookworm";
    const containerName = `devspace-tmux-${runId.slice(0, 8)}-${role}`;
    const labels = {
      "devspace.test": "persistent-tmux-feasibility",
      "devspace.test-run": runId,
      "devspace.test-image": imageReference
    };
    const containerId = await progress.run("docker.container.create", dockerOperationTimeoutMs, () => createWritableRootlessTmuxContainer(engine, containerName, {
      imageReference,
      user: testUser,
      labels,
      cpuMillicores: 500,
      memoryBytes: 512 * 1024 * 1024,
      pidLimit: 64
    }));
    fixture.containerIds.add(containerId);
    progress.record("docker.container.created", "info", { containerId, containerName, imageReference, executionUser: testUser });
    await progress.run("docker.container.start", dockerOperationTimeoutMs, () => engine.startContainer(containerId));
    progress.record("docker.container.started", "info", { containerId });
    const container = await progress.run("docker.container.inspect-after-start", dockerOperationTimeoutMs,
      () => engine.inspectContainer(containerId));
    progress.record("docker.container.state", "info", {
      containerId, image: container.Config.Image, user: container.Config.User,
      running: container.State.Running, status: container.State.Status
    });
    expect(container.Config.User).toBe(testUser);
    expect(container.HostConfig).toMatchObject({
      Privileged: false, NetworkMode: "none", ReadonlyRootfs: false,
      NanoCpus: 500_000_000, Memory: 512 * 1024 * 1024, MemorySwap: 512 * 1024 * 1024, PidsLimit: 64,
      CapAdd: [], CapDrop: ["ALL"], Devices: [], SecurityOpt: ["no-new-privileges:true"]
    });
    expect(container.Mounts.filter((mount) => mount.Type === "bind")).toEqual([]);
    expect(await commandOkay(engine, containerId, ["id", "-u"], "container.identity.uid")).toBe("1000\n");
    expect(await commandOkay(engine, containerId, ["id", "-g"], "container.identity.gid")).toBe("1000\n");

    const directoryName = `persistent-tmux-${runId}`;
    const artifactRoot = `/opt/${directoryName}`;
    const binaryPath = `${artifactRoot}/tmux`;
    const configPath = `${artifactRoot}/tmux.conf`;
    const terminfoPath = `${artifactRoot}/terminfo`;
    const socketDirectory = `${artifactRoot}/socket`;
    const socketPath = `${socketDirectory}/server.sock`;
    const sessionName = `shell-${runId.slice(0, 8)}`;
    progress.record("artifact.stage.started", "started", { containerId, destination: "/opt" });
    const archiveTemporaryRoot = await progress.run("artifact.archive-temporary-root.create", dockerOperationTimeoutMs,
      () => mkdtemp(path.join(tmpdir(), "devspace-tmux-probe-")));
    fixture.temporaryRoots.add(archiveTemporaryRoot);
    const archivePath = path.join(archiveTemporaryRoot, "tmux-artifacts.tar");
    const archiveWriteAbort = new AbortController();
    await progress.run("artifact.archive.generate-and-write", commandTimeoutMs,
      () => writeArtifactArchiveFile(runId, archivePath, archiveWriteAbort.signal),
      () => archiveWriteAbort.abort(new Error("rootless-tmux-archive-generation-timeout")));
    const archiveFile = await progress.run("artifact.archive.stat", dockerOperationTimeoutMs, () => stat(archivePath));
    if (archiveFile.size < 2_200_000 || archiveFile.size > 4 * 1024 * 1024) {
      throw new Error(`rootless-tmux-archive-size-invalid:${archiveFile.size}`);
    }
    progress.record("artifact.archive.file-created", "completed", {
      archiveBytes: archiveFile.size, mode: archiveFile.mode & 0o777
    });
    const archiveBytes = await progress.run("artifact.archive.read-for-validation", dockerOperationTimeoutMs,
      () => readFile(archivePath));
    const archiveValidationAbort = new AbortController();
    const archiveValidation = await progress.run("artifact.archive.validate", commandTimeoutMs,
      () => validateArtifactArchive(archiveBytes, runId, archiveValidationAbort.signal),
      () => archiveValidationAbort.abort(new Error("rootless-tmux-archive-validation-timeout")));
    progress.record("artifact.archive.verified", "completed", { ...archiveValidation, archiveBytes: archiveBytes.length });

    const upload = createReadStream(archivePath);
    upload.once("end", () => progress.record("artifact.upload.source-eof", "completed", {
      containerId, archiveBytes: upload.bytesRead
    }));
    upload.once("error", (error: Error) => progress.record("artifact.upload.source-error", "failed", {
      containerId, archiveBytes: upload.bytesRead, error: errorMessage(error)
    }));
    const uploadOperation = engine.putContainerArchive(containerId, "/opt", upload, 30_000);
    try {
      await progress.run("artifact.stage.docker-archive-put", dockerOperationTimeoutMs,
        () => uploadOperation,
        () => {
          progress.record("artifact.upload.cancel-requested", "info", {
            containerId, archiveBytes: upload.bytesRead, sourceEnded: upload.readableEnded
          });
          upload.destroy(new Error("rootless-tmux-docker-archive-put-cancelled"));
        });
    } catch (error) {
      await Promise.race([uploadOperation.then(() => undefined, () => undefined), delay(1_000)]);
      throw error;
    } finally {
      if (!upload.destroyed) upload.destroy();
    }
    progress.record("artifact.stage.docker-response", "completed", {
      containerId, archiveBytes: upload.bytesRead, sourceEnded: upload.readableEnded
    });
    progress.record("artifact.stage.completed", "completed", { containerId, destination: "/opt" });
    expect(await commandOkay(engine, containerId, ["id", "-u"], "artifact.verify.exec-uid")).toBe("1000\n");
    expect(await commandOkay(engine, containerId, ["id", "-g"], "artifact.verify.exec-gid")).toBe("1000\n");
    expect(await commandOkay(engine, containerId, ["sha256sum", "--", binaryPath], "artifact.verify.binary-sha256"))
      .toContain(tmuxBinarySha256);
    expect(await commandOkay(engine, containerId, ["stat", "-c", "%a %u:%g", artifactRoot], "artifact.verify.root-ownership"))
      .toBe("700 1000:1000\n");
    expect(await commandOkay(engine, containerId, [binaryPath, "-V"], "artifact.verify.tmux-version")).toBe("tmux 3.7c\n");
    expect(await commandOkay(engine, containerId, ["stat", "-c", "%a %u:%g", binaryPath], "artifact.verify.binary-ownership"))
      .toBe("755 1000:1000\n");
    expect(await commandOkay(engine, containerId, ["stat", "-c", "%a %u:%g", configPath], "artifact.verify.config-ownership"))
      .toBe("600 1000:1000\n");
    for (const name of ["xterm-256color", "tmux-256color"]) {
      const entry = (await collectFiles(tmuxTerminfoPath)).find((candidate) => path.posix.basename(candidate.relativePath) === name);
      if (entry === undefined) throw new Error(`rootless-tmux-terminfo-entry-missing:${name}`);
      const stagedPath = `${terminfoPath}/${entry.relativePath}`;
      expect(await commandOkay(engine, containerId, ["test", "-s", stagedPath], `artifact.verify.terminfo.${name}.exists`)).toBe("");
      expect(await commandOkay(engine, containerId, ["stat", "-c", "%a %u:%g", stagedPath], `artifact.verify.terminfo.${name}.metadata`))
        .toBe("644 1000:1000\n");
    }
    await commandOkay(engine, containerId, ["mkdir", "-m", "700", "--", socketDirectory], "tmux.socket-directory.create");
    expect(await commandOkay(engine, containerId, ["stat", "-c", "%a %u:%g", socketDirectory], "tmux.socket-directory.verify"))
      .toBe("700 1000:1000\n");

    progress.record("tmux.session-create.started", "started", { containerId, sessionName, shell: "/bin/sh -i" });
    const creation = await containerCommand(engine, containerId, [
      binaryPath, "-S", socketPath, "-f", configPath,
      "new-session", "-d", "-s", sessionName, "-x", "80", "-y", "24", "/bin/sh", "-i"
    ], { TERM: "xterm-256color", TERMINFO: terminfoPath, TMUX_TMPDIR: socketDirectory }, "tmux.session-create");
    progress.record("tmux.session-create.completed", "completed", { containerId, execId: creation.execId, exitCode: creation.exitCode });
    expect(creation.exitCode).toBe(0);
    const socketInfo = (await commandOkay(engine, containerId, ["stat", "-c", "%F %a %u:%g", socketPath],
      "tmux.socket.verify-owner-mode")).trim().split(" ");
    expect(socketInfo[0]).toBe("socket");
    expect(socketInfo[2]).toBe("1000:1000");
    const socketMode = Number.parseInt(socketInfo[1] ?? "", 8);
    expect(Number.isInteger(socketMode) && (socketMode & 0o600) === 0o600 && (socketMode & 0o077) === 0).toBe(true);

    const identityBefore = await paneIdentity(engine, containerId, binaryPath, socketPath, configPath, sessionName);
    const [sessionId, paneId, shellPid] = identityBefore.split("|");
    progress.record("tmux.session.identity", "info", { containerId, sessionId, paneId, shellPid, identity: identityBefore });
    expect(sessionId).toMatch(/^\$[0-9]+$/u);
    expect(paneId).toMatch(/^%[0-9]+$/u);
    expect(shellPid).toMatch(/^[1-9][0-9]*$/u);
    const first = await startAttachment(engine, containerId, binaryPath, socketPath, configPath, terminfoPath, sessionName, 80, 24);
    expect((await progress.run("tmux.first-attachment.inspect-exec", dockerOperationTimeoutMs,
      () => engine.inspectExec(first.execId))).Running).toBe(true);

    await writeAttachment(first, "printf 'SHELL_PID=%s\\n' \"$$\"; printf 'SHELL_TERM=%s\\n' \"$TERM\"",
      "tmux.first-attachment.write-pid-term");
    await waitForAttachmentText(first, `SHELL_PID=${shellPid}`, "tmux.first-attachment.read-pid");
    await waitForAttachmentText(first, "SHELL_TERM=tmux-256color", "tmux.first-attachment.read-term");
    await progress.run("tmux.first-attachment.resize", dockerOperationTimeoutMs,
      () => engine.resizeExec(first.execId, 100, 32));
    const resizedIdentity = await waitFor(
      async () => await paneIdentity(engine, containerId, binaryPath, socketPath, configPath, sessionName),
      (value) => value.endsWith("100x32"),
      "rootless-tmux-pane-did-not-follow-docker-exec-resize",
      "tmux.first-attachment.resize-confirm"
    );
    expect(resizedIdentity.split("|").slice(0, 3).join("|")).toBe(identityBefore.split("|").slice(0, 3).join("|"));
    await writeAttachment(first, "printf 'RESIZE_STTY=%s\\n' \"$(stty size)\"", "tmux.first-attachment.write-resize-check");
    await waitForAttachmentText(first, "RESIZE_STTY=32 100", "tmux.first-attachment.read-resize-check");

    await writeAttachment(first,
      "i=1; while [ \"$i\" -le 100 ]; do printf 'HISTORY_LINE_%03d\\n' \"$i\"; i=$((i + 1)); done; printf 'HISTORY_DONE\\n'",
      "tmux.first-attachment.write-history");
    await waitForAttachmentText(first, "HISTORY_DONE", "tmux.first-attachment.read-history-complete");
    const history = await commandOkay(engine, containerId, [
      binaryPath, "-S", socketPath, "-f", configPath, "capture-pane", "-p", "-S", "-", "-t", sessionName
    ]);
    expect(history).toContain("HISTORY_LINE_001");
    expect(history).toContain("HISTORY_LINE_100");
    await commandOkay(engine, containerId, [binaryPath, "-S", socketPath, "-f", configPath, "copy-mode", "-t", sessionName]);
    expect(await commandOkay(engine, containerId, [
      binaryPath, "-S", socketPath, "-f", configPath, "display-message", "-p", "-t", sessionName, "#{pane_in_mode}"
    ])).toBe("1\n");
    await commandOkay(engine, containerId, [binaryPath, "-S", socketPath, "-f", configPath, "send-keys", "-X", "-t", sessionName, "cancel"]);
    expect(await commandOkay(engine, containerId, [
      binaryPath, "-S", socketPath, "-f", configPath, "display-message", "-p", "-t", sessionName, "#{pane_in_mode}"
    ])).toBe("0\n");

    await writeAttachment(first, "printf '\\033[2J\\033[HDEVSPACE_SCREEN_MARKER\\n'; printf 'SHELL_PID=%s\\n' \"$$\"",
      "tmux.first-attachment.write-screen-marker");
    const firstScreen = await waitForAttachmentText(first, "DEVSPACE_SCREEN_MARKER", "tmux.first-attachment.read-screen-marker");
    expect(firstScreen).toContain(`SHELL_PID=${shellPid}`);
    expect(await commandOkay(engine, containerId, [
      binaryPath, "-S", socketPath, "-f", configPath, "capture-pane", "-p", "-S", "-", "-t", sessionName
    ])).toContain("DEVSPACE_SCREEN_MARKER");

    const clientPidText = await commandOkay(engine, containerId, [
      binaryPath, "-S", socketPath, "-f", configPath, "list-clients", "-t", sessionName, "-F", "#{client_pid}"
    ]);
    const clientPid = clientPidText.trim();
    expect(clientPid).toMatch(/^[1-9][0-9]*$/u);
    await commandOkay(engine, containerId, ["/bin/sh", "-c", "kill -KILL \"$1\"", "sh", clientPid]);
    await waitFor(async () => (await progress.run("docker.exec.first-attachment.inspect", dockerOperationTimeoutMs,
      () => engine.inspectExec(first.execId))).Running, (running) => !running,
    "rootless-tmux-first-docker-exec-client-did-not-exit", "tmux.first-attachment.detach-confirm");
    await waitFor(
      async () => await commandOkay(engine, containerId, [binaryPath, "-S", socketPath, "-f", configPath,
        "list-clients", "-t", sessionName, "-F", "#{client_pid}"]),
      (value) => value.trim() === "",
      "rootless-tmux-client-remained-attached-after-termination",
      "tmux.first-attachment.detach-client-confirm"
    );
    const detachedIdentity = await paneIdentity(engine, containerId, binaryPath, socketPath, configPath, sessionName);
    expect(detachedIdentity.split("|").slice(0, 3).join("|")).toBe(identityBefore.split("|").slice(0, 3).join("|"));
    expect(detachedIdentity).toBe(resizedIdentity);

    const second = await startAttachment(engine, containerId, binaryPath, socketPath, configPath, terminfoPath, sessionName, 100, 32);
    expect(second.execId).not.toBe(first.execId);
    const redrawn = await waitForAttachmentText(second, "DEVSPACE_SCREEN_MARKER", "tmux.second-attachment.redraw");
    expect(redrawn.includes(`${String.fromCharCode(27)}[`)).toBe(true);
    expect(await paneIdentity(engine, containerId, binaryPath, socketPath, configPath, sessionName)).toBe(resizedIdentity);
    const retainedHistory = await commandOkay(engine, containerId, [
      binaryPath, "-S", socketPath, "-f", configPath, "capture-pane", "-p", "-S", "-", "-t", sessionName
    ]);
    expect(retainedHistory).toContain("HISTORY_LINE_001");
    expect(retainedHistory).toContain("HISTORY_LINE_100");
    await commandOkay(engine, containerId, [binaryPath, "-S", socketPath, "-f", configPath, "copy-mode", "-t", sessionName]);
    expect(await commandOkay(engine, containerId, [
      binaryPath, "-S", socketPath, "-f", configPath, "display-message", "-p", "-t", sessionName, "#{pane_in_mode}"
    ])).toBe("1\n");
    await commandOkay(engine, containerId, [binaryPath, "-S", socketPath, "-f", configPath, "send-keys", "-X", "-t", sessionName, "cancel"]);
    await writeAttachment(second, "printf 'REATTACHED_INPUT_OK\\n'", "tmux.second-attachment.write-input");
    await waitForAttachmentText(second, "REATTACHED_INPUT_OK", "tmux.second-attachment.read-input");

    const stoppedAt = performance.now();
    await progress.run("docker.container.stop", dockerOperationTimeoutMs, () => engine.stopContainer(containerId));
    expect((await progress.run("docker.container.inspect-after-stop", dockerOperationTimeoutMs,
      () => engine.inspectContainer(containerId))).State.Running).toBe(false);
    await waitFor(async () => (await progress.run("docker.exec.second-attachment.inspect", dockerOperationTimeoutMs,
      () => engine.inspectExec(second.execId))).Running, (running) => !running,
    "rootless-tmux-attachment-remained-running-after-container-stop", "docker.container-stop.attachment-exit");
    second.stream.destroy();
    let stoppedAttachRejected = false;
    try {
      await progress.run("docker.exec.create-after-container-stop", dockerOperationTimeoutMs, () => engine.createExec(containerId, {
        command: [binaryPath, "-S", socketPath, "-f", configPath, "attach-session", "-t", sessionName],
        workingDirectory: "/", environment: { TERM: "xterm-256color", TERMINFO: terminfoPath },
        attachStdin: true, tty: true, consoleSize: { columns: 100, rows: 32 }
      }));
    } catch (error) {
      if (!(error instanceof DockerEngineError) || ![404, 409].includes(error.statusCode)) throw error;
      stoppedAttachRejected = true;
    }
    expect(stoppedAttachRejected).toBe(true);
    const stopElapsedMs = Math.round(performance.now() - stoppedAt);

    const elapsedMs = Math.round(performance.now() - startedAt);
    progress.record("tmux.feasibility-assertions.completed", "completed", {
      containerId, sessionId, paneId, shellPid, firstAttachExecId: first.execId, secondAttachExecId: second.execId,
      resize: "100x32", historyLines: 100, stopElapsedMs, elapsedMs
    });
    const evidence = {
      image: imageReference,
      architecture: image.Architecture,
      containerId,
      executionUser: testUser,
      tmuxVersion: "3.7c",
      archiveSha256: tmuxArchiveSha256,
      binarySha256: tmuxBinarySha256,
      sessionId,
      paneId,
      shellPid,
      creationExecId: creation.execId,
      firstAttachExecId: first.execId,
      secondAttachExecId: second.execId,
      resize: "100x32",
      historyLines: 100,
      stopElapsedMs,
      elapsedMs
    };
    console.log(`ROOTLESS_TMUX_FEASIBILITY ${JSON.stringify(evidence)}`);
    if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, [
        `### Rootless tmux feasibility: ${imageReference}`,
        "",
        `- Container: \`${containerId}\` (${testUser}, linux/${image.Architecture})`,
        `- Session/pane: \`${sessionId}\` / \`${paneId}\`; shell PID remained \`${shellPid}\` across execs \`${first.execId}\` and \`${second.execId}\`.`,
        `- tmux 3.7c artifact SHA-256: \`${tmuxArchiveSha256}\` archive, \`${tmuxBinarySha256}\` binary.`,
        `- Verified 100 history lines, input, redraw, resize to 100×32, Stop rejection in ${stopElapsedMs} ms.`,
        `- Probe elapsed: ${elapsedMs} ms.`,
        ""
      ].join("\n"), "utf8");
    }
    await cleanupContainer(fixture, containerId);
  }, 300_000);
