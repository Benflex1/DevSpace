import { describe, expect, test } from "vitest";
import { restartRuntime } from "./runtime-restart.js";

describe("workspace runtime restart", () => {
  test("stops a running runtime before starting it", async () => {
    const actions: string[] = [];
    await restartRuntime("running", (action) => { actions.push(action); return Promise.resolve(); });
    expect(actions).toEqual(["stop", "start"]);
  });

  test("does not start when stop fails", async () => {
    const actions: string[] = [];
    await expect(restartRuntime("running", (action) => {
      actions.push(action);
      return Promise.reject(new Error("Stop was rejected."));
    })).rejects.toThrow("Stop was rejected.");
    expect(actions).toEqual(["stop"]);
  });

  test("surfaces a start failure after a successful stop", async () => {
    const actions: string[] = [];
    await expect(restartRuntime("running", (action) => {
      actions.push(action);
      if (action === "start") return Promise.reject(new Error("Start was rejected."));
      return Promise.resolve();
    })).rejects.toThrow("Start was rejected.");
    expect(actions).toEqual(["stop", "start"]);
  });

  test("starts a stopped or absent runtime without stopping first", async () => {
    const stoppedActions: string[] = [];
    await restartRuntime("start", (action) => { stoppedActions.push(action); return Promise.resolve(); });
    expect(stoppedActions).toEqual(["start"]);
  });
});
