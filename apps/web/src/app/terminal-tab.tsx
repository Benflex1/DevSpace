"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { TERMINAL_SUBPROTOCOL, decodeTerminalAgentFrame, encodeTerminalClientFrame } from "@devspace/contracts";
import { isTerminalAttachableState, isTerminalOpenableState, reconcileTerminalState, terminalSocketCloseAction, terminalStateMessage, terminalUiState, type TerminalUiState } from "./terminal-lifecycle.js";
export type TerminalView = { id: string; processId: string; title: string; state: string };

export function TerminalTab({ projectId, workspaceId, terminal, active, nativeHarnessSessionId, onRefresh, onTerminalStateChange }: {
  projectId: string;
  workspaceId: string;
  terminal: TerminalView;
  active: boolean;
  nativeHarnessSessionId?: string;
  onRefresh: () => void;
  onTerminalStateChange: (terminalId: string, state: string) => void;
}) {
  const [state, setState] = useState<TerminalUiState>(() => terminalUiState(terminal.state));
  const [message, setMessage] = useState("");
  const [persistentReady, setPersistentReady] = useState(false);
  const [manualReconnectAvailable, setManualReconnectAvailable] = useState(false);
  const terminalElement = useRef<HTMLDivElement>(null);
  const xterm = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const nativeHarnessSessionIdRef = useRef(nativeHarnessSessionId);
  nativeHarnessSessionIdRef.current = nativeHarnessSessionId;
  const socket = useRef<WebSocket | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const authoritativeState = useRef(terminal.state);
  authoritativeState.current = terminal.state;
  const closeAttachment = useRef<(() => void) | null>(null);
  const manualReconnect = useRef<(() => void) | null>(null);
  const persistentControl = useRef<((type: "history" | "live") => void) | null>(null);
  const onRefreshRef = useRef(onRefresh);
  const onTerminalStateChangeRef = useRef(onTerminalStateChange);
  onRefreshRef.current = onRefresh;
  onTerminalStateChangeRef.current = onTerminalStateChange;
  const updateState = (next: TerminalUiState) => {
    setState(next);
  };

  useEffect(() => {
    const reconciliation = reconcileTerminalState(terminal.state, stateRef.current);
    if (!reconciliation.closeAttachment) return;
    updateState(reconciliation.state);
    setMessage(terminalStateMessage(terminal.state));
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
    let nativeAttachStarted = false;
    let nativeAttached = false;
    let nativeFirstOutput = false;
    let attachmentConflict = false;
    const markNativeHarness = (name: string) => {
      const sessionId = nativeHarnessSessionIdRef.current;
      if (sessionId === undefined) return;
      try {
        performance.mark(name, { detail: {
          sessionId, workspaceId, terminalId: terminal.id
        } });
      } catch { /* performance diagnostics must not affect terminal attachment */ }
    };
    let disposeResources = () => undefined;
    const requestRefresh = () => {
      onRefreshRef.current();
    };
    const start = window.setTimeout(() => {
      if (!isTerminalOpenableState(authoritativeState.current)) {
        updateState(terminalUiState(authoritativeState.current));
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
      const sendFrame = (socket: WebSocket, frame: ReturnType<typeof encodeTerminalClientFrame>) => {
        const payload = new ArrayBuffer(frame.byteLength);
        new Uint8Array(payload).set(frame);
        socket.send(payload);
      };
      const send = (frame: ReturnType<typeof encodeTerminalClientFrame>) => {
        if (ready && currentSocket?.readyState === WebSocket.OPEN) sendFrame(currentSocket, frame);
      };
      let lastColumns = 0;
      let lastRows = 0;
      let persistentResizePending = false;
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
          if (persistentResizePending) {
            lastColumns = terminalInstance.cols;
            lastRows = terminalInstance.rows;
            return;
          }
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
        if (!nativeAttachStarted) {
          nativeAttachStarted = true;
          markNativeHarness("devspace.native-harness.terminal-attach-started");
        }
        const webSocket = new WebSocket(`${protocol}//${window.location.host}/api/projects/${projectId}/workspaces/${workspaceId}/terminals/${terminal.id}/stream`, TERMINAL_SUBPROTOCOL);
        webSocket.binaryType = "arraybuffer";
        currentSocket = webSocket;
        socket.current = webSocket;
        ready = false;
        persistentResizePending = false;
        setPersistentReady(false);
        persistentControl.current = null;
        webSocket.onmessage = (event) => {
          if (currentSocket !== webSocket) return;
          if (!(event.data instanceof ArrayBuffer)) { webSocket.close(1002); return; }
          const decoded = decodeTerminalAgentFrame(new Uint8Array(event.data));
          if (!decoded.ok) { webSocket.close(1002); return; }
          if (decoded.frame.type === "ready") {
            const isPersistent = "version" in decoded.frame && decoded.frame.version === 2;
            if (isPersistent) {
              persistentResizePending = true;
              terminalInstance.reset();
              lastColumns = 0;
              lastRows = 0;
              setPersistentReady(true);
              persistentControl.current = (type) => send(encodeTerminalClientFrame({ type }));
            }
            ready = true;
            if (!nativeAttached) {
              nativeAttached = true;
              markNativeHarness("devspace.native-harness.terminal-attached");
            }
            updateState("active");
            onTerminalStateChangeRef.current(terminal.id, "active");
            requestRefresh();
            if (isPersistent) {
              lastColumns = terminalInstance.cols;
              lastRows = terminalInstance.rows;
            }
            scheduleResize();
            setManualReconnectAvailable(false);
            if (stableConnectionTimer !== null) window.clearTimeout(stableConnectionTimer);
            stableConnectionTimer = window.setTimeout(() => { stableConnectionTimer = null; reconnectAttempts = 0; }, 1_000);
            return;
          }
          if (decoded.frame.type === "output") {
            if (!nativeFirstOutput) {
              nativeFirstOutput = true;
              markNativeHarness("devspace.native-harness.first-terminal-output");
            }
            terminalInstance.write(decoded.frame.data);
            if (persistentResizePending) {
              persistentResizePending = false;
              lastColumns = terminalInstance.cols;
              lastRows = terminalInstance.rows;
              send(encodeTerminalClientFrame({ type: "resize", columns: terminalInstance.cols, rows: terminalInstance.rows }));
            }
            return;
          }
          if (decoded.frame.type === "attachment-conflict") {
            attachmentConflict = true;
            setManualReconnectAvailable(true);
            updateState("disconnected");
            setMessage("This terminal is already attached in another browser tab. Close that tab, then reconnect here.");
            webSocket.close(1000, "Terminal already attached.");
            return;
          }
          terminalEnded = true;
          updateState("closed");
          onTerminalStateChangeRef.current(terminal.id, "closed");
          setMessage(decoded.frame.exitCode === null ? "Terminal exited." : `Terminal exited with code ${decoded.frame.exitCode}.`);
          requestRefresh();
        };
        webSocket.onclose = (event) => {
          if (currentSocket !== webSocket) return;
          ready = false;
          currentSocket = null;
          if (socket.current === webSocket) socket.current = null;
          if (stableConnectionTimer !== null) {
            window.clearTimeout(stableConnectionTimer);
            stableConnectionTimer = null;
          }
          if (attachmentConflict) return;
          const action = terminalSocketCloseAction({ terminalEnded, cancelled, terminalState: authoritativeState.current, closeCode: event.code });
          if (action === "ignore") return;
          if (action === "refresh") {
            if (!terminalEnded && cancelled && isTerminalAttachableState(authoritativeState.current)) {
              updateState("disconnected");
              onTerminalStateChangeRef.current(terminal.id, "disconnected");
            }
            requestRefresh();
            return;
          }
          updateState("disconnected");
          onTerminalStateChangeRef.current(terminal.id, "disconnected");
          reconnectAttempts += 1;
          if (reconnectAttempts > 8) {
            updateState("disconnected");
            setManualReconnectAvailable(true);
            setMessage("Automatic reconnect stopped. You can try again when the Agent is available.");
            requestRefresh();
            return;
          }
          reconnectTimer = window.setTimeout(connectSocket, Math.min(150 * (2 ** (reconnectAttempts - 1)), 2_000));
        };
        webSocket.onerror = () => undefined;
      };
      manualReconnect.current = () => {
        if (cancelled || terminalEnded) return;
        attachmentConflict = false;
        reconnectAttempts = 0;
        setManualReconnectAvailable(false);
        setMessage("");
        updateState("connecting");
        connectSocket();
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
          sendFrame(currentSocket, encodeTerminalClientFrame({ type: "detach" }));
        }
        if (currentSocket?.readyState !== WebSocket.CLOSED) currentSocket?.close();
        persistentControl.current = null;
        manualReconnect.current = null;
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
    // Callback identity must not own the socket. Only the terminal identity does.
  }, [projectId, terminal.id, workspaceId]);

  return <section className={`terminal-tab-surface ${active ? "is-active" : "is-inactive"}`} aria-hidden={!active}
    aria-label="Terminal session" role={active ? "region" : undefined}>
    {persistentReady && <div className="terminal-toolbar" role="toolbar" aria-label="Persistent terminal controls">
      <button type="button" onClick={() => { persistentControl.current?.("history"); xterm.current?.focus(); }}>History</button>
      <button type="button" onClick={() => { persistentControl.current?.("live"); xterm.current?.focus(); }}>Return to live</button>
      <button type="button" onClick={() => {
        const selection = xterm.current?.getSelection() ?? "";
        if (selection.length === 0) { setMessage("Select terminal text first, then copy it."); return; }
        try {
          navigator.clipboard.writeText(selection).then(
            () => setMessage("Selection copied."),
            () => setMessage("Clipboard access is unavailable in this browser.")
          );
        } catch { setMessage("Clipboard access is unavailable in this browser."); }
      }}>Copy selection</button>
    </div>}
    <div ref={terminalElement} className="terminal-canvas" />
    {manualReconnectAvailable && <button type="button" className="terminal-reconnect" onClick={() => manualReconnect.current?.()}>
      Reconnect
    </button>}
    {message !== "" && <p className="message" role={active ? "status" : undefined}>{message}</p>}
    {active && ["creating", "closing", "closed", "failed", "lost"].includes(state) && <p className="terminal-help">
      {terminalStateMessage(state)}
    </p>}
  </section>;
}
