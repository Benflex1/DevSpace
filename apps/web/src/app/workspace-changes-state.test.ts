import { expect, test } from "vitest";
import { gitBranchNameSchema } from "@devspace/contracts";
import { gitChangeMarker, groupGitChanges } from "./workspace-changes-state.js";

const status = {
  projectId: "018f0f00-0000-7000-8000-000000000101",
  workspaceId: "018f0f00-0000-7000-8000-000000000102",
  branchName: gitBranchNameSchema.parse("main"),
  headCommit: "a".repeat(40), dirty: true, aheadCount: 1, behindCount: 2,
  identity: { name: "Dev", email: "dev@example.invalid" },
  files: [
    { path: "both.ts", oldPath: null, stagedState: "modified" as const, unstagedState: "modified" as const, untracked: false, classification: "modified" as const },
    { path: "new.ts", oldPath: null, stagedState: "unchanged" as const, unstagedState: "untracked" as const, untracked: true, classification: "added" as const },
    { path: "done.ts", oldPath: null, stagedState: "added" as const, unstagedState: "unchanged" as const, untracked: false, classification: "added" as const }
  ]
};

test("groups a file with both staged and unstaged changes in both review sections", () => {
  const groups = groupGitChanges(status);
  expect(groups.changes.map((entry) => entry.path)).toEqual(["both.ts", "new.ts"]);
  expect(groups.staged.map((entry) => entry.path)).toEqual(["both.ts", "done.ts"]);
});

test("uses compact useful change markers", () => {
  expect(gitChangeMarker(status.files[0]!, false)).toBe("M");
  expect(gitChangeMarker(status.files[1]!, false)).toBe("U");
  expect(gitChangeMarker(status.files[2]!, true)).toBe("A");
});
