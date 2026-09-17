import type { Duplex } from "node:stream";
import type { CodexSplitRuntime } from "./split-runtime.js";
import type { CodexSplitRuntimeRecord } from "./runtime-record.js";
import type { NativeCodexPty } from "./native-pty.js";
import {
  DockerEngineClient,
  type DockerExecInspection
} from "../docker-runtime.js";

const WORKING_DIRECTORY = "/workspace" as const;
const CODEX_EXECUTABLE = "/opt/devspace/codex-launcher/codex" as const;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const MAX_OUTPUT_BYTES = 32 * 1024;

export interface CodexSplitPtyProof {
  readonly genericTtyCycles: number;
  readonly codexVersionTtyCycles: number;
  readonly nativePtyStartupCycles: number;
}

export interface CodexPtyTiming {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function stageError(reason: string, cause?: unknown): Error {
  return cause === undefined ? new Error(reason) : new Error(reason, { cause });
}

function exitError(exitCode: number | null, detail: string): Error {
  const safeCode = Number.isSafeInteger(exitCode) ? String(exitCode) : "unknown";
  return stageError("native-pty-exit", new Error(`exit-code-${safeCode}-${detail}`));
}

function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("native-pty-stream");
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function timing(input: CodexPtyTiming): Required<CodexPtyTiming> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error("native-pty-exit");
  }
  return {
    timeoutMs,
    pollIntervalMs,
    now: input.now ?? Date.now,
    sleep: input.sleep ?? (async (milliseconds) => await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  };
}

async function inspectPtyState(pty: Pick<NativeCodexPty, "execId" | "containerId" | "inspect">): Promise<DockerExecInspection> {
  let inspection: DockerExecInspection;
  try {
    inspection = await pty.inspect();
  } catch (error) {
    if (error instanceof Error && /^(?:native-pty-exec-state|native-pty-exit)$/u.test(error.message)) throw error;
    throw stageError("native-pty-exec-state", error);
  }
  if (inspection.ID !== pty.execId || inspection.ContainerID !== pty.containerId
    || !Number.isSafeInteger(inspection.ExitCode) && inspection.ExitCode !== null) {
    throw stageError("native-pty-exec-state");
  }
  return inspection;
}

/**
 * Waits for a native Docker exec to finish while keeping stream, state, and
 * nonzero-exit failures distinguishable. The clock and sleep seams make the
 * deadline behavior deterministic in unit tests.
 */
export async function waitForNativeCodexPtyExit(
  input: {
    readonly pty: Pick<NativeCodexPty, "execId" | "containerId" | "stream" | "inspect">;
  } & CodexPtyTiming
): Promise<DockerExecInspection> {
  const pty = input.pty;
  const limits = timing(input);
  let streamError: unknown = null;
  let streamClosed = false;
  const onError = (error: Error): void => { streamError = error; };
  const onClose = (): void => { streamClosed = true; };
  pty.stream.once("error", onError);
  pty.stream.once("close", onClose);
  const deadline = limits.now() + limits.timeoutMs;
  try {
    while (true) {
      if (streamError !== null) throw stageError("native-pty-stream", streamError);
      const inspection = await inspectPtyState(pty);
      if (!inspection.Running) {
        if (inspection.ExitCode === null) throw stageError("native-pty-exec-state");
        if (inspection.ExitCode !== 0) throw exitError(inspection.ExitCode, "nonzero");
        return inspection;
      }
      if (streamClosed) throw stageError("native-pty-stream");
      const remaining = deadline - limits.now();
      if (remaining <= 0) throw exitError(null, "timeout");
      await limits.sleep(Math.min(limits.pollIntervalMs, remaining));
    }
  } finally {
    pty.stream.off("error", onError);
    pty.stream.off("close", onClose);
  }
}

interface AttachedTtyExec {
  readonly containerId: string;
  readonly execId: string;
  readonly stream: Duplex;
  readonly inspect: () => Promise<DockerExecInspection>;
  readonly resize: (columns: number, rows: number) => Promise<void>;
}

async function attachTtyExec(input: {
  readonly docker: DockerEngineClient;
  readonly containerId: string;
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}): Promise<AttachedTtyExec> {
  let execId: string;
  try {
    execId = await input.docker.createExec(input.containerId, {
      command: input.command,
      workingDirectory: WORKING_DIRECTORY,
      environment: input.environment,
      attachStdin: true,
      tty: true
    });
  } catch (error) {
    throw stageError("native-pty-exec-create", error);
  }
  let stream: Duplex;
  try {
    stream = await input.docker.startExecAttached(execId, true);
  } catch (error) {
    throw stageError("native-pty-attach", error);
  }
  if (stream === undefined || typeof stream.destroy !== "function" || typeof stream.on !== "function"
    || typeof stream.write !== "function") {
    stream?.destroy();
    throw stageError("native-pty-stream");
  }
  const inspect = async (): Promise<DockerExecInspection> => {
    let inspection: DockerExecInspection;
    try {
      inspection = await input.docker.inspectExec(execId);
    } catch (error) {
      throw stageError("native-pty-exec-state", error);
    }
    if (inspection.ID !== execId || inspection.ContainerID !== input.containerId) {
      throw stageError("native-pty-exec-state");
    }
    return inspection;
  };
  const resize = async (columns: number, rows: number): Promise<void> => {
    try {
      await input.docker.resizeExec(execId, columns, rows);
    } catch (error) {
      throw stageError("native-pty-resize", error);
    }
  };
  return { containerId: input.containerId, execId, stream, inspect, resize };
}

function assertActive(inspection: DockerExecInspection): void {
  if (!inspection.Running) {
    if (inspection.ExitCode === null) throw stageError("native-pty-exec-state");
    throw exitError(inspection.ExitCode, "before-output");
  }
}

interface TtyOutputObserver {
  readonly waitForMarker: (marker: string, timing: CodexPtyTiming) => Promise<void>;
  readonly hasMarker: (marker: string) => boolean;
  readonly writeLine: (line: string) => void;
  readonly dispose: () => void;
}

function observeTtyOutput(stream: Duplex): TtyOutputObserver {
  let output = Buffer.alloc(0);
  let streamError: unknown = null;
  let streamClosed = false;
  const onData = (chunk: Buffer): void => {
    const bytes = Buffer.from(chunk);
    output = Buffer.concat([output, bytes]);
    if (output.length > MAX_OUTPUT_BYTES) streamError = new Error("native-pty-output-too-large");
  };
  const onError = (error: Error): void => { streamError = error; };
  const onClose = (): void => { streamClosed = true; };
  stream.on("data", onData);
  stream.once("error", onError);
  stream.once("close", onClose);
  return {
    async waitForMarker(marker: string, input: CodexPtyTiming): Promise<void> {
      if (marker.length === 0) throw new Error("native-pty-stream");
      const limits = timing(input);
      const deadline = limits.now() + limits.timeoutMs;
      while (true) {
        if (output.includes(Buffer.from(marker))) return;
        if (streamError !== null) throw stageError("native-pty-stream", streamError);
        if (streamClosed) throw stageError("native-pty-stream");
        const remaining = deadline - limits.now();
        if (remaining <= 0) throw stageError("native-pty-stream", new Error("output-timeout"));
        await limits.sleep(Math.min(limits.pollIntervalMs, remaining));
      }
    },
    hasMarker(marker: string): boolean {
      return output.includes(Buffer.from(marker));
    },
    writeLine(line: string): void {
      if (streamError !== null || streamClosed) throw stageError("native-pty-stream");
      try {
        stream.write(Buffer.from(`${line}\n`, "utf8"));
      } catch (error) {
        throw stageError("native-pty-stream", error);
      }
    },
    dispose(): void {
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("close", onClose);
    }
  };
}

async function resizeWithEvidence(handle: AttachedTtyExec, columns: number, rows: number, phase: "initial" | "second"): Promise<void> {
  try {
    await handle.resize(columns, rows);
  } catch (error) {
    let state: DockerExecInspection | null = null;
    try {
      state = await handle.inspect();
    } catch {
      // The stable outer resize reason remains useful when Docker cannot report
      // a post-failure state; no raw Docker response is exposed.
    }
    const stateReason = state === null
      ? "state-unavailable"
      : state.Running ? "running" : `exited-${state.ExitCode === null ? "unknown" : state.ExitCode}`;
    throw stageError("native-pty-resize", new Error(`native-pty-resize-${phase}-${stateReason}`, { cause: error }));
  }
}

async function closeTtyStream(stream: Duplex, input: CodexPtyTiming): Promise<void> {
  const limits = timing(input);
  let streamError: unknown = null;
  let closed = false;
  const onError = (error: Error): void => { streamError = error; };
  const onClose = (): void => { closed = true; };
  stream.once("error", onError);
  stream.once("close", onClose);
  try {
    stream.destroy();
    const deadline = limits.now() + limits.timeoutMs;
    while (!closed) {
      if (streamError !== null) throw stageError("native-pty-stream", streamError);
      const remaining = deadline - limits.now();
      if (remaining <= 0) throw stageError("native-pty-stream", new Error("close-timeout"));
      await limits.sleep(Math.min(limits.pollIntervalMs, remaining));
    }
  } finally {
    stream.off("error", onError);
    stream.off("close", onClose);
  }
}

async function runTtyCommand(input: {
  readonly docker: DockerEngineClient;
  readonly containerId: string;
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly readyMarker: string;
  readonly requiredMarker?: string;
  readonly inputLine?: string;
  readonly acknowledgementMarker?: string;
  readonly timing?: CodexPtyTiming;
}): Promise<void> {
  const limits = input.timing ?? {};
  const handle = await attachTtyExec(input);
  const observer = observeTtyOutput(handle.stream);
  try {
    const attached = await handle.inspect();
    assertActive(attached);
    await resizeWithEvidence(handle, 120, 40, "initial");
    const afterFirstResize = await handle.inspect();
    assertActive(afterFirstResize);
    await resizeWithEvidence(handle, 100, 30, "second");
    await observer.waitForMarker(input.readyMarker, limits);
    if (input.requiredMarker !== undefined && !observer.hasMarker(input.requiredMarker)) {
      const reason = observer.hasMarker("DEVSPACE_CODEX_VERSION_NOT_EXECUTABLE")
        ? "codex-launcher-not-executable"
        : observer.hasMarker("DEVSPACE_CODEX_VERSION_OUTPUT_MISMATCH")
          ? "codex-version-output-mismatch"
          : "required-output-marker-missing";
      throw stageError("native-pty-exit", new Error(reason));
    }
    if (input.inputLine !== undefined) observer.writeLine(input.inputLine);
    if (input.acknowledgementMarker !== undefined) {
      await observer.waitForMarker(input.acknowledgementMarker, limits);
    }
    await waitForNativeCodexPtyExit({
      pty: {
        containerId: handle.containerId,
        execId: handle.execId,
        stream: handle.stream,
        inspect: handle.inspect
      },
      ...limits
    });
  } finally {
    observer.dispose();
    if (!handle.stream.destroyed) handle.stream.destroy();
  }
}

export async function runCodexSplitGenericTtySmoke(input: {
  readonly docker: DockerEngineClient;
  readonly containerId: string;
  readonly cycleId: string;
  readonly timing?: CodexPtyTiming;
}): Promise<void> {
  const ready = `DEVSPACE_TTY_READY_${input.cycleId}`;
  const acknowledgement = `DEVSPACE_TTY_ACK_${input.cycleId}`;
  const expectedInput = `DEVSPACE_TTY_INPUT_${input.cycleId}`;
  const script = [
    "set -eu",
    "test -t 0",
    "test -t 1",
    `printf '%s\\n' ${shellQuote(ready)}`,
    "IFS= read -r value",
    `test "$value" = ${shellQuote(expectedInput)}`,
    `printf '%s\\n' ${shellQuote(acknowledgement)}`
  ].join("; ");
  await runTtyCommand({
    docker: input.docker,
    containerId: input.containerId,
    command: ["/bin/sh", "-c", script],
    environment: {},
    readyMarker: ready,
    inputLine: expectedInput,
    acknowledgementMarker: acknowledgement,
    ...(input.timing === undefined ? {} : { timing: input.timing })
  });
}

export async function runCodexSplitCodexVersionTtySmoke(input: {
  readonly docker: DockerEngineClient;
  readonly containerId: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timing?: CodexPtyTiming;
}): Promise<void> {
  const script = [
    "set +e",
    `if [ ! -x ${shellQuote(CODEX_EXECUTABLE)} ]; then printf '%s\\n' DEVSPACE_CODEX_VERSION_NOT_EXECUTABLE; sleep 1; exit 126; fi`,
    `output=$(${shellQuote(CODEX_EXECUTABLE)} --version 2>/dev/null)`,
    "status=$?",
    "case \"$output\" in *0.153.4*) printf '%s\\n' DEVSPACE_CODEX_VERSION_OK ;; *) printf '%s\\n' DEVSPACE_CODEX_VERSION_OUTPUT_MISMATCH ;; esac",
    `printf 'DEVSPACE_CODEX_STATUS_%s\\n' "$status"`,
    "sleep 1",
    "exit \"$status\""
  ].join("; ");
  await runTtyCommand({
    docker: input.docker,
    containerId: input.containerId,
    command: ["/bin/sh", "-c", script],
    environment: input.environment,
    readyMarker: "DEVSPACE_CODEX_VERSION_",
    requiredMarker: "DEVSPACE_CODEX_VERSION_OK",
    ...(input.timing === undefined ? {} : { timing: input.timing })
  });
}

async function restartControlContainer(input: { readonly docker: DockerEngineClient; readonly containerId: string }): Promise<void> {
  try {
    await input.docker.stopContainer(input.containerId);
    await input.docker.startContainer(input.containerId);
  } catch (error) {
    throw stageError("native-pty-exit", error);
  }
}

async function runNativePtyStartupSmoke(input: {
  readonly docker: DockerEngineClient;
  readonly runtime: Pick<CodexSplitRuntime, "startNewSession">;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly controlContainerId: string;
  readonly timing?: CodexPtyTiming;
}): Promise<void> {
  const pty = await input.runtime.startNewSession({
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    columns: 120,
    rows: 40
  });
  try {
    const inspection = await inspectPtyState(pty);
    assertActive(inspection);
    await closeTtyStream(pty.stream, input.timing ?? {});
  } catch (error) {
    if (error instanceof Error && /^(?:native-pty-|codex-)/u.test(error.message)) throw error;
    throw stageError("native-pty-exit", error);
  }
  await restartControlContainer({ docker: input.docker, containerId: input.controlContainerId });
}

export async function runCodexSplitPtyProof(input: {
  readonly docker: DockerEngineClient;
  readonly runtime: Pick<CodexSplitRuntime, "startNewSession">;
  readonly record: CodexSplitRuntimeRecord;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly controlEnvironment: Readonly<Record<string, string>>;
  readonly runId: string;
  readonly timing?: CodexPtyTiming;
}): Promise<CodexSplitPtyProof> {
  for (let cycle = 1; cycle <= 5; cycle += 1) {
    await runCodexSplitGenericTtySmoke({
      docker: input.docker,
      containerId: input.record.control.id,
      cycleId: `${input.runId}-generic-${cycle}`,
      ...(input.timing === undefined ? {} : { timing: input.timing })
    });
  }
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await runCodexSplitCodexVersionTtySmoke({
      docker: input.docker,
      containerId: input.record.control.id,
      environment: input.controlEnvironment,
      ...(input.timing === undefined ? {} : { timing: input.timing })
    });
  }
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await runNativePtyStartupSmoke({
      docker: input.docker,
      runtime: input.runtime,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      controlContainerId: input.record.control.id,
      ...(input.timing === undefined ? {} : { timing: input.timing })
    });
  }
  return { genericTtyCycles: 5, codexVersionTtyCycles: 3, nativePtyStartupCycles: 3 };
}
