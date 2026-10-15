import { describe, expect, test } from "vitest";
import { pipeline } from "node:stream/promises";
import { PassThrough } from "node:stream";
import * as tar from "tar-stream";
import {
  buildPersistentTmuxArchive,
  PersistentTmuxIdentityMismatchError,
  PersistentTmuxRuntime,
  persistentTerminalOwnershipMarker,
  persistentTmuxBinding,
  persistentTmuxSessionName,
  parseTmuxPaneObservation,
  type PersistentTerminalOwnership
} from "./persistent-terminal-runtime.js";
import type { DockerEngineClient } from "./docker-runtime.js";

const ownership: PersistentTerminalOwnership = {
  projectId: "018f0f00-0000-7000-8000-000000000001",
  workspaceId: "018f0f00-0000-7000-8000-000000000002",
  terminalId: "018f0f00-0000-7000-8000-000000000003",
  processId: "018f0f00-0000-7000-8000-000000000003",
  containerId: "a".repeat(64),
  generation: 1,
  revisionId: "018f0f00-0000-7000-8000-000000000004",
  revisionHash: `sha256-jcs-v1:${"b".repeat(64)}`,
  runtimePlanHash: `sha256-jcs-v1:${"c".repeat(64)}`
};

function multiplexedStdout(output: string): Buffer {
  const bytes = Buffer.from(output);
  const frame = Buffer.alloc(8 + bytes.length);
  frame[0] = 1;
  frame.writeUInt32BE(bytes.length, 4);
  bytes.copy(frame, 8);
  return frame;
}

function socketInspectionRuntime(socketMetadata: string): {
  readonly runtime: PersistentTmuxRuntime;
  readonly binding: ReturnType<typeof persistentTmuxBinding>;
} {
  const binding = persistentTmuxBinding(ownership.containerId, 1000, 1000);
  const commands = new Map<string, readonly string[]>();
  let nextExec = 0;
  const response = (command: readonly string[]) => {
    if (command.includes("stat")) return { exitCode: 0, stdout: `${socketMetadata}\n` };
    if (command.includes("list-panes")) {
      return { exitCode: 0, stdout: `${persistentTmuxSessionName(ownership.terminalId)}|$7|%0|4321|0|-1|1|1\n` };
    }
    if (command.includes("show-environment")) {
      return { exitCode: 0, stdout: `DEVSPACE_TERMINAL_OWNER=${persistentTerminalOwnershipMarker(ownership)}\n` };
    }
    return { exitCode: 0, stdout: "" };
  };
  const engine = {
    createExec: (_containerId: string, input: { readonly command: readonly string[] }): Promise<string> => {
      const execId = `socket-inspection-${++nextExec}`;
      commands.set(execId, input.command);
      return Promise.resolve(execId);
    },
    startExecAttached: (execId: string, tty: boolean): Promise<PassThrough> => {
      const stream = new PassThrough();
      const command = commands.get(execId) ?? [];
      queueMicrotask(() => {
        if (tty) stream.write(Buffer.from("tmux probe redraw"));
        else stream.end(multiplexedStdout(response(command).stdout));
      });
      return Promise.resolve(stream);
    },
    inspectExec: (execId: string) => Promise.resolve({ ID: execId, ContainerID: binding.containerId,
      Running: false, ExitCode: response(commands.get(execId) ?? []).exitCode })
  } as unknown as DockerEngineClient;
  return { runtime: new PersistentTmuxRuntime(engine), binding };
}

describe("persistent tmux identity", () => {
  test.each(["600", "670", "700"])('accepts a correctly owned tmux socket in secure mode %s', async (mode) => {
    const { runtime, binding } = socketInspectionRuntime(`socket ${mode} 1000:1000`);
    await expect(runtime.lookupSession(binding, ownership, persistentTmuxSessionName(ownership.terminalId), "$7", "%0"))
      .resolves.toMatchObject({ sessionId: "$7", paneId: "%0", panePid: 4321 });
  });

  test.each([
    "socket 700 1001:1000",
    "socket 700 1000:1001",
    "socket 701 1000:1000",
    "socket 770 1000:1000",
    "socket 755 1000:1000",
    "directory 700 1000:1000"
  ])("rejects unsafe tmux socket metadata %s", async (metadata) => {
    const { runtime, binding } = socketInspectionRuntime(metadata);
    await expect(runtime.lookupSession(binding, ownership, persistentTmuxSessionName(ownership.terminalId), "$7", "%0"))
      .rejects.toBeInstanceOf(PersistentTmuxIdentityMismatchError);
  });

  test("uses the same mode policy for the recovery capability probe", async () => {
    const { runtime, binding } = socketInspectionRuntime("socket 700 1000:1000");
    await expect(runtime.probe(binding)).resolves.toBeUndefined();
  });

  test("derives a deterministic session name and a runtime-fenced ownership marker", () => {
    expect(persistentTmuxSessionName(ownership.terminalId)).toBe(`ds-${ownership.terminalId}`);
    expect(persistentTerminalOwnershipMarker(ownership)).toMatch(/^[0-9a-f]{64}$/u);
    expect(persistentTerminalOwnershipMarker(ownership)).toBe(persistentTerminalOwnershipMarker({ ...ownership }));
    expect(persistentTerminalOwnershipMarker({ ...ownership, containerId: "d".repeat(64) }))
      .not.toBe(persistentTerminalOwnershipMarker(ownership));
    expect(persistentTerminalOwnershipMarker({ ...ownership, generation: 2 }))
      .not.toBe(persistentTerminalOwnershipMarker(ownership));
  });

  test("uses the existing root execution identity for an isolated tmux socket", () => {
    expect(persistentTmuxBinding("a".repeat(64), 0, 0)).toMatchObject({
      uid: 0,
      gid: 0,
      socketDirectory: "/tmp/devspace-persistent-tmux-0",
      socketPath: "/tmp/devspace-persistent-tmux-0/server.sock"
    });
  });

  test("packages tmux artifacts for a root-owned workspace execution identity", async () => {
    const headers: Array<{ readonly uid?: number; readonly gid?: number }> = [];
    const extract = tar.extract();
    extract.on("entry", (header, stream, next) => {
      headers.push({ uid: header.uid ?? -1, gid: header.gid ?? -1 });
      stream.on("end", next);
      stream.resume();
    });
    await pipeline(await buildPersistentTmuxArchive(0, 0), extract);

    expect(headers.length).toBeGreaterThan(0);
    expect(headers.every((header) => header.uid === 0 && header.gid === 0)).toBe(true);
  });

  test("parses one exact pane and retains pane-death evidence", () => {
    expect(parseTmuxPaneObservation("ds-shell|$4|%7|1234|0|-1|1|1\n")).toEqual({
      sessionName: "ds-shell", sessionId: "$4", paneId: "%7", panePid: 1234,
      paneDead: false, paneDeadStatus: null
    });
    expect(parseTmuxPaneObservation("ds-shell|$4|%7|1234|1|7|1|1\n")).toEqual({
      sessionName: "ds-shell", sessionId: "$4", paneId: "%7", panePid: 1234,
      paneDead: true, paneDeadStatus: 7
    });
  });

  test.each([
    "",
    "ds-shell|$4|%7|1234|0|-1|2|1",
    "ds-shell|$4|%7|1234|0|-1|1|2",
    "ds-shell|$4|%7|bad|0|-1|1|1",
    "ds-shell|$4|%7|1234|false|-1|1|1",
    "ds-shell|$4|%7|1234|1|not-an-exit|1|1"
  ])("rejects incomplete or multi-pane tmux identity %j", (output) => {
    expect(parseTmuxPaneObservation(output)).toBeNull();
  });
});
