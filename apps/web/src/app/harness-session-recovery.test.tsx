/**
 * @vitest-environment node
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { buttonText, click, FakeNode, findButtons, installTerminalTestDom, settleReact, visibleText } from "./terminal-test-dom.js";

vi.mock("./terminal-tab.js", () => ({
  TerminalTab: ({ terminal, onRefresh }: { terminal: { id: string }; onRefresh: () => void }) => createElement("div",
    { "data-terminal-id": terminal.id }, createElement("button", { onClick: onRefresh }, "Refresh projection"), "attached")
}));

const projectId = "018f1f34-7000-7000-8000-000000000001";
const workspaceId = "018f1f34-7000-7000-8000-000000000002";
const oldSessionId = "018f1f34-7000-7000-8000-000000000003";
const currentSessionId = "018f1f34-7000-7000-8000-000000000004";
const roots: Root[] = [];

afterEach(() => {
  for (const root of roots) act(() => { root.unmount(); });
  roots.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function terminalIds(node: FakeNode): string[] {
  const terminalId = node.attributes["data-terminal-id"];
  const ids = terminalId === undefined ? [] : [terminalId];
  return ids.concat(node.children.flatMap(terminalIds));
}

function findSessionSelector(node: FakeNode): FakeNode | undefined {
  if (node.nodeName === "SELECT" && node.attributes["aria-label"] === "Native session") return node;
  for (const child of node.children) {
    const match = findSessionSelector(child);
    if (match !== undefined) return match;
  }
  return undefined;
}

function selectSession(node: FakeNode, id: string) {
  node.value = id;
  const event = {
    type: "change", target: node, currentTarget: null, bubbles: true, cancelable: true,
    defaultPrevented: false, button: 0,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { /* tests do not cancel the bubble */ }
  };
  node.dispatchEvent(event);
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function session(id: string, state: string, admissionStatus?: string) {
  return {
    id, harnessId: "codex", state, terminalSessionId: id, processId: id, processGeneration: 1, title: "Codex",
    ...(admissionStatus === undefined ? {} : { admissionStatus })
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("refresh reconciles an in-progress admission without selecting an older lost session", async () => {
  const rootElement = installTerminalTestDom(class {});
  let inspections = 0;
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ url: requestUrl(input), method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (method !== "GET") return Promise.resolve(jsonResponse({ sessionId: currentSessionId, terminalId: currentSessionId, workspaceId, harnessId: "codex" }));
    inspections += 1;
    return Promise.resolve(jsonResponse({ definitions: [], sessions: inspections === 1
      ? [session(oldSessionId, "lost"), session(currentSessionId, "creating", "admitting")]
      : [session(oldSessionId, "lost"), session(currentSessionId, "active", "admitted")] }));
  }));
  const { HarnessSessionTab } = await import("./harness-session-tab.js");
  const root = createRoot(rootElement as never);
  roots.push(root);
  act(() => { root.render(createElement(HarnessSessionTab, { projectId, workspaceId, active: true })); });
  await settleReact();

  expect(terminalIds(rootElement)).toEqual([]);
  expect(visibleText(rootElement)).toContain("Admission in progress");

  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
  await settleReact();

  expect(inspections).toBeGreaterThanOrEqual(2);
  expect(terminalIds(rootElement)).toEqual([currentSessionId]);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  expect(visibleText(rootElement)).toContain("Connecting");
});

test("an uncertain admission retries only the exact existing session before attaching", async () => {
  const rootElement = installTerminalTestDom(class {});
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const request = { url: requestUrl(input), method, ...(typeof init?.body === "string" ? { body: init.body } : {}) };
    requests.push(request);
    if (method === "POST") return Promise.resolve(jsonResponse({ sessionId: currentSessionId, terminalId: currentSessionId, workspaceId, harnessId: "codex" }));
    return Promise.resolve(jsonResponse({ definitions: [], sessions: [session(currentSessionId, requests.some((item) => item.method === "POST") ? "active" : "creating",
      requests.some((item) => item.method === "POST") ? "admitted" : "uncertain")] }));
  }));
  const { HarnessSessionTab } = await import("./harness-session-tab.js");
  const root = createRoot(rootElement as never);
  roots.push(root);
  act(() => { root.render(createElement(HarnessSessionTab, { projectId, workspaceId, active: true })); });
  await settleReact(16);

  const retries: Array<Record<string, unknown>> = requests.filter((request) => request.method === "POST")
    .map((request) => JSON.parse(request.body ?? "{}") as Record<string, unknown>);
  expect(retries).toEqual([{ action: "retry-native", workspaceId, sessionId: currentSessionId, processGeneration: 1 }]);
  expect(terminalIds(rootElement)).toEqual([currentSessionId]);
  expect(visibleText(rootElement)).toContain("Connecting");
  expect(visibleText(rootElement)).not.toContain("Admission uncertain");
});

test("an active row with uncertain Agent admission stays detached until exact reconciliation", async () => {
  const rootElement = installTerminalTestDom(class {});
  const requests: Array<{ method: string; body?: string }> = [];
  let admissionConfirmed = false;
  let resolveRetry!: (response: Response) => void;
  const retryResponse = new Promise<Response>((resolve) => { resolveRetry = resolve; });
  vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (method === "POST") return retryResponse;
    return Promise.resolve(jsonResponse({ definitions: [], sessions: [session(currentSessionId, "active",
      admissionConfirmed ? "admitted" : "uncertain")] }));
  }));
  const { HarnessSessionTab } = await import("./harness-session-tab.js");
  const root = createRoot(rootElement as never);
  roots.push(root);
  act(() => { root.render(createElement(HarnessSessionTab, { projectId, workspaceId, active: true })); });
  await settleReact(12);

  expect(terminalIds(rootElement)).toEqual([]);
  expect(visibleText(rootElement)).toContain("Reconciling admission");
  expect(requests.filter((request) => request.method === "POST").map((request) =>
    JSON.parse(request.body ?? "{}") as Record<string, unknown>)).toEqual([
    { action: "retry-native", workspaceId, sessionId: currentSessionId, processGeneration: 1 }
  ]);

  admissionConfirmed = true;
  await act(async () => {
    resolveRetry(jsonResponse({ sessionId: currentSessionId, terminalId: currentSessionId, workspaceId, harnessId: "codex" }));
    await settleReact();
  });
  await settleReact();

  expect(terminalIds(rootElement)).toEqual([currentSessionId]);
  expect(visibleText(rootElement)).toContain("Connecting");
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
});

test("an interrupted Start discovers and attaches the same creating session without another create request", async () => {
  vi.useFakeTimers();
  const rootElement = installTerminalTestDom(class {});
  const requests: Array<{ method: string; body?: string }> = [];
  let inspections = 0;
  let admissionStartedAt: number | null = null;
  vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (method === "POST") {
      admissionStartedAt = Date.now();
      return Promise.reject(new Error("connection dropped"));
    }
    inspections += 1;
    const admitted = admissionStartedAt !== null && Date.now() - admissionStartedAt >= 187_000;
    const sessions = inspections === 1 ? [] : admitted
      ? [session(currentSessionId, "active", "admitted")]
      : [session(currentSessionId, "creating", "admitting")];
    return Promise.resolve(jsonResponse({ definitions: [], sessions }));
  }));
  const { HarnessSessionTab } = await import("./harness-session-tab.js");
  const root = createRoot(rootElement as never);
  roots.push(root);
  act(() => { root.render(createElement(HarnessSessionTab, { projectId, workspaceId, active: true })); });
  await act(async () => { for (let turn = 0; turn < 6; turn += 1) await Promise.resolve(); });

  const start = findButtons(rootElement).find((button) => buttonText(button) === "Start");
  expect(start).toBeDefined();
  act(() => { click(start!); });
  await act(async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve(); });

  expect(visibleText(rootElement)).toContain("Admission in progress");
  expect(terminalIds(rootElement)).toEqual([]);
  expect(requests.filter((request) => request.method === "POST")
    .map((request) => JSON.parse(request.body ?? "{}") as Record<string, unknown>))
    .toEqual([{ action: "create-native", workspaceId, harnessId: "codex" }]);

  await act(async () => { await vi.advanceTimersByTimeAsync(186_000); });
  expect(terminalIds(rootElement)).toEqual([]);
  expect(visibleText(rootElement)).toContain("Admission in progress");

  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(terminalIds(rootElement)).toEqual([currentSessionId]);
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  expect(inspections).toBeGreaterThan(24);
});

test("an older list response cannot replace the selected session after a newer refresh", async () => {
  const rootElement = installTerminalTestDom(class {});
  let inspections = 0;
  let releaseOlder!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    void input;
    inspections += 1;
    if (inspections === 1) return Promise.resolve(jsonResponse({ definitions: [], sessions: [session(currentSessionId, "active")] }));
    if (inspections === 2) return new Promise<Response>((resolve) => { releaseOlder = resolve; });
    return Promise.resolve(jsonResponse({ definitions: [], sessions: [session(currentSessionId, "active")] }));
  }));
  const { HarnessSessionTab } = await import("./harness-session-tab.js");
  const root = createRoot(rootElement as never);
  roots.push(root);
  act(() => { root.render(createElement(HarnessSessionTab, { projectId, workspaceId, active: true })); });
  await settleReact();

  const refresh = () => findButtons(rootElement).find((button) => buttonText(button) === "Refresh projection");
  act(() => { click(refresh()!); });
  act(() => { click(refresh()!); });
  await settleReact();
  act(() => { releaseOlder(jsonResponse({ definitions: [], sessions: [session(oldSessionId, "lost")] })); });
  await settleReact();

  expect(terminalIds(rootElement)).toEqual([currentSessionId]);
  expect(visibleText(rootElement)).not.toContain("Connection lost");
});

test("a Start conflict refreshes away from the selected lost session", async () => {
  const rootElement = installTerminalTestDom(class {});
  let inspections = 0;
  const requests: Array<{ method: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (method === "POST") return Promise.resolve(jsonResponse({ message: "A native session is already active." }, 409));
    inspections += 1;
    return Promise.resolve(jsonResponse({ definitions: [], sessions: inspections === 1
      ? [session(oldSessionId, "lost")]
      : [session(oldSessionId, "lost"), session(currentSessionId, "active")] }));
  }));
  const { HarnessSessionTab } = await import("./harness-session-tab.js");
  const root = createRoot(rootElement as never);
  roots.push(root);
  act(() => { root.render(createElement(HarnessSessionTab, { projectId, workspaceId, active: true })); });
  await settleReact();

  const start = findButtons(rootElement).find((button) => buttonText(button) === "Start");
  expect(start).toBeDefined();
  act(() => { click(start!); });
  await settleReact();

  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  expect(terminalIds(rootElement)).toEqual([currentSessionId]);
  expect(visibleText(rootElement)).toContain("Connecting");
});

test("a stale Resume conflict selects the current active session after an exact refresh", async () => {
  const rootElement = installTerminalTestDom(class {});
  let inspections = 0;
  const requests: Array<{ method: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (method === "POST") return Promise.resolve(jsonResponse({ message: "The session generation changed." }, 422));
    inspections += 1;
    const oldLostSession = { ...session(oldSessionId, "lost"), resume: true };
    return Promise.resolve(jsonResponse({ definitions: [], sessions: inspections === 1
      ? [oldLostSession]
      : [oldLostSession, session(currentSessionId, "active")] }));
  }));
  const { HarnessSessionTab } = await import("./harness-session-tab.js");
  const root = createRoot(rootElement as never);
  roots.push(root);
  act(() => { root.render(createElement(HarnessSessionTab, { projectId, workspaceId, active: true })); });
  await settleReact();

  const resume = findButtons(rootElement).find((button) => buttonText(button) === "Resume");
  expect(resume).toBeDefined();
  act(() => { click(resume!); });
  await settleReact();

  const posts = requests.filter((request) => request.method === "POST")
    .map((request) => JSON.parse(request.body ?? "{}") as Record<string, unknown>);
  expect(posts).toEqual([{ action: "resume", workspaceId, sessionId: oldSessionId }]);
  expect(terminalIds(rootElement)).toEqual([currentSessionId]);
});

test("a pending exact-session refresh cannot replace a newer manual session selection", async () => {
  const rootElement = installTerminalTestDom(class {});
  let inspections = 0;
  let releaseExactRefresh!: (response: Response) => void;
  const sessions = [session(oldSessionId, "creating", "admitting"), session(currentSessionId, "active")];
  vi.stubGlobal("fetch", vi.fn(() => {
    inspections += 1;
    if (inspections === 1) return Promise.resolve(jsonResponse({ definitions: [], sessions }));
    return new Promise<Response>((resolve) => { releaseExactRefresh = resolve; });
  }));
  const { HarnessSessionTab } = await import("./harness-session-tab.js");
  const root = createRoot(rootElement as never);
  roots.push(root);
  act(() => { root.render(createElement(HarnessSessionTab, { projectId, workspaceId, active: true })); });
  await settleReact();

  const selector = findSessionSelector(rootElement);
  expect(selector).toBeDefined();
  act(() => { selectSession(selector!, oldSessionId); });
  await settleReact();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
  expect(inspections).toBe(2);

  act(() => { selectSession(selector!, currentSessionId); });
  await settleReact();
  act(() => { releaseExactRefresh(jsonResponse({ definitions: [], sessions })); });
  await settleReact();

  expect(terminalIds(rootElement)).toEqual([currentSessionId]);
  expect(visibleText(rootElement)).toContain("Connecting");
});
