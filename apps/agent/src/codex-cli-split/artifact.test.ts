import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { assertCodexArtifactCompatibleWithImage, codexCommand, prepareCodexSplitArtifact } from "./artifact.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; executable: string; state: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-split-artifact-"));
  const state = await mkdtemp(path.join(tmpdir(), "devspace-split-artifact-state-"));
  roots.push(root, state);
  await mkdir(path.join(root, "bin"), { recursive: true });
  await mkdir(path.join(root, "codex-resources"), { recursive: true });
  await mkdir(path.join(root, "codex-path"), { recursive: true });
  await writeFile(path.join(root, "codex-package.json"), JSON.stringify({
    layoutVersion: 1, version: "0.153.4", target: "x86_64-unknown-linux-musl", variant: "codex",
    entrypoint: "bin/codex", resourcesDir: "codex-resources", pathDir: "codex-path"
  }));
  const bytes = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(64, 7)]);
  const executable = path.join(root, "bin", "codex");
  await writeFile(executable, bytes, { mode: 0o755 });
  await chmod(executable, 0o755);
  await writeFile(path.join(root, "bin", "codex-code-mode-host"), bytes, { mode: 0o755 });
  await writeFile(path.join(root, "codex-resources", "bwrap"), bytes, { mode: 0o755 });
  await writeFile(path.join(root, "codex-path", "rg"), bytes, { mode: 0o755 });
  await symlink("bin/codex", path.join(root, "codex"));
  return { root, executable, state };
}

test("stages only the admitted version and exposes a fixed trusted launcher", async () => {
  const source = await fixture();
  const artifact = await prepareCodexSplitArtifact({ configuredPath: source.executable, stateRoot: source.state });
  expect(artifact.packageVersion).toBe("0.153.4");
  expect(artifact.mountTarget).toBe("/opt/devspace/codex");
  expect(artifact.entrypointPath).toBe("/opt/devspace/codex/bin/codex");
  expect(artifact.launcherPath).toBe("/opt/devspace/codex-launcher/codex");
  expect(codexCommand(artifact, ["--version"])).toEqual(["/opt/devspace/codex-launcher/codex", "--version"]);
  expect(JSON.stringify(artifact)).not.toContain("codex-home");
});

test("reattach reuses and re-verifies the executor's existing staged closure", async () => {
  const source = await fixture();
  const initial = await prepareCodexSplitArtifact({ configuredPath: source.executable, stateRoot: source.state });
  const reattached = await prepareCodexSplitArtifact({
    configuredPath: source.executable,
    stateRoot: source.state,
    existingStagingRoot: initial.staged.stagingRoot
  });

  expect(reattached.staged.stagingRoot).toBe(initial.staged.stagingRoot);
  expect(reattached.closureDigest).toBe(initial.closureDigest);
});

test("fresh split preparation reuses an existing verified staged closure", async () => {
  const source = await fixture();
  const initial = await prepareCodexSplitArtifact({ configuredPath: source.executable, stateRoot: source.state });
  const fresh = await prepareCodexSplitArtifact({ configuredPath: source.executable, stateRoot: source.state });

  expect(fresh.staged.stagingRoot).toBe(initial.staged.stagingRoot);
  expect(fresh.closureDigest).toBe(initial.closureDigest);
});

test("fresh split preparation ignores an invalid staged closure", async () => {
  const source = await fixture();
  const initial = await prepareCodexSplitArtifact({ configuredPath: source.executable, stateRoot: source.state });
  await writeFile(path.join(initial.staged.stagingRoot, "stale-entry"), "stale");

  const fresh = await prepareCodexSplitArtifact({ configuredPath: source.executable, stateRoot: source.state });

  expect(fresh.staged.stagingRoot).not.toBe(initial.staged.stagingRoot);
  expect(fresh.closureDigest).toBe(initial.closureDigest);
});

test("rejects incompatible image architecture and unsafe Codex arguments", async () => {
  const source = await fixture();
  const artifact = await prepareCodexSplitArtifact({ configuredPath: source.executable, stateRoot: source.state });
  expect(() => assertCodexArtifactCompatibleWithImage({ artifact, image: {
    Id: "sha256:image", Os: "linux", Architecture: "arm64", Config: {}
  } })).toThrow("codex-artifact-image-architecture");
  expect(() => codexCommand(artifact, ["--unsafe\0arg"])).toThrow("codex-command-invalid");
});
