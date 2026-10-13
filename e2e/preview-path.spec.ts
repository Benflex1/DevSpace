import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { expect, test } from "@playwright/test";

const coordinationPath = path.resolve(".cache/e2e-runtime.json");
interface Database {
  prepare<Row>(sql: string): { get(...parameters: unknown[]): Row | undefined };
  close(): void;
}
const sqliteModule: unknown = createRequire(path.resolve("apps/web/package.json"))("better-sqlite3");
if (typeof sqliteModule !== "function") throw new Error("better-sqlite3 test dependency is unavailable");
const BetterSqlite3 = sqliteModule as new (filename: string, options: { readonly: boolean }) => Database;
interface Fixture { databasePath: string; projectId: string; controlToken: string; gatewayPort: number }
interface PreviewRow { id: string; workspace_id: string; hostname: string; config_revision_id: string; container_port: number }
interface WorkspaceRow { id: string }
interface DockerSnapshot {
  containerDetails: Array<{ id: string; state: { Running: boolean }; portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> }>;
  appListeners: Array<{ containerId: string; execId: string; containerPort: number; hostPort: number; listening: boolean }>;
}
interface GatewaySnapshot {
  routes: Array<{ projectId: string; workspaceId: string; previewId: string; revisionId: string; generation: number; hostname: string; leaseId: string; hostIp: string; hostPort: number }>;
  probeEvents: Array<{ leaseId: string }>;
}

function parseFixture(value: unknown): Fixture {
  if (value === null || typeof value !== "object") throw new Error("E2E fixture metadata is invalid");
  const record = value as Record<string, unknown>;
  if (typeof record.databasePath !== "string" || typeof record.projectId !== "string" || typeof record.controlToken !== "string"
    || !Number.isInteger(record.gatewayPort)) throw new Error("E2E fixture metadata is incomplete");
  return record as unknown as Fixture;
}

async function control(fixture: Fixture, requestPath: string, method: "GET" | "POST" = "GET"): Promise<Response> {
  return await fetch(`http://127.0.0.1:3199${requestPath}`, { method, headers: { authorization: `Bearer ${fixture.controlToken}` } });
}

async function dockerSnapshot(fixture: Fixture): Promise<DockerSnapshot> {
  return await (await control(fixture, "/docker-snapshot")).json() as DockerSnapshot;
}

async function gatewaySnapshot(fixture: Fixture): Promise<GatewaySnapshot> {
  return await (await control(fixture, "/gateway-snapshot")).json() as GatewaySnapshot;
}

function readWorkspace(fixture: Fixture): WorkspaceRow {
  const database = new BetterSqlite3(fixture.databasePath, { readonly: true });
  try {
    const workspace = database.prepare<WorkspaceRow>("select id from workspaces where project_id = ?").get(fixture.projectId);
    if (workspace === undefined) throw new Error("Workspace seed state is incomplete");
    return workspace;
  } finally { database.close(); }
}

function readPreview(fixture: Fixture): PreviewRow {
  const database = new BetterSqlite3(fixture.databasePath, { readonly: true });
  try {
    const preview = database.prepare<PreviewRow>("select id, workspace_id, hostname, config_revision_id, container_port from previews where preview_key = 'web'").get();
    if (preview === undefined) throw new Error("Preview seed state is incomplete");
    return preview;
  } finally { database.close(); }
}

async function websocketUpgrade(port: number, hostname: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    const finish = () => { socket.destroy(); resolve(data); };
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.includes("hmr-ready:") || data.includes("HTTP/1.1 502")) finish();
    });
    socket.once("connect", () => socket.write(
      `GET /__hmr HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ZGV2c3BhY2U=\r\n\r\n`
    ));
  });
}

async function dismissLostTerminalDialog(page: import("@playwright/test").Page): Promise<void> {
  const dialog = page.locator(".lost-terminal-dialog");
  try {
    await dialog.waitFor({ state: "visible", timeout: 5_000 });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return;
    throw error;
  }

  const dismiss = dialog.getByRole("button", { name: "Dismiss", exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  await dialog.getByRole("button", { name: "Dismiss anyway", exact: true }).click();
  await expect(page.locator(".lost-terminal-dialog-backdrop")).toBeHidden();
}

test("follows the deterministic workspace preview path", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = parseFixture(JSON.parse(await readFile(coordinationPath, "utf8")));
  const workspace = readWorkspace(fixture);

  await page.goto(`/projects/${fixture.projectId}`);
  const project = page.locator("main.workbench");
  await expect(project).toBeVisible();
  const preview = readPreview(fixture);
  const previewUrl = `http://${preview.hostname}:${fixture.gatewayPort}`;
  const previewItem = project.locator(".preview-list li").filter({ hasText: "Web" });
  await expect(previewItem).toContainText("Waiting");

  await project.getByRole("button", { name: "Start runtime" }).click();
  await expect(project.locator(".runtime-chip.running")).toHaveText("Running", { timeout: 30_000 });
  await expect(previewItem).toContainText("Waiting");

  const beforeApplication = await dockerSnapshot(fixture);
  expect(beforeApplication.containerDetails).toHaveLength(1);
  expect(beforeApplication.containerDetails[0]?.state.Running).toBe(true);
  expect(beforeApplication.containerDetails[0]?.portBindings).toEqual({ "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: expect.any(String) }] });
  expect(beforeApplication.appListeners).toEqual([]);
  expect((await page.request.get(previewUrl)).status()).toBe(404);

  await project.getByRole("button", { name: "Create terminal", exact: true }).click();
  await expect(project.locator(".terminal-list li.selected")).toContainText("active", { timeout: 15_000 });
  const terminal = project.locator(".terminal-tab-surface.is-active");
  await terminal.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("pnpm dev");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("preview app listening", { timeout: 15_000 });

  await expect.poll(async () => (await dockerSnapshot(fixture)).appListeners.length, { timeout: 15_000 }).toBe(1);
  const afterApplication = await dockerSnapshot(fixture);
  const listener = afterApplication.appListeners[0];
  const container = afterApplication.containerDetails[0];
  expect(listener).toMatchObject({ containerId: container?.id, containerPort: 3000, listening: true });
  expect(container?.portBindings["3000/tcp"]?.[0]?.HostPort).toBe(String(listener?.hostPort));

  await expect.poll(async () => (await page.request.get(previewUrl)).status(), { timeout: 20_000 }).toBe(200);
  await expect(previewItem).toContainText("Ready", { timeout: 20_000 });
  await dismissLostTerminalDialog(page);
  await previewItem.getByRole("button").click();
  await expect(page.getByRole("tab", { name: "Preview", exact: true })).toHaveCount(1);
  await previewItem.getByRole("button").click();
  await expect(page.getByRole("tab", { name: "Preview", exact: true })).toHaveCount(1);

  const previewTab = project.locator(".preview-tab-surface.is-active");
  await expect(previewTab.locator("iframe.preview-frame")).toBeVisible({ timeout: 15_000 });
  await expect(page.frameLocator("iframe.preview-frame").locator("main")).toContainText(`Workspace preview ${listener?.containerId}`);
  const httpResponse = await page.request.get(previewUrl);
  expect(httpResponse.status()).toBe(200);
  expect(await httpResponse.text()).toContain(`data-preview-container="${listener?.containerId}"`);

  const websocketResponse = await websocketUpgrade(fixture.gatewayPort, preview.hostname);
  expect(websocketResponse).toMatch(/101 Switching Protocols/u);
  expect(websocketResponse).toContain(`hmr-ready:${listener?.containerId}`);
  const gateway = await gatewaySnapshot(fixture);
  expect(gateway.routes).toEqual([expect.objectContaining({ projectId: fixture.projectId, workspaceId: workspace.id,
    previewId: preview.id, revisionId: preview.config_revision_id, hostname: preview.hostname, hostIp: "127.0.0.1", hostPort: listener?.hostPort })]);
  expect(gateway.probeEvents.some((event) => event.leaseId === gateway.routes[0]?.leaseId)).toBe(true);

  expect((await control(fixture, "/restart-agent", "POST")).status).toBe(204);
  await expect.poll(async () => (await page.request.get(previewUrl)).status(), { timeout: 20_000 }).toBe(200);
  await dismissLostTerminalDialog(page);
  expect((await gatewaySnapshot(fixture)).routes).toEqual([expect.objectContaining({
    projectId: fixture.projectId, workspaceId: workspace.id, previewId: preview.id, hostPort: listener?.hostPort
  })]);

  expect((await control(fixture, "/restart-gateway", "POST")).status).toBe(204);
  expect((await gatewaySnapshot(fixture)).routes).toEqual([]);
  await page.reload();
  await expect.poll(async () => (await page.request.get(previewUrl)).status(), { timeout: 20_000 }).toBe(200);
  await expect(previewItem).toContainText("Ready", { timeout: 20_000 });
  await dismissLostTerminalDialog(page);
  await previewItem.getByRole("button").click();
  await expect(page.getByRole("tab", { name: "Preview", exact: true })).toHaveCount(1);
  const reloadedPreviewTab = project.locator(".preview-tab-surface.is-active");

  let reconcileRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/api/projects/${fixture.projectId}/previews`)) reconcileRequests += 1;
  });
  await reloadedPreviewTab.getByRole("button", { name: "Reload" }).click();
  await expect(project.locator(".workbench-message")).toContainText("Preview reconciliation requested.");
  await expect.poll(() => reconcileRequests, { timeout: 10_000 }).toBe(1);
  await expect(reloadedPreviewTab.locator(".preview-state")).toHaveText("Ready", { timeout: 15_000 });

  await project.getByRole("button", { name: "Stop runtime" }).click();
  await expect(project.locator(".runtime-chip.stopped")).toHaveText("Stopped", { timeout: 30_000 });
  await expect(previewItem).not.toContainText("Ready");
  await expect.poll(async () => (await page.request.get(previewUrl)).status(), { timeout: 15_000 }).toBe(404);
  await expect.poll(async () => (await dockerSnapshot(fixture)).appListeners.length, { timeout: 15_000 }).toBe(0);
  const stopped = await dockerSnapshot(fixture);
  expect(stopped.containerDetails[0]?.state.Running).toBe(false);
  expect(stopped.containerDetails[0]?.portBindings["3000/tcp"]?.[0]?.HostPort).toBe(String(listener?.hostPort));
  await expect.poll(async () => (await gatewaySnapshot(fixture)).routes.length, { timeout: 15_000 }).toBe(0);
});
