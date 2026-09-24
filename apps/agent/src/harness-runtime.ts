import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  classifyResumeArgv,
  resumeCapability,
  substituteResumeArgv,
  type HarnessArgv
} from "@devspace/contracts";
import { durableJsonWriter, readStrictJson } from "./private-state.js";
import { discoverCodexNativeSessionId } from "./harness-codex-discovery.js";
import { resolveCodexExecutable, type ExecutableSource } from "./harness-executable.js";
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

type SessionRecord = {
  workspaceId: string;
  harnessId: string;
  processId: string;
  nativeSessionId: string | null;
  executableSource: ExecutableSource | null;
  state: "live" | "stopped" | "lost";
  leaseId: string | null;
};

const sessionRecordSchema = z.strictObject({
  workspaceId: z.string(),
  harnessId: z.string(),
  processId: z.string(),
  nativeSessionId: z.string().nullable(),
  executableSource: z.unknown().nullable(),
  state: z.enum(["live", "stopped", "lost"]),
  leaseId: z.string().nullable()
});

export interface HarnessRuntimeDependencies {
  readonly home: HarnessHomeStore;
  readonly stateRoot: string;
  readonly createHarnessExec: (input: {
    projectId: string; workspaceId: string; processId: string; terminalId: string;
    command: readonly string[]; environment: Readonly<Record<string, string>>;
  }) => Promise<void>;
  readonly inspectSlot: (workspaceId: string) => Promise<HarnessSlotMountObservation>;
  readonly recreateWorkspace?: (input: { workspaceId: string; projectId: string }) => Promise<HarnessSlotMountObservation>;
  readonly imageCodex?: { present: boolean; version: string | null };
  readonly artifact?: { available: boolean; version: string | null; command: readonly string[] };
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

  const definitionOf = (harnessId: string) => {
    if (harnessId === CODEX_HARNESS_ID) return { ...CODEX_PRESET, origin: "builtin" as const, environment: {} as Record<string, { kind: "literal"; value: string }> };
    const custom = customs.get(harnessId);
    if (custom === undefined) throw new HarnessRuntimeError("RESOURCE_NOT_FOUND", "The harness definition was not found.");
    return custom;
  };

  const dedicatedHome = (harnessId: string) => harnessId === CODEX_HARNESS_ID;

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
      if (liveByWorkspace.has(input.workspaceId)) {
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
        const image = dependencies.imageCodex ?? { present: false, version: null };
        const artifact = dependencies.artifact ?? { available: false, version: null, command: ["codex"] };
        const resolved = resolveCodexExecutable({
          imageHasCodex: image.present, imageReportedVersion: image.version,
          artifactAvailable: artifact.available, artifactReportedVersion: artifact.version
        });
        if (resolved.kind === "unavailable") {
          throw new HarnessRuntimeError("HARNESS_EXECUTABLE_UNAVAILABLE", "Codex is not available in the workspace image or as an Agent artifact.");
        }
        executableSource = resolved;
        command = resolved.kind === "agent-artifact" ? [...artifact.command] : ["codex"];
        const lease = await dependencies.home.acquireLease({
          harnessId: input.harnessId, workspaceId: input.workspaceId,
          aiSessionId: input.sessionId, processGeneration: input.processGeneration
        });
        leaseId = lease.leaseId;
        await dependencies.home.materialize({
          workspaceId: input.workspaceId, harnessId: input.harnessId, leaseId: lease.leaseId
        });
        env.CODEX_HOME = HARNESS_SLOT_ENV;
      }
      await dependencies.createHarnessExec({
        projectId: input.projectId, workspaceId: input.workspaceId,
        processId: input.processId, terminalId: input.terminalId,
        command, environment: env
      });
      liveByWorkspace.set(input.workspaceId, input.sessionId);
      await saveSession(input.sessionId, {
        workspaceId: input.workspaceId, harnessId: input.harnessId, processId: input.processId,
        nativeSessionId: null, executableSource, state: "live", leaseId
      });
      return env;
    },
    async settleExit(input: { sessionId: string }) {
      const record = await loadSession(input.sessionId);
      if (record.leaseId !== null) {
        await dependencies.home.writeBackAndClear({ workspaceId: record.workspaceId, leaseId: record.leaseId });
        if (record.harnessId === CODEX_HARNESS_ID) {
          record.nativeSessionId = await discoverCodexNativeSessionId(dependencies.home.persistentHomePath(CODEX_HARNESS_ID));
        }
        await dependencies.home.releaseLease({ harnessId: record.harnessId, leaseId: record.leaseId });
        record.leaseId = null;
      }
      record.state = "stopped";
      liveByWorkspace.delete(record.workspaceId);
      await saveSession(input.sessionId, record);
    },
    async resume(input: { sessionId: string; projectId: string; processId: string; terminalId: string; processGeneration: number }) {
      const record = await loadSession(input.sessionId);
      const definition = definitionOf(record.harnessId);
      const classified = classifyResumeArgv(definition.resume);
      if (classified.kind === "none") throw new HarnessRuntimeError("AI_CAPABILITY_UNSUPPORTED", "Resume is not configured.");
      if (classified.kind === "native-id" && record.nativeSessionId === null) {
        throw new HarnessRuntimeError("AI_CAPABILITY_UNSUPPORTED", "A native session id is not available.");
      }
      if (liveByWorkspace.has(record.workspaceId)) {
        throw new HarnessRuntimeError("RESOURCE_STATE_CONFLICT", "A native harness is already live in this workspace.");
      }
      let command: string[];
      if (classified.kind === "provider-handled") {
        command = [definition.resume!.executable, ...definition.resume!.args];
      } else {
        const substituted = substituteResumeArgv(definition.resume!, record.nativeSessionId!);
        command = [substituted.executable, ...substituted.args];
      }
      return this.start({
        projectId: input.projectId, workspaceId: record.workspaceId, sessionId: input.sessionId,
        harnessId: record.harnessId, processId: input.processId, terminalId: input.terminalId,
        processGeneration: input.processGeneration
      }).then(async (env) => {
        if (classified.kind === "native-id" || classified.kind === "provider-handled") {
          // start() launched launch argv; replace by issuing resume command instead.
        }
        return { env, command };
      });
    },
    async resumeExec(input: {
      sessionId: string; projectId: string; processId: string; terminalId: string; processGeneration: number;
    }) {
      const record = await loadSession(input.sessionId);
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
      if (liveByWorkspace.has(record.workspaceId)) {
        throw new HarnessRuntimeError("RESOURCE_STATE_CONFLICT", "A native harness is already live in this workspace.");
      }
      const env: Record<string, string> = {};
      let leaseId: string | null = null;
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
        const lease = await dependencies.home.acquireLease({
          harnessId: record.harnessId, workspaceId: record.workspaceId,
          aiSessionId: input.sessionId, processGeneration: input.processGeneration
        });
        leaseId = lease.leaseId;
        await dependencies.home.materialize({
          workspaceId: record.workspaceId, harnessId: record.harnessId, leaseId: lease.leaseId
        });
        env.CODEX_HOME = HARNESS_SLOT_ENV;
        const image = dependencies.imageCodex ?? { present: false, version: null };
        const artifact = dependencies.artifact ?? { available: false, version: null, command: ["codex"] };
        const resolved = resolveCodexExecutable({
          imageHasCodex: image.present, imageReportedVersion: image.version,
          artifactAvailable: artifact.available, artifactReportedVersion: artifact.version
        });
        if (resolved.kind === "unavailable") {
          throw new HarnessRuntimeError("HARNESS_EXECUTABLE_UNAVAILABLE", "Codex is not available.");
        }
        if (resolved.kind === "agent-artifact") command = [...artifact.command, ...command.slice(1)];
      }
      await dependencies.createHarnessExec({
        projectId: input.projectId, workspaceId: record.workspaceId,
        processId: input.processId, terminalId: input.terminalId,
        command, environment: env
      });
      liveByWorkspace.set(record.workspaceId, input.sessionId);
      await saveSession(input.sessionId, { ...record, processId: input.processId, state: "live", leaseId });
      return { command, env };
    },
    async recoverAfterAgentRestart() {
      const recovered = await dependencies.home.recoverDirtySlots();
      const { readdir } = await import("node:fs/promises");
      let entries: string[] = [];
      try { entries = await readdir(sessionsRoot); } catch { entries = []; }
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        const sessionId = name.slice(0, -".json".length);
        const record = await loadSession(sessionId);
        if (record.state !== "live") continue;
        if (record.harnessId === CODEX_HARNESS_ID) {
          record.nativeSessionId = await discoverCodexNativeSessionId(dependencies.home.persistentHomePath(CODEX_HARNESS_ID));
        }
        record.state = "lost";
        record.leaseId = null;
        liveByWorkspace.delete(record.workspaceId);
        await saveSession(sessionId, record);
      }
      await dependencies.home.reapStaleLeases();
      return recovered;
    },
    privateNativeId: async (sessionId: string) => (await loadSession(sessionId)).nativeSessionId,
    publicSnapshot: async (sessionId: string) => {
      const record = await loadSession(sessionId);
      return { state: record.state, harnessId: record.harnessId, executableSource: record.executableSource };
    }
  };
}
