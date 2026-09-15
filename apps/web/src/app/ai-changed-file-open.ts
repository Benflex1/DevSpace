import type { GitInspectionData } from "@devspace/contracts";
import type { BrowserAiTurn } from "./ai-session-projection.js";

export type AiChangedFileOpenTarget =
  | { kind: "edit"; path: string }
  | { kind: "changes"; path: string; diffKind: "staged" | "unstaged" }
  | { kind: "unavailable"; path: string; reason: string };

export function resolveAiChangedFileOpenTarget(
  file: BrowserAiTurn["changedFiles"]["files"][number],
  status: GitInspectionData | null
): AiChangedFileOpenTarget {
  const entry = status?.files.find((candidate) => candidate.path === file.path);
  const staged = entry !== undefined && entry.stagedState !== "unchanged";
  const unstaged = entry !== undefined && entry.unstagedState !== "unchanged";
  if (file.change === "deleted") {
    if (staged && !unstaged) return { kind: "changes", path: file.path, diffKind: "staged" };
    if (unstaged && !staged) return { kind: "changes", path: file.path, diffKind: "unstaged" };
    return { kind: "unavailable", path: file.path, reason: "The deleted file has no single safe Workbench view." };
  }
  if (staged && !unstaged) return { kind: "changes", path: file.path, diffKind: "staged" };
  if (unstaged && !staged) return { kind: "changes", path: file.path, diffKind: "unstaged" };
  return { kind: "edit", path: file.path };
}
