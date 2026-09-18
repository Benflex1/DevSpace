import { Duplex, PassThrough } from "node:stream";
import { expect, test } from "vitest";
import type { NativeCodexPty } from "./native-pty.js";
import { runCodexSplitGenericTtySmoke, runCodexSplitPtyProof, waitForNativeCodexPtyExit } from "./pty-harness.js";
import { DockerEngineClient, type DockerExecInspection } from "../docker-runtime.js";

function pty(stream: PassThrough, inspect: () => Promise<DockerExecInspection>, execId = "exec-id"): NativeCodexPty {
  return {
    containerId: "control-id",
    execId,
    command: ["/opt/devspace/codex-launcher/codex"], logicalArgv: ["codex"],
    workingDirectory: "/workspace",
    stream,
    resize: () => Promise.resolve(),
    inspect
  };
}

test("reports a bounded native PTY exit when the process exits nonzero", async () => {
  const stream = new PassThrough();
  const result = pty(stream, () => Promise.resolve({ ID: "exec-id", Running: false, ExitCode: 17, ContainerID: "control-id" }));
  await expect(waitForNativeCodexPtyExit({ pty: result })).rejects.toThrow("native-pty-exit");
});

test("reports an attached stream failure while waiting for native PTY exit", async () => {
  const stream = new PassThrough();
  const result = pty(stream, () => Promise.resolve({ ID: "exec-id", Running: true, ExitCode: null, ContainerID: "control-id", Pid: 321 }));
  const waiting = waitForNativeCodexPtyExit({ pty: result, timeoutMs: 100, pollIntervalMs: 1 });
  stream.emit("error", new Error("socket-failed"));
  await expect(waiting).rejects.toThrow("native-pty-stream");
});

test("bounds native PTY exit polling when the exec remains running", async () => {
  const stream = new PassThrough();
  let now = 0;
  let sleeps = 0;
  const result = pty(stream, () => Promise.resolve({ ID: "exec-id", Running: true, ExitCode: null, ContainerID: "control-id", Pid: 321 }));
  await expect(waitForNativeCodexPtyExit({
    pty: result,
    timeoutMs: 5,
    pollIntervalMs: 1,
    now: () => now,
    sleep: (milliseconds) => { sleeps += 1; now += milliseconds; return Promise.resolve(); }
  })).rejects.toThrow("native-pty-exit");
  expect(sleeps).toBeGreaterThan(0);
  expect(sleeps).toBeLessThan(10);
});

test("allows a live TTY exec without a stable PID to reach resize", async () => {
  class FixtureStream extends Duplex {
    constructor() {
      super();
      queueMicrotask(() => this.push("DEVSPACE_TTY_READY_cycle\n"));
    }

    _read(): void {}

    _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      if (chunk.toString("utf8").includes("DEVSPACE_TTY_INPUT_cycle")) {
        this.push("DEVSPACE_TTY_ACK_cycle\n");
        this.push(null);
      }
      callback();
    }
  }

  let resizeCount = 0;
  let inspectCount = 0;
  const stream = new FixtureStream();
  const docker = new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override createExec(): Promise<string> { return Promise.resolve("exec-id"); }
    override startExecAttached(): Promise<Duplex> { return Promise.resolve(stream); }
    override resizeExec(): Promise<void> { resizeCount += 1; return Promise.resolve(); }
    override inspectExec(): Promise<DockerExecInspection> {
      inspectCount += 1;
      if (inspectCount === 1) return Promise.resolve({ ID: "exec-id", Running: true, ExitCode: null, ContainerID: "control-id" });
      if (stream.destroyed || inspectCount >= 4) return Promise.resolve({ ID: "exec-id", Running: false, ExitCode: 0, ContainerID: "control-id" });
      return Promise.resolve({ ID: "exec-id", Running: true, ExitCode: null, ContainerID: "control-id", Pid: 321 });
    }
  }();

  await expect(runCodexSplitGenericTtySmoke({ docker, containerId: "control-id", cycleId: "cycle" }))
    .resolves.toBeUndefined();
  expect(resizeCount).toBe(2);
  expect(inspectCount).toBeGreaterThanOrEqual(4);
});

test("classifies the resize phase and observed process state after a resize failure", async () => {
  const stream = new PassThrough();
  let inspectCount = 0;
  const docker = new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override createExec(): Promise<string> { return Promise.resolve("exec-id"); }
    override startExecAttached(): Promise<PassThrough> { return Promise.resolve(stream); }
    override resizeExec(): Promise<void> { return Promise.reject(new Error("resize-failed")); }
    override inspectExec(): Promise<DockerExecInspection> {
      inspectCount += 1;
      return inspectCount === 1
        ? Promise.resolve({ ID: "exec-id", Running: true, ExitCode: null, ContainerID: "control-id" })
        : Promise.resolve({ ID: "exec-id", Running: false, ExitCode: 0, ContainerID: "control-id" });
    }
  }();

  let failure: unknown;
  try {
    await runCodexSplitGenericTtySmoke({ docker, containerId: "control-id", cycleId: "cycle" });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("native-pty-resize");
  expect(((failure as Error & { readonly cause?: Error }).cause)?.message)
    .toBe("native-pty-resize-initial-exited-0");
});

test("does not restart the control container between native PTY startup cycles", async () => {
  class SmokeStream extends Duplex {
    private readonly ready: string;
    private readonly acknowledgement: string | null;

    constructor(ready: string, acknowledgement: string | null) {
      super();
      this.ready = ready;
      this.acknowledgement = acknowledgement;
      queueMicrotask(() => {
        this.push(`${this.ready}\n`);
        if (this.acknowledgement === null) this.push(null);
      });
    }

    _read(): void {}

    _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      if (this.acknowledgement !== null && chunk.toString("utf8").trim().length > 0) {
        this.push(`${this.acknowledgement}\n`);
        this.push(null);
      }
      callback();
    }
  }

  let execNumber = 0;
  let stopped = 0;
  let started = 0;
  const running = new Set<string>();
  const commands = new Map<string, string>();
  const docker = new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }

    override createExec(_containerId: string, input: { readonly command: readonly string[] }): Promise<string> {
      execNumber += 1;
      const execId = `exec-${execNumber}`;
      commands.set(execId, input.command.join(" "));
      running.add(execId);
      return Promise.resolve(execId);
    }

    override startExecAttached(execId: string): Promise<Duplex> {
      const command = commands.get(execId) ?? "";
      const isVersion = command.includes("DEVSPACE_CODEX_VERSION_OK");
      const ready = isVersion ? "DEVSPACE_CODEX_VERSION_OK" : command.match(/DEVSPACE_TTY_READY_[A-Za-z0-9_-]+/u)?.[0] ?? "missing-ready";
      const acknowledgement = isVersion ? null : command.match(/DEVSPACE_TTY_ACK_[A-Za-z0-9_-]+/u)?.[0] ?? "missing-ack";
      const stream = isVersion
        ? new SmokeStream(ready, null)
        : new SmokeStream(ready, acknowledgement);
      stream.once("end", () => running.delete(execId));
      stream.once("close", () => running.delete(execId));
      return Promise.resolve(stream);
    }

    override resizeExec(): Promise<void> { return Promise.resolve(); }

    override inspectExec(execId: string): Promise<DockerExecInspection> {
      return Promise.resolve({
        ID: execId, Running: running.has(execId), ExitCode: running.has(execId) ? null : 0, ContainerID: "control-id"
      });
    }

    override stopContainer(): Promise<void> { stopped += 1; return Promise.resolve(); }
    override startContainer(): Promise<void> { started += 1; return Promise.resolve(); }
  }();

  let nativeNumber = 0;
  const runtime = {
    startNewSession: (): Promise<NativeCodexPty> => {
      nativeNumber += 1;
      const stream = new PassThrough();
      return Promise.resolve(pty(stream, () => Promise.resolve({
        ID: `native-${nativeNumber}`, Running: true, ExitCode: null, ContainerID: "control-id", Pid: 42
      }), `native-${nativeNumber}`));
    }
  };

  await expect(runCodexSplitPtyProof({
    docker,
    runtime,
    record: { control: { id: "control-id" } } as never,
    runId: "run-id",
    projectId: "project-id",
    workspaceId: "workspace-id",
    controlEnvironment: {}
  })).resolves.toEqual({ genericTtyCycles: 5, codexVersionTtyCycles: 3, nativePtyStartupCycles: 3 });
  expect(stopped).toBe(0);
  expect(started).toBe(0);
});
