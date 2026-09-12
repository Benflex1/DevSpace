import type { GitDiffData } from "@devspace/contracts";

export type DiffPresentation =
  | { readonly kind: "available" }
  | { readonly kind: "no-longer-present"; readonly message: "This change is no longer present." }
  | { readonly kind: "unavailable"; readonly message: string };

export function classifyDiffResult(result: GitDiffData): DiffPresentation {
  if (result.available) return { kind: "available" };
  if (result.reason === "not-found") return { kind: "no-longer-present", message: "This change is no longer present." };
  return { kind: "unavailable", message: `Diff not available for this file (${result.reason}).` };
}
