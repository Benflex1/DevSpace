import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { RuntimeControls } from "./runtime-controls.js";
import {
  isTerminalAttachableState, isTerminalOpenableState, isTerminalSidebarVisible, isTerminalVisibleState, LOST_TERMINAL_SIDEBAR_EXPIRY_MS, reconcileTerminalState,
  nativeHarnessTerminalState, removeTerminalCollectionEntries, sortTerminalViewsByTitle, terminalSocketCloseAction, terminalStateMessage, terminalUiState, updateTerminalCollectionState
} from "./terminal-lifecycle.js";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

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

  test("keeps closed output briefly visible without making the terminal live-attachable", () => {
    expect(isTerminalVisibleState("closed")).toBe(true);
    expect(isTerminalOpenableState("closed")).toBe(true);
    expect(isTerminalAttachableState("closed")).toBe(false);
    expect(isTerminalSidebarVisible("closed", 10_000, 10_000)).toBe(true);
    expect(isTerminalSidebarVisible("closed", 10_000, 10_000 + LOST_TERMINAL_SIDEBAR_EXPIRY_MS)).toBe(false);
  });

  test.each([
    ["creating", "active"],
    ["active", "active"],
    ["lost", "lost"],
    ["stopped", "closed"]
  ])("maps native harness state %s to terminal state %s", (sessionState, terminalState) => {
    expect(nativeHarnessTerminalState(sessionState)).toBe(terminalState);
  });

  test("does not keep failed terminals in the normal terminal list", () => {
    expect(isTerminalVisibleState("failed")).toBe(false);
    expect(isTerminalOpenableState("failed")).toBe(false);
  });

  test("keeps a lost terminal visible but never attachable", () => {
    expect(isTerminalVisibleState("lost")).toBe(true);
    expect(isTerminalAttachableState("lost")).toBe(false);
  });

  test("keeps a newly lost terminal visible until the sidebar expiry", () => {
    const lostAt = 10_000;
    expect(isTerminalSidebarVisible("lost", lostAt, lostAt)).toBe(true);
    expect(isTerminalSidebarVisible("lost", lostAt, lostAt + LOST_TERMINAL_SIDEBAR_EXPIRY_MS - 1)).toBe(true);
    expect(isTerminalSidebarVisible("lost", lostAt, lostAt + LOST_TERMINAL_SIDEBAR_EXPIRY_MS)).toBe(false);
  });

  test("never expires active terminals", () => {
    expect(isTerminalSidebarVisible("active", 0, Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isTerminalSidebarVisible("disconnected", undefined, Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  test("explains lost-terminal control boundaries", () => {
    expect(terminalStateMessage("lost")).toContain("Agent restart lost this terminal's PTY attachment");
    expect(terminalStateMessage("lost")).toContain("cannot be reattached");
    expect(terminalStateMessage("lost")).toContain("processes launched here may still be running");
  });

  test("renders lost terminals compactly and delegates recovery to one dialog", async () => {
    const workbench = await readFile(new URL("./project-workbench.tsx", import.meta.url), "utf8");
    const runtimeControls = await readFile(new URL("./runtime-controls.tsx", import.meta.url), "utf8");
    expect(workbench).toContain('terminal.state === "lost"');
    expect(workbench).toContain("<LostTerminalDialog");
    expect(workbench).toContain('role="dialog"');
    expect(workbench).not.toContain("lost-terminal-notice");
    expect(workbench).toContain("onRestartInitiated={handleLostTerminalRestartInitiated}");
    expect(workbench).toContain("onRestartSuccess={handleLostTerminalRestartSuccess}");
    expect(workbench).toContain('aria-labelledby="lost-terminal-dialog-title"');
    expect(workbench).toContain('aria-describedby="lost-terminal-dialog-description"');
    expect(workbench).toContain('step === "warning" ? <>');
    expect(workbench).toContain('onClick={() => goToStep("dismiss")}>Dismiss</button>');
    expect(workbench).toContain('onClick={() => goToStep("go-back")}>Go back</button>');
    expect(workbench).toContain('onClick={onDismiss}>Dismiss anyway</button>');
    expect(workbench).toContain("lost-terminal-warning-statement");
    expect(workbench).toContain("lost-terminal-warning-supporting");
    expect(workbench).toContain("lostTerminalDialogStepAfter");
    expect(workbench).toContain("removeTerminalCollectionEntries");
    expect(workbench).toContain("closeWorkbenchTabsForTerminalIds");
    expect(workbench).toContain("isTerminalSidebarVisible");
    expect(workbench).toContain('const ids = terminals.filter((terminal) => terminal.state === "lost")');
    expect(workbench).toContain("return terminal.title;");
    expect(workbench).not.toContain("terminalLabels");
    expect(workbench).toContain("runtimeState={runtimeState}");
    expect(runtimeControls).toContain("/api/projects/${projectId}/runtime");
    expect(runtimeControls).toContain('body: JSON.stringify({ action })');
    expect(runtimeControls).toContain("runtimeControlState");
    expect(runtimeControls).toContain('"Restart workspace"');
    expect(runtimeControls).toContain("restartRuntime");
    expect(runtimeControls).toContain("onRestartInitiated?.();");
    expect(runtimeControls).toContain("if (pendingRef.current) return;");
    expect(runtimeControls).toContain("router.refresh()");
  });

  test("renders one runtime action with state-aware labels and authorization", () => {
    const render = (runtimeState: string, canStart: boolean, canStop: boolean, activeAction: "stop" | null = null) =>
      renderToStaticMarkup(createElement(RuntimeControls, {
        projectId: "project-1", runtimeAvailable: true, runtimeState, canStart, canStop, activeAction, retryStart: false
      }));
    const start = render("stopped", true, false);
    expect(start.match(/<button/g)).toHaveLength(1);
    expect(start).toContain("Start runtime");
    expect(start).not.toContain("disabled");
    const stop = render("running", false, true);
    expect(stop.match(/<button/g)).toHaveLength(1);
    expect(stop).toContain("Stop runtime");
    expect(stop).not.toContain("disabled");
    expect(render("running", false, false)).toContain('disabled=""');
    const stopping = render("running", false, true, "stop");
    expect(stopping.match(/<button/g)).toHaveLength(1);
    expect(stopping).toContain("Stopping…");
    expect(stopping).toContain('disabled=""');
  });

  test("keeps recovery dialog styling secondary for Dismiss and primary for Restart", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toContain(".lost-terminal-dismiss { font-size: .7rem; padding: 5px 8px; }");
    expect(css).toContain(".lost-terminal-dialog-actions .runtime-controls button { font-size: .84rem; padding: 10px 16px; }");
  });

  test("keeps creating visible but never attachable", () => {
    expect(isTerminalVisibleState("creating")).toBe(true);
    expect(isTerminalAttachableState("creating")).toBe(false);
  });

  test("keeps the sidebar collection synchronized across attach, detach, reopen, and exit", () => {
    const terminal = { id: "terminal-1", title: "Terminal 1", state: "disconnected" };
    const attached = updateTerminalCollectionState([terminal], terminal.id, "active");
    expect(attached[0]?.state).toBe("active");
    const detached = updateTerminalCollectionState(attached, terminal.id, "disconnected");
    expect(detached[0]?.state).toBe("disconnected");
    const reopened = updateTerminalCollectionState(detached, terminal.id, "active");
    expect(reopened[0]?.state).toBe("active");
    const exited = updateTerminalCollectionState(reopened, terminal.id, "closed");
    expect(exited[0]?.state).toBe("closed");
    expect(isTerminalVisibleState(exited[0]?.state ?? "")).toBe(true);
  });

  test("removes only the terminal rows captured by lost-terminal recovery", () => {
    const terminals = [
      { id: "lost-1", title: "Terminal 1", state: "lost" },
      { id: "healthy-1", title: "Terminal 2", state: "active" },
      { id: "lost-2", title: "Terminal 3", state: "lost" }
    ];
    expect(removeTerminalCollectionEntries(terminals, ["lost-2", "lost-1"])).toEqual([terminals[1]]);
  });

  test("sorts terminal labels naturally and deterministically when a gap is reused", () => {
    const sorted = sortTerminalViewsByTitle([
      { id: "terminal-3", title: "Terminal 3", state: "active" },
      { id: "terminal-2-reused", title: "Terminal 2", state: "disconnected" },
      { id: "terminal-1", title: "Terminal 1", state: "active" }
    ]);
    expect(sorted.map((terminal) => terminal.title)).toEqual(["Terminal 1", "Terminal 2", "Terminal 3"]);
  });

  test("refreshes after process exit or intentional detach, without reconnecting an ended socket", () => {
    expect(terminalSocketCloseAction({ terminalEnded: true, cancelled: false, terminalState: "active", closeCode: 1000 })).toBe("refresh");
    expect(terminalSocketCloseAction({ terminalEnded: false, cancelled: true, terminalState: "active", closeCode: 1000 })).toBe("refresh");
    expect(terminalSocketCloseAction({ terminalEnded: false, cancelled: true, terminalState: "lost", closeCode: 1000 })).toBe("ignore");
    expect(terminalSocketCloseAction({ terminalEnded: false, cancelled: false, terminalState: "closed", closeCode: 1006 })).toBe("ignore");
    expect(terminalSocketCloseAction({ terminalEnded: false, cancelled: false, terminalState: "active", closeCode: 1006 })).toBe("reconnect");
  });

  test("keeps the Workbench terminal surface bounded for responsive xterm fitting", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toContain(".terminal-tab-surface { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }");
    expect(css).toContain(".terminal-tab-surface .terminal-canvas { flex: 1 1 auto; height: auto; min-height: 0; min-width: 0; overflow: hidden; }");
    expect(css).toContain(".terminal-tab-surface .terminal-canvas .xterm-viewport { max-height: 100%; max-width: 100%; overflow-x: hidden; overflow-y: auto; }");
    const terminalTab = await readFile(new URL("./terminal-tab.tsx", import.meta.url), "utf8");
    expect(terminalTab).not.toContain("terminal-tab-header");
    expect(terminalTab).not.toContain("terminal-identity");
  });
});
