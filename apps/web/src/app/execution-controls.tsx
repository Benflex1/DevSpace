"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  TERMINAL_SUBPROTOCOL, decodeTerminalAgentFrame, encodeTerminalClientFrame
} from "@devspace/contracts";
import { selectInitialTerminal } from "./terminal-selection.js";

type Task = { key: string; displayName: string };
type TaskRun = { id: string; taskKey: string; processId: string | null; state: string; processState: string | null; exitCode: number | null };
type TerminalView = { id: string; processId: string; state: string };
type TerminalUiState = "connecting" | "active" | "disconnected" | "closed" | "failed" | "lost";

export function ExecutionControls({ projectId, workspaceId, runtimeRunning, initialTasks, initialTaskRuns, initialTerminals }: {
  projectId: string; workspaceId: string; runtimeRunning: boolean; initialTasks: readonly Task[];
  initialTaskRuns: readonly TaskRun[]; initialTerminals: readonly TerminalView[];
}) {
  const [tasks, setTasks] = useState<readonly Task[]>(initialTasks);
  const [runs, setRuns] = useState<readonly TaskRun[]>(initialTaskRuns);
  const initialTerminal = selectInitialTerminal(initialTerminals);
  const [terminalId, setTerminalId] = useState<string | null>(initialTerminal?.id ?? null);
  const [terminalState, setTerminalState] = useState<TerminalUiState>(initialTerminal?.state === "active" ? "disconnected"
    : (initialTerminal?.state as TerminalUiState | undefined) ?? "closed");
  const [showTerminal, setShowTerminal] = useState(false);
  const [message, setMessage] = useState("");
  const terminalElement = useRef<HTMLDivElement>(null);
  const xterm = useRef<Terminal | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const detachSocket = useRef<() => void>(() => undefined);

  const refresh = useCallback(async (knownTerminalId = terminalId) => {
    const response = await fetch(`/api/projects/${projectId}/tasks`, { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json() as { tasks: Task[]; taskRuns: TaskRun[]; terminals: TerminalView[] };
    setTasks(data.tasks); setRuns(data.taskRuns);
    const liveTerminal = data.terminals.find((terminal) => terminal.id === knownTerminalId);
    if (liveTerminal?.state === "lost" || liveTerminal?.state === "failed" || liveTerminal?.state === "closed") {
      setTerminalState(liveTerminal.state); socket.current?.close(4000, "terminal no longer attachable");
    }
  }, [projectId, terminalId]);

  useEffect(() => {
    if (!runs.some((run) => ["queued", "starting", "running"].includes(run.state))) return;
    let stopped = false;
    let timer: number | null = null;
    const schedule = () => {
      if (stopped || document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => {
        timer = null;
        refresh().catch(() => undefined).finally(() => { schedule(); });
      }, 750);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
      } else schedule();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    schedule();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh, runs]);

  useEffect(() => {
    if (!showTerminal || terminalId === null) return;
    const element = terminalElement.current;
    if (element === null) { setTerminalState("failed"); return; }
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
      setTerminalState("connecting"); setMessage("");
      xterm.current?.dispose();
      const terminal = new Terminal({ cursorBlink: true, convertEol: true, fontSize: 14, screenReaderMode: true,
        theme: { background: "#101418", foreground: "#e7eef5" } });
      const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element); terminal.focus(); xterm.current = terminal;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const send = (frame: ReturnType<typeof encodeTerminalClientFrame>) => {
        if (ready && currentSocket?.readyState === WebSocket.OPEN) currentSocket.send(frame);
      };
      let lastColumns = 0;
      let lastRows = 0;
      const scheduleResize = () => {
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
          if (terminal.cols === lastColumns && terminal.rows === lastRows) return;
          lastColumns = terminal.cols; lastRows = terminal.rows;
          send(encodeTerminalClientFrame({ type: "resize", columns: terminal.cols, rows: terminal.rows }));
        });
      };
      const dataDisposable = terminal.onData((data) => send(encodeTerminalClientFrame({ type: "input", data: new TextEncoder().encode(data) })));
      const binaryDisposable = terminal.onBinary((data) => send(encodeTerminalClientFrame({ type: "input",
        data: Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff) })));
      const resize = new ResizeObserver(scheduleResize);
      resize.observe(element);
      window.addEventListener("resize", scheduleResize);
      const connectSocket = () => {
        if (cancelled || terminalEnded) return;
        const webSocket = new WebSocket(`${protocol}//${window.location.host}/api/projects/${projectId}/workspaces/${workspaceId}/terminals/${terminalId}/stream`, TERMINAL_SUBPROTOCOL);
        webSocket.binaryType = "arraybuffer"; currentSocket = webSocket; socket.current = webSocket; ready = false;
        webSocket.onmessage = (event) => {
          if (currentSocket !== webSocket) return;
          if (!(event.data instanceof ArrayBuffer)) { webSocket.close(1002); return; }
          const decoded = decodeTerminalAgentFrame(new Uint8Array(event.data));
          if (!decoded.ok) { webSocket.close(1002); return; }
          if (decoded.frame.type === "ready") {
            ready = true; setTerminalState("active"); scheduleResize();
            if (stableConnectionTimer !== null) window.clearTimeout(stableConnectionTimer);
            stableConnectionTimer = window.setTimeout(() => { reconnectAttempts = 0; }, 1_000);
            return;
          }
          if (decoded.frame.type === "output") { terminal.write(decoded.frame.data); return; }
          terminalEnded = true; setTerminalState("closed");
          setMessage(decoded.frame.exitCode === null ? "Terminal exited." : `Terminal exited with code ${decoded.frame.exitCode}.`);
        };
        webSocket.onclose = (event) => {
          if (currentSocket !== webSocket) return;
          ready = false; currentSocket = null; if (socket.current === webSocket) socket.current = null;
          if (cancelled || terminalEnded) return;
          if (event.code === 4000) { refresh().catch(() => undefined); return; }
          setTerminalState((state) => state === "closed" || state === "failed" || state === "lost" ? state : "disconnected");
          reconnectAttempts += 1;
          if (reconnectAttempts > 8) { setTerminalState("failed"); refresh().catch(() => undefined); return; }
          reconnectTimer = window.setTimeout(connectSocket, Math.min(150 * (2 ** (reconnectAttempts - 1)), 2_000));
        };
        webSocket.onerror = () => undefined;
      };
      connectSocket();
      detachSocket.current = () => send(encodeTerminalClientFrame({ type: "detach" }));
      disposeResources = () => {
        dataDisposable.dispose(); binaryDisposable.dispose(); resize.disconnect(); window.removeEventListener("resize", scheduleResize);
        if (currentSocket?.readyState !== WebSocket.CLOSED) currentSocket?.close();
        terminal.dispose();
        if (xterm.current === terminal) xterm.current = null;
        detachSocket.current = () => undefined;
      };
    }, 0);
    return () => {
      cancelled = true; window.clearTimeout(start);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (stableConnectionTimer !== null) window.clearTimeout(stableConnectionTimer);
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      if (resizeRetryTimer !== null) window.clearTimeout(resizeRetryTimer);
      disposeResources();
    };
  }, [projectId, refresh, showTerminal, terminalId, workspaceId]);

  const connect = (id: string) => {
    setTerminalId(id); setShowTerminal(true); setTerminalState("connecting"); setMessage("");
  };

  const open = async () => {
    setMessage("Creating terminal…");
    const response = await fetch(`/api/projects/${projectId}/terminals`, { method: "POST",
      headers: { "content-type": "application/json", "x-devspace-csrf": "1" }, body: JSON.stringify({ action: "create" }) });
    const body = await response.json() as { terminalId?: string; message?: string };
    if (!response.ok || body.terminalId === undefined) { setMessage(body.message ?? "Terminal creation failed."); return; }
    setTerminalId(body.terminalId); connect(body.terminalId);
    await refresh(body.terminalId);
  };

  const detach = () => {
    detachSocket.current(); setTerminalState("disconnected"); setShowTerminal(false);
  };
  const runTask = async (taskKey: string) => {
    setMessage("Starting task…");
    const response = await fetch(`/api/projects/${projectId}/tasks`, { method: "POST",
      headers: { "content-type": "application/json", "x-devspace-csrf": "1" },
      body: JSON.stringify({ action: "run", taskKey }) });
    const result = await response.json() as { message?: string };
    setMessage(response.ok ? "Task started." : result.message ?? "Task action failed.");
    await refresh();
  };

  return <div className="execution-controls">
    <section className="terminal-section" aria-labelledby={`terminal-${projectId}`}>
      <div className="subsection-heading"><h4 id={`terminal-${projectId}`}>Terminal</h4><span className={`terminal-state ${terminalState}`}>{terminalState}</span></div>
      {terminalId === null ? <button type="button" disabled={!runtimeRunning} onClick={() => { open().catch(() => setTerminalState("failed")); }}>Open terminal</button>
        : <div className="inline-actions">
          {terminalState !== "active" && !["closed", "failed", "lost"].includes(terminalState)
            && <button type="button" onClick={() => connect(terminalId)}>Reconnect</button>}
          {terminalState === "active" && <button type="button" onClick={() => setShowTerminal(true)}>Show terminal</button>}
          {["closed", "failed", "lost"].includes(terminalState)
            && <button type="button" disabled={!runtimeRunning} onClick={() => { open().catch(() => setTerminalState("failed")); }}>
            Open new terminal
          </button>}
        </div>}
      {showTerminal && terminalId !== null && <div className="terminal-panel" role="region" aria-label="Workspace terminal">
        <div ref={terminalElement} className="terminal-canvas" />
        <div className="inline-actions"><button type="button" onClick={detach}>Detach</button></div>
      </div>}
    </section>
    <section className="tasks-section" aria-labelledby={`tasks-${projectId}`}>
      <h4 id={`tasks-${projectId}`}>Configured tasks</h4>
      {tasks.length === 0 ? <p className="empty">No tasks configured</p> : <ul className="task-list">{tasks.map((task) =>
        <li key={task.key}><div><strong>{task.displayName}</strong><code>{task.key}</code></div>
          <button type="button" disabled={!runtimeRunning} onClick={() => { runTask(task.key).catch(() => undefined); }}>Run</button></li>)}</ul>}
      {runs.length > 0 && <div className="task-runs"><h5>Recent task runs</h5><ul>{runs.map((run) =>
        <li key={run.id}><code>{run.taskKey}</code><span>{run.state}</span><span>Process: {run.processState ?? "pending"}</span>
          {run.exitCode !== null && <span>Exit code: {run.exitCode}</span>}
          </li>)}</ul></div>}
    </section>
    {message !== "" && <p className="message" role="status">{message}</p>}
  </div>;
}
