import { describe, expect, test, vi } from "vitest";
import {
  createAiSessionInitialRetryCoordinator,
  type AiSessionInitialRetrySelection
} from "./ai-session-initial-retry.js";

const workspaceId = "018f0f00-0000-7000-8000-000000000102";
const sessionId = "018f0f00-0000-7000-8000-000000000103";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function recoverySelection(overrides: Partial<AiSessionInitialRetrySelection> = {}): AiSessionInitialRetrySelection {
  return { sessionId, selectionGeneration: 7, state: "creating", lastSequence: 0, ...overrides };
}

describe("initial AI session retry coordinator", () => {
  test("posts only the existing Create action and loads the exact returned session ID", async () => {
    const current = recoverySelection();
    const post = vi.fn(() => Promise.resolve({ sessionId }));
    const load = vi.fn(() => Promise.resolve());
    const coordinator = createAiSessionInitialRetryCoordinator({
      workspaceId,
      getSelection: () => current,
      post,
      load,
      setPending: vi.fn(),
      setMessage: vi.fn()
    });

    expect(await coordinator.retry(current)).toBe(true);
    expect(post).toHaveBeenCalledWith({ action: "create", workspaceId });
    expect(load).toHaveBeenCalledWith(sessionId);
    expect(current.sessionId).toBe(sessionId);
  });

  test("fences repeated clicks and reports pending until the one request settles", async () => {
    const current = recoverySelection();
    const request = deferred<{ sessionId: string }>();
    const pending: boolean[] = [];
    const post = vi.fn(() => request.promise);
    const coordinator = createAiSessionInitialRetryCoordinator({
      workspaceId,
      getSelection: () => current,
      post,
      load: vi.fn(() => Promise.resolve()),
      setPending: (value) => pending.push(value),
      setMessage: vi.fn()
    });

    const first = coordinator.retry(current);
    const duplicate = coordinator.retry(current);
    expect(await duplicate).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
    expect(pending).toEqual([true]);
    request.resolve({ sessionId });
    expect(await first).toBe(true);
    expect(pending).toEqual([true, false]);
  });

  test("reloads synchronized-empty or ambiguous success and allows a later manual retry", async () => {
    const current = recoverySelection();
    const post = vi.fn(() => Promise.resolve({ sessionId }));
    const load = vi.fn(() => Promise.resolve());
    const coordinator = createAiSessionInitialRetryCoordinator({
      workspaceId,
      getSelection: () => current,
      post,
      load,
      setPending: vi.fn(),
      setMessage: vi.fn()
    });

    expect(await coordinator.retry(current)).toBe(true);
    expect(await coordinator.retry(current)).toBe(true);
    expect(post).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenNthCalledWith(1, sessionId);
    expect(load).toHaveBeenNthCalledWith(2, sessionId);
  });

  test.each([
    ["session.started", recoverySelection({ lastSequence: 1 })],
    ["session.ready", recoverySelection({ state: "active", lastSequence: 2 })]
  ])("lets canonical %s win while a retry is pending", async (_event, canonical) => {
    let current = recoverySelection();
    const request = deferred<{ sessionId: string }>();
    const load = vi.fn(() => Promise.resolve());
    const coordinator = createAiSessionInitialRetryCoordinator({
      workspaceId,
      getSelection: () => current,
      post: () => request.promise,
      load,
      setPending: vi.fn(),
      setMessage: vi.fn()
    });

    const retry = coordinator.retry(current);
    current = canonical;
    request.resolve({ sessionId });
    expect(await retry).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  test("selection change invalidates stale success, failure, and final pending mutation", async () => {
    let current = recoverySelection();
    const request = deferred<{ sessionId: string }>();
    const pending: boolean[] = [];
    const messages: string[] = [];
    const load = vi.fn(() => Promise.resolve());
    const coordinator = createAiSessionInitialRetryCoordinator({
      workspaceId,
      getSelection: () => current,
      post: () => request.promise,
      load,
      setPending: (value) => pending.push(value),
      setMessage: (value) => messages.push(value)
    });

    const retry = coordinator.retry(current);
    current = recoverySelection({ sessionId: "018f0f00-0000-7000-8000-000000000104", selectionGeneration: 8 });
    coordinator.invalidate();
    request.resolve({ sessionId });
    expect(await retry).toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
    expect(pending).toEqual([true, false]);
  });

  test("keeps the same selected session on a safe Web failure and permits another attempt", async () => {
    const current = recoverySelection();
    const post = vi.fn()
      .mockRejectedValueOnce(new Error("The AI session no longer matches this workspace."))
      .mockResolvedValueOnce({ sessionId });
    const load = vi.fn(() => Promise.resolve());
    const messages: string[] = [];
    const coordinator = createAiSessionInitialRetryCoordinator({
      workspaceId,
      getSelection: () => current,
      post,
      load,
      setPending: vi.fn(),
      setMessage: (value) => messages.push(value)
    });

    expect(await coordinator.retry(current)).toBe(false);
    expect(current.sessionId).toBe(sessionId);
    expect(load).not.toHaveBeenCalled();
    expect(messages).toEqual(["The AI session no longer matches this workspace."]);
    expect(await coordinator.retry(current)).toBe(true);
  });

  test("rejects a replacement session identity without loading it", async () => {
    const current = recoverySelection();
    const replacementId = "018f0f00-0000-7000-8000-000000000104";
    const load = vi.fn(() => Promise.resolve());
    const messages: string[] = [];
    const coordinator = createAiSessionInitialRetryCoordinator({
      workspaceId,
      getSelection: () => current,
      post: () => Promise.resolve({ sessionId: replacementId }),
      load,
      setPending: vi.fn(),
      setMessage: (value) => messages.push(value)
    });

    expect(await coordinator.retry(current)).toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(messages).toEqual(["The AI session is no longer available."]);
  });
});
