export type ExecutableSource =
  | { kind: "image-path"; command: "codex"; reportedVersion: string | null }
  | { kind: "agent-artifact"; reportedVersion: string | null };

export async function probeImageCodex(docker: {
  createExec(containerId: string, input: {
    command: readonly string[];
    workingDirectory: string;
    environment: Readonly<Record<string, string>>;
    attachStdin: boolean;
    tty: boolean;
  }): Promise<string>;
  startExecAttached(execId: string, tty: boolean): Promise<NodeJS.ReadableStream>;
  inspectExec(execId: string): Promise<{ Running: boolean; ExitCode: number | null }>;
}, containerId: string): Promise<{ present: boolean; version: string | null }> {
  let execId: string;
  try {
    execId = await docker.createExec(containerId, {
      command: ["codex", "--version"],
      workingDirectory: "/workspace",
      environment: {},
      attachStdin: false,
      tty: false
    });
  } catch {
    return { present: false, version: null };
  }
  const chunks: Buffer[] = [];
  try {
    const stream = await docker.startExecAttached(execId, false);
    await new Promise<void>((resolve) => {
      stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => resolve());
      stream.on("close", () => resolve());
      stream.on("error", () => resolve());
    });
  } catch {
    return { present: false, version: null };
  }
  try {
    const inspection = await docker.inspectExec(execId);
    if (inspection.Running || inspection.ExitCode !== 0) return { present: false, version: null };
  } catch {
    return { present: false, version: null };
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const match = text.match(/\d+\.\d+\.\d+/u);
  return { present: true, version: match?.[0] ?? null };
}

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
