import type { Duplex } from "node:stream";
import { uuidV7Schema } from "@devspace/contracts";
import { DockerEngineClient, type DockerExecInspection } from "../docker-runtime.js";
import type { CodexControlSidecarBinding } from "./control-sidecar.js";

const EXECUTABLE_PATH = "/opt/devspace/codex-launcher/codex" as const;
const WORKING_DIRECTORY = "/workspace" as const;
const MIN_COLUMNS = 1;
const MAX_COLUMNS = 1_000;
const MIN_ROWS = 1;
const MAX_ROWS = 500;

function stageError(reason: string, cause?: unknown): Error {
  return cause === undefined ? new Error(reason) : new Error(reason, { cause });
}

export interface NativeCodexPty {
  readonly containerId: string;
  readonly execId: string;
  readonly command: readonly string[];
  readonly workingDirectory: "/workspace";
  readonly stream: Duplex;
  resize(columns: number, rows: number): Promise<void>;
  inspect(): Promise<DockerExecInspection>;
}

function inputKeysAreExact(input: object): boolean {
  const allowed = new Set(["docker", "control", "executablePath", "resumeSessionId", "environment", "columns", "rows"]);
  return Object.keys(input).every((key) => allowed.has(key));
}

function assertSize(columns: number, rows: number): void {
  if (!Number.isSafeInteger(columns) || columns < MIN_COLUMNS || columns > MAX_COLUMNS
    || !Number.isSafeInteger(rows) || rows < MIN_ROWS || rows > MAX_ROWS) {
    throw new Error("native-pty-size");
  }
}

function sortedEnvironment(environment: Readonly<Record<string, string>>): readonly string[] {
  return Object.entries(environment)
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || value.includes("\0")
        || [...value].some((character) => (character.codePointAt(0) ?? 0) < 32)) {
        throw new Error("native-pty-environment");
      }
      return `${name}=${value}`;
    })
    .sort((left, right) => left.localeCompare(right));
}

function assertEnvironmentMatches(
  environment: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>
): void {
  if (JSON.stringify(sortedEnvironment(environment)) !== JSON.stringify(sortedEnvironment(expected))) {
    throw new Error("native-pty-environment");
  }
}

function assertRemoteControl(control: CodexControlSidecarBinding, environment: Readonly<Record<string, string>>): void {
  const policy = control.policy;
  const remote = policy.remote;
  if (control.containerId.length === 0
    || policy.workingDirectory !== WORKING_DIRECTORY
    || policy.physicalWorkspaceMounts.length !== 0
    || policy.physicalGitMounts.length !== 0
    || policy.forwardingDisabled !== true
    || policy.proxyProcesses.length !== 0
    || remote.environmentId !== "remote"
    || remote.logicalCwd !== WORKING_DIRECTORY
    || remote.workspaceRoots.length !== 1 || remote.workspaceRoots[0] !== WORKING_DIRECTORY
    || remote.localEnvironmentAvailable !== false || remote.unifiedExecRequired !== true
    || remote.endpoint.endpointHost !== "codex-executor"
    || remote.endpoint.endpointUrl !== `ws://codex-executor:${remote.endpoint.endpointPort}`
    || remote.endpoint.security === "unproven"
    || remote.managedPolicy.projectLayerOverrideProof !== "cannot-override"
    || policy.environment.CODEX_HOME !== "/codex-home"
    || policy.environment.HOME !== "/codex-home"
    || policy.environment.CODEX_EXEC_SERVER_URL !== remote.endpoint.endpointUrl) {
    throw new Error("native-pty-remote-policy");
  }
  assertEnvironmentMatches(environment, policy.environment);
}

function assertResumeId(resumeSessionId: string | null): void {
  if (resumeSessionId !== null && !uuidV7Schema.safeParse(resumeSessionId).success) {
    throw new Error("native-pty-session");
  }
}

export async function startNativeCodexPty(input: {
  readonly docker: DockerEngineClient;
  readonly control: CodexControlSidecarBinding;
  readonly executablePath: "/opt/devspace/codex-launcher/codex";
  readonly resumeSessionId: string | null;
  readonly environment: Readonly<Record<string, string>>;
  readonly columns: number;
  readonly rows: number;
}): Promise<NativeCodexPty> {
  if (input === null || !inputKeysAreExact(input)) throw new Error("native-pty-input");
  if (input.executablePath !== EXECUTABLE_PATH || input.control.policy.artifact.launcherPath !== EXECUTABLE_PATH) {
    throw new Error("native-pty-executable");
  }
  assertRemoteControl(input.control, input.environment);
  assertResumeId(input.resumeSessionId);
  assertSize(input.columns, input.rows);
  const command = input.resumeSessionId === null
    ? [EXECUTABLE_PATH]
    : [EXECUTABLE_PATH, "resume", input.resumeSessionId];
  let execId: string;
  try {
    execId = await input.docker.createExec(input.control.containerId, {
      command,
      workingDirectory: WORKING_DIRECTORY,
      environment: input.environment,
      attachStdin: true,
      tty: true
    });
  } catch (error) {
    throw stageError("native-pty-exec-create", error);
  }
  let stream: Duplex | undefined;
  try {
    stream = await input.docker.startExecAttached(execId, true);
  } catch (error) {
    throw stageError("native-pty-attach", error);
  }
  if (stream === undefined || typeof stream.destroy !== "function" || typeof stream.on !== "function") {
    stream?.destroy();
    throw stageError("native-pty-stream");
  }
  try {
    await input.docker.resizeExec(execId, input.columns, input.rows);
  } catch (error) {
    stream.destroy();
    throw stageError("native-pty-resize", error);
  }
  return {
    containerId: input.control.containerId,
    execId,
    command,
    workingDirectory: WORKING_DIRECTORY,
    stream,
    async resize(columns, rows) {
      assertSize(columns, rows);
      try {
        await input.docker.resizeExec(execId, columns, rows);
      } catch (error) {
        throw stageError("native-pty-resize", error);
      }
    },
    async inspect() {
      let inspection: DockerExecInspection;
      try {
        inspection = await input.docker.inspectExec(execId);
      } catch (error) {
        throw stageError("native-pty-exec-state", error);
      }
      if (inspection.ID !== execId || inspection.ContainerID !== input.control.containerId) {
        throw stageError("native-pty-exec-state");
      }
      return inspection;
    }
  };
}
