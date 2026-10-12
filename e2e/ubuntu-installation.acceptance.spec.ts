import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const exec = promisify(execFile);
const appOrigin = "https://127.0.0.1:3444";

async function authenticatedStatus(pathname: string): Promise<number> {
  const response = await fetch(`${appOrigin}${pathname}`);
  return response.status;
}

test("fresh installation completes project, workspace, terminal, task, and persistence workflow", async ({ page }) => {
  test.setTimeout(900_000);
  page.on("websocket", (websocket) => {
    const pathname = new URL(websocket.url()).pathname;
    if (!/\/terminals\/[^/]+\/stream$/u.test(pathname)) return;
    console.log(`[installation-browser] terminal websocket opened path=${pathname}`);
    websocket.on("framesent", (frame) => {
      const length = typeof frame.payload === "string" ? Buffer.byteLength(frame.payload) : frame.payload.length;
      console.log(`[installation-browser] terminal websocket sent frame bytes=${length}`);
    });
    websocket.on("framereceived", (frame) => {
      const length = typeof frame.payload === "string" ? Buffer.byteLength(frame.payload) : frame.payload.length;
      console.log(`[installation-browser] terminal websocket received frame bytes=${length}`);
    });
    websocket.on("close", () => console.log("[installation-browser] terminal websocket closed"));
  });
  const unauthenticated = await fetch("http://127.0.0.1:3000/api/projects/00000000-0000-4000-8000-000000000000/runtime");
  expect(unauthenticated.status).toBe(403);

  const pageResponse = await page.goto("/");
  expect(pageResponse?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "DevSpace" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Agent connected" })).toBeVisible();

  const suffix = process.env.GITHUB_RUN_ID ?? `${Date.now()}`;
  const projectName = `Installation Acceptance ${suffix}`;
  const projectSlug = `install-${suffix}`;
  await page.getByRole("textbox", { name: /Repository URL/u }).fill("https://127.0.0.1:3443/repository.git");
  await page.getByLabel("Project name").fill(projectName);
  await page.getByLabel("Project slug").fill(projectSlug);
  const registerResponse = page.waitForResponse((response) => response.url().endsWith("/api/projects")
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Inspect and register" }).click();
  const registered = await registerResponse;
  expect(registered.status()).toBe(201);

  const dashboardProject = page.locator("article", { has: page.getByRole("heading", { name: projectName }) });
  await expect(dashboardProject.getByText("Registered — workspace setup pending")).toBeVisible({ timeout: 120_000 });
  const projectHref = await dashboardProject.getByRole("link", { name: "Open project" }).getAttribute("href");
  if (projectHref === null) throw new Error("The installation acceptance project link is missing.");
  const projectId = projectHref.split("/").pop();
  if (projectId === undefined || projectId === "") throw new Error("The installation acceptance project ID is missing.");
  await dashboardProject.getByRole("link", { name: "Open project" }).click();

  await page.getByLabel("Development container image").fill("mcr.microsoft.com/devcontainers/base:ubuntu-24.04");
  let workspaceId: string | null = null;
  for (let attempt = 0; attempt < 120 && workspaceId === null; attempt += 1) {
    const setupResponsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/projects/${projectId}/setup`)
      && response.request().method() === "POST");
    await page.getByRole("button", { name: "Set up primary workspace" }).click();
    const setupResponse = await setupResponsePromise;
    const setupBody: unknown = await setupResponse.json();
    if (setupResponse.status() === 202) {
      await page.waitForTimeout(5_000);
      continue;
    }
    expect(setupResponse.status()).toBe(200);
    if (setupBody === null || typeof setupBody !== "object" || !("workspace" in setupBody)
      || typeof setupBody.workspace !== "object" || setupBody.workspace === null
      || !("workspaceId" in setupBody.workspace) || typeof setupBody.workspace.workspaceId !== "string") {
      throw new Error("Workspace setup did not return its workspace ID.");
    }
    workspaceId = setupBody.workspace.workspaceId;
  }
  if (workspaceId === null) throw new Error("Primary workspace setup did not finish within ten minutes.");

  const workbench = page.locator("main.workbench");
  await expect(workbench).toBeVisible({ timeout: 120_000 });
  await expect(workbench.locator(".runtime-chip.absent")).toHaveText("Offline");

  await exec("/usr/bin/sudo", ["systemctl", "restart", "devspace-agent.service"], { timeout: 90_000 });
  await exec("/usr/bin/sudo", ["systemctl", "restart", "devspace-web.service"], { timeout: 90_000 });
  await expect.poll(async () => await authenticatedStatus(`/api/projects/${projectId}/runtime`), { timeout: 90_000 }).toBe(200);
  await page.goto(`/projects/${projectId}`);
  await expect(page.locator("main.workbench")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Agent connected" })).toBeVisible();

  await page.getByRole("button", { name: "Start runtime" }).click();
  await expect(page.locator(".runtime-chip.running")).toHaveText("Running", { timeout: 300_000 });
  await expect(page.getByRole("button", { name: "Stop runtime" })).toBeVisible();
  await page.getByRole("button", { name: "Create terminal", exact: true }).click();
  await expect(page.locator(".terminal-list li").first()).toContainText("active", { timeout: 60_000 });
  const firstTerminal = page.locator(".terminal-tab-surface.is-active");
  await firstTerminal.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("pwd; printf 'fresh-host-terminal-ok\\n'; printf 'fresh-host-persistence-ok\\n' > /workspace/install-acceptance.txt");
  await page.keyboard.press("Enter");
  await expect(firstTerminal.getByText(/\/workspace/u)).toBeVisible({ timeout: 30_000 });
  await expect(firstTerminal.getByText(/fresh-host-terminal-ok/u)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Stop runtime" }).click();
  await expect(page.locator(".runtime-chip.stopped")).toHaveText("Stopped", { timeout: 180_000 });
  await page.getByRole("button", { name: "Project Options" }).click();
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByLabel("Task check name")).toHaveValue("Check workspace");
  await page.getByRole("button", { name: "Save Draft" }).click();
  await expect(page.locator(".options-draft-identity")).toContainText("Saved draft", { timeout: 60_000 });
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("button", { name: "Confirm Apply" }).click();
  await expect(page.locator(".options-apply-status.success")).toContainText("Applied", { timeout: 180_000 });

  await page.getByRole("button", { name: "Start runtime" }).click();
  await expect(page.locator(".runtime-chip.running")).toHaveText("Running", { timeout: 300_000 });
  const taskRow = page.locator(".sidebar-task-list li", { hasText: "Check workspace" });
  await taskRow.getByRole("button", { name: "Run", exact: true }).click();
  const taskRuns = page.locator(".sidebar-task-runs");
  await expect(taskRuns).toContainText("succeeded", { timeout: 120_000 });
  await expect(taskRuns).toContainText("Exit code: 0");

  await page.getByRole("button", { name: "Create terminal", exact: true }).click();
  await expect(page.locator(".terminal-list li").filter({ hasText: "Terminal 2" })).toContainText("active", { timeout: 60_000 });
  const secondTerminal = page.locator(".terminal-tab-surface.is-active");
  await secondTerminal.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("cat /workspace/install-acceptance.txt");
  await page.keyboard.press("Enter");
  await expect(secondTerminal.getByText(/fresh-host-persistence-ok/u)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Stop runtime" }).click();
  await expect(page.locator(".runtime-chip.stopped")).toHaveText("Stopped", { timeout: 180_000 });
  const resultFile = process.env.INSTALL_ACCEPTANCE_RESULT_FILE;
  if (resultFile === undefined) throw new Error("INSTALL_ACCEPTANCE_RESULT_FILE is required.");
  await writeFile(resultFile, `${JSON.stringify({ projectId, workspaceId, projectSlug })}\n`, { mode: 0o600 });
});
