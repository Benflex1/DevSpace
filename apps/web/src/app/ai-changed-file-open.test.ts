import { expect, test } from "vitest";
import type { GitInspectionData } from "@devspace/contracts";
import { resolveAiChangedFileOpenTarget } from "./ai-changed-file-open.js";

const status = {
  projectId: "018f0f00-0000-7000-8000-000000000201",
  workspaceId: "018f0f00-0000-7000-8000-000000000202",
  branchName: "main", headCommit: "a".repeat(40), dirty: true, aheadCount: 0, behindCount: 0,
  identity: { name: null, email: null },
  files: [
    { path: "staged.ts", oldPath: null, stagedState: "modified", unstagedState: "unchanged", untracked: false, classification: "modified" },
    { path: "unstaged.ts", oldPath: null, stagedState: "unchanged", unstagedState: "modified", untracked: false, classification: "modified" },
    { path: "both.ts", oldPath: null, stagedState: "modified", unstagedState: "modified", untracked: false, classification: "modified" },
    { path: "gone.ts", oldPath: null, stagedState: "deleted", unstagedState: "unchanged", untracked: false, classification: "deleted" },
    { path: "renamed-new.ts", oldPath: "renamed-old.ts", stagedState: "renamed", unstagedState: "unchanged", untracked: false, classification: "renamed" }
  ]
} as unknown as GitInspectionData;

const file = (path: string, change: "modified" | "deleted" | "renamed" = "modified", oldPath: string | null = null) => ({ path, change, oldPath });

test("opens staged-only and unstaged-only AI changes in the matching Changes view", () => {
  expect(resolveAiChangedFileOpenTarget(file("staged.ts"), status)).toEqual({ kind: "changes", path: "staged.ts", diffKind: "staged" });
  expect(resolveAiChangedFileOpenTarget(file("unstaged.ts"), status)).toEqual({ kind: "changes", path: "unstaged.ts", diffKind: "unstaged" });
});

test("does not guess when a path has both staged and unstaged changes", () => {
  expect(resolveAiChangedFileOpenTarget(file("both.ts"), status)).toEqual({ kind: "edit", path: "both.ts" });
});

test("uses the current renamed path and never normal-reads a deleted file", () => {
  expect(resolveAiChangedFileOpenTarget(file("renamed-new.ts", "renamed", "renamed-old.ts"), status)).toEqual({ kind: "changes", path: "renamed-new.ts", diffKind: "staged" });
  expect(resolveAiChangedFileOpenTarget(file("gone.ts", "deleted"), status)).toEqual({ kind: "changes", path: "gone.ts", diffKind: "staged" });
  expect(resolveAiChangedFileOpenTarget(file("both.ts", "deleted"), status)).toMatchObject({ kind: "unavailable" });
  expect(resolveAiChangedFileOpenTarget(file("missing.ts", "deleted"), null)).toMatchObject({ kind: "unavailable" });
});
