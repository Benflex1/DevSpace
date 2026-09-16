import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { nativeCodexHomePath, ensureNativeCodexHome } from "./native-home.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

test("derives the owner-private native home below the Agent state root", () => {
  expect(nativeCodexHomePath("/srv/devspace/state")).toBe("/srv/devspace/state/codex-homes/owner-default");
  expect(() => nativeCodexHomePath("/srv/devspace/state\0unsafe")).toThrow("native-home-state-root-invalid");
});

test("creates and pins a restrictive native home without reading its contents", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-native-home-"));
  roots.push(root);
  const homePath = path.join(root, "state", "codex-homes", "owner-default");
  const ownerUid = process.getuid?.() ?? 0;
  const ownerGid = process.getgid?.() ?? 0;
  const binding = await ensureNativeCodexHome({ homePath, ownerUid, ownerGid });
  expect(binding.mountTarget).toBe("/codex-home");
  expect(binding.homePath).toBe(homePath);
  expect(binding.identity).toEqual(expect.objectContaining({ device: expect.any(String), inode: expect.any(String) }));
  const stats = await lstat(homePath);
  expect(stats.isDirectory()).toBe(true);
  expect(stats.isSymbolicLink()).toBe(false);
  expect(stats.mode & 0o777).toBe(0o700);
});

test("rejects a symlinked or incorrectly owned/mode native home", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-native-home-invalid-"));
  roots.push(root);
  const homePath = path.join(root, "state", "codex-homes", "owner-default");
  await mkdir(path.dirname(homePath), { recursive: true });
  await symlink(root, homePath);
  await expect(ensureNativeCodexHome({ homePath, ownerUid: process.getuid?.() ?? 0, ownerGid: process.getgid?.() ?? 0 }))
    .rejects.toThrow("native-home");

  const validPath = path.join(root, "valid");
  const binding = await ensureNativeCodexHome({ homePath: validPath, ownerUid: process.getuid?.() ?? 0, ownerGid: process.getgid?.() ?? 0 });
  await chmod(validPath, 0o755);
  await expect(ensureNativeCodexHome({ homePath: validPath, ownerUid: process.getuid?.() ?? 0, ownerGid: process.getgid?.() ?? 0 }))
    .rejects.toThrow("native-home-mode");
  await chmod(validPath, 0o700);
  await expect(ensureNativeCodexHome({
    homePath: validPath,
    ownerUid: (process.getuid?.() ?? 0) + 1,
    ownerGid: process.getgid?.() ?? 0
  })).rejects.toThrow("native-home-owner");
  expect(binding.homePath).toBe(validPath);
});
