import { expect, test, type Page } from "@playwright/test";

type MonacoRuntimeDiagnostic = {
  readonly status: string;
  readonly expectedRuntime: string;
  readonly resolvedRuntime: string;
  readonly identityMatches: boolean;
};

test.describe.configure({ timeout: 300_000 });

async function createReadyProject(page: Page, label: string): Promise<{ projectId: string; workbench: ReturnType<Page["locator"]> }> {
  const slug = `${label.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}-${Date.now().toString(36)}`;
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Agent connected" })).toBeVisible();
  await page.getByRole("textbox", { name: /Repository URL/u }).fill("https://127.0.0.1:3443/repository.git");
  await page.getByLabel("Project name").fill(label);
  await page.getByLabel("Project slug").fill(slug);
  await page.getByRole("button", { name: "Inspect and register" }).click();

  const projectCard = page.locator("article", { has: page.getByRole("heading", { name: label }) });
  await expect(projectCard.getByRole("link", { name: "Open project" })).toBeVisible({ timeout: 30_000 });
  const projectHref = await projectCard.getByRole("link", { name: "Open project" }).getAttribute("href");
  if (projectHref === null) throw new Error("The project link is missing.");
  const projectId = projectHref.split("/").pop();
  if (projectId === undefined || projectId === "") throw new Error("The project ID is missing.");

  await projectCard.getByRole("link", { name: "Open project" }).click();
  const workbench = page.locator("main.workbench");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await workbench.count() === 0) {
      const projectPage = page.locator("main");
      await projectPage.getByLabel("Development container image").fill("node:24-bookworm");
      await projectPage.getByRole("button", { name: "Set up primary workspace" }).click();
    }
    try {
      await expect(workbench).toBeVisible({ timeout: 60_000 });
      return { projectId, workbench };
    } catch (error) {
      if (attempt === 2) throw error;
      await page.reload();
    }
  }
  throw new Error("The Workbench did not become visible.");
}

async function openReadme(page: Page): Promise<ReturnType<Page["locator"]>> {
  await page.getByRole("button", { name: "README.md", exact: true }).click();
  const surface = page.locator(".editor-tab-surface:not(.is-inactive)");
  await expect(surface.getByRole("textbox", { name: "Editor content" })).toBeVisible({ timeout: 60_000 });
  return surface;
}

async function replaceEditorText(page: Page, content: string): Promise<void> {
  const input = page.locator(".editor-tab-surface:not(.is-inactive)").getByRole("textbox", { name: "Editor content" });
  await expect(input).toBeVisible({ timeout: 60_000 });
  await input.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(content);
}

async function runtimeDiagnostic(page: Page): Promise<MonacoRuntimeDiagnostic | null> {
  const value: unknown = await page.evaluate(() => {
    const browserGlobal = globalThis as typeof globalThis & { __DEVSPACE_MONACO_RUNTIME__?: unknown };
    return browserGlobal.__DEVSPACE_MONACO_RUNTIME__ ?? null;
  });
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.status !== "string" || typeof record.expectedRuntime !== "string" || typeof record.resolvedRuntime !== "string"
    || typeof record.identityMatches !== "boolean") return null;
  return {
    status: record.status,
    expectedRuntime: record.expectedRuntime,
    resolvedRuntime: record.resolvedRuntime,
    identityMatches: record.identityMatches
  };
}

async function diffModelUris(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const browserGlobal = globalThis as typeof globalThis & { __DEVSPACE_MONACO_RUNTIME__?: { getModelUris?: () => unknown } };
    const uris = browserGlobal.__DEVSPACE_MONACO_RUNTIME__?.getModelUris?.();
    return Array.isArray(uris) && uris.every((uri): uri is string => typeof uri === "string") ? uris : [];
  });
}

test("preserves exact unsaved text through a forced EditorTab remount and repeated mode toggles", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  const { projectId } = await createReadyProject(page, "Editor Ownership");
  let reads = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/projects/${projectId}/files` && url.searchParams.get("action") === "read") reads += 1;
  });
  const surface = await openReadme(page);
  const content = "unsaved editor ownership survives every presentation remount\n";
  await replaceEditorText(page, content);
  await expect(surface.getByText("Unsaved changes", { exact: true })).toBeVisible();

  await page.evaluate(() => {
    const browserGlobal = globalThis as typeof globalThis & { Event: new (type: string) => unknown; dispatchEvent: (event: unknown) => boolean };
    browserGlobal.dispatchEvent(new browserGlobal.Event("devspace:test:remount-editor"));
  });
  await expect(surface).toHaveAttribute("data-editor-remount-count", "2");
  await expect(surface.getByText("Unsaved changes", { exact: true })).toBeVisible();
  await expect.poll(async () => (await surface.locator(".view-lines").allTextContents()).join("\n").replaceAll("\u00a0", " ")).toContain(content.trim());

  for (let index = 0; index < 3; index += 1) {
    await surface.getByRole("button", { name: "Changes", exact: true }).click();
    await surface.getByRole("button", { name: "Edit", exact: true }).click();
  }
  await expect(surface.getByText("Unsaved changes", { exact: true })).toBeVisible();
  await expect.poll(async () => (await surface.locator(".view-lines").allTextContents()).join("\n").replaceAll("\u00a0", " ")).toContain(content.trim());
  expect(reads).toBe(1);
  expect(pageErrors.map((error) => error.message)).toEqual([]);
});

test("shows unsaved Git guidance without fabricating a worktree diff", async ({ page }) => {
  await createReadyProject(page, "Unsaved Git Guidance");
  const surface = await openReadme(page);
  await replaceEditorText(page, "this is only in the unsaved editor buffer\n");
  await expect(surface.getByText("Unsaved changes", { exact: true })).toBeVisible();
  await expect(page.getByText("Save this file to see your edits in Git Changes.", { exact: true })).toBeVisible();
  await expect(page.getByText("Working tree clean.", { exact: true })).toBeVisible();
  await expect(page.locator(".git-change-file")).toHaveCount(0);
});

test("owns actual diff models through kind transitions and close without page errors", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await createReadyProject(page, "Diff Ownership");
  const surface = await openReadme(page);
  await replaceEditorText(page, "saved worktree change for diff lifecycle\n");
  await surface.getByRole("button", { name: "Save", exact: true }).click();
  await expect(surface.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
  await replaceEditorText(page, "additional unsaved editor content\n");
  await expect(surface.getByText("Unsaved changes", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Changes", exact: true }).first().click();
  const changedFile = page.locator(".git-change-file", { hasText: "README.md" }).first();
  await expect(changedFile).toBeVisible({ timeout: 30_000 });
  await changedFile.click();
  await expect(surface.locator("[data-devspace-diff-editor] .monaco-diff-editor")).toHaveCount(1, { timeout: 60_000 });
  await expect.poll(async () => (await diffModelUris(page)).filter((uri) => uri.includes("/diff/")).length).toBe(2);
  await expect.poll(async () => (await surface.locator(".view-lines").allTextContents()).join("\n").replaceAll("\u00a0", " ")).toContain("saved worktree change for diff lifecycle");

  await page.locator(".git-change-group").filter({ hasText: "Changes" }).getByRole("button", { name: "Stage", exact: true }).click();
  const stagedFile = page.locator(".git-change-group").filter({ hasText: "Staged Changes" }).locator(".git-change-file");
  await expect(stagedFile).toHaveCount(1, { timeout: 30_000 });
  await stagedFile.click();
  await expect.poll(async () => (await diffModelUris(page)).filter((uri) => uri.includes("/diff/staged/")).length).toBe(2);

  await surface.getByRole("button", { name: "Edit", exact: true }).click();
  await expect.poll(async () => (await diffModelUris(page)).filter((uri) => uri.includes("/diff/")).length).toBe(0);
  await surface.getByRole("button", { name: "Changes", exact: true }).click();
  await expect(surface.locator("[data-devspace-diff-editor] .monaco-diff-editor")).toHaveCount(1, { timeout: 60_000 });
  await expect.poll(async () => (await diffModelUris(page)).filter((uri) => uri.includes("/diff/")).length).toBe(2);
  await surface.getByRole("button", { name: "Edit", exact: true }).click();
  await expect.poll(async () => (await diffModelUris(page)).filter((uri) => uri.includes("/diff/")).length).toBe(0);
  await page.getByRole("button", { name: "Close README.md", exact: true }).click();
  await expect.poll(async () => (await diffModelUris(page)).filter((uri) => uri.includes("/diff/")).length).toBe(0);
  expect(pageErrors.map((error) => error.message)).toEqual([]);
});

test("resolves local Monaco before the Workbench editor starts and never requests jsDelivr Monaco", async ({ page }) => {
  const cdnRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("cdn.jsdelivr.net") && request.url().includes("monaco")) cdnRequests.push(request.url()); });
  await createReadyProject(page, "Local Monaco Runtime");
  await openReadme(page);
  await expect.poll(async () => await runtimeDiagnostic(page)).toMatchObject({
    status: "ready", expectedRuntime: "local", resolvedRuntime: "local", identityMatches: true
  });
  expect(cdnRequests).toEqual([]);
});
