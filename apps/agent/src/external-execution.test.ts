import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  ExternalExecutionFence,
  externalExecutionMarkerSchema,
  isExactLinuxProcessIdentity,
  parseLinuxProcStat
} from "./external-execution.js";

const operationId = "018f0f00-0000-7000-8000-000000000001";
const projectId = "018f0f00-0000-7000-8000-000000000002";
const executionId = "018f0f00-0000-7000-8000-000000000003";
const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

async function executionRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-execution-test-")); roots.push(root);
  const executions = path.join(root, "executions"); await mkdir(executions);
  return executions;
}

test("Linux process identity uses PID, process group, and kernel start time", async () => {
  const parsed = parseLinuxProcStat(process.pid, await readFile(`/proc/${process.pid}/stat`, "utf8"));
  expect(parsed.pid).toBe(process.pid);
  expect(parsed.startTimeTicks).toMatch(/^[0-9]+$/u);
  expect(isExactLinuxProcessIdentity(parsed, parsed)).toBe(true);
  expect(isExactLinuxProcessIdentity(parsed, { ...parsed, startTimeTicks: `${BigInt(parsed.startTimeTicks) + 1n}` })).toBe(false);
  expect(isExactLinuxProcessIdentity(parsed, { ...parsed, pid: parsed.pid + 1 })).toBe(false);
});

test("confirmed stale and provably pre-spawn execution markers retire safely", async () => {
  const root = await executionRoot();
  const marker = externalExecutionMarkerSchema.parse({ version: 1, phase: "running", operationId, projectId, executionId,
    role: "project-fetch", createdAt: "2026-07-17T12:00:00.000Z", deadlineAt: "2026-07-17T12:00:01.000Z",
    process: { pid: 2_000_000_000, processGroupId: 2_000_000_000, startTimeTicks: "1" } });
  await writeFile(path.join(root, `${operationId}.json`), `${JSON.stringify(marker)}\n`, "utf8");
  const fence = new ExternalExecutionFence(root); await fence.initialize();
  await fence.awaitProject(projectId);
  expect(fence.isHealthy).toBe(true);
  expect(await readdir(root)).toEqual([]);

  const reserved = externalExecutionMarkerSchema.parse({ version: 1, phase: "reserved", operationId, projectId,
    executionId: "018f0f00-0000-7000-8000-000000000004", role: "project-fetch",
    createdAt: new Date(Date.now() - 1_000).toISOString(), deadlineAt: new Date(Date.now() + 10_000).toISOString() });
  await writeFile(path.join(root, `${operationId}.json`), `${JSON.stringify(reserved)}\n`, "utf8");
  const restarted = new ExternalExecutionFence(root); await restarted.initialize();
  await restarted.awaitProject(projectId);
  expect(await readdir(root)).toEqual([]);
});

test("a launch-committed marker without confirmed process identity fails closed permanently", async () => {
  const root = await executionRoot();
  const marker = externalExecutionMarkerSchema.parse({ version: 1, phase: "launch-committed", operationId, projectId,
    executionId, role: "project-fetch", createdAt: new Date(Date.now() - 1_000).toISOString(),
    deadlineAt: new Date(Date.now() + 10_000).toISOString() });
  await writeFile(path.join(root, `${operationId}.json`), `${JSON.stringify(marker)}\n`, "utf8");
  const fence = new ExternalExecutionFence(root); await fence.initialize();
  await expect(fence.awaitProject(projectId)).rejects.toThrow(/indeterminate|reconciliation/u);
  expect(fence.isHealthy).toBe(false);
  expect(await readdir(root)).toContain(`${operationId}.json`);
  await expect(fence.awaitProject(projectId)).rejects.toThrow(/corrupt/u);
});

test("execution markers reject PID-only and structurally inconsistent identities", () => {
  expect(externalExecutionMarkerSchema.safeParse({ version: 1, phase: "running", operationId, projectId, executionId,
    role: "project-fetch", createdAt: "2026-07-17T12:00:00.000Z", deadlineAt: "2026-07-17T12:00:01.000Z",
    process: { pid: 123, processGroupId: 123 } }).success).toBe(false);
});

test("an execution marker must bind to the exact nonterminal journal operation and project", async () => {
  const root = await executionRoot();
  const marker = externalExecutionMarkerSchema.parse({ version: 1, phase: "reserved", operationId, projectId, executionId,
    role: "store-clone", createdAt: new Date(Date.now() - 1_000).toISOString(), deadlineAt: new Date(Date.now() + 10_000).toISOString() });
  await writeFile(path.join(root, `${operationId}.json`), `${JSON.stringify(marker)}\n`, "utf8");
  const fence = new ExternalExecutionFence(root); await fence.initialize();
  expect(() => fence.validateJournalBindings(() => ({ operationName: "project.managed-store.create", state: "running",
    request: { projectId: "018f0f00-0000-7000-8000-000000000099" } }))).toThrow(/corrupt/u);
  expect(fence.isHealthy).toBe(false);
});

test("a timed-out real Git process group is terminated and its marker is retired", async () => {
  const root = await executionRoot();
  const fence = new ExternalExecutionFence(root); await fence.initialize();
  const socket = path.join(path.dirname(root), "credential-cache.sock");
  const result = await fence.runGit({ operationId, projectId, role: "project-fetch",
    args: ["-c", "core.hooksPath=/dev/null", "credential-cache--daemon", socket], timeoutMs: 150,
    maxOutputBytes: 64 * 1024, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", LC_ALL: "C" } });
  expect(result.code === 0 && result.signal === null).toBe(false);
  expect(result.timedOut).toBe(true);
  expect(await readdir(root)).toEqual([]);
});
