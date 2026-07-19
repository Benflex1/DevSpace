import { describe, expect, test } from "vitest";
import { isTerminalAttachableState, reconcileTerminalState, terminalUiState } from "./terminal-lifecycle.js";

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
});
