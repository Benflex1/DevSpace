import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as tar from "tar-stream";
import { afterEach, expect, test } from "vitest";
import { DockerEngineClient, DockerEngineError } from "../docker-runtime.js";
import { resolveCodexExecutionArtifact, stageCodexExecutionArtifact } from "./artifact-identity.js";
import { createCodexArtifactStager } from "./artifact-stager.js";

const dockerSocketPath = process.env.DEVSPACE_TEST_DOCKER_SOCKET_PATH;
const imageReference = process.env.DEVSPACE_TEST_GIT_IMAGE ?? "mcr.microsoft.com/devcontainers/base:ubuntu-24.04";
const artifactRoot = "/opt/devspace/codex-artifact";
const testImageUser = "1000:1000";

interface StageCounters {
  execCreations: number;
  putCalls: number;
  getCalls: number;
  putBytes: number;
  getBytes: number;
}

interface StageMeasurement extends StageCounters {
  readonly elapsedMs: number;
  readonly startRssBytes: number;
  readonly peakRssSampledBytes: number;
  readonly peakRssDeltaBytes: number;
}

type ReadbackFault = { readonly kind: "corrupt"; readonly marker: Buffer } | { readonly kind: "unexpected" };

interface ActiveFixture {
  readonly root: string;
  readonly engine: MeasuringDockerEngine;
  readonly runId: string;
  readonly containerIds: Set<string>;
}

let activeFixture: ActiveFixture | null = null;

function chunkBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("rootless-artifact-stream-chunk-invalid");
}

async function* countedChunks(source: Readable, record: (byteLength: number) => void): AsyncGenerator<Buffer> {
  for await (const value of source) {
    const chunk = chunkBuffer(value as unknown);
    record(chunk.length);
    yield chunk;
  }
}

async function streamBytes(source: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const value of source) chunks.push(chunkBuffer(value as unknown));
  return Buffer.concat(chunks);
}

function unexpectedArchive(): Readable {
  const archive = tar.pack();
  void new Promise<void>((resolve, reject) => {
    archive.entry({ name: "artifact/unexpected", type: "file", mode: 0o600, size: 5 }, Buffer.from("extra"),
      (error) => error == null ? resolve() : reject(error));
  }).then(() => archive.finalize()).catch((error: unknown) => {
    archive.destroy(error instanceof Error ? error : new Error("rootless-artifact-fixture-archive-failed"));
  });
  return archive;
}

function appendFixtureArchiveEntry(pack: tar.Pack, header: tar.Header): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    pack.entry(header, (error) => error == null ? resolve() : reject(error));
  });
}

function artifactRootBootstrapArchive(): Readable {
  const archive = tar.pack();
  void (async () => {
    await appendFixtureArchiveEntry(archive, {
      name: "devspace/", type: "directory", mode: 0o755, uid: 0, gid: 0, mtime: new Date(0)
    });
    await appendFixtureArchiveEntry(archive, {
      name: "devspace/codex-artifact/", type: "directory", mode: 0o700, uid: 0, gid: 0, mtime: new Date(0)
    });
    archive.finalize();
  })().catch((error: unknown) => archive.destroy(error instanceof Error ? error : new Error("rootless-artifact-bootstrap-failed")));
  return archive;
}

class MeasuringDockerEngine extends DockerEngineClient {
  measurement: StageCounters | null = null;
  readbackFault: ReadbackFault | null = null;
  partialUploadAfterBytes: number | null = null;

  private async sendArchive(containerId: string, destinationPath: string, archive: Readable, timeoutMs: number): Promise<void> {
    try { await super.putContainerArchive(containerId, destinationPath, archive, timeoutMs); }
    catch (error) {
      if (error instanceof DockerEngineError) {
        throw new Error(`rootless-artifact-archive-put-rejected:${error.statusCode}:${destinationPath}:${error.responseBody}`, { cause: error });
      }
      throw error;
    }
  }

  override async createExec(containerId: string, input: Parameters<DockerEngineClient["createExec"]>[1]): Promise<string> {
    if (this.measurement !== null) this.measurement.execCreations += 1;
    return await super.createExec(containerId, input);
  }

  override async putContainerArchive(containerId: string, destinationPath: string, archive: Readable, timeoutMs: number): Promise<void> {
    const measurement = this.measurement;
    if (measurement !== null) measurement.putCalls += 1;
    const failAfter = this.partialUploadAfterBytes;
    this.partialUploadAfterBytes = null;
    if (failAfter !== null) {
      let transferred = 0;
      const partial = Readable.from((async function* () {
        for await (const value of archive) {
          const chunk = chunkBuffer(value as unknown);
          const remaining = failAfter - transferred;
          if (remaining <= 0) throw new Error("rootless-artifact-fixture-partial-upload");
          if (chunk.length > remaining) {
            yield chunk.subarray(0, remaining);
            throw new Error("rootless-artifact-fixture-partial-upload");
          }
          transferred += chunk.length;
          yield chunk;
        }
      })());
      return await this.sendArchive(containerId, destinationPath, partial, timeoutMs);
    }
    if (measurement === null) return await this.sendArchive(containerId, destinationPath, archive, timeoutMs);
    const measured = Readable.from(countedChunks(archive, (byteLength) => { measurement.putBytes += byteLength; }));
    return await this.sendArchive(containerId, destinationPath, measured, timeoutMs);
  }

  override async getContainerArchive(containerId: string, sourcePath: string, timeoutMs: number): Promise<Readable> {
    const measurement = this.measurement;
    if (measurement !== null) measurement.getCalls += 1;
    const archive = await super.getContainerArchive(containerId, sourcePath, timeoutMs);
    const fault = this.readbackFault;
    this.readbackFault = null;
    if (fault !== null) {
      const bytes = await streamBytes(archive);
      if (measurement !== null) measurement.getBytes += bytes.length;
      if (fault.kind === "unexpected") return unexpectedArchive();
      const corrupted = Buffer.from(bytes);
      const markerOffset = corrupted.indexOf(fault.marker);
      if (markerOffset < 0) throw new Error("rootless-artifact-fixture-corruption-marker-missing");
      corrupted[markerOffset] = (corrupted[markerOffset] ?? 0) ^ 0x01;
      return Readable.from([corrupted]);
    }
    if (measurement === null) return archive;
    return Readable.from(countedChunks(archive, (byteLength) => { measurement.getBytes += byteLength; }));
  }
}

async function dockerRequest(socketPath: string, method: string, requestPath: string, body?: Buffer): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const request = httpRequest({
      socketPath, method, path: requestPath,
      headers: body === undefined ? {} : { "content-type": "application/json", "content-length": String(body.length) }
    }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (value: Buffer) => {
        length += value.length;
        if (length > 64 * 1024) {
          response.destroy(new Error("rootless-artifact-docker-response-too-large"));
          return;
        }
        chunks.push(Buffer.from(value));
      });
      response.once("end", () => {
        const responseBody = Buffer.concat(chunks);
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new Error(`rootless-artifact-docker-request-failed:${method}:${status}:${responseBody.toString("utf8").slice(0, 240)}`));
          return;
        }
        resolve(responseBody);
      });
      response.once("error", reject);
    });
    request.setTimeout(30_000, () => request.destroy(new Error("rootless-artifact-docker-request-timeout")));
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function createFixtureContainer(engine: DockerEngineClient, runId: string, role: "target" | "peer"): Promise<string> {
  const name = `devspace-codex-artifact-${runId.slice(0, 8)}-${role}`;
  const labels = {
    "devspace.test": "codex-artifact-staging",
    "devspace.test-run": runId,
    "devspace.test-role": role
  };
  const response = await dockerRequest(engine.socketPath,
    "POST", `/containers/create?name=${encodeURIComponent(name)}`, Buffer.from(JSON.stringify({
      Image: imageReference,
      Entrypoint: ["/bin/sh", "-c"],
      Cmd: ["trap 'exit 0' TERM INT; while :; do sleep 2147483647 & wait $!; done"],
      WorkingDir: "/workspace",
      User: testImageUser,
      Env: [],
      Labels: labels,
      HostConfig: {
        Binds: [], Mounts: [], Tmpfs: {
          "/workspace": "rw,nosuid,nodev,size=64m,mode=0700,uid=1000,gid=1000"
        },
        NetworkMode: "none", PortBindings: {}, PublishAllPorts: false,
        Privileged: false, PidMode: "", IpcMode: "private", UTSMode: "", UsernsMode: "", CgroupnsMode: "private",
        AutoRemove: false, ReadonlyRootfs: false, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        CapAdd: [], CapDrop: ["ALL"], Devices: [], SecurityOpt: ["no-new-privileges:true"],
        NanoCpus: 500_000_000, Memory: 512 * 1024 * 1024, MemorySwap: 512 * 1024 * 1024, PidsLimit: 64
      }
    })));
  const created = JSON.parse(response.toString("utf8")) as { readonly Id?: unknown };
  if (typeof created.Id !== "string" || !/^[a-f0-9]{64}$/u.test(created.Id)) {
    throw new Error("rootless-artifact-container-id-invalid");
  }
  return created.Id;
}

async function createArtifactFixture(root: string, seed: number): Promise<{
  readonly staged: Awaited<ReturnType<typeof stageCodexExecutionArtifact>>;
  readonly artifact: Awaited<ReturnType<typeof resolveCodexExecutionArtifact>>;
  readonly marker: Buffer;
}> {
  const sourceRoot = path.join(root, `source-${seed}`);
  await Promise.all(["bin", "codex-resources", "codex-path"].map(async (directory) =>
    await mkdir(path.join(sourceRoot, directory), { recursive: true, mode: 0o700 })));
  await writeFile(path.join(sourceRoot, "codex-package.json"), JSON.stringify({
    layoutVersion: 1, version: "0.1.0", target: "x86_64-unknown-linux-musl", variant: "codex",
    entrypoint: "bin/codex", resourcesDir: "codex-resources", pathDir: "codex-path"
  }), { mode: 0o644 });

  const marker = Buffer.from(`DEVSPACE_ARTIFACT_FIXTURE_${seed}_PAYLOAD_MARKER`);
  const native = Buffer.alloc(2 * 1024 * 1024, 0x40 + seed);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(native);
  marker.copy(native, 64);
  const entries: ReadonlyArray<{ readonly relativePath: string; readonly bytes: Buffer; readonly mode: number }> = [
    { relativePath: "bin/codex", bytes: native, mode: 0o755 },
    { relativePath: "bin/codex-code-mode-host", bytes: Buffer.from("fixture mode helper\n"), mode: 0o750 },
    { relativePath: "codex-resources/fixture.dat", bytes: Buffer.alloc(512 * 1024, 0x70 + seed), mode: 0o640 },
    { relativePath: "codex-path/rg", bytes: Buffer.alloc(64 * 1024, 0x30 + seed), mode: 0o755 }
  ];
  for (const entry of entries) {
    const target = path.join(sourceRoot, ...entry.relativePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, entry.bytes, { mode: entry.mode });
    await chmod(target, entry.mode);
  }
  await symlink("bin/codex", path.join(sourceRoot, "codex"));

  const artifact = await resolveCodexExecutionArtifact(path.join(sourceRoot, "codex"));
  const staged = await stageCodexExecutionArtifact({ artifact, stateRoot: path.join(root, `state-${seed}`) });
  return { staged, artifact, marker };
}

async function containerCommand(engine: DockerEngineClient, containerId: string, command: readonly string[]): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}> {
  const execId = await engine.createExec(containerId, {
    command, workingDirectory: "/", environment: { LC_ALL: "C" }, attachStdin: false, tty: false
  });
  const stream = await engine.startExecAttached(execId, false);
  const chunks: Buffer[] = [];
  for await (const value of stream) chunks.push(chunkBuffer(value as unknown));
  const raw = Buffer.concat(chunks);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    if (offset + 8 > raw.length) throw new Error("rootless-artifact-docker-frame-truncated");
    const streamType = raw[offset];
    const length = raw.readUInt32BE(offset + 4);
    const end = offset + 8 + length;
    if ((streamType !== 1 && streamType !== 2) || end > raw.length) throw new Error("rootless-artifact-docker-frame-invalid");
    (streamType === 1 ? stdout : stderr).push(raw.subarray(offset + 8, end));
    offset = end;
  }
  const inspection = await engine.inspectExec(execId);
  if (inspection.Running || inspection.ExitCode === null) throw new Error("rootless-artifact-docker-exec-incomplete");
  return { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: inspection.ExitCode };
}

async function commandOkay(engine: DockerEngineClient, containerId: string, command: readonly string[]): Promise<string> {
  const result = await containerCommand(engine, containerId, command);
  if (result.exitCode !== 0) {
    throw new Error(`rootless-artifact-container-command-failed:${command[0] ?? "unknown"}:${result.exitCode}:${result.stderr.slice(0, 200)}`);
  }
  return result.stdout;
}

async function measureStage<T>(engine: MeasuringDockerEngine, operation: () => Promise<T>): Promise<{
  readonly value: T;
  readonly measurement: StageMeasurement;
}> {
  const counters: StageCounters = { execCreations: 0, putCalls: 0, getCalls: 0, putBytes: 0, getBytes: 0 };
  const startRssBytes = process.memoryUsage.rss();
  let peakRssSampledBytes = startRssBytes;
  const sample = () => { peakRssSampledBytes = Math.max(peakRssSampledBytes, process.memoryUsage.rss()); };
  const timer = setInterval(sample, 5);
  const startedAt = performance.now();
  engine.measurement = counters;
  try {
    const value = await operation();
    sample();
    const elapsedMs = performance.now() - startedAt;
    const measurement = {
      ...counters, elapsedMs: Math.round(elapsedMs * 100) / 100, startRssBytes, peakRssSampledBytes,
      peakRssDeltaBytes: Math.max(0, peakRssSampledBytes - startRssBytes)
    };
    return { value, measurement };
  } finally {
    clearInterval(timer);
    engine.measurement = null;
  }
}

function artifactDestination(digest: string): string {
  return `${artifactRoot}/${digest}`;
}

async function assertNotPublished(engine: DockerEngineClient, containerId: string, digest: string): Promise<void> {
  const destination = artifactDestination(digest);
  expect((await containerCommand(engine, containerId, ["sh", "-c", "test ! -e \"$1\" && test ! -L \"$1\"", "sh", destination])).exitCode).toBe(0);
  expect(await commandOkay(engine, containerId, ["find", `${artifactRoot}`, "-mindepth", "1", "-maxdepth", "1", "-name", ".stage-*", "-print"]))
    .toBe("");
}

async function verifyPublishedArtifact(engine: DockerEngineClient, containerId: string, fixture: Awaited<ReturnType<typeof createArtifactFixture>>): Promise<void> {
  const destination = `${artifactDestination(fixture.artifact.closureDigest)}/artifact`;
  const expectedPaths = new Map<string, { readonly kind: "d" | "f" | "l"; readonly mode: string }>([
    ["", { kind: "d", mode: "700" }]
  ]);
  for (const entry of fixture.artifact.entries) {
    const target = `${destination}/${entry.relativePath}`;
    const pathParts = entry.relativePath.split("/");
    for (let index = 1; index < pathParts.length; index += 1) {
      const directory = pathParts.slice(0, index).join("/");
      expectedPaths.set(directory, { kind: "d", mode: "700" });
    }
    if (entry.kind === "symlink") {
      expect(await commandOkay(engine, containerId, ["readlink", "--", target])).toBe(`${entry.linkTarget}\n`);
      expectedPaths.set(entry.relativePath, { kind: "l", mode: entry.mode.toString(8) });
      continue;
    }
    if (entry.sha256 === null) throw new Error("rootless-artifact-fixture-file-hash-missing");
    const hash = await commandOkay(engine, containerId, ["sha256sum", "--", target]);
    expect(hash.slice(0, 64)).toBe(entry.sha256);
    expect(await commandOkay(engine, containerId, ["stat", "-c", "%s", "--", target])).toBe(`${entry.byteLength}\n`);
    expect(await commandOkay(engine, containerId, ["stat", "-c", "%a %u:%g", "--", target]))
      .toBe(`${entry.mode.toString(8)} ${testImageUser}\n`);
    expectedPaths.set(entry.relativePath, { kind: "f", mode: entry.mode.toString(8) });
  }
  const entrypoint = `${destination}/${fixture.artifact.entrypoint.relativePath}`;
  expect((await containerCommand(engine, containerId, ["test", "-x", entrypoint])).exitCode).toBe(0);
  const observedTree = (await commandOkay(engine, containerId, [
    "sh", "-c", "find \"$1\" -printf '%P\\t%y\\t%m\\t%U:%G\\n' | LC_ALL=C sort", "sh", destination
  ])).trimEnd().split("\n").map((line) => line.split("\t"));
  const expectedTree = [...expectedPaths.entries()].map(([relativePath, entry]) =>
    [relativePath, entry.kind, entry.mode, testImageUser]).sort((left, right) => left[0]!.localeCompare(right[0]!));
  if (JSON.stringify(observedTree) !== JSON.stringify(expectedTree)) {
    throw new Error(`rootless-artifact-published-tree-mismatch:${JSON.stringify({ observedTree, expectedTree })}`);
  }
}

function createStager(engine: DockerEngineClient, readbackHelperBytes: Buffer) {
  return createCodexArtifactStager({ docker: engine, readbackHelperBytes, createId: () => randomUUID() });
}

async function cleanupContainer(fixture: ActiveFixture, containerId: string): Promise<void> {
  const container = await fixture.engine.inspectContainer(containerId);
  if (container.Config.Labels["devspace.test-run"] !== fixture.runId
    || container.Config.Labels["devspace.test"] !== "codex-artifact-staging") {
    throw new Error("rootless-artifact-refusing-to-remove-unowned-container");
  }
  if (container.State.Running) await fixture.engine.stopContainer(containerId);
  await fixture.engine.removeContainer(containerId);
  await expect(fixture.engine.inspectContainer(containerId)).rejects.toMatchObject({ statusCode: 404 });
  fixture.containerIds.delete(containerId);
}

afterEach(async () => {
  if (activeFixture === null) return;
  const fixture = activeFixture;
  let cleanupError: unknown;
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
  try { await rm(fixture.root, { recursive: true, force: true }); }
  catch (error) { cleanupError ??= error; }
  finally { activeFixture = null; }
  if (cleanupError !== undefined) {
    throw cleanupError instanceof Error ? cleanupError : new Error("rootless-artifact-fixture-cleanup-failed", { cause: cleanupError });
  }
});

test.skipIf(dockerSocketPath === undefined)("real rootless Docker accepts batched Codex artifact staging and rejects incomplete readbacks", async () => {
  if (dockerSocketPath === undefined) throw new Error("DEVSPACE_TEST_DOCKER_SOCKET_PATH is required; no Docker socket fallback is permitted.");
  const engine = new MeasuringDockerEngine(dockerSocketPath);
  await engine.assertRootlessAvailable();
  await engine.ensureImage(imageReference);

  const root = await mkdtemp(path.join(tmpdir(), "devspace-rootless-codex-artifact-"));
  const runId = randomUUID();
  const active = { root, engine, runId, containerIds: new Set<string>() } satisfies ActiveFixture;
  activeFixture = active;
  const targetContainerId = await createFixtureContainer(engine, runId, "target");
  active.containerIds.add(targetContainerId);
  await engine.startContainer(targetContainerId);
  const peerContainerId = await createFixtureContainer(engine, runId, "peer");
  active.containerIds.add(peerContainerId);
  await engine.startContainer(peerContainerId);
  await engine.putContainerArchive(targetContainerId, "/opt", artifactRootBootstrapArchive(), 30_000);
  expect(await commandOkay(engine, targetContainerId, ["stat", "-c", "%a %u:%g", artifactRoot]))
    .toBe(`700 ${testImageUser}\n`);
  const labels = (await engine.listContainers()).filter((container) => container.Labels["devspace.test-run"] === runId);
  expect(labels.map((container) => container.Id).sort()).toEqual([peerContainerId, targetContainerId].sort());

  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../native/artifacts/linux-x64/codex-artifact-readback");
  const helperBytes = await readFile(helperPath);
  const fixture = await createArtifactFixture(root, 1);
  const fixtureBytes = fixture.artifact.entries.reduce((total, entry) =>
    total + (entry.kind === "file" ? entry.byteLength : 0), 0);
  const stager = createStager(engine, helperBytes);
  const input = { containerId: targetContainerId, staged: fixture.staged, destinationRoot: artifactDestination(fixture.artifact.closureDigest) };

  const cold = await measureStage(engine, async () => await stager.stageIntoRunningContainer(input));
  expect(cold.value.entrypointPath).toBe(`${input.destinationRoot}/artifact/bin/codex`);
  expect(cold.measurement).toMatchObject({ execCreations: 6, putCalls: 1, getCalls: 1 });
  expect(cold.measurement.putBytes).toBeGreaterThan(fixtureBytes);
  expect(cold.measurement.getBytes).toBeGreaterThan(fixtureBytes);
  await verifyPublishedArtifact(engine, targetContainerId, fixture);

  const warm = await measureStage(engine, async () => await stager.stageIntoRunningContainer(input));
  expect(warm.value.entrypointPath).toBe(cold.value.entrypointPath);
  expect(warm.measurement).toMatchObject({ execCreations: 3, putCalls: 0, getCalls: 1, putBytes: 0 });
  expect(warm.measurement.getBytes).toBeGreaterThan(fixtureBytes);
  expect((await engine.inspectContainer(peerContainerId)).State.Running).toBe(true);
  expect((await containerCommand(engine, peerContainerId, [
    "sh", "-c", "test ! -e \"$1\" && test ! -L \"$1\"", "sh", input.destinationRoot
  ])).exitCode).toBe(0);

  const corruptFixture = await createArtifactFixture(root, 2);
  engine.readbackFault = { kind: "corrupt", marker: corruptFixture.marker };
  await expect(stager.stageIntoRunningContainer({
    containerId: targetContainerId, staged: corruptFixture.staged,
    destinationRoot: artifactDestination(corruptFixture.artifact.closureDigest)
  })).rejects.toThrow("codex-artifact-readback-mismatch");
  await assertNotPublished(engine, targetContainerId, corruptFixture.artifact.closureDigest);

  const unexpectedFixture = await createArtifactFixture(root, 3);
  engine.readbackFault = { kind: "unexpected" };
  await expect(stager.stageIntoRunningContainer({
    containerId: targetContainerId, staged: unexpectedFixture.staged,
    destinationRoot: artifactDestination(unexpectedFixture.artifact.closureDigest)
  })).rejects.toThrow("codex-artifact-readback-mismatch");
  await assertNotPublished(engine, targetContainerId, unexpectedFixture.artifact.closureDigest);

  const partialFixture = await createArtifactFixture(root, 4);
  engine.partialUploadAfterBytes = 64 * 1024;
  await expect(stager.stageIntoRunningContainer({
    containerId: targetContainerId, staged: partialFixture.staged,
    destinationRoot: artifactDestination(partialFixture.artifact.closureDigest)
  })).rejects.toBeDefined();
  await assertNotPublished(engine, targetContainerId, partialFixture.artifact.closureDigest);

  const helperLeftovers = await commandOkay(engine, targetContainerId, [
    "sh", "-c", "if [ -d /tmp/devspace-ai ]; then find /tmp/devspace-ai -mindepth 1 -maxdepth 1 -name 'codex-artifact-*' -print; fi"
  ]);
  expect(helperLeftovers).toBe("");
  expect(await commandOkay(engine, targetContainerId, ["find", artifactRoot, "-mindepth", "1", "-maxdepth", "1", "-name", ".stage-*", "-print"]))
    .toBe("");

  const benchmark = {
    fixtureBytes,
    measurementsAreRealDockerApiStreams: true,
    rssNote: "Node process RSS sampled every 5 ms during each stage call",
    archiveByteNote: "PUT and GET tar body bytes; excludes HTTP headers and exec frames",
    cold: cold.measurement,
    warm: warm.measurement
  };
  console.log(`ROOTLESS_CODEX_ARTIFACT_BENCHMARK ${JSON.stringify(benchmark)}`);
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    const summary = [
      "### Rootless Docker Codex artifact staging benchmark",
      "",
      `Fixture payload: ${fixtureBytes} bytes. Docker archive body byte counts exclude HTTP headers and exec frames. RSS is the Node test process sampled every 5 ms.`,
      "",
      "| Stage | Wall time (ms) | Docker exec creations | PUT bytes | GET bytes | Peak sampled RSS (bytes) |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      `| Cold | ${cold.measurement.elapsedMs} | ${cold.measurement.execCreations} | ${cold.measurement.putBytes} | ${cold.measurement.getBytes} | ${cold.measurement.peakRssSampledBytes} |`,
      `| Warm | ${warm.measurement.elapsedMs} | ${warm.measurement.execCreations} | ${warm.measurement.putBytes} | ${warm.measurement.getBytes} | ${warm.measurement.peakRssSampledBytes} |`,
      ""
    ].join("\n");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
  }

  await cleanupContainer(active, peerContainerId);
  await cleanupContainer(active, targetContainerId);
});
