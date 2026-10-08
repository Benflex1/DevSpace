/**
 * @vitest-environment node
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { buttonText, FakeNode, findButtons, installTerminalTestDom, settleReact, visibleText } from "./terminal-test-dom.js";

class FakeSocket {
  static instances: FakeSocket[] = [];
  binaryType = "";
  readyState = 0;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send() { /* unused */ }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() { /* unused */ }
    open() { /* unused */ }
    focus() { /* unused */ }
    write() { /* unused */ }
    onData() { return { dispose() { /* unused */ } }; }
    onBinary() { return { dispose() { /* unused */ } }; }
    dispose() { /* unused */ }
  }
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() { /* unused */ }
    proposeDimensions() { return { cols: 80, rows: 24 }; }
  }
}));

const projectId = "018f1f34-7000-7000-8000-000000000001";
const workspaceId = "018f1f34-7000-7000-8000-000000000002";
const sessionId = "018f1f34-7000-7000-8000-000000000010";
const terminalId = "018f1f34-7000-7000-8000-000000000011";
const secretPath = "/opt/devspace/codex-artifact/b8cfdf0ab86c/artifact/bin/codex";
const roots: Root[] = [];
const posts: Array<{ body: unknown; headers: Record<string, string> }> = [];

function harnessBody(sessions: unknown[]) {
  return {
    definitions: [
      { id: "codex", displayName: "Codex", origin: "builtin" },
      { id: "custom-one", displayName: "Custom", origin: "custom" }
    ],
    sessions
  };
}

function session(
  state: string,
  resume = false,
  identity: { id?: string; terminalId?: string; title?: string } = {}
) {
  return {
    id: identity.id ?? sessionId,
    harnessId: "codex",
    state,
    terminalSessionId: identity.terminalId ?? terminalId,
    processId: identity.terminalId ?? terminalId,
    title: identity.title ?? "Codex",
    resume,
    nativeSessionId: "provider-session-should-not-render",
    executableSource: { kind: "agent-artifact", reportedVersion: "0.156.1", path: secretPath },
    closureDigest: "b8cfdf0ab86c58ad83ee23b510d7f2dcc4e5dc4feefe949fb74764771826a2c4"
  };
}

function installFetch(sessions: unknown[] | (() => unknown[])) {
  posts.length = 0;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    if (init?.method === "POST") posts.push({ body: JSON.parse(init.body ?? "{}"), headers: init.headers ?? {} });
    if (String(url).includes("/harness")) {
      const current = typeof sessions === "function" ? sessions() : sessions;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(harnessBody(structuredClone(current))) });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        profile: {
          profileId: "codex",
          profileRevision: "1",
          displayName: "Codex",
          availability: { state: "available" },
          capabilities: { interrupt: false, approvals: false, structuredInput: false }
        },
        sessions: [],
        session: null
      })
    });
  }));
}

function findSelectNode(node: FakeNode, label: string): FakeNode | null {
  if (node.nodeName === "SELECT" && node.getAttribute("aria-label") === label) return node;
  for (const child of node.children) {
    const found = findSelectNode(child, label);
    if (found !== null) return found;
  }
  return null;
}

function findClassNode(node: FakeNode, className: string): FakeNode | null {
  if (node.getAttribute("class")?.split(/\s+/u).includes(className) === true) return node;
  for (const child of node.children) {
    const found = findClassNode(child, className);
    if (found !== null) return found;
  }
  return null;
}

function selectedOptionValue(node: FakeNode): string {
  return node.options?.find((option) => option.selected)?.value ?? node.value;
}

function reactChange(node: FakeNode, value: string) {
  const propsKey = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  const onChange = (node as unknown as Record<string, { onChange?: (event: { target: { value: string } }) => void }>)[propsKey ?? ""]?.onChange;
  if (onChange === undefined) throw new Error("select has no change handler");
  act(() => { onChange({ target: { value } }); });
}

async function mount(node: ReturnType<typeof createElement>) {
  const body = installTerminalTestDom(FakeSocket);
  const root = createRoot(body as never);
  roots.push(root);
  act(() => { root.render(node); });
  await settleReact();
  return body;
}

function buttons(body: FakeNode) {
  return findButtons(body).map((button) => buttonText(button));
}

afterEach(() => {
  for (const root of roots) root.unmount();
  roots.length = 0;
  FakeSocket.instances = [];
  vi.unstubAllGlobals();
});

test("native mode is the default and legacy is not shown with it", async () => {
  installFetch([]);
  const { AiWorkbenchTab } = await import("./ai-workbench-tab.js");
  const body = await mount(createElement(AiWorkbenchTab, {
    projectId, workspaceId, active: true, onOpenChangedFile: () => undefined
  }));
  const text = visibleText(body);
  expect(text).toContain("Native");
  expect(text).toContain("Start");
  expect(text).not.toContain("AI session");
  expect(text).not.toContain("Legacy structured");
  expect(text).not.toContain("Create session");
  const legacy = findButtons(body).find((button) => buttonText(button) === "Legacy");
  expect(legacy?.getAttribute("aria-selected")).toBe("false");
  const native = findButtons(body).find((button) => buttonText(button) === "Native");
  expect(native?.getAttribute("aria-selected")).toBe("true");
});

test("legacy structured Codex stays reachable without stacking under native", async () => {
  installFetch([]);
  const { AiWorkbenchTab } = await import("./ai-workbench-tab.js");
  const body = await mount(createElement(AiWorkbenchTab, {
    projectId, workspaceId, active: true, onOpenChangedFile: () => undefined
  }));
  const legacy = findButtons(body).find((button) => buttonText(button) === "Legacy");
  expect(legacy).toBeDefined();
  const propsKey = Object.getOwnPropertyNames(legacy!).find((name) => name.startsWith("__reactProps"));
  const onClick = (legacy as unknown as Record<string, { onClick?: () => void }>)[propsKey ?? ""]?.onClick;
  expect(onClick).toEqual(expect.any(Function));
  act(() => { onClick?.(); });
  await settleReact();
  const text = visibleText(body);
  expect(text).toContain("AI session");
  expect(text).not.toContain("Start a harness");
  expect(text).not.toContain("Legacy structured");
  expect(legacy?.getAttribute("aria-selected")).toBe("true");
});

test("an empty native session shows Start and a provider chooser, not Resume", async () => {
  installFetch([]);
  const { HarnessSessionTab } = await import("./harness-session-tab.js");
  const body = await mount(createElement(HarnessSessionTab, { projectId, workspaceId, active: true }));
  expect(buttons(body)).toContain("Start");
  expect(buttons(body)).not.toContain("Resume");
  expect(body.children.some((node) => node.nodeName === "SECTION" && findSelect(node))).toBe(true);
  expect(visibleText(body)).not.toContain("agent-artifact");
});

test("successful Start selects the returned active session and attaches its terminal", async () => {
  const lostSessionId = "018f1f34-7000-7000-8000-000000000020";
  const createdSessionId = "018f1f34-7000-7000-8000-000000000010";
  const lostTerminalId = "018f1f34-7000-7000-8000-000000000021";
  const createdTerminalId = "018f1f34-7000-7000-8000-000000000011";
  let projected: unknown[] = [session("lost", false, { id: lostSessionId, terminalId: lostTerminalId })];
  posts.length = 0;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    if (String(url).includes("/harness")) {
      if (init?.method === "POST") {
        posts.push({ body: JSON.parse(init.body ?? "{}"), headers: init.headers ?? {} });
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sessionId: createdSessionId, terminalId: createdTerminalId, workspaceId, harnessId: "codex" })
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(harnessBody(structuredClone(projected))) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ profile: null, sessions: [], session: null }) });
  }));

  const { HarnessSessionTab } = await import("./harness-session-tab.js");
  const body = await mount(createElement(HarnessSessionTab, { projectId, workspaceId, active: true }));
  expect(visibleText(findClassNode(body, "native-ai-state")!)).toBe("Connection lost");
  expect(buttons(body)).toContain("Start");

  projected = [
    session("lost", false, { id: lostSessionId, terminalId: lostTerminalId }),
    session("active", false, { id: createdSessionId, terminalId: createdTerminalId })
  ];
  const start = findButtons(body).find((button) => buttonText(button) === "Start");
  await act(async () => {
    reactClick(start!)();
    await settleReact();
  });
  await settleReact();

  const selector = findSelectNode(body, "Native session");
  expect(selector).not.toBeNull();
  expect(selector?.options?.map((option) => option.value)).toEqual([lostSessionId, createdSessionId]);
  expect(selectedOptionValue(selector!)).toBe(createdSessionId);
  expect(visibleText(findClassNode(body, "native-ai-state")!)).toBe("Running");
  expect(FakeSocket.instances.at(-1)?.url).toContain(`/terminals/${createdTerminalId}/stream`);
  expect(FakeSocket.instances.at(-1)?.url).not.toContain(`/terminals/${lostTerminalId}/stream`);
  expect(posts).toHaveLength(1);
  expect(posts[0]?.body).toMatchObject({ action: "create-native", workspaceId, harnessId: "codex" });
});

test("a live native session shows one terminal and neither Start nor a provider switch", async () => {
  installFetch([session("active")]);
  const { HarnessSessionTab } = await import("./harness-session-tab.js");
  const body = await mount(createElement(HarnessSessionTab, { projectId, workspaceId, active: true }));
  expect(buttons(body)).not.toContain("Start");
  expect(buttons(body)).not.toContain("Resume");
  expect(findSelect(body)).toBe(false);
  expect(visibleText(body)).toContain("Running");
  expect(visibleText(body)).toContain("Codex");
  expect(FakeSocket.instances).toHaveLength(1);
  expect(FakeSocket.instances[0]?.url).toContain(terminalId);
  const text = visibleText(body);
  expect(text).not.toContain("agent-artifact");
  expect(text).not.toContain("0.156.1");
  expect(text).not.toContain(secretPath);
  expect(text).not.toContain("provider-session-should-not-render");
  expect(text).not.toContain("b8cfdf0ab86c");
  expect(text).not.toContain("Source:");
});

test("Resume is shown only for a resumable stopped or lost session", async () => {
  installFetch([session("stopped", true)]);
  const { HarnessSessionTab } = await import("./harness-session-tab.js");
  const stopped = await mount(createElement(HarnessSessionTab, { projectId, workspaceId, active: true }));
  expect(buttons(stopped)).toContain("Resume");
  expect(buttons(stopped)).not.toContain("Start");
  expect(visibleText(stopped)).toContain("Stopped");
  expect(findSelect(stopped)).toBe(false);

  for (const root of roots) root.unmount();
  roots.length = 0;
  installFetch([session("lost", true)]);
  const lost = await mount(createElement(HarnessSessionTab, { projectId, workspaceId, active: true }));
  expect(buttons(lost)).toEqual(["Resume"]);
  expect(visibleText(lost)).toContain("Connection lost");
  expect(findSelect(lost)).toBe(false);
});

test("a projection reorder cannot retarget the previously displayed native session", async () => {
  const targetId = "01a0f7e5-a3a9-76ae-b8f3-10e62f60ef38";
  const olderId = "01a0f75e-cd71-70ba-a6c8-70bf50251015";
  const targetTerminalId = "01a0f7e5-a3a9-76ae-b8f3-10e62f60ef39";
  const olderTerminalId = "01a0f75e-cd71-70ba-a6c8-70bf50251016";
  let projected: unknown[] = [
    session("active", false, { id: targetId, terminalId: targetTerminalId }),
    session("lost", true, { id: olderId, terminalId: olderTerminalId })
  ];
  const requests: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
  posts.length = 0;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const requestInit = init === undefined ? undefined : {
      ...(init.method === undefined ? {} : { method: init.method }),
      ...(init.body === undefined ? {} : { body: init.body })
    };
    requests.push(requestInit === undefined ? { url } : { url, init: requestInit });
    if (init?.method === "POST") posts.push({ body: JSON.parse(init.body ?? "{}"), headers: init.headers ?? {} });
    if (String(url).includes("/harness")) {
      // Return new objects on every refresh, as the server projection does.
      return Promise.resolve({ ok: true, json: () => Promise.resolve(harnessBody(structuredClone(projected))) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ profile: null, sessions: [], session: null }) });
  }));

  const { HarnessSessionTab } = await import("./harness-session-tab.js");
  const body = installTerminalTestDom(FakeSocket);
  const root = createRoot(body as never);
  roots.push(root);
  const element = (active: boolean) => createElement(HarnessSessionTab, { projectId, workspaceId, active });
  act(() => { root.render(element(true)); });
  await settleReact();
  expect(FakeSocket.instances.at(-1)?.url).toContain(targetTerminalId);
  const initialSelection = findSelectNode(body, "Native session");
  expect(initialSelection).not.toBeNull();
  reactChange(initialSelection!, targetId);
  await settleReact();
  expect(selectedOptionValue(initialSelection!)).toBe(targetId);

  // Workspace Stop/Start recovery causes a new projection with the older row first.
  // The target remains a lost, resumable row, while the older session is also resumable.
  projected = [
    session("lost", true, { id: olderId, terminalId: olderTerminalId }),
    session("lost", true, { id: targetId, terminalId: targetTerminalId })
  ];
  act(() => { root.render(element(false)); });
  await settleReact(2);
  act(() => { root.render(element(true)); });
  await settleReact();

  const nativeSelection = findSelectNode(body, "Native session");
  expect(nativeSelection).not.toBeNull();
  expect(selectedOptionValue(nativeSelection!)).toBe(targetId);
  const resume = findButtons(body).find((button) => buttonText(button) === "Resume");
  expect(resume).toBeDefined();
  act(() => { reactClick(resume!)(); });
  await settleReact();
  expect(posts.at(-1)?.body).toMatchObject({ action: "resume", sessionId: targetId });
  expect(requests.filter((request) => request.init?.method === "POST")).toHaveLength(1);
});

test("a selected session stays selected when its state changes from lost to stopped", async () => {
  const targetId = "01a0f7e5-a3a9-76ae-b8f3-10e62f60ef38";
  const olderId = "01a0f75e-cd71-70ba-a6c8-70bf50251015";
  let projected: unknown[] = [session("lost", true, { id: targetId }), session("lost", true, { id: olderId })];
  installFetch(() => projected);
  const { HarnessSessionTab } = await import("./harness-session-tab.js");
  const body = installTerminalTestDom(FakeSocket);
  const root = createRoot(body as never);
  roots.push(root);
  const element = (active: boolean) => createElement(HarnessSessionTab, { projectId, workspaceId, active });
  act(() => { root.render(element(true)); });
  await settleReact();
  reactChange(findSelectNode(body, "Native session")!, targetId);
  await settleReact();

  projected = [session("stopped", true, { id: olderId }), session("stopped", true, { id: targetId })];
  act(() => { root.render(element(false)); });
  await settleReact(2);
  act(() => { root.render(element(true)); });
  await settleReact();

  expect(selectedOptionValue(findSelectNode(body, "Native session")!)).toBe(targetId);
  expect(visibleText(body)).toContain("Stopped");
  act(() => { reactClick(findButtons(body).find((button) => buttonText(button) === "Resume")!)(); });
  await settleReact();
  expect(posts.at(-1)?.body).toMatchObject({ action: "resume", sessionId: targetId });
});

test.each([
  ["the selected session disappears while another is resumable", [session("lost", true, { id: "01a0f75e-cd71-70ba-a6c8-70bf50251015" })]],
  ["the selected session becomes non-resumable", [session("lost", false, { id: "01a0f7e5-a3a9-76ae-b8f3-10e62f60ef38" }), session("lost", true, { id: "01a0f75e-cd71-70ba-a6c8-70bf50251015" })]]
])("a stale Resume callback sends no mutation when %s", async (_caseName, nextProjection) => {
  const targetId = "01a0f7e5-a3a9-76ae-b8f3-10e62f60ef38";
  const olderId = "01a0f75e-cd71-70ba-a6c8-70bf50251015";
  let projected: unknown[] = [session("lost", true, { id: targetId }), session("lost", true, { id: olderId })];
  installFetch(() => projected);
  const { HarnessSessionTab } = await import("./harness-session-tab.js");
  const body = installTerminalTestDom(FakeSocket);
  const root = createRoot(body as never);
  roots.push(root);
  const element = (active: boolean) => createElement(HarnessSessionTab, { projectId, workspaceId, active });
  act(() => { root.render(element(true)); });
  await settleReact();
  const selector = findSelectNode(body, "Native session");
  expect(selector).not.toBeNull();
  reactChange(selector!, targetId);
  await settleReact();
  const resume = findButtons(body).find((button) => buttonText(button) === "Resume");
  expect(resume).toBeDefined();
  const staleResumeClick = reactClick(resume!);

  projected = nextProjection;
  act(() => { root.render(element(false)); });
  await settleReact(2);
  act(() => { root.render(element(true)); });
  await settleReact();

  expect(findButtons(body).map((button) => buttonText(button))).not.toContain("Resume");
  act(() => { staleResumeClick(); });
  await settleReact();
  expect(posts).toEqual([]);
});

test("Resume follows the explicitly selected session when another session is selected", async () => {
  const targetId = "01a0f7e5-a3a9-76ae-b8f3-10e62f60ef38";
  const olderId = "01a0f75e-cd71-70ba-a6c8-70bf50251015";
  installFetch([session("lost", true, { id: targetId }), session("lost", true, { id: olderId })]);
  const { HarnessSessionTab } = await import("./harness-session-tab.js");
  const body = await mount(createElement(HarnessSessionTab, { projectId, workspaceId, active: true }));
  const selector = findSelectNode(body, "Native session");
  expect(selector).not.toBeNull();
  expect(selectedOptionValue(selector!)).toBe(targetId);
  reactChange(selector!, olderId);
  await settleReact();
  const resume = findButtons(body).find((button) => buttonText(button) === "Resume");
  act(() => { reactClick(resume!)(); });
  await settleReact();
  expect(posts.at(-1)?.body).toMatchObject({ action: "resume", sessionId: olderId });
});

test("Native/Legacy presentation switching preserves the selected native session id", async () => {
  const targetId = "01a0f7e5-a3a9-76ae-b8f3-10e62f60ef38";
  const olderId = "01a0f75e-cd71-70ba-a6c8-70bf50251015";
  let projected = [session("lost", true, { id: targetId }), session("lost", true, { id: olderId })];
  installFetch(() => projected);
  const { AiWorkbenchTab } = await import("./ai-workbench-tab.js");
  const body = await mount(createElement(AiWorkbenchTab, { projectId, workspaceId, active: true, onOpenChangedFile: () => undefined }));
  const selection = findSelectNode(body, "Native session");
  expect(selection).not.toBeNull();
  reactChange(selection!, olderId);
  await settleReact();

  const legacy = findButtons(body).find((button) => buttonText(button) === "Legacy");
  act(() => { reactClick(legacy!)(); });
  await settleReact(2);
  projected = [session("lost", true, { id: targetId }), session("lost", true, { id: olderId })];
  const native = findButtons(body).find((button) => buttonText(button) === "Native");
  act(() => { reactClick(native!)(); });
  await settleReact();

  const selectionAfterSwitch = findSelectNode(body, "Native session");
  expect(selectionAfterSwitch).not.toBeNull();
  const resume = findButtons(body).find((button) => buttonText(button) === "Resume");
  expect(resume).toBeDefined();
  act(() => { reactClick(resume!)(); });
  await settleReact();
  expect(posts.at(-1)?.body).toMatchObject({ action: "resume", sessionId: olderId });
});

test("switching away from the AI surface and back reuses the same terminal socket", async () => {
  installFetch([session("active")]);
  const { AiWorkbenchTab } = await import("./ai-workbench-tab.js");
  const body = installTerminalTestDom(FakeSocket);
  const root = createRoot(body as never);
  roots.push(root);
  const element = (active: boolean) => createElement(AiWorkbenchTab, {
    projectId, workspaceId, active, onOpenChangedFile: () => undefined
  });
  act(() => { root.render(element(true)); });
  await settleReact();
  expect(FakeSocket.instances).toHaveLength(1);
  act(() => { root.render(element(false)); });
  await settleReact(2);
  act(() => { root.render(element(true)); });
  await settleReact();
  expect(FakeSocket.instances).toHaveLength(1);
  expect(posts).toEqual([]);
});

test("Start and Resume send the DevSpace CSRF marker", async () => {
  installFetch([]);
  const { HarnessSessionTab } = await import("./harness-session-tab.js");
  const empty = await mount(createElement(HarnessSessionTab, { projectId, workspaceId, active: true }));
  const start = findButtons(empty).find((button) => buttonText(button) === "Start");
  const startClick = reactClick(start!);
  act(() => { startClick(); });
  expect(posts.at(-1)).toMatchObject({
    body: { action: "create-native", workspaceId, harnessId: "codex" },
    headers: { "content-type": "application/json", "x-devspace-csrf": "1" }
  });

  for (const root of roots) root.unmount();
  roots.length = 0;
  posts.length = 0;
  installFetch([session("stopped", true)]);
  const stopped = await mount(createElement(HarnessSessionTab, { projectId, workspaceId, active: true }));
  const resume = findButtons(stopped).find((button) => buttonText(button) === "Resume");
  const resumeClick = reactClick(resume!);
  act(() => { resumeClick(); });
  expect(posts.at(-1)).toMatchObject({
    body: { action: "resume", workspaceId, sessionId },
    headers: { "content-type": "application/json", "x-devspace-csrf": "1" }
  });
});

function reactClick(node: FakeNode): () => void {
  const propsKey = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  const onClick = (node as unknown as Record<string, { onClick?: () => void }>)[propsKey ?? ""]?.onClick;
  if (onClick === undefined) throw new Error("button has no click handler");
  return onClick;
}

function findSelect(node: FakeNode): boolean {
  if (node.nodeName === "SELECT") return !node.hidden && node.parentNode instanceof Object;
  return node.hidden ? false : node.children.some((child) => findSelect(child));
}
