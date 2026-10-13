import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Readable } from "node:stream";
import * as tar from "tar-stream";
import { afterEach, expect, test } from "vitest";
import { DockerEngineClient, DockerEngineError } from "./docker-runtime.js";

const dockerSocketPath = process.env.DEVSPACE_TEST_DOCKER_SOCKET_PATH;
const tmuxBinaryPath = process.env.DEVSPACE_TEST_TMUX_BINARY_PATH;
const tmuxTerminfoPath = process.env.DEVSPACE_TEST_TMUX_TERMINFO_PATH;
const tmuxArchiveSha256 = "cc56bd1cc873eb6089c615f0496b072385bda8a6d944069f38564a5d49c128aa";
const tmuxBinarySha256 = "7d0f1e85c5b11df7fe127ab90674c6a15663ad72a25fcf7fabadba6bbb0b29d5";
const testImages = ["node:24-bookworm", "node:24-bookworm-slim"] as const;
const testUser = "1000:1000";
const commandTimeoutMs = 15_000;

interface ActiveFixture {
  readonly engine: DockerEngineClient;
  readonly runId: string;
  readonly containerIds: Set<string>;
  readonly attachments: Set<import("node:stream").Duplex>;
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
  environment: Readonly<Record<string, string>> = {}
): Promise<DockerCommandResult> {
  const execId = await engine.createExec(containerId, {
    command, workingDirectory: "/", environment, attachStdin: false, tty: false
  });
  const stream = await engine.startExecAttached(execId, false);
  const chunks: Buffer[] = [];
  for await (const value of stream) chunks.push(chunkBuffer(value as unknown));
  const output = decodeDockerFrames(Buffer.concat(chunks));
  const inspection = await engine.inspectExec(execId);
  if (inspection.Running || inspection.ExitCode === null) throw new Error("rootless-tmux-docker-exec-did-not-finish");
  return { execId, ...output, exitCode: inspection.ExitCode };
}

async function commandOkay(engine: DockerEngineClient, containerId: string, command: readonly string[]): Promise<string> {
  const result = await containerCommand(engine, containerId, command);
  if (result.exitCode !== 0) {
    throw new Error(`rootless-tmux-container-command-failed:${command[0] ?? "unknown"}:${result.exitCode}:${result.stderr.slice(0, 300)}`);
  }
  return result.stdout;
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

async function waitFor<T>(read: () => Promise<T>, matches: (value: T) => boolean, message: string): Promise<T> {
  const deadline = Date.now() + commandTimeoutMs;
  let value = await read();
  while (!matches(value) && Date.now() < deadline) {
    await delay(50);
    value = await read();
  }
  if (!matches(value)) throw new Error(message);
  return value;
}

function attachmentText(attachment: TmuxAttachment): string {
  return Buffer.concat(attachment.chunks).toString("utf8");
}

async function waitForAttachmentText(attachment: TmuxAttachment, marker: string): Promise<string> {
  const deadline = Date.now() + commandTimeoutMs;
  while (!attachmentText(attachment).includes(marker) && Date.now() < deadline) {
    if (attachment.streamError !== null && attachment.streamError !== undefined) {
      const detail = attachment.streamError instanceof Error
        ? attachment.streamError.message
        : typeof attachment.streamError === "string" ? attachment.streamError : "unknown-stream-error";
      throw new Error(`rootless-tmux-attachment-stream-failed:${detail}`);
    }
    if (attachment.stream.destroyed) throw new Error(`rootless-tmux-attachment-closed-before:${marker}`);
    await delay(25);
  }
  const text = attachmentText(attachment);
  if (!text.includes(marker)) throw new Error(`rootless-tmux-attachment-marker-timeout:${marker}`);
  return text;
}

async function writeAttachment(attachment: TmuxAttachment, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    attachment.stream.write(Buffer.from(`${text}\r`, "utf8"), (error) => error == null ? resolve() : reject(error));
  });
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
  const execId = await engine.createExec(containerId, {
    command: [binaryPath, "-S", socketPath, "-f", configPath, "attach-session", "-t", sessionName],
    workingDirectory: "/",
    environment: { TERM: "xterm-256color", TERMINFO: terminfoPath, TMUX_TMPDIR: path.posix.dirname(socketPath) },
    attachStdin: true,
    tty: true,
    consoleSize: { columns, rows }
  });
  const stream = await engine.startExecAttached(execId, true);
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
  ])).trim();
}

async function cleanupContainer(fixture: ActiveFixture, containerId: string): Promise<void> {
  const container = await fixture.engine.inspectContainer(containerId);
  if (container.Config.Labels["devspace.test"] !== "persistent-tmux-feasibility"
    || container.Config.Labels["devspace.test-run"] !== fixture.runId) {
    throw new Error("rootless-tmux-refusing-to-remove-unowned-container");
  }
  if (container.State.Running) await fixture.engine.stopContainer(containerId);
  await fixture.engine.removeContainer(containerId);
  try {
    await fixture.engine.inspectContainer(containerId);
    throw new Error("rootless-tmux-container-removal-not-observed");
  } catch (error) {
    if (!(error instanceof DockerEngineError) || error.statusCode !== 404) throw error;
  }
  fixture.containerIds.delete(containerId);
}

afterEach(async () => {
  const fixture = activeFixture;
  if (fixture === null) return;
  let cleanupError: unknown;
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
  activeFixture = null;
  if (cleanupError !== undefined) {
    throw cleanupError instanceof Error ? cleanupError : new Error("rootless-tmux-fixture-cleanup-failed", { cause: cleanupError });
  }
});

test.skipIf(dockerSocketPath === undefined || tmuxBinaryPath === undefined || tmuxTerminfoPath === undefined)
  .each(testImages)("real rootless Docker preserves the tmux shell across disposable exec clients (%s)", async (imageReference) => {
    if (dockerSocketPath === undefined || tmuxBinaryPath === undefined || tmuxTerminfoPath === undefined) {
      throw new Error("DEVSPACE_TEST_DOCKER_SOCKET_PATH and pinned tmux artifact paths are required; no Docker socket fallback is permitted.");
    }
    const startedAt = performance.now();
    const engine = new DockerEngineClient(dockerSocketPath);
    await engine.assertRootlessAvailable();
    const runId = randomUUID();
    const fixture: ActiveFixture = { engine, runId, containerIds: new Set(), attachments: new Set() };
    activeFixture = fixture;
    await engine.ensureImage(imageReference);
    const image = await engine.inspectImage(imageReference);
    expect(image).toMatchObject({ Os: "linux", Architecture: "amd64" });

    const role = imageReference.endsWith("-slim") ? "slim" : "bookworm";
    const containerName = `devspace-tmux-${runId.slice(0, 8)}-${role}`;
    const labels = {
      "devspace.test": "persistent-tmux-feasibility",
      "devspace.test-run": runId,
      "devspace.test-image": imageReference
    };
    const containerId = await engine.createProbeContainer(containerName, {
      imageId: image.Id,
      imageReference,
      user: testUser,
      labels,
      environment: {},
      cpuMillicores: 500,
      memoryBytes: 512 * 1024 * 1024,
      pidLimit: 64
    });
    fixture.containerIds.add(containerId);
    await engine.startContainer(containerId);
    const container = await engine.inspectContainer(containerId);
    expect(container.Config.User).toBe(testUser);
    expect(container.HostConfig).toMatchObject({ Privileged: false, NetworkMode: "none" });
    expect(await commandOkay(engine, containerId, ["id", "-u"])).toBe("1000\n");
    expect(await commandOkay(engine, containerId, ["id", "-g"])).toBe("1000\n");

    const directoryName = `persistent-tmux-${runId}`;
    const artifactRoot = `/opt/devspace-codex-probe/${directoryName}`;
    const binaryPath = `${artifactRoot}/tmux`;
    const configPath = `${artifactRoot}/tmux.conf`;
    const terminfoPath = `${artifactRoot}/terminfo`;
    const socketDirectory = `${artifactRoot}/socket`;
    const socketPath = `${socketDirectory}/server.sock`;
    const sessionName = `shell-${runId.slice(0, 8)}`;
    await commandOkay(engine, containerId, ["mkdir", "-m", "700", "--", artifactRoot]);
    await engine.putContainerArchive(containerId, "/opt/devspace-codex-probe", artifactArchive(runId), 30_000);
    expect(await commandOkay(engine, containerId, ["sha256sum", "--", binaryPath])).toContain(tmuxBinarySha256);
    expect(await commandOkay(engine, containerId, [binaryPath, "-V"])).toBe("tmux 3.7c\n");
    expect(await commandOkay(engine, containerId, ["stat", "-c", "%a %u:%g", binaryPath])).toBe("755 1000:1000\n");
    for (const name of ["xterm-256color", "tmux-256color"]) {
      const entry = (await collectFiles(tmuxTerminfoPath)).find((candidate) => path.posix.basename(candidate.relativePath) === name);
      if (entry === undefined) throw new Error(`rootless-tmux-terminfo-entry-missing:${name}`);
      const stagedPath = `${terminfoPath}/${entry.relativePath}`;
      expect(await commandOkay(engine, containerId, ["test", "-s", stagedPath])).toBe("");
      expect(await commandOkay(engine, containerId, ["stat", "-c", "%u:%g", stagedPath])).toBe("1000:1000\n");
    }
    await commandOkay(engine, containerId, ["mkdir", "-m", "700", "--", socketDirectory]);
    expect(await commandOkay(engine, containerId, ["stat", "-c", "%a %u:%g", socketDirectory])).toBe("700 1000:1000\n");

    const creation = await containerCommand(engine, containerId, [
      binaryPath, "-S", socketPath, "-f", configPath,
      "new-session", "-d", "-s", sessionName, "-x", "80", "-y", "24", "/bin/sh", "-i"
    ], { TERM: "xterm-256color", TERMINFO: terminfoPath, TMUX_TMPDIR: socketDirectory });
    expect(creation.exitCode).toBe(0);
    const socketInfo = (await commandOkay(engine, containerId, ["stat", "-c", "%F %a %u:%g", socketPath])).trim().split(" ");
    expect(socketInfo[0]).toBe("socket");
    expect(socketInfo[2]).toBe("1000:1000");
    const socketMode = Number.parseInt(socketInfo[1] ?? "", 8);
    expect(Number.isInteger(socketMode) && (socketMode & 0o600) === 0o600 && (socketMode & 0o077) === 0).toBe(true);

    const identityBefore = await paneIdentity(engine, containerId, binaryPath, socketPath, configPath, sessionName);
    const [sessionId, paneId, shellPid] = identityBefore.split("|");
    expect(sessionId).toMatch(/^\$[0-9]+$/u);
    expect(paneId).toMatch(/^%[0-9]+$/u);
    expect(shellPid).toMatch(/^[1-9][0-9]*$/u);
    const first = await startAttachment(engine, containerId, binaryPath, socketPath, configPath, terminfoPath, sessionName, 80, 24);
    expect((await engine.inspectExec(first.execId)).Running).toBe(true);

    await writeAttachment(first, "printf 'SHELL_PID=%s\\n' \"$$\"; printf 'SHELL_TERM=%s\\n' \"$TERM\"");
    await waitForAttachmentText(first, `SHELL_PID=${shellPid}`);
    await waitForAttachmentText(first, "SHELL_TERM=tmux-256color");
    await engine.resizeExec(first.execId, 100, 32);
    const resizedIdentity = await waitFor(
      async () => await paneIdentity(engine, containerId, binaryPath, socketPath, configPath, sessionName),
      (value) => value.endsWith("100x32"),
      "rootless-tmux-pane-did-not-follow-docker-exec-resize"
    );
    expect(resizedIdentity.split("|").slice(0, 3).join("|")).toBe(identityBefore.split("|").slice(0, 3).join("|"));
    await writeAttachment(first, "printf 'RESIZE_STTY=%s\\n' \"$(stty size)\"");
    await waitForAttachmentText(first, "RESIZE_STTY=32 100");

    await writeAttachment(first,
      "i=1; while [ \"$i\" -le 100 ]; do printf 'HISTORY_LINE_%03d\\n' \"$i\"; i=$((i + 1)); done; printf 'HISTORY_DONE\\n'");
    await waitForAttachmentText(first, "HISTORY_DONE");
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

    await writeAttachment(first, "printf '\\033[2J\\033[HDEVSPACE_SCREEN_MARKER\\n'; printf 'SHELL_PID=%s\\n' \"$$\"");
    const firstScreen = await waitForAttachmentText(first, "DEVSPACE_SCREEN_MARKER");
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
    await waitFor(async () => (await engine.inspectExec(first.execId)).Running, (running) => !running,
      "rootless-tmux-first-docker-exec-client-did-not-exit");
    await waitFor(
      async () => await commandOkay(engine, containerId, [binaryPath, "-S", socketPath, "-f", configPath,
        "list-clients", "-t", sessionName, "-F", "#{client_pid}"]),
      (value) => value.trim() === "",
      "rootless-tmux-client-remained-attached-after-termination"
    );
    const detachedIdentity = await paneIdentity(engine, containerId, binaryPath, socketPath, configPath, sessionName);
    expect(detachedIdentity.split("|").slice(0, 3).join("|")).toBe(identityBefore.split("|").slice(0, 3).join("|"));
    expect(detachedIdentity).toBe(resizedIdentity);

    const second = await startAttachment(engine, containerId, binaryPath, socketPath, configPath, terminfoPath, sessionName, 100, 32);
    expect(second.execId).not.toBe(first.execId);
    const redrawn = await waitForAttachmentText(second, "DEVSPACE_SCREEN_MARKER");
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
    await writeAttachment(second, "printf 'REATTACHED_INPUT_OK\\n'");
    await waitForAttachmentText(second, "REATTACHED_INPUT_OK");

    const stoppedAt = performance.now();
    await engine.stopContainer(containerId);
    expect((await engine.inspectContainer(containerId)).State.Running).toBe(false);
    await waitFor(async () => (await engine.inspectExec(second.execId)).Running, (running) => !running,
      "rootless-tmux-attachment-remained-running-after-container-stop");
    second.stream.destroy();
    let stoppedAttachRejected = false;
    try {
      await engine.createExec(containerId, {
        command: [binaryPath, "-S", socketPath, "-f", configPath, "attach-session", "-t", sessionName],
        workingDirectory: "/", environment: { TERM: "xterm-256color", TERMINFO: terminfoPath },
        attachStdin: true, tty: true, consoleSize: { columns: 100, rows: 32 }
      });
    } catch (error) {
      if (!(error instanceof DockerEngineError) || ![404, 409].includes(error.statusCode)) throw error;
      stoppedAttachRejected = true;
    }
    expect(stoppedAttachRejected).toBe(true);
    const stopElapsedMs = Math.round(performance.now() - stoppedAt);

    const elapsedMs = Math.round(performance.now() - startedAt);
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
