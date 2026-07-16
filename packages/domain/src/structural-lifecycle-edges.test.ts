import { describe, expect, test } from "vitest";
import {
  isAiSessionStructuralEdge,
  isPreviewDesiredStructuralEdge,
  isPreviewObservedStructuralEdge,
  isProcessDesiredStructuralEdge,
  isProcessObservedStructuralEdge,
  isRuntimeStackObservedStructuralEdge,
  isTerminalStructuralEdge,
  isWorkspaceObservedStructuralEdge,
  isWorkspaceServiceHealthStructuralEdge,
  isWorkspaceServiceObservedStructuralEdge,
  transitionAiSession,
  transitionPreviewDesired,
  transitionPreviewObserved,
  transitionProcessDesired,
  transitionProcessObserved,
  transitionRuntimeStackObserved,
  transitionTerminal,
  transitionWorkspaceObserved,
  transitionWorkspaceServiceHealth,
  transitionWorkspaceServiceObserved
} from "./index.js";

describe("public structural lifecycle edge predicates", () => {
  test.each([
    [isWorkspaceObservedStructuralEdge, transitionWorkspaceObserved, "stopped", "starting", "running", "archived"],
    [isRuntimeStackObservedStructuralEdge, transitionRuntimeStackObserved, "stopped", "starting", "absent", "running"],
    [isWorkspaceServiceObservedStructuralEdge, transitionWorkspaceServiceObserved, "stopped", "starting", "absent", "running"],
    [isProcessDesiredStructuralEdge, transitionProcessDesired, "running", "stopped", "running", "running"],
    [isProcessObservedStructuralEdge, transitionProcessObserved, "queued", "starting", "queued", "running"],
    [isTerminalStructuralEdge, transitionTerminal, "creating", "active", "closed", "active"],
    [isPreviewDesiredStructuralEdge, transitionPreviewDesired, "inactive", "active", "inactive", "inactive"],
    [isPreviewObservedStructuralEdge, transitionPreviewObserved, "inactive", "starting", "inactive", "healthy"],
    [isAiSessionStructuralEdge, transitionAiSession, "creating", "active", "stopped", "active"]
  ] as const)("reports the same unguarded graph edge as %s", (predicate, transition, from, to, invalidFrom, invalidTo) => {
    expect(predicate(from as never, to as never)).toBe(true);
    expect(transition(from as never, to as never).ok).toBe(true);
    expect(predicate(invalidFrom as never, invalidTo as never)).toBe(false);
  });

  test("shares the service-health graph with the contextual validator", () => {
    expect(isWorkspaceServiceHealthStructuralEdge("healthy", "unhealthy")).toBe(true);
    expect(transitionWorkspaceServiceHealth("healthy", "unhealthy", {
      serviceObservedState: "running"
    }).ok).toBe(true);
    expect(isWorkspaceServiceHealthStructuralEdge("healthy", "starting")).toBe(false);
  });

  test("exposes guarded graph edges without fabricating contextual evidence", () => {
    expect(isWorkspaceObservedStructuralEdge("lost", "running")).toBe(true);
    expect(transitionWorkspaceObserved("lost", "running").ok).toBe(false);
    expect(isPreviewObservedStructuralEdge("lost", "inactive")).toBe(true);
    expect(transitionPreviewObserved("lost", "inactive").ok).toBe(false);
    expect(isRuntimeStackObservedStructuralEdge("removing", "absent")).toBe(true);
    expect(transitionRuntimeStackObserved("removing", "absent").ok).toBe(false);
    expect(isWorkspaceServiceHealthStructuralEdge("unknown", "healthy")).toBe(true);
    expect(transitionWorkspaceServiceHealth("unknown", "healthy").ok).toBe(false);
  });
});
