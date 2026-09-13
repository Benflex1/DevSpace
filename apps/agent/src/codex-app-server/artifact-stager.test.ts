import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import type { DockerEngineClient } from "../docker-runtime.js";
import {
  codexExecutionArtifactClosureDigest,
  type CodexExecutionArtifact,
  stageCodexExecutionArtifact
} from "./artifact-identity.js";
import {
  createCodexArtifactStager,
  type CodexArtifactReadback,
  type CodexLaunchArtifact
} from "./artifact-stager.js";

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

function launchArtifact(staged: Awaited<ReturnType<typeof stageCodexExecutionArtifact>>): CodexLaunchArtifact {
  return { staged, managedImageId: imageId, probeRuntime, profileRevision: `sha256-ai-profile-v1:${"b".repeat(64)}` };
}

describe("Codex artifact stager", () => {
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
});
