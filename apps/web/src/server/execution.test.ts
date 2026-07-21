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

async function createReadyProject(options: { now?: () => Date } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-terminal-policy-"));
  directories.push(directory);
  const databasePath = path.join(directory, "devspace.sqlite");
  const database = openProjectDatabase(databasePath, options);
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

function terminalSnapshot(input: {
  projectId: string;
  workspaceId: string;
  terminalId: string;
  state: "active" | "disconnected" | "lost";
  agentBootId?: string;
}) {
  const agentBootId = input.agentBootId ?? "018f0f00-0000-7000-8000-000000000099";
  return {
    agentBootId,
    throughCursor: `v1.${agentBootId}.3` as const,
    resources: [{ type: "terminal" as const, identity: {
      projectId: input.projectId, workspaceId: input.workspaceId, terminalId: input.terminalId
    }, state: input.state }],
    operationObservations: []
  };
}

function insertWorkspacePreview(databasePath: string, input: { previewId: string; workspaceId: string; revisionId: string; hostname: string; observedState?: "healthy" | "lost"; routePresent?: boolean }) {
  const raw = new BetterSqlite3(databasePath);
  raw.prepare(`insert into previews
    (id, workspace_id, config_revision_id, service_id, preview_key, display_name, target_kind, target_key, domain_base_id,
      hostname_pattern, hostname, container_port, protocol, health_path, health_statuses_json, startup_timeout_seconds,
      web_socket_forwarding, desired_state, observed_state, route_present, route_revision, runtime_generation,
      last_observation_json, last_error_code, last_error_message, operation_id, created_at, updated_at, activated_at, deactivated_at)
    values (?, ?, ?, null, 'web', 'Web', 'workspace', 'workspace', 'preview-main', '{project}-{workspace}-{preview}-{shortId}', ?, 3000,
      'http', '/health', '[200]', 5, 1, 'active', ?, ?, 1, 1, null, null, null, null,
      '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z', null)`)
    .run(input.previewId, input.workspaceId, input.revisionId, input.hostname, input.observedState ?? "healthy", (input.routePresent ?? true) ? 1 : 0);
  raw.close();
}

function failedPreviewSnapshot(operationId: string, previewId: string, preview?: { projectId: string; workspaceId: string; hostname: string; observedState: "healthy" | "lost"; routePresent: boolean }) {
  return {
    agentBootId: "018f0f00-0000-7000-8000-000000000099",
    throughCursor: "v1.018f0f00-0000-7000-8000-000000000099.3" as const,
    resources: preview === undefined ? [] : [{ type: "preview" as const, observation: {
      projectId: preview.projectId, workspaceId: preview.workspaceId, previewId, previewKey: "web",
      desiredState: "active" as const, observedState: preview.observedState, routePresent: preview.routePresent,
      hostname: preview.hostname
    } }],
    operationObservations: [{ operationId, state: "failed" as const, updatedAt: "2026-07-19T00:00:00.000Z", failure: {
      code: "GATEWAY_UPDATE_FAILED" as const, message: "The preview route could not be removed.", retryable: true as const,
      details: { previewId }
    } }]
  };
}

test("failed preview operation snapshots preserve the last proven route", async () => {
  const { database, project, databasePath, workspaceId } = await createReadyProject();
  const previewId = "018f0f00-0000-7000-8000-000000000010";
  const revisionId = "018f0f00-0000-7000-8000-000000000002";
  const hostname = "workbench-primary-web-018f0f00.preview.example.com";
  insertWorkspacePreview(databasePath, { previewId, workspaceId, revisionId, hostname });
  const intent = database.preparePreviewMutation({ projectId: project.id, workspaceId, previewId, actor: "actor", action: "deactivate" });

  database.applyExecutionSnapshot(failedPreviewSnapshot(intent.operation.operationId, previewId));

  expect(database.listPreviews(project.id, workspaceId)).toEqual([expect.objectContaining({
    id: previewId, observedState: "failed", routePresent: true, lastErrorCode: "GATEWAY_UPDATE_FAILED"
  })]);
});

test("stale preview snapshot data cannot cross the active revision fence", async () => {
  const { database, project, databasePath, workspaceId } = await createReadyProject();
  const oldRevisionId = "018f0f00-0000-7000-8000-000000000002";
  const newRevisionId = "018f0f00-0000-7000-8000-000000000011";
  const previewId = "018f0f00-0000-7000-8000-000000000012";
  const hostname = "workbench-primary-web-018f0f00.preview.example.com";
  insertWorkspacePreview(databasePath, { previewId, workspaceId, revisionId: oldRevisionId, hostname, observedState: "lost", routePresent: false });
  const intent = database.preparePreviewMutation({ projectId: project.id, workspaceId, previewId, actor: "actor", action: "deactivate" });
  const raw = new BetterSqlite3(databasePath);
  const timestamp = "2026-07-19T00:00:00.000Z";
  const hash = `sha256-jcs-v1:${"b".repeat(64)}`;
  raw.prepare("update project_config_revisions set state = 'superseded', superseded_at = ? where id = ?").run(timestamp, oldRevisionId);
  raw.prepare(`insert into project_config_revisions
    (id, project_id, revision_number, schema_version, configuration_json, configuration_hash, source, state, created_by, created_at, activated_at)
    values (?, ?, 2, 1, '{"schemaVersion":1,"developmentEnvironment":{"source":{"kind":"image","imageReference":"node:24"}}}', ?, 'user', 'active', 'actor', ?, ?)`)
    .run(newRevisionId, project.id, hash, timestamp, timestamp);
  raw.prepare("update workspaces set config_revision_id = ? where id = ?").run(newRevisionId, workspaceId);
  raw.prepare("update projects set active_config_revision_id = ? where id = ?").run(newRevisionId, project.id);
  raw.close();

  database.applyExecutionSnapshot(failedPreviewSnapshot(intent.operation.operationId, previewId, {
    projectId: project.id, workspaceId, hostname, observedState: "healthy", routePresent: true
  }));

  expect(database.listPreviews(project.id, workspaceId)).toEqual([expect.objectContaining({
    id: previewId, configRevisionId: oldRevisionId, observedState: "lost", routePresent: false, lastErrorCode: null
  })]);
});

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

test("allocates stable lowest available terminal numbers and reuses dead-terminal gaps", async () => {
  const { database, project, databasePath, workspaceId } = await createReadyProject();
  const first = database.prepareTerminalCreate(project.id, "actor");
  const second = database.prepareTerminalCreate(project.id, "actor");
  expect(database.getManagedProject(project.id)?.terminals).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: first.terminalId, title: "Terminal 1" }),
    expect.objectContaining({ id: second.terminalId, title: "Terminal 2" })
  ]));

  const raw = new BetterSqlite3(databasePath);
  raw.prepare("update terminal_sessions set state = 'disconnected' where id in (?, ?)").run(first.terminalId, second.terminalId);
  raw.prepare("update terminal_sessions set state = 'closed' where id = ?").run(second.terminalId);
  raw.close();

  const reused = database.prepareTerminalCreate(project.id, "actor");
  expect(database.getManagedProject(project.id)?.terminals).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: first.terminalId, title: "Terminal 1", state: "disconnected" }),
    expect.objectContaining({ id: reused.terminalId, title: "Terminal 2" })
  ]));

  const rawAgain = new BetterSqlite3(databasePath);
  rawAgain.prepare("update terminal_sessions set state = 'lost' where workspace_id = ?").run(workspaceId);
  rawAgain.close();
  const reset = database.prepareTerminalCreate(project.id, "actor");
  expect(database.getManagedProject(project.id)?.terminals).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: reset.terminalId, title: "Terminal 1" })
  ]));
});

test("retains a newly lost terminal, then retires its session and process once without refreshing closed_at", async () => {
  let currentTime = new Date("2026-07-19T00:00:00.000Z");
  const { database, project, databasePath, workspaceId } = await createReadyProject({ now: () => currentTime });
  const intent = database.prepareTerminalCreate(project.id, "actor");

  database.applyExecutionSnapshot(terminalSnapshot({ projectId: project.id, workspaceId, terminalId: intent.terminalId, state: "lost" }));
  const raw = new BetterSqlite3(databasePath);
  expect(raw.prepare("select state, closed_at from terminal_sessions where id = ?").get(intent.terminalId)).toEqual({
    state: "lost", closed_at: currentTime.toISOString()
  });
  expect(raw.prepare("select id from processes where id = ?").get(intent.terminalId)).toEqual({ id: intent.terminalId });
  raw.close();
  expect(database.getManagedProject(project.id)?.terminals).toEqual([
    expect.objectContaining({ id: intent.terminalId, state: "lost" })
  ]);

  currentTime = new Date("2026-07-19T00:00:10.000Z");
  database.applyExecutionSnapshot(terminalSnapshot({ projectId: project.id, workspaceId, terminalId: intent.terminalId, state: "lost" }));
  const repeated = new BetterSqlite3(databasePath);
  expect(repeated.prepare("select closed_at from terminal_sessions where id = ?").get(intent.terminalId)).toEqual({
    closed_at: "2026-07-19T00:00:00.000Z"
  });
  repeated.close();

  currentTime = new Date("2026-07-19T00:00:30.000Z");
  expect(database.getManagedProject(project.id)?.terminals).toEqual([]);
  const retired = new BetterSqlite3(databasePath);
  expect(retired.prepare("select id from terminal_sessions where id = ?").get(intent.terminalId)).toBeUndefined();
  expect(retired.prepare("select id from processes where id = ?").get(intent.terminalId)).toBeUndefined();
  retired.close();
  expect(database.listOperations()).toEqual(expect.arrayContaining([
    expect.objectContaining({ operationName: "terminal.create", resourceId: intent.terminalId })
  ]));
});

test("does not prune active or disconnected terminals after the grace period", async () => {
  let currentTime = new Date("2026-07-19T00:00:00.000Z");
  const { database, project, databasePath, workspaceId } = await createReadyProject({ now: () => currentTime });
  const intent = database.prepareTerminalCreate(project.id, "actor");
  database.applyExecutionSnapshot(terminalSnapshot({ projectId: project.id, workspaceId, terminalId: intent.terminalId, state: "active" }));

  currentTime = new Date("2026-07-19T00:01:00.000Z");
  database.applyExecutionSnapshot(terminalSnapshot({ projectId: project.id, workspaceId, terminalId: intent.terminalId, state: "disconnected" }));
  expect(database.getManagedProject(project.id)?.terminals).toEqual([
    expect.objectContaining({ id: intent.terminalId, state: "disconnected" })
  ]);
  const raw = new BetterSqlite3(databasePath);
  expect(raw.prepare("select id from processes where id = ?").get(intent.terminalId)).toEqual({ id: intent.terminalId });
  raw.close();
});

test("an already-retired lost terminal is ignored by later Agent snapshots and does not reappear", async () => {
  let currentTime = new Date("2026-07-19T00:00:00.000Z");
  const { database, project, workspaceId } = await createReadyProject({ now: () => currentTime });
  const old = database.prepareTerminalCreate(project.id, "actor");
  database.applyExecutionSnapshot(terminalSnapshot({ projectId: project.id, workspaceId, terminalId: old.terminalId, state: "lost" }));

  currentTime = new Date("2026-07-19T00:00:31.000Z");
  database.applyExecutionSnapshot(terminalSnapshot({
    projectId: project.id, workspaceId, terminalId: old.terminalId, state: "lost", agentBootId: "018f0f00-0000-7000-8000-000000000100"
  }));
  expect(database.getManagedProject(project.id)?.terminals).toEqual([]);

  const replacement = database.prepareTerminalCreate(project.id, "actor");
  expect(database.getManagedProject(project.id)?.terminals).toEqual([
    expect.objectContaining({ id: replacement.terminalId, title: "Terminal 1" })
  ]);
  currentTime = new Date("2026-07-19T00:00:32.000Z");
  const laterRestartSnapshot = terminalSnapshot({
    projectId: project.id, workspaceId, terminalId: replacement.terminalId, state: "lost", agentBootId: "018f0f00-0000-7000-8000-000000000101"
  });
  laterRestartSnapshot.resources.push({ type: "terminal", identity: {
    projectId: project.id, workspaceId, terminalId: old.terminalId
  }, state: "lost" });
  database.applyExecutionSnapshot(laterRestartSnapshot);
  expect(database.getManagedProject(project.id)?.terminals).toEqual([
    expect.objectContaining({ id: replacement.terminalId, state: "lost" })
  ]);
});

test("expired lost terminals do not reserve display numbers while preserving live labels", async () => {
  let currentTime = new Date("2026-07-19T00:00:00.000Z");
  const { database, project, workspaceId } = await createReadyProject({ now: () => currentTime });
  const first = database.prepareTerminalCreate(project.id, "actor");
  const second = database.prepareTerminalCreate(project.id, "actor");
  database.applyExecutionSnapshot(terminalSnapshot({ projectId: project.id, workspaceId, terminalId: first.terminalId, state: "active" }));
  database.applyExecutionSnapshot(terminalSnapshot({ projectId: project.id, workspaceId, terminalId: second.terminalId, state: "lost" }));

  currentTime = new Date("2026-07-19T00:00:30.000Z");
  const replacement = database.prepareTerminalCreate(project.id, "actor");
  expect(database.getManagedProject(project.id)?.terminals).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: first.terminalId, title: "Terminal 1", state: "active" }),
    expect.objectContaining({ id: replacement.terminalId, title: "Terminal 2" })
  ]));
});

test("the first terminal number is reused after Terminal 1 and Terminal 2 are retired", async () => {
  let currentTime = new Date("2026-07-19T00:00:00.000Z");
  const { database, project, workspaceId } = await createReadyProject({ now: () => currentTime });
  const first = database.prepareTerminalCreate(project.id, "actor");
  const second = database.prepareTerminalCreate(project.id, "actor");
  database.applyExecutionSnapshot(terminalSnapshot({ projectId: project.id, workspaceId, terminalId: first.terminalId, state: "lost" }));
  database.applyExecutionSnapshot(terminalSnapshot({ projectId: project.id, workspaceId, terminalId: second.terminalId, state: "lost" }));

  currentTime = new Date("2026-07-19T00:00:30.000Z");
  const replacement = database.prepareTerminalCreate(project.id, "actor");
  expect(database.getManagedProject(project.id)?.terminals).toEqual([
    expect.objectContaining({ id: replacement.terminalId, title: "Terminal 1" })
  ]);
});

test("allocates concurrent terminal creation intents without duplicate live labels", async () => {
  const { database, project } = await createReadyProject();
  const intents = Array.from({ length: 12 }, () => database.prepareTerminalCreate(project.id, "actor"));
  const terminals = database.getManagedProject(project.id)?.terminals ?? [];
  expect(new Set(intents.map((intent) => terminals.find((terminal) => terminal.id === intent.terminalId)?.title))).toEqual(
    new Set(Array.from({ length: 12 }, (_value, index) => `Terminal ${index + 1}`))
  );
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
