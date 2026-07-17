import { expect, test } from "@playwright/test";

test("registers and reloads a persisted project through the real Web and Agent socket", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "DevSpace" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Agent connected" })).toBeVisible();
  await page.getByLabel("Repository URL").fill("https://example.com/acme/rocket.git");
  await page.getByLabel("Project name").fill("Rocket");
  await page.getByLabel("Project slug").fill("rocket");
  await page.getByRole("button", { name: "Inspect and register" }).click();
  await expect(page.getByRole("heading", { name: "Rocket" })).toBeVisible();
  await expect(page.getByText("Registered — workspace setup pending")).toBeVisible();
  await expect(page.getByText("main", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Rocket" })).toBeVisible();
  await expect(page.getByText("Registered — workspace setup pending")).toBeVisible();
});
