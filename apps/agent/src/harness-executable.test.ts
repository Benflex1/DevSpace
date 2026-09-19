import { expect, test } from "vitest";
import { resolveCodexExecutable } from "./harness-executable.js";

test("image codex wins over a configured agent artifact", () => {
  expect(resolveCodexExecutable({
    imageHasCodex: true, imageReportedVersion: "0.155.1",
    artifactAvailable: true, artifactReportedVersion: "0.145.0"
  })).toEqual({ kind: "image-path", command: "codex", reportedVersion: "0.155.1" });
});

test("agent artifact is used only when image codex is absent", () => {
  expect(resolveCodexExecutable({
    imageHasCodex: false, imageReportedVersion: null,
    artifactAvailable: true, artifactReportedVersion: "0.145.0"
  })).toEqual({ kind: "agent-artifact", reportedVersion: "0.145.0" });
});

test("unavailable when neither image nor artifact exists", () => {
  expect(resolveCodexExecutable({
    imageHasCodex: false, imageReportedVersion: null,
    artifactAvailable: false, artifactReportedVersion: null
  })).toEqual({ kind: "unavailable" });
});
