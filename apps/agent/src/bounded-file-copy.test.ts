import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { BoundedFileCopyQueue } from "./bounded-file-copy.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("bounds active copies and aggregate in-flight bytes", async () => {
  const queue = new BoundedFileCopyQueue(3, 5);
  const gates = [deferred(), deferred(), deferred(), deferred(), deferred()];
  const started = gates.map(() => deferred());
  let active = 0;
  let activeBytes = 0;
  let peakActive = 0;
  let peakBytes = 0;
  const startedIndices: number[] = [];

  const operation = (index: number, bytes: number) => async () => {
    active += 1;
    activeBytes += bytes;
    peakActive = Math.max(peakActive, active);
    peakBytes = Math.max(peakBytes, activeBytes);
    startedIndices.push(index);
    started[index]!.resolve();
    try { await gates[index]!.promise; }
    finally {
      active -= 1;
      activeBytes -= bytes;
    }
  };

  const first = queue.schedule(3, operation(0, 3));
  const second = queue.schedule(2, operation(1, 2));
  await Promise.all([started[0]!.promise, started[1]!.promise]);
  const third = queue.schedule(1, operation(2, 1));
  await Promise.resolve();
  expect(startedIndices).toEqual([0, 1]);
  expect(peakBytes).toBe(5);
  gates[0]!.resolve();
  await started[2]!.promise;

  const fourth = queue.schedule(1, operation(3, 1));
  await started[3]!.promise;
  expect(startedIndices).toEqual([0, 1, 2, 3]);
  const fifth = queue.schedule(1, operation(4, 1));
  await Promise.resolve();
  expect(peakActive).toBe(3);
  expect(peakBytes).toBeLessThanOrEqual(5);
  expect(startedIndices).toEqual([0, 1, 2, 3]);

  gates[1]!.resolve();
  await started[4]!.promise;
  for (const gate of gates) gate.resolve();
  await Promise.all([first, second, third, fourth, fifth]);
  await queue.drain();
  expect(peakActive).toBeLessThanOrEqual(3);
  expect(peakBytes).toBeLessThanOrEqual(5);
});

test("worker failure drains in-flight writes before rejection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bounded-copy-"));
  roots.push(root);
  const queue = new BoundedFileCopyQueue(2, 8);
  const failingStarted = deferred();
  const slowStarted = deferred();
  const releaseSlow = deferred();
  const failure = new Error("synthetic-copy-failure");
  let completedWrites = 0;
  let writeStartedAfterCleanup = false;
  let cleanupComplete = false;

  const failing = queue.schedule(1, async () => {
    failingStarted.resolve();
    await writeFile(path.join(root, "partial"), "partial");
    throw failure;
  });
  const slow = queue.schedule(1, async () => {
    slowStarted.resolve();
    await releaseSlow.promise;
    if (cleanupComplete) writeStartedAfterCleanup = true;
    await writeFile(path.join(root, "drained"), "complete");
    completedWrites += 1;
  });
  await Promise.all([failingStarted.promise, slowStarted.promise]);

  const rejectedSchedule = queue.schedule(1, () => Promise.reject(new Error("a task was scheduled after the worker failure")));
  await expect(rejectedSchedule).rejects.toBe(failure);
  let drainSettled = false;
  const drain = queue.drain().finally(() => { drainSettled = true; });
  await Promise.resolve();
  expect(drainSettled).toBe(false);

  releaseSlow.resolve();
  await expect(drain).rejects.toBe(failure);
  await Promise.all([failing, slow]);
  cleanupComplete = true;
  await rm(root, { recursive: true, force: true });

  expect(completedWrites).toBe(1);
  expect(writeStartedAfterCleanup).toBe(false);
  await expect(readFile(path.join(root, "drained"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
