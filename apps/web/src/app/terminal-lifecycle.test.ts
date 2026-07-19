import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { isTerminalAttachableState, isTerminalVisibleState, reconcileTerminalState, terminalSocketCloseAction, terminalUiState } from "./terminal-lifecycle.js";

describe("terminal lifecycle reconciliation", () => {
  test.each(["creating", "closing", "closed", "failed", "lost"])("does not treat %s as attachable", (state) => {
    expect(isTerminalAttachableState(state)).toBe(false);
    expect(reconcileTerminalState(state, "active")).toMatchObject({ state, closeAttachment: true });
  });

  test.each(["lost", "failed", "closed"])("server-reconciled %s wins over a mounted attachment", (state) => {
    expect(reconcileTerminalState(state, "active")).toEqual({ state, closeAttachment: true });
  });

  test("active and disconnected are the only states eligible for a new attachment", () => {
    expect(isTerminalAttachableState("active")).toBe(true);
    expect(isTerminalAttachableState("disconnected")).toBe(true);
    expect(terminalUiState("active")).toBe("disconnected");
  });

  test.each(["closed", "failed", "lost"])("does not keep %s in the normal terminal list", (state) => {
    expect(isTerminalVisibleState(state)).toBe(false);
  });

  test("keeps creating visible but never attachable", () => {
    expect(isTerminalVisibleState("creating")).toBe(true);
    expect(isTerminalAttachableState("creating")).toBe(false);
  });

  test("refreshes after process exit or intentional detach, without reconnecting an ended socket", () => {
    expect(terminalSocketCloseAction({ terminalEnded: true, cancelled: false, terminalState: "active", closeCode: 1000 })).toBe("refresh");
    expect(terminalSocketCloseAction({ terminalEnded: false, cancelled: true, terminalState: "active", closeCode: 1000 })).toBe("refresh");
    expect(terminalSocketCloseAction({ terminalEnded: false, cancelled: true, terminalState: "lost", closeCode: 1000 })).toBe("ignore");
    expect(terminalSocketCloseAction({ terminalEnded: false, cancelled: false, terminalState: "active", closeCode: 1006 })).toBe("reconnect");
  });

  test("keeps the Workbench terminal surface bounded for responsive xterm fitting", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toContain(".terminal-tab-surface { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }");
    expect(css).toContain(".terminal-tab-surface .terminal-canvas { flex: 1 1 auto; height: auto; min-height: 0; min-width: 0; overflow: hidden; }");
    expect(css).toContain(".terminal-tab-surface .terminal-canvas .xterm-viewport { max-height: 100%; max-width: 100%; overflow-x: hidden; overflow-y: auto; }");
  });
});
