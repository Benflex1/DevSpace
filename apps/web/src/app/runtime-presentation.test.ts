import { describe, expect, test } from "vitest";
import { runtimePresentationLabel, runtimePresentationMessage } from "./runtime-presentation.js";

describe("runtime presentation", () => {
  test.each([
    ["absent", "Not started"],
    ["creating", "Creating"],
    ["starting", "Starting"],
    ["running", "Running"],
    ["stopping", "Stopping"],
    ["stopped", "Stopped"],
    ["degraded", "Degraded"],
    ["failed", "Failed"],
    ["removing", "Removing"],
    ["lost", "Lost"]
  ] as const)("labels %s truthfully", (state, label) => {
    expect(runtimePresentationLabel(state, true)).toBe(label);
  });

  test("labels an unavailable rootless runtime as unavailable even when no stack exists", () => {
    expect(runtimePresentationLabel("absent", false)).toBe("Unavailable");
  });

  test("does not turn an unknown observed state into a misleading running state", () => {
    expect(runtimePresentationLabel("unexpected", true)).toBe("Unavailable");
  });

  test("explains the stopped runtime prerequisite without exposing private diagnostics", () => {
    expect(runtimePresentationMessage("absent", true, null)).toBe("Start the workspace runtime before Codex can start.");
    expect(runtimePresentationMessage("stopped", true, null)).toBe("Start the workspace runtime before Codex can start.");
  });
});
