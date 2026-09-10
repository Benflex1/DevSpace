import { expect, test } from "vitest";
import type { GitDiffData } from "@devspace/contracts";
import { classifyDiffResult } from "./editor-diff-state.js";

const base = {
  projectId: "018f0f00-0000-7000-0000-000000000101",
  workspaceId: "018f0f00-0000-7000-0000-000000000102",
  path: "src/App.tsx",
  oldPath: null,
  kind: "unstaged" as const
};

test("treats a missing retained diff as a reconciliable no-longer-present change", () => {
  const result: GitDiffData = { ...base, available: false, reason: "not-found" };

  expect(classifyDiffResult(result)).toEqual({
    kind: "no-longer-present",
    message: "This change is no longer present."
  });
});

test("keeps genuine unavailable diff reasons distinct from stale-entry reconciliation", () => {
  const result: GitDiffData = { ...base, available: false, reason: "binary" };

  expect(classifyDiffResult(result)).toEqual({
    kind: "unavailable",
    message: "Diff not available for this file (binary)."
  });
});
