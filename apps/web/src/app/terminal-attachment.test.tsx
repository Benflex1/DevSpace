/**
 * @vitest-environment node
 */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { installTerminalTestDom, settleReact } from "./terminal-test-dom.js";
import { encodeTerminalAgentFrame } from "@devspace/contracts";

const xtermState = vi.hoisted(() => ({ writes: [] as Uint8Array[] }));

class FakeSocket {
  static instances: FakeSocket[] = [];
  binaryType = "";
  readyState = 0;
  url: string;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send() { /* recorded by the caller when needed */ }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  emitReady() {
    this.readyState = 1;
    this.onmessage?.({ data: Uint8Array.of(0x11).buffer });
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
});

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
