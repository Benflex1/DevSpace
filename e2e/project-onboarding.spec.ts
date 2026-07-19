import { expect, test } from "@playwright/test";

test("registers and reloads a persisted project through the real Web and Agent socket", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "DevSpace" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Agent connected" })).toBeVisible();
  await page.getByLabel("Repository URL").fill("https://127.0.0.1:3443/repository.git");
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
