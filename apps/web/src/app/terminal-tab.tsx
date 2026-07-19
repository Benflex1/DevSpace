"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { TERMINAL_SUBPROTOCOL, decodeTerminalAgentFrame, encodeTerminalClientFrame } from "@devspace/contracts";

export type TerminalUiState = "connecting" | "active" | "disconnected" | "closed" | "failed" | "lost";
export type TerminalView = { id: string; processId: string; state: string };

export function terminalUiState(view: TerminalView): TerminalUiState {
  return view.state === "active" ? "disconnected" : (view.state as TerminalUiState);
}

export function TerminalTab({ projectId, workspaceId, terminal, active, onStateChange, onRefresh }: {
  projectId: string;
  workspaceId: string;
  terminal: TerminalView;
  active: boolean;
  onStateChange: (terminalId: string, state: TerminalUiState) => void;
  onRefresh: () => void;
}) {
  const [state, setState] = useState<TerminalUiState>(() => terminalUiState(terminal));
  const [message, setMessage] = useState("");
  const terminalElement = useRef<HTMLDivElement>(null);
  const xterm = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const socket = useRef<WebSocket | null>(null);
  const stateChange = useRef(onStateChange);
  stateChange.current = onStateChange;
  const updateState = (next: TerminalUiState) => {
    setState(next);
    stateChange.current(terminal.id, next);
  };

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
      disposeResources = () => {
        dataDisposable.dispose();
        binaryDisposable.dispose();
        resize.disconnect();
        window.removeEventListener("resize", scheduleResize);
        if (ready && currentSocket?.readyState === WebSocket.OPEN) {
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
    };
    // A tab owns one terminal attachment for its entire mounted lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, terminal.id, workspaceId]);

  return <section className={`terminal-tab-surface ${active ? "is-active" : "is-inactive"}`} aria-hidden={!active}
    aria-label={`Terminal ${terminal.id}`} role={active ? "region" : undefined}>
    <div className="terminal-tab-header">
      <span className={`terminal-state ${state}`}>{state}</span>
      <span className="terminal-identity">{terminal.processId.slice(0, 8)}</span>
    </div>
    <div ref={terminalElement} className="terminal-canvas" />
    {message !== "" && <p className="message" role={active ? "status" : undefined}>{message}</p>}
    {active && ["closed", "failed", "lost"].includes(state) && <p className="terminal-help">This terminal is no longer attachable. Create a replacement from the sidebar.</p>}
  </section>;
}
