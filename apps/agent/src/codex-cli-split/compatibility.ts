import { resolveCodexExecutablePath } from "../codex-executable-resolution.js";
import { runBoundedProcess, type BoundedProcessResult } from "../git-inspector.js";

export const ADMITTED_CODEX_VERSION = "0.153.4" as const;

const VERSION_OUTPUT_MAX_BYTES = 16 * 1024;

export interface CodexVersionEvidence {
  readonly executablePath: string;
  readonly versionOutput: string;
  readonly version: string;
  readonly exact: boolean;
}

function assertExecutablePath(executablePath: string): void {
  if (!executablePath.startsWith("/") || executablePath.includes("\0")) {
    throw new Error("codex-executable-path-invalid");
  }
}

export function parseCodexVersionOutput(output: string): string {
  if (Buffer.byteLength(output, "utf8") > VERSION_OUTPUT_MAX_BYTES || output.includes("\0")) {
    throw new Error("codex-version-output-invalid");
  }
  const matches = [...output.matchAll(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/gu)];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error("codex-version-output-invalid");
  }
  return matches[0][1];
}

export function assertAdmittedCodexVersion(input: {
  readonly executablePath: string;
  readonly versionOutput: string;
}): CodexVersionEvidence {
  assertExecutablePath(input.executablePath);
  const version = parseCodexVersionOutput(input.versionOutput);
  if (version !== ADMITTED_CODEX_VERSION) throw new Error("codex-version-not-admitted");
  return { executablePath: input.executablePath, versionOutput: input.versionOutput, version, exact: true };
}

function versionEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/nonexistent",
    XDG_CONFIG_HOME: "/nonexistent",
    XDG_CACHE_HOME: "/nonexistent",
    LANG: "C",
    LC_ALL: "C"
  };
}

export async function probeAdmittedCodexVersion(input: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly executablePath?: string;
  readonly runProcess?: (command: string, args: readonly string[], options: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly env: NodeJS.ProcessEnv;
  }) => Promise<BoundedProcessResult>;
} = {}): Promise<CodexVersionEvidence> {
  const executablePath = input.executablePath ?? resolveCodexExecutablePath(input.environment ?? process.env);
  assertExecutablePath(executablePath);
  const runner = input.runProcess ?? runBoundedProcess;
  const result = await runner(executablePath, ["--version"], {
    timeoutMs: 15_000,
    maxOutputBytes: VERSION_OUTPUT_MAX_BYTES,
    env: versionEnvironment()
  });
  if (result.signal !== null || result.code !== 0) throw new Error("codex-version-probe-failed");
  return assertAdmittedCodexVersion({ executablePath, versionOutput: result.stdout });
}
