import { describe, expect, test } from "vitest";
import {
  activateWorkbenchTab, closeWorkbenchTab, emptyWorkbenchTabs, openWorkbenchTab, previewTabId, terminalTabId, type WorkbenchTab
} from "./workbench-tabs.js";

const terminal = (id: string): WorkbenchTab => ({ id: terminalTabId(id), kind: "terminal", terminalId: id, title: `Terminal ${id}` });

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
});
