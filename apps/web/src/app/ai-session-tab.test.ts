import { readFile } from "node:fs/promises";
import { act, createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { replayAiEvents, type AiSessionReplayEvent } from "./ai-session-replay.js";
import { aiSessionStreamAdmission } from "./ai-session-stream-admission.js";
import { AiSessionTab } from "./ai-session-tab.js";

vi.mock("./runtime-controls.js", () => ({ RuntimeControls: () => null }));

type TestEventListener = (event: TestEvent) => void;

class TestEvent {
  readonly type: string;
  readonly bubbles = true;
  readonly cancelable = true;
  target: TestDomNode | null = null;
  currentTarget: TestDomNode | null = null;
  defaultPrevented = false;
  private propagationStopped = false;

  constructor(type: string) {
    this.type = type;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }

  get isPropagationStopped() {
    return this.propagationStopped;
  }
}

class TestDomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly ownerDocument: TestDocument;
  readonly childNodes: TestDomNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<TestEventListener>>();
  parentNode: TestDomNode | null = null;
  nodeValue: string | null = null;
  value = "";
  disabled = false;
  checked = false;
  selected = false;
  style: Record<string, string> = {};
  private ownText = "";

  constructor(ownerDocument: TestDocument, nodeName: string, nodeType = 1) {
    this.ownerDocument = ownerDocument;
    this.nodeName = nodeName.toUpperCase();
    this.tagName = this.nodeName;
    this.nodeType = nodeType;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get nextSibling() {
    if (this.parentNode === null) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return index < 0 ? null : this.parentNode.childNodes[index + 1] ?? null;
  }

  get options() {
    return this.nodeName === "SELECT" ? this.childNodes.filter((child) => child.nodeName === "OPTION") : undefined;
  }

  get textContent() {
    if (this.nodeType !== 1) return this.nodeValue ?? "";
    return this.ownText + this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.childNodes.splice(0, this.childNodes.length);
  }

  appendChild(child: TestDomNode) {
    child.parentNode?.removeChild(child);
    this.ownText = "";
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  insertBefore(child: TestDomNode, before: TestDomNode | null) {
    if (before === null) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    const index = this.childNodes.indexOf(before);
    if (index < 0) return this.appendChild(child);
    this.ownText = "";
    this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child: TestDomNode) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  addEventListener(type: string, listener: TestEventListener) {
    const listeners = this.listeners.get(type) ?? new Set<TestEventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: TestEventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: TestEvent) {
    event.target ??= this;
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    if (event.bubbles && !event.isPropagationStopped && this.parentNode !== null) this.parentNode.dispatchEvent(event);
    return !event.defaultPrevented;
  }
}

class TestDocument {
  readonly nodeType = 9;
  readonly documentElement: TestDomNode;
  readonly body: TestDomNode;
  readonly listeners = new Map<string, Set<TestEventListener>>();
  defaultView: Record<string, unknown> | null = null;
  activeElement: TestDomNode | null = null;

  constructor() {
    this.documentElement = new TestDomNode(this, "html");
    this.body = new TestDomNode(this, "body");
  }

  createElement(nodeName: string) {
    return new TestDomNode(this, nodeName);
  }

  createElementNS(_namespace: string, nodeName: string) {
    return this.createElement(nodeName);
  }

  createTextNode(value: string) {
    const node = new TestDomNode(this, "#text", 3);
    node.nodeValue = value;
    return node;
  }

  createComment(value: string) {
    const node = new TestDomNode(this, "#comment", 8);
    node.nodeValue = value;
    return node;
  }

  addEventListener(type: string, listener: TestEventListener) {
    const listeners = this.listeners.get(type) ?? new Set<TestEventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: TestEventListener) {
    this.listeners.get(type)?.delete(listener);
  }
}

function installTestDom() {
  const globalObject = globalThis as unknown as Record<string, unknown>;
  const keys = ["document", "window", "navigator", "Node", "Element", "HTMLElement", "HTMLIFrameElement", "SVGElement", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(keys.map((key) => [key, globalObject[key]]));
  const document = new TestDocument();
  const windowObject: Record<string, unknown> = {
    document,
    Node: TestDomNode,
    Element: TestDomNode,
    HTMLElement: TestDomNode,
    HTMLIFrameElement: TestDomNode,
    SVGElement: TestDomNode,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  };
  document.defaultView = windowObject;
  Object.defineProperty(globalObject, "navigator", { configurable: true, writable: true, value: { userAgent: "test" } });
  Object.assign(globalObject, {
    document,
    window: windowObject,
    Node: TestDomNode,
    Element: TestDomNode,
    HTMLElement: TestDomNode,
    HTMLIFrameElement: TestDomNode,
    SVGElement: TestDomNode,
    IS_REACT_ACT_ENVIRONMENT: true
  });
  return { document, restore: () => { for (const [key, value] of previous) globalObject[key] = value; } };
}

function findNode(root: TestDomNode, predicate: (node: TestDomNode) => boolean): TestDomNode | null {
  if (predicate(root)) return root;
  for (const child of root.childNodes) {
    const found = findNode(child, predicate);
    if (found !== null) return found;
  }
  return null;
}

async function settleReact() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  test("renders explicit initial-start recovery through the Create coordinator", async () => {
    const source = await readFile(new URL("./ai-session-tab.tsx", import.meta.url), "utf8");

    expect(source).toContain("Codex did not finish starting.");
    expect(source).toContain("Retry starting Codex");
    expect(source).toContain("controls?.showInitialRetry");
    expect(source).toContain("disabled={controls.initialRetryDisabled}");
    expect(source).toContain("initialRetryCoordinator.retry(selected)");
    expect(source).toContain("aiSessionMutationControls(");
  });

  test("keeps historical sessions inspectable without offering a cross-revision restart", async () => {
    const source = await readFile(new URL("./ai-session-tab.tsx", import.meta.url), "utf8");

    expect(source).toContain("profile.profileRevision === session.profileRevision");
    expect(source).toContain("historical-only");
    expect(source).toContain('disabled={liveSessionExists}');
  });

  test("keeps nonterminal session history visible while the runtime prerequisite is unavailable", async () => {
    const source = await readFile(new URL("./ai-session-tab.tsx", import.meta.url), "utf8");

    expect(source).toContain("aiSessionStreamAdmission");
    expect(source).toContain('reason === "workspace-runtime-unavailable"');
    expect(source).toContain("Committed history is preserved.");
    expect(source).toContain("runtimePresentationMessage(runtimeState, runtimeAvailable, activeAction)");
    expect(source).toContain('action="start"');
    expect(source).toContain("runtimeState={runtimeState}");
    expect(source).toContain("runtimeAvailable={runtimeAvailable}");
  });

  test("keeps creating sessions eligible to observe their lifecycle", async () => {
    const source = await readFile(new URL("./ai-session-tab.tsx", import.meta.url), "utf8");

    expect(source).toContain('sessionState: session?.state ?? null');
    expect(source).toContain('runtimeState !== "running"');
    expect(source).toContain('profile?.availability.state === "available"');
    expect(source).not.toContain('session?.state === "ready"');
  });

  test("covers persisted-session recovery from a never-started runtime to a live stream", async () => {
    const source = await readFile(new URL("./ai-session-tab.tsx", import.meta.url), "utf8");
    const workbench = await readFile(new URL("./project-workbench.tsx", import.meta.url), "utf8");
    const stopped = aiSessionStreamAdmission({ active: true, sessionState: "active", runtimeState: "absent", runtimeAvailable: true,
      activeAction: null, providerAvailable: false });
    const starting = aiSessionStreamAdmission({ active: true, sessionState: "active", runtimeState: "starting", runtimeAvailable: true,
      activeAction: "start", providerAvailable: false });
    const running = aiSessionStreamAdmission({ active: true, sessionState: "creating", runtimeState: "running", runtimeAvailable: true,
      activeAction: null, providerAvailable: true });

    expect(stopped).toMatchObject({ allowed: false, reason: "workspace-runtime-unavailable" });
    expect(starting).toMatchObject({ allowed: false, reason: "workspace-runtime-unavailable" });
    expect(running).toEqual({ allowed: true, reason: "allowed" });
    expect(source).toContain("replayAiEvents");
    expect(source).toContain("Committed history is preserved.");
    expect(source).toContain('action="start"');
    expect(source).toContain("runtimeState={runtimeState}");
    expect(workbench).toContain("router.refresh()");
    expect(workbench).toContain("/api/projects/${projectId}/runtime");
  });

  test("preserves an explicitly selected older session across runtime refreshes", async () => {
    const dom = installTestDom();
    const projectId = "project-1";
    const workspaceId = "workspace-1";
    const newestSessionId = "session-newest";
    const olderSessionId = "session-older";
    const profile = {
      profileId: "codex", profileRevision: "profile-revision", displayName: "Codex",
      availability: { state: "available" as const }, capabilities: { interrupt: true, approvals: false, structuredInput: false }
    };
    const makeSelectedSession = (sessionId: string, title: string, outputText: string) => ({
      session: {
        id: sessionId, title, state: "stopped", profileRevision: profile.profileRevision, lastSequence: 0,
        historyStartSequence: 1, historyTruncated: false, interactionsTruncated: false
      },
      turns: [{
        id: `turn-${sessionId}`, state: "completed", content: { kind: "text", text: `${title} prompt` }, outputText,
        outputTruncated: false, activities: [], changedFiles: { files: [], truncated: false }, createdAt: "2026-09-15T00:00:00.000Z"
      }],
      interactions: [], events: []
    });
    const newest = makeSelectedSession(newestSessionId, "Newest session", "newest history");
    const older = makeSelectedSession(olderSessionId, "Older session", "older history");
    const sessions = [
      { id: newestSessionId, workspaceId, title: newest.session.title, state: newest.session.state, lastSequence: 0, historyStartSequence: 1, historyTruncated: false, createdAt: "2026-09-15T00:00:02.000Z", updatedAt: "2026-09-15T00:00:02.000Z" },
      { id: olderSessionId, workspaceId, title: older.session.title, state: older.session.state, lastSequence: 0, historyStartSequence: 1, historyTruncated: false, createdAt: "2026-09-15T00:00:01.000Z", updatedAt: "2026-09-15T00:00:01.000Z" }
    ];
    const requests: Array<{ method: string; url: string }> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ method: init?.method ?? "GET", url });
      const requestedSessionId = new URL(url, "http://localhost").searchParams.get("sessionId");
      const selected = requestedSessionId === olderSessionId ? older : newest;
      return Promise.resolve(new Response(JSON.stringify({ profile, sessions, session: selected }), { status: 200, headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const props = {
      projectId, workspaceId, active: false, runtimeState: "stopped", runtimeAvailable: true,
      activeAction: null, canStart: true, canStop: false, retryStart: false
    } as const;
    try {
      const { createRoot } = await import("react-dom/client");
      const container = dom.document.createElement("div");
      const root = createRoot(container as unknown as Element);

      await act(async () => { root.render(createElement(AiSessionTab, props)); await Promise.resolve(); });
      await settleReact();
      expect(container.textContent).toContain("newest history");
      expect(container.textContent).not.toContain("older history");

      const select = findNode(container, (node) => node.nodeName === "SELECT");
      expect(select).not.toBeNull();
      select!.value = olderSessionId;
      await act(async () => { select!.dispatchEvent(new TestEvent("change")); await Promise.resolve(); });
      await settleReact();
      expect(select!.value).toBe(olderSessionId);
      expect(container.textContent).toContain("older history");
      expect(container.textContent).not.toContain("newest history");

      const requestCountBeforeRuntimeRefresh = requests.length;
      await act(async () => {
        root.render(createElement(AiSessionTab, { ...props, runtimeState: "running", canStop: true }));
        await Promise.resolve();
      });
      await settleReact();

      expect(requests.slice(requestCountBeforeRuntimeRefresh).some(({ url }) => new URL(url, "http://localhost").searchParams.get("sessionId") === olderSessionId)).toBe(true);
      expect(select!.value).toBe(olderSessionId);
      expect(container.textContent).toContain("older history");
      expect(container.textContent).not.toContain("newest history");
      expect(requests.every(({ method }) => method === "GET")).toBe(true);
      await act(async () => { root.unmount(); await Promise.resolve(); });
      await settleReact();
    } finally {
      dom.restore();
    }
  });
});
