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
const posts: unknown[] = [];

function harnessBody(sessions: unknown[]) {
  return {
    definitions: [
      { id: "codex", displayName: "Codex", origin: "builtin" },
      { id: "custom-one", displayName: "Custom", origin: "custom" }
    ],
    sessions
  };
}

function session(state: string, resume = false) {
  return {
    id: sessionId,
    harnessId: "codex",
    state,
    terminalSessionId: terminalId,
    processId: terminalId,
    title: "Codex",
    resume,
    nativeSessionId: "provider-session-should-not-render",
    executableSource: { kind: "agent-artifact", reportedVersion: "0.156.1", path: secretPath },
    closureDigest: "b8cfdf0ab86c58ad83ee23b510d7f2dcc4e5dc4feefe949fb74764771826a2c4"
  };
}

function installFetch(sessions: unknown[]) {
  posts.length = 0;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") posts.push(JSON.parse(init.body ?? "{}"));
    if (String(url).includes("/harness")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(harnessBody(sessions)) });
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

function findSelect(node: FakeNode): boolean {
  if (node.nodeName === "SELECT") return !node.hidden && node.parentNode instanceof Object;
  return node.hidden ? false : node.children.some((child) => findSelect(child));
}
