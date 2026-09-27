import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  harnessExecutionAdmissionUncertain,
  type HarnessRecoveryIdentity,
  type HarnessRecoveryReport
} from "./execution-manager.js";
import {
  classifyResumeArgv,
  resumeCapability,
  substituteResumeArgv,
  type HarnessArgv
} from "@devspace/contracts";
import { durableJsonWriter, readStrictJson } from "./private-state.js";
import { discoverCodexNativeSessionId } from "./harness-codex-discovery.js";
import type { ExecutableSource } from "./harness-executable.js";
import { CODEX_HARNESS_ID, CODEX_PRESET, HARNESS_SLOT_ENV } from "./harness-presets.js";
import type { HarnessHomeStore } from "./harness-home.js";
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

type SessionRecord = {
  workspaceId: string;
  harnessId: string;
  processId: string;
  nativeSessionId: string | null;
  executableSource: ExecutableSource | null;
  state: "live" | "stopped" | "lost";
  leaseId: string | null;
  recoveryPhase?: "ready-to-release";
  definitionDigest: string | null;
  processGeneration: number;
  admission: "started" | "uncertain";
};

const sessionRecordSchema = z.strictObject({
  workspaceId: z.string(),
  harnessId: z.string(),
  processId: z.string(),
  nativeSessionId: z.string().nullable(),
  executableSource: z.unknown().nullable(),
  state: z.enum(["live", "stopped", "lost"]),
  leaseId: z.string().nullable(),
  recoveryPhase: z.literal("ready-to-release").optional(),
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
  }) => Promise<void>;
  readonly observeHarnessRecovery?: () => readonly HarnessRecoveryReport[];
  readonly inspectSlot: (workspaceId: string) => Promise<HarnessSlotMountObservation>;
  readonly recreateWorkspace?: (input: { workspaceId: string; projectId: string }) => Promise<HarnessSlotMountObservation>;
  readonly imageCodex?: { present: boolean; version: string | null };
  readonly probeImageCodex?: (input: { projectId: string; workspaceId: string }) => Promise<{ present: boolean; version: string | null }>;
  readonly artifact?: { available: boolean; version: string | null; command: readonly string[] };
  readonly stageNativeCodex?: (input: { projectId: string; workspaceId: string }) => Promise<{
    entrypointPath: string; reportedVersion: string | null;
  }>;
  readonly now?: () => Date;
}

export function createHarnessRuntime(dependencies: HarnessRuntimeDependencies) {
  const customs = new Map<string, CustomHarnessDefinition>();
  const sessionsRoot = path.join(path.resolve(dependencies.stateRoot), "harness-sessions");
  const liveByWorkspace = new Map<string, string>();

  const sessionPath = (sessionId: string) => path.join(sessionsRoot, `${sessionId}.json`);

  const loadSession = async (sessionId: string): Promise<SessionRecord> => {
    return sessionRecordSchema.parse(await readStrictJson(sessionPath(sessionId), sessionRecordSchema)) as SessionRecord;
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
      if (candidate?.workspaceId === workspaceId && (candidate.state === "live" || candidate.leaseId !== null)) return true;
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
        record.nativeSessionId = await discoverCodexNativeSessionId(dependencies.home.persistentHomePath(CODEX_HARNESS_ID));
      }
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
    liveByWorkspace.delete(record.workspaceId);
    await saveSession(identity.sessionId, record);
  };

  const probeCodex = async (input: { projectId: string; workspaceId: string }) => dependencies.probeImageCodex !== undefined
    ? await dependencies.probeImageCodex(input)
    : { present: dependencies.imageCodex?.present === true, version: dependencies.imageCodex?.version ?? null };

  const assertInContainerEntrypoint = (value: string): string => {
    if (!value.startsWith("/opt/devspace/codex-artifact/") || value.includes("..") || value.includes("\0")
      || path.posix.normalize(value) !== value) {
      throw new HarnessRuntimeError("HARNESS_EXECUTABLE_UNAVAILABLE", "The Codex artifact entrypoint is not inside the workspace container.");
    }
    return value;
  };

  const stageCodexCommand = async (input: { projectId: string; workspaceId: string }, base: readonly string[]) => {
    if (dependencies.stageNativeCodex === undefined) {
      throw new HarnessRuntimeError("HARNESS_EXECUTABLE_UNAVAILABLE", "Codex is not available in the workspace image or as an Agent artifact.");
    }
    try {
      const staged = await dependencies.stageNativeCodex(input);
      return {
        command: [assertInContainerEntrypoint(staged.entrypointPath), ...base.slice(1)],
        executableSource: { kind: "agent-artifact" as const, reportedVersion: staged.reportedVersion }
      };
    } catch (error) {
      if (error instanceof HarnessRuntimeError) throw error;
      throw new HarnessRuntimeError("HARNESS_EXECUTABLE_UNAVAILABLE", "The Agent Codex artifact could not be staged into the workspace container.");
    }
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
    }) {
      return exclusive(async () => {
        const existingEarly = await loadSession(input.sessionId).catch(() => null);
        if (existingEarly?.state === "live" && existingEarly.processId === input.processId) {
          liveByWorkspace.set(input.workspaceId, input.sessionId);
          return {};
        }
        if ((existingEarly !== null && (existingEarly.state === "live" || existingEarly.leaseId !== null))
          || (liveByWorkspace.has(input.workspaceId) && liveByWorkspace.get(input.workspaceId) !== input.sessionId)
          || await workspaceHarnessBusy(input.workspaceId, input.sessionId)) {
          throw new HarnessRuntimeError("RESOURCE_STATE_CONFLICT", "A native harness is already live in this workspace.");
        }
        const definition = definitionOf(input.harnessId);
        const env: Record<string, string> = {};
        for (const [name, binding] of Object.entries(definition.environment ?? {})) {
          if (binding.kind === "literal") env[name] = binding.value;
        }
        let leaseId: string | null = null;
        let command = [definition.launch.executable, ...definition.launch.args];
        let executableSource: ExecutableSource | null = null;
        const previous = existingEarly;
        try {
          if (dedicatedHome(input.harnessId)) {
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
            const probed = await probeCodex(input);
            const stageAfterMaterialize = !probed.present;
            if (probed.present) {
              executableSource = { kind: "image-path", command: "codex", reportedVersion: probed.version };
              command = ["codex", ...command.slice(1)];
            } else if (dependencies.stageNativeCodex === undefined) {
              throw new HarnessRuntimeError("HARNESS_EXECUTABLE_UNAVAILABLE", "Codex is not available in the workspace image or as an Agent artifact.");
            }
            const lease = await dependencies.home.acquireLease({
              harnessId: input.harnessId, workspaceId: input.workspaceId,
              aiSessionId: input.sessionId, processGeneration: input.processGeneration
            });
            leaseId = lease.leaseId;
            await dependencies.home.materialize({
              workspaceId: input.workspaceId, harnessId: input.harnessId, leaseId: lease.leaseId
            });
            env.CODEX_HOME = HARNESS_SLOT_ENV;
            if (stageAfterMaterialize) {
              const staged = await stageCodexCommand(input, command);
              command = staged.command;
              executableSource = staged.executableSource;
            }
          }
          const admitted: SessionRecord = {
            workspaceId: input.workspaceId, harnessId: input.harnessId, processId: input.processId,
            nativeSessionId: previous?.nativeSessionId ?? null, executableSource, state: "live", leaseId,
            definitionDigest: authorityDigest(definition),
            processGeneration: input.processGeneration, admission: "uncertain"
          };
          await saveSession(input.sessionId, admitted);
          liveByWorkspace.set(input.workspaceId, input.sessionId);
          await dependencies.createHarnessExec({
            projectId: input.projectId, workspaceId: input.workspaceId,
            processId: input.processId, terminalId: input.terminalId,
            command, environment: env, sessionId: input.sessionId, processGeneration: input.processGeneration, leaseId
          });
        } catch (error) {
          if (harnessExecutionAdmissionUncertain(error)) {
            await saveSession(input.sessionId, {
              workspaceId: input.workspaceId, harnessId: input.harnessId, processId: input.processId,
              nativeSessionId: previous?.nativeSessionId ?? null, executableSource, state: "live", leaseId,
              definitionDigest: authorityDigest(definition),
              processGeneration: input.processGeneration, admission: "uncertain"
            });
            liveByWorkspace.set(input.workspaceId, input.sessionId);
            throw new HarnessRuntimeError("HARNESS_ADMISSION_UNCERTAIN", "The harness exec may have started; retry the same process.");
          }
          await restoreAfterDefinitePreStartFailure(input.sessionId, input.workspaceId, input.harnessId, leaseId, previous, {
            workspaceId: input.workspaceId, harnessId: input.harnessId, processId: input.processId,
            nativeSessionId: previous?.nativeSessionId ?? null, executableSource, state: "live", leaseId,
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
          definitionDigest: authorityDigest(definition),
          processGeneration: input.processGeneration, admission: "started"
        });
        liveByWorkspace.set(input.workspaceId, input.sessionId);
        return env;
      });
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
    }) {
      return exclusive(async () => {
        const record = await loadSession(input.sessionId);
        if (record.state === "live" && record.processId === input.processId && record.processGeneration === input.processGeneration) {
          liveByWorkspace.set(record.workspaceId, input.sessionId);
          return { command: [], env: {} };
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
        let command: string[];
        if (classified.kind === "provider-handled") command = [definition.resume!.executable, ...definition.resume!.args];
        else {
          const substituted = substituteResumeArgv(definition.resume!, record.nativeSessionId!);
          command = [substituted.executable, ...substituted.args];
        }
        const env: Record<string, string> = {};
        let leaseId: string | null = null;
        let executableSource = record.executableSource;
        try {
          if (dedicatedHome(record.harnessId)) {
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
            const probed = await probeCodex({ projectId: input.projectId, workspaceId: record.workspaceId });
            const stageAfterMaterialize = !probed.present;
            if (probed.present) {
              executableSource = { kind: "image-path", command: "codex", reportedVersion: probed.version };
              command = ["codex", ...command.slice(1)];
            } else if (dependencies.stageNativeCodex === undefined) {
              throw new HarnessRuntimeError("HARNESS_EXECUTABLE_UNAVAILABLE", "Codex is not available.");
            }
            const lease = await dependencies.home.acquireLease({
              harnessId: record.harnessId, workspaceId: record.workspaceId,
              aiSessionId: input.sessionId, processGeneration: input.processGeneration
            });
            leaseId = lease.leaseId;
            await dependencies.home.materialize({
              workspaceId: record.workspaceId, harnessId: record.harnessId, leaseId: lease.leaseId
            });
            env.CODEX_HOME = HARNESS_SLOT_ENV;
            if (stageAfterMaterialize) {
              const staged = await stageCodexCommand({ projectId: input.projectId, workspaceId: record.workspaceId }, command);
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
            command, environment: env, sessionId: input.sessionId, processGeneration: input.processGeneration, leaseId
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
    async capability(sessionId: string, definition?: CustomHarnessDefinition) {
      const record = await loadSession(sessionId);
      if (definition !== undefined) {
        if (definition.id !== record.harnessId || (record.definitionDigest !== null && authorityDigest(definition) !== record.definitionDigest)) {
          return { state: record.state, processGeneration: record.processGeneration, resume: false };
        }
        customs.set(definition.id, definition);
      }
      let resume: boolean;
      try {
        resume = record.state !== "live" && record.leaseId === null && resumeCapability({
          resume: definitionOf(record.harnessId).resume,
          nativeSessionId: record.nativeSessionId
        });
      } catch {
        resume = false;
      }
      return { state: record.state, processGeneration: record.processGeneration, resume };
    },
    async finalizeRecoveredLoss(identity: HarnessRecoveryIdentity) {
      return exclusive(async () => await finalizeRecoveredLoss(identity));
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
          if (record.state !== "live" && !(record.state === "lost" && record.leaseId !== null)) continue;
          const matching = reports.filter((item) => item.processId === record.processId && item.workspaceId === record.workspaceId
            && item.sessionId === sessionId && item.processGeneration === record.processGeneration && item.leaseId === record.leaseId);
          record.state = "lost";
          if (record.leaseId !== null || matching.some((item) => item.observation === "running" || item.observation === "unproven")) {
            liveByWorkspace.set(record.workspaceId, sessionId);
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
