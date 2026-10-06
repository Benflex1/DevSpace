/* eslint-disable @typescript-eslint/require-await */
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import type { DockerEngineClient } from "../docker-runtime.js";
import {
  codexExecutionArtifactClosureDigest,
  resolveCodexExecutionArtifact,
  type CodexExecutionArtifact,
  stageCodexExecutionArtifact
} from "./artifact-identity.js";
import {
  createCodexArtifactStager,
  parseCodexArtifactTree,
  type CodexArtifactReadback,
  type CodexArtifactStagingDiagnostic,
  type CodexLaunchArtifact
} from "./artifact-stager.js";
import type { CodexArtifactStagingTiming } from "./artifact-staging-diagnostics.js";

const roots: string[] = [];
const imageId = `sha256:${"a".repeat(64)}`;
const probeRuntime = {
  imageId,
  operatingSystem: "linux",
  architecture: "amd64",
  containerUser: "1000:1000",
  policyVersion: "codex-probe-runtime-v1" as const
};
type DockerExecInput = Parameters<DockerEngineClient["createExec"]>[1];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function endStream(): Duplex {
  const stream = new Duplex({
    read() { /* fake Docker stream */ },
    write(_chunk, _encoding, callback) { callback(); }
  });
  setImmediate(() => stream.emit("close"));
  return stream;
}

function fakeDocker(captured: Array<Record<string, unknown>>): DockerEngineClient {
  let execNumber = 0;
  return {
    inspectContainer: async () => ({
      Id: "managed-container", Name: "/managed", Image: imageId,
      Config: { Labels: {}, WorkingDir: "/workspace", User: "1000:1000" },
      State: { Running: true, Status: "running" }, HostConfig: {} as never,
      NetworkSettings: { Networks: null }, Mounts: []
    }),
    inspectImage: async () => ({ Id: imageId, Os: "linux", Architecture: "amd64", Config: {} }),
    createExec: async (_containerId: string, input: DockerExecInput) => {
      captured.push({ input });
      execNumber += 1;
      return `exec-${execNumber}`;
    },
    startExecAttached: async () => endStream(),
    inspectExec: async (id: string) => ({ ID: id, Running: false, ExitCode: 0, ContainerID: "managed-container" })
  } as unknown as DockerEngineClient;
}

async function fixture(): Promise<{
  readonly root: string;
  readonly staged: Awaited<ReturnType<typeof stageCodexExecutionArtifact>>;
  readonly artifact: CodexExecutionArtifact;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-codex-artifact-stager-"));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  await writeFile(path.join(root, "native"), Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64, 7)]), { mode: 0o755 });
  await chmod(path.join(root, "native"), 0o755);
  await writeFile(path.join(root, "resource"), "same staged bytes", { mode: 0o644 });
  await chmod(path.join(root, "resource"), 0o644);
  await mkdir(sourceRoot, { recursive: true });
  await copyFile(path.join(root, "native"), path.join(sourceRoot, "codex"));
  await copyFile(path.join(root, "resource"), path.join(sourceRoot, "resource"));
  const nativeBytes = await readFile(path.join(sourceRoot, "codex"));
  const resourceBytes = await readFile(path.join(sourceRoot, "resource"));
  const entries = [
    { relativePath: "codex", kind: "file" as const, mode: 0o755, linkTarget: null, byteLength: nativeBytes.length, sha256: "" },
    { relativePath: "resource", kind: "file" as const, mode: 0o644, linkTarget: null, byteLength: resourceBytes.length, sha256: "" }
  ];
  const { createHash } = await import("node:crypto");
  entries[0]!.sha256 = createHash("sha256").update(nativeBytes).digest("hex");
  entries[1]!.sha256 = createHash("sha256").update(resourceBytes).digest("hex");
  const artifact: CodexExecutionArtifact = {
    configuredPath: path.join(root, "configured-codex"), canonicalSourceRoot: sourceRoot,
    layout: "self-contained-native", target: { os: "linux", architecture: "amd64", abi: "gnu" }, packageVersion: null,
    entrypoint: entries[0]!, entries, entrypointSha256: entries[0]!.sha256,
    closureDigest: codexExecutionArtifactClosureDigest({ layout: "self-contained-native", target: { os: "linux", architecture: "amd64", abi: "gnu" }, packageVersion: null, entries })
  };
  const staged = await stageCodexExecutionArtifact({ artifact, stateRoot: path.join(root, "state") });
  return { root, staged, artifact };
}

async function standaloneFixture(): Promise<{
  readonly root: string;
  readonly staged: Awaited<ReturnType<typeof stageCodexExecutionArtifact>>;
  readonly artifact: CodexExecutionArtifact;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-codex-standalone-stager-"));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, "bin"), { recursive: true });
  await mkdir(path.join(sourceRoot, "codex-resources"), { recursive: true });
  await mkdir(path.join(sourceRoot, "codex-path"), { recursive: true });
  await writeFile(path.join(sourceRoot, "codex-package.json"), JSON.stringify({
    layoutVersion: 1,
    version: "0.159.0",
    target: "x86_64-unknown-linux-musl",
    variant: "codex",
    entrypoint: "bin/codex",
    resourcesDir: "codex-resources",
    pathDir: "codex-path"
  }));
  for (const [relative, seed] of [["bin/codex", 1], ["bin/codex-code-mode-host", 2], ["codex-resources/pty", 3], ["codex-path/rg", 4]] as const) {
    const filePath = path.join(sourceRoot, relative);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64, seed)]), { mode: 0o755 });
    await chmod(filePath, 0o755);
  }
  await symlink("bin/codex", path.join(sourceRoot, "codex"));
  const artifact = await resolveCodexExecutionArtifact(path.join(sourceRoot, "codex"));
  const staged = await stageCodexExecutionArtifact({ artifact, stateRoot: path.join(root, "state") });
  return { root, staged, artifact };
}

function statefulContainerDocker(remoteRoot: string, options: { readonly failPublish?: boolean } = {}): {
  readonly docker: DockerEngineClient;
  readonly captured: Array<Record<string, unknown>>;
  readonly remotePath: (containerPath: string) => string;
  readonly exitCodes: Map<string, number>;
} {
  const captured: Array<Record<string, unknown>> = [];
  const execInputs = new Map<string, DockerExecInput>();
  const exitCodes = new Map<string, number>();
  let execNumber = 0;
  let failPublish = options.failPublish ?? false;
  const remotePath = (containerPath: string): string => path.join(remoteRoot, containerPath.replace(/^\/+/, ""));
  const applyCommand = async (execId: string, bytes: Buffer): Promise<void> => {
    const input = execInputs.get(execId)!;
    const environment = input.environment;
    const command = input.command[2] ?? "";
    try {
      if (command.includes("cat > \"$DEVSPACE_TARGET_PATH\"")) {
        const directory = remotePath(environment.DEVSPACE_TARGET_DIR!);
        await mkdir(directory, { recursive: true });
        const target = remotePath(environment.DEVSPACE_TARGET_PATH!);
        await writeFile(target, bytes);
        await chmod(target, Number.parseInt(environment.DEVSPACE_TARGET_MODE!, 8));
      } else if (command.includes("ln -s --")) {
        const directory = remotePath(environment.DEVSPACE_TARGET_DIR!);
        await mkdir(directory, { recursive: true });
        await symlink(environment.DEVSPACE_LINK_TARGET!, remotePath(environment.DEVSPACE_TARGET_PATH!));
      } else if (command.includes("DEVSPACE_CACHE_STAGE") && command.includes("mv -T --")) {
        if (failPublish) {
          failPublish = false;
          throw new Error("fixture-publish-failure");
        }
        const stage = remotePath(environment.DEVSPACE_CACHE_STAGE!);
        const destination = remotePath(environment.DEVSPACE_CACHE_DEST!);
        const backup = remotePath(environment.DEVSPACE_CACHE_BACKUP!);
        let movedExisting = false;
        try {
          await lstat(destination);
          await rename(destination, backup);
          movedExisting = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        try { await rename(stage, destination); }
        catch (error) {
          if (movedExisting) await rename(backup, destination);
          throw error;
        }
        if (movedExisting) await rm(backup, { recursive: true, force: true });
      } else if (command.includes("rm -rf --")) {
        await rm(remotePath(environment.DEVSPACE_TARGET_DIR!), { recursive: true, force: true });
      } else {
        throw new Error("fixture-docker-command-unrecognized");
      }
      exitCodes.set(execId, 0);
    } catch {
      exitCodes.set(execId, 1);
    }
  };
  const docker = {
    createExec: async (_containerId: string, input: DockerExecInput) => {
      captured.push({ input });
      execNumber += 1;
      const id = `exec-${execNumber}`;
      execInputs.set(id, input);
      return id;
    },
    startExecAttached: async (execId: string) => {
      const input = execInputs.get(execId)!;
      if (!input.attachStdin) {
        await applyCommand(execId, Buffer.alloc(0));
        return endStream();
      }
      const chunks: Buffer[] = [];
      const stream = new Duplex({
        read() { /* fixture Docker stream */ },
        write(chunk, _encoding, callback) {
          if (!Buffer.isBuffer(chunk)) {
            callback(new Error("fixture-docker-input-invalid"));
            return;
          }
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          void applyCommand(execId, Buffer.concat(chunks)).then(() => {
            callback();
            stream.push(null);
            setImmediate(() => stream.emit("close"));
          }, callback);
        }
      });
      return stream;
    },
    inspectExec: async (id: string) => ({
      ID: id, Running: false, ExitCode: exitCodes.get(id) ?? 0, ContainerID: "managed-container"
    })
  } as unknown as DockerEngineClient;
  return { docker, captured, remotePath, exitCodes };
}

async function readRemoteEntry(remotePath: string): Promise<CodexArtifactReadback> {
  const stats = await lstat(remotePath);
  if (stats.isSymbolicLink()) {
    return { kind: "symlink", mode: Number(stats.mode & 0o777), bytes: Buffer.alloc(0), linkTarget: await readlink(remotePath) };
  }
  return { kind: "file", mode: Number(stats.mode & 0o777), bytes: await readFile(remotePath), linkTarget: null };
}

async function listRemoteTree(remoteRoot: string, containerRoot: string): Promise<readonly {
  readonly kind: "directory" | "file" | "symlink" | "special";
  readonly relativePath: string;
}[] | null> {
  const root = path.join(remoteRoot, containerRoot.replace(/^\/+/, ""));
  try { await lstat(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const result: Array<{ kind: "directory" | "file" | "symlink" | "special"; relativePath: string }> = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const relativePath = prefix.length === 0 ? name : `${prefix}/${name}`;
      const stats = await lstat(path.join(directory, name));
      if (stats.isDirectory()) {
        result.push({ kind: "directory", relativePath });
        await visit(path.join(directory, name), relativePath);
      } else if (stats.isFile()) result.push({ kind: "file", relativePath });
      else if (stats.isSymbolicLink()) result.push({ kind: "symlink", relativePath });
      else result.push({ kind: "special", relativePath });
    }
  };
  const stats = await lstat(root);
  if (!stats.isDirectory()) return [{ kind: "special", relativePath: "" }];
  await visit(root, "");
  return result;
}

function runningStager(input: {
  readonly remoteRoot: string;
  readonly remote: ReturnType<typeof statefulContainerDocker>;
  readonly diagnostics?: CodexArtifactStagingDiagnostic[];
  readonly timings?: CodexArtifactStagingTiming[];
}) {
  return createCodexArtifactStager({
    docker: input.remote.docker, readbackHelperBytes: Buffer.from("fixture-helper"), createId: () => "fixture-id",
    ...(input.diagnostics === undefined ? {} : { onFailure: (diagnostic) => input.diagnostics!.push(diagnostic) }),
    ...(input.timings === undefined ? {} : { onTiming: (timing) => input.timings!.push(timing) }),
    listArtifactTree: async ({ artifactRoot }) => await listRemoteTree(input.remoteRoot, artifactRoot),
    readbackEntry: async ({ artifactRoot, entry }) => await readRemoteEntry(
      input.remote.remotePath(path.posix.join(artifactRoot, entry.relativePath))
    )
  });
}

function launchArtifact(staged: Awaited<ReturnType<typeof stageCodexExecutionArtifact>>): CodexLaunchArtifact {
  return { staged, managedImageId: imageId, probeRuntime, profileRevision: `sha256-ai-profile-v1:${"b".repeat(64)}` };
}

describe("Codex artifact stager", () => {
  test("parses bounded tree listings and rejects malformed or escaping paths", () => {
    const frame = (entries: readonly { kind: number; path: string }[], status = 0): Buffer => {
      const parts = [Buffer.alloc(20)];
      parts[0]!.write("DSARTL01", 0, "ascii");
      parts[0]!.writeUInt32BE(1, 8);
      parts[0]!.writeUInt32BE(status, 12);
      parts[0]!.writeUInt32BE(entries.length, 16);
      for (const entry of entries) {
        const name = Buffer.from(entry.path);
        const record = Buffer.alloc(8);
        record.writeUInt32BE(entry.kind, 0);
        record.writeUInt32BE(name.length, 4);
        parts.push(record, name);
      }
      return Buffer.concat(parts);
    };

    expect(parseCodexArtifactTree(frame([
      { kind: 1, path: "artifact" }, { kind: 1, path: "artifact/bin" },
      { kind: 2, path: "artifact/bin/codex" }, { kind: 3, path: "artifact/codex" },
      { kind: 4, path: "artifact/socket" }
    ]))).toEqual([
      { kind: "directory", relativePath: "artifact" }, { kind: "directory", relativePath: "artifact/bin" },
      { kind: "file", relativePath: "artifact/bin/codex" }, { kind: "symlink", relativePath: "artifact/codex" },
      { kind: "special", relativePath: "artifact/socket" }
    ]);
    expect(parseCodexArtifactTree(frame([], 1))).toBeNull();
    expect(() => parseCodexArtifactTree(frame([{ kind: 2, path: "../escape" }]))).toThrow("codex-artifact-tree-path-invalid");
    expect(() => parseCodexArtifactTree(frame([
      { kind: 2, path: "artifact/codex" }, { kind: 3, path: "artifact/codex" }
    ]))).toThrow("codex-artifact-tree-path-invalid");
  });

  test("reuses the same verified standalone closure at its digest destination", async () => {
    const fixtureValue = await standaloneFixture();
    const remoteRoot = await mkdtemp(path.join(tmpdir(), "devspace-codex-artifact-container-"));
    roots.push(remoteRoot);
    const remote = statefulContainerDocker(remoteRoot);
    const diagnostics: CodexArtifactStagingDiagnostic[] = [];
    const timings: CodexArtifactStagingTiming[] = [];
    const stager = runningStager({ remoteRoot, remote, diagnostics, timings });
    const destinationRoot = `/opt/devspace/codex-artifact/${fixtureValue.artifact.closureDigest}`;
    const stage = async () => await stager.stageIntoRunningContainer({
      containerId: "a".repeat(64), staged: fixtureValue.staged, destinationRoot
    });

    const first = await stage();
    const symlinkPath = remote.remotePath(`${destinationRoot}/artifact/codex`);
    expect(first.entrypointPath).toBe(`${destinationRoot}/artifact/bin/codex`);
    expect(await lstat(symlinkPath).then((stats) => stats.isSymbolicLink())).toBe(true);
    expect(await readlink(symlinkPath)).toBe("bin/codex");
    const artifactUploadsAfterFirst = remote.captured.filter((captured) => {
      const env = (captured.input as DockerExecInput).environment;
      return env.DEVSPACE_TARGET_PATH?.includes("/artifact/") === true;
    }).length;

    const second = await stage();
    expect(second.entrypointPath).toBe(first.entrypointPath);
    expect(await lstat(symlinkPath).then((stats) => stats.isSymbolicLink())).toBe(true);
    expect(await readlink(symlinkPath)).toBe("bin/codex");
    expect(remote.captured.filter((captured) => {
      const env = (captured.input as DockerExecInput).environment;
      return env.DEVSPACE_TARGET_PATH?.includes("/artifact/") === true;
    })).toHaveLength(artifactUploadsAfterFirst);
    expect(diagnostics).toEqual([]);
    expect(timings.some((timing) => timing.phase === "artifact-cache-verification" && timing.cacheState === "miss")).toBe(true);
    expect(timings.some((timing) => timing.phase === "artifact-cache-verification" && timing.cacheState === "hit")).toBe(true);
    expect(remote.captured.some((captured) => JSON.stringify(captured).includes(fixtureValue.staged.stagingRoot))).toBe(false);
  });

  test("repairs incomplete, corrupt, malformed, and unexpected digest caches as whole closures", async () => {
    const corruptions: Array<{ readonly name: string; readonly mutate: (artifactRoot: string, destinationRoot: string) => Promise<void> }> = [
      { name: "missing artifact", mutate: async (root) => await rm(root, { recursive: true, force: true }) },
      { name: "partial regular files", mutate: async (root) => await rm(path.join(root, "bin", "codex")) },
      { name: "missing convenience symlink", mutate: async (root) => await rm(path.join(root, "codex")) },
      { name: "wrong convenience symlink target", mutate: async (root) => {
        await rm(path.join(root, "codex"));
        await symlink("bin/codex-code-mode-host", path.join(root, "codex"));
      } },
      { name: "wrong regular-file hash", mutate: async (root) => {
        const target = path.join(root, "bin", "codex");
        await writeFile(target, "corrupt artifact");
        await chmod(target, 0o755);
      } },
      { name: "wrong regular-file mode", mutate: async (root) => await chmod(path.join(root, "bin", "codex"), 0o644) },
      { name: "unexpected directory at symlink path", mutate: async (root) => {
        await rm(path.join(root, "codex"));
        await mkdir(path.join(root, "codex"));
      } },
      { name: "unexpected tree member", mutate: async (root) => await writeFile(path.join(root, "unexpected"), "old closure") },
      { name: "unexpected root member", mutate: async (_root, destination) => await writeFile(path.join(destination, "old-helper"), "stale") }
    ];

    for (const corruption of corruptions) {
      const fixtureValue = await standaloneFixture();
      const remoteRoot = await mkdtemp(path.join(tmpdir(), "devspace-codex-artifact-repair-"));
      roots.push(remoteRoot);
      const remote = statefulContainerDocker(remoteRoot);
      const stager = runningStager({ remoteRoot, remote });
      const destinationRoot = `/opt/devspace/codex-artifact/${fixtureValue.artifact.closureDigest}`;
      const artifactRoot = remote.remotePath(`${destinationRoot}/artifact`);
      await stager.stageIntoRunningContainer({ containerId: "a".repeat(64), staged: fixtureValue.staged, destinationRoot });
      await corruption.mutate(artifactRoot, remote.remotePath(destinationRoot));

      const repaired = await stager.stageIntoRunningContainer({ containerId: "a".repeat(64), staged: fixtureValue.staged, destinationRoot });
      expect(repaired.entrypointPath, corruption.name).toBe(`${destinationRoot}/artifact/bin/codex`);
      expect(await readlink(remote.remotePath(`${destinationRoot}/artifact/codex`)), corruption.name).toBe("bin/codex");
      expect(await readFile(remote.remotePath(`${destinationRoot}/artifact/bin/codex`)), corruption.name)
        .toEqual(await readFile(path.join(fixtureValue.staged.stagingRoot, "bin", "codex")));
      expect(await lstat(remote.remotePath(`${destinationRoot}/old-helper`)).catch(() => null), corruption.name).toBeNull();
      expect(await lstat(remote.remotePath(`${destinationRoot}/artifact/unexpected`)).catch(() => null), corruption.name).toBeNull();
    }
  });

  test("preserves a verified cache when cache verification is ambiguous", async () => {
    const fixtureValue = await standaloneFixture();
    const remoteRoot = await mkdtemp(path.join(tmpdir(), "devspace-codex-artifact-preserve-"));
    roots.push(remoteRoot);
    const remote = statefulContainerDocker(remoteRoot);
    const destinationRoot = `/opt/devspace/codex-artifact/${fixtureValue.artifact.closureDigest}`;
    await runningStager({ remoteRoot, remote }).stageIntoRunningContainer({
      containerId: "a".repeat(64), staged: fixtureValue.staged, destinationRoot
    });
    const failing = createCodexArtifactStager({
      docker: remote.docker, readbackHelperBytes: Buffer.from("fixture-helper"), createId: () => "retry-id",
      listArtifactTree: async () => { throw new Error("codex-artifact-tree-verification-unproven"); }
    });

    await expect(failing.stageIntoRunningContainer({
      containerId: "a".repeat(64), staged: fixtureValue.staged, destinationRoot
    })).rejects.toThrow("codex-artifact-tree-verification-unproven");
    expect(await readlink(remote.remotePath(`${destinationRoot}/artifact/codex`))).toBe("bin/codex");
    expect(await readFile(remote.remotePath(`${destinationRoot}/artifact/bin/codex`)))
      .toEqual(await readFile(path.join(fixtureValue.staged.stagingRoot, "bin", "codex")));
  });

  test("serializes concurrent same-digest staging without mixed publication", async () => {
    const fixtureValue = await standaloneFixture();
    const remoteRoot = await mkdtemp(path.join(tmpdir(), "devspace-codex-artifact-concurrent-"));
    roots.push(remoteRoot);
    const remote = statefulContainerDocker(remoteRoot);
    const stager = runningStager({ remoteRoot, remote });
    const destinationRoot = `/opt/devspace/codex-artifact/${fixtureValue.artifact.closureDigest}`;
    const input = { containerId: "a".repeat(64), staged: fixtureValue.staged, destinationRoot };

    const results = await Promise.all([
      stager.stageIntoRunningContainer(input), stager.stageIntoRunningContainer(input)
    ]);
    expect(results[0]?.entrypointPath).toBe(`${destinationRoot}/artifact/bin/codex`);
    expect(results[1]?.entrypointPath).toBe(results[0]?.entrypointPath);
    const artifactUploads = remote.captured.filter((captured) => {
      const environment = (captured.input as DockerExecInput).environment;
      return environment.DEVSPACE_TARGET_PATH?.includes("/artifact/") === true;
    });
    expect(artifactUploads).toHaveLength(fixtureValue.artifact.entries.length);
    expect(await readlink(remote.remotePath(`${destinationRoot}/artifact/codex`))).toBe("bin/codex");
  });

  test("a failed publication never returns an executable path or removes unrelated cache state", async () => {
    const fixtureValue = await standaloneFixture();
    const remoteRoot = await mkdtemp(path.join(tmpdir(), "devspace-codex-artifact-publish-fail-"));
    roots.push(remoteRoot);
    const remote = statefulContainerDocker(remoteRoot, { failPublish: true });
    const diagnostics: CodexArtifactStagingDiagnostic[] = [];
    const stager = runningStager({ remoteRoot, remote, diagnostics });
    const destinationRoot = `/opt/devspace/codex-artifact/${fixtureValue.artifact.closureDigest}`;

    await expect(stager.stageIntoRunningContainer({
      containerId: "a".repeat(64), staged: fixtureValue.staged, destinationRoot
    })).rejects.toThrow("codex-artifact-cache-publication-unproven");
    expect(await lstat(remote.remotePath(destinationRoot)).catch(() => null)).toBeNull();
    expect(await lstat(remote.remotePath(`/opt/devspace/codex-artifact/.stage-${fixtureValue.artifact.closureDigest}-fixture-id`)).catch(() => null)).toBeNull();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      phase: "artifact-cache-replacement", failureCode: "codex-artifact-cache-publication-unproven"
    }));
  });

  test("uploads every staged closure member and proves the exact bounded readback", async () => {
    const fixtureValue = await fixture();
    const captured: Array<Record<string, unknown>> = [];
    const readbacks = new Map<string, CodexArtifactReadback>();
    for (const entry of fixtureValue.artifact.entries) {
      const bytes = await readFile(path.join(fixtureValue.staged.stagingRoot, ...entry.relativePath.split("/")));
      readbacks.set(entry.relativePath, { kind: "file", mode: entry.mode, bytes, linkTarget: null });
    }
    const stager = createCodexArtifactStager({
      docker: fakeDocker(captured), readbackHelperBytes: Buffer.from("helper"), createId: () => "probe-id",
      readbackEntry: async ({ entry }) => readbacks.get(entry.relativePath)!
    });
    const result = await stager.stageIntoManagedProvider({
      containerId: "managed-container", launchArtifact: launchArtifact(fixtureValue.staged),
      sessionId: "018f0000-0000-7000-8000-000000000001", processGeneration: 1
    });
    expect(result.entrypointPath).toContain("/artifact/codex");
    expect(result.artifactReadbackPath).toContain("codex-artifact-readback");
    const uploadedPaths = captured.map((entry) => String((entry.input as { environment?: Record<string, string> }).environment?.DEVSPACE_TARGET_PATH ?? ""));
    expect(uploadedPaths.some((value) => value.endsWith("/artifact/codex"))).toBe(true);
    expect(uploadedPaths.some((value) => value.endsWith("/artifact/resource"))).toBe(true);
  });

  test("does not use a replaced source path after discovery staged the closure", async () => {
    const fixtureValue = await fixture();
    await writeFile(path.join(fixtureValue.root, "native"), "replacement");
    const bytes = await readFile(path.join(fixtureValue.staged.stagingRoot, "codex"));
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  });

  test("fails before upload when the managed image differs from discovery", async () => {
    const fixtureValue = await fixture();
    const captured: Array<Record<string, unknown>> = [];
    const docker = fakeDocker(captured);
    (docker.inspectContainer as unknown as { mockResolvedValue?: (value: unknown) => void }).mockResolvedValue?.({});
    const stager = createCodexArtifactStager({ docker, readbackHelperBytes: Buffer.from("helper"), createId: () => "probe-id" });
    await expect(stager.stageIntoManagedProvider({
      containerId: "wrong-container", launchArtifact: launchArtifact(fixtureValue.staged),
      sessionId: "018f0000-0000-7000-8000-000000000001", processGeneration: 1
    })).rejects.toThrow("codex-launch-runtime-mismatch");
    expect(captured).toHaveLength(0);
  });

  test("fails closed when an artifact readback member differs", async () => {
    const fixtureValue = await fixture();
    const captured: Array<Record<string, unknown>> = [];
    const stager = createCodexArtifactStager({
      docker: fakeDocker(captured), readbackHelperBytes: Buffer.from("helper"), createId: () => "probe-id",
      readbackEntry: async ({ entry }) => ({ kind: "file", mode: entry.mode, bytes: Buffer.from("wrong"), linkTarget: null })
    });
    await expect(stager.stageIntoManagedProvider({
      containerId: "managed-container", launchArtifact: launchArtifact(fixtureValue.staged),
      sessionId: "018f0000-0000-7000-8000-000000000001", processGeneration: 1
    })).rejects.toThrow("codex-artifact-readback-mismatch");
  });

  test("reports bounded private diagnostics for the first running-container upload failure", async () => {
    const fixtureValue = await fixture();
    const captured: Array<Record<string, unknown>> = [];
    const diagnostics: CodexArtifactStagingDiagnostic[] = [];
    const docker = fakeDocker(captured);
    let attachCount = 0;
    docker.startExecAttached = async () => {
      attachCount += 1;
      if (attachCount === 1) throw new Error("permission denied at /private/host/secret");
      return endStream();
    };
    const stager = createCodexArtifactStager({
      docker, readbackHelperBytes: Buffer.from("helper"), createId: () => "probe-id",
      onFailure: (diagnostic) => diagnostics.push(diagnostic)
    });
    const destinationRoot = `/opt/devspace/codex-artifact/${fixtureValue.artifact.closureDigest}`;

    await expect(stager.stageIntoRunningContainer({
      containerId: "a".repeat(64), staged: fixtureValue.staged,
      destinationRoot
    })).rejects.toThrow("permission denied at /private/host/secret");

    expect(diagnostics).toHaveLength(1);
    const diagnostic = diagnostics[0];
    expect(diagnostic).toMatchObject({
      phase: "readback-helper-upload", failureCode: "unclassified", errorClass: "Error",
      containerId: "a".repeat(64), artifactLayout: "self-contained-native"
    });
    expect(diagnostic?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(diagnostic?.cleanupElapsedMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics[0]).not.toHaveProperty("errorMessage");
    expect(JSON.stringify(diagnostics)).not.toContain("/private/host/secret");
    expect(captured.some((item) => {
      const input = item.input as DockerExecInput;
      return input.command[2]?.includes("rm -rf") === true;
    })).toBe(true);
  });
});
