import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import WebSocket from "ws";

const exec = promisify(execFile);
const coordinationPath = path.resolve(".cache/e2e-runtime.json");
interface Database { prepare<Row>(sql: string): { get(...parameters: unknown[]): Row | undefined; all(...parameters: unknown[]): Row[] }; close(): void }
const sqliteModule: unknown = createRequire(path.resolve("apps/web/package.json"))("better-sqlite3");
if (typeof sqliteModule !== "function") throw new Error("better-sqlite3 test dependency is unavailable");
const BetterSqlite3 = sqliteModule as new (filename: string, options: { readonly: boolean }) => Database;
interface Fixture { databasePath: string; managedRoot: string; projectId: string; expectedHead: string; controlToken: string }
interface ProjectRow { state: string; active_config_revision_id: string | null; primary_workspace_id: string | null }
interface RevisionRow { state: string }
interface OperationRow { operation_id: string; operation_name: string; resource_id: string; state: string }
interface WorkspaceRow { id: string }
interface RuntimeRow { runtime_generation: number; desired_state: string; observed_state: string }
interface ServiceRow { desired_state: string; observed_state: string }
interface TerminalRow { id: string; state: string }
function parseFixture(value: unknown): Fixture {
  if (value === null || typeof value !== "object") throw new Error("E2E fixture metadata is invalid");
  const record = value as Record<string, unknown>;
  for (const key of ["databasePath", "managedRoot", "projectId", "expectedHead", "controlToken"] as const) {
    if (typeof record[key] !== "string") throw new Error(`E2E fixture ${key} is invalid`);
  }
  return record as unknown as Fixture;
}

async function rejectedWebSocket(url: string, origin: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, "devspace.terminal.v1", { origin });
    socket.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
    socket.once("open", () => { socket.close(); reject(new Error("WebSocket unexpectedly opened.")); });
    socket.once("error", () => undefined);
  });
}

async function gotoProject(page: import("@playwright/test").Page, projectId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(`/projects/${projectId}`);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("interrupted by another navigation")) throw error;
      await page.waitForTimeout(500);
    }
  }
  throw new Error("Project navigation was repeatedly interrupted.");
}

test("sets up and recovers the real managed primary workspace", async ({ page }) => {
  test.setTimeout(360_000);
  const fixtureJson: unknown = JSON.parse(await readFile(coordinationPath, "utf8"));
  const fixture = parseFixture(fixtureJson);
  await page.goto("/");
  const dashboardProject = page.locator("article", { has: page.getByRole("heading", { name: "Managed Fixture" }) });
  await expect(dashboardProject.getByRole("link", { name: "Open project" })).toBeVisible();
  await expect(page.locator(".execution-controls")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run" })).toHaveCount(0);
  const missingProjectResponse = await page.request.get("/projects/018f0f00-0000-7000-8000-ffffffffffff");
  expect(missingProjectResponse.status()).toBe(404);
  await dashboardProject.getByRole("link", { name: "Open project" }).click();
  const project = page.locator("main");
  await expect(page).toHaveURL(new RegExp(`/projects/${fixture.projectId}$`, "u"));
  await expect(project.getByText("Registered — workspace setup pending")).toBeVisible();
  await project.getByLabel("Development container image").fill("node:24-bookworm");
  await project.getByLabel("Configure a task").check();
  await project.getByRole("button", { name: "Set up primary workspace" }).click();
  await expect(page.locator("main.workbench")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".workbench-breadcrumb")).toContainText("Managed Fixture");
  await expect(page.locator(".workbench-tabstrip")).toContainText("Open a terminal");
  await expect(page.locator(".workbench-sidebar")).toContainText("Tasks");
  await expect(page.locator(".workbench-statusbar")).toContainText("Agent connected");
  await expect(page.locator(".runtime-chip.absent")).toHaveText("Offline");
  await expect(project.getByRole("button", { name: "Start environment" })).toBeVisible();

  const database = new BetterSqlite3(fixture.databasePath, { readonly: true });
  const projectRow = database.prepare<ProjectRow>("select state, active_config_revision_id, primary_workspace_id from projects where id = ?").get(fixture.projectId);
  const revisions = database.prepare<RevisionRow>("select state from project_config_revisions where project_id = ?").all(fixture.projectId);
  const operations = database.prepare<OperationRow>("select operation_id, operation_name, resource_id, state from operations where project_id = ? order by operation_name").all(fixture.projectId);
  const workspaces = database.prepare<WorkspaceRow>("select id from workspaces where project_id = ?").all(fixture.projectId);
  database.close();
  expect(projectRow).toBeDefined();
  if (projectRow === undefined || workspaces[0] === undefined || revisions[0] === undefined) throw new Error("E2E database state is incomplete");
  expect(projectRow.state).toBe("ready"); expect(revisions).toHaveLength(1); expect(revisions[0].state).toBe("active");
  expect(workspaces).toHaveLength(1); expect(projectRow.primary_workspace_id).toBe(workspaces[0].id);
  expect(operations.map((operation) => operation.operation_name).sort()).toEqual([
    "configuration-revision.register", "configuration-runtime-plan.register", "project.fetch", "project.managed-store.create", "workspace.create"
  ]);
  expect(operations.every((operation) => operation.state === "succeeded")).toBe(true);

  const repository = path.join(fixture.managedRoot, "projects", fixture.projectId, "repository.git");
  const workspace = path.join(fixture.managedRoot, "workspaces", workspaces[0].id, "source");
  expect((await lstat(repository)).isDirectory()).toBe(true); expect((await lstat(workspace)).isDirectory()).toBe(true);
  const bare = (await exec("/usr/bin/git", ["--git-dir", repository, "rev-parse", "--is-bare-repository"])).stdout.trim();
  const branch = (await exec("/usr/bin/git", ["-C", workspace, "branch", "--show-current"])).stdout.trim();
  const head = (await exec("/usr/bin/git", ["-C", workspace, "rev-parse", "HEAD"])).stdout.trim();
  const dirty = (await exec("/usr/bin/git", ["-C", workspace, "status", "--porcelain=v1"])).stdout;
  expect(bare).toBe("true"); expect(branch).toBe("main"); expect(head).toBe(fixture.expectedHead); expect(dirty).toBe("");
  for (const operation of operations) {
    const journal: unknown = JSON.parse(await readFile(path.join(fixture.managedRoot, "state", "operations", `${operation.operation_id}.json`), "utf8"));
    expect(journal).toMatchObject({ operationId: operation.operation_id, operationName: operation.operation_name, state: "succeeded" });
  }

  const failFirstStart = await fetch("http://127.0.0.1:3199/fail-next-container-create", {
    method: "POST", headers: { authorization: `Bearer ${fixture.controlToken}` }
  });
  expect(failFirstStart.status).toBe(204);
  await project.getByRole("button", { name: "Start environment" }).click();
  await expect(project.getByText("The development container could not be created safely.")).toBeVisible({ timeout: 120_000 });
  const staleWebOperation = await fetch("http://127.0.0.1:3199/simulate-stale-web-runtime-operation", {
    method: "POST", headers: { authorization: `Bearer ${fixture.controlToken}` }
  });
  expect(staleWebOperation.status).toBe(204);
  const failedStartRestart = await fetch("http://127.0.0.1:3199/restart", {
    method: "POST", headers: { authorization: `Bearer ${fixture.controlToken}` }
  });
  expect(failedStartRestart.status).toBe(204);
  await expect.poll(async () => await fetch(`http://127.0.0.1:3100/projects/${fixture.projectId}`).then((response) => response.status).catch(() => 0), {
    timeout: 30_000
  }).toBe(200);
  await gotoProject(page, fixture.projectId);
  await expect(project.getByRole("button", { name: "Retry start" })).toBeVisible();
  await project.getByRole("button", { name: "Retry start" }).click();
  await expect(project.getByText("Running", { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(project.getByRole("button", { name: "Stop environment" })).toBeVisible();
  let taskGetRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().endsWith(`/api/projects/${fixture.projectId}/tasks`)) taskGetRequests += 1;
  });
  await page.waitForTimeout(2_000);
  expect(taskGetRequests).toBe(0);
  const dockerSnapshot = await fetch("http://127.0.0.1:3199/docker-snapshot", {
    headers: { authorization: `Bearer ${fixture.controlToken}` }
  }).then(async (response) => await response.json()) as { networks: number; containers: number; execs: unknown[] };
  expect(dockerSnapshot).toMatchObject({ networks: 1, containers: 1 }); expect(dockerSnapshot.execs).toEqual([]);
  await page.reload(); await expect(project.getByText("Running", { exact: true })).toBeVisible();
  const restart = await fetch("http://127.0.0.1:3199/restart", { method: "POST", headers: { authorization: `Bearer ${fixture.controlToken}` } });
  expect(restart.status).toBe(204);
  await expect.poll(async () => await fetch("http://127.0.0.1:3100/").then((response) => response.status).catch(() => 0), {
    timeout: 30_000
  }).toBe(200);
  const browserContext = page.context();
  await page.close();
  let recoveredPage = await browserContext.newPage();
  await gotoProject(recoveredPage, fixture.projectId);
  let recovered = recoveredPage.locator("main.workbench");
  let recoveredTaskGetRequests = 0;
  recoveredPage.on("request", (request) => {
    if (request.method() === "GET" && request.url().endsWith(`/api/projects/${fixture.projectId}/tasks`)) recoveredTaskGetRequests += 1;
  });
  await expect(recovered).toBeVisible();
  await expect(recovered.locator(".runtime-chip.running")).toHaveText("Running");
  await expect(recovered.locator(".workbench-sidebar")).toContainText("Terminals");
  await recovered.getByRole("button", { name: "Stop environment" }).click();
  await expect(recovered.getByText("Stopped", { exact: true })).toBeVisible({ timeout: 120_000 });
  const stoppedRestart = await fetch("http://127.0.0.1:3199/restart", { method: "POST", headers: { authorization: `Bearer ${fixture.controlToken}` } });
  expect(stoppedRestart.status).toBe(204);
  await expect.poll(async () => await fetch("http://127.0.0.1:3100/").then((response) => response.status).catch(() => 0), { timeout: 30_000 }).toBe(200);
  await expect.poll(async () => await fetch(`http://127.0.0.1:3100/projects/${fixture.projectId}`).then((response) => response.status).catch(() => 0), {
    timeout: 30_000
  }).toBe(200);
  await gotoProject(recoveredPage, fixture.projectId);
  await expect(recovered.locator(".runtime-chip.stopped")).toHaveText("Stopped");
  await recovered.getByRole("button", { name: "Start environment" }).click();
  await expect(recovered.getByText("Running", { exact: true })).toBeVisible({ timeout: 120_000 });

  const runtimeDatabase = new BetterSqlite3(fixture.databasePath, { readonly: true });
  const runtimeRows = runtimeDatabase.prepare<RuntimeRow>("select runtime_generation, desired_state, observed_state from runtime_stacks").all();
  const serviceRows = runtimeDatabase.prepare<ServiceRow>("select desired_state, observed_state from workspace_services where kind = 'development'").all();
  runtimeDatabase.close();
  expect(runtimeRows).toEqual([{ runtime_generation: 1, desired_state: "running", observed_state: "running" }]);
  expect(serviceRows).toEqual([{ desired_state: "running", observed_state: "running" }]);

  await expect(recovered.getByRole("button", { name: "Create terminal", exact: true })).toBeEnabled();
  await recovered.getByRole("button", { name: "Create terminal", exact: true }).click();
  await expect(recovered.locator(".terminal-list li").filter({ hasText: "Terminal 1" })).toContainText("active", { timeout: 30_000 });
  const terminal = recovered.locator(".terminal-tab-surface.is-active");
  await terminal.locator(".xterm-helper-textarea").focus();
  await recoveredPage.keyboard.type("echo terminal-e2e-ok"); await recoveredPage.keyboard.press("Enter");
  await expect(terminal.getByText(/terminal-e2e-ok/u)).toBeVisible();
  await recoveredPage.setViewportSize({ width: 800, height: 700 });
  const terminalDatabase = new BetterSqlite3(fixture.databasePath, { readonly: true });
  const terminalRow = terminalDatabase.prepare<TerminalRow>("select id from terminal_sessions order by created_at desc limit 1").get();
  terminalDatabase.close();
  if (terminalRow === undefined) throw new Error("The terminal row was not persisted.");
  const terminalUrl = `ws://127.0.0.1:3100/api/projects/${fixture.projectId}/workspaces/${workspaces[0].id}/terminals/${terminalRow.id}/stream`;
  await expect(rejectedWebSocket(terminalUrl, "http://cross-origin.invalid")).resolves.toBe(400);
  await expect(rejectedWebSocket(terminalUrl, "http://127.0.0.1:3100")).resolves.toBe(409);
  await expect.poll(async () => {
    const snapshot = await fetch("http://127.0.0.1:3199/docker-snapshot", { headers: { authorization: `Bearer ${fixture.controlToken}` } })
      .then(async (response) => await response.json()) as { execs: Array<{ command: string[]; rows: number; columns: number }> };
    const shell = snapshot.execs.find((item) => item.command.at(-1) === "/bin/sh");
    return shell === undefined ? "missing" : `${shell.columns}x${shell.rows}`;
  }).not.toBe("80x24");
  await recovered.getByRole("button", { name: "Create terminal tab" }).click();
  await expect(recovered.getByRole("tab", { name: "Terminal 2" })).toBeVisible();
  await recovered.getByRole("tab", { name: "Terminal 1" }).click();
  await expect(recovered.locator(".terminal-list li").filter({ hasText: "Terminal 1" })).toContainText("active");
  await expect(recovered.locator(".terminal-tab-surface.is-active")).toContainText("terminal-e2e-ok");
  await recovered.getByRole("button", { name: "Close Terminal 1" }).click();
  const detachedTerminal = recovered.locator(".terminal-list li").filter({ hasText: "Terminal 1" });
  await expect(detachedTerminal).toContainText("disconnected");
  await detachedTerminal.getByRole("button").click();
  await expect(recovered.locator(".terminal-tab-surface.is-active")).toBeVisible();
  const webRestart = await fetch("http://127.0.0.1:3199/restart-web", { method: "POST", headers: { authorization: `Bearer ${fixture.controlToken}` } });
  expect(webRestart.status).toBe(204);
  await recoveredPage.close(); recoveredPage = await browserContext.newPage(); await gotoProject(recoveredPage, fixture.projectId);
  recovered = recoveredPage.locator("main.workbench");
  await expect(recovered.locator(".terminal-list li").filter({ hasText: "disconnected" }).first()).toBeVisible({ timeout: 30_000 });
  await recovered.locator(".terminal-list li").filter({ hasText: "disconnected" }).first().getByRole("button").click();
  await expect(recovered.locator(".terminal-list li").filter({ hasText: "active" }).first()).toBeVisible();
  const agentRestart = await fetch("http://127.0.0.1:3199/restart-agent", { method: "POST", headers: { authorization: `Bearer ${fixture.controlToken}` } });
  expect(agentRestart.status).toBe(204);
  const executionOwnershipDirectory = path.join(fixture.managedRoot, "state", "ownership", "executions");
  const executionOwnershipEntries = await readdir(executionOwnershipDirectory);
  expect(executionOwnershipEntries.every((entry) => entry.endsWith(".json"))).toBe(true);
  await expect.poll(async () => await fetch(`http://127.0.0.1:3100/projects/${fixture.projectId}`).then((response) => response.status).catch(() => 0), {
    timeout: 30_000
  }).toBe(200);
  await gotoProject(recoveredPage, fixture.projectId);
  await expect(recoveredPage.getByRole("status").filter({ hasText: "Agent connected" })).toBeVisible({ timeout: 30_000 });
  await expect(recovered.locator(".terminal-list li").filter({ hasText: "lost" })).toHaveCount(0);
  await recovered.getByRole("button", { name: "Create terminal tab" }).click();
  await expect(recovered.locator(".terminal-list li").filter({ hasText: "active" }).first()).toBeVisible({ timeout: 30_000 });
  const replacementDatabase = new BetterSqlite3(fixture.databasePath, { readonly: true });
  const terminalRows = replacementDatabase.prepare<TerminalRow>("select id, state from terminal_sessions order by created_at desc, id desc").all();
  replacementDatabase.close();
  expect(terminalRows.length).toBeGreaterThanOrEqual(2);
  expect(terminalRows[0]?.id).not.toBe(terminalRow.id);
  expect(terminalRows.find((row) => row.id === terminalRow.id)?.state).toBe("lost");

  await gotoProject(recoveredPage, fixture.projectId);
  recovered = recoveredPage.locator("main.workbench");
  await expect(recovered.locator(".terminal-list li").filter({ hasText: "lost" })).toHaveCount(0);

  await recovered.locator(".sidebar-task-list li").filter({ hasText: "Check workspace" }).getByRole("button", { name: "Run" }).click();
  await expect(recovered.getByText("passed", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(recovered.locator(".sidebar-task-runs")).toContainText("Exit code: 0");
  expect(recoveredTaskGetRequests).toBeGreaterThan(0);
  const taskWebRestart = await fetch("http://127.0.0.1:3199/restart-web", { method: "POST", headers: { authorization: `Bearer ${fixture.controlToken}` } });
  expect(taskWebRestart.status).toBe(204);
  await recoveredPage.close(); recoveredPage = await browserContext.newPage(); await gotoProject(recoveredPage, fixture.projectId);
  recovered = recoveredPage.locator("main.workbench");
  await expect(recovered.locator(".sidebar-task-runs").filter({ hasText: "check" }).getByText("passed", { exact: true })).toBeVisible({ timeout: 30_000 });
});
