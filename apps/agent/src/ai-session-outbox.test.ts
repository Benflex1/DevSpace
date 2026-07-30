import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  ACKNOWLEDGED_RETENTION_TAIL,
  MAX_RETAINED_OUTBOX_EVENTS,
  TERMINAL_EVENT_RESERVE,
  createAiSessionOutbox,
  manifestPathForAiSession,
  outboxPathForAiSession
} from "./ai-session-outbox.js";
import { canonicalAiEventSchema } from "@devspace/contracts";

const projectId = "018f1f34-7000-7000-8000-000000000001";
const workspaceId = "018f1f34-7000-7000-8000-000000000002";
const sessionId = "018f1f34-7000-7000-8000-000000000003";
const binding = { projectId, workspaceId, aiSessionId: sessionId };
const profile = { profileId: "codex", profileRevision: `sha256-ai-profile-v1:${"a".repeat(64)}`, provider: "codex" };

function eventInput(index: number, kind: "normal" | "turn-finalization" | "provider-finalization" | "terminal" = "normal") {
  return {
    turnId: sessionId,
    eventType: "turn.output.delta" as const,
    payload: { stream: "assistant" as const, text: `event-${index}` },
    profile,
    processGeneration: 1,
    kind
  };
}

async function fixture() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "devspace-ai-outbox-test-"));
  const ids = [0];
  const outbox = await createAiSessionOutbox({ stateRoot, binding, createId: () => {
    ids[0] = (ids[0] ?? 0) + 1;
    return `018f1f34-7000-7000-8000-${(ids[0] ?? 0).toString().padStart(12, "0")}`;
  } });
  return { stateRoot, outbox };
}

async function seededFixture(count: number) {
  const { stateRoot } = await fixture();
  const events = Array.from({ length: count }, (_, index) => canonicalAiEventSchema.parse({
    schemaVersion: "devspace.ai-event/v1",
    eventId: `018f1f34-7000-7000-8000-${(index + 100).toString().padStart(12, "0")}`,
    sessionId,
    turnId: sessionId,
    sequence: index + 1,
    observedAt: "2026-07-29T00:00:00.000Z",
    profile,
    processGeneration: 1,
    eventType: "turn.output.delta",
    payload: { stream: "assistant", text: `seed-${index + 1}` }
  }));
  await writeFile(outboxPathForAiSession(stateRoot, sessionId), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
  const outbox = await createAiSessionOutbox({ stateRoot, binding });
  return { stateRoot, outbox };
}

describe("Agent-private AI session outbox", () => {
  test("accepts an exact full-identity acknowledgement and repeats it idempotently", async () => {
    const { stateRoot, outbox } = await fixture();
    try {
      const event = await outbox.append(eventInput(1));
      const acknowledgement = { ...binding, throughSequence: event.sequence, throughEventId: event.eventId };
      await expect(outbox.acknowledge(acknowledgement)).resolves.toEqual(acknowledgement);
      await expect(outbox.acknowledge(acknowledgement)).resolves.toEqual(acknowledgement);
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test.each([
    ["projectId", "018f1f34-7000-7000-8000-000000000010"],
    ["workspaceId", "018f1f34-7000-7000-8000-000000000011"],
    ["aiSessionId", "018f1f34-7000-7000-8000-000000000012"]
  ] as const)("rejects a foreign %s", async (field, value) => {
    const { stateRoot, outbox } = await fixture();
    try {
      const event = await outbox.append(eventInput(1));
      await expect(outbox.acknowledge({ ...binding, [field]: value, throughSequence: event.sequence, throughEventId: event.eventId }))
        .rejects.toMatchObject({ code: "AI_IDENTITY_MISMATCH" });
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("rejects a matching sequence with a different event ID and acknowledgements ahead of the outbox", async () => {
    const { stateRoot, outbox } = await fixture();
    try {
      const event = await outbox.append(eventInput(1));
      await expect(outbox.acknowledge({ ...binding, throughSequence: event.sequence, throughEventId: "018f1f34-7000-7000-8000-000000000099" }))
        .rejects.toMatchObject({ code: "AI_EVENT_SEQUENCE_CONFLICT" });
      await expect(outbox.acknowledge({ ...binding, throughSequence: event.sequence + 1, throughEventId: event.eventId }))
        .rejects.toMatchObject({ code: "AI_EVENT_SEQUENCE_CONFLICT" });
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("reloads the exact acknowledgement and rejects missing or inconsistent persisted state", async () => {
    const { stateRoot, outbox } = await fixture();
    try {
      const event = await outbox.append(eventInput(1));
      await outbox.acknowledge({ ...binding, throughSequence: event.sequence, throughEventId: event.eventId });
      const restarted = await createAiSessionOutbox({ stateRoot, binding });
      expect(restarted.acknowledgedThrough).toBe(event.sequence);
      expect(restarted.acknowledgedEventId).toBe(event.eventId);

      await rm(manifestPathForAiSession(stateRoot, sessionId));
      await expect(createAiSessionOutbox({ stateRoot, binding })).rejects.toMatchObject({ code: "AI_OUTBOX_UNAVAILABLE" });
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("does not silently discard unacknowledged events at capacity", async () => {
    const { stateRoot } = await fixture();
    try {
      const seeded = await seededFixture(MAX_RETAINED_OUTBOX_EVENTS);
      await rm(stateRoot, { recursive: true, force: true });
      const seededStateRoot = seeded.stateRoot;
      const seededOutbox = seeded.outbox;
      const before = await readFile(outboxPathForAiSession(seededStateRoot, sessionId), "utf8");
      await expect(seededOutbox.append(eventInput(MAX_RETAINED_OUTBOX_EVENTS + 1))).rejects.toMatchObject({ code: "AI_OUTBOX_UNAVAILABLE" });
      expect(await readFile(outboxPathForAiSession(seededStateRoot, sessionId), "utf8")).toBe(before);
      expect(seededOutbox.nextSequence).toBe(MAX_RETAINED_OUTBOX_EVENTS + 1);
      expect(seededOutbox.events).toHaveLength(MAX_RETAINED_OUTBOX_EVENTS);
      await rm(seededStateRoot, { recursive: true, force: true });
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("reserves terminal capacity while a turn is active", async () => {
    const { stateRoot } = await fixture();
    try {
      const fill = MAX_RETAINED_OUTBOX_EVENTS - TERMINAL_EVENT_RESERVE - 2;
      const seeded = await seededFixture(fill);
      await rm(stateRoot, { recursive: true, force: true });
      const seededStateRoot = seeded.stateRoot;
      const seededOutbox = seeded.outbox;
      await seededOutbox.reserveProviderGeneration();
      await expect(seededOutbox.beginTurn({ turnId: sessionId, profile, processGeneration: 1, content: { kind: "text", text: "hello" } }))
        .resolves.toHaveLength(2);
      await expect(seededOutbox.append(eventInput(fill + 3))).rejects.toMatchObject({ code: "AI_OUTBOX_UNAVAILABLE" });
      for (let index = 0; index < 4; index += 1) await seededOutbox.append(eventInput(fill + 4 + index, "turn-finalization"));
      await seededOutbox.finishTurn();
      for (let index = 0; index < 2; index += 1) await seededOutbox.append(eventInput(fill + 8 + index, "provider-finalization"));
      await seededOutbox.releaseProviderGeneration();
      expect(seededOutbox.events).toHaveLength(MAX_RETAINED_OUTBOX_EVENTS);
      await rm(seededStateRoot, { recursive: true, force: true });
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("rejects turn acceptance unless the worst turn terminal path fits beside provider finalization", async () => {
    const seeded = await seededFixture(MAX_RETAINED_OUTBOX_EVENTS - 7);
    try {
      await seeded.outbox.reserveProviderGeneration();
      await expect(seeded.outbox.beginTurn({
        turnId: sessionId,
        profile,
        processGeneration: 1,
        content: { kind: "text", text: "boundary" }
      })).rejects.toMatchObject({ code: "AI_OUTBOX_UNAVAILABLE" });
      expect(seeded.outbox.events).toHaveLength(MAX_RETAINED_OUTBOX_EVENTS - 7);
    } finally {
      await rm(seeded.stateRoot, { recursive: true, force: true });
    }
  });

  test("compacts only acknowledged entries older than the retained acknowledgement tail", async () => {
    const { stateRoot } = await fixture();
    try {
      const seeded = await seededFixture(ACKNOWLEDGED_RETENTION_TAIL + 4);
      await rm(stateRoot, { recursive: true, force: true });
      const seededStateRoot = seeded.stateRoot;
      const seededOutbox = seeded.outbox;
      const events = [...seededOutbox.events];
      const acknowledged = events[events.length - 1]!;
      await seededOutbox.acknowledge({ ...binding, throughSequence: acknowledged.sequence, throughEventId: acknowledged.eventId });
      expect(seededOutbox.events[0]?.sequence).toBe(5);
      expect(seededOutbox.events.every((event) => event.sequence >= acknowledged.sequence - ACKNOWLEDGED_RETENTION_TAIL + 1 || event.sequence > acknowledged.sequence)).toBe(true);
      await rm(seededStateRoot, { recursive: true, force: true });
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("reports a replay gap before the compacted boundary", async () => {
    const { stateRoot } = await fixture();
    try {
      const seeded = await seededFixture(ACKNOWLEDGED_RETENTION_TAIL + 4);
      await rm(stateRoot, { recursive: true, force: true });
      const seededStateRoot = seeded.stateRoot;
      const seededOutbox = seeded.outbox;
      const events = [...seededOutbox.events];
      const acknowledged = events.at(-1)!;
      await seededOutbox.acknowledge({ ...binding, throughSequence: acknowledged.sequence, throughEventId: acknowledged.eventId });
      await expect(seededOutbox.replay(0)).rejects.toMatchObject({ code: "AI_EVENT_GAP" });
      await rm(seededStateRoot, { recursive: true, force: true });
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("keeps private files owner-only and rejects symlinked state", async () => {
    const { stateRoot } = await fixture();
    try {
      expect((await lstat(outboxPathForAiSession(stateRoot, sessionId))).mode & 0o777).toBe(0o600);
      expect((await lstat(manifestPathForAiSession(stateRoot, sessionId))).mode & 0o777).toBe(0o600);
      const target = path.join(stateRoot, "target");
      await writeFile(target, "not-an-outbox", { mode: 0o600 });
      await rm(outboxPathForAiSession(stateRoot, sessionId));
      await symlink(target, outboxPathForAiSession(stateRoot, sessionId));
      await expect(createAiSessionOutbox({ stateRoot, binding })).rejects.toMatchObject({ code: "AI_OUTBOX_UNAVAILABLE" });
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("delivers only after durable append, preserves sequence on failure, and recovers the chain", async () => {
    const { stateRoot } = await fixture();
    let fail = true;
    try {
      const outbox = await createAiSessionOutbox({ stateRoot, binding, faultHooks: {
        beforeAppendWrite: () => { if (fail) throw new Error("injected-append-failure"); }
      } });
      const delivered: number[] = [];
      await outbox.subscribe(0, (event) => delivered.push(event.sequence));
      await expect(outbox.append(eventInput(1))).rejects.toMatchObject({ code: "AI_OUTBOX_UNAVAILABLE" });
      expect(outbox.nextSequence).toBe(1);
      expect(delivered).toEqual([]);
      fail = false;
      const event = await outbox.append(eventInput(1));
      expect(event.sequence).toBe(1);
      expect(delivered).toEqual([1]);
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("serializes concurrent append and acknowledgement without regression", async () => {
    const { stateRoot, outbox } = await fixture();
    try {
      const first = await outbox.append(eventInput(1));
      const secondPromise = outbox.append(eventInput(2));
      const acknowledgementPromise = outbox.acknowledge({ ...binding, throughSequence: first.sequence, throughEventId: first.eventId });
      await Promise.all([secondPromise, acknowledgementPromise]);
      expect(outbox.acknowledgedThrough).toBe(1);
      expect(outbox.events.map((event) => event.sequence)).toEqual([1, 2]);
      const second = outbox.events[1]!;
      await Promise.all([
        outbox.acknowledge({ ...binding, throughSequence: second.sequence, throughEventId: second.eventId }),
        outbox.acknowledge({ ...binding, throughSequence: first.sequence, throughEventId: first.eventId })
      ]);
      expect(outbox.acknowledgedThrough).toBe(2);
      expect(outbox.acknowledgedEventId).toBe(second.eventId);
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("manifest persistence failure leaves the JSONL outbox and acknowledgement unchanged", async () => {
    const { stateRoot, outbox } = await fixture();
    try {
      const event = await outbox.append(eventInput(1));
      const before = await readFile(outboxPathForAiSession(stateRoot, sessionId), "utf8");
      const faulted = await createAiSessionOutbox({ stateRoot, binding, faultHooks: {
        beforeAtomicRename: (pathname) => { if (pathname.endsWith(".state.json")) throw new Error("injected-manifest-failure"); }
      } });
      await expect(faulted.acknowledge({ ...binding, throughSequence: event.sequence, throughEventId: event.eventId }))
        .rejects.toMatchObject({ code: "AI_OUTBOX_UNAVAILABLE" });
      expect(await readFile(outboxPathForAiSession(stateRoot, sessionId), "utf8")).toBe(before);
      expect(faulted.acknowledgedThrough).toBe(0);
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("durable acknowledgement survives a failed compaction and retries idempotently", async () => {
    const { stateRoot } = await fixture();
    let failCompaction = true;
    try {
      const seeded = await seededFixture(ACKNOWLEDGED_RETENTION_TAIL + 4);
      await rm(stateRoot, { recursive: true, force: true });
      const events = [...seeded.outbox.events];
      const acknowledgement = { ...binding, throughSequence: events.at(-1)!.sequence, throughEventId: events.at(-1)!.eventId };
      const faulted = await createAiSessionOutbox({ stateRoot: seeded.stateRoot, binding, faultHooks: {
        beforeAtomicRename: (pathname) => { if (pathname.endsWith(".jsonl") && failCompaction) throw new Error("injected-compaction-failure"); }
      } });
      const before = await readFile(outboxPathForAiSession(seeded.stateRoot, sessionId), "utf8");
      await expect(faulted.acknowledge(acknowledgement)).rejects.toMatchObject({ code: "AI_OUTBOX_UNAVAILABLE" });
      const manifestText = await readFile(manifestPathForAiSession(seeded.stateRoot, sessionId), "utf8");
      expect(manifestText).toContain(`"acknowledgedThrough":${acknowledgement.throughSequence}`);
      expect(await readFile(outboxPathForAiSession(seeded.stateRoot, sessionId), "utf8")).toBe(before);
      failCompaction = false;
      await expect(faulted.acknowledge(acknowledgement)).resolves.toEqual(acknowledgement);
      expect(faulted.events[0]?.sequence).toBe(5);
      await rm(seeded.stateRoot, { recursive: true, force: true });
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });

  test("a foreign manifest and a missing unacknowledged prefix fail closed", async () => {
    const { stateRoot, outbox } = await fixture();
    try {
      const event = await outbox.append(eventInput(1));
      const manifest = JSON.parse(await readFile(manifestPathForAiSession(stateRoot, sessionId), "utf8")) as Record<string, unknown>;
      await writeFile(manifestPathForAiSession(stateRoot, sessionId), `${JSON.stringify({ ...manifest, projectId: "018f1f34-7000-7000-8000-000000000010" })}\n`, { mode: 0o600 });
      await expect(createAiSessionOutbox({ stateRoot, binding })).rejects.toMatchObject({ code: "AI_OUTBOX_UNAVAILABLE" });
      await writeFile(manifestPathForAiSession(stateRoot, sessionId), JSON.stringify({ ...manifest, acknowledgedThrough: event.sequence, acknowledgedEventId: event.eventId }), { mode: 0o600 });
      await writeFile(outboxPathForAiSession(stateRoot, sessionId), "", { mode: 0o600 });
      await expect(createAiSessionOutbox({ stateRoot, binding })).rejects.toMatchObject({ code: "AI_OUTBOX_UNAVAILABLE" });
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });
});
