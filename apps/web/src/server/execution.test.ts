import BetterSqlite3 from "better-sqlite3";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { decodeTerminalAgentFrame, encodeTerminalAgentFrame, encodeTerminalClientFrame, TERMINAL_SUBPROTOCOL } from "@devspace/contracts";
import { AgentResponseError, AgentUnavailableError } from "./agent-client.js";
import { openProjectDatabase } from "./database.js";
import { openTerminal } from "./execution.js";
import { installTerminalWebSocketRelay } from "./terminal-relay.js";

const directories: string[] = [];
const databases: Array<ReturnType<typeof openProjectDatabase>> = [];
const servers: Server[] = [];
const relayRemovers: Array<() => void> = [];
const webSocketServers: WebSocketServer[] = [];
afterEach(async () => {
  for (const remove of relayRemovers.splice(0)) remove();
  for (const socketServer of webSocketServers.splice(0)) await new Promise<void>((resolve) => socketServer.close(() => resolve()));
  await Promise.all(servers.splice(0).map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))));
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

test("stale preview snapshots cannot mutate or expose historical revision rows", async () => {
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

  expect(database.listPreviews(project.id, workspaceId)).toEqual([]);
  const historical = new BetterSqlite3(databasePath);
  expect(historical.prepare(`select observed_state as observedState, route_present as routePresent,
    last_error_code as lastErrorCode from previews where id = ?`).get(previewId)).toEqual({
    observedState: "lost", routePresent: 0, lastErrorCode: null
  });
  historical.close();
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

test("retires lost terminal resources when a workspace stop intent is accepted", async () => {
  const { database, project, databasePath, workspaceId } = await createReadyProject();
  const lost = database.prepareTerminalCreate(project.id, "actor");
  const active = database.prepareTerminalCreate(project.id, "actor");
  const disconnected = database.prepareTerminalCreate(project.id, "actor");
  database.applyExecutionSnapshot(terminalSnapshot({ projectId: project.id, workspaceId, terminalId: lost.terminalId, state: "lost" }));
  database.applyExecutionSnapshot(terminalSnapshot({ projectId: project.id, workspaceId, terminalId: active.terminalId, state: "active" }));
  database.applyExecutionSnapshot(terminalSnapshot({ projectId: project.id, workspaceId, terminalId: disconnected.terminalId, state: "disconnected" }));
  const raw = new BetterSqlite3(databasePath);
  const service = raw.prepare("select id from workspace_services where runtime_stack_id = (select id from runtime_stacks where workspace_id = ?)").get(workspaceId) as { id: string };
  const taskProcessId = "018f0f00-0000-7000-8000-000000000020";
  raw.prepare(`insert into processes
    (id, workspace_id, service_id, kind, definition_key, desired_state, observed_state, exit_code, started_at, finished_at, last_observed_at)
    values (?, ?, ?, 'task', 'build', 'running', 'running', null, null, null, null)`).run(taskProcessId, workspaceId, service.id);
  raw.close();
  const operationsBefore = database.listOperations();
  const auditEventsBefore = database.listAuditEvents();
  const runtime = database.listRuntimeStacks()[0];
  if (runtime === undefined) throw new Error("runtime stack was not created");

  const stop = database.prepareRuntimeMutation({ projectId: project.id, workspaceId, actor: "actor", action: "stop",
    runtimePlanHash: runtime.runtimePlanHash, imageReference: "node:24-bookworm" });
  expect(stop.operationName).toBe("workspace.stop");

  const retired = new BetterSqlite3(databasePath);
  expect(retired.prepare("select id from terminal_sessions where id = ?").get(lost.terminalId)).toBeUndefined();
  expect(retired.prepare("select id from processes where id = ?").get(lost.terminalId)).toBeUndefined();
  expect(retired.prepare("select id from terminal_sessions where id in (?, ?)").all(active.terminalId, disconnected.terminalId)).toHaveLength(2);
  expect(retired.prepare("select id from processes where id = ? and kind = 'task'").get(taskProcessId)).toEqual({ id: taskProcessId });
  retired.close();
  expect(database.listOperations()).toHaveLength(operationsBefore.length + 1);
  expect(database.listOperations()).toEqual(expect.arrayContaining([...operationsBefore, stop]));
  expect(database.listAuditEvents()).toEqual(auditEventsBefore);
  expect(database.getManagedProject(project.id)?.terminals).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: active.terminalId, state: "active" }),
    expect.objectContaining({ id: disconnected.terminalId, state: "disconnected" })
  ]));
  expect(database.getManagedProject(project.id)?.terminals.some((terminal) => terminal.id === lost.terminalId)).toBe(false);

  const restarted = new BetterSqlite3(databasePath);
  restarted.prepare("update workspaces set desired_state = 'running', observed_state = 'running' where id = ?").run(workspaceId);
  restarted.prepare("update runtime_stacks set desired_state = 'running', observed_state = 'running' where workspace_id = ?").run(workspaceId);
  restarted.prepare("update workspace_services set desired_state = 'running', observed_state = 'running' where runtime_stack_id = (select id from runtime_stacks where workspace_id = ?)").run(workspaceId);
  restarted.close();
  const replacement = database.prepareTerminalCreate(project.id, "actor");
  expect(database.getManagedProject(project.id)?.terminals.some((terminal) => terminal.id === lost.terminalId)).toBe(false);
  expect(database.getManagedProject(project.id)?.terminals).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: replacement.terminalId })
  ]));
  database.applyExecutionSnapshot(terminalSnapshot({ projectId: project.id, workspaceId, terminalId: lost.terminalId, state: "lost", agentBootId: "018f0f00-0000-7000-8000-000000000100" }));
  expect(database.getManagedProject(project.id)?.terminals.some((terminal) => terminal.id === lost.terminalId)).toBe(false);
});

test("retires active terminals after a confirmed workspace stop", async () => {
  const { database, project, databasePath, workspaceId } = await createReadyProject();
  const terminal = database.prepareTerminalCreate(project.id, "actor");
  database.applyExecutionSnapshot(terminalSnapshot({ projectId: project.id, workspaceId, terminalId: terminal.terminalId, state: "active" }));
  const runtime = database.listRuntimeStacks()[0];
  if (runtime === undefined) throw new Error("runtime stack was not created");

  const stop = database.prepareRuntimeMutation({ projectId: project.id, workspaceId, actor: "actor", action: "stop",
    runtimePlanHash: runtime.runtimePlanHash, imageReference: "node:24-bookworm" });
  expect(database.getManagedProject(project.id)?.terminals).toEqual([expect.objectContaining({ id: terminal.terminalId, state: "active" })]);

  database.finishRuntimeMutation({ operationId: stop.operationId, projectId: project.id, workspaceId,
    outcome: { state: "succeeded", workspaceObserved: "stopped", runtimeObserved: "stopped" } });

  const retired = new BetterSqlite3(databasePath);
  expect(retired.prepare("select id from terminal_sessions where id = ?").get(terminal.terminalId)).toBeUndefined();
  expect(retired.prepare("select id from processes where id = ?").get(terminal.terminalId)).toBeUndefined();
  retired.close();
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

test("stale Agent process snapshots cannot revive a terminal after it has stopped", async () => {
  const { database, project, databasePath, workspaceId } = await createReadyProject();
  const terminal = database.prepareTerminalCreate(project.id, "actor");
  const agentBootId = "018f0f00-0000-7000-8000-000000000102";
  const snapshot = (observedState: "running" | "killed") => ({
    agentBootId,
    throughCursor: `v1.${agentBootId}.3` as const,
    resources: [{ type: "process" as const, observation: {
      projectId: project.id, workspaceId, processId: terminal.terminalId, kind: "terminal" as const,
      desiredState: observedState === "killed" ? "stopped" as const : "running" as const,
      observedState, exitCode: null, startedAt: null,
      finishedAt: observedState === "killed" ? "2026-07-19T00:00:01.000Z" : null
    } }],
    operationObservations: []
  });
  database.applyExecutionSnapshot(snapshot("killed"));
  database.applyExecutionSnapshot(snapshot("running"));

  const raw = new BetterSqlite3(databasePath);
  expect(raw.prepare("select desired_state as desiredState, observed_state as observedState from processes where id = ?")
    .get(terminal.terminalId)).toEqual({ desiredState: "stopped", observedState: "killed" });
  raw.close();
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

test("a stale terminal-create failure cannot overwrite a terminal retired by workspace Stop", async () => {
  const currentTime = new Date("2026-07-19T00:00:00.000Z");
  const { database, project, databasePath, workspaceId } = await createReadyProject({ now: () => currentTime });
  const intent = database.prepareTerminalCreate(project.id, "actor");
  const raw = new BetterSqlite3(databasePath);
  raw.prepare("update terminal_sessions set state = 'lost', closed_at = ? where id = ?")
    .run(currentTime.toISOString(), intent.terminalId);
  raw.prepare("update processes set desired_state = 'stopped', observed_state = 'killed', finished_at = ? where id = ?")
    .run("2026-07-19T00:00:01.000Z", intent.terminalId);
  raw.close();

  database.applyExecutionSnapshot({
    ...terminalSnapshot({ projectId: project.id, workspaceId, terminalId: intent.terminalId, state: "active" }),
    operationObservations: [{ operationId: intent.operation.operationId, state: "failed", updatedAt: "2026-07-19T00:00:02.000Z",
      failure: { code: "ROOTLESS_RUNTIME_UNAVAILABLE", message: "The runtime is unavailable.", retryable: true, details: { component: "docker" } } }]
  });

  expect(database.getManagedProject(project.id)?.terminals).toEqual([
    expect.objectContaining({ id: intent.terminalId, state: "lost" })
  ]);
  const retired = new BetterSqlite3(databasePath);
  expect(retired.prepare("select desired_state as desiredState, observed_state as observedState from processes where id = ?")
    .get(intent.terminalId)).toEqual({ desiredState: "stopped", observedState: "killed" });
  retired.close();
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

test("authorizes a closed terminal only for its bounded post-exit replay window and exact owner", async () => {
  let currentTime = new Date("2026-07-19T00:00:30.000Z");
  const { database, project, databasePath, workspaceId } = await createReadyProject({ now: () => currentTime });
  const terminalIds = Array.from({ length: 8 }, () => database.prepareTerminalCreate(project.id, "actor").terminalId);
  const [active, disconnected, freshClosed, expiredClosed, lost, failed, creating, nullClosed] = terminalIds;
  const raw = new BetterSqlite3(databasePath);
  raw.prepare("update terminal_sessions set state = 'active' where id = ?").run(active);
  raw.prepare("update terminal_sessions set state = 'disconnected' where id = ?").run(disconnected);
  raw.prepare("update terminal_sessions set state = 'closed', closed_at = ? where id = ?")
    .run("2026-07-19T00:00:00.001Z", freshClosed);
  raw.prepare("update terminal_sessions set state = 'closed', closed_at = ? where id = ?")
    .run("2026-07-18T23:59:59.999Z", expiredClosed);
  raw.prepare("update terminal_sessions set state = 'lost', closed_at = ? where id = ?")
    .run(currentTime.toISOString(), lost);
  raw.prepare("update terminal_sessions set state = 'failed', closed_at = ? where id = ?")
    .run(currentTime.toISOString(), failed);
  raw.prepare("update terminal_sessions set state = 'closed', closed_at = null where id = ?").run(nullClosed);
  raw.close();

  expect(database.authorizeTerminal(project.id, workspaceId, active!)).toBe(true);
  expect(database.authorizeTerminal(project.id, workspaceId, disconnected!)).toBe(true);
  expect(database.authorizeTerminal(project.id, workspaceId, freshClosed!)).toBe(true);
  expect(database.authorizeTerminal(project.id, workspaceId, expiredClosed!)).toBe(false);
  expect(database.authorizeTerminal(project.id, workspaceId, lost!)).toBe(false);
  expect(database.authorizeTerminal(project.id, workspaceId, failed!)).toBe(false);
  expect(database.authorizeTerminal(project.id, workspaceId, creating!)).toBe(false);
  expect(database.authorizeTerminal(project.id, workspaceId, nullClosed!)).toBe(false);
  expect(database.authorizeTerminal(project.id, "018f0f00-0000-7000-8000-000000000088", freshClosed!)).toBe(false);
  expect(database.authorizeTerminal("018f0f00-0000-7000-8000-000000000087", workspaceId, freshClosed!)).toBe(false);
  expect(database.authorizeTerminal(project.id, workspaceId, "018f0f00-0000-7000-8000-000000000086")).toBe(false);

  currentTime = new Date("2026-07-19T00:00:30.001Z");
  expect(database.authorizeTerminal(project.id, workspaceId, freshClosed!)).toBe(false);
  currentTime = new Date("2026-07-19T00:00:00.000Z");
  expect(database.authorizeTerminal(project.id, workspaceId, freshClosed!)).toBe(false);
});

test("Web relays a closed fast-exit terminal's one-shot Agent replay before the authorization grace expires", async () => {
  const currentTime = new Date("2026-07-19T00:00:30.000Z");
  const { database, project, databasePath, workspaceId } = await createReadyProject({ now: () => currentTime });
  const intent = database.prepareTerminalCreate(project.id, "actor");
  const raw = new BetterSqlite3(databasePath);
  raw.prepare("update terminal_sessions set state = 'closed', closed_at = ? where id = ?")
    .run(currentTime.toISOString(), intent.terminalId);
  raw.close();

  const agentSocketPath = path.join(path.dirname(databasePath), "agent.sock");
  const agentHttp = createServer();
  const agentWebSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  webSocketServers.push(agentWebSockets);
  let replayClaimed = false;
  let agentClaims = 0;
  agentHttp.on("upgrade", (request, socket, head) => {
    if (request.url !== `/v1/terminals/${intent.terminalId}/stream` || request.headers["sec-websocket-protocol"] !== TERMINAL_SUBPROTOCOL) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
    }
    agentClaims += 1;
    if (replayClaimed) {
      socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
    }
    replayClaimed = true;
    agentWebSockets.handleUpgrade(request, socket, head, (websocket) => {
      websocket.send(Buffer.from(encodeTerminalAgentFrame({ type: "ready" })), { binary: true });
      websocket.send(Buffer.from(encodeTerminalAgentFrame({ type: "output", data: Buffer.from("FAST_CUSTOM_HARNESS_OUTPUT\n") })), { binary: true });
      websocket.send(Buffer.from(encodeTerminalAgentFrame({ type: "exit", exitCode: 0 })), { binary: true });
      websocket.close(1000);
    });
  });
  await new Promise<void>((resolve, reject) => { agentHttp.once("error", reject); agentHttp.listen(agentSocketPath, resolve); });
  servers.push(agentHttp);

  const origin = "http://terminal-test.invalid";
  const web = createServer();
  const removeRelay = installTerminalWebSocketRelay(web, {
    appOrigin: origin, agentSocketPath, auth: { mode: "development", actor: "test@example.invalid" },
    authorizeTerminal: (projectId, authorizedWorkspaceId, terminalId) =>
      database.authorizeTerminal(projectId, authorizedWorkspaceId, terminalId),
    onUnmatchedUpgrade: (_request, socket) => socket.destroy()
  });
  relayRemovers.push(removeRelay);
  await new Promise<void>((resolve, reject) => { web.once("error", reject); web.listen(0, "127.0.0.1", resolve); });
  servers.push(web);
  const address = web.address();
  if (address === null || typeof address === "string") throw new Error("Web relay did not bind a TCP port.");
  const url = `ws://127.0.0.1:${address.port}/api/projects/${project.id}/workspaces/${workspaceId}/terminals/${intent.terminalId}/stream`;
  const receive = async (terminalUrl: string): Promise<{ status: number | null; frames: Array<ReturnType<typeof decodeTerminalAgentFrame>> }> => {
    const socket = new WebSocket(terminalUrl, TERMINAL_SUBPROTOCOL, { headers: { origin } });
    return await new Promise((resolve, reject) => {
      const frames: Array<ReturnType<typeof decodeTerminalAgentFrame>> = [];
      let settled = false;
      const finish = (status: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status, frames });
      };
      const timer = setTimeout(() => { socket.terminate(); reject(new Error("terminal relay did not close")); }, 3_000);
      socket.on("message", (data, isBinary) => {
        if (!isBinary) { socket.terminate(); reject(new Error("terminal relay returned a text frame")); return; }
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        frames.push(decodeTerminalAgentFrame(bytes));
      });
      socket.once("open", () => undefined);
      socket.once("close", () => finish(null));
      socket.once("unexpected-response", (_request, response) => finish(response.statusCode ?? 0));
      socket.once("error", (error) => { if (!settled && socket.readyState !== WebSocket.CLOSED) reject(error); });
    });
  };

  const first = await receive(url);
  expect(first.status).toBe(null);
  expect(first.frames.map((frame) => frame.ok ? frame.frame.type : frame.error)).toEqual(["ready", "output", "exit"]);
  expect(first.frames[1]).toMatchObject({ ok: true, frame: { type: "output", data: Buffer.from("FAST_CUSTOM_HARNESS_OUTPUT\n") } });
  expect(first.frames[2]).toMatchObject({ ok: true, frame: { type: "exit", exitCode: 0 } });
  expect(agentClaims).toBe(1);

  const second = await receive(url);
  expect(second.status).toBe(null);
  expect(second.frames).toEqual([{ ok: true, frame: { type: "attachment-conflict" } }]);
  expect(agentClaims).toBe(2);

  const foreign = await receive(`ws://127.0.0.1:${address.port}/api/projects/${project.id}/workspaces/${workspaceId}/terminals/018f0f00-0000-7000-8000-000000000086/stream`);
  expect(foreign.status).toBe(404);
  expect(foreign.frames).toEqual([]);
  expect(agentClaims).toBe(2);
});

test("active terminal relay still carries live input and resize frames", async () => {
  const { database, project, databasePath, workspaceId } = await createReadyProject();
  const intent = database.prepareTerminalCreate(project.id, "actor");
  const raw = new BetterSqlite3(databasePath);
  raw.prepare("update terminal_sessions set state = 'active' where id = ?").run(intent.terminalId);
  raw.close();

  const agentSocketPath = path.join(path.dirname(databasePath), "live-agent.sock");
  const agentHttp = createServer();
  const agentWebSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  webSocketServers.push(agentWebSockets);
  const clientFrames: Buffer[] = [];
  let finishFrames!: () => void;
  const receivedFrames = new Promise<void>((resolve) => { finishFrames = resolve; });
  agentHttp.on("upgrade", (request, socket, head) => {
    agentWebSockets.handleUpgrade(request, socket, head, (websocket) => {
      websocket.send(Buffer.from(encodeTerminalAgentFrame({ type: "ready" })), { binary: true });
      websocket.on("message", (data, isBinary) => {
        if (!isBinary) return;
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        clientFrames.push(bytes);
        if (clientFrames.length === 2) { finishFrames(); websocket.close(1000); }
      });
    });
  });
  await new Promise<void>((resolve, reject) => { agentHttp.once("error", reject); agentHttp.listen(agentSocketPath, resolve); });
  servers.push(agentHttp);
  const origin = "http://terminal-live-test.invalid";
  const web = createServer();
  relayRemovers.push(installTerminalWebSocketRelay(web, {
    appOrigin: origin, agentSocketPath, auth: { mode: "development", actor: "test@example.invalid" },
    authorizeTerminal: (projectId, authorizedWorkspaceId, terminalId) =>
      database.authorizeTerminal(projectId, authorizedWorkspaceId, terminalId),
    onUnmatchedUpgrade: (_request, socket) => socket.destroy()
  }));
  await new Promise<void>((resolve, reject) => { web.once("error", reject); web.listen(0, "127.0.0.1", resolve); });
  servers.push(web);
  const address = web.address();
  if (address === null || typeof address === "string") throw new Error("Web relay did not bind a TCP port.");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/projects/${project.id}/workspaces/${workspaceId}/terminals/${intent.terminalId}/stream`,
    TERMINAL_SUBPROTOCOL, { headers: { origin } });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("live terminal relay did not open")), 3_000);
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("error", reject);
  });
  await ready;
  socket.send(Buffer.from(encodeTerminalClientFrame({ type: "input", data: Buffer.from("local-input") })), { binary: true });
  socket.send(Buffer.from(encodeTerminalClientFrame({ type: "resize", columns: 120, rows: 40 })), { binary: true });
  await receivedFrames;
  expect(clientFrames.map((frame) => Array.from(frame))).toEqual([
    Array.from(encodeTerminalClientFrame({ type: "input", data: Buffer.from("local-input") })),
    Array.from(encodeTerminalClientFrame({ type: "resize", columns: 120, rows: 40 }))
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
