import { spawn, type SpawnOptions } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { remoteRepositoryUrlSchema, sourceInspectionDataSchema, type SourceInspectionData } from "@devspace/contracts";
import { classifyAuthenticatedGitFailure } from "./authenticated-git-failure.js";

const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const TERMINATION_GRACE_MS = 100;
const FORCED_SETTLEMENT_MS = 100;

export interface GitInspector {
  inspect(url: string): Promise<SourceInspectionData>;
}

export type GitInspectionUnavailableReason = "remote-source" | "timeout" | "output-limit" | "spawn" | "process-management";

export class GitInspectionUnavailableError extends Error {
  constructor(readonly reason: GitInspectionUnavailableReason = "process-management") {
    super("The repository source is currently unavailable.");
    this.name = "GitInspectionUnavailableError";
  }
}

export class GitInspectionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitInspectionPolicyError";
  }
}

export interface BoundedProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface BoundedProcessOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env: NodeJS.ProcessEnv;
  readonly onSpawn?: (pid: number) => void;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Refusing to signal an invalid process group.");
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function runBoundedProcess(command: string, args: readonly string[], options: BoundedProcessOptions): Promise<BoundedProcessResult> {
  if (process.platform === "win32") throw new GitInspectionUnavailableError("spawn");
  return await new Promise<BoundedProcessResult>((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env
    };
    const child = spawn(command, [...args], spawnOptions);
    const pid = child.pid;
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (pid === undefined || pid <= 1 || childStdout === null || childStderr === null) {
      child.kill("SIGKILL");
      reject(new GitInspectionUnavailableError("spawn"));
      return;
    }
    options.onSpawn?.(pid);
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let settled = false;
    let cancelling = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    let settlementTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      if (settlementTimer !== undefined) clearTimeout(settlementTimer);
      childStdout.removeAllListeners();
      childStderr.removeAllListeners();
      child.removeAllListeners();
      childStdout.destroy();
      childStderr.destroy();
    };
    const fail = (reason: GitInspectionUnavailableReason) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new GitInspectionUnavailableError(reason));
    };
    const cancel = (reason: "timeout" | "output-limit") => {
      if (settled || cancelling) return;
      cancelling = true;
      clearTimeout(timeoutTimer);
      try { signalProcessGroup(pid, "SIGTERM"); } catch { fail("process-management"); return; }
      terminationTimer = setTimeout(() => {
        try { signalProcessGroup(pid, "SIGKILL"); } catch { fail("process-management"); return; }
        settlementTimer = setTimeout(() => fail(reason), FORCED_SETTLEMENT_MS);
      }, TERMINATION_GRACE_MS);
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (cancelling || settled) return;
      totalBytes += chunk.length;
      if (totalBytes > options.maxOutputBytes) { cancel("output-limit"); return; }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    const timeoutTimer = setTimeout(() => cancel("timeout"), options.timeoutMs);
    childStdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    childStderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", () => fail("spawn"));
    child.once("close", (code, signal) => {
      // A direct child may exit on SIGTERM while a credential helper still holds the process
      // group. Keep the escalation timer alive until the group has received SIGKILL.
      if (cancelling) return;
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, stderr, code, signal });
    });
  });
}

export function parseLsRemoteOutput(output: string): SourceInspectionData {
  let defaultBranch: string | null = null;
  let headCommit: string | null = null;
  for (const line of output.split("\n")) {
    const symref = /^ref: refs\/heads\/(.+)\tHEAD$/u.exec(line);
    if (symref?.[1] !== undefined) defaultBranch = symref[1];
    const head = /^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/u.exec(line);
    if (head?.[1] !== undefined) headCommit = head[1];
  }
  return sourceInspectionDataSchema.parse({ sourceKind: "remote", isGitRepository: true, defaultBranch, headCommit });
}

function validateInspectionUrl(rawUrl: string): string {
  const parsed = remoteRepositoryUrlSchema.parse(rawUrl);
  const url = new URL(parsed);
  if (url.protocol !== "https:") throw new GitInspectionPolicyError("Only HTTPS Git repository URLs are supported for source inspection.");
  if (url.search !== "") throw new GitInspectionPolicyError("Repository URLs containing query parameters are not supported.");
  return parsed;
}

export function createProductionGitInspector(options: {
  timeoutMs?: number;
  runProcess?: typeof runBoundedProcess;
} = {}): GitInspector {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const processRunner = options.runProcess ?? runBoundedProcess;
  return {
    async inspect(rawUrl) {
      const url = validateInspectionUrl(rawUrl);
      const caFile = process.env.DEVSPACE_GIT_CA_FILE;
      const result = await processRunner("/usr/bin/git", [
        "-c", "core.hooksPath=/dev/null",
        "-c", "submodule.recurse=false",
        "-c", "protocol.allow=never",
        "-c", "protocol.https.allow=always",
        ...(caFile === undefined ? [] : ["-c", `http.sslCAInfo=${path.resolve(caFile)}`]),
        "ls-remote", "--symref", url, "HEAD"
      ], {
        timeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/nonexistent",
          LANG: "C",
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "/bin/false"
        }
      });
      if (result.signal === null && result.code === 0) return parseLsRemoteOutput(result.stdout);
      const failureKind = classifyAuthenticatedGitFailure(result);
      if (failureKind === "remote-source" || failureKind === "authentication") {
        throw new GitInspectionUnavailableError("remote-source");
      }
      throw new Error("git-inspection-process-failed");
    }
  };
}
