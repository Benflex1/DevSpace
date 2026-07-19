"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { TERMINAL_SUBPROTOCOL, decodeTerminalAgentFrame, encodeTerminalClientFrame } from "@devspace/contracts";
import { isTerminalAttachableState, reconcileTerminalState, terminalUiState, type TerminalUiState } from "./terminal-lifecycle.js";
export type TerminalView = { id: string; processId: string; state: string };

export function TerminalTab({ projectId, workspaceId, terminal, active, onRefresh }: {
  projectId: string;
  workspaceId: string;
  terminal: TerminalView;
  active: boolean;
  onRefresh: () => void;
}) {
  const [state, setState] = useState<TerminalUiState>(() => terminalUiState(terminal.state));
  const [message, setMessage] = useState("");
  const terminalElement = useRef<HTMLDivElement>(null);
  const xterm = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const socket = useRef<WebSocket | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const authoritativeState = useRef(terminal.state);
  authoritativeState.current = terminal.state;
  const closeAttachment = useRef<(() => void) | null>(null);
  const updateState = (next: TerminalUiState) => {
    setState(next);
  };

  useEffect(() => {
    const reconciliation = reconcileTerminalState(terminal.state, stateRef.current);
    if (!reconciliation.closeAttachment) return;
    updateState(reconciliation.state);
    setMessage(terminal.state === "creating" ? "Terminal is still being created." : "This terminal is no longer attachable.");
    closeAttachment.current?.();
  }, [terminal.id, terminal.state]);

  useEffect(() => {
    const element = terminalElement.current;
    if (element === null) return;
    const terminalInstance = xterm.current;
    if (active && terminalInstance !== null) {
      window.requestAnimationFrame(() => fitAddon.current?.fit());
    }
  }, [active]);

  useEffect(() => {
    const element = terminalElement.current;
    if (element === null) {
      updateState("failed");
      return;
    }
    let cancelled = false;
    let reconnectTimer: number | null = null;
    let stableConnectionTimer: number | null = null;
    let resizeFrame: number | null = null;
    let resizeRetryTimer: number | null = null;
    let reconnectAttempts = 0;
    let currentSocket: WebSocket | null = null;
    let ready = false;
    let terminalEnded = false;
    let disposeResources = () => undefined;
    const start = window.setTimeout(() => {
      if (!isTerminalAttachableState(terminal.state)) {
        updateState(terminalUiState(terminal.state));
        return;
      }
      updateState("connecting");
      setMessage("");
      const terminalInstance = new Terminal({ cursorBlink: true, convertEol: true, fontSize: 14, screenReaderMode: true,
        theme: { background: "#101418", foreground: "#e7eef5" } });
      const fit = new FitAddon();
      terminalInstance.loadAddon(fit);
      fitAddon.current = fit;
      terminalInstance.open(element);
      terminalInstance.focus();
      xterm.current = terminalInstance;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const send = (frame: ReturnType<typeof encodeTerminalClientFrame>) => {
        if (ready && currentSocket?.readyState === WebSocket.OPEN) currentSocket.send(frame);
      };
      let lastColumns = 0;
      let lastRows = 0;
      const scheduleResize = () => {
        if (!activeRef.current) return;
        if (resizeFrame !== null) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = null;
          if (element.clientWidth === 0 || element.clientHeight === 0) {
            if (resizeRetryTimer === null) resizeRetryTimer = window.setTimeout(() => {
              resizeRetryTimer = null; scheduleResize();
            }, 50);
            return;
          }
          const dimensions = fit.proposeDimensions();
          if (dimensions === undefined) {
            if (resizeRetryTimer === null) resizeRetryTimer = window.setTimeout(() => {
              resizeRetryTimer = null; scheduleResize();
            }, 50);
            return;
          }
          fit.fit();
          if (terminalInstance.cols === lastColumns && terminalInstance.rows === lastRows) return;
          lastColumns = terminalInstance.cols;
          lastRows = terminalInstance.rows;
          send(encodeTerminalClientFrame({ type: "resize", columns: terminalInstance.cols, rows: terminalInstance.rows }));
        });
      };
      const dataDisposable = terminalInstance.onData((data) => send(encodeTerminalClientFrame({ type: "input", data: new TextEncoder().encode(data) })));
      const binaryDisposable = terminalInstance.onBinary((data) => send(encodeTerminalClientFrame({ type: "input",
        data: Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff) })));
      const resize = new ResizeObserver(scheduleResize);
      resize.observe(element);
      window.addEventListener("resize", scheduleResize);
      const connectSocket = () => {
        if (cancelled || terminalEnded) return;
        const webSocket = new WebSocket(`${protocol}//${window.location.host}/api/projects/${projectId}/workspaces/${workspaceId}/terminals/${terminal.id}/stream`, TERMINAL_SUBPROTOCOL);
        webSocket.binaryType = "arraybuffer";
        currentSocket = webSocket;
        socket.current = webSocket;
        ready = false;
        webSocket.onmessage = (event) => {
          if (currentSocket !== webSocket) return;
          if (!(event.data instanceof ArrayBuffer)) { webSocket.close(1002); return; }
          const decoded = decodeTerminalAgentFrame(new Uint8Array(event.data));
          if (!decoded.ok) { webSocket.close(1002); return; }
          if (decoded.frame.type === "ready") {
            ready = true;
            updateState("active");
            scheduleResize();
            if (stableConnectionTimer !== null) window.clearTimeout(stableConnectionTimer);
            stableConnectionTimer = window.setTimeout(() => { reconnectAttempts = 0; }, 1_000);
            return;
          }
          if (decoded.frame.type === "output") { terminalInstance.write(decoded.frame.data); return; }
          terminalEnded = true;
          updateState("closed");
          setMessage(decoded.frame.exitCode === null ? "Terminal exited." : `Terminal exited with code ${decoded.frame.exitCode}.`);
        };
        webSocket.onclose = (event) => {
          if (currentSocket !== webSocket) return;
          ready = false;
          currentSocket = null;
          if (socket.current === webSocket) socket.current = null;
          if (cancelled || terminalEnded) return;
          if (event.code === 4000) { onRefresh(); return; }
          updateState("disconnected");
          reconnectAttempts += 1;
          if (reconnectAttempts > 8) { updateState("failed"); onRefresh(); return; }
          reconnectTimer = window.setTimeout(connectSocket, Math.min(150 * (2 ** (reconnectAttempts - 1)), 2_000));
        };
        webSocket.onerror = () => undefined;
      };
      connectSocket();
      closeAttachment.current = () => {
        terminalEnded = true;
        if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
        currentSocket?.close();
      };
      disposeResources = () => {
        dataDisposable.dispose();
        binaryDisposable.dispose();
        resize.disconnect();
        window.removeEventListener("resize", scheduleResize);
        if (ready && isTerminalAttachableState(authoritativeState.current) && currentSocket?.readyState === WebSocket.OPEN) {
          currentSocket.send(encodeTerminalClientFrame({ type: "detach" }));
        }
        if (currentSocket?.readyState !== WebSocket.CLOSED) currentSocket?.close();
        terminalInstance.dispose();
        if (xterm.current === terminalInstance) xterm.current = null;
        if (fitAddon.current === fit) fitAddon.current = null;
      };
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(start);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (stableConnectionTimer !== null) window.clearTimeout(stableConnectionTimer);
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      if (resizeRetryTimer !== null) window.clearTimeout(resizeRetryTimer);
      disposeResources();
      closeAttachment.current = null;
    };
    // A tab owns one terminal attachment for its entire mounted lifetime.
  }, [projectId, terminal.id, terminal.state, workspaceId]);

  return <section className={`terminal-tab-surface ${active ? "is-active" : "is-inactive"}`} aria-hidden={!active}
    aria-label={`Terminal ${terminal.id}`} role={active ? "region" : undefined}>
    <div className="terminal-tab-header">
      <span className={`terminal-state ${state}`}>{state}</span>
      <span className="terminal-identity">{terminal.processId.slice(0, 8)}</span>
    </div>
    <div ref={terminalElement} className="terminal-canvas" />
    {message !== "" && <p className="message" role={active ? "status" : undefined}>{message}</p>}
    {active && ["creating", "closing", "closed", "failed", "lost"].includes(state) && <p className="terminal-help">
      {state === "creating" ? "This terminal is still being created." : "This terminal is no longer attachable. Create a replacement from the sidebar."}
    </p>}
  </section>;
}
