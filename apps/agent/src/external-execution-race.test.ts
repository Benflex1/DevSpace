import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  readFile: vi.fn(),
  spawn: vi.fn()
}));

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawn: mocks.spawn
}));

vi.mock("node:fs/promises", async () => ({
  ...(await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")),
  open: mocks.open,
  readFile: mocks.readFile
}));

const { ExternalExecutionFence } = await import("./external-execution.js");
const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

const operationId = "018f0f00-0000-7000-8000-000000000101";
const projectId = "018f0f00-0000-7000-8000-000000000102";
const executionId = "018f0f00-0000-7000-8000-000000000103";
const roots: string[] = [];
const fakePid = 3210;

class FakeChild extends EventEmitter {
  readonly pid = fakePid;
  closeListenerCountAtEmit: number | null = null;

  emitClose(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.closeListenerCountAtEmit = this.listenerCount("close");
    this.emit("close", code, signal);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`test timeout after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

function procStat(): string {
  return `${fakePid} (git) S 1 ${fakePid} ${fakePid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 12345`;
}

async function executionRoot(): Promise<string> {
  const root = await mkdtemp(path.join("/tmp", "devspace-execution-race-test-"));
  roots.push(root);
  const executions = path.join(root, "executions");
  await mkdir(executions);
  return executions;
}

beforeEach(() => {
  mocks.open.mockImplementation((filePath: string, flags: string, mode?: number) => {
    if (flags === "wx") {
      return Promise.resolve({ fd: 99, close: vi.fn(() => Promise.resolve()) });
    }
    return realFs.open(filePath, flags, mode);
  });
  mocks.readFile.mockImplementation(async (filePath: string, encoding?: BufferEncoding) => await realFs.readFile(filePath, encoding as "utf8"));
  mocks.spawn.mockReset();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});

test("terminal completion before identity proof retires the execution safely", async () => {
  const root = await executionRoot();
  const child = new FakeChild();
  const closeStarted = deferred();
  const releaseClose = deferred();
  let closeCalls = 0;
  mocks.spawn.mockImplementation(() => child);
  mocks.open.mockImplementation(async (filePath: string, flags: string, mode?: number) => {
    if (flags === "wx") {
      return {
        fd: 99,
        close: vi.fn(async () => {
          closeCalls += 1;
          if (closeCalls === 1) {
            closeStarted.resolve();
            child.emitClose();
          }
          await releaseClose.promise;
        })
      };
    }
    return await realFs.open(filePath, flags, mode);
  });
  mocks.readFile.mockImplementation(async (filePath: string, encoding?: BufferEncoding) => {
    if (filePath === `/proc/${fakePid}/stat`) return procStat();
    if (filePath === `/proc/${fakePid}/environ`) throw Object.assign(new Error("process exited"), { code: "ESRCH" });
    return await realFs.readFile(filePath, encoding as "utf8");
  });

  const fence = new ExternalExecutionFence(root);
  await fence.initialize();
  const run = fence.runGit({ operationId, projectId, executionId, role: "workspace-branch-update",
    args: ["--git-dir", "/tmp/diagnostic.git", "update-ref", "refs/heads/diagnostic", "HEAD"],
    timeoutMs: 500, maxOutputBytes: 4096, env: { PATH: "/usr/bin:/bin" } });
  await closeStarted.promise;
  releaseClose.resolve();
  try {
    await expect(withTimeout(run, 100)).resolves.toMatchObject({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false });
  } finally {
    child.emitClose();
    await withTimeout(run.catch(() => undefined), 100);
  }
  expect(fence.isHealthy).toBe(true);
  expect(await readdir(root)).toEqual([]);
});

test("completion is observed before awaited output cleanup", async () => {
  const root = await executionRoot();
  const child = new FakeChild();
  const closeStarted = deferred();
  const releaseClose = deferred();
  let closeCalls = 0;
  mocks.spawn.mockImplementation(() => child);
  mocks.open.mockImplementation(async (filePath: string, flags: string, mode?: number) => {
    if (flags === "wx") {
      return {
        fd: 99,
        close: vi.fn(async () => {
          closeCalls += 1;
          if (closeCalls === 1) {
            closeStarted.resolve();
            child.emitClose();
          }
          await releaseClose.promise;
        })
      };
    }
    return await realFs.open(filePath, flags, mode);
  });
  mocks.readFile.mockImplementation(async (filePath: string, encoding?: BufferEncoding) => {
    if (filePath === `/proc/${fakePid}/stat`) return procStat();
    if (filePath === `/proc/${fakePid}/environ`) throw Object.assign(new Error("process exited"), { code: "ESRCH" });
    return await realFs.readFile(filePath, encoding as "utf8");
  });

  const fence = new ExternalExecutionFence(root);
  await fence.initialize();
  const run = fence.runGit({ operationId, projectId, executionId, role: "workspace-add",
    args: ["--git-dir", "/tmp/diagnostic.git", "worktree", "add", "--", "/tmp/worktree", "main"],
    timeoutMs: 500, maxOutputBytes: 4096, env: { PATH: "/usr/bin:/bin" } });
  await closeStarted.promise;
  try {
    expect(child.closeListenerCountAtEmit).toBeGreaterThan(0);
  } finally {
    releaseClose.resolve();
    child.emitClose();
    await withTimeout(run.catch(() => undefined), 100);
  }
});

test("a transient environment-read failure resolves from a conclusive terminal child", async () => {
  const root = await executionRoot();
  const child = new FakeChild();
  mocks.spawn.mockImplementation(() => child);
  mocks.readFile.mockImplementation(async (filePath: string, encoding?: BufferEncoding) => {
    if (filePath === `/proc/${fakePid}/stat`) return procStat();
    if (filePath === `/proc/${fakePid}/environ`) {
      child.emitClose();
      throw Object.assign(new Error("transient environment read"), { code: "EACCES" });
    }
    return await realFs.readFile(filePath, encoding as "utf8");
  });

  const fence = new ExternalExecutionFence(root);
  await fence.initialize();
  await expect(fence.runGit({ operationId, projectId, executionId, role: "workspace-branch-update",
    args: ["--git-dir", "/tmp/diagnostic.git", "update-ref", "refs/heads/diagnostic", "HEAD"],
    timeoutMs: 500, maxOutputBytes: 4096, env: { PATH: "/usr/bin:/bin" } })).resolves.toMatchObject({ code: 0, signal: null });
  expect(fence.isHealthy).toBe(true);
  expect(await readdir(root)).toEqual([]);
});

test("a persistently live child without exact environment proof fails closed", async () => {
  const root = await executionRoot();
  const child = new FakeChild();
  let environmentReads = 0;
  mocks.spawn.mockImplementation(() => child);
  mocks.readFile.mockImplementation(async (filePath: string, encoding?: BufferEncoding) => {
    if (filePath === `/proc/${fakePid}/stat`) return procStat();
    if (filePath === `/proc/${fakePid}/environ`) {
      environmentReads += 1;
      throw Object.assign(new Error("persistent environment read failure"), { code: "EACCES" });
    }
    return await realFs.readFile(filePath, encoding as "utf8");
  });

  const fence = new ExternalExecutionFence(root);
  await fence.initialize();
  await expect(fence.runGit({ operationId, projectId, executionId, role: "workspace-branch-update",
    args: ["--git-dir", "/tmp/diagnostic.git", "update-ref", "refs/heads/diagnostic", "HEAD"],
    timeoutMs: 200, maxOutputBytes: 4096, env: { PATH: "/usr/bin:/bin" } })).rejects.toThrow(/identity|indeterminate|corrupt/u);
  expect(environmentReads).toBeGreaterThan(1);
  expect(fence.isHealthy).toBe(false);
  expect(await readdir(root)).toContain(`${operationId}.json`);
});
