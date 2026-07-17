import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

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
function parseFixture(value: unknown): Fixture {
  if (value === null || typeof value !== "object") throw new Error("E2E fixture metadata is invalid");
  const record = value as Record<string, unknown>;
  for (const key of ["databasePath", "managedRoot", "projectId", "expectedHead", "controlToken"] as const) {
    if (typeof record[key] !== "string") throw new Error(`E2E fixture ${key} is invalid`);
  }
  return record as unknown as Fixture;
}

test("sets up and recovers the real managed primary workspace", async ({ page }) => {
  const fixtureJson: unknown = JSON.parse(await readFile(coordinationPath, "utf8"));
  const fixture = parseFixture(fixtureJson);
  await page.goto("/");
  const project = page.locator("article", { has: page.getByRole("heading", { name: "Managed Fixture" }) });
  await expect(project.getByText("Registered — workspace setup pending")).toBeVisible();
  await project.getByLabel("Development container image").fill("node:24-bookworm");
  await project.getByRole("button", { name: "Set up primary workspace" }).click();
  await expect(project.getByText("Ready", { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(project.getByText("Active revision v1")).toBeVisible();
  await expect(project.getByText(/Present · [0-9a-f]{12}/u)).toBeVisible();
  await expect(project.getByText("stopped · clean")).toBeVisible();
  await expect(project.getByText("No container created")).toBeVisible();

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
    "configuration-revision.register", "project.fetch", "project.managed-store.create", "workspace.create"
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

  await page.reload(); await expect(project.getByText("Ready", { exact: true })).toBeVisible();
  const restart = await fetch("http://127.0.0.1:3199/restart", { method: "POST", headers: { authorization: `Bearer ${fixture.controlToken}` } });
  expect(restart.status).toBe(204);
  await expect.poll(async () => await fetch("http://127.0.0.1:3100/").then((response) => response.status).catch(() => 0), {
    timeout: 30_000
  }).toBe(200);
  const browserContext = page.context();
  await page.close();
  const recoveredPage = await browserContext.newPage();
  await recoveredPage.goto("/");
  const recovered = recoveredPage.locator("article", { has: recoveredPage.getByRole("heading", { name: "Managed Fixture" }) });
  await expect(recovered.getByText("Ready", { exact: true })).toBeVisible();
  await expect(recovered.getByText("stopped · clean")).toBeVisible();
  await expect(recovered.getByText("No container created")).toBeVisible();
});
