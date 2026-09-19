export type ExecutableSource =
  | { kind: "image-path"; command: "codex"; reportedVersion: string | null }
  | { kind: "agent-artifact"; reportedVersion: string | null };

export function resolveCodexExecutable(input: {
  imageHasCodex: boolean;
  imageReportedVersion: string | null;
  artifactAvailable: boolean;
  artifactReportedVersion: string | null;
}): ExecutableSource | { kind: "unavailable" } {
  if (input.imageHasCodex) {
    return { kind: "image-path", command: "codex", reportedVersion: input.imageReportedVersion };
  }
  if (input.artifactAvailable) {
    return { kind: "agent-artifact", reportedVersion: input.artifactReportedVersion };
  }
  return { kind: "unavailable" };
}
