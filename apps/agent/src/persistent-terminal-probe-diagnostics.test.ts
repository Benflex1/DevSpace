import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { collectStreamUntilEof, errorMessage, ProbeProgress } from "./persistent-terminal-probe-diagnostics.js";

test("ProbeProgress persists timestamped operation checkpoints and the last completed step", async () => {
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true });
  const root = await mkdtemp(path.join(process.cwd(), ".tmp/probe-diagnostics-"));
  const filePath = path.join(root, "progress.jsonl");
  try {
    const progress = new ProbeProgress("node:24-bookworm", filePath);
    await progress.run("docker.image.inspect", 100, () => "image-id");

    const [started, completed] = (await readFile(filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      timestamp: string; image: string; checkpoint: string; status: string; lastCompletedCheckpoint: string | null;
    });
    expect(started).toMatchObject({ image: "node:24-bookworm", checkpoint: "docker.image.inspect", status: "started" });
    expect(Number.isNaN(Date.parse(started?.timestamp ?? ""))).toBe(false);
    expect(completed).toMatchObject({
      image: "node:24-bookworm", checkpoint: "docker.image.inspect", status: "completed",
      lastCompletedCheckpoint: "docker.image.inspect"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProbeProgress reports a named operation deadline and runs its cancellation hook", async () => {
  const progress = new ProbeProgress("node:24-bookworm");
  let cancelled = false;

  await expect(progress.run("docker.exec.attach", 10, () => new Promise<never>(() => {}), () => { cancelled = true; }))
    .rejects.toThrow("rootless-tmux-probe-operation-timeout:docker.exec.attach:10ms");

  expect(cancelled).toBe(true);
  expect(progress.lastCheckpoint).toBe("docker.exec.attach");
  expect(progress.lastCompletedCheckpoint).toBeNull();
});

test("errorMessage retains the cause of Docker transport failures", () => {
  expect(errorMessage(new Error("Docker Engine transport request failed.", { cause: new Error("docker-engine-timeout") })))
    .toBe("Docker Engine transport request failed.:cause=docker-engine-timeout");
});

test("collectStreamUntilEof collects output through EOF", async () => {
  const stream = new PassThrough();
  const output = collectStreamUntilEof(stream, "docker.exec.output", 100);
  stream.write("first");
  stream.end("second");

  await expect(output).resolves.toEqual(Buffer.from("firstsecond"));
});

test("collectStreamUntilEof destroys and reports a stream that never reaches EOF", async () => {
  const stream = new PassThrough();

  await expect(collectStreamUntilEof(stream, "docker.exec.output", 10))
    .rejects.toThrow("rootless-tmux-probe-stream-timeout:docker.exec.output:10ms");

  expect(stream.destroyed).toBe(true);
});

test("collectStreamUntilEof destroys a stream that exceeds the bounded output size", async () => {
  const stream = new PassThrough();
  const output = collectStreamUntilEof(stream, `docker.exec.output.${randomUUID()}`, 100, 4);
  stream.write("12345");

  await expect(output).rejects.toThrow("rootless-tmux-probe-stream-limit-exceeded");
  expect(stream.destroyed).toBe(true);
});
