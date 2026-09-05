import { expect, test } from "@playwright/test";

test("registers and reloads a persisted project through the real Web and Agent socket", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "DevSpace" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Agent connected" })).toBeVisible();
  await page.getByRole("textbox", { name: /Repository URL/u }).fill("https://127.0.0.1:3443/repository.git");
  await page.getByLabel("Project name").fill("Rocket");
  await page.getByLabel("Project slug").fill("rocket");
  await page.getByRole("button", { name: "Inspect and register" }).click();
  let project = page.locator("article", { has: page.getByRole("heading", { name: "Rocket" }) });
  await expect(project.getByRole("heading", { name: "Rocket" })).toBeVisible();
  await expect(project.getByText("Registered — workspace setup pending")).toBeVisible();
  await expect(project.getByRole("link", { name: "Open project" })).toBeVisible();
  await page.reload();
  project = page.locator("article", { has: page.getByRole("heading", { name: "Rocket" }) });
  await expect(project.getByRole("heading", { name: "Rocket" })).toBeVisible();
  await expect(project.getByText("Registered — workspace setup pending")).toBeVisible();
});

test("keeps unconfigured GitHub App selection inside the unified Add Project surface", async ({ page }) => {
  await page.goto("/");
  const form = page.locator("section.form-card", { has: page.getByRole("heading", { name: "Add Project" }) });
  await form.getByRole("radio", { name: "Connected GitHub repository" }).check();
  await expect(form.getByText("GitHub App access has not been configured by the administrator")).toBeVisible();
  await expect(form.getByRole("textbox", { name: /Repository URL/u })).toHaveCount(0);
  await expect(form.getByRole("button", { name: /clone|create project|disconnect/i })).toHaveCount(0);
});
