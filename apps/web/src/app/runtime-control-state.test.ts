import { describe, expect, test } from "vitest";
import { runtimeControlState } from "./runtime-control-state.js";

const base = {
  runtimeAvailable: true,
  activeAction: null,
  canStart: false,
  canStop: false
} as const;

describe("runtime control state", () => {
  test("keeps Stop runtime visible when live runtime is running but canStop is stale", () => {
    expect(runtimeControlState({ ...base, runtimeState: "running" })).toMatchObject({
      action: "stop", visible: true, disabled: true,
      reason: "The live Agent state does not currently authorize stopping this runtime."
    });
  });

  test("exposes Start runtime when the stopped runtime is startable", () => {
    expect(runtimeControlState({ ...base, runtimeState: "stopped", canStart: true })).toMatchObject({
      action: "start", visible: true, disabled: false, reason: null
    });
  });

  test("enables both shared stop presentations after exact running authorization", () => {
    expect(runtimeControlState({ ...base, runtimeState: "running", canStop: true })).toMatchObject({
      action: "stop", visible: true, disabled: false, reason: null
    });
    expect(runtimeControlState({ ...base, runtimeState: "running", canStop: true, requestedAction: "stop" })).toMatchObject({
      action: "stop", visible: true, disabled: false, reason: null
    });
  });

  test("disables the visible action while another runtime mutation is active", () => {
    expect(runtimeControlState({ ...base, runtimeState: "running", canStop: true, activeAction: "stop" })).toMatchObject({
      action: "stop", visible: true, disabled: true,
      reason: "Another runtime action is already in progress."
    });
  });
});
