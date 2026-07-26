import { describe, expect, test } from "vitest";
import {
  aiInteractionRequestStates,
  aiProviderProcessStates,
  aiSessionV1States,
  aiTurnStates,
  transitionAiInteractionRequest,
  transitionAiProviderProcess,
  transitionAiSessionV1,
  transitionAiTurn,
  type LifecycleName,
  type TransitionResult
} from "./index.js";

interface ExhaustiveCase<State extends string> {
  readonly lifecycle: LifecycleName;
  readonly states: readonly State[];
  readonly edges: Readonly<Record<State, readonly State[]>>;
  readonly transition: (from: State, to: State) => TransitionResult<State>;
}

function verifyExhaustively<State extends string>(fixture: ExhaustiveCase<State>): void {
  describe(fixture.lifecycle, () => {
    const edgeKeys = new Set(
      (Object.entries(fixture.edges) as [State, readonly State[]][]).flatMap(([from, targets]) =>
        targets.map((to) => `${from}->${to}`)
      )
    );
    const pairs = fixture.states.flatMap((from) =>
      fixture.states.map((to) => [from, to] as const)
    );

    test("fixture covers every ordered pair exactly once", () => {
      expect(Object.keys(fixture.edges)).toEqual([...fixture.states]);
      expect(pairs).toHaveLength(fixture.states.length ** 2);
      expect(edgeKeys.size).toBe(
        (Object.values(fixture.edges) as readonly (readonly State[])[])
          .reduce((count, targets) => count + targets.length, 0)
      );
    });

    test.each(pairs)("%s -> %s matches the complete graph", (from, to) => {
      const expected = edgeKeys.has(`${from}->${to}`);
      const result = fixture.transition(from, to);
      expect(result.ok).toBe(expected);
      if (expected) {
        expect(result).toEqual({ ok: true, state: to });
      } else {
        expect(result).toEqual({
          ok: false,
          error: {
            kind: "invalid-transition",
            code: "INVALID_LIFECYCLE_TRANSITION",
            lifecycle: fixture.lifecycle,
            from,
            to
          }
        });
      }
    });
  });
}

verifyExhaustively({
  lifecycle: "ai-session-v1",
  states: aiSessionV1States,
  edges: {
    creating: ["ready", "stopping", "unavailable", "lost"],
    ready: ["running", "stopping", "unavailable", "lost"],
    running: [
      "ready",
      "waiting-for-approval",
      "waiting-for-input",
      "interrupting",
      "stopping",
      "lost"
    ],
    "waiting-for-approval": ["running", "interrupting", "stopping", "lost"],
    "waiting-for-input": ["running", "interrupting", "stopping", "lost"],
    interrupting: ["ready", "stopping", "lost"],
    stopping: ["stopped", "lost"],
    stopped: ["creating"],
    unavailable: ["creating", "stopping", "lost"],
    lost: ["creating", "stopping"]
  },
  transition: transitionAiSessionV1
});

verifyExhaustively({
  lifecycle: "ai-provider-process",
  states: aiProviderProcessStates,
  edges: {
    creating: ["exec-created", "failed", "lost"],
    "exec-created": ["identity-confirming", "failed", "lost"],
    "identity-confirming": ["running", "failed", "lost"],
    running: ["stopping", "exited", "failed", "lost"],
    stopping: ["exited", "failed", "lost"],
    exited: [],
    failed: [],
    lost: []
  },
  transition: transitionAiProviderProcess
});

verifyExhaustively({
  lifecycle: "ai-turn",
  states: aiTurnStates,
  edges: {
    accepted: ["starting", "failed", "lost"],
    starting: ["running", "failed", "lost"],
    running: [
      "waiting-for-approval",
      "waiting-for-input",
      "interrupting",
      "provider-completed",
      "failed",
      "lost"
    ],
    "waiting-for-approval": ["running", "interrupting", "failed", "lost"],
    "waiting-for-input": ["running", "interrupting", "failed", "lost"],
    interrupting: ["provider-completed", "interrupted", "failed", "lost"],
    "provider-completed": ["quiesced", "failed", "lost"],
    quiesced: ["completed", "interrupted", "failed"],
    completed: [],
    interrupted: [],
    failed: [],
    lost: []
  },
  transition: transitionAiTurn
});

verifyExhaustively({
  lifecycle: "ai-interaction-request",
  states: aiInteractionRequestStates,
  edges: {
    pending: ["responded", "cancelled", "expired", "lost"],
    responded: [],
    cancelled: [],
    expired: [],
    lost: []
  },
  transition: transitionAiInteractionRequest
});
