import type { GitInspectionData, GitStatusEntry } from "@devspace/contracts";

export interface GitChangeGroups {
  readonly changes: readonly GitStatusEntry[];
  readonly staged: readonly GitStatusEntry[];
}

export function groupGitChanges(status: GitInspectionData | null): GitChangeGroups {
  const files = status?.files ?? [];
  return {
    changes: files.filter((entry) => entry.unstagedState !== "unchanged"),
    staged: files.filter((entry) => entry.stagedState !== "unchanged")
  };
}

export function gitChangeMarker(entry: GitStatusEntry, staged: boolean): string {
  const state = staged ? entry.stagedState : entry.unstagedState;
  return state === "untracked" ? "U" : state === "renamed" ? "R" : state === "copied" ? "C" : state === "added" ? "A"
    : state === "deleted" ? "D" : state === "modified" ? "M" : "·";
}
