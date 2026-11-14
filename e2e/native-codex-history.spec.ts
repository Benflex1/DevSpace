import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const nativeSessionId = "018f1f34-7000-7000-8000-000000000401";
const processId = "018f1f34-7000-7000-8000-000000000402";
const olderCursor = "e2e-opaque-codex-history-cursor";

const newestPage = {
  messages: [
    { id: "u-3", role: "user", text: "third fixture prompt", timestamp: "2026-11-13T12:00:03.000Z" },
    { id: "a-3", role: "assistant", text: "third fixture answer", timestamp: "2026-11-13T12:00:04.000Z" }
  ],
  olderCursor,
  olderHistoryTruncated: false,
  snapshot: "settled",
  available: true
};
const olderPage = {
  messages: [
    { id: "u-1", role: "user", text: "first fixture prompt", timestamp: "2026-11-13T11:59:00.000Z" },
    { id: "a-1", role: "assistant", text: "first fixture answer", timestamp: "2026-11-13T11:59:10.000Z" },
    { id: "u-2", role: "user", text: "second fixture prompt", timestamp: "2026-11-13T11:59:30.000Z" },
    { id: "a-2", role: "assistant", text: "second fixture answer", timestamp: "2026-11-13T11:59:40.000Z" }
  ],
  olderCursor: null,
  olderHistoryTruncated: false,
  snapshot: "settled",
  available: true
};

test("Native Codex History reloads from a bounded history fixture after F5 and restores the selected Workbench tab", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = JSON.parse(await readFile(".cache/e2e-runtime.json", "utf8")) as { projectId: string };
  const historyRequests: string[] = [];
  const nativeSessionGets: string[] = [];
  const nativeMutations: string[] = [];

  await page.route("**/api/projects/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const harnessPath = `/api/projects/${fixture.projectId}/harness`;
    if (url.pathname === harnessPath && request.method() === "GET") {
      const workspaceId = url.searchParams.get("workspaceId");
      if (workspaceId === null) { await route.fulfill({ status: 422 }); return; }
      nativeSessionGets.push(workspaceId);
      await route.fulfill({ json: { definitions: [{ id: "codex", displayName: "Codex", origin: "builtin" }], sessions: [{
        id: nativeSessionId, harnessId: "codex", state: "stopped", terminalSessionId: null, processId,
        title: "Codex", processGeneration: 2, resume: true
      }] } });
      return;
    }
    if (url.pathname === `${harnessPath}/${nativeSessionId}/history` && request.method() === "GET") {
      historyRequests.push(url.pathname + url.search);
      await route.fulfill({ json: url.searchParams.has("cursor") ? olderPage : newestPage });
      return;
    }
    if (url.pathname === harnessPath && request.method() !== "GET") nativeMutations.push(request.method());
    await route.continue();
  });

  await page.goto(`/projects/${fixture.projectId}`);
  const workbench = page.locator("main.workbench");
  for (let attempt = 0; attempt < 3 && await workbench.count() === 0; attempt += 1) {
    const setup = page.getByRole("button", { name: "Set up primary workspace" });
    if (await setup.count() > 0) {
      await page.getByLabel("Development container image").fill("node:24-bookworm");
      await setup.click();
    }
    await expect(workbench).toBeVisible({ timeout: 60_000 });
  }
  await expect(workbench).toBeVisible();
  await page.getByRole("button", { name: /AI/ }).click();
  const projectTabs = workbench.getByRole("tablist", { name: "Project tabs" });
  const nativeTab = projectTabs.getByRole("tab", { name: "AI session" });
  await expect(nativeTab).toHaveAttribute("aria-selected", "true");

  const native = page.getByRole("region", { name: "Native harness" });
  const conversation = native.locator(".native-ai-conversation");
  await expect(conversation).toHaveAttribute("data-native-conversation-view", "live");
  await native.getByRole("button", { name: "Earlier conversation", exact: true }).click();
  await expect(conversation).toHaveAttribute("data-native-conversation-view", "history");
  const history = native.getByRole("region", { name: "Codex conversation history" });
  await expect(history.getByText("third fixture prompt", { exact: true })).toBeVisible();
  await expect(history.getByText("third fixture answer", { exact: true })).toBeVisible();
  // Reaching the top of the revealed history pages older messages automatically;
  // the explicit control remains for keyboard and non-wheel navigation.
  await expect(history.getByText("first fixture prompt", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(history.getByText("second fixture answer", { exact: true })).toBeVisible();
  const rendered = await history.locator(".native-conversation-message").allTextContents();
  expect(rendered.join(" ")).toContain("first fixture prompt");
  expect(rendered.join(" ").indexOf("first fixture prompt")).toBeLessThan(rendered.join(" ").indexOf("third fixture prompt"));
  expect(rendered.join(" ")).not.toContain("usage");
  expect(rendered.join(" ")).not.toContain("function_call_output");
  await native.getByRole("button", { name: "Return to live terminal", exact: true }).click();
  await expect(conversation).toHaveAttribute("data-native-conversation-view", "live");
  expect(await page.evaluate(() => {
    const browserGlobal = globalThis as unknown as { readonly localStorage: Storage; readonly sessionStorage: Storage };
    const values = (storage: Storage) => Array.from({ length: storage.length }, (_, index) => {
      const key = storage.key(index);
      return key === null ? "" : `${key}=${storage.getItem(key) ?? ""}`;
    }).join("\n");
    return JSON.stringify({ local: values(browserGlobal.localStorage), session: values(browserGlobal.sessionStorage) });
  })).not.toContain("third fixture prompt");

  await page.reload();
  const reloadedWorkbench = page.locator("main.workbench");
  await expect(reloadedWorkbench).toBeVisible();
  const restoredNativeTab = reloadedWorkbench.getByRole("tablist", { name: "Project tabs" }).getByRole("tab", { name: "AI session" });
  await expect(restoredNativeTab).toHaveAttribute("aria-selected", "true");
  const reloadedNative = page.getByRole("region", { name: "Native harness" });
  await reloadedNative.getByRole("button", { name: "Earlier conversation", exact: true }).click();
  const reloadedHistory = reloadedNative.getByRole("region", { name: "Codex conversation history" });
  await expect(reloadedHistory.getByText("third fixture prompt", { exact: true })).toBeVisible();
  await expect(reloadedHistory.getByText("first fixture prompt", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(reloadedHistory.getByText("second fixture prompt", { exact: true })).toBeVisible();

  expect(nativeSessionGets.length).toBeGreaterThanOrEqual(2);
  expect(new Set(nativeSessionGets).size).toBe(1);
  expect(historyRequests.filter((url) => url.includes("cursor=")).length).toBe(2);
  expect(nativeMutations).toEqual([]);
});
