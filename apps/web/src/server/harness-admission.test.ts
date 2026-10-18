/* eslint-disable @typescript-eslint/require-await -- Agent doubles return immediately. */
import BetterSqlite3 from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgentResponseError, AgentUnavailableError, type FullAgentClient } from "./agent-client.js";
import { openProjectDatabase, ProjectSetupConflictError } from "./database.js";
import {
  createNativeHarnessSession, listProjectedHarnessSessions, resumeNativeHarnessSession, retryNativeHarnessSession
} from "./harness-sessions.js";
import { saveCustomHarnessDefinition } from "./harness-definitions.js";
import { mutatePrimaryWorkspaceRuntime } from "./workspace-runtime.js";
import { workspaceInspectionDataSchema } from "@devspace/contracts";
import { canonicalizeProjectOptionsV1, compileRuntimePlanV1, hashProjectOptionsV1, hashRuntimePlanV1, parseProjectOptionsV1 } from "@devspace/project-options";

const directories: string[] = [];
const databases: Array<ReturnType<typeof openProjectDatabase>> = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

async function createReadyProject() {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-harness-admission-"));
  directories.push(directory);
  const databasePath = path.join(directory, "devspace.sqlite");
  const database = openProjectDatabase(databasePath);
  databases.push(database);
  const project = database.createProject({ name: "Workbench", slug: `workbench-${directories.length}`, repositoryUrl: "https://example.com/workbench.git", defaultBranch: "main", actor: "actor" });
  const revisionId = "018f0f00-0000-7000-8000-000000000002";
  const workspaceId = "018f0f00-0000-7000-8000-000000000003";
  const stackId = "018f0f00-0000-7000-8000-000000000004";
  const serviceId = "018f0f00-0000-7000-8000-000000000005";
  const timestamp = "2026-07-19T00:00:00.000Z";
  const hash = `sha256-jcs-v1:${"a".repeat(64)}`;
  const raw = new BetterSqlite3(databasePath);
  raw.pragma("foreign_keys = ON");
  raw.prepare(`insert into project_config_revisions
    (id, project_id, revision_number, schema_version, configuration_json, configuration_hash, source, state, created_by, created_at, activated_at)
    values (?, ?, 1, 1, '{"schemaVersion":1,"developmentEnvironment":{"source":{"kind":"image","imageReference":"node:24"}}}', ?, 'user', 'active', 'actor', ?, ?)`)
    .run(revisionId, project.id, hash, timestamp, timestamp);
  raw.prepare(`insert into workspaces
    (id, project_id, config_revision_id, kind, name, slug, branch_name, base_ref, worktree_path, desired_state, observed_state, dirty_state, created_at, updated_at)
    values (?, ?, ?, 'primary', 'Primary', 'primary', 'main', 'main', ?, 'running', 'running', 'clean', ?, ?)`)
    .run(workspaceId, project.id, revisionId, `/workspaces/${workspaceId}`, timestamp, timestamp);
  raw.prepare(`insert into runtime_stacks
    (id, workspace_id, runtime_namespace, runtime_plan_hash, desired_state, observed_state, runtime_generation, created_at, updated_at)
    values (?, ?, 'workbench-primary', ?, 'running', 'running', 1, ?, ?)`)
    .run(stackId, workspaceId, hash, timestamp, timestamp);
  raw.prepare(`insert into workspace_services
    (id, runtime_stack_id, service_key, kind, image_reference, desired_state, observed_state, health_state, started_at)
    values (?, ?, 'development', 'development', 'node:24-bookworm', 'running', 'running', 'healthy', ?)`)
    .run(serviceId, stackId, timestamp);
  raw.prepare("update projects set active_config_revision_id = ?, primary_workspace_id = ?, state = 'ready' where id = ?")
    .run(revisionId, workspaceId, project.id);
  raw.close();
  return { database, project, databasePath, workspaceId };
}

test("a lost agent response retries the same creating harness and a definite rejection does not", async () => {
  const fixture = await createReadyProject();
  const calls: Array<{ processId: string; processGeneration: number }> = [];
  let failFirst = true;
  const agent = {
    startNativeHarness: async (data: { processId: string; processGeneration: number; sessionId: string }) => {
      calls.push({ processId: data.processId, processGeneration: data.processGeneration });
      if (failFirst) {
        failFirst = false;
        throw new AgentUnavailableError();
      }
      return { settled: false };
    }
  } as unknown as FullAgentClient;
  await expect(createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", { database: fixture.database, agent }))
    .rejects.toBeInstanceOf(AgentUnavailableError);
  const creating = fixture.database.listNativeHarnessSessions(fixture.workspaceId);
  expect(creating).toHaveLength(1);
  expect(creating[0]).toMatchObject({ state: "creating", processGeneration: 1 });
  const started = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", { database: fixture.database, agent });
  expect(started.sessionId).toBe(creating[0]!.id);
  expect(started.terminalId).toBe(creating[0]!.terminalSessionId);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)).toHaveLength(1);
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "active", processGeneration: 1 });

  const rejected = {
    startNativeHarness: async () => {
      throw new AgentResponseError("HARNESS_EXECUTABLE_UNAVAILABLE", "Codex is not available.", false);
    }
  } as unknown as FullAgentClient;
  const other = await createReadyProject();
  await expect(createNativeHarnessSession(other.project.id, "actor", other.workspaceId, "codex", { database: other.database, agent: rejected }))
    .rejects.toBeInstanceOf(AgentResponseError);
  expect(other.database.listNativeHarnessSessions(other.workspaceId)[0]).toMatchObject({ state: "failed" });
  const again = await createNativeHarnessSession(other.project.id, "actor", other.workspaceId, "codex", {
    database: other.database,
    agent: { startNativeHarness: async () => ({ settled: false }) } as unknown as FullAgentClient
  });
  expect(again.sessionId).not.toBe(other.database.listNativeHarnessSessions(other.workspaceId).find((row) => row.state === "failed")?.id);
});

test("Agent inspection projects admission progress and a matching started generation", async () => {
  const fixture = await createReadyProject();
  const inspectionCalls: Array<Record<string, unknown>> = [];
  const agent = {
    startNativeHarness: async () => { throw new AgentUnavailableError(); },
    inspectNativeHarness: async (input: Record<string, unknown>) => {
      inspectionCalls.push(input);
      return { state: "admitting" as const, processGeneration: 1, resume: false };
    }
  } as unknown as FullAgentClient;

  await expect(createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", {
    database: fixture.database, agent
  })).rejects.toBeInstanceOf(AgentUnavailableError);
  const creating = fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]!;
  const duringAdmission = await listProjectedHarnessSessions(fixture.workspaceId, { database: fixture.database, agent });

  expect(inspectionCalls[0]).toMatchObject({
    sessionId: creating.id, workspaceId: fixture.workspaceId, harnessId: "codex",
    processId: creating.processId, processGeneration: 1
  });
  expect(duringAdmission[0]).toMatchObject({ id: creating.id, state: "creating", admissionStatus: "admitting", resume: false });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "creating" });

  const admittedAgent = {
    inspectNativeHarness: async (input: Record<string, unknown>) => ({
      state: "live" as const, processGeneration: input.processGeneration as number, admission: "started" as const, resume: false
    })
  } as unknown as Pick<FullAgentClient, "inspectNativeHarness">;
  const admitted = await listProjectedHarnessSessions(fixture.workspaceId, { database: fixture.database, agent: admittedAgent });
  expect(admitted[0]).toMatchObject({ id: creating.id, state: "active", admissionStatus: "admitted" });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "active" });
});

test("uncertain Agent admission stays creating and does not activate its terminal", async () => {
  const fixture = await createReadyProject();
  const agent = {
    startNativeHarness: async () => { throw new AgentUnavailableError(); },
    inspectNativeHarness: async (input: Record<string, unknown>) => ({
      state: "live" as const, processGeneration: input.processGeneration as number, admission: "uncertain" as const, resume: false
    })
  } as unknown as FullAgentClient;
  await expect(createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", {
    database: fixture.database, agent
  })).rejects.toBeInstanceOf(AgentUnavailableError);

  const projected = await listProjectedHarnessSessions(fixture.workspaceId, { database: fixture.database, agent });
  expect(projected[0]).toMatchObject({ state: "creating", admissionStatus: "uncertain", resume: false });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "creating" });
});

test("retrying a native admission is bound to the existing session, terminal, and generation", async () => {
  const fixture = await createReadyProject();
  const calls: Array<Record<string, unknown>> = [];
  const agent = {
    startNativeHarness: async (input: Record<string, unknown>) => {
      calls.push(input);
      if (calls.length === 1) throw new AgentUnavailableError();
      return { settled: false };
    }
  } as unknown as FullAgentClient;
  await expect(createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", {
    database: fixture.database, agent
  })).rejects.toBeInstanceOf(AgentUnavailableError);
  const existing = fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]!;

  const retried = await retryNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, existing.id, existing.processGeneration, {
    database: fixture.database, agent
  });

  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(retried).toMatchObject({ sessionId: existing.id, terminalId: existing.terminalSessionId, workspaceId: fixture.workspaceId });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)).toHaveLength(1);
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({
    id: existing.id, state: "active", processGeneration: 1, terminalSessionId: existing.terminalSessionId
  });
  await expect(retryNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, existing.id, 2, {
    database: fixture.database, agent
  })).rejects.toBeInstanceOf(ProjectSetupConflictError);
  await expect(retryNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId,
    "018f0f00-0000-7000-8000-000000000099", 1, { database: fixture.database, agent }))
    .rejects.toBeInstanceOf(ProjectSetupConflictError);
  expect(calls).toHaveLength(2);
});

test("an uncertain lost PTY admission stays creating until Agent projection marks it lost", async () => {
  const fixture = await createReadyProject();
  let starts = 0;
  const agent = {
    startNativeHarness: async () => {
      starts += 1;
      throw new AgentResponseError("HARNESS_ADMISSION_UNCERTAIN", "The harness PTY is not attachable yet.", true);
    },
    inspectNativeHarness: async () => ({ state: "lost", processGeneration: 1, resume: false })
  } as unknown as FullAgentClient;

  await expect(createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", {
    database: fixture.database, agent
  })).rejects.toMatchObject({ code: "HARNESS_ADMISSION_UNCERTAIN" });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)).toMatchObject([
    { state: "creating", processGeneration: 1 }
  ]);

  const projected = await listProjectedHarnessSessions(fixture.workspaceId, { database: fixture.database, agent });
  expect(projected).toMatchObject([{ state: "lost", resume: false }]);
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)).toMatchObject([
    { state: "lost", processGeneration: 1 }
  ]);
  expect(starts).toBe(1);
});

test("a same-generation retry that Agent reports settled leaves the Web row stopped", async () => {
  const fixture = await createReadyProject();
  const calls: Array<{ sessionId: string; processId: string; terminalId: string; processGeneration: number }> = [];
  let uncertain = true;
  const agent = {
    startNativeHarness: async (input: { sessionId: string; processId: string; terminalId: string; processGeneration: number }) => {
      calls.push(input);
      if (uncertain) {
        uncertain = false;
        throw new AgentResponseError("HARNESS_ADMISSION_UNCERTAIN", "The exact exec has not settled yet.", true);
      }
      return { settled: true };
    }
  } as unknown as FullAgentClient;

  await expect(createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", {
    database: fixture.database, agent
  })).rejects.toMatchObject({ code: "HARNESS_ADMISSION_UNCERTAIN" });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)).toMatchObject([
    { state: "creating", processGeneration: 1 }
  ]);

  const retried = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", {
    database: fixture.database, agent
  });
  expect(retried.sessionId).toBe(calls[0]!.sessionId);
  expect(calls[1]).toEqual(calls[0]);
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)).toMatchObject([
    { id: retried.sessionId, state: "stopped", processGeneration: 1 }
  ]);
});

test("resume generation increments once per admitted resume and rolls back a definite rejection", async () => {
  const fixture = await createReadyProject();
  const generations: number[] = [];
  let agentState: "live" | "stopped" = "stopped";
  let agentGeneration = 1;
  const agent = {
    startNativeHarness: async () => ({ settled: false }),
    inspectNativeHarness: async () => ({ state: agentState, processGeneration: agentGeneration, resume: agentState === "stopped" }),
    resumeNativeHarness: async (data: { processGeneration: number; definition?: { id: string } }) => {
      generations.push(data.processGeneration);
      if (data.definition?.id === "my-agent") return { settled: false };
      if (generations.length === 1) throw new AgentResponseError("HARNESS_DEFINITION_CONFLICT", "changed", false);
      agentState = "live";
      agentGeneration = data.processGeneration;
      return { settled: false };
    }
  } as unknown as FullAgentClient;
  const started = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", { database: fixture.database, agent });
  fixture.database.completeNativeHarnessAdmission(started.sessionId);
  await expect(resumeNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, started.sessionId, { database: fixture.database, agent }))
    .rejects.toBeInstanceOf(AgentResponseError);
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "stopped", processGeneration: 1 });
  await resumeNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, started.sessionId, { database: fixture.database, agent });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "active", processGeneration: 2 });
  fixture.database.completeNativeHarnessAdmission(started.sessionId);
  agentState = "stopped";
  await resumeNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, started.sessionId, { database: fixture.database, agent });
  expect(generations).toEqual([2, 2, 3]);
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]?.processGeneration).toBe(3);
});

test("a lost resume response keeps the claimed generation for the retry", async () => {
  const fixture = await createReadyProject();
  const generations: number[] = [];
  let fail = true;
  let agentState: "live" | "stopped" = "stopped";
  let agentGeneration = 1;
  const agent = {
    startNativeHarness: async () => ({ settled: false }),
    inspectNativeHarness: async () => ({ state: agentState, processGeneration: agentGeneration, resume: agentState === "stopped" }),
    resumeNativeHarness: async (data: { processGeneration: number; processId: string }) => {
      generations.push(data.processGeneration);
      if (fail) {
        fail = false;
        agentState = "live";
        agentGeneration = data.processGeneration;
        throw new AgentUnavailableError();
      }
      return { settled: false };
    }
  } as unknown as FullAgentClient;
  const started = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", { database: fixture.database, agent });
  fixture.database.completeNativeHarnessAdmission(started.sessionId);
  await expect(resumeNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, started.sessionId, { database: fixture.database, agent }))
    .rejects.toBeInstanceOf(AgentUnavailableError);
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "creating", processGeneration: 2 });
  await resumeNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, started.sessionId, { database: fixture.database, agent });
  expect(generations).toEqual([2, 2]);
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "active", processGeneration: 2 });
});

test("custom resume fails closed when the definition is gone and still sends it when present", async () => {
  const fixture = await createReadyProject();
  saveCustomHarnessDefinition(fixture.database, {
    id: "my-agent", displayName: "Mine", origin: "custom",
    launch: { executable: "my-agent", args: [] },
    resume: { executable: "my-agent", args: ["--resume"] },
    environment: {}, privateState: { kind: "none" }
  });
  const seen: unknown[] = [];
  const agent = {
    startNativeHarness: async () => ({ settled: false }),
    inspectNativeHarness: async () => ({ state: "stopped", processGeneration: 1, resume: true }),
    resumeNativeHarness: async (data: { definition?: unknown; processGeneration: number }) => {
      seen.push(data.definition);
      return { settled: false };
    }
  } as unknown as FullAgentClient;
  const started = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "my-agent", { database: fixture.database, agent });
  fixture.database.completeNativeHarnessAdmission(started.sessionId);
  const raw = new BetterSqlite3(fixture.databasePath);
  raw.prepare("delete from harness_definitions where id = ?").run("my-agent");
  raw.close();
  await expect(resumeNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, started.sessionId, { database: fixture.database, agent }))
    .rejects.toThrow(/definition was not found/u);
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "stopped", processGeneration: 1 });
  saveCustomHarnessDefinition(fixture.database, {
    id: "my-agent", displayName: "Mine", origin: "custom",
    launch: { executable: "my-agent", args: [] },
    resume: { executable: "my-agent", args: ["--resume"] },
    environment: {}, privateState: { kind: "none" }
  });
  await resumeNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, started.sessionId, { database: fixture.database, agent });
  expect(seen[0]).toMatchObject({ id: "my-agent", resume: { executable: "my-agent", args: ["--resume"] } });
  expect(JSON.stringify(seen[0])).not.toContain("nativeSessionId");
});

test("native terminal snapshot projects stopped and lost without touching structured sessions", async () => {
  const fixture = await createReadyProject();
  const agent = { startNativeHarness: async () => ({ settled: false }) } as unknown as FullAgentClient;
  const native = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", { database: fixture.database, agent });
  fixture.database.applyExecutionSnapshot({
    agentBootId: "018f0f00-0000-7000-8000-000000000099",
    throughCursor: "v1.018f0f00-0000-7000-8000-000000000099.1",
    resources: [{ type: "terminal", identity: { projectId: fixture.project.id, workspaceId: fixture.workspaceId, terminalId: native.terminalId }, state: "closed" }],
    operationObservations: []
  });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "stopped" });

  const restarted = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", { database: fixture.database, agent });
  fixture.database.applyExecutionSnapshot({
    agentBootId: "018f0f00-0000-7000-8000-000000000099",
    throughCursor: "v1.018f0f00-0000-7000-8000-000000000099.2",
    resources: [{ type: "terminal", identity: { projectId: fixture.project.id, workspaceId: fixture.workspaceId, terminalId: restarted.terminalId }, state: "lost" }],
    operationObservations: []
  });
  const structuredId = "018f0f00-0000-7000-8000-0000000000aa";
  const raw = new BetterSqlite3(fixture.databasePath);
  raw.prepare(`insert into ai_sessions (
      id, workspace_id, provider_key, profile_key, profile_revision, revision_id, runtime_plan_hash,
      runtime_generation, process_generation, last_sequence, history_start_sequence, history_truncated,
      interaction_history_truncated, runtime_kind, title, state, created_at, updated_at
    ) values (?, ?, 'codex', 'codex', ?, '018f0f00-0000-7000-8000-000000000002', ?, 1, 1, 0, 1, 0, 0, 'structured', 'Codex session', 'creating', ?, ?)`).run(
    structuredId, fixture.workspaceId, `sha256-ai-profile-v1:${"0".repeat(64)}`, `sha256-jcs-v1:${"a".repeat(64)}`,
    "2026-07-19T00:00:00.000Z", "2026-07-19T00:00:00.000Z"
  );
  raw.close();
  fixture.database.applyExecutionSnapshot({
    agentBootId: "018f0f00-0000-7000-8000-000000000099",
    throughCursor: "v1.018f0f00-0000-7000-8000-000000000099.3",
    resources: [{ type: "terminal", identity: { projectId: fixture.project.id, workspaceId: fixture.workspaceId, terminalId: restarted.terminalId }, state: "lost" }],
    operationObservations: []
  });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId).find((row) => row.id === restarted.sessionId)).toMatchObject({ state: "lost" });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId).find((row) => row.id === native.sessionId)).toMatchObject({ state: "stopped" });
  expect(fixture.database.getAiSession(fixture.project.id, fixture.workspaceId, structuredId)?.session.state).toBe("creating");
});

test("lost native session exposes Resume only after Agent recovery capability becomes available", async () => {
  const fixture = await createReadyProject();
  const agent = { startNativeHarness: async () => ({ settled: false }) } as unknown as FullAgentClient;
  const started = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", { database: fixture.database, agent });
  fixture.database.applyExecutionSnapshot({
    agentBootId: "018f0f00-0000-7000-8000-000000000099",
    throughCursor: "v1.018f0f00-0000-7000-8000-000000000099.1",
    resources: [{ type: "terminal", identity: { projectId: fixture.project.id, workspaceId: fixture.workspaceId, terminalId: started.terminalId }, state: "lost" }],
    operationObservations: []
  });

  let canResume = false;
  const projected = await listProjectedHarnessSessions(fixture.workspaceId, {
    database: fixture.database,
    agent: { inspectNativeHarness: async () => ({ state: "lost", processGeneration: 1, resume: canResume }) } as unknown as Pick<FullAgentClient, "inspectNativeHarness">
  });
  expect(projected[0]).toMatchObject({ id: started.sessionId, state: "lost", resume: false });

  canResume = true;
  const finalized = await listProjectedHarnessSessions(fixture.workspaceId, {
    database: fixture.database,
    agent: { inspectNativeHarness: async () => ({ state: "lost", processGeneration: 1, resume: canResume }) } as unknown as Pick<FullAgentClient, "inspectNativeHarness">
  });
  expect(finalized[0]).toMatchObject({ id: started.sessionId, state: "lost", resume: true });
});

test("an authoritative lost inspection reconciles stale active state before direct Resume", async () => {
  const fixture = await createReadyProject();
  const privateNativeId = "provider-native-session-private";
  const resumeCalls: Array<{ sessionId: string; processGeneration: number }> = [];
  const agent = {
    startNativeHarness: async () => ({ settled: false }),
    inspectNativeHarness: async () => ({
      state: "lost", processGeneration: 1, resume: true, nativeSessionId: privateNativeId
    }),
    resumeNativeHarness: async (input: { sessionId: string; processGeneration: number }) => {
      resumeCalls.push(input);
      return { settled: false };
    }
  } as unknown as FullAgentClient;
  const started = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", {
    database: fixture.database, agent
  });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "active", processGeneration: 1 });

  const projected = await listProjectedHarnessSessions(fixture.workspaceId, { database: fixture.database, agent });
  expect(projected[0]).toMatchObject({ id: started.sessionId, state: "lost", resume: true });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "lost", processGeneration: 1 });
  expect(JSON.stringify(projected)).not.toContain(privateNativeId);

  const resumed = await resumeNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, started.sessionId, {
    database: fixture.database, agent
  });
  expect(resumed.sessionId).toBe(started.sessionId);
  expect(resumeCalls).toHaveLength(1);
  expect(resumeCalls[0]).toMatchObject({ sessionId: started.sessionId, processGeneration: 2 });
  expect(JSON.stringify(resumeCalls)).not.toContain(privateNativeId);
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "active", processGeneration: 2 });
});

test("direct Resume reconciles stale active state before claiming its next generation", async () => {
  const fixture = await createReadyProject();
  const resumeCalls: Array<{ sessionId: string; processGeneration: number }> = [];
  const inspectNativeHarness = vi.fn(async () => ({ state: "lost" as const, processGeneration: 1, resume: true }));
  const agent = {
    startNativeHarness: async () => ({ settled: false }),
    inspectNativeHarness,
    resumeNativeHarness: async (input: { sessionId: string; processGeneration: number }) => {
      resumeCalls.push(input);
      return { settled: false };
    }
  } as unknown as FullAgentClient;
  const started = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", {
    database: fixture.database, agent
  });

  await resumeNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, started.sessionId, {
    database: fixture.database, agent
  });

  expect(inspectNativeHarness).toHaveBeenCalledOnce();
  expect(resumeCalls).toHaveLength(1);
  expect(resumeCalls[0]).toMatchObject({ sessionId: started.sessionId, processGeneration: 2 });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "active", processGeneration: 2 });
});

test.each([
  ["stopped", "stopped", true, "closed"],
  ["lost", "lost", true, "lost"],
  ["live", "active", false, "active"]
] as const)("Agent %s observation reconciles active generation 1 to %s", async (agentState, expectedState, resume, expectedTerminalState) => {
  const fixture = await createReadyProject();
  const agent = {
    startNativeHarness: async () => ({ settled: false }),
    inspectNativeHarness: async () => ({ state: agentState, processGeneration: 1, resume })
  } as unknown as FullAgentClient;
  const started = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", {
    database: fixture.database, agent
  });

  const projected = await listProjectedHarnessSessions(fixture.workspaceId, { database: fixture.database, agent });

  expect(projected[0]).toMatchObject({ id: started.sessionId, state: expectedState, resume });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: expectedState, processGeneration: 1 });
  const raw = new BetterSqlite3(fixture.databasePath);
  const terminal = raw.prepare("select state from terminal_sessions where id = ?").get(started.terminalId) as { state: string } | undefined;
  raw.close();
  expect(terminal?.state).toBe(expectedTerminalState);
});

test("a live Agent observation does not resurrect a lost native session", async () => {
  const fixture = await createReadyProject();
  const initialAgent = { startNativeHarness: async () => ({ settled: false }) } as unknown as FullAgentClient;
  const started = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", {
    database: fixture.database, agent: initialAgent
  });
  fixture.database.applyExecutionSnapshot({
    agentBootId: "018f0f00-0000-7000-8000-000000000099",
    throughCursor: "v1.018f0f00-0000-7000-8000-000000000099.1",
    resources: [{ type: "terminal", identity: { projectId: fixture.project.id, workspaceId: fixture.workspaceId, terminalId: started.terminalId }, state: "lost" }],
    operationObservations: []
  });
  const agent = {
    inspectNativeHarness: async () => ({ state: "live", processGeneration: 1, resume: false })
  } as unknown as Pick<FullAgentClient, "inspectNativeHarness">;

  const projected = await listProjectedHarnessSessions(fixture.workspaceId, { database: fixture.database, agent });

  expect(projected[0]).toMatchObject({ id: started.sessionId, state: "lost", resume: false });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "lost", processGeneration: 1 });
});

test("an older Agent generation cannot overwrite or resume a newer SQLite generation", async () => {
  const fixture = await createReadyProject();
  const started = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", {
    database: fixture.database,
    agent: { startNativeHarness: async () => ({ settled: false }) } as unknown as FullAgentClient
  });
  fixture.database.applyExecutionSnapshot({
    agentBootId: "018f0f00-0000-7000-8000-000000000099",
    throughCursor: "v1.018f0f00-0000-7000-8000-000000000099.1",
    resources: [{ type: "terminal", identity: { projectId: fixture.project.id, workspaceId: fixture.workspaceId, terminalId: started.terminalId }, state: "lost" }],
    operationObservations: []
  });
  expect(fixture.database.claimHarnessResumeGeneration(started.sessionId, 1)).toBe(2);
  fixture.database.activateNativeHarnessSession(started.sessionId);
  const resumeHarness = vi.fn(async () => ({ settled: false }));
  const agent = {
    inspectNativeHarness: async () => ({ state: "lost", processGeneration: 1, resume: true }),
    resumeNativeHarness: resumeHarness
  } as unknown as FullAgentClient;

  const projected = await listProjectedHarnessSessions(fixture.workspaceId, { database: fixture.database, agent });
  await expect(resumeNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, started.sessionId, {
    database: fixture.database, agent
  })).rejects.toBeInstanceOf(ProjectSetupConflictError);

  expect(projected[0]).toMatchObject({ id: started.sessionId, state: "active", resume: false });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "active", processGeneration: 2 });
  expect(resumeHarness).not.toHaveBeenCalled();
});

test("Agent inspection failure preserves SQLite state and fails Resume closed", async () => {
  const fixture = await createReadyProject();
  const started = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", {
    database: fixture.database,
    agent: { startNativeHarness: async () => ({ settled: false }) } as unknown as FullAgentClient
  });
  const resumeHarness = vi.fn(async () => ({ settled: false }));
  const agent = {
    inspectNativeHarness: async () => { throw new AgentUnavailableError(); },
    resumeNativeHarness: resumeHarness
  } as unknown as FullAgentClient;

  const projected = await listProjectedHarnessSessions(fixture.workspaceId, { database: fixture.database, agent });
  await expect(resumeNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, started.sessionId, {
    database: fixture.database, agent
  })).rejects.toBeInstanceOf(ProjectSetupConflictError);

  expect(projected[0]).toMatchObject({ id: started.sessionId, state: "active", resume: false });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "active", processGeneration: 1 });
  expect(resumeHarness).not.toHaveBeenCalled();
});

test("native harness lifecycle integration preserves one session across settle, orphan recovery, workspace restart, and resume", async () => {
  const fixture = await createReadyProject();
  const parsedOptions = parseProjectOptionsV1({
    schemaVersion: 1, developmentEnvironment: { source: { kind: "image", imageReference: "node:24" } }
  });
  const canonicalOptions = canonicalizeProjectOptionsV1(parsedOptions);
  const validConfigHash = hashProjectOptionsV1(parsedOptions);
  const runtimePlanHash = hashRuntimePlanV1(compileRuntimePlanV1(parsedOptions));
  const rawFixture = new BetterSqlite3(fixture.databasePath);
  rawFixture.prepare("update project_config_revisions set configuration_json = ?, configuration_hash = ? where project_id = ?")
    .run(canonicalOptions, validConfigHash, fixture.project.id);
  rawFixture.prepare("update runtime_stacks set runtime_plan_hash = ? where workspace_id = ?")
    .run(runtimePlanHash, fixture.workspaceId);
  rawFixture.close();
  type ScriptedHarness = {
    state: "live" | "stopped" | "lost";
    processGeneration: number;
    processId: string;
    terminalId: string;
    leaseId: string | null;
    dirty: boolean;
    resume: boolean;
  };
  const harnesses = new Map<string, ScriptedHarness>();
  const observations = new Map<string, { operationId: string; state: "succeeded"; updatedAt: string; failure: null }>();
  const resumeCalls: Array<{ sessionId: string; processId: string; terminalId: string; processGeneration: number }> = [];
  let runtimeState: "running" | "stopped" = "running";
  const completeOperation = (operationId: string) => observations.set(operationId, {
    operationId, state: "succeeded", updatedAt: "2026-07-19T00:00:00.000Z", failure: null
  });
  const agent = {
    startNativeHarness: async (input: { sessionId: string; processId: string; terminalId: string; processGeneration: number }) => {
      harnesses.set(input.sessionId, {
        state: "live", processGeneration: input.processGeneration, processId: input.processId,
        terminalId: input.terminalId, leaseId: `lease-${input.sessionId}-${input.processGeneration}`,
        dirty: true, resume: false
      });
      return { settled: false };
    },
    inspectNativeHarness: async (input: { sessionId: string }) => {
      const harness = harnesses.get(input.sessionId);
      if (harness === undefined) throw new Error("unknown-test-harness");
      return { state: harness.state, processGeneration: harness.processGeneration, resume: harness.resume };
    },
    resumeNativeHarness: async (input: { sessionId: string; processId: string; terminalId: string; processGeneration: number }) => {
      const harness = harnesses.get(input.sessionId);
      if (harness === undefined) throw new Error("unknown-test-harness");
      harness.state = "live";
      harness.processGeneration = input.processGeneration;
      harness.processId = input.processId;
      harness.terminalId = input.terminalId;
      harness.leaseId = `lease-${input.sessionId}-${input.processGeneration}`;
      harness.dirty = true;
      harness.resume = false;
      resumeCalls.push(input);
      return { settled: false };
    },
    registerRuntimePlan: async (operationId: string) => { completeOperation(operationId); },
    startWorkspace: async (operationId: string) => { runtimeState = "running"; completeOperation(operationId); },
    stopWorkspace: async (operationId: string) => {
      runtimeState = "stopped";
      completeOperation(operationId);
    },
    snapshot: async () => ({
      agentBootId: "018f0f00-0000-7000-8000-000000000099",
      throughCursor: "v1.018f0f00-0000-7000-8000-000000000099.1" as const,
      resources: [], operationObservations: [...observations.values()]
    }),
    runtimeStatus: async () => ({ rootlessRuntime: "available" as const, operationJournal: "available" as const, checkedAt: "2026-07-19T00:00:00.000Z" }),
    inspectWorkspace: async (projectId: string, workspaceId: string) => {
      const context = fixture.database.getRuntimeContext(projectId);
      return workspaceInspectionDataSchema.parse({
        projectId, workspaceId, kind: "primary", revisionId: context.revision.id,
        revisionHash: context.revision.configurationHash,
        desiredState: runtimeState, observedState: runtimeState, dirty: false,
        runtimeStack: { desiredState: runtimeState, observedState: runtimeState }
      });
    }
  } as unknown as FullAgentClient;

  const target = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", {
    database: fixture.database, agent
  });
  const targetAgent = harnesses.get(target.sessionId)!;
  expect(targetAgent.state).toBe("live");
  expect(targetAgent.processGeneration).toBe(1);
  expect(targetAgent.leaseId).not.toBeNull();
  expect(targetAgent.dirty).toBe(true);
  expect(targetAgent.resume).toBe(false);

  // The foreground generation exited cleanly; Agent observation is authoritative over the active Web row.
  targetAgent.state = "stopped";
  targetAgent.leaseId = null;
  targetAgent.dirty = false;
  targetAgent.resume = true;
  expect(await listProjectedHarnessSessions(fixture.workspaceId, { database: fixture.database, agent })).toEqual([
    expect.objectContaining({ id: target.sessionId, state: "stopped", resume: true })
  ]);
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId).find((row) => row.id === target.sessionId))
    .toMatchObject({ state: "stopped", processGeneration: 1 });

  const older = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", {
    database: fixture.database, agent
  });
  const olderAgent = harnesses.get(older.sessionId)!;
  olderAgent.state = "stopped";
  olderAgent.leaseId = null;
  olderAgent.dirty = false;
  olderAgent.resume = true;
  expect(await listProjectedHarnessSessions(fixture.workspaceId, { database: fixture.database, agent })).toHaveLength(2);

  const secondGeneration = await resumeNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, target.sessionId, {
    database: fixture.database, agent
  });
  expect(secondGeneration.sessionId).toBe(target.sessionId);
  expect(secondGeneration.terminalId).not.toBe(target.terminalId);
  expect(resumeCalls).toEqual([expect.objectContaining({ sessionId: target.sessionId, processGeneration: 2 })]);
  expect(targetAgent.state).toBe("live");
  expect(targetAgent.processGeneration).toBe(2);
  expect(targetAgent.leaseId).not.toBeNull();
  expect(targetAgent.dirty).toBe(true);
  expect(targetAgent.resume).toBe(false);
  expect(await listProjectedHarnessSessions(fixture.workspaceId, { database: fixture.database, agent }))
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: target.sessionId, state: "active", resume: false }), expect.objectContaining({ id: older.sessionId })]));

  // Simulate Agent loss while the exact admitted generation remains an orphan in its private home.
  targetAgent.state = "lost";
  expect(await listProjectedHarnessSessions(fixture.workspaceId, { database: fixture.database, agent }))
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: target.sessionId, state: "lost", resume: false })]));
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId).find((row) => row.id === target.sessionId))
    .toMatchObject({ state: "lost", processGeneration: 2 });
  expect(targetAgent.leaseId).not.toBeNull();
  expect(targetAgent.dirty).toBe(true);
  expect(targetAgent.resume).toBe(false);
  await expect(resumeNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, target.sessionId, {
    database: fixture.database, agent
  })).rejects.toBeInstanceOf(ProjectSetupConflictError);
  expect(resumeCalls).toHaveLength(1);

  const runtimeDependencies = {
    database: fixture.database, agent: agent as never, orchestrationTimeoutMs: 2_000,
    nowMonotonic: () => 1, sleep: async () => undefined
  };
  await mutatePrimaryWorkspaceRuntime("stop", fixture.project.id, "actor", runtimeDependencies);
  expect(runtimeState).toBe("stopped");
  // Script the exact Agent post-stop finalization observation at this external boundary.
  targetAgent.leaseId = null;
  targetAgent.dirty = false;
  targetAgent.resume = true;
  expect(targetAgent).toMatchObject({ state: "lost", leaseId: null, dirty: false, resume: true });
  expect(await listProjectedHarnessSessions(fixture.workspaceId, { database: fixture.database, agent }))
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: target.sessionId, state: "lost", resume: true })]));

  await mutatePrimaryWorkspaceRuntime("start", fixture.project.id, "actor", runtimeDependencies);
  expect(runtimeState).toBe("running");
  const thirdGeneration = await resumeNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, target.sessionId, {
    database: fixture.database, agent
  });
  expect(thirdGeneration.sessionId).toBe(target.sessionId);
  expect(thirdGeneration.terminalId).not.toBe(secondGeneration.terminalId);
  expect(resumeCalls.map((call) => [call.sessionId, call.processGeneration])).toEqual([
    [target.sessionId, 2], [target.sessionId, 3]
  ]);
  expect(targetAgent.state).toBe("live");
  expect(targetAgent.processGeneration).toBe(3);
  expect(targetAgent.leaseId).not.toBeNull();
  expect(targetAgent.dirty).toBe(true);
  expect(targetAgent.resume).toBe(false);

  targetAgent.state = "stopped";
  targetAgent.leaseId = null;
  targetAgent.dirty = false;
  targetAgent.resume = true;
  await listProjectedHarnessSessions(fixture.workspaceId, { database: fixture.database, agent });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId).find((row) => row.id === target.sessionId))
    .toMatchObject({ id: target.sessionId, state: "stopped", processGeneration: 3, terminalSessionId: thirdGeneration.terminalId });
  expect(targetAgent).toMatchObject({ state: "stopped", leaseId: null, dirty: false, resume: true });
});

test("harness inspection reconciliation ignores structured sessions", async () => {
  const fixture = await createReadyProject();
  const raw = new BetterSqlite3(fixture.databasePath);
  const structuredId = "018f0f00-0000-7000-8000-0000000000aa";
  raw.prepare(`insert into ai_sessions (
      id, workspace_id, provider_key, profile_key, profile_revision, revision_id, runtime_plan_hash,
      runtime_generation, process_generation, last_sequence, history_start_sequence, history_truncated,
      interaction_history_truncated, runtime_kind, title, state, created_at, updated_at
    ) values (?, ?, 'codex', 'codex', ?, '018f0f00-0000-7000-8000-000000000002', ?, 1, 1, 0, 1, 0, 0, 'structured', 'Codex session', 'creating', ?, ?)`).run(
    structuredId, fixture.workspaceId, `sha256-ai-profile-v1:${"0".repeat(64)}`, `sha256-jcs-v1:${"a".repeat(64)}`,
    "2026-07-19T00:00:00.000Z", "2026-07-19T00:00:00.000Z"
  );
  raw.close();

  fixture.database.reconcileNativeHarnessObservation({ sessionId: structuredId, expectedGeneration: 1, agentState: "lost" });

  expect(fixture.database.getAiSession(fixture.project.id, fixture.workspaceId, structuredId)?.session.state).toBe("creating");
});

test("execution snapshots and Agent inspection converge idempotently on lost", async () => {
  const fixture = await createReadyProject();
  const agent = { startNativeHarness: async () => ({ settled: false }) } as unknown as FullAgentClient;
  const snapshot = (terminalId: string, cursor: number) => fixture.database.applyExecutionSnapshot({
    agentBootId: "018f0f00-0000-7000-8000-000000000099",
    throughCursor: `v1.018f0f00-0000-7000-8000-000000000099.${cursor}`,
    resources: [{ type: "terminal", identity: { projectId: fixture.project.id, workspaceId: fixture.workspaceId, terminalId }, state: "lost" }],
    operationObservations: []
  });

  const snapshotFirst = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", { database: fixture.database, agent });
  snapshot(snapshotFirst.terminalId, 1);
  fixture.database.reconcileNativeHarnessObservation({ sessionId: snapshotFirst.sessionId, expectedGeneration: 1, agentState: "lost" });
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId).find((row) => row.id === snapshotFirst.sessionId)).toMatchObject({ state: "lost" });

  const inspectFirst = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", { database: fixture.database, agent });
  fixture.database.reconcileNativeHarnessObservation({ sessionId: inspectFirst.sessionId, expectedGeneration: 1, agentState: "lost" });
  snapshot(inspectFirst.terminalId, 2);
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId).find((row) => row.id === inspectFirst.sessionId)).toMatchObject({ state: "lost" });
});

test("native resume generation claims are fenced to the inspected generation", async () => {
  const fixture = await createReadyProject();
  const started = await createNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, "codex", {
    database: fixture.database,
    agent: { startNativeHarness: async () => ({ settled: false }) } as unknown as FullAgentClient
  });
  fixture.database.applyExecutionSnapshot({
    agentBootId: "018f0f00-0000-7000-8000-000000000099",
    throughCursor: "v1.018f0f00-0000-7000-8000-000000000099.1",
    resources: [{ type: "terminal", identity: { projectId: fixture.project.id, workspaceId: fixture.workspaceId, terminalId: started.terminalId }, state: "lost" }],
    operationObservations: []
  });
  expect(fixture.database.claimHarnessResumeGeneration(started.sessionId, 1)).toBe(2);
  fixture.database.applyExecutionSnapshot({
    agentBootId: "018f0f00-0000-7000-8000-000000000099",
    throughCursor: "v1.018f0f00-0000-7000-8000-000000000099.2",
    resources: [{ type: "terminal", identity: { projectId: fixture.project.id, workspaceId: fixture.workspaceId, terminalId: started.terminalId }, state: "lost" }],
    operationObservations: []
  });

  expect(() => fixture.database.claimHarnessResumeGeneration(started.sessionId, 1)).toThrow(ProjectSetupConflictError);
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]).toMatchObject({ state: "lost", processGeneration: 2 });
});
