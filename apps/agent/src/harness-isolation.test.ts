import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createHarnessHomeStore } from "./harness-home.js";
import { createHarnessRuntime } from "./harness-runtime.js";

const projectId = "018f1f34-7000-7000-8000-000000000001";
const workspaceId = "018f1f34-7000-7000-8000-000000000002";
const wsB = "018f1f34-7000-7000-8000-00000000000b";
const sessionId = "018f1f34-7000-7000-8000-000000000003";
const processId = "018f1f34-7000-7000-8000-000000000004";
const terminalId = "018f1f34-7000-7000-8000-000000000005";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("codex and claude homes cannot share one materialized slot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-iso-"));
  roots.push(root);
  const home = createHarnessHomeStore(root);
  await mkdir(home.persistentHomePath("codex"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(home.persistentHomePath("codex"), "auth.json"), "codex-secret", { mode: 0o600 });
  await mkdir(home.persistentHomePath("claude"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(home.persistentHomePath("claude"), "auth.json"), "claude-secret", { mode: 0o600 });
  const lease = await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId: sessionId, processGeneration: 1 });
  const slot = await home.materialize({ workspaceId, harnessId: "codex", leaseId: lease.leaseId });
  expect(await readdir(slot.slotHostPath)).not.toContain("claude");
  expect(await readFile(path.join(slot.slotHostPath, "auth.json"), "utf8")).toBe("codex-secret");
});

test("one persistent home cannot be materialized by two workspaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-lease-"));
  roots.push(root);
  const home = createHarnessHomeStore(root);
  await home.acquireLease({ harnessId: "codex", workspaceId, aiSessionId: sessionId, processGeneration: 1 });
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000013", processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_HOME_IN_USE" });
});

test("custom harness exec env does not inherit CODEX_HOME", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-custom-iso-"));
  roots.push(root);
  const created: Array<{ environment: Record<string, string> }> = [];
  const runtime = createHarnessRuntime({
    home: createHarnessHomeStore(root),
    stateRoot: root,
    createHarnessExec: (input) => { created.push({ environment: { ...input.environment } }); return Promise.resolve(); },
    inspectSlot: () => Promise.resolve({ state: "missing" }),
    imageCodex: { present: true, version: null }
  });
  runtime.registerCustom({
    id: "my-agent", displayName: "My Agent", origin: "custom",
    launch: { executable: "my-agent", args: [] }, resume: null, environment: {}, privateState: { kind: "none" }
  });
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "my-agent", processId, terminalId, processGeneration: 1
  });
  expect(created[0]?.environment.CODEX_HOME).toBeUndefined();
});
