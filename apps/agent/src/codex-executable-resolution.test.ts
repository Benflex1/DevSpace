import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { resolveCodexExecutablePath } from "./codex-executable-resolution.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

test("uses the explicit deployment executable path before PATH", () => {
  expect(resolveCodexExecutablePath({
    DEVSPACE_CODEX_EXECUTABLE_PATH: "/srv/devspace/bin/codex",
    PATH: "/path-that-does-not-contain-codex"
  })).toBe("/srv/devspace/bin/codex");
});

test("resolves Codex from an executable in an absolute non-personal PATH entry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-codex-resolution-test-"));
  roots.push(root);
  const bin = path.join(root, "deployment-bin");
  await mkdir(bin);
  const executable = path.join(bin, "codex");
  await writeFile(executable, "codex fixture", { mode: 0o755 });
  await chmod(executable, 0o755);

  expect(resolveCodexExecutablePath({ PATH: bin })).toBe(executable);
  expect(executable).not.toContain("/home/benjamin/");
});

test("does not substitute a personal home path when the deployment variable is absent", () => {
  expect(() => resolveCodexExecutablePath({ PATH: "/srv/devspace/bin" })).toThrow("CODEX_EXECUTABLE_MISSING");
});

test("fails closed when Codex is missing from PATH", () => {
  expect(() => resolveCodexExecutablePath({ PATH: "" })).toThrow("CODEX_EXECUTABLE_MISSING");
});
