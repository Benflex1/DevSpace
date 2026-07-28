import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createAiSessionRuntime } from "./ai-session-runtime.js";

const projectId = "018f1f34-7000-7000-8000-000000000001";
const workspaceId = "018f1f34-7000-7000-8000-000000000002";
const sessionId = "018f1f34-7000-7000-8000-000000000003";
const turnId = "018f1f34-7000-7000-8000-000000000004";
const revisionId = "018f1f34-7000-7000-8000-000000000005";
const profileRevision = `sha256-ai-profile-v1:${"b".repeat(64)}`;
const runtimePlanHash = `sha256-project-options-v1:${"a".repeat(64)}`;

const binding = {
  projectId, workspaceId, aiSessionId: sessionId, revisionId, runtimePlanHash,
  runtimeGeneration: 1, profileId: "codex", profileRevision
};

describe("AI session runtime", () => {
  test("fake app-server preserves ordered streaming, interrupt, and replay", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "devspace-ai-runtime-test-"));
    const runtime = createAiSessionRuntime({ mode: "fake", stateRoot });
    try {
    expect((await runtime.inspect({ projectId, workspaceId, profileId: "codex" })).availability.state).toBe("available");
    await runtime.start(binding);
    await runtime.sendTurn({ ...binding, processGeneration: 1, turnId, content: { kind: "text", text: "hello" } });
    const first = await runtime.collect(sessionId, 0, 30);
    expect(first.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "session.started", "session.ready", "turn.accepted", "turn.started", "turn.output.delta",
      "turn.provider-completed", "turn.files.changed", "turn.quiesced"
    ]));
    expect(first.find((event) => event.eventType === "turn.output.delta")?.payload).toEqual({ stream: "assistant", text: "Hello from the deterministic provider." });
    const last = first.at(-1);
    expect(last).toBeDefined();
    const replay = await runtime.collect(sessionId, 0, 100);
    expect(replay.map((event) => event.sequence)).toEqual(first.map((event) => event.sequence));
    await runtime.sendTurn({ ...binding, processGeneration: 1, turnId: "018f1f34-7000-7000-8000-000000000006", content: { kind: "text", text: "long" } });
    await runtime.interrupt({ ...binding, turnId: "018f1f34-7000-7000-8000-000000000006", processGeneration: 1 });
      const interrupted = await runtime.collect(sessionId, last!.sequence, 250);
      expect(interrupted.some((event) => event.eventType === "turn.interrupted")).toBe(true);
      const restarted = createAiSessionRuntime({ mode: "fake", stateRoot });
      const recovered = await restarted.replay(sessionId, 0);
      expect(recovered.at(-1)?.eventType).toBe("session.lost");
      expect(recovered.at(-1)?.payload).toEqual({ code: "AGENT_RESTART" });
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });
});
