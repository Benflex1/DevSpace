/* eslint-disable @typescript-eslint/require-await -- Agent doubles return immediately. */
import BetterSqlite3 from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { AgentResponseError, AgentUnavailableError, type FullAgentClient } from "./agent-client.js";
import { openProjectDatabase } from "./database.js";
import { createNativeHarnessSession, resumeNativeHarnessSession } from "./harness-sessions.js";
import { saveCustomHarnessDefinition } from "./harness-definitions.js";

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

test("resume generation increments once per admitted resume and rolls back a definite rejection", async () => {
  const fixture = await createReadyProject();
  const generations: number[] = [];
  const agent = {
    startNativeHarness: async () => ({ settled: false }),
    resumeNativeHarness: async (data: { processGeneration: number; definition?: { id: string } }) => {
      generations.push(data.processGeneration);
      if (data.definition?.id === "my-agent") return { settled: false };
      if (generations.length === 1) throw new AgentResponseError("HARNESS_DEFINITION_CONFLICT", "changed", false);
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
  await resumeNativeHarnessSession(fixture.project.id, "actor", fixture.workspaceId, started.sessionId, { database: fixture.database, agent });
  expect(generations).toEqual([2, 2, 3]);
  expect(fixture.database.listNativeHarnessSessions(fixture.workspaceId)[0]?.processGeneration).toBe(3);
});

test("a lost resume response keeps the claimed generation for the retry", async () => {
  const fixture = await createReadyProject();
  const generations: number[] = [];
  let fail = true;
  const agent = {
    startNativeHarness: async () => ({ settled: false }),
    resumeNativeHarness: async (data: { processGeneration: number; processId: string }) => {
      generations.push(data.processGeneration);
      if (fail) {
        fail = false;
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
