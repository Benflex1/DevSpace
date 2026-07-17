import { expect, test } from "vitest";
import { AgentEventLog } from "./event-log.js";

const boot = "018f0f00-0000-7000-8000-000000000001";
const otherBoot = "018f0f00-0000-7000-8000-000000000002";
const operation = "018f0f00-0000-7000-8000-000000000003";
const project = "018f0f00-0000-7000-8000-000000000004";

test("sequences real events monotonically, replays from zero, and delivers live events", () => {
  const log = new AgentEventLog(boot, () => new Date("2026-07-17T12:00:00.000Z"), 8);
  expect(log.throughCursor).toBe(`v1.${boot}.0`);
  log.progressed(operation, { type: "project", projectId: project }, "accepted");
  log.succeeded(operation, { type: "project", projectId: project });
  expect(log.currentSequence).toBe(2);
  expect(log.throughCursor).toBe(`v1.${boot}.2`);
  expect(log.replay(`v1.${boot}.0`)).toMatchObject({ ok: true, events: [
    { sequence: 1, cursor: `v1.${boot}.1` }, { sequence: 2, cursor: `v1.${boot}.2` }
  ] });
  const live: number[] = [];
  const unsubscribe = log.subscribe((event) => live.push(event.sequence));
  log.progressed(operation, null, "live"); unsubscribe(); log.progressed(operation, null, "after unsubscribe");
  expect(live).toEqual([3]);
});

test("retention boundaries, future cursors, wrong boots, and new boot identity obey F10", () => {
  const log = new AgentEventLog(boot, () => new Date("2026-07-17T12:00:00.000Z"), 2);
  for (let index = 0; index < 4; index += 1) log.progressed(operation, null, `event ${index}`);
  expect(log.replay(`v1.${boot}.1`)).toEqual({ ok: false, reason: "cursor_expired" });
  expect(log.replay(`v1.${boot}.2`)).toMatchObject({ ok: true, events: [{ sequence: 3 }, { sequence: 4 }] });
  expect(log.replay(`v1.${boot}.5`)).toEqual({ ok: false, reason: "history_unavailable" });
  expect(log.replay(`v1.${otherBoot}.0`)).toEqual({ ok: false, reason: "boot_mismatch" });
  const restarted = new AgentEventLog(otherBoot, () => new Date("2026-07-17T12:00:00.000Z"));
  expect(restarted.bootId).not.toBe(log.bootId);
  expect(restarted.throughCursor).toBe(`v1.${otherBoot}.0`);
});
