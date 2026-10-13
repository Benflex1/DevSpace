import { describe, expect, test } from "vitest";
import { pipeline } from "node:stream/promises";
import * as tar from "tar-stream";
import {
  buildPersistentTmuxArchive,
  persistentTerminalOwnershipMarker,
  persistentTmuxBinding,
  persistentTmuxSessionName,
  parseTmuxPaneObservation,
  type PersistentTerminalOwnership
} from "./persistent-terminal-runtime.js";

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

describe("persistent tmux identity", () => {
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
