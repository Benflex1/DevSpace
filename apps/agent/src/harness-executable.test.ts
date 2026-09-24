/* eslint-disable @typescript-eslint/require-await -- fake Docker execs are synchronous. */
import { Readable } from "node:stream";
import { expect, test } from "vitest";
import { probeImageCodex, resolveCodexExecutable } from "./harness-executable.js";

test("probe reports image codex when argv exec exits 0", async () => {
  const commands: Array<readonly string[]> = [];
  const probed = await probeImageCodex({
    createExec: async (_containerId, input) => {
      commands.push(input.command);
      return "exec-codex";
    },
    startExecAttached: async () => Readable.from(["codex-cli 0.155.1\n"]),
    inspectExec: async () => ({ Running: false, ExitCode: 0 })
  }, "container-owned");
  expect(commands).toEqual([["codex", "--version"]]);
  expect(probed).toEqual({ present: true, version: "0.155.1" });
});

test("probe reports codex absent when exec fails or the command is missing", async () => {
  await expect(probeImageCodex({
    createExec: async () => { throw new Error("missing"); },
    startExecAttached: async () => Readable.from([]),
    inspectExec: async () => ({ Running: false, ExitCode: 0 })
  }, "container-owned")).resolves.toEqual({ present: false, version: null });
  await expect(probeImageCodex({
    createExec: async () => "exec-codex",
    startExecAttached: async () => Readable.from(["not found\n"]),
    inspectExec: async () => ({ Running: false, ExitCode: 127 })
  }, "container-owned")).resolves.toEqual({ present: false, version: null });
});

test("resolve prefers image path, then artifact, then unavailable", () => {
  expect(resolveCodexExecutable({
    imageHasCodex: true, imageReportedVersion: "0.155.1", artifactAvailable: true, artifactReportedVersion: "0.145.0"
  })).toEqual({ kind: "image-path", command: "codex", reportedVersion: "0.155.1" });
  expect(resolveCodexExecutable({
    imageHasCodex: false, imageReportedVersion: null, artifactAvailable: true, artifactReportedVersion: null
  })).toEqual({ kind: "agent-artifact", reportedVersion: null });
  expect(resolveCodexExecutable({
    imageHasCodex: false, imageReportedVersion: null, artifactAvailable: false, artifactReportedVersion: null
  })).toEqual({ kind: "unavailable" });
});
