import BetterSqlite3 from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { AgentResponseError, AgentUnavailableError } from "./agent-client.js";
import { openProjectDatabase } from "./database.js";
import { openTerminal } from "./execution.js";

const directories: string[] = [];
const databases: Array<ReturnType<typeof openProjectDatabase>> = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

async function createReadyProject() {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-terminal-policy-"));
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

test("allows multiple live terminals per workspace while keeping distinct server identities", async () => {
  const { database, project } = await createReadyProject();

  const first = database.prepareTerminalCreate(project.id, "actor");
  const second = database.prepareTerminalCreate(project.id, "actor");
  expect(second.terminalId).not.toBe(first.terminalId);
  expect(second.operation.operationId).not.toBe(first.operation.operationId);
  expect(database.authorizeTerminal(project.id, "018f0f00-0000-7000-8000-000000000003", first.terminalId)).toBe(false);
  expect(database.getManagedProject(project.id)?.terminals).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: first.terminalId, processId: first.terminalId, state: "creating" }),
    expect.objectContaining({ id: second.terminalId, processId: second.terminalId, state: "creating" })
  ]));
});

test("rejects terminal creation before persisting an intent when the Agent is unavailable", async () => {
  const { database, project } = await createReadyProject();
  const agent = { health: () => Promise.reject(new AgentUnavailableError()) } as never;

  await expect(openTerminal(project.id, "actor", { database, agent })).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
  expect(database.getManagedProject(project.id)?.terminals).toEqual([]);
});

test("rejects terminal creation when the required runtime is unavailable", async () => {
  const { database, project } = await createReadyProject();
  const agent = {
    health: () => Promise.resolve({ status: "ok" }),
    runtimeStatus: () => Promise.resolve({ rootlessRuntime: "unavailable", operationJournal: "available", checkedAt: "2026-07-19T00:00:00.000Z" })
  } as never;

  await expect(openTerminal(project.id, "actor", { database, agent })).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
  expect(database.getManagedProject(project.id)?.terminals).toEqual([]);
});

test("compensates a deterministic Agent terminal-create failure into a failed terminal", async () => {
  const { database, project } = await createReadyProject();
  const agent = {
    health: () => Promise.resolve({ status: "ok" }),
    runtimeStatus: () => Promise.resolve({ rootlessRuntime: "available", operationJournal: "available", checkedAt: "2026-07-19T00:00:00.000Z" }),
    createTerminal: () => Promise.reject(new AgentResponseError("ROOTLESS_RUNTIME_UNAVAILABLE", "The runtime is unavailable."))
  } as never;

  await expect(openTerminal(project.id, "actor", { database, agent })).rejects.toMatchObject({ code: "ROOTLESS_RUNTIME_UNAVAILABLE" });
  expect(database.getManagedProject(project.id)?.terminals).toEqual([
    expect.objectContaining({ state: "failed" })
  ]);
  expect(database.getManagedProject(project.id)?.terminals.some((terminal) => terminal.state === "creating")).toBe(false);
});

test("closing after authoritative terminal loss preserves the lost state", async () => {
  const { database, project, databasePath, workspaceId } = await createReadyProject();
  const intent = database.prepareTerminalCreate(project.id, "actor");
  const raw = new BetterSqlite3(databasePath);
  raw.prepare("update terminal_sessions set state = 'lost' where id = ?").run(intent.terminalId);
  raw.close();

  expect(database.authorizeTerminal(project.id, workspaceId, intent.terminalId)).toBe(false);
  expect(() => database.prepareTerminalClose(project.id, intent.terminalId, "actor")).toThrow("no longer attachable");
  expect(database.getManagedProject(project.id)?.terminals).toEqual([
    expect.objectContaining({ id: intent.terminalId, state: "lost" })
  ]);
});

test("lists every attachable terminal instead of silently truncating after ten", async () => {
  const { database, project, databasePath } = await createReadyProject();
  const terminalIds = Array.from({ length: 11 }, () => database.prepareTerminalCreate(project.id, "actor").terminalId);
  const raw = new BetterSqlite3(databasePath);
  raw.prepare("update terminal_sessions set state = 'disconnected' where workspace_id = ?").run("018f0f00-0000-7000-8000-000000000003");
  raw.close();

  const terminals = database.getManagedProject(project.id)?.terminals ?? [];
  expect(terminals).toHaveLength(11);
  expect(terminals.map((terminal) => terminal.id)).toEqual(expect.arrayContaining(terminalIds));
});
