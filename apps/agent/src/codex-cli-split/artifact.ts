import { lstat, readlink, symlink } from "node:fs/promises";
import path from "node:path";
import {
  resolveCodexExecutionArtifact,
  stageCodexExecutionArtifact,
  verifyStagedCodexExecutionArtifact,
  type CodexExecutionArtifact,
  type StagedCodexExecutionArtifact
} from "../codex-app-server/artifact-identity.js";
import { architectureCompatible } from "../codex-app-server/probe-runtime.js";
import {
  assertContained,
  establishPinnedDirectory,
  lstatIdentity
} from "../private-state.js";
import type { DockerImageInspection } from "../docker-runtime.js";

export interface CodexSplitArtifactBinding {
  readonly staged: StagedCodexExecutionArtifact;
  readonly packageVersion: string;
  readonly closureDigest: string;
  readonly mountTarget: "/opt/devspace/codex";
  readonly entrypointPath: string;
  readonly launcherPath: "/opt/devspace/codex-launcher/codex";
  readonly launcherSourceRoot: string;
  readonly launcherSourcePath: string;
}

function absolutePath(value: string, code: string): string {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(code);
  return path.resolve(value);
}

function hasSandboxHelper(artifact: CodexExecutionArtifact): boolean {
  return artifact.entries.some((entry) => entry.kind === "file"
    && (entry.relativePath === "codex-resources/bwrap" || entry.relativePath.endsWith("/codex-resources/bwrap")));
}

async function ensureLauncher(input: {
  readonly root: string;
  readonly target: string;
}): Promise<string> {
  await establishPinnedDirectory(input.root);
  const launcher = path.join(input.root, "codex");
  const observed = await lstatIdentity(launcher);
  if (observed === null) {
    await symlink(input.target, launcher);
  } else {
    if (!observed.stats.isSymbolicLink() || await readlink(launcher, "utf8") !== input.target) {
      throw new Error("codex-launcher-integrity");
    }
  }
  const verified = await lstatIdentity(launcher);
  if (verified === null || !verified.stats.isSymbolicLink() || await readlink(launcher, "utf8") !== input.target) {
    throw new Error("codex-launcher-integrity");
  }
  return launcher;
}

export async function prepareCodexSplitArtifact(input: {
  readonly configuredPath: string;
  readonly stateRoot: string;
}): Promise<CodexSplitArtifactBinding> {
  const configuredPath = absolutePath(input.configuredPath, "codex-artifact-path-invalid");
  const stateRoot = absolutePath(input.stateRoot, "codex-artifact-state-root-invalid");
  const artifact = await resolveCodexExecutionArtifact(configuredPath);
  if (artifact.packageVersion !== "0.153.4") throw new Error("codex-artifact-version-not-admitted");
  if (artifact.target.os !== "linux" || !hasSandboxHelper(artifact)) {
    throw new Error("codex-artifact-closure-incompatible");
  }
  const staged = await stageCodexExecutionArtifact({ artifact, stateRoot });
  assertContained(stateRoot, staged.stagingRoot);
  await verifyStagedCodexExecutionArtifact(staged);
  const launcherSourceRoot = path.join(stateRoot, "codex-split-launchers", artifact.closureDigest);
  const entrypointPath = path.posix.join("/opt/devspace/codex", artifact.entrypoint.relativePath);
  const launcherSourcePath = await ensureLauncher({ root: launcherSourceRoot, target: entrypointPath });
  return {
    staged,
    packageVersion: artifact.packageVersion,
    closureDigest: artifact.closureDigest,
    mountTarget: "/opt/devspace/codex",
    entrypointPath,
    launcherPath: "/opt/devspace/codex-launcher/codex",
    launcherSourceRoot,
    launcherSourcePath
  };
}

export function assertCodexArtifactCompatibleWithImage(input: {
  readonly artifact: CodexSplitArtifactBinding;
  readonly image: DockerImageInspection;
}): void {
  if (input.artifact.packageVersion !== "0.153.4") throw new Error("codex-artifact-version-not-admitted");
  if (input.image.Os !== "linux") throw new Error("codex-artifact-image-os");
  if (!architectureCompatible(input.artifact.staged.artifact.target.architecture, input.image.Architecture)) {
    throw new Error("codex-artifact-image-architecture");
  }
  if (!hasSandboxHelper(input.artifact.staged.artifact)) throw new Error("codex-artifact-sandbox-helper-missing");
}

export function codexCommand(artifact: CodexSplitArtifactBinding, args: readonly string[]): readonly string[] {
  if (args.some((argument) => argument.includes("\0"))) throw new Error("codex-command-invalid");
  return [artifact.launcherPath, ...args];
}
