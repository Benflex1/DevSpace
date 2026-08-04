import { describe, expect, test } from "vitest";
import { createAiSessionLoadCoordinator } from "./ai-session-load.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("AI session load coordinator", () => {
  test("prevents obsolete success, error, and finally mutations", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const applied: string[] = [];
    const messages: string[] = [];
    const loading: boolean[] = [];
    const runs: Array<{ requested: string | undefined; signal: AbortSignal }> = [];
    const coordinator = createAiSessionLoadCoordinator({
      run: (requested, signal) => {
        runs.push({ requested, signal });
        return requested === "A" ? first.promise : second.promise;
      },
      apply: (value) => applied.push(value),
      setLoading: (value) => loading.push(value),
      setMessage: (value) => { if (value !== null) messages.push(value); }
    });

    const loadA = coordinator.load("A");
    const loadB = coordinator.load("B");
    expect(runs[0]?.signal.aborted).toBe(true);
    second.resolve("B");
    await loadB;
    first.resolve("A");
    await loadA;

    expect(applied).toEqual(["B"]);
    expect(messages).toEqual([]);
    expect(loading).toEqual([true, true, false]);
  });

  test("an obsolete rejection is ignored and cancellation aborts the snapshot signal", async () => {
    const first = deferred<string>();
    const applied: string[] = [];
    let signal!: AbortSignal;
    const coordinator = createAiSessionLoadCoordinator({
      run: (_requested, currentSignal) => { signal = currentSignal; return first.promise; },
      apply: (value) => applied.push(value),
      setLoading: () => undefined,
      setMessage: (value) => { if (value !== null) throw new Error(`stale message: ${value}`); }
    });

    const load = coordinator.load("A");
    coordinator.cancel();
    first.reject(new Error("obsolete failure"));
    await load;
    expect(signal.aborted).toBe(true);
    expect(applied).toEqual([]);
  });
});
