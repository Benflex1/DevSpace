import { describe, expect, test } from "vitest";
import {
  activateWorkbenchTab, closeWorkbenchTab, closeWorkbenchTabsForTerminalIds, editorTab, emptyWorkbenchTabs, openWorkbenchTab, previewTabId, terminalTabId, type WorkbenchTab
} from "./workbench-tabs.js";

const terminal = (id: string): WorkbenchTab => ({ id: terminalTabId(id), kind: "terminal", terminalId: id, title: `Terminal ${id}` });
const editor = (path: string): WorkbenchTab => editorTab(path);

describe("Workbench tab state", () => {
  test("uses stable terminal identity and preserves ordered tabs", () => {
    const first = terminal("one");
    const second = terminal("two");
    const state = openWorkbenchTab(openWorkbenchTab(emptyWorkbenchTabs, first), second);
    expect(first.id).toBe("terminal:one");
    expect(state.tabs.map((tab) => tab.id)).toEqual(["terminal:one", "terminal:two"]);
    expect(state.activeTabId).toBe("terminal:two");
  });

  test("activates an existing tab instead of duplicating it", () => {
    const state = openWorkbenchTab(openWorkbenchTab(emptyWorkbenchTabs, terminal("one")), terminal("one"));
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe("terminal:one");
  });

  test("deduplicates preview tabs by preview identity and closes to the adjacent tab", () => {
    const preview: WorkbenchTab = { id: previewTabId("preview-one"), kind: "preview", previewId: "preview-one" };
    const state = openWorkbenchTab(openWorkbenchTab(emptyWorkbenchTabs, terminal("one")), preview);
    const deduplicated = openWorkbenchTab(state, { ...preview });
    expect(deduplicated.tabs.map((tab) => tab.id)).toEqual(["terminal:one", "preview:preview-one"]);
    expect(deduplicated.activeTabId).toBe("preview:preview-one");
    expect(closeWorkbenchTab(deduplicated, preview.id).activeTabId).toBe("terminal:one");
  });

  test("activates only known tabs", () => {
    const state = openWorkbenchTab(emptyWorkbenchTabs, terminal("one"));
    expect(activateWorkbenchTab(state, "terminal:missing")).toBe(state);
    expect(activateWorkbenchTab(state, "terminal:one").activeTabId).toBe("terminal:one");
  });

  test("falls back to the next tab, then the previous tab, when closing active tab", () => {
    const state = openWorkbenchTab(openWorkbenchTab(openWorkbenchTab(emptyWorkbenchTabs, terminal("one")), terminal("two")), terminal("three"));
    expect(closeWorkbenchTab(state, "terminal:two").activeTabId).toBe("terminal:three");
    expect(closeWorkbenchTab(closeWorkbenchTab(state, "terminal:two"), "terminal:three").activeTabId).toBe("terminal:one");
    expect(closeWorkbenchTab(state, "terminal:one").activeTabId).toBe("terminal:three");
  });

  test("closes lost-terminal tabs without closing unrelated tabs", () => {
    const state = openWorkbenchTab(openWorkbenchTab(openWorkbenchTab(emptyWorkbenchTabs, terminal("lost-1")), terminal("healthy")), terminal("lost-2"));
    const next = closeWorkbenchTabsForTerminalIds(state, ["lost-1", "lost-2"]);
    expect(next.tabs.map((tab) => tab.id)).toEqual(["terminal:healthy"]);
    expect(next.activeTabId).toBe("terminal:healthy");
  });

  test("uses stable editor identity and focuses an already-open file", () => {
    const first = editor("src/index.ts");
    const state = openWorkbenchTab(openWorkbenchTab(emptyWorkbenchTabs, first), editor("src/index.ts"));
    expect(first.id).toBe("editor:src%2Findex.ts");
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(first.id);
  });

  test("closes an editor tab to the adjacent fallback", () => {
    const first = editor("README.md");
    const second = editor("src/index.ts");
    const state = openWorkbenchTab(openWorkbenchTab(emptyWorkbenchTabs, first), second);
    expect(closeWorkbenchTab(state, second.id).activeTabId).toBe(first.id);
  });
});
