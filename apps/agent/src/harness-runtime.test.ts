/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method -- harness fixtures model async boundaries. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { TaskStartRecoveryRequiredError } from "./execution-manager.js";
import { createHarnessHomeStore } from "./harness-home.js";
import { createHarnessRuntime } from "./harness-runtime.js";
import type { HarnessSlotMountObservation } from "./workspace-runtime.js";

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

async function fixture(input: {
  slot?: HarnessSlotMountObservation;
  recreate?: () => Promise<HarnessSlotMountObservation>;
  imageHasCodex?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-runtime-"));
  roots.push(root);
  const home = createHarnessHomeStore(root);
  const createdExecs: Array<{ command: readonly string[]; environment: Record<string, string> }> = [];
  let slot: HarnessSlotMountObservation = input.slot ?? { state: "present-and-exact" };
  const runtime = createHarnessRuntime({
    home,
    stateRoot: root,
    createHarnessExec: async (exec) => {
      createdExecs.push({ command: exec.command, environment: { ...exec.environment } });
    },
    inspectSlot: async () => slot,
    recreateWorkspace: input.recreate ?? (async (workspace) => {
      void workspace;
      throw new Error("recreate-not-configured");
    }),
    imageCodex: { present: input.imageHasCodex !== false, version: "0.155.1" },
    artifact: { available: true, version: "0.145.0", command: ["/opt/codex/codex"] }
  });
  return { runtime, home, createdExecs, setSlot: (next: HarnessSlotMountObservation) => { slot = next; }, root };
}

test("codex launch env contains CODEX_HOME and not CLAUDE_CONFIG_DIR", async () => {
  const { runtime, createdExecs } = await fixture();
  const env = await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  expect(env.CODEX_HOME).toBe("/opt/devspace/harness-home");
  expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(env.HOME).not.toBe("/opt/devspace/harness-home");
  expect(createdExecs[0]?.command).toEqual(["codex", "--yolo"]);
});

test("image codex wins over artifact on start", async () => {
  const { createdExecs, runtime } = await fixture({ imageHasCodex: true });
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  expect(createdExecs[0]?.command[0]).toBe("codex");
  expect(await runtime.publicSnapshot(sessionId)).toMatchObject({
    executableSource: { kind: "image-path", command: "codex", reportedVersion: "0.155.1" }
  });
});

test("custom start does not set CODEX_HOME and does not acquire a home lease", async () => {
  const { runtime, createdExecs, home } = await fixture();
  runtime.registerCustom({
    id: "my-agent", displayName: "My Agent", origin: "custom",
    launch: { executable: "my-agent", args: [] }, resume: null, environment: {}, privateState: { kind: "none" }
  });
  const env = await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "my-agent", processId, terminalId, processGeneration: 1
  });
  expect(env.CODEX_HOME).toBeUndefined();
  expect(createdExecs[0]?.command).toEqual(["my-agent"]);
  expect(createdExecs[0]?.environment.CODEX_HOME).toBeUndefined();
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).resolves.toMatchObject({ leaseId: expect.any(String) });
});

test("custom provider-handled resume is offered without a native id", async () => {
  const { runtime, createdExecs } = await fixture();
  runtime.registerCustom({
    id: "my-agent-continue", displayName: "Continue", origin: "custom",
    launch: { executable: "my-agent", args: [] },
    resume: { executable: "my-agent", args: ["--resume"] },
    environment: {}, privateState: { kind: "none" }
  });
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "my-agent-continue", processId, terminalId, processGeneration: 1
  });
  await runtime.settleExit({ sessionId });
  expect((await runtime.inspect({ harnessId: "my-agent-continue", workspaceId, sessionId })).capabilities.resume).toBe(true);
  const result = await runtime.resumeExec({
    sessionId, projectId, processId: "018f1f34-7000-7000-8000-000000000006",
    terminalId: "018f1f34-7000-7000-8000-000000000007", processGeneration: 2
  });
  expect(result.command).toEqual(["my-agent", "--resume"]);
  expect(createdExecs[1]?.command).toEqual(["my-agent", "--resume"]);
});

test("id-substitution resume with no native id fails closed and does not exec", async () => {
  const { runtime, createdExecs } = await fixture();
  runtime.registerCustom({
    id: "my-agent-id", displayName: "Id", origin: "custom",
    launch: { executable: "my-agent", args: [] },
    resume: { executable: "my-agent", args: ["--resume", "{sessionId}"] },
    environment: {}, privateState: { kind: "none" }
  });
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "my-agent-id", processId, terminalId, processGeneration: 1
  });
  await runtime.settleExit({ sessionId });
  expect((await runtime.inspect({ harnessId: "my-agent-id", workspaceId, sessionId })).capabilities.resume).toBe(false);
  const before = createdExecs.length;
  await expect(runtime.resumeExec({
    sessionId, projectId, processId: "018f1f34-7000-7000-8000-000000000006",
    terminalId: "018f1f34-7000-7000-8000-000000000007", processGeneration: 2
  })).rejects.toMatchObject({ code: "AI_CAPABILITY_UNSUPPORTED" });
  expect(createdExecs).toHaveLength(before);
});

test("second workspace cannot start Codex while the home is leased", async () => {
  const { runtime, createdExecs } = await fixture();
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  await expect(runtime.start({
    projectId, workspaceId: wsB, sessionId: "018f1f34-7000-7000-8000-000000000023",
    harnessId: "codex", processId: "018f1f34-7000-7000-8000-000000000024",
    terminalId: "018f1f34-7000-7000-8000-000000000025", processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_HOME_IN_USE" });
  expect(createdExecs).toHaveLength(1);
});

test("codex start with missing slot does not exec and recreates then launches", async () => {
  let recreates = 0;
  const { runtime, createdExecs, setSlot } = await fixture({
    slot: { state: "missing" },
    recreate: async () => {
      recreates += 1;
      setSlot({ state: "present-and-exact" });
      return { state: "present-and-exact" };
    }
  });
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  expect(recreates).toBe(1);
  expect(createdExecs).toHaveLength(1);
});

test("agent restart without exact exec evidence marks the session lost but preserves its lease and slot", async () => {
  const { runtime, home, root } = await fixture();
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  const slot = path.join(root, "harness-slots", workspaceId);
  await mkdir(path.join(slot, "sessions"), { recursive: true });
  await writeFile(path.join(slot, "sessions", "thread-crash.jsonl"), `${JSON.stringify({ id: "thread-crash", cwd: "/workspace" })}\n`);
  await runtime.recoverAfterAgentRestart();
  expect(await runtime.privateNativeId(sessionId)).toBeNull();
  expect(await runtime.publicSnapshot(sessionId)).toMatchObject({ state: "lost" });
  expect((await runtime.inspect({ harnessId: "codex", workspaceId, sessionId })).capabilities.resume).toBe(false);
  expect(await readdir(path.join(slot, "sessions"))).toEqual(["thread-crash.jsonl"]);
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_HOME_IN_USE" });
});

test("proven terminated recovery discovers the id and keeps the session lost", async () => {
  const { home, root } = await fixture();
  let recovery: {
    processId: string; workspaceId: string; sessionId: string; processGeneration: number; leaseId: string | null;
    observation: "terminated";
  } | null = null;
  const runtime = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async (input) => {
      recovery = { ...input, observation: "terminated" };
    },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    imageCodex: { present: true, version: null },
    observeHarnessRecovery: () => recovery === null ? [] : [recovery]
  });
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  const slot = path.join(root, "harness-slots", workspaceId);
  await mkdir(path.join(slot, "sessions"), { recursive: true });
  await writeFile(path.join(slot, "sessions", "thread-crash.jsonl"), `${JSON.stringify({ id: "thread-crash", cwd: "/workspace" })}\n`);
  await runtime.recoverAfterAgentRestart();
  expect(await runtime.privateNativeId(sessionId)).toBe("thread-crash");
  expect(await runtime.publicSnapshot(sessionId)).toMatchObject({ state: "lost" });
  expect((await runtime.inspect({ harnessId: "codex", workspaceId, sessionId })).capabilities.resume).toBe(true);
  expect(await readdir(slot)).toEqual([]);
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).resolves.toMatchObject({ leaseId: expect.any(String) });
});

test("recovery resumes safely after the lease was released before session persistence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-release-restart-"));
  roots.push(root);
  const home = createHarnessHomeStore(root);
  let releaseThenCrash = true;
  const interruptedHome = {
    ...home,
    releaseLease: async (input: { harnessId: string; leaseId: string }) => {
      await home.releaseLease(input);
      if (releaseThenCrash) {
        releaseThenCrash = false;
        throw new Error("simulated-agent-crash-after-lease-release");
      }
    }
  };
  let identity: { processId: string; workspaceId: string; sessionId: string; processGeneration: number; leaseId: string | null } | null = null;
  const recovery = () => identity === null ? [] : [{ ...identity, observation: "definitely-gone" as const }];
  const runtime = createHarnessRuntime({
    home: interruptedHome, stateRoot: root,
    createHarnessExec: async (input) => { identity = input; },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    observeHarnessRecovery: recovery,
    imageCodex: { present: true, version: null }
  });
  await runtime.start({ projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1 });
  const slot = path.join(root, "harness-slots", workspaceId, "sessions");
  await mkdir(slot, { recursive: true });
  await writeFile(path.join(slot, "thread-release-window.jsonl"), `${JSON.stringify({ id: "thread-release-window", cwd: "/workspace" })}\n`);

  await expect(runtime.recoverAfterAgentRestart()).rejects.toThrow("simulated-agent-crash-after-lease-release");
  expect(await runtime.privateNativeId(sessionId)).toBe("thread-release-window");
  expect(await readFile(path.join(root, "harness-homes", "codex", ".lease", "metadata.json"), "utf8").catch(() => null)).toBeNull();
  expect(await runtime.capability(sessionId)).toMatchObject({ state: "lost", resume: false });

  const restarted = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async () => { throw new Error("restart-must-not-exec"); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    observeHarnessRecovery: recovery,
    imageCodex: { present: true, version: null }
  });
  await restarted.recoverAfterAgentRestart();
  expect(await restarted.publicSnapshot(sessionId)).toMatchObject({ state: "lost" });
  expect(await restarted.privateNativeId(sessionId)).toBe("thread-release-window");
  expect(await restarted.capability(sessionId)).toMatchObject({ state: "lost", processGeneration: 1, resume: true });
  expect(await readdir(path.join(root, "harness-slots", workspaceId))).toEqual([]);
  expect(await readFile(path.join(home.persistentHomePath("codex"), "sessions", "thread-release-window.jsonl"), "utf8"))
    .toContain("thread-release-window");
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).resolves.toMatchObject({ leaseId: expect.any(String) });
});

test("agent restart does not invent an id when discovery finds nothing", async () => {
  const { runtime } = await fixture();
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  await runtime.recoverAfterAgentRestart();
  expect(await runtime.privateNativeId(sessionId)).toBeNull();
  expect((await runtime.inspect({ harnessId: "codex", workspaceId, sessionId })).capabilities.resume).toBe(false);
});

test("codex resume after discovery execs resume argv with native id", async () => {
  const { runtime, createdExecs, root } = await fixture();
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  const slot = path.join(root, "harness-slots", workspaceId);
  await mkdir(path.join(slot, "sessions"), { recursive: true });
  await writeFile(path.join(slot, "sessions", "thread-live.jsonl"), `${JSON.stringify({ id: "thread-live", cwd: "/workspace" })}\n`);
  await runtime.settleExit({ sessionId });
  const result = await runtime.resumeExec({
    sessionId, projectId, processId: "018f1f34-7000-7000-8000-000000000016",
    terminalId: "018f1f34-7000-7000-8000-000000000017", processGeneration: 2
  });
  expect(result.command).toEqual(["codex", "--yolo", "resume", "thread-live"]);
  expect(createdExecs.at(-1)?.command).toEqual(["codex", "--yolo", "resume", "thread-live"]);
  expect(createdExecs.at(-1)?.command[3]).toBe("thread-live");
  expect(createdExecs.at(-1)?.environment.CODEX_HOME).toBe("/opt/devspace/harness-home");
});

test("the misleading resume() entry point is not part of the runtime", async () => {
  const source = await readFile(new URL("./harness-runtime.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/async resume\(/u);
  expect(source).toMatch(/async resumeExec\(/u);
  const { runtime } = await fixture();
  expect("resume" in runtime).toBe(false);
  expect(runtime.resumeExec).toEqual(expect.any(Function));
});

test("exec-create failure after materialize releases the lease and keeps home bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-compensate-"));
  roots.push(root);
  const home = createHarnessHomeStore(root);
  await mkdir(home.persistentHomePath("codex"), { recursive: true });
  await writeFile(path.join(home.persistentHomePath("codex"), "auth.json"), "keep-me");
  const runtime = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async () => { throw new Error("exec-create-failed"); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    imageCodex: { present: true, version: null }
  });
  await expect(runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  })).rejects.toThrow(/exec-create-failed/u);
  expect(await readdir(path.join(root, "harness-slots", workspaceId))).toEqual([]);
  expect(await readFile(path.join(home.persistentHomePath("codex"), "auth.json"), "utf8")).toBe("keep-me");
  await expect(runtime.publicSnapshot(sessionId)).resolves.toMatchObject({ state: "stopped" });
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).resolves.toMatchObject({ leaseId: expect.any(String) });
});

test("uncertain exec admission keeps the lease and does not destroy the home", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-uncertain-"));
  roots.push(root);
  const home = createHarnessHomeStore(root);
  await mkdir(home.persistentHomePath("codex"), { recursive: true });
  await writeFile(path.join(home.persistentHomePath("codex"), "auth.json"), "keep-me");
  const runtime = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async () => { throw new TaskStartRecoveryRequiredError(); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    imageCodex: { present: true, version: null }
  });
  await expect(runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_ADMISSION_UNCERTAIN" });
  expect(await readFile(path.join(home.persistentHomePath("codex"), "auth.json"), "utf8")).toBe("keep-me");
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_HOME_IN_USE" });
});

test("resume exec-create failure restores the previous session and releases the new lease", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-resume-compensate-"));
  roots.push(root);
  const home = createHarnessHomeStore(root);
  let calls = 0;
  const runtime = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async () => {
      calls += 1;
      if (calls > 1) throw new Error("resume-exec-failed");
    },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    imageCodex: { present: true, version: null }
  });
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  const slot = path.join(root, "harness-slots", workspaceId);
  await mkdir(path.join(slot, "sessions"), { recursive: true });
  await writeFile(path.join(slot, "sessions", "thread-live.jsonl"), `${JSON.stringify({ id: "thread-live", cwd: "/workspace" })}\n`);
  await runtime.settleExit({ sessionId });
  await expect(runtime.resumeExec({
    sessionId, projectId, processId: "018f1f34-7000-7000-8000-000000000016",
    terminalId: "018f1f34-7000-7000-8000-000000000017", processGeneration: 2
  })).rejects.toThrow(/resume-exec-failed/u);
  expect(await runtime.privateNativeId(sessionId)).toBe("thread-live");
  expect(await runtime.publicSnapshot(sessionId)).toMatchObject({ state: "stopped" });
  expect(await readdir(path.join(root, "harness-slots", workspaceId))).toEqual([]);
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).resolves.toMatchObject({ leaseId: expect.any(String) });
});

test("image codex wins without staging and an in-container artifact is the only fallback", async () => {
  const image = await fixture();
  let imageStages = 0;
  const imageRuntime = createHarnessRuntime({
    home: image.home, stateRoot: image.root,
    createHarnessExec: async (exec) => { image.createdExecs.push({ command: exec.command, environment: { ...exec.environment } }); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    probeImageCodex: async () => ({ present: true, version: "0.160.0" }),
    stageNativeCodex: async () => { imageStages += 1; return { entrypointPath: "/opt/devspace/codex-artifact/unused/artifact/codex", reportedVersion: null }; }
  });
  await imageRuntime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  expect(imageStages).toBe(0);
  expect(image.createdExecs[0]?.command).toEqual(["codex", "--yolo"]);
  expect(await imageRuntime.publicSnapshot(sessionId)).toMatchObject({ executableSource: { kind: "image-path", reportedVersion: "0.160.0" } });

  const fallbackRoot = await mkdtemp(path.join(tmpdir(), "devspace-harness-artifact-"));
  roots.push(fallbackRoot);
  const fallbackExecs: Array<{ command: readonly string[] }> = [];
  let staged = 0;
  const entrypoint = "/opt/devspace/codex-artifact/closure/artifact/codex";
  const fallback = createHarnessRuntime({
    home: createHarnessHomeStore(fallbackRoot), stateRoot: fallbackRoot,
    createHarnessExec: async (exec) => { fallbackExecs.push({ command: exec.command }); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    probeImageCodex: async () => ({ present: false, version: null }),
    stageNativeCodex: async () => { staged += 1; return { entrypointPath: entrypoint, reportedVersion: "0.156.1" }; }
  });
  await fallback.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  expect(staged).toBe(1);
  expect(fallbackExecs[0]?.command).toEqual([entrypoint, "--yolo"]);
  expect(await fallback.publicSnapshot(sessionId)).toMatchObject({ executableSource: { kind: "agent-artifact", reportedVersion: "0.156.1" } });

  const noneRoot = await mkdtemp(path.join(tmpdir(), "devspace-harness-no-executable-"));
  roots.push(noneRoot);
  const none = createHarnessRuntime({
    home: createHarnessHomeStore(noneRoot), stateRoot: noneRoot,
    createHarnessExec: async () => { throw new Error("should-not-exec"); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    probeImageCodex: async () => ({ present: false, version: null })
  });
  await expect(none.start({
    projectId, workspaceId, sessionId: "018f1f34-7000-7000-8000-000000000033",
    harnessId: "codex", processId: "018f1f34-7000-7000-8000-000000000034",
    terminalId: "018f1f34-7000-7000-8000-000000000035", processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_EXECUTABLE_UNAVAILABLE" });
});

test("a host path is never executed and a staging failure releases the home", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-harness-host-path-"));
  roots.push(root);
  const home = createHarnessHomeStore(root);
  await mkdir(home.persistentHomePath("codex"), { recursive: true });
  await writeFile(path.join(home.persistentHomePath("codex"), "auth.json"), "keep-me");
  const execs: string[][] = [];
  const hostPath = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async (exec) => { execs.push([...exec.command]); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    probeImageCodex: async () => ({ present: false, version: null }),
    stageNativeCodex: async () => ({ entrypointPath: "/config/.local/bin/codex", reportedVersion: null })
  });
  await expect(hostPath.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_EXECUTABLE_UNAVAILABLE" });
  expect(execs).toEqual([]);
  expect(await readdir(path.join(root, "harness-slots", workspaceId))).toEqual([]);
  await expect(home.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).resolves.toMatchObject({ leaseId: expect.any(String) });

  const stageRoot = await mkdtemp(path.join(tmpdir(), "devspace-harness-stage-fail-"));
  roots.push(stageRoot);
  const stageHome = createHarnessHomeStore(stageRoot);
  await mkdir(stageHome.persistentHomePath("codex"), { recursive: true });
  await writeFile(path.join(stageHome.persistentHomePath("codex"), "auth.json"), "keep-me");
  const failedStage = createHarnessRuntime({
    home: stageHome, stateRoot: stageRoot,
    createHarnessExec: async () => { throw new Error("should-not-exec"); },
    inspectSlot: async () => ({ state: "present-and-exact" }),
    probeImageCodex: async () => ({ present: false, version: null }),
    stageNativeCodex: async () => { throw new Error("upload-failed"); }
  });
  await expect(failedStage.start({
    projectId, workspaceId, sessionId: "018f1f34-7000-7000-8000-000000000043",
    harnessId: "codex", processId: "018f1f34-7000-7000-8000-000000000044",
    terminalId: "018f1f34-7000-7000-8000-000000000045", processGeneration: 1
  })).rejects.toMatchObject({ code: "HARNESS_EXECUTABLE_UNAVAILABLE" });
  expect(await readFile(path.join(stageHome.persistentHomePath("codex"), "auth.json"), "utf8")).toBe("keep-me");
  await expect(stageHome.acquireLease({
    harnessId: "codex", workspaceId: wsB, aiSessionId: "018f1f34-7000-7000-8000-000000000099", processGeneration: 1
  })).resolves.toMatchObject({ leaseId: expect.any(String) });
});

test("resume generation is monotonic and a stale generation does not exec", async () => {
  const { runtime, createdExecs, root } = await fixture();
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  const slot = path.join(root, "harness-slots", workspaceId);
  await mkdir(path.join(slot, "sessions"), { recursive: true });
  await writeFile(path.join(slot, "sessions", "thread-live.jsonl"), `${JSON.stringify({ id: "thread-live", cwd: "/workspace" })}\n`);
  await runtime.settleExit({ sessionId });
  const secondProcess = "018f1f34-7000-7000-8000-000000000016";
  await runtime.resumeExec({
    sessionId, projectId, processId: secondProcess,
    terminalId: "018f1f34-7000-7000-8000-000000000017", processGeneration: 2
  });
  const lease = JSON.parse(await readFile(path.join(root, "harness-homes", "codex", ".lease", "metadata.json"), "utf8")) as { processGeneration: number };
  expect(lease.processGeneration).toBe(2);
  await runtime.settleExit({ sessionId });
  await expect(runtime.resumeExec({
    sessionId, projectId, processId: "018f1f34-7000-7000-8000-000000000018",
    terminalId: "018f1f34-7000-7000-8000-000000000019", processGeneration: 2
  })).rejects.toMatchObject({ code: "RESOURCE_STATE_CONFLICT" });
  await runtime.resumeExec({
    sessionId, projectId, processId: "018f1f34-7000-7000-8000-00000000001a",
    terminalId: "018f1f34-7000-7000-8000-00000000001b", processGeneration: 3
  });
  expect(createdExecs).toHaveLength(3);
  const record = JSON.parse(await readFile(path.join(root, "harness-sessions", `${sessionId}.json`), "utf8")) as { processGeneration: number };
  expect(record.processGeneration).toBe(3);
});

const customContinue = {
  id: "my-agent-continue", displayName: "Continue", origin: "custom" as const,
  launch: { executable: "my-agent", args: [] as string[] },
  resume: { executable: "my-agent", args: ["--resume"] },
  environment: {}, privateState: { kind: "none" as const }
};

test("custom resume survives a new agent process only when the pinned definition matches", async () => {
  const { runtime, root, home } = await fixture();
  runtime.registerCustom(customContinue);
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "my-agent-continue", processId, terminalId, processGeneration: 1
  });
  await runtime.settleExit({ sessionId });
  const restarted = createHarnessRuntime({
    home, stateRoot: root,
    createHarnessExec: async () => undefined,
    inspectSlot: async () => ({ state: "present-and-exact" }),
    imageCodex: { present: false, version: null }
  });
  await expect(restarted.resumeExec({
    sessionId, projectId, processId: "018f1f34-7000-7000-8000-000000000006",
    terminalId: "018f1f34-7000-7000-8000-000000000007", processGeneration: 2
  })).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  const resumed = await restarted.resumeExec({
    sessionId, projectId, processId: "018f1f34-7000-7000-8000-000000000006",
    terminalId: "018f1f34-7000-7000-8000-000000000007", processGeneration: 2,
    definition: customContinue
  });
  expect(resumed.command).toEqual(["my-agent", "--resume"]);
  expect(await restarted.capability(sessionId, customContinue)).toMatchObject({ resume: false, state: "live" });
  await restarted.settleExit({ sessionId });
  expect(await restarted.capability(sessionId, customContinue)).toMatchObject({ resume: true });
  expect(JSON.stringify(await restarted.capability(sessionId, customContinue))).not.toContain("nativeSession");
  await expect(restarted.resumeExec({
    sessionId, projectId, processId: "018f1f34-7000-7000-8000-000000000008",
    terminalId: "018f1f34-7000-7000-8000-000000000009", processGeneration: 3,
    definition: { ...customContinue, launch: { executable: "other-agent", args: [] } }
  })).rejects.toMatchObject({ code: "HARNESS_DEFINITION_CONFLICT" });
});

test("resume capability follows the definition and private native id", async () => {
  const codex = await fixture();
  await codex.runtime.start({
    projectId, workspaceId, sessionId, harnessId: "codex", processId, terminalId, processGeneration: 1
  });
  await codex.runtime.settleExit({ sessionId });
  expect(await codex.runtime.capability(sessionId)).toMatchObject({ state: "stopped", resume: false });

  const provider = await fixture();
  provider.runtime.registerCustom(customContinue);
  await provider.runtime.start({
    projectId, workspaceId, sessionId, harnessId: "my-agent-continue", processId, terminalId, processGeneration: 1
  });
  await provider.runtime.settleExit({ sessionId });
  const providerRestart = createHarnessRuntime({
    home: provider.home, stateRoot: provider.root,
    createHarnessExec: async () => undefined,
    inspectSlot: async () => ({ state: "present-and-exact" })
  });
  expect(await providerRestart.capability(sessionId)).toMatchObject({ resume: false });
  expect(await providerRestart.capability(sessionId, customContinue)).toMatchObject({ resume: true });

  const identified = await fixture();
  identified.runtime.registerCustom({
    ...customContinue, id: "my-agent-id",
    resume: { executable: "my-agent", args: ["--resume", "{sessionId}"] }
  });
  await identified.runtime.start({
    projectId, workspaceId, sessionId, harnessId: "my-agent-id", processId, terminalId, processGeneration: 1
  });
  await identified.runtime.settleExit({ sessionId });
  expect(await identified.runtime.capability(sessionId)).toMatchObject({ resume: false });
});

test("custom privateState none may start when the slot is missing", async () => {
  const { runtime, createdExecs } = await fixture({ slot: { state: "missing" } });
  runtime.registerCustom({
    id: "my-agent", displayName: "My Agent", origin: "custom",
    launch: { executable: "my-agent", args: [] }, resume: null, environment: {}, privateState: { kind: "none" }
  });
  await runtime.start({
    projectId, workspaceId, sessionId, harnessId: "my-agent", processId, terminalId, processGeneration: 1
  });
  expect(createdExecs).toHaveLength(1);
});
