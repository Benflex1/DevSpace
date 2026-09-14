import { statSync } from "node:fs";
import path from "node:path";

const CODEX_EXECUTABLE_NAME = "codex";

function isExecutableFile(candidate: string): boolean {
  try {
    const stats = statSync(candidate);
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function resolveCodexExecutablePath(environment: NodeJS.ProcessEnv = process.env): string {
  const configuredPath = environment.DEVSPACE_CODEX_EXECUTABLE_PATH;
  if (configuredPath !== undefined) return configuredPath;

  const pathValue = environment.PATH;
  if (pathValue === undefined || pathValue.length === 0) throw new Error("CODEX_EXECUTABLE_MISSING");
  for (const directory of pathValue.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, CODEX_EXECUTABLE_NAME);
    if (isExecutableFile(candidate)) return candidate;
  }
  throw new Error("CODEX_EXECUTABLE_MISSING");
}
