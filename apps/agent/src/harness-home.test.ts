import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createHarnessHomeStore, type HarnessHomeStore } from "./harness-home.js";

const workspaceId = "018f1f34-7000-7000-8000-000000000001";
const wsA = "018f1f34-7000-7000-8000-00000000000a";
const wsB = "018f1f34-7000-7000-8000-00000000000b";
const otherWorkspace = "018f1f34-7000-7000-8000-00000000000c";
const aiSessionId = "018f1f34-7000-7000-8000-000000000011";
const sessionA = "018f1f34-7000-7000-8000-000000000012";
const sessionB = "018f1f34-7000-7000-8000-000000000013";
const otherSession = "018f1f34-7000-7000-8000-000000000014";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store(): Promise<{ home: HarnessHomeStore; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-home-"));
  roots.push(root);
  return { home: createHarnessHomeStore(root), root };
}

async function writeAuth(homePath: string, value: string): Promise<void> {
  await mkdir(homePath, { recursive: true, mode: 0o700 });
  await writeFile(path.join(homePath, "auth.json"), value, { mode: 0o600 });
}

test("codex materialize does not expose a sibling claude auth file", async () => {
  const { home } = await store();
  await writeAuth(home.persistentHomePath("codex"), "codex-secret");
  await writeAuth(home.persistentHomePath("claude"), "claude-secret");
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId, harnessId: "codex", leaseId: lease.leaseId });
  const names = await readdir(slot.slotHostPath);
  expect(names).not.toContain("claude");
  expect(await readFile(path.join(slot.slotHostPath, "auth.json"), "utf8")).toBe("codex-secret");
});

test("second workspace cannot acquire the same harness home lease", async () => {
  const { home } = await store();
  await home.acquireLease({ harnessId: "codex", workspaceId: wsA, aiSessionId: sessionA, processGeneration: 1 });
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: sessionB, processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_HOME_IN_USE" });
});

test("same workspace re-acquires its lease after simulated agent restart", async () => {
  const { home } = await store();
  const first = await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId, processGeneration: 1 });
  const again = await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId, processGeneration: 1 });
  expect(again.leaseId).toBe(first.leaseId);
});

test("stale lease after writeback-before-release is recovered then acquired by another workspace", async () => {
  const { home } = await store();
  const leaseA = await home.acquireLease({
    harnessId: "codex", workspaceId: wsA, aiSessionId: sessionA, processGeneration: 1
  });
  await home.materialize({ workspaceId: wsA, harnessId: "codex", leaseId: leaseA.leaseId });
  await home.writeBackAndClear({ workspaceId: wsA, leaseId: leaseA.leaseId });
  await home.reapStaleLeases();
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: sessionB, processGeneration: 1
  })).resolves.toMatchObject({ leaseId: expect.any(String) });
});

test("rejects symlink, special file, path escape, oversize file, and over-count trees", async () => {
  const { home } = await store();
  const homePath = home.persistentHomePath("codex");
  await mkdir(homePath, { recursive: true, mode: 0o700 });
  await symlink("/tmp/outside", path.join(homePath, "link"));
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId, processGeneration: 1 });
  await expect(home.materialize({ workspaceId, harnessId: "codex", leaseId: lease.leaseId }))
    .rejects.toMatchObject({ code: "HARNESS_HOME_UNSUPPORTED" });
});

test("failed writeback leaves the previous persistent home intact and keeps the lease", async () => {
  const { home } = await store();
  await writeAuth(home.persistentHomePath("codex"), "previous");
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId, harnessId: "codex", leaseId: lease.leaseId });
  await symlink("/tmp/outside", path.join(slot.slotHostPath, "bad"));
  await expect(home.writeBackAndClear({ workspaceId, leaseId: lease.leaseId }))
    .rejects.toMatchObject({ code: "HARNESS_HOME_UNSUPPORTED" });
  expect(await readFile(path.join(home.persistentHomePath("codex"), "auth.json"), "utf8")).toBe("previous");
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: otherWorkspace, aiSessionId: otherSession, processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_HOME_IN_USE" });
});

test("rejects a harnessId with ..", async () => {
  const { home } = await store();
  await expect(home.acquireLease({
    harnessId: "../etc", workspaceId, aiSessionId, processGeneration: 1
  })).rejects.toThrow();
});

test("writeback restores only the recorded owner home", async () => {
  const { home } = await store();
  await writeAuth(home.persistentHomePath("codex"), "codex-before");
  await writeAuth(home.persistentHomePath("claude"), "claude-before");
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId, harnessId: "codex", leaseId: lease.leaseId });
  await writeFile(path.join(slot.slotHostPath, "auth.json"), "codex-after", { mode: 0o600 });
  await home.writeBackAndClear({ workspaceId, leaseId: lease.leaseId });
  expect(await readFile(path.join(home.persistentHomePath("codex"), "auth.json"), "utf8")).toBe("codex-after");
  expect(await readFile(path.join(home.persistentHomePath("claude"), "auth.json"), "utf8")).toBe("claude-before");
  expect(await readdir(slot.slotHostPath)).toEqual([]);
});
