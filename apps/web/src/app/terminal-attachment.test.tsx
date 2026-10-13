/**
 * @vitest-environment node
 */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { buttonText, FakeNode, findButtons, installTerminalTestDom, settleReact } from "./terminal-test-dom.js";
import { decodeTerminalClientFrame, encodeTerminalAgentFrame } from "@devspace/contracts";

const xtermState = vi.hoisted(() => ({ writes: [] as Uint8Array[], resets: 0, selection: "selected history text" }));

class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  binaryType = "";
  readyState = 0;
  url: string;
  sent: Uint8Array[] = [];
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: ArrayBuffer) { this.sent.push(new Uint8Array(data)); }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  emitReady() {
    this.readyState = 1;
    this.onmessage?.({ data: Uint8Array.of(0x11).buffer });
  }
  emitPersistentReady(attachmentId: string) {
    this.readyState = 1;
    const frame = encodeTerminalAgentFrame({ type: "ready", version: 2, attachmentId });
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer });
  }
  emitClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  emitExit() {
    this.onmessage?.({ data: Uint8Array.of(0x13, 0x00).buffer });
  }
  emitOutput(data: Uint8Array) {
    const frame = encodeTerminalAgentFrame({ type: "output", data });
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer });
  }
}

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() { /* fit addon is unused */ }
    open() { /* canvas is not required */ }
    focus() { /* focus is irrelevant */ }
    reset() { xtermState.resets += 1; }
    getSelection() { return xtermState.selection; }
    write(data: Uint8Array) { xtermState.writes.push(data); }
    onData() { return { dispose() { /* unused */ } }; }
    onBinary() { return { dispose() { /* unused */ } }; }
    dispose() { /* attachment teardown */ }
  }
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() { /* no layout */ }
    proposeDimensions() { return { cols: 80, rows: 24 }; }
  }
}));

const projectId = "018f1f34-7000-7000-8000-000000000001";
const workspaceId = "018f1f34-7000-7000-8000-000000000002";
const terminalId = "018f1f34-7000-7000-8000-000000000003";
const replacementId = "018f1f34-7000-7000-8000-000000000004";
const roots: Root[] = [];

afterEach(() => {
  for (const root of roots) root.unmount();
  roots.length = 0;
  FakeSocket.instances = [];
  xtermState.writes = [];
  xtermState.resets = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function reactProps(node: FakeNode): { onClick?: () => void } {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (key === undefined) throw new Error("React props are not attached to the terminal test node");
  return (node as unknown as Record<string, { onClick?: () => void }>)[key]!;
}

test("parent refresh after ready does not open a second terminal socket", async () => {
  const rootElement = installTerminalTestDom(FakeSocket);
  const { TerminalTab } = await import("./terminal-tab.js");
  function Harness() {
    const [tick, setTick] = useState(0);
    return createElement("div", null,
      createElement("span", null, String(tick)),
      createElement(TerminalTab, {
        projectId,
        workspaceId,
        terminal: { id: terminalId, processId: terminalId, title: "Codex", state: "active" },
        active: true,
        onRefresh: () => setTick((value) => value + 1),
        onTerminalStateChange: () => setTick((value) => value + 1)
      }));
  }
  const root = createRoot(rootElement as never);
  roots.push(root);
  act(() => { root.render(createElement(Harness)); });
  await settleReact();
  const attached = FakeSocket.instances.length;
  expect(attached).toBeGreaterThan(0);
  act(() => { FakeSocket.instances.at(-1)?.emitReady(); });
  await settleReact(2);
  expect(FakeSocket.instances).toHaveLength(attached);
});

test("a new terminal identity opens a new socket and exit still refreshes", async () => {
  const rootElement = installTerminalTestDom(FakeSocket);
  const { TerminalTab } = await import("./terminal-tab.js");
  const refreshes: string[] = [];
  function Harness({ id }: { id: string }) {
    return createElement(TerminalTab, {
      projectId,
      workspaceId,
      terminal: { id, processId: id, title: "Codex", state: "active" },
      active: true,
      onRefresh: () => { refreshes.push(id); },
      onTerminalStateChange: () => undefined
    });
  }
  const root = createRoot(rootElement as never);
  roots.push(root);
  act(() => { root.render(createElement(Harness, { id: terminalId })); });
  await settleReact();
  expect(FakeSocket.instances).toHaveLength(1);
  act(() => { root.render(createElement(Harness, { id: replacementId })); });
  await settleReact();
  expect(FakeSocket.instances).toHaveLength(2);
  expect(FakeSocket.instances[1]?.url).toContain(replacementId);
  const beforeExit = refreshes.length;
  act(() => { FakeSocket.instances[1]?.emitExit(); });
  expect(refreshes.slice(beforeExit)).toEqual([replacementId]);
});

test("hiding and showing the same terminal does not open another socket", async () => {
  const rootElement = installTerminalTestDom(FakeSocket);
  const { TerminalTab } = await import("./terminal-tab.js");
  function Harness({ active }: { active: boolean }) {
    return createElement(TerminalTab, {
      projectId,
      workspaceId,
      terminal: { id: terminalId, processId: terminalId, title: "Codex", state: "active" },
      active,
      onRefresh: () => undefined,
      onTerminalStateChange: () => undefined
    });
  }
  const root = createRoot(rootElement as never);
  roots.push(root);
  act(() => { root.render(createElement(Harness, { active: true })); });
  await settleReact();
  expect(FakeSocket.instances).toHaveLength(1);
  act(() => { FakeSocket.instances[0]?.emitReady(); });
  act(() => { root.render(createElement(Harness, { active: false })); });
  await settleReact(2);
  act(() => { root.render(createElement(Harness, { active: true })); });
  await settleReact(2);
  expect(FakeSocket.instances).toHaveLength(1);
  expect(FakeSocket.instances[0]?.readyState).toBe(1);
});

test("valid PTY output after ready reaches xterm with ANSI and screen-control bytes intact", async () => {
  const rootElement = installTerminalTestDom(FakeSocket);
  const { TerminalTab } = await import("./terminal-tab.js");
  const root = createRoot(rootElement as never);
  roots.push(root);
  act(() => { root.render(createElement(TerminalTab, {
    projectId, workspaceId,
    terminal: { id: terminalId, processId: terminalId, title: "Codex", state: "active" },
    active: true, onRefresh: () => undefined, onTerminalStateChange: () => undefined
  })); });
  await settleReact();
  const socket = FakeSocket.instances[0];
  expect(socket).toBeDefined();
  act(() => { socket?.emitReady(); });
  await settleReact();
  const bytes = new TextEncoder().encode("plain\u001b[31mred\u001b[0m\u001b[?1049h\u001b[2J\u001b[Hscreen\u001b[?1049l");
  act(() => { socket?.emitOutput(bytes); });

  expect(xtermState.writes).toEqual([bytes]);
});

test("persistent ready resets xterm, resizes after the first redraw, and exposes history and copy controls", async () => {
  const body = installTerminalTestDom(FakeSocket);
  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: clipboardWrite } });
  const { TerminalTab } = await import("./terminal-tab.js");
  const root = createRoot(body as never);
  roots.push(root);
  act(() => { root.render(createElement(TerminalTab, {
    projectId, workspaceId,
    terminal: { id: terminalId, processId: terminalId, title: "Terminal 1", state: "active" },
    active: true, onRefresh: () => undefined, onTerminalStateChange: () => undefined
  })); });
  await settleReact();
  const socket = FakeSocket.instances[0]!;
  act(() => { socket.emitPersistentReady("018f1f34-7000-7000-8000-000000000099"); });
  await settleReact();

  expect(xtermState.resets).toBe(1);
  const sentFrames = () => socket.sent.map((frame) => {
    const decoded = decodeTerminalClientFrame(frame);
    return decoded.ok ? decoded.frame : null;
  });
  expect(sentFrames()).not.toContainEqual({ type: "resize", columns: 80, rows: 24 });
  const redraw = new TextEncoder().encode("restored tmux screen");
  act(() => { socket.emitOutput(redraw); });
  expect(xtermState.writes).toEqual([redraw]);
  expect(sentFrames()).toContainEqual({ type: "resize", columns: 80, rows: 24 });
  const buttons = findButtons(body);
  for (const label of ["History", "Return to live", "Copy selection"]) {
    const button = buttons.find((candidate) => buttonText(candidate) === label);
    expect(button).toBeDefined();
    act(() => { reactProps(button!).onClick?.(); });
  }
  expect(socket.sent.map((frame) => frame[0])).toEqual(expect.arrayContaining([0x02, 0x04, 0x05]));
  await settleReact();
  expect(clipboardWrite).toHaveBeenCalledWith("selected history text");
});

test("reconnect retries stop after the bound and expose a working manual Reconnect button", async () => {
  const body = installTerminalTestDom(FakeSocket);
  const fakeWindow = window as unknown as {
    setTimeout: (callback: () => void, delayMs?: number) => number;
    clearTimeout: (timerId: number) => void;
  };
  let nextTimerId = 0;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  fakeWindow.setTimeout = (callback, delayMs = 0) => {
    const timerId = ++nextTimerId;
    timers.set(timerId, { callback, delayMs });
    return timerId;
  };
  fakeWindow.clearTimeout = (timerId) => { timers.delete(timerId); };
  const { TerminalTab } = await import("./terminal-tab.js");
  const root = createRoot(body as never);
  roots.push(root);
  act(() => { root.render(createElement(TerminalTab, {
    projectId, workspaceId,
    terminal: { id: terminalId, processId: terminalId, title: "Terminal 1", state: "active" },
    active: true, onRefresh: () => undefined, onTerminalStateChange: () => undefined
  })); });
  await settleReact();
  const runTimer = async (delayMs?: number) => {
    const entry = [...timers.entries()].sort((left, right) => left[1].delayMs - right[1].delayMs)
      .find(([, timer]) => delayMs === undefined || timer.delayMs === delayMs);
    if (entry === undefined) throw new Error("Expected terminal reconnect timer was not scheduled");
    timers.delete(entry[0]);
    act(() => { entry[1].callback(); });
    await settleReact();
  };
  await runTimer(0);
  FakeSocket.instances[0]!.emitReady();
  await settleReact();
  await runTimer(1_000);

  for (let retry = 0; retry < 8; retry += 1) {
    FakeSocket.instances.at(-1)!.emitClose(1006);
    await settleReact();
    await runTimer();
  }
  FakeSocket.instances.at(-1)!.emitClose(1006);
  await settleReact();
  expect(FakeSocket.instances).toHaveLength(9);
  expect(findButtons(body).map((button) => buttonText(button))).toContain("Reconnect");
  const reconnect = findButtons(body).find((button) => buttonText(button) === "Reconnect")!;
  act(() => { reactProps(reconnect).onClick?.(); });
  await settleReact();
  expect(FakeSocket.instances).toHaveLength(10);
});

test("Native harness terminal marks attachment and first output without recording PTY bytes", async () => {
  const rootElement = installTerminalTestDom(FakeSocket);
  const { TerminalTab } = await import("./terminal-tab.js");
  const mark = vi.spyOn(performance, "mark");
  const root = createRoot(rootElement as never);
  roots.push(root);
  act(() => { root.render(createElement(TerminalTab, {
    projectId, workspaceId, nativeHarnessSessionId: "018f1f34-7000-7000-8000-000000000006",
    terminal: { id: terminalId, processId: terminalId, title: "Codex", state: "active" },
    active: true, onRefresh: () => undefined, onTerminalStateChange: () => undefined
  })); });
  await settleReact();
  const socket = FakeSocket.instances[0];
  expect(socket).toBeDefined();
  act(() => { socket?.emitReady(); });
  await settleReact(2);
  const output = new TextEncoder().encode("private terminal output");
  act(() => { socket?.emitOutput(output); });
  await settleReact(2);

  const markNames = mark.mock.calls.map(([name]) => name);
  expect(markNames).toEqual(expect.arrayContaining([
    "devspace.native-harness.terminal-attach-started",
    "devspace.native-harness.terminal-attached",
    "devspace.native-harness.first-terminal-output"
  ]));
  expect(JSON.stringify(mark.mock.calls)).toContain("018f1f34-7000-7000-8000-000000000006");
  expect(JSON.stringify(mark.mock.calls)).not.toContain("private terminal output");
});

test("a closed fast-exit terminal receives its one-shot retained output and exit frame", async () => {
  const rootElement = installTerminalTestDom(FakeSocket);
  const { TerminalTab } = await import("./terminal-tab.js");
  const states: string[] = [];
  const root = createRoot(rootElement as never);
  roots.push(root);
  act(() => { root.render(createElement(TerminalTab, {
    projectId, workspaceId,
    terminal: { id: terminalId, processId: terminalId, title: "Terminal 1", state: "closed" },
    active: true, onRefresh: () => undefined, onTerminalStateChange: (_id, state) => states.push(state)
  })); });
  await settleReact();
  expect(FakeSocket.instances).toHaveLength(1);
  const socket = FakeSocket.instances[0]!;
  act(() => { socket.emitReady(); });
  const output = new TextEncoder().encode("FAST_EXIT_DIAGNOSTIC");
  act(() => { socket.emitOutput(output); socket.emitExit(); });
  await settleReact(2);

  expect(xtermState.writes).toEqual([output]);
  expect(states.at(-1)).toBe("closed");
  expect(FakeSocket.instances).toHaveLength(1);
});
