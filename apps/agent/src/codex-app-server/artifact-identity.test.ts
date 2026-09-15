import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  resolveCodexExecutionArtifact,
  stageCodexExecutionArtifact,
  verifyStagedCodexExecutionArtifact
} from "./artifact-identity.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function nativeFixtureBytes(seed: number): Buffer {
  return Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(64, seed)]);
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function writeExecutable(filePath: string, contents = nativeFixtureBytes(1)): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, { mode: 0o755 });
  await chmod(filePath, 0o755);
}

async function standaloneFixture(options: {
  readonly root?: string;
  readonly extraResourceFiles?: number;
} = {}): Promise<{ root: string; entrypoint: string }> {
  const root = options.root ?? await temporaryRoot("devspace-codex-standalone-");
  await mkdir(path.join(root, "bin"), { recursive: true });
  await mkdir(path.join(root, "codex-resources", "zsh", "bin"), { recursive: true });
  await mkdir(path.join(root, "codex-path"), { recursive: true });
  await writeFile(path.join(root, "codex-package.json"), JSON.stringify({
    layoutVersion: 1,
    version: "0.153.4",
    target: "x86_64-unknown-linux-musl",
    variant: "codex",
    entrypoint: "bin/codex",
    resourcesDir: "codex-resources",
    pathDir: "codex-path"
  }));
  const entrypoint = path.join(root, "bin", "codex");
  await writeExecutable(entrypoint);
  await writeExecutable(path.join(root, "bin", "codex-code-mode-host"), nativeFixtureBytes(2));
  await writeExecutable(path.join(root, "codex-resources", "bwrap"), nativeFixtureBytes(3));
  await writeExecutable(path.join(root, "codex-resources", "zsh", "bin", "zsh"), nativeFixtureBytes(4));
  await writeExecutable(path.join(root, "codex-path", "rg"), nativeFixtureBytes(5));
  await symlink("bin/codex", path.join(root, "codex"));
  for (let index = 0; index < (options.extraResourceFiles ?? 0); index += 1) {
    await writeFile(path.join(root, "codex-resources", `extra-${index}.txt`), "fixture");
  }
  return { root, entrypoint };
}

async function nodeNativeFixture(options: { readonly ambiguous?: boolean } = {}): Promise<{ root: string; wrapper: string }> {
  const root = await temporaryRoot("devspace-codex-node-");
  const wrapper = path.join(root, "bin", "codex.js");
  await mkdir(path.dirname(wrapper), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "@openai/codex",
    version: "0.153.4",
    bin: { codex: "bin/codex.js" },
    optionalDependencies: {
      "@openai/codex-linux-x64-musl": "0.153.4",
      ...(options.ambiguous ? { "@openai/codex-linux-x64-gnu": "0.153.4" } : {})
    }
  }));
  await writeFile(wrapper, "#!/usr/bin/env node\n// static fixture wrapper\n", { mode: 0o755 });
  await chmod(wrapper, 0o755);
  for (const target of options.ambiguous ? ["x86_64-unknown-linux-musl", "x86_64-unknown-linux-gnu"] : ["x86_64-unknown-linux-musl"]) {
    const suffix = target.endsWith("musl") ? "musl" : "gnu";
    const packageRoot = path.join(root, "node_modules", `@openai/codex-linux-x64-${suffix}`);
    await mkdir(path.join(packageRoot, "vendor", target, "bin"), { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: `@openai/codex-linux-x64-${suffix}`,
      version: "0.153.4",
      os: ["linux"],
      cpu: ["x64"]
    }));
    await writeExecutable(path.join(packageRoot, "vendor", target, "bin", "codex"), nativeFixtureBytes(suffix === "musl" ? 6 : 7));
  }
  return { root, wrapper };
}

test("recognizes the official standalone package through its safe convenience symlink", async () => {
  const fixture = await standaloneFixture();
  const artifact = await resolveCodexExecutionArtifact(path.join(fixture.root, "codex"));

  expect(artifact.layout).toBe("standalone-package");
  expect(artifact.canonicalSourceRoot).toBe(fixture.root);
  expect(artifact.entrypoint.relativePath).toBe("bin/codex");
  expect(artifact.entrypointSha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(artifact.entries.some((entry) => entry.relativePath === "codex" && entry.kind === "symlink")).toBe(true);
  expect(artifact.closureDigest).toMatch(/^[0-9a-f]{64}$/u);
});

test("recognizes the official node wrapper statically and chooses its native vendor payload", async () => {
  const fixture = await nodeNativeFixture();
  const artifact = await resolveCodexExecutionArtifact(fixture.wrapper);

  expect(artifact.layout).toBe("official-node-native-payload");
  expect(artifact.entrypoint.relativePath).toContain("vendor/x86_64-unknown-linux-musl/bin/codex");
  expect(artifact.entries.some((entry) => entry.relativePath === "bin/codex.js")).toBe(true);
});

test("recognizes a compatible direct native executable as a one-file closure", async () => {
  const root = await temporaryRoot("devspace-codex-native-");
  const executable = path.join(root, "codex");
  await writeExecutable(executable);

  const artifact = await resolveCodexExecutionArtifact(executable);

  expect(artifact.layout).toBe("self-contained-native");
  expect(artifact.entries).toHaveLength(1);
  expect(artifact.entrypoint.relativePath).toBe("codex");
});

test("rejects arbitrary shell and JavaScript launchers", async () => {
  const root = await temporaryRoot("devspace-codex-launcher-");
  const shell = path.join(root, "launcher.sh");
  const javascript = path.join(root, "launcher.js");
  await writeFile(shell, "#!/bin/sh\necho codex\n", { mode: 0o755 });
  await writeFile(javascript, "console.log('codex')\n", { mode: 0o755 });

  await expect(resolveCodexExecutionArtifact(shell)).rejects.toThrow("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  await expect(resolveCodexExecutionArtifact(javascript)).rejects.toThrow("CODEX_UNRECOGNIZED_EXECUTION_FORM");
});

test("rejects traversal and unexpected package links", async () => {
  const fixture = await standaloneFixture();
  const outside = path.join(await temporaryRoot("devspace-codex-outside-"), "outside");
  await writeFile(outside, "outside");
  await rm(path.join(fixture.root, "codex-resources", "bwrap"));
  await symlink(path.relative(path.join(fixture.root, "codex-resources"), outside), path.join(fixture.root, "codex-resources", "bwrap"));

  await expect(resolveCodexExecutionArtifact(path.join(fixture.root, "codex")))
    .rejects.toThrow("CODEX_UNRECOGNIZED_EXECUTION_FORM");
});

test("rejects ambiguous native optional dependencies without executing the wrapper", async () => {
  const fixture = await nodeNativeFixture({ ambiguous: true });
  await expect(resolveCodexExecutionArtifact(fixture.wrapper)).rejects.toThrow("CODEX_UNRECOGNIZED_EXECUTION_FORM");
});

test("rejects a package closure over the bounded entry count", async () => {
  const fixture = await standaloneFixture({ extraResourceFiles: 4096 });
  await expect(resolveCodexExecutionArtifact(path.join(fixture.root, "codex")))
    .rejects.toThrow("CODEX_UNRECOGNIZED_EXECUTION_FORM");
});

test("detects changed closure members and link targets", async () => {
  const fixture = await standaloneFixture();
  const artifact = await resolveCodexExecutionArtifact(path.join(fixture.root, "codex"));
  await writeFile(path.join(fixture.root, "codex-resources", "bwrap"), nativeFixtureBytes(99));
  await expect(stageCodexExecutionArtifact({ artifact, stateRoot: await temporaryRoot("devspace-codex-stage-") }))
    .rejects.toThrow("CODEX_EXECUTABLE_INTEGRITY_CHANGED");

  const second = await standaloneFixture();
  await rm(path.join(second.root, "codex"));
  await symlink("bin/codex-code-mode-host", path.join(second.root, "codex"));
  await expect(resolveCodexExecutionArtifact(path.join(second.root, "codex")))
    .rejects.toThrow("CODEX_UNRECOGNIZED_EXECUTION_FORM");
});

test("staging is independent from a later configured-path replacement", async () => {
  const root = await temporaryRoot("devspace-codex-replacement-");
  const executable = path.join(root, "codex");
  await writeExecutable(executable, nativeFixtureBytes(11));
  const artifact = await resolveCodexExecutionArtifact(executable);
  const staged = await stageCodexExecutionArtifact({ artifact, stateRoot: await temporaryRoot("devspace-codex-stage-") });

  await writeFile(executable, nativeFixtureBytes(12), { mode: 0o755 });
  await verifyStagedCodexExecutionArtifact(staged);
  await expect(readFile(staged.entrypointPath)).resolves.toEqual(nativeFixtureBytes(11));
  await expect(lstat(staged.stagingRoot)).resolves.toBeTruthy();
});
