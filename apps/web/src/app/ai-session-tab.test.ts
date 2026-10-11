import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AiSessionTab } from "./ai-session-tab.js";
import { buttonText, click, findButtons, installTerminalTestDom, settleReact, visibleText } from "./terminal-test-dom.js";
import { replayAiEvents, type AiSessionReplayEvent } from "./ai-session-replay.js";

describe("AI session browser hydration", () => {
  test("does not append historical output deltas to persisted turn text", () => {
    const turn = {
      id: "turn-1", state: "completed", content: { kind: "text" as const, text: "Prompt" }, outputText: "Answer",
      outputTruncated: false, activities: [], changedFiles: { files: [], truncated: false }, createdAt: "2026-07-28T00:00:00.000Z"
    };
    const events: AiSessionReplayEvent[] = [
      { eventType: "turn.output.delta", turnId: "turn-1", payload: { text: "Answer" } },
      { eventType: "turn.activity.started", turnId: "turn-1", payload: { presentation: { summary: "Reading workspace" } } }
    ];

    const [hydrated] = replayAiEvents([turn], events);

    expect(hydrated?.outputText).toBe("Answer");
    expect(hydrated?.activities).toEqual(["Reading workspace"]);
  });

  test("renders initial-start recovery and retries the exact session through Create", async () => {
    const { body, fetchMock } = await mountSession("creating");
    const retry = findButtons(body).find((button) => buttonText(button) === "Retry starting Codex");
    expect(visibleText(body)).toContain("Codex did not finish starting.");
    expect(retry?.disabled).toBe(false);
    if (retry === undefined) throw new Error("Missing initial retry button");
    let finishStart!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishStart = resolve; }));
    act(() => { click(retry); });
    await settleReact();
    expect(retry.disabled).toBe(true);
    finishStart({ ok: true, json: () => Promise.resolve({ sessionId: "session-1" }) } as Response);
    await settleReact();
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/ai", expect.objectContaining({
      method: "POST", body: JSON.stringify({ action: "create", workspaceId: "workspace-1" })
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/ai?workspaceId=workspace-1&sessionId=session-1", expect.anything()
    );
  });

  test("keeps historical sessions inspectable without offering a cross-revision restart", async () => {
    const { body, fetchMock } = await mountSession("stopped", "older-revision");
    expect(visibleText(body)).toContain("historical-only");
    expect(visibleText(body)).toContain("Persisted answer");
    expect(findButtons(body).map(buttonText)).not.toContain("Start Codex again");
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });
});

let root: Root | undefined;
afterEach(() => {
  act(() => { root?.unmount(); });
  root = undefined;
  vi.unstubAllGlobals();
});

async function mountSession(state: string, profileRevision = "current-revision") {
  const session = { id: "session-1", title: "Session", state, profileRevision, lastSequence: 0,
    historyStartSequence: 1, historyTruncated: false, interactionsTruncated: false };
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/ai/events?")) {
      // Keep the stream open until component cleanup, without reconnect timers.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }
    const body = init?.method === "POST" ? { sessionId: session.id } : url.includes("/ai/status?")
      ? { profile: { profileId: "codex", profileRevision: "current-revision", displayName: "Codex",
        availability: { state: "available" }, capabilities: { interrupt: false, approvals: false, structuredInput: false } } }
      : { sessions: [session], session: { session, events: [], turns: state === "stopped" ? [{
        id: "turn-1", state: "completed", content: { kind: "text", text: "Prompt" }, outputText: "Persisted answer",
        outputTruncated: false, changedFiles: { files: [], truncated: false }, createdAt: "2026-07-28T00:00:00.000Z"
      }] : [] } };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  const body = installTerminalTestDom(class {});
  root = createRoot(body as never);
  act(() => { root!.render(createElement(AiSessionTab, { projectId: "project-1", workspaceId: "workspace-1", active: true })); });
  await settleReact();
  return { body, fetchMock };
}
