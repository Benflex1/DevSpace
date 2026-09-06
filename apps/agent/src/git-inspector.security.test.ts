import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, expect, test, vi } from "vitest";
import { GitInspectionPolicyError, GitInspectionUnavailableError, createProductionGitInspector, runBoundedProcess } from "./git-inspector.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function waitForFile(file: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { return Number(await readFile(file, "utf8")); } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error("Timed out waiting for descendant PID.");
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process ${pid} survived cancellation.`);
}

async function waitUntilAlive(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process ${pid} did not become alive.`);
}

async function exerciseCancellation(mode: "timeout" | "output"): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-process-tree-"));
  directories.push(directory);
  const pidFile = path.join(directory, "descendant.pid");
  let groupPid = 0;
  const started = Date.now();
  const operation = runBoundedProcess(process.execPath, [path.resolve("apps/agent/test/fixtures/process-tree.mjs"), pidFile, mode], {
    timeoutMs: mode === "timeout" ? 500 : 5_000,
    maxOutputBytes: mode === "output" ? 1_024 : 256 * 1024,
    env: { PATH: process.env.PATH },
    onSpawn: (pid) => { groupPid = pid; }
  });
  let descendantPid = 0;
  try {
    descendantPid = await waitForFile(pidFile);
    expect(groupPid).toBeGreaterThan(1);
    expect(isAlive(descendantPid)).toBe(true);
    await expect(operation).rejects.toMatchObject({
      reason: mode === "timeout" ? "timeout" : "output-limit"
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    await waitUntilDead(descendantPid);
  } finally {
    if (groupPid > 1) try { process.kill(-groupPid, "SIGKILL"); } catch { /* already terminated */ }
    await operation.catch(() => undefined);
    if (descendantPid > 1) await waitUntilDead(descendantPid);
  }
}

test("timeout terminates the complete Git process group and settles within a bound", async () => {
  await exerciseCancellation("timeout");
});

test("a direct child exiting during cancellation grace still escalates the remaining descendant", async () => {
  await exerciseCancellation("timeout");
});

test("output overflow terminates the complete Git process group and settles within a bound", async () => {
  await exerciseCancellation("output");
});

test("cancellation terminates the target group without signaling an unrelated process group", async () => {
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: "ignore"
  });
  const sentinelPid = sentinel.pid;
  if (sentinelPid === undefined || sentinelPid <= 1) throw new Error("Sentinel process did not start.");
  let targetPid = 0;
  let targetDescendantPid = 0;
  let operation: Promise<unknown> | undefined;
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-process-sentinel-"));
  directories.push(directory);
  const pidFile = path.join(directory, "descendant.pid");
  try {
    await waitUntilAlive(sentinelPid);
    operation = runBoundedProcess(process.execPath, [path.resolve("apps/agent/test/fixtures/process-tree.mjs"), pidFile, "timeout"], {
      timeoutMs: 500,
      maxOutputBytes: 256 * 1024,
      env: { PATH: process.env.PATH },
      onSpawn: (pid) => { targetPid = pid; }
    });
    targetDescendantPid = await waitForFile(pidFile);
    expect(isAlive(sentinelPid)).toBe(true);
    expect(targetPid).toBeGreaterThan(1);
    expect(isAlive(targetDescendantPid)).toBe(true);
    await expect(operation).rejects.toBeInstanceOf(GitInspectionUnavailableError);
    await waitUntilDead(targetDescendantPid);
    expect(isAlive(sentinelPid)).toBe(true);
  } finally {
    if (targetPid > 1) try { process.kill(-targetPid, "SIGKILL"); } catch { /* already terminated */ }
    if (operation !== undefined) await operation.catch(() => undefined);
    if (targetDescendantPid > 1) await waitUntilDead(targetDescendantPid).catch(() => undefined);
    try { process.kill(-sentinelPid, "SIGKILL"); } catch { /* already terminated */ }
    await waitUntilDead(sentinelPid).catch(() => undefined);
  }
});

test("normal subprocess completion resolves without cancellation", async () => {
  const result = await runBoundedProcess(process.execPath, [path.resolve("apps/agent/test/fixtures/process-normal.mjs")], {
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
    env: { PATH: process.env.PATH }
  });
  expect(result).toMatchObject({ code: 0, signal: null, stdout: "normal-completion\n", stderr: "" });
});

test("inspection-unavailable reasons preserve local process versus remote timeout causes", () => {
  expect(new GitInspectionUnavailableError("spawn")).toMatchObject({ reason: "spawn" });
  expect(new GitInspectionUnavailableError("process-management")).toMatchObject({ reason: "process-management" });
  expect(new GitInspectionUnavailableError("timeout")).toMatchObject({ reason: "timeout" });
});

test("an already-gone process group is handled without signaling an unrelated process", async () => {
  let groupPid = 0;
  const operation = runBoundedProcess(process.execPath, [path.resolve("apps/agent/test/fixtures/process-normal.mjs")], {
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
    env: { PATH: process.env.PATH },
    onSpawn: (pid) => {
      groupPid = pid;
      process.kill(-pid, "SIGKILL");
    }
  });
  const result = await operation;
  expect(groupPid).toBeGreaterThan(1);
  expect(result.signal).toBe("SIGKILL");
});

test("production inspection accepts plain HTTPS and rejects queries or SSH before process execution", async () => {
  const runner = vi.fn<typeof runBoundedProcess>().mockResolvedValue({
    stdout: "ref: refs/heads/main\tHEAD\n0123456789abcdef0123456789abcdef01234567\tHEAD\n",
    stderr: "", code: 0, signal: null
  });
  const inspector = createProductionGitInspector({ runProcess: runner });
  await expect(inspector.inspect("https://example.com/repo.git")).resolves.toMatchObject({ defaultBranch: "main" });
  expect(runner).toHaveBeenCalledTimes(1);
  await expect(inspector.inspect("https://example.com/repo.git?access_token=review-secret")).rejects.toBeInstanceOf(GitInspectionPolicyError);
  await expect(inspector.inspect("ssh://git@example.com/repo.git")).rejects.toBeInstanceOf(GitInspectionPolicyError);
  expect(runner).toHaveBeenCalledTimes(1);
});

test("production inspection treats a signaled Git process as internal even with a zero exit code", async () => {
  const runner = vi.fn<typeof runBoundedProcess>().mockResolvedValue({
    stdout: "ref: refs/heads/main\tHEAD\n0123456789abcdef0123456789abcdef01234567\tHEAD\n",
    stderr: "",
    code: 0,
    signal: "SIGTERM"
  });
  const inspector = createProductionGitInspector({ runProcess: runner });
  await expect(inspector.inspect("https://example.com/repo.git")).rejects.toMatchObject({ message: "git-inspection-process-failed" });
});
