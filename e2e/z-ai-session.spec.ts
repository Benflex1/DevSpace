import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("runs the fake-provider AI session through interactions, navigation, refresh, and stop", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = JSON.parse(await readFile(".cache/e2e-runtime.json", "utf8")) as { projectId: string };
  await page.goto(`/projects/${fixture.projectId}`);
  const project = page.locator("main");
  const workbench = page.locator("main.workbench");
  for (let attempt = 0; attempt < 3 && await workbench.count() === 0; attempt += 1) {
    const setup = project.getByRole("button", { name: "Set up primary workspace" });
    if (await setup.count() > 0) {
      await project.getByLabel("Development container image").fill("node:24-bookworm");
      await setup.click();
    }
    await expect(workbench).toBeVisible({ timeout: 60_000 });
  }
  await expect(workbench).toBeVisible();
  const startRuntime = project.getByRole("button", { name: "Start runtime" });
  if (await startRuntime.count() > 0) {
    await startRuntime.click();
    await expect(project.getByText("Running", { exact: true })).toBeVisible({ timeout: 120_000 });
  }
  await workbench.getByRole("button", { name: /AI/ }).click();
  const ai = page.locator(".ai-tab-surface");
  await expect(ai.getByText("Start an AI session")).toBeVisible({ timeout: 60_000 });
  await ai.getByRole("button", { name: "Create session" }).click();
  await expect(ai.getByRole("button", { name: "Stop AI session" })).toBeVisible();
  const sessionSelect = ai.getByLabel("Session", { exact: true });
  const firstSessionId = await sessionSelect.inputValue();

  await ai.getByLabel("AI prompt").fill("approval");
  await ai.getByRole("button", { name: "Send", exact: true }).click();
  await expect(ai.getByText("Codex needs approval", { exact: true })).toBeVisible();
  await expect(ai.getByText("printf 'DevSpace approval'", { exact: true })).toBeVisible();
  await expect(ai.getByText("Risk: read", { exact: true })).toBeVisible();
  await ai.getByRole("button", { name: "Approve once" }).click();
  await expect(ai.getByText("The approved command completed.", { exact: true })).toBeVisible();
  await expect(ai.getByRole("button", { name: "Approve once" })).toHaveCount(0);

  await ai.getByLabel("AI prompt").fill("approval");
  await ai.getByRole("button", { name: "Send", exact: true }).click();
  await expect(ai.getByRole("button", { name: "Deny" })).toBeVisible();
  await ai.getByRole("button", { name: "Deny" }).click();
  await expect(ai.getByText("The command was denied.", { exact: true })).toBeVisible();

  await ai.getByLabel("AI prompt").fill("question");
  await ai.getByRole("button", { name: "Send", exact: true }).click();
  await expect(ai.getByText("Codex has questions", { exact: true })).toBeVisible();
  await ai.getByRole("radio", { name: /Safe/u }).check();
  await ai.getByRole("textbox", { name: "Reason" }).fill("The bounded fixture is safe.");
  await ai.getByRole("button", { name: "Submit answers" }).click();
  await expect(ai.getByText("Thanks, I will continue with those answers.", { exact: true })).toBeVisible();

  await ai.getByLabel("AI prompt").fill("Create a file named devspace-ai-beta-check.txt containing exactly: DevSpace AI beta check");
  await ai.getByRole("button", { name: "Send", exact: true }).click();
  await expect(ai.getByText("Hello from the deterministic provider.")).toBeVisible();
  await expect(ai.getByText("Changed files")).toBeVisible();
  await expect(ai.locator("code").filter({ hasText: "devspace-ai-beta-check.txt" })).toBeVisible();
  await ai.getByRole("button", { name: "Open in Workbench" }).click();
  await expect(page.locator('section[aria-label="Editor for devspace-ai-beta-check.txt"][aria-hidden="false"]')).toBeVisible();

  await page.reload();
  await page.locator("main.workbench").getByRole("button", { name: /AI/ }).click();
  const refreshed = page.locator(".ai-tab-surface");
  await expect(refreshed.getByText("Hello from the deterministic provider.")).toBeVisible();
  await expect(refreshed.getByText("Some older interaction history is omitted", { exact: false })).toHaveCount(0);
  await expect(refreshed.getByRole("button", { name: "Approve once" })).toHaveCount(0);

  await refreshed.getByRole("button", { name: "Stop AI session" }).click();
  await expect(refreshed.getByText("stopped", { exact: true })).toBeVisible();
  await expect(refreshed.getByRole("button", { name: "New session" })).toBeEnabled();
  await refreshed.getByRole("button", { name: "New session" }).click();
  await expect(refreshed.getByRole("button", { name: "Stop AI session" })).toBeVisible();
  const secondSessionId = await refreshed.getByLabel("Session", { exact: true }).inputValue();
  expect(secondSessionId).not.toBe(firstSessionId);
  await expect(refreshed.getByRole("button", { name: "Live session exists" })).toBeVisible();
  await refreshed.getByLabel("Session", { exact: true }).selectOption(firstSessionId);
  await expect(refreshed.getByText("The approved command completed.", { exact: true })).toBeVisible();
  await refreshed.getByLabel("Session", { exact: true }).selectOption(secondSessionId);

  await refreshed.getByLabel("AI prompt").fill("long");
  await refreshed.getByRole("button", { name: "Send", exact: true }).click();
  await expect(refreshed.getByRole("button", { name: "Interrupt active turn" })).toBeVisible();
  await refreshed.getByRole("button", { name: "Interrupt active turn" }).click();
  await expect(refreshed.getByText("interrupted", { exact: true })).toBeVisible();
  await refreshed.getByRole("button", { name: "Stop AI session" }).click();
  await expect(refreshed.getByText("stopped", { exact: true })).toBeVisible();
});
