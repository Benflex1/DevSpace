import { describe, expect, test, vi } from "vitest";
import { aiSessionMutationControls, createAiSessionRestartCoordinator } from "./ai-session-restart.js";

const workspaceId = "018f0f00-0000-7000-8000-000000000102";
const stoppedSessionId = "018f0f00-0000-7000-8000-000000000103";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("stopped AI session recovery controls", () => {
  test("keeps stopped history visible while exposing only exact-session restart", () => {
    expect(aiSessionMutationControls("stopped", false, false)).toEqual({
      showHistory: true,
      showComposer: false,
      showInterrupt: false,
      showStop: false,
      showRestart: true,
      restartDisabled: false
    });
    expect(aiSessionMutationControls("lost", false, false)).toMatchObject({
      showHistory: true, showComposer: false, showInterrupt: false, showStop: false, showRestart: false
    });
    expect(aiSessionMutationControls("active", true, false)).toMatchObject({
      showHistory: true, showComposer: true, showInterrupt: true, showStop: true, showRestart: false
    });
    expect(aiSessionMutationControls("creating", false, false)).toMatchObject({
      showHistory: true, showComposer: false, showInterrupt: false, showStop: false, showRestart: false
    });
  });

  test("posts the exact selected session, fences duplicate clicks, cancels stale work, and reloads only that session", async () => {
    const request = deferred<void>();
    const post = vi.fn(() => request.promise);
    const cancel = vi.fn();
    const load = vi.fn(() => Promise.resolve());
    const pending: boolean[] = [];
    const coordinator = createAiSessionRestartCoordinator({
      workspaceId,
      post,
      cancel,
      load,
      setPending: (value) => pending.push(value)
    });

    const first = coordinator.restart(stoppedSessionId);
    const duplicate = coordinator.restart(stoppedSessionId);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ action: "restart", workspaceId, sessionId: stoppedSessionId });
    expect(post).toHaveBeenCalledTimes(1);
    expect(await duplicate).toBe(false);
    request.resolve();
    expect(await first).toBe(true);
    expect(load).toHaveBeenCalledWith(stoppedSessionId);
    expect(pending).toEqual([true, false]);
  });

  test("preserves the stopped selection and reports only the bounded restart failure", async () => {
    const load = vi.fn(() => Promise.resolve());
    const messages: string[] = [];
    const coordinator = createAiSessionRestartCoordinator({
      workspaceId,
      post: () => Promise.reject(new Error("Only a stopped AI session can be started again.")),
      cancel: vi.fn(),
      load,
      setPending: vi.fn(),
      setMessage: (message) => messages.push(message)
    });

    expect(await coordinator.restart(stoppedSessionId)).toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(messages).toEqual(["Only a stopped AI session can be started again."]);
  });
});
