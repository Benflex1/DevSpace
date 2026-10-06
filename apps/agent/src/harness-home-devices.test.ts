import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { createHarnessHomeStore } from "./harness-home.js";

const syntheticDevices = vi.hoisted(() => new Map<string, "block" | "character">());

vi.mock("node:fs/promises", async (importOriginal) => {
  type FsPromisesModule = typeof import("node:fs/promises");
  const actual = await importOriginal<FsPromisesModule>();
  return {
    ...actual,
    lstat: vi.fn(async (...args: Parameters<typeof actual.lstat>) => {
      const stats = await actual.lstat(...args);
      const kind = syntheticDevices.get(String(args[0]));
      if (kind === undefined) return stats;
      const special = Object.create(stats) as typeof stats;
      special.isSymbolicLink = () => false;
      special.isSocket = () => false;
      special.isFIFO = () => false;
      special.isBlockDevice = () => kind === "block";
      special.isCharacterDevice = () => kind === "character";
      special.isDirectory = () => false;
      special.isFile = () => false;
      return special;
    })
  };
});

const workspaceId = "018f1f34-7000-7000-8000-00000000000a";
const otherWorkspaceId = "018f1f34-7000-7000-8000-00000000000b";
const sessionId = "018f1f34-7000-7000-8000-000000000012";
const otherSessionId = "018f1f34-7000-7000-8000-000000000013";
const roots: string[] = [];

afterEach(async () => {
  syntheticDevices.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.each([
  ["character", "outside-cache"],
  ["block", "outside-cache"],
  ["character", "codex-cache"],
  ["block", "codex-cache"]
] as const)("writeback rejects %s devices %s", async (kind, location) => {
  const root = await mkdtemp(path.join(tmpdir(), "hh-device-"));
  roots.push(root);
  const home = createHarnessHomeStore(root);
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId: sessionId, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId, harnessId: "codex", leaseId: lease.leaseId });
  const devicePath = location === "codex-cache"
    ? path.join(slot.slotHostPath, "packages", "app-server-daemon", "releases", `${kind}-device`)
    : path.join(slot.slotHostPath, `${kind}-device`);
  await mkdir(path.dirname(devicePath), { recursive: true });
  await writeFile(devicePath, "test fixture");
  syntheticDevices.set(devicePath, kind);

  await expect(home.writeBackAndClear({ workspaceId, leaseId: lease.leaseId }))
    .rejects.toMatchObject({ code: "HARNESS_HOME_UNSUPPORTED" });
  await expect(home.acquireLease({ harnessId: "codex", workspaceId: otherWorkspaceId, aiSessionId: otherSessionId, processGeneration: 1 }))
    .rejects.toMatchObject({ code: "HARNESS_HOME_IN_USE" });
});
