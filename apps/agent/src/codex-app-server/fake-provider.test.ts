import { describe, expect, test } from "vitest";
import type { AdapterCallbacks, AiStructuredInputAnswer } from "./provider.js";
import { FakeProvider } from "./fake-provider.js";
import type { CodexInteractionProjection } from "./interactions.js";

function callbacks(received: { projection?: CodexInteractionProjection; output: string[] }): AdapterCallbacks {
  return {
    outputDelta: async (text) => { received.output.push(text); },
    activity: async () => undefined,
    interactionRequested: async (projection) => { received.projection = projection; },
    interactionResolved: async () => undefined,
    completed: async () => undefined,
    providerIncompatible: async () => undefined,
    privateFailure: () => undefined,
    failed: async () => undefined,
    providerClosed: async () => undefined
  };
}

async function waitForProjection(received: { projection?: CodexInteractionProjection }): Promise<CodexInteractionProjection> {
  for (let attempt = 0; attempt < 20 && received.projection === undefined; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (received.projection === undefined) throw new Error("fake interaction was not requested");
  return received.projection;
}

async function runQuestion(answers: readonly AiStructuredInputAnswer[]): Promise<{ output: string[]; response: unknown }> {
  const received: { projection?: CodexInteractionProjection; output: string[] } = { output: [] };
  let response: unknown;
  const provider = new FakeProvider(callbacks(received), null, {
    onNativeResponse: (value) => { response = value; }
  }, () => "devspace-request-1");
  const sending = provider.sendTurn("devspace-turn-1", "question");
  const projection = await waitForProjection(received);
  expect(projection.kind).toBe("input");
  await provider.respondToStructuredInput(projection.requestId, answers);
  await sending;
  return { output: received.output, response };
}

describe("deterministic fake Codex provider", () => {
  test("maps a listed option to the exact private native label", async () => {
    const result = await runQuestion([
      { questionId: "question-1", kind: "selected", optionId: "option-1" },
      { questionId: "question-2", kind: "selected", optionId: "option-1" }
    ]);
    expect(result.response).toEqual({
      kind: "input",
      payload: { answers: { "question-1": { answers: ["Safe"] }, "question-2": { answers: ["Continue"] } } }
    });
    expect(result.output).toContain("Thanks, I will continue with the selected options.");
  });

  test("encodes Other as a pinned user_note answer without exposing native values", async () => {
    const result = await runQuestion([
      { questionId: "question-1", kind: "other", text: "Use the bounded custom mode." },
      { questionId: "question-2", kind: "selected", optionId: "option-1" }
    ]);
    expect(result.response).toEqual({
      kind: "input",
      payload: { answers: { "question-1": { answers: ["user_note: Use the bounded custom mode."] }, "question-2": { answers: ["Continue"] } } }
    });
    expect(result.output).toContain("Thanks, I will continue with the Other answer.");
  });
});
