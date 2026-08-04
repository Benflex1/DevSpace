import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("runs the fake-provider AI session through refresh and stop", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = JSON.parse(await readFile(".cache/e2e-runtime.json", "utf8")) as { projectId: string };
  await page.goto("/");
  const card = page.locator("article", { has: page.getByRole("heading", { name: "Managed Fixture" }) });
  if (await card.count() > 0) await card.getByRole("link", { name: "Open project" }).click();
  else await page.goto(`/projects/${fixture.projectId}`);
  const project = page.locator("main");
  const setup = project.getByRole("button", { name: "Set up primary workspace" });
  if (await setup.count() > 0) {
    await project.getByLabel("Development container image").fill("node:24-bookworm");
    await setup.click();
  }
  const workbench = page.locator("main.workbench");
  await expect(workbench).toBeVisible();
  const startRuntime = project.getByRole("button", { name: "Start runtime" });
  if (await startRuntime.count() > 0) {
    await startRuntime.click();
    await expect(project.getByText("Running", { exact: true })).toBeVisible({ timeout: 120_000 });
  }
  await workbench.getByRole("button", { name: /AI/ }).click();
  const ai = page.locator(".ai-tab-surface");
  await expect(ai.getByText("Start an AI session")).toBeVisible();
  await ai.getByRole("button", { name: "Create session" }).click();
  await expect(ai.getByRole("button", { name: "Stop AI session" })).toBeVisible();
  await ai.getByLabel("AI prompt").fill("Create a file named devspace-ai-beta-check.txt containing exactly: DevSpace AI beta check");
  await ai.getByRole("button", { name: "Send", exact: true }).click();
  await expect(ai.getByText("Hello from the deterministic provider.")).toBeVisible();
  await expect(ai.getByText("Changed files")).toBeVisible();
  await expect(ai.locator("code").filter({ hasText: "devspace-ai-beta-check.txt" })).toBeVisible();
  await page.reload();
  await page.locator("main.workbench").getByRole("button", { name: /AI/ }).click();
  const refreshed = page.locator(".ai-tab-surface");
  await expect(refreshed.getByText("Hello from the deterministic provider.")).toBeVisible();
  await refreshed.getByLabel("AI prompt").fill("long");
  await refreshed.getByRole("button", { name: "Send", exact: true }).click();
  await expect(refreshed.getByRole("button", { name: "Interrupt active turn" })).toBeVisible();
  await refreshed.getByRole("button", { name: "Interrupt active turn" }).click();
  await expect(refreshed.getByText("interrupted", { exact: true })).toBeVisible();
  await refreshed.getByRole("button", { name: "Stop AI session" }).click();
  await expect(refreshed.getByText("stopped", { exact: true })).toBeVisible();
});
