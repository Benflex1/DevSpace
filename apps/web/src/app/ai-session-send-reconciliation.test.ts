import { describe, expect, test, vi } from "vitest";
import { createAiSessionSendReconciliation } from "./ai-session-send-reconciliation.js";

function fixture() {
  const restoreDraft = vi.fn();
  const setPending = vi.fn();
  const setMessage = vi.fn();
  const coordinator = createAiSessionSendReconciliation({ restoreDraft, setPending, setMessage });
  const ambiguous = { sessionId: "session-a", selectionGeneration: 7, turnId: "turn-a", draft: "keep me" };
  return { coordinator, ambiguous, restoreDraft, setPending, setMessage };
}

describe("ambiguous AI send reconciliation", () => {
  test("withholds the draft when an immediate SQLite load does not yet contain the turn", () => {
    const value = fixture();
    expect(value.coordinator.begin(value.ambiguous)).toBe(true);
    expect(value.coordinator.observe({
      sessionId: "session-a",
      selectionGeneration: 7,
      state: "active",
      canonicalTurnIds: new Set()
    })).toBe("pending");
    expect(value.restoreDraft).not.toHaveBeenCalled();
    expect(value.coordinator.hasPending("session-a", 7)).toBe(true);
  });

  test("resolves acceptance only for the exact canonical turn and keeps the draft cleared", () => {
    const value = fixture();
    value.coordinator.begin(value.ambiguous);
    expect(value.coordinator.observe({
      sessionId: "session-a",
      selectionGeneration: 7,
      state: "active",
      canonicalTurnIds: new Set(["turn-a"])
    })).toBe("accepted");
    expect(value.restoreDraft).not.toHaveBeenCalled();
    expect(value.coordinator.hasPending("session-a", 7)).toBe(false);
  });

  test.each(["stopped", "lost"])("restores only after exact session terminal state %s proves absence", (state) => {
    const value = fixture();
    value.coordinator.begin(value.ambiguous);
    expect(value.coordinator.observe({
      sessionId: "session-a",
      selectionGeneration: 7,
      state,
      canonicalTurnIds: new Set()
    })).toBe("restored");
    expect(value.restoreDraft).toHaveBeenCalledWith("keep me");
  });

  test("ignores stale reconciliation after session selection changes", () => {
    const value = fixture();
    value.coordinator.begin(value.ambiguous);
    expect(value.coordinator.observe({
      sessionId: "session-b",
      selectionGeneration: 8,
      state: "lost",
      canonicalTurnIds: new Set()
    })).toBe("stale");
    expect(value.restoreDraft).not.toHaveBeenCalled();
    expect(value.coordinator.hasPending("session-a", 7)).toBe(true);
  });

  test("keeps the draft withheld when reconciliation loading fails", () => {
    const value = fixture();
    value.coordinator.begin(value.ambiguous);
    value.coordinator.fail("session-a", 7);
    expect(value.restoreDraft).not.toHaveBeenCalled();
    expect(value.coordinator.hasPending("session-a", 7)).toBe(true);
    expect(value.setMessage).toHaveBeenLastCalledWith("Delivery outcome is uncertain; reconciling.");
  });

  test("rejects a second unresolved send claim", () => {
    const value = fixture();
    expect(value.coordinator.begin(value.ambiguous)).toBe(true);
    expect(value.coordinator.begin({ ...value.ambiguous, turnId: "turn-b" })).toBe(false);
  });
});
