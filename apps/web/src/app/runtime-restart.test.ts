import { describe, expect, test } from "vitest";
import { restartRuntime } from "./runtime-restart.js";

describe("workspace runtime restart", () => {
  test("stops a running runtime before starting it", async () => {
    const events: string[] = [];
    await restartRuntime("running", (action) => { events.push(action); return Promise.resolve(); }, () => {
      events.push("fresh-authorization");
      return Promise.resolve({ runtimeState: "stopped", canStart: true });
    });
    expect(events).toEqual(["stop", "fresh-authorization", "start"]);
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
    }, () => Promise.resolve({ runtimeState: "stopped", canStart: true }))).rejects.toThrow("Start was rejected.");
    expect(actions).toEqual(["stop", "start"]);
  });

  test("does not start when fresh post-stop authorization denies it", async () => {
    const events: string[] = [];
    await expect(restartRuntime("running", (action) => {
      events.push(action);
      return Promise.resolve();
    }, () => {
      events.push("fresh-authorization");
      return Promise.resolve({ runtimeState: "stopped", canStart: false });
    })).rejects.toThrow("fresh runtime reconciliation does not authorize starting it");
    expect(events).toEqual(["stop", "fresh-authorization"]);
  });

  test("does not start when fresh state is not startable", async () => {
    const actions: string[] = [];
    await expect(restartRuntime("running", (action) => {
      actions.push(action);
      return Promise.resolve();
    }, () => Promise.resolve({ runtimeState: "running", canStart: true }))).rejects.toThrow("fresh runtime reconciliation does not authorize starting it");
    expect(actions).toEqual(["stop"]);
  });

  test("starts a stopped or absent runtime without stopping first", async () => {
    const stoppedActions: string[] = [];
    await restartRuntime("start", (action) => { stoppedActions.push(action); return Promise.resolve(); });
    expect(stoppedActions).toEqual(["start"]);
  });
});
