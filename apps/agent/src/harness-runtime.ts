import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import {
  harnessExecutionAdmissionUncertain,
  type HarnessAdmissionIdentity,
  type HarnessAdmissionPhaseRunner,
  type HarnessAdmissionReconciliation,
  type HarnessRecoveryIdentity,
  type HarnessRecoveryReport
} from "./execution-manager.js";
import {
  classifyResumeArgv,
  resumeCapability,
  substituteResumeArgv,
  uuidV7Schema,
  type HarnessArgv
} from "@devspace/contracts";
import { durableJsonWriter, readStrictJson } from "./private-state.js";
import {
  codexSessionIdBaseline,
  discoverCodexNativeSessionId,
  repairLegacyCodexFilenameId
} from "./harness-codex-discovery.js";
import type { ExecutableSource } from "./harness-executable.js";
import { CODEX_HARNESS_ID, CODEX_PRESET, HARNESS_SLOT_ENV } from "./harness-presets.js";
import { HarnessHomeError, type HarnessHomeStore } from "./harness-home.js";
import type { HarnessSlotMountObservation } from "./workspace-runtime.js";
import * as z from "zod";

export class HarnessRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HarnessRuntimeError";
  }
}

export type CustomHarnessDefinition = {
  id: string;
  displayName: string;
  origin: "custom";
  launch: HarnessArgv;
  resume: HarnessArgv | null;
  environment: Record<string, { kind: "literal"; value: string }>;
  privateState: { kind: "none" };
};

type HarnessAdmissionOperation = "native-harness.start" | "native-harness.resume";
type HarnessAdmissionPhase = "serialization-wait" | "admission-execution" | "total-admission"
  | "runtime-validation" | "workspace-validation" | "executable-probe" | "codex-session-baseline"
  | "workspace-runtime-validation" | "harness-home-lease" | "harness-home-materialization"
  | "docker-exec-creation";
type HarnessAdmissionOutcome = "success" | "failure" | "uncertain";
type HarnessAdmissionTiming = {
  readonly operationName: HarnessAdmissionOperation;
  readonly phase: HarnessAdmissionPhase;
  readonly outcome: HarnessAdmissionOutcome;
  readonly durationMs: number;
  readonly requestId?: string;
  readonly sessionId: string;
  readonly workspaceId?: string;
  readonly terminalId?: string;
  readonly harnessId?: string;
  readonly processGeneration: number;
  readonly errorCode?: string;
};
type HarnessAdmissionTimingContext = Omit<HarnessAdmissionTiming, "phase" | "outcome" | "durationMs" | "errorCode">;

type SessionRecord = {
  workspaceId: string;
  harnessId: string;
  processId: string;
  nativeSessionId: string | null;
  executableSource: ExecutableSource | null;
  state: "live" | "stopped" | "lost";
  leaseId: string | null;
  discoveryBaseline?: string[];
  recoveryPhase?: "ready-to-release";
  recoveryPending?: boolean;
  definitionDigest: string | null;
  processGeneration: number;
  admission: "started" | "uncertain";
};

type HarnessInspectionIdentity = {
  workspaceId: string;
  harnessId: string;
  processId?: string;
  processGeneration: number;
};

function assertHarnessInspectionIdentity(
  expected: HarnessInspectionIdentity,
  actual: HarnessInspectionIdentity
): void {
  if (expected.workspaceId !== actual.workspaceId || expected.harnessId !== actual.harnessId
    || (expected.processId !== undefined && expected.processId !== actual.processId)
    || expected.processGeneration !== actual.processGeneration) {
    throw new HarnessRuntimeError("RESOURCE_STATE_CONFLICT", "The inspection identity does not match this harness generation.");
  }
}

const sessionRecordSchema = z.strictObject({
  workspaceId: z.string(),
  harnessId: z.string(),
  processId: z.string(),
  nativeSessionId: z.string().nullable(),
  executableSource: z.unknown().nullable(),
  state: z.enum(["live", "stopped", "lost"]),
  leaseId: z.string().nullable(),
  discoveryBaseline: z.array(uuidV7Schema).max(4_096).optional(),
  recoveryPhase: z.literal("ready-to-release").optional(),
  recoveryPending: z.boolean().optional(),
  definitionDigest: z.string().nullable().default(null),
  processGeneration: z.number().int().positive().default(1),
  admission: z.enum(["started", "uncertain"]).default("started")
});

export interface HarnessRuntimeDependencies {
  readonly home: HarnessHomeStore;
  readonly stateRoot: string;
  readonly createHarnessExec: (input: {
    projectId: string; workspaceId: string; processId: string; terminalId: string;
    command: readonly string[]; environment: Readonly<Record<string, string>>;
    sessionId: string; processGeneration: number; leaseId: string | null;
    measureAdmissionPhase: HarnessAdmissionPhaseRunner;
  }) => Promise<void>;
  readonly reconcileHarnessAdmission?: (input: HarnessAdmissionIdentity) => Promise<HarnessAdmissionReconciliation>;
  readonly observeHarnessRecovery?: () => readonly HarnessRecoveryReport[];
  readonly inspectSlot: (workspaceId: string) => Promise<HarnessSlotMountObservation>;
  readonly recreateWorkspace?: (input: { workspaceId: string; projectId: string }) => Promise<HarnessSlotMountObservation>;
  readonly imageCodex?: { present: boolean; version: string | null };
  readonly probeImageCodex?: (input: {
    projectId: string; workspaceId: string; measureAdmissionPhase: HarnessAdmissionPhaseRunner;
  }) => Promise<{ present: boolean; version: string | null }>;
  readonly artifact?: { available: boolean; version: string | null; command: readonly string[] };
  readonly stageNativeCodex?: (input: {
    projectId: string; workspaceId: string; sessionId: string; measureAdmissionPhase: HarnessAdmissionPhaseRunner;
  }) => Promise<{
    entrypointPath: string; reportedVersion: string | null;
  }>;
  readonly onAdmissionTiming?: (timing: HarnessAdmissionTiming) => void;
  readonly now?: () => Date;
}

export function createHarnessRuntime(dependencies: HarnessRuntimeDependencies) {
  const customs = new Map<string, CustomHarnessDefinition>();
  const sessionsRoot = path.join(path.resolve(dependencies.stateRoot), "harness-sessions");
  const liveByWorkspace = new Map<string, string>();
  const admissionsBySession = new Map<string, {
    workspaceId: string;
    harnessId: string;
    processId: string;
    processGeneration: number;
    definitionDigest: string;
    activeRequests: number;
  }>();

  const sessionPath = (sessionId: string) => path.join(sessionsRoot, `${sessionId}.json`);

  const loadSession = async (sessionId: string): Promise<SessionRecord> => {
    const record = sessionRecordSchema.parse(await readStrictJson(sessionPath(sessionId), sessionRecordSchema)) as SessionRecord;
    if (record.harnessId === CODEX_HARNESS_ID && typeof record.nativeSessionId === "string"
      && !uuidV7Schema.safeParse(record.nativeSessionId).success) {
      try {
        const repaired = await repairLegacyCodexFilenameId(
          dependencies.home.persistentHomePath(CODEX_HARNESS_ID), record.nativeSessionId
        );
        if (repaired !== null) {
          record.nativeSessionId = repaired;
          await saveSession(sessionId, record);
        }
      } catch {
        // A missing or ambiguous legacy mapping stays private and non-resumable.
      }
    }
    return record;
  };

  const saveSession = async (sessionId: string, record: SessionRecord): Promise<void> => {
    await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
    await durableJsonWriter.write(sessionPath(sessionId), record);
  };

  const workspaceHarnessBusy = async (workspaceId: string, sessionId: string): Promise<boolean> => {
    const { readdir } = await import("node:fs/promises");
    let names: string[];
    try { names = await readdir(sessionsRoot); } catch { return false; }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const candidateId = name.slice(0, -".json".length);
      if (candidateId === sessionId) continue;
      const candidate = await loadSession(candidateId).catch(() => null);
      if (candidate?.workspaceId === workspaceId
        && (candidate.state === "live" || candidate.leaseId !== null || candidate.recoveryPending === true)) return true;
    }
    return false;
  };

  const definitionOf = (harnessId: string) => {
    if (harnessId === CODEX_HARNESS_ID) return { ...CODEX_PRESET, origin: "builtin" as const, environment: {} as Record<string, { kind: "literal"; value: string }> };
    const custom = customs.get(harnessId);
    if (custom === undefined) throw new HarnessRuntimeError("RESOURCE_NOT_FOUND", "The harness definition was not found.");
    return custom;
  };

  const dedicatedHome = (harnessId: string) => harnessId === CODEX_HARNESS_ID;

  const digestOf = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

  const authorityDigest = (value: { launch: unknown; resume: unknown; environment?: unknown }): string => digestOf({
    launch: value.launch, resume: value.resume ?? null, environment: value.environment ?? {}
  });

  let mutation = Promise.resolve();
  const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = mutation.then(operation, operation);
    mutation = run.then(() => undefined, () => undefined);
    return run;
  };

  const reportAdmissionTiming = (
    context: HarnessAdmissionTimingContext,
    phase: HarnessAdmissionPhase,
    durationMs: number,
    outcome: HarnessAdmissionOutcome,
    error?: unknown
  ): void => {
    if (dependencies.onAdmissionTiming === undefined) return;
    const errorCode = error instanceof HarnessRuntimeError || error instanceof HarnessHomeError
      ? error.code
      : error !== undefined && harnessExecutionAdmissionUncertain(error) ? "HARNESS_ADMISSION_UNCERTAIN"
        : error === undefined ? undefined : "AGENT_INTERNAL_ERROR";
    try {
      dependencies.onAdmissionTiming({
        ...context, phase, durationMs: Math.max(0, durationMs), outcome,
        ...(errorCode === undefined ? {} : { errorCode })
      });
    } catch { /* diagnostic callbacks must not affect admission */ }
  };

  const measureAdmissionPhase = async <T>(
    context: HarnessAdmissionTimingContext,
    phase: HarnessAdmissionPhase,
    operation: () => Promise<T>
  ): Promise<T> => {
    const startedAt = performance.now();
    try {
      const result = await operation();
      reportAdmissionTiming(context, phase, performance.now() - startedAt, "success");
      return result;
    } catch (error) {
      const outcome = ((error instanceof HarnessRuntimeError && error.code === "HARNESS_ADMISSION_UNCERTAIN")
        || harnessExecutionAdmissionUncertain(error)) ? "uncertain" : "failure";
      reportAdmissionTiming(context, phase, performance.now() - startedAt, outcome, error);
      throw error;
    }
  };

  const runAdmission = <T>(
    context: HarnessAdmissionTimingContext,
    operation: () => Promise<T>
  ): Promise<T> => {
    const queuedAt = performance.now();
    return exclusive(async () => {
      const executionStartedAt = performance.now();
      reportAdmissionTiming(context, "serialization-wait", executionStartedAt - queuedAt, "success");
      let outcome: HarnessAdmissionOutcome = "success";
      let failure: unknown;
      try {
        return await operation();
      } catch (error) {
        failure = error;
        outcome = ((error instanceof HarnessRuntimeError && error.code === "HARNESS_ADMISSION_UNCERTAIN")
          || harnessExecutionAdmissionUncertain(error)) ? "uncertain" : "failure";
        throw error;
      } finally {
        const completedAt = performance.now();
        reportAdmissionTiming(context, "admission-execution", completedAt - executionStartedAt, outcome, failure);
        reportAdmissionTiming(context, "total-admission", completedAt - queuedAt, outcome, failure);
      }
    });
  };

  const releaseAdmittedHome = async (workspaceId: string, harnessId: string, leaseId: string | null) => {
    if (leaseId === null) return;
    try { await dependencies.home.writeBackAndClear({ workspaceId, leaseId }); }
    catch { /* slot was not materialized, or writeback already completed */ }
    try { await dependencies.home.releaseLease({ harnessId, leaseId }); }
    catch { /* lease was already released by settlement or a previous compensation */ }
  };

  const writeBackAndReleaseHome = async (sessionId: string, record: SessionRecord): Promise<void> => {
    if (record.leaseId === null) return;
    if (record.recoveryPhase !== "ready-to-release") {
      await dependencies.home.writeBackAndClear({ workspaceId: record.workspaceId, leaseId: record.leaseId });
      if (record.harnessId === CODEX_HARNESS_ID) {
        const homePath = dependencies.home.persistentHomePath(CODEX_HARNESS_ID);
        if (record.nativeSessionId === null && record.discoveryBaseline !== undefined) {
          record.nativeSessionId = await discoverCodexNativeSessionId(homePath, { baselineIds: record.discoveryBaseline });
        } else if (uuidV7Schema.safeParse(record.nativeSessionId).success) {
          const verified = await discoverCodexNativeSessionId(homePath, { expectedId: record.nativeSessionId! });
          if (verified !== record.nativeSessionId) {
            throw new HarnessRuntimeError("HARNESS_NATIVE_SESSION_ID_UNVERIFIED", "The previously bound Codex conversation could not be verified.");
          }
        }
      }
      delete record.discoveryBaseline;
      record.recoveryPhase = "ready-to-release";
      await saveSession(sessionId, record);
    }
    await dependencies.home.releaseLease({ harnessId: record.harnessId, leaseId: record.leaseId });
    record.leaseId = null;
    delete record.recoveryPhase;
  };

  const restoreAfterDefinitePreStartFailure = async (
    sessionId: string,
    workspaceId: string,
    harnessId: string,
    leaseId: string | null,
    previous: SessionRecord | null,
    admitted: SessionRecord
  ) => {
    await releaseAdmittedHome(workspaceId, harnessId, leaseId);
    liveByWorkspace.delete(workspaceId);
    await saveSession(sessionId, previous === null
      ? { ...admitted, state: "stopped", leaseId: null, admission: "started" }
      : { ...previous, leaseId: null });
  };

  const finalizeRecoveredLoss = async (identity: HarnessRecoveryIdentity): Promise<void> => {
    const record = await loadSession(identity.sessionId);
    if (record.processId !== identity.processId || record.workspaceId !== identity.workspaceId
      || record.processGeneration !== identity.processGeneration || record.leaseId !== identity.leaseId) return;
    if (record.state === "stopped" && record.leaseId === null) return;
    await writeBackAndReleaseHome(identity.sessionId, record);
    record.state = "lost";
    record.admission = "started";
    delete record.recoveryPending;
    liveByWorkspace.delete(record.workspaceId);
    await saveSession(identity.sessionId, record);
  };

  const probeCodex = async (input: { projectId: string; workspaceId: string; measureAdmissionPhase: HarnessAdmissionPhaseRunner }) => dependencies.probeImageCodex !== undefined
    ? await dependencies.probeImageCodex(input)
    : { present: dependencies.imageCodex?.present === true, version: dependencies.imageCodex?.version ?? null };

  const assertInContainerEntrypoint = (value: string): string => {
    if (!value.startsWith("/opt/devspace/codex-artifact/") || value.includes("..") || value.includes("\0")
      || path.posix.normalize(value) !== value) {
      throw new HarnessRuntimeError("HARNESS_EXECUTABLE_UNAVAILABLE", "The Codex artifact entrypoint is not inside the workspace container.");
    }
    return value;
  };

  const stageCodexCommand = async (
    input: { projectId: string; workspaceId: string; sessionId: string },
    base: readonly string[], measureAdmissionPhase: HarnessAdmissionPhaseRunner
  ) => {
    if (dependencies.stageNativeCodex === undefined) {
      throw new HarnessRuntimeError("HARNESS_EXECUTABLE_UNAVAILABLE", "Codex is not available in the workspace image or as an Agent artifact.");
    }
    try {
      const staged = await dependencies.stageNativeCodex({ ...input, measureAdmissionPhase });
      return {
        command: [assertInContainerEntrypoint(staged.entrypointPath), ...base.slice(1)],
        executableSource: { kind: "agent-artifact" as const, reportedVersion: staged.reportedVersion }
      };
    } catch (error) {
      if (error instanceof HarnessRuntimeError) throw error;
      throw new HarnessRuntimeError("HARNESS_EXECUTABLE_UNAVAILABLE", "The Agent Codex artifact could not be staged into the workspace container.");
    }
  };

  const reconcileUncertainAdmission = async (input: HarnessAdmissionIdentity): Promise<"started" | "settled"> => {
    const throwUncertain = () => new HarnessRuntimeError(
      "HARNESS_ADMISSION_UNCERTAIN", "The harness admission is not yet safely attachable; retry the same process."
    );
    if (dependencies.reconcileHarnessAdmission === undefined) throw throwUncertain();
    const result = await dependencies.reconcileHarnessAdmission(input);
    const current = await loadSession(input.sessionId);
    if (current.workspaceId !== input.workspaceId || current.processId !== input.processId
      || current.processGeneration !== input.processGeneration) {
      throw new HarnessRuntimeError("RESOURCE_STATE_CONFLICT", "The private harness session no longer matches this admission.");
    }
    if (current.state === "stopped" && current.leaseId === null) return "settled";
    if (current.leaseId !== input.leaseId) {
      throw new HarnessRuntimeError("RESOURCE_STATE_CONFLICT", "The private harness lease no longer matches this admission.");
    }
    if (result === "settled") throw throwUncertain();
    if (result === "running-without-stream") {
      current.state = "lost";
      current.recoveryPending = true;
      await saveSession(input.sessionId, current);
      liveByWorkspace.set(input.workspaceId, input.sessionId);
      throw throwUncertain();
    }
    if (result === "attachable-running" && current.state === "live" && current.admission === "uncertain") {
      current.admission = "started";
      await saveSession(input.sessionId, current);
      liveByWorkspace.set(input.workspaceId, input.sessionId);
      return "started";
    }
    throw throwUncertain();
  };

  return {
    registerCustom(definition: CustomHarnessDefinition): void {
      if (definition.id === CODEX_HARNESS_ID) throw new HarnessRuntimeError("HARNESS_ID_INVALID", "custom id collides with codex");
      customs.set(definition.id, definition);
    },
    async inspect(input: { harnessId: string; workspaceId: string; sessionId?: string }) {
      const definition = definitionOf(input.harnessId);
      let nativeSessionId: string | null = null;
      if (input.sessionId !== undefined) {
        try { nativeSessionId = (await loadSession(input.sessionId)).nativeSessionId; } catch { nativeSessionId = null; }
      }
      if (input.harnessId === CODEX_HARNESS_ID && !uuidV7Schema.safeParse(nativeSessionId).success) nativeSessionId = null;
      return {
        harnessId: input.harnessId,
        capabilities: {
          start: true,
          resume: resumeCapability({ resume: definition.resume, nativeSessionId }),
          pty: true
        }
      };
    },
    async start(input: {
      projectId: string; workspaceId: string; sessionId: string; harnessId: string;
      processId: string; terminalId: string; processGeneration: number;
    }, requestId?: string): Promise<Record<string, string>> {
      const timingContext: HarnessAdmissionTimingContext = {
        operationName: "native-harness.start", sessionId: input.sessionId, workspaceId: input.workspaceId,
        terminalId: input.terminalId, harnessId: input.harnessId, processGeneration: input.processGeneration,
        ...(requestId === undefined ? {} : { requestId })
      };
      let requestedDefinition: ReturnType<typeof definitionOf>;
      try {
        requestedDefinition = definitionOf(input.harnessId);
      } catch (error) {
        return runAdmission(timingContext, async () => {
          await measureAdmissionPhase(timingContext, "runtime-validation", () => Promise.resolve().then(() => { throw error; }));
          return {};
        });
      }
      const existingAdmission = admissionsBySession.get(input.sessionId);
      let trackedAdmission: NonNullable<ReturnType<typeof admissionsBySession.get>>;
      if (existingAdmission !== undefined) {
        assertHarnessInspectionIdentity({
          workspaceId: input.workspaceId, harnessId: input.harnessId, processId: input.processId,
          processGeneration: input.processGeneration
        }, existingAdmission);
        if (existingAdmission.definitionDigest !== authorityDigest(requestedDefinition)) {
          throw new HarnessRuntimeError("HARNESS_DEFINITION_CONFLICT", "The custom harness definition changed during admission.");
        }
        existingAdmission.activeRequests += 1;
        trackedAdmission = existingAdmission;
      } else {
        trackedAdmission = {
          workspaceId: input.workspaceId,
          harnessId: input.harnessId,
          processId: input.processId,
          processGeneration: input.processGeneration,
          definitionDigest: authorityDigest(requestedDefinition),
          activeRequests: 1
        };
        admissionsBySession.set(input.sessionId, trackedAdmission);
      }
      try {
        return await runAdmission(timingContext, async () => {
          const preflight = await measureAdmissionPhase(timingContext, "runtime-validation", async () => {
            const existingEarly = await loadSession(input.sessionId).catch(() => null);
            if (existingEarly !== null && existingEarly.processId === input.processId
              && existingEarly.processGeneration === input.processGeneration && existingEarly.state !== "live") {
              if (existingEarly.state === "lost") throw new HarnessRuntimeError(
                "HARNESS_ADMISSION_UNCERTAIN", "The exact harness process was lost; reconcile its Agent state before completing admission."
              );
              return { kind: "complete" as const };
            }
            if (existingEarly?.recoveryPending === true) {
              throw new HarnessRuntimeError("RESOURCE_STATE_CONFLICT", "A lost harness process is still being recovered.");
            }
            if (existingEarly?.state === "live" && existingEarly.processId === input.processId) {
              if (existingEarly.workspaceId !== input.workspaceId || existingEarly.harnessId !== input.harnessId
                || existingEarly.processGeneration !== input.processGeneration) {
                throw new HarnessRuntimeError("RESOURCE_STATE_CONFLICT", "The retry does not match the live harness generation.");
              }
              liveByWorkspace.set(input.workspaceId, input.sessionId);
              if (existingEarly.admission === "uncertain") {
                await reconcileUncertainAdmission({
                  projectId: input.projectId, workspaceId: input.workspaceId, processId: input.processId,
                  terminalId: input.terminalId, sessionId: input.sessionId,
                  processGeneration: input.processGeneration, leaseId: existingEarly.leaseId
                });
              }
              return { kind: "complete" as const };
            }
            if ((existingEarly !== null && (existingEarly.state === "live" || existingEarly.leaseId !== null))
              || (liveByWorkspace.has(input.workspaceId) && liveByWorkspace.get(input.workspaceId) !== input.sessionId)
              || await workspaceHarnessBusy(input.workspaceId, input.sessionId)) {
              throw new HarnessRuntimeError("RESOURCE_STATE_CONFLICT", "A native harness is already live in this workspace.");
            }
            const definition = requestedDefinition;
            const env: Record<string, string> = {};
            for (const [name, binding] of Object.entries(definition.environment ?? {})) {
              if (binding.kind === "literal") env[name] = binding.value;
            }
            return {
              kind: "admit" as const, previous: existingEarly, definition, env,
              command: [definition.launch.executable, ...definition.launch.args]
            };
          });
          if (preflight.kind === "complete") return {};
          const { previous, definition, env } = preflight;
            let leaseId: string | null = null;
            let command = preflight.command;
            let executableSource: ExecutableSource | null = null;
            const needsDiscoveryBaseline = dedicatedHome(input.harnessId) && (previous === null || previous.nativeSessionId === null);
            const discoveryBaseline = needsDiscoveryBaseline
              ? await measureAdmissionPhase(timingContext, "codex-session-baseline", async () =>
                await codexSessionIdBaseline(dependencies.home.persistentHomePath(CODEX_HARNESS_ID)))
              : undefined;
            try {
              if (dedicatedHome(input.harnessId)) {
                await measureAdmissionPhase(timingContext, "workspace-validation", async () => {
                  let slot = await dependencies.inspectSlot(input.workspaceId);
                  if (slot.state !== "present-and-exact") {
                    if (dependencies.recreateWorkspace === undefined) {
                      throw new HarnessRuntimeError("HARNESS_SLOT_MOUNT_MISSING", "The workspace container does not have the harness slot.");
                    }
                    slot = await dependencies.recreateWorkspace({ workspaceId: input.workspaceId, projectId: input.projectId });
                    if (slot.state !== "present-and-exact") {
                      throw new HarnessRuntimeError("HARNESS_SLOT_MOUNT_MISSING", "The workspace container does not have the harness slot.");
                    }
                  }
                });
                const probed = await probeCodex({
                  ...input, measureAdmissionPhase: (phase, operation) => measureAdmissionPhase(timingContext, phase, operation)
                });
                const stageAfterMaterialize = !probed.present;
                if (probed.present) {
                  executableSource = { kind: "image-path", command: "codex", reportedVersion: probed.version };
                  command = ["codex", ...command.slice(1)];
                } else if (dependencies.stageNativeCodex === undefined) {
                  throw new HarnessRuntimeError("HARNESS_EXECUTABLE_UNAVAILABLE", "Codex is not available in the workspace image or as an Agent artifact.");
                }
                const lease = await measureAdmissionPhase(timingContext, "harness-home-lease", async () =>
                  await dependencies.home.acquireLease({
                    harnessId: input.harnessId, workspaceId: input.workspaceId,
                    aiSessionId: input.sessionId, processGeneration: input.processGeneration
                  }));
                leaseId = lease.leaseId;
                await measureAdmissionPhase(timingContext, "harness-home-materialization", async () =>
                  await dependencies.home.materialize({
                    workspaceId: input.workspaceId, harnessId: input.harnessId, leaseId: lease.leaseId
                  }));
                env.CODEX_HOME = HARNESS_SLOT_ENV;
                if (stageAfterMaterialize) {
                  const staged = await stageCodexCommand(input, command,
                    (phase, operation) => measureAdmissionPhase(timingContext, phase, operation));
                  command = staged.command;
                  executableSource = staged.executableSource;
                }
              }
              const admitted: SessionRecord = {
                workspaceId: input.workspaceId, harnessId: input.harnessId, processId: input.processId,
                nativeSessionId: previous?.nativeSessionId ?? null, executableSource, state: "live", leaseId,
                ...(discoveryBaseline === undefined ? {} : { discoveryBaseline }),
                definitionDigest: authorityDigest(definition),
                processGeneration: input.processGeneration, admission: "uncertain"
              };
              await saveSession(input.sessionId, admitted);
              liveByWorkspace.set(input.workspaceId, input.sessionId);
              await dependencies.createHarnessExec({
                projectId: input.projectId, workspaceId: input.workspaceId,
                processId: input.processId, terminalId: input.terminalId,
                command, environment: env, sessionId: input.sessionId, processGeneration: input.processGeneration, leaseId,
                measureAdmissionPhase: (phase, operation) => measureAdmissionPhase(timingContext, phase, operation)
              });
            } catch (error) {
              if (harnessExecutionAdmissionUncertain(error)) {
                await saveSession(input.sessionId, {
                  workspaceId: input.workspaceId, harnessId: input.harnessId, processId: input.processId,
                  nativeSessionId: previous?.nativeSessionId ?? null, executableSource, state: "live", leaseId,
                  ...(discoveryBaseline === undefined ? {} : { discoveryBaseline }),
                  definitionDigest: authorityDigest(definition),
                  processGeneration: input.processGeneration, admission: "uncertain"
                });
                liveByWorkspace.set(input.workspaceId, input.sessionId);
                throw new HarnessRuntimeError("HARNESS_ADMISSION_UNCERTAIN", "The harness exec may have started; retry the same process.");
              }
              await restoreAfterDefinitePreStartFailure(input.sessionId, input.workspaceId, input.harnessId, leaseId, previous, {
                workspaceId: input.workspaceId, harnessId: input.harnessId, processId: input.processId,
                nativeSessionId: previous?.nativeSessionId ?? null, executableSource, state: "live", leaseId,
                ...(discoveryBaseline === undefined ? {} : { discoveryBaseline }),
                definitionDigest: authorityDigest(definition),
                processGeneration: input.processGeneration, admission: "uncertain"
              });
              throw error;
            }
            const settled = await loadSession(input.sessionId).catch(() => null);
            if (settled?.state === "stopped" || settled?.state === "lost") return env;
            await saveSession(input.sessionId, {
              workspaceId: input.workspaceId, harnessId: input.harnessId, processId: input.processId,
              nativeSessionId: settled?.nativeSessionId ?? previous?.nativeSessionId ?? null, executableSource, state: "live", leaseId,
              ...(settled?.discoveryBaseline === undefined && discoveryBaseline === undefined
                ? {} : { discoveryBaseline: settled?.discoveryBaseline ?? discoveryBaseline! }),
              definitionDigest: authorityDigest(definition),
              processGeneration: input.processGeneration, admission: "started"
            });
            liveByWorkspace.set(input.workspaceId, input.sessionId);
            return env;
          });
      } finally {
        if (admissionsBySession.get(input.sessionId) === trackedAdmission) {
          trackedAdmission.activeRequests -= 1;
          if (trackedAdmission.activeRequests === 0) admissionsBySession.delete(input.sessionId);
        }
      }
    },
    async settleExit(input: { sessionId: string }) {
      const record = await loadSession(input.sessionId);
      if (record.state === "stopped") return;
      await writeBackAndReleaseHome(input.sessionId, record);
      record.state = "stopped";
      record.admission = "started";
      liveByWorkspace.delete(record.workspaceId);
      await saveSession(input.sessionId, record);
    },
    async settleByProcess(processId: string) {
      const { readdir } = await import("node:fs/promises");
      let entries: string[];
      try { entries = await readdir(sessionsRoot); } catch { return; }
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        const sessionId = name.slice(0, -".json".length);
        const record = await loadSession(sessionId);
        if (record.processId !== processId || record.state !== "live") continue;
        await this.settleExit({ sessionId });
        return;
      }
    },
    async resumeExec(input: {
      sessionId: string; projectId: string; processId: string; terminalId: string; processGeneration: number;
      definition?: CustomHarnessDefinition;
    }, requestId?: string) {
      const timingContext: HarnessAdmissionTimingContext = {
        operationName: "native-harness.resume", sessionId: input.sessionId,
        terminalId: input.terminalId, processGeneration: input.processGeneration,
        ...(requestId === undefined ? {} : { requestId })
      };
      return runAdmission(timingContext, async () => {
        const preflight = await measureAdmissionPhase(timingContext, "runtime-validation", async () => {
          const record = await loadSession(input.sessionId);
          if (record.state === "live" && record.processId === input.processId && record.processGeneration === input.processGeneration) {
            liveByWorkspace.set(record.workspaceId, input.sessionId);
            if (record.admission === "uncertain") {
              await reconcileUncertainAdmission({
                projectId: input.projectId, workspaceId: record.workspaceId, processId: input.processId,
                terminalId: input.terminalId, sessionId: input.sessionId,
                processGeneration: input.processGeneration, leaseId: record.leaseId
              });
            }
            return { kind: "complete" as const };
          }
          if (record.processId === input.processId && record.processGeneration === input.processGeneration
            && record.state !== "live") {
            if (record.state === "lost") throw new HarnessRuntimeError(
              "HARNESS_ADMISSION_UNCERTAIN", "The exact harness process was lost; reconcile its Agent state before completing admission."
            );
            return { kind: "complete" as const };
          }
          if (record.recoveryPending === true) {
            throw new HarnessRuntimeError("RESOURCE_STATE_CONFLICT", "A lost harness process is still being recovered.");
          }
          if (input.definition !== undefined) {
            if (input.definition.id !== record.harnessId) {
              throw new HarnessRuntimeError("HARNESS_DEFINITION_CONFLICT", "The harness definition does not match this session.");
            }
            const digest = authorityDigest(input.definition);
            if (record.definitionDigest !== null && digest !== record.definitionDigest) {
              throw new HarnessRuntimeError("HARNESS_DEFINITION_CONFLICT", "The harness definition changed since this session started.");
            }
            customs.set(input.definition.id, input.definition);
          }
          if (input.processGeneration !== record.processGeneration + 1) {
            throw new HarnessRuntimeError("RESOURCE_STATE_CONFLICT", "The harness generation is stale.");
          }
          if (dedicatedHome(record.harnessId) && record.leaseId !== null) {
            throw new HarnessRuntimeError("RESOURCE_STATE_CONFLICT", "The dedicated harness home is still leased to a recovered process.");
          }
          if (record.state === "live" || liveByWorkspace.has(record.workspaceId)) {
            throw new HarnessRuntimeError("RESOURCE_STATE_CONFLICT", "A native harness is already live in this workspace.");
          }
          const definition = definitionOf(record.harnessId);
          const classified = classifyResumeArgv(definition.resume);
          if (classified.kind === "none") throw new HarnessRuntimeError("AI_CAPABILITY_UNSUPPORTED", "Resume is not configured.");
          if (classified.kind === "native-id" && (record.nativeSessionId === null || record.nativeSessionId === undefined)) {
            throw new HarnessRuntimeError("AI_CAPABILITY_UNSUPPORTED", "A native session id is not available.");
          }
          if (dedicatedHome(record.harnessId) && classified.kind === "native-id"
            && !uuidV7Schema.safeParse(record.nativeSessionId).success) {
            throw new HarnessRuntimeError("AI_CAPABILITY_UNSUPPORTED", "A canonical Codex conversation id is not available.");
          }
          const command = classified.kind === "provider-handled"
            ? [definition.resume!.executable, ...definition.resume!.args]
            : (() => {
              const substituted = substituteResumeArgv(definition.resume!, record.nativeSessionId!);
              return [substituted.executable, ...substituted.args];
            })();
          return { kind: "resume" as const, record, definition, command };
        });
        if (preflight.kind === "complete") return { command: [], env: {} };
        const { record, definition } = preflight;
        const phaseContext: HarnessAdmissionTimingContext = {
          ...timingContext, workspaceId: record.workspaceId, harnessId: record.harnessId
        };
        let command = preflight.command;
        const env: Record<string, string> = {};
        let leaseId: string | null = null;
        let executableSource = record.executableSource;
        try {
          if (dedicatedHome(record.harnessId)) {
            await measureAdmissionPhase(phaseContext, "workspace-validation", async () => {
              let slot = await dependencies.inspectSlot(record.workspaceId);
              if (slot.state !== "present-and-exact") {
                if (dependencies.recreateWorkspace === undefined) {
                  throw new HarnessRuntimeError("HARNESS_SLOT_MOUNT_MISSING", "The workspace container does not have the harness slot.");
                }
                slot = await dependencies.recreateWorkspace({ workspaceId: record.workspaceId, projectId: input.projectId });
                if (slot.state !== "present-and-exact") {
                  throw new HarnessRuntimeError("HARNESS_SLOT_MOUNT_MISSING", "The workspace container does not have the harness slot.");
                }
              }
            });
            const probed = await probeCodex({
              projectId: input.projectId, workspaceId: record.workspaceId,
              measureAdmissionPhase: (phase, operation) => measureAdmissionPhase(phaseContext, phase, operation)
            });
            const stageAfterMaterialize = !probed.present;
            if (probed.present) {
              executableSource = { kind: "image-path", command: "codex", reportedVersion: probed.version };
              command = ["codex", ...command.slice(1)];
            } else if (dependencies.stageNativeCodex === undefined) {
              throw new HarnessRuntimeError("HARNESS_EXECUTABLE_UNAVAILABLE", "Codex is not available.");
            }
            const lease = await measureAdmissionPhase(phaseContext, "harness-home-lease", async () =>
              await dependencies.home.acquireLease({
                harnessId: record.harnessId, workspaceId: record.workspaceId,
                aiSessionId: input.sessionId, processGeneration: input.processGeneration
              }));
            leaseId = lease.leaseId;
            await measureAdmissionPhase(phaseContext, "harness-home-materialization", async () =>
              await dependencies.home.materialize({
                workspaceId: record.workspaceId, harnessId: record.harnessId, leaseId: lease.leaseId
              }));
            env.CODEX_HOME = HARNESS_SLOT_ENV;
            if (stageAfterMaterialize) {
              const staged = await stageCodexCommand(
                { projectId: input.projectId, workspaceId: record.workspaceId, sessionId: input.sessionId }, command,
                (phase, operation) => measureAdmissionPhase(phaseContext, phase, operation));
              command = staged.command;
              executableSource = staged.executableSource;
            }
          }
          const admitted: SessionRecord = {
            ...record, processId: input.processId, executableSource, state: "live", leaseId,
            processGeneration: input.processGeneration, admission: "uncertain",
            definitionDigest: record.definitionDigest ?? authorityDigest(definition)
          };
          await saveSession(input.sessionId, admitted);
          liveByWorkspace.set(record.workspaceId, input.sessionId);
          await dependencies.createHarnessExec({
            projectId: input.projectId, workspaceId: record.workspaceId,
            processId: input.processId, terminalId: input.terminalId,
            command, environment: env, sessionId: input.sessionId, processGeneration: input.processGeneration, leaseId,
            measureAdmissionPhase: (phase, operation) => measureAdmissionPhase(phaseContext, phase, operation)
          });
        } catch (error) {
          if (harnessExecutionAdmissionUncertain(error)) {
            await saveSession(input.sessionId, {
              ...record, processId: input.processId, executableSource, state: "live", leaseId,
              processGeneration: input.processGeneration, admission: "uncertain"
            });
            liveByWorkspace.set(record.workspaceId, input.sessionId);
            throw new HarnessRuntimeError("HARNESS_ADMISSION_UNCERTAIN", "The harness exec may have started; retry the same process.");
          }
          await restoreAfterDefinitePreStartFailure(input.sessionId, record.workspaceId, record.harnessId, leaseId, record, {
            ...record, processId: input.processId, executableSource, state: "live", leaseId,
            processGeneration: input.processGeneration, admission: "uncertain"
          });
          throw error;
        }
        const settled = await loadSession(input.sessionId);
        if (settled.state === "stopped" || settled.state === "lost") return { command, env };
        await saveSession(input.sessionId, {
          ...settled, processId: input.processId, executableSource, state: "live", leaseId,
          processGeneration: input.processGeneration, admission: "started",
          definitionDigest: settled.definitionDigest ?? authorityDigest(definition)
        });
        liveByWorkspace.set(record.workspaceId, input.sessionId);
        return { command, env };
      });
    },
    async capability(sessionId: string, definition?: CustomHarnessDefinition, identity?: HarnessInspectionIdentity) {
      const trackedAdmission = admissionsBySession.get(sessionId);
      if (trackedAdmission !== undefined) {
        if (identity !== undefined) assertHarnessInspectionIdentity(identity, trackedAdmission);
        if (definition !== undefined) {
          if (definition.id !== trackedAdmission.harnessId || authorityDigest(definition) !== trackedAdmission.definitionDigest) {
            return { state: "admitting", processGeneration: trackedAdmission.processGeneration, resume: false };
          }
          customs.set(definition.id, definition);
        }
        return { state: "admitting", processGeneration: trackedAdmission.processGeneration, resume: false };
      }
      const record = await loadSession(sessionId);
      if (identity !== undefined) assertHarnessInspectionIdentity(identity, record);
      if (definition !== undefined) {
        if (definition.id !== record.harnessId || (record.definitionDigest !== null && authorityDigest(definition) !== record.definitionDigest)) {
          return { state: record.state, processGeneration: record.processGeneration, resume: false };
        }
        customs.set(definition.id, definition);
      }
      let resume: boolean;
      try {
        const nativeSessionId = record.harnessId === CODEX_HARNESS_ID
          && !uuidV7Schema.safeParse(record.nativeSessionId).success ? null : record.nativeSessionId;
        resume = record.state !== "live" && record.leaseId === null && record.recoveryPending !== true && resumeCapability({
          resume: definitionOf(record.harnessId).resume,
          nativeSessionId
        });
      } catch {
        resume = false;
      }
      return {
        state: record.state,
        processGeneration: record.processGeneration,
        resume,
        ...(record.state === "live" ? { admission: record.admission } : {})
      };
    },
    async finalizeRecoveredLoss(identity: HarnessRecoveryIdentity) {
      return exclusive(async () => await finalizeRecoveredLoss(identity));
    },
    async assertWorkspaceQuiescent(workspaceId: string) {
      if (liveByWorkspace.has(workspaceId)) {
        throw new HarnessRuntimeError("HARNESS_ADMISSION_UNCERTAIN", "A live AI execution still owns this workspace.");
      }
      let entries: string[];
      try { entries = await readdir(sessionsRoot); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
        else throw error;
      }
      for (const name of entries) {
        if (!name.endsWith(".json")) throw new HarnessRuntimeError("HARNESS_ADMISSION_UNCERTAIN", "AI session ownership state is not exact.");
        const record = await loadSession(name.slice(0, -".json".length));
        if (record.workspaceId === workspaceId
          && (record.state === "live" || record.leaseId !== null || record.recoveryPending === true)) {
          throw new HarnessRuntimeError("HARNESS_ADMISSION_UNCERTAIN", "An AI session or private-home lease is still active for this workspace.");
        }
      }
      if (await dependencies.home.hasActiveWorkspaceLease?.(workspaceId) === true) {
        throw new HarnessRuntimeError("HARNESS_ADMISSION_UNCERTAIN", "A private-home lease or dirty persistent slot is still active for this workspace.");
      }
    },
    async recoverAfterAgentRestart() {
      return exclusive(async () => {
        const reports = dependencies.observeHarnessRecovery?.() ?? [];
        const { readdir } = await import("node:fs/promises");
        let entries: string[];
        try { entries = await readdir(sessionsRoot); } catch { entries = []; }
        for (const name of entries) {
          if (!name.endsWith(".json")) continue;
          const sessionId = name.slice(0, -".json".length);
          const record = await loadSession(sessionId);
          if (record.state !== "live" && !(record.state === "lost" && record.leaseId !== null)
            && record.recoveryPending !== true) continue;
          const matching = reports.filter((item) => item.processId === record.processId && item.workspaceId === record.workspaceId
            && item.sessionId === sessionId && item.processGeneration === record.processGeneration && item.leaseId === record.leaseId);
          record.state = "lost";
          if (record.leaseId !== null || record.recoveryPending === true
            || matching.some((item) => item.observation === "running" || item.observation === "unproven")) {
            liveByWorkspace.set(record.workspaceId, sessionId);
          }
          if (matching.some((item) => item.observation === "running" || item.observation === "unproven")) {
            record.recoveryPending = true;
          }
          await saveSession(sessionId, record);
          if (matching.length !== 1) continue;
          const report = matching[0]!;
          if (report.observation === "running" || report.observation === "unproven") continue;
          await finalizeRecoveredLoss({
            processId: report.processId,
            workspaceId: report.workspaceId,
            sessionId,
            processGeneration: report.processGeneration!,
            leaseId: report.leaseId
          });
        }
        return [];
      });
    },
    privateNativeId: async (sessionId: string) => (await loadSession(sessionId)).nativeSessionId,
    publicSnapshot: async (sessionId: string) => {
      const record = await loadSession(sessionId);
      return { state: record.state, harnessId: record.harnessId, executableSource: record.executableSource };
    }
  };
}
