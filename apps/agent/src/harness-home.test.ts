import { chmod, mkdtemp, mkdir, open, lstat, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:net";
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
const unixSocketServers: Server[] = [];

afterEach(async () => {
  await Promise.all(unixSocketServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    if (!server.listening) { resolve(); return; }
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store(options?: Parameters<typeof createHarnessHomeStore>[1]): Promise<{ home: HarnessHomeStore; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "hh-"));
  roots.push(root);
  return { home: createHarnessHomeStore(root, options), root };
}

async function writeAuth(homePath: string, value: string): Promise<void> {
  await mkdir(homePath, { recursive: true, mode: 0o700 });
  await writeFile(path.join(homePath, "auth.json"), value, { mode: 0o600 });
}

async function bindUnixSocket(socketPath: string): Promise<void> {
  const server = createServer();
  unixSocketServers.push(server);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
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

test("a dirty slot blocks a new lease when its lease metadata is missing", async () => {
  const { home, root } = await store();
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId: wsA, aiSessionId: sessionA, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId: wsA, harnessId: "codex", leaseId: lease.leaseId });
  await rm(path.join(home.persistentHomePath("codex"), ".lease"), { recursive: true, force: true });

  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: sessionB, processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_HOME_IN_USE" });
  expect(await readdir(slot.slotHostPath)).toEqual([]);
  expect(await readFile(path.join(root, "harness-meta", `${wsA}.json`), "utf8")).toContain('"dirty":true');
});

test("stale lease after writeback-before-release is recovered then acquired by another workspace", async () => {
  const { home } = await store();
  const leaseA = await home.acquireLease({
    harnessId: "codex", workspaceId: wsA, aiSessionId: sessionA, processGeneration: 1
  });
  await home.materialize({ workspaceId: wsA, harnessId: "codex", leaseId: leaseA.leaseId });
  await home.writeBackAndClear({ workspaceId: wsA, leaseId: leaseA.leaseId });
  await home.reapStaleLeases();
  const leaseB = await home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: sessionB, processGeneration: 1
  });
  expect(leaseB.leaseId).toEqual(expect.any(String));
});

test("writes back native homes with the entry count observed during orphan recovery", async () => {
  const { home } = await store();
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId, harnessId: "codex", leaseId: lease.leaseId });
  for (let index = 0; index < 8_300; index += 1) {
    await mkdir(path.join(slot.slotHostPath, `entry-${index}`));
  }

  await home.writeBackAndClear({ workspaceId, leaseId: lease.leaseId });

  expect((await readdir(home.persistentHomePath("codex"))).filter((name) => name !== ".lease")).toHaveLength(8_300);
  expect(await readdir(slot.slotHostPath)).toEqual([]);
  await home.releaseLease({ harnessId: "codex", leaseId: lease.leaseId });
}, 20_000);

test("preserves absolute symlink objects without dereferencing their targets", async () => {
  const { home, root } = await store();
  const homePath = home.persistentHomePath("codex");
  const outsideTarget = path.join(root, "target-outside-home");
  await writeAuth(homePath, "codex-before");
  await writeFile(outsideTarget, "this target must never be copied through the link");
  await symlink(outsideTarget, path.join(homePath, "link"));
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId, harnessId: "codex", leaseId: lease.leaseId });
  const slotLink = path.join(slot.slotHostPath, "link");
  expect((await lstat(slotLink)).isSymbolicLink()).toBe(true);
  expect(await readlink(slotLink)).toBe(outsideTarget);

  await home.writeBackAndClear({ workspaceId, leaseId: lease.leaseId });
  const persistentLink = path.join(homePath, "link");
  expect((await lstat(persistentLink)).isSymbolicLink()).toBe(true);
  expect(await readlink(persistentLink)).toBe(outsideTarget);
  expect(await readFile(path.join(homePath, "auth.json"), "utf8")).toBe("codex-before");
  expect(await readdir(slot.slotHostPath)).toEqual([]);
});

test("writeback omits ephemeral Unix sockets and rematerializes durable home state", async () => {
  const { home, root } = await store();
  const homePath = home.persistentHomePath("codex");
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId: wsA, aiSessionId: sessionA, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId: wsA, harnessId: "codex", leaseId: lease.leaseId });
  await mkdir(path.join(slot.slotHostPath, "app-server-daemon"));
  await mkdir(path.join(slot.slotHostPath, "state"));
  await writeFile(path.join(slot.slotHostPath, "state", "durable.json"), "durable-state");
  await symlink("state/durable.json", path.join(slot.slotHostPath, "durable-link"));
  const socketPath = path.join(slot.slotHostPath, "app-server-daemon", "daemon-updater.sock");
  await bindUnixSocket(socketPath);

  await expect(home.writeBackAndClear({ workspaceId: wsA, leaseId: lease.leaseId })).resolves.toBeUndefined();

  expect(await readFile(path.join(homePath, "state", "durable.json"), "utf8")).toBe("durable-state");
  expect(await readlink(path.join(homePath, "durable-link"))).toBe("state/durable.json");
  await expect(lstat(path.join(homePath, "app-server-daemon", "daemon-updater.sock"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(path.join(root, "harness-meta", `${wsA}.json`), "utf8"))).toMatchObject({ dirty: false });
  expect(await readdir(slot.slotHostPath)).toEqual([]);

  await home.releaseLease({ harnessId: "codex", leaseId: lease.leaseId });
  const nextLease = await home.acquireLease({ harnessId: "codex", workspaceId: wsB, aiSessionId: sessionB, processGeneration: 1 });
  const nextSlot = await home.materialize({ workspaceId: wsB, harnessId: "codex", leaseId: nextLease.leaseId });
  expect(await readFile(path.join(nextSlot.slotHostPath, "state", "durable.json"), "utf8")).toBe("durable-state");
  expect(await readlink(path.join(nextSlot.slotHostPath, "durable-link"))).toBe("state/durable.json");
  await expect(lstat(path.join(nextSlot.slotHostPath, "app-server-daemon", "daemon-updater.sock"))).rejects.toMatchObject({ code: "ENOENT" });
  await home.writeBackAndClear({ workspaceId: wsB, leaseId: nextLease.leaseId });
  await home.releaseLease({ harnessId: "codex", leaseId: nextLease.leaseId });
});

test("uses exact workspace-user cleanup when rootless container ownership blocks host slot removal", async () => {
  const cleanedWorkspaces: string[] = [];
  let slotPath = "";
  let protectedDirectory = "";
  const { home } = await store({
    clearSlotAsWorkspaceUser: async (workspaceId) => {
      cleanedWorkspaces.push(workspaceId);
      await chmod(protectedDirectory, 0o700);
      for (const entry of await readdir(slotPath)) await rm(path.join(slotPath, entry), { recursive: true, force: true });
    }
  });
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId: wsA, aiSessionId: sessionA, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId: wsA, harnessId: "codex", leaseId: lease.leaseId });
  slotPath = slot.slotHostPath;
  const privateCache = path.join(slotPath, "packages", "app-server-daemon", "releases", "0.159.3", "bin");
  protectedDirectory = privateCache;
  await mkdir(privateCache, { recursive: true });
  await writeFile(path.join(privateCache, "codex"), "ephemeral");
  await chmod(privateCache, 0o555);

  await home.writeBackAndClear({ workspaceId: wsA, leaseId: lease.leaseId });
  await home.releaseLease({ harnessId: "codex", leaseId: lease.leaseId });

  expect(cleanedWorkspaces).toEqual([wsA]);
  expect(await readdir(slotPath)).toEqual([]);
  await expect(lstat(path.join(home.persistentHomePath("codex"), "packages", "app-server-daemon", "releases")))
    .rejects.toMatchObject({ code: "ENOENT" });
});

test("persistent Unix sockets fail closed during slot materialization", async () => {
  const { home } = await store();
  const homePath = home.persistentHomePath("codex");
  await writeAuth(homePath, "durable-state");
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId: wsA, aiSessionId: sessionA, processGeneration: 1 });
  await bindUnixSocket(path.join(homePath, "runtime.sock"));

  await expect(home.materialize({ workspaceId: wsA, harnessId: "codex", leaseId: lease.leaseId }))
    .rejects.toMatchObject({ code: "HARNESS_HOME_UNSUPPORTED" });
  await home.releaseLease({ harnessId: "codex", leaseId: lease.leaseId });
});

test("Codex app-server release cache is omitted from bounded home copies", async () => {
  const { home } = await store();
  const homePath = home.persistentHomePath("codex");
  const releases = path.join(homePath, "packages", "app-server-daemon", "releases");
  await mkdir(releases, { recursive: true });
  await writeFile(path.join(homePath, "config.toml"), "durable-config");
  for (let index = 0; index < 6; index += 1) {
    const version = `0.159.${index}`;
    const versionDir = path.join(releases, version, "bin");
    await mkdir(versionDir, { recursive: true });
    const artifact = await open(path.join(versionDir, "codex"), "w");
    try {
      await artifact.truncate(180 * 1024 * 1024);
    } finally {
      await artifact.close();
    }
  }
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId: wsA, aiSessionId: sessionA, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId: wsA, harnessId: "codex", leaseId: lease.leaseId });

  expect(await readFile(path.join(slot.slotHostPath, "config.toml"), "utf8")).toBe("durable-config");
  await expect(lstat(path.join(slot.slotHostPath, "packages", "app-server-daemon", "releases")))
    .rejects.toMatchObject({ code: "ENOENT" });

  const generatedCache = path.join(slot.slotHostPath, "packages", "app-server-daemon", "releases", "0.159.9", "bin");
  await mkdir(generatedCache, { recursive: true });
  await writeFile(path.join(generatedCache, "codex"), "ephemeral-package-binary");
  await home.writeBackAndClear({ workspaceId: wsA, leaseId: lease.leaseId });

  expect(await readFile(path.join(homePath, "config.toml"), "utf8")).toBe("durable-config");
  await expect(lstat(path.join(homePath, "packages", "app-server-daemon", "releases")))
    .rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(slot.slotHostPath)).toEqual([]);
  await home.releaseLease({ harnessId: "codex", leaseId: lease.leaseId });
}, 20_000);

test("Codex cache traversal still rejects FIFO and enforces entry bounds", async () => {
  const { home } = await store();
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId: wsA, aiSessionId: sessionA, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId: wsA, harnessId: "codex", leaseId: lease.leaseId });
  const releases = path.join(slot.slotHostPath, "packages", "app-server-daemon", "releases");
  await mkdir(releases, { recursive: true });
  execFileSync("mkfifo", [path.join(releases, "unexpected-pipe")]);

  await expect(home.writeBackAndClear({ workspaceId: wsA, leaseId: lease.leaseId }))
    .rejects.toMatchObject({ code: "HARNESS_HOME_UNSUPPORTED" });
  await rm(path.join(releases, "unexpected-pipe"));
  await rm(path.join(slot.slotHostPath, "packages"), { recursive: true, force: true });
  await mkdir(releases, { recursive: true });
  for (let index = 0; index < 16_381; index += 1) await mkdir(path.join(releases, `entry-${index}`));

  await expect(home.writeBackAndClear({ workspaceId: wsA, leaseId: lease.leaseId }))
    .rejects.toThrow("entry count exceeds the bound");
}, 30_000);

test("writeback continues to reject FIFOs", async () => {
  const { home } = await store();
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId: wsA, aiSessionId: sessionA, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId: wsA, harnessId: "codex", leaseId: lease.leaseId });
  execFileSync("mkfifo", [path.join(slot.slotHostPath, "pipe")]);

  await expect(home.writeBackAndClear({ workspaceId: wsA, leaseId: lease.leaseId }))
    .rejects.toMatchObject({ code: "HARNESS_HOME_UNSUPPORTED" });
  await expect(home.acquireLease({ harnessId: "codex", workspaceId: wsB, aiSessionId: sessionB, processGeneration: 1 }))
    .rejects.toMatchObject({ code: "HARNESS_HOME_IN_USE" });
});

test("Unix sockets count toward the bounded entry traversal", async () => {
  const { home } = await store();
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId: wsA, aiSessionId: sessionA, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId: wsA, harnessId: "codex", leaseId: lease.leaseId });
  const bulk = path.join(slot.slotHostPath, "bulk");
  await mkdir(bulk);
  for (let index = 0; index < 16_382; index += 1) await mkdir(path.join(bulk, `entry-${index}`));
  await bindUnixSocket(path.join(slot.slotHostPath, "runtime.sock"));

  await expect(home.writeBackAndClear({ workspaceId: wsA, leaseId: lease.leaseId }))
    .rejects.toThrow("entry count exceeds the bound");
}, 30_000);

test("retry after a completed socket-omitting writeback is idempotent", async () => {
  const { home, root } = await store();
  const homePath = home.persistentHomePath("codex");
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId: wsA, aiSessionId: sessionA, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId: wsA, harnessId: "codex", leaseId: lease.leaseId });
  await writeFile(path.join(slot.slotHostPath, "state.json"), "settled-once");
  await bindUnixSocket(path.join(slot.slotHostPath, "runtime.sock"));
  await home.writeBackAndClear({ workspaceId: wsA, leaseId: lease.leaseId });

  const restarted = createHarnessHomeStore(root);
  await restarted.writeBackAndClear({ workspaceId: wsA, leaseId: lease.leaseId });
  await restarted.releaseLease({ harnessId: "codex", leaseId: lease.leaseId });

  expect(await readFile(path.join(homePath, "state.json"), "utf8")).toBe("settled-once");
  await expect(lstat(path.join(homePath, "runtime.sock"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(slot.slotHostPath)).toEqual([]);
});

test("writeback ignores a container-created reserved .lease entry", async () => {
  const { home } = await store();
  const homePath = home.persistentHomePath("codex");
  await writeAuth(homePath, "previous-home");
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId, harnessId: "codex", leaseId: lease.leaseId });
  await symlink("/container-only-target", path.join(slot.slotHostPath, ".lease"));

  await home.writeBackAndClear({ workspaceId, leaseId: lease.leaseId });

  expect(await readFile(path.join(homePath, "auth.json"), "utf8")).toBe("previous-home");
  expect(await readFile(path.join(homePath, ".lease", "metadata.json"), "utf8")).toContain(lease.leaseId);
  expect(await readdir(slot.slotHostPath)).toEqual([]);
});

test("unsupported file writeback leaves the previous persistent home intact and keeps the lease", async () => {
  const { home } = await store();
  await writeAuth(home.persistentHomePath("codex"), "previous");
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId, harnessId: "codex", leaseId: lease.leaseId });
  const tooLarge = await open(path.join(slot.slotHostPath, "too-large"), "wx", 0o600);
  await tooLarge.truncate(32 * 1024 * 1024 + 1);
  await tooLarge.close();
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

test("a finalized slot can retry writeback and release without overwriting a newer lease", async () => {
  const { home } = await store();
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId: wsA, aiSessionId: sessionA, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId: wsA, harnessId: "codex", leaseId: lease.leaseId });
  await writeFile(path.join(slot.slotHostPath, "auth.json"), "completed-home", { mode: 0o600 });
  await home.writeBackAndClear({ workspaceId: wsA, leaseId: lease.leaseId });
  await home.releaseLease({ harnessId: "codex", leaseId: lease.leaseId });

  await home.writeBackAndClear({ workspaceId: wsA, leaseId: lease.leaseId });
  const [, newerLease] = await Promise.all([
    home.releaseLease({ harnessId: "codex", leaseId: lease.leaseId }),
    home.acquireLease({ harnessId: "codex", workspaceId: wsB, aiSessionId: sessionB, processGeneration: 1 })
  ]);

  expect(await readFile(path.join(home.persistentHomePath("codex"), "auth.json"), "utf8")).toBe("completed-home");
  expect(await readdir(slot.slotHostPath)).toEqual([]);
  expect(newerLease.leaseId).not.toBe(lease.leaseId);
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: otherWorkspace, aiSessionId: otherSession, processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_HOME_IN_USE" });
});
