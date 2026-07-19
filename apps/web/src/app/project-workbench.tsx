"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RuntimeControls } from "./runtime-controls.js";
import { isTerminalAttachableState } from "./terminal-lifecycle.js";
import { TerminalTab, type TerminalView } from "./terminal-tab.js";
import {
  activateWorkbenchTab, closeWorkbenchTab, emptyWorkbenchTabs, openWorkbenchTab, terminalTabId, type WorkbenchTab, type WorkbenchTabState
} from "./workbench-tabs.js";

type Task = { key: string; displayName: string };
type TaskRun = { id: string; taskKey: string; processId: string | null; state: string; processState: string | null; exitCode: number | null };
type FutureNavItem = "Files" | "Git" | "Previews" | "AI";

export function ProjectWorkbench({ projectId, workspaceId, projectName, branchName, runtimeState, runtimeRunning, runtimeAvailable,
  agentStatus, agentReachable, activeAction, canStart, canStop, retryStart, initialTasks, initialTaskRuns, initialTerminals,
  repositoryUrl, actor }: {
  projectId: string;
  workspaceId: string;
  projectName: string;
  branchName: string;
  runtimeState: string;
  runtimeRunning: boolean;
  runtimeAvailable: boolean;
  agentStatus: string;
  agentReachable: boolean;
  activeAction: "start" | "stop" | null;
  canStart: boolean;
  canStop: boolean;
  retryStart: boolean;
  initialTasks: readonly Task[];
  initialTaskRuns: readonly TaskRun[];
  initialTerminals: readonly TerminalView[];
  repositoryUrl: string;
  actor: string;
}) {
  const [tabs, setTabs] = useState<WorkbenchTabState>(emptyWorkbenchTabs);
  const [terminals, setTerminals] = useState<readonly TerminalView[]>(initialTerminals);
  const terminalLabels = useRef(new Map(initialTerminals.map((terminal, index) => [terminal.id, `Terminal ${index + 1}`])));
  const [tasks, setTasks] = useState<readonly Task[]>(initialTasks);
  const [runs, setRuns] = useState<readonly TaskRun[]>(initialTaskRuns);
  const [message, setMessage] = useState("");
  const getTerminalTitle = useCallback((terminal: TerminalView): string => {
    const existing = terminalLabels.current.get(terminal.id);
    if (existing !== undefined) return existing;
    const nextNumber = terminalLabels.current.size + 1;
    const title = `Terminal ${nextNumber}`;
    terminalLabels.current.set(terminal.id, title);
    return title;
  }, []);

  const refresh = useCallback(async (): Promise<{ terminals: TerminalView[] }> => {
    const response = await fetch(`/api/projects/${projectId}/tasks`, { cache: "no-store" });
    if (!response.ok) return { terminals: [] };
    const data = await response.json() as { tasks: Task[]; taskRuns: TaskRun[]; terminals: TerminalView[] };
    setTasks(data.tasks);
    setRuns(data.taskRuns);
    setTerminals(data.terminals);
    for (const terminal of data.terminals) getTerminalTitle(terminal);
    return data;
  }, [getTerminalTitle, projectId]);

  useEffect(() => {
    if (!runs.some((run) => ["queued", "starting", "running"].includes(run.state))) return;
    let stopped = false;
    let timer: number | null = null;
    const schedule = () => {
      if (stopped || document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => {
        timer = null;
        refresh().catch(() => undefined).finally(() => schedule());
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

  const terminalById = useMemo(() => new Map(terminals.map((terminal) => [terminal.id, terminal])), [terminals]);
  const actionsAvailable = runtimeRunning && runtimeAvailable && agentReachable && agentStatus === "connected";
  const openTerminalTab = useCallback((terminal: TerminalView) => {
    if (!actionsAvailable || !isTerminalAttachableState(terminal.state)) return;
    setTabs((current) => openWorkbenchTab(current, {
      id: terminalTabId(terminal.id), kind: "terminal", terminalId: terminal.id, title: getTerminalTitle(terminal)
    }));
  }, [actionsAvailable, getTerminalTitle]);
  const createTerminal = async () => {
    if (!actionsAvailable) return;
    setMessage("Creating terminal…");
    const response = await fetch(`/api/projects/${projectId}/terminals`, { method: "POST",
      headers: { "content-type": "application/json", "x-devspace-csrf": "1" }, body: JSON.stringify({ action: "create" }) });
    const body = await response.json() as { terminalId?: string; message?: string };
    if (!response.ok || body.terminalId === undefined) {
      setMessage(body.message ?? "Terminal creation failed.");
      return;
    }
    const data = await refresh();
    const terminal = data.terminals.find((candidate) => candidate.id === body.terminalId);
    if (terminal === undefined || !isTerminalAttachableState(terminal.state)) {
      setMessage("Terminal creation succeeded, but its current state is not attachable.");
      return;
    }
    openTerminalTab(terminal);
    setMessage("");
  };
  const closeTab = (tab: WorkbenchTab) => {
    setTabs((current) => closeWorkbenchTab(current, tab.id));
  };
  const runTask = async (taskKey: string) => {
    if (!actionsAvailable) return;
    setMessage("Starting task…");
    const response = await fetch(`/api/projects/${projectId}/tasks`, { method: "POST",
      headers: { "content-type": "application/json", "x-devspace-csrf": "1" }, body: JSON.stringify({ action: "run", taskKey }) });
    const result = await response.json() as { message?: string };
    setMessage(response.ok ? "Task started." : result.message ?? "Task action failed.");
    await refresh();
  };

  return <main className="workbench" aria-label={`${projectName} project workbench`}>
    <WorkbenchTopBar projectName={projectName} branchName={branchName} repositoryUrl={repositoryUrl} projectId={projectId}
      runtimeState={runtimeState} runtimeAvailable={runtimeAvailable} activeAction={activeAction} canStart={canStart} canStop={canStop}
      retryStart={retryStart} />
    <div className="workbench-body">
      <WorkbenchSidebar terminals={terminals} getTerminalTitle={getTerminalTitle} tabs={tabs} actionsAvailable={actionsAvailable} tasks={tasks} runs={runs}
        onOpenTerminal={openTerminalTab} onCreateTerminal={() => { createTerminal().catch(() => setMessage("Terminal creation failed.")); }}
        onRunTask={(taskKey) => { runTask(taskKey).catch(() => setMessage("Task action failed.")); }} />
      <section className="workbench-main" aria-label="Workbench surface">
        <WorkbenchTabStrip tabs={tabs} onActivate={(tabId) => setTabs((current) => activateWorkbenchTab(current, tabId))}
          onClose={closeTab} onCreateTerminal={() => { createTerminal().catch(() => setMessage("Terminal creation failed.")); }}
          canCreateTerminal={actionsAvailable} />
        <WorkbenchSurface tabs={tabs} terminalById={terminalById} projectId={projectId} workspaceId={workspaceId}
          onRefresh={() => { refresh().catch(() => undefined); }} />
        {message !== "" && <p className="workbench-message message" role="status">{message}</p>}
      </section>
    </div>
    <WorkbenchStatusBar runtimeState={runtimeState} agentStatus={agentStatus} agentReachable={agentReachable}
      activeTab={tabs.tabs.find((tab) => tab.id === tabs.activeTabId)} terminals={terminals} actor={actor} />
  </main>;
}

function WorkbenchTopBar({ projectName, branchName, repositoryUrl, projectId, runtimeState, runtimeAvailable, activeAction, canStart,
  canStop, retryStart }: {
  projectName: string; branchName: string; repositoryUrl: string; projectId: string; runtimeState: string; runtimeAvailable: boolean;
  activeAction: "start" | "stop" | null; canStart: boolean; canStop: boolean; retryStart: boolean;
}) {
  return <header className="workbench-topbar">
    <div className="workbench-breadcrumb"><Link href="/" aria-label="Back to Projects">Projects</Link><span aria-hidden="true">/</span><strong>{projectName}</strong></div>
    <div className="workbench-context"><span className="context-item"><span className="context-label">branch</span><code>{branchName}</code></span>
      <span className={`runtime-chip ${runtimeState}`}>{runtimeLabel(runtimeState)}</span>
      <a className="topbar-action" href={repositoryUrl} target="_blank" rel="noreferrer">Repository</a>
      <RuntimeControls projectId={projectId} runtimeAvailable={runtimeAvailable} activeAction={activeAction} canStart={canStart}
        canStop={canStop} retryStart={retryStart} />
    </div>
  </header>;
}

function WorkbenchSidebar({ terminals, getTerminalTitle, tabs, actionsAvailable, tasks, runs, onOpenTerminal, onCreateTerminal, onRunTask }: {
  terminals: readonly TerminalView[]; getTerminalTitle: (terminal: TerminalView) => string; tabs: WorkbenchTabState; actionsAvailable: boolean; tasks: readonly Task[]; runs: readonly TaskRun[];
  onOpenTerminal: (terminal: TerminalView) => void; onCreateTerminal: () => void; onRunTask: (taskKey: string) => void;
}) {
  return <aside className="workbench-sidebar" aria-label="Project navigation">
    <div className="sidebar-heading"><span>Project</span><span className="sidebar-kicker">M1</span></div>
    <nav className="workbench-nav" aria-label="Workbench tools">
      <button type="button" className="workbench-nav-item active"><span aria-hidden="true">▸</span> Terminals <span className="nav-count">{terminals.length}</span></button>
      <button type="button" className="workbench-nav-item"><span aria-hidden="true">≡</span> Tasks <span className="nav-count">{tasks.length}</span></button>
      {(["Files", "Git", "Previews", "AI"] as FutureNavItem[]).map((item) =>
        <button type="button" className="workbench-nav-item future" disabled key={item} title={`${item} is planned for a later milestone`}>
          <span aria-hidden="true">·</span> {item}<span className="nav-future">Soon</span>
        </button>)}
    </nav>
    <div className="sidebar-section">
      <div className="sidebar-section-heading"><h2>Terminals</h2><button type="button" className="icon-button" disabled={!actionsAvailable}
        onClick={onCreateTerminal} aria-label="Create terminal" title={actionsAvailable ? "Create terminal" : "The Agent and runtime must be available to create a terminal"}>+</button></div>
      {terminals.length === 0 ? <p className="sidebar-empty">No terminal sessions yet.</p> : <ul className="terminal-list">
        {terminals.map((terminal) => {
          const tab = tabs.tabs.find((candidate) => candidate.kind === "terminal" && candidate.terminalId === terminal.id);
          const attachable = actionsAvailable && isTerminalAttachableState(terminal.state);
          return <li key={terminal.id} className={tab?.id === tabs.activeTabId ? "selected" : ""}>
            <button type="button" disabled={!attachable} onClick={() => onOpenTerminal(terminal)} title={attachable ? "Open terminal tab" : "This terminal is no longer attachable"}>
              <span className={`sidebar-state ${terminal.state}`} aria-hidden="true" />
              <span><strong>{getTerminalTitle(terminal)}</strong><small>{terminal.state}</small></span>
              {tab?.id === tabs.activeTabId && <span className="sidebar-active">●</span>}
            </button>
          </li>;
        })}
      </ul>}
    </div>
    <div className="sidebar-section tasks-sidebar-section">
      <div className="sidebar-section-heading"><h2>Tasks</h2></div>
      {tasks.length === 0 ? <p className="sidebar-empty">No configured tasks.</p> : <ul className="sidebar-task-list">
        {tasks.map((task) => <li key={task.key}><span><strong>{task.displayName}</strong><code>{task.key}</code></span>
          <button type="button" disabled={!actionsAvailable} onClick={() => onRunTask(task.key)}>Run</button></li>)}
      </ul>}
      {runs.length > 0 && <div className="sidebar-task-runs"><h3>Recent runs</h3>{runs.slice(0, 5).map((run) =>
        <div key={run.id}><code>{run.taskKey}</code><span className={`run-state ${run.state}`}>{run.state}</span>{run.exitCode !== null && <span>Exit code: {run.exitCode}</span>}</div>)}</div>}
    </div>
  </aside>;
}

function WorkbenchTabStrip({ tabs, onActivate, onClose, onCreateTerminal, canCreateTerminal }: {
  tabs: WorkbenchTabState; onActivate: (tabId: string) => void; onClose: (tab: WorkbenchTab) => void; onCreateTerminal: () => void;
  canCreateTerminal: boolean;
}) {
  return <div className="workbench-tabstrip" role="tablist" aria-label="Project tabs">
    {tabs.tabs.map((tab) => <div className={`workbench-tab ${tab.id === tabs.activeTabId ? "active" : ""}`} key={tab.id}>
      <button type="button" role="tab" aria-selected={tab.id === tabs.activeTabId} onClick={() => onActivate(tab.id)}>{tab.kind === "terminal" && <span className="tab-dot" aria-hidden="true" />}{tabTitle(tab)}</button>
      <button type="button" className="tab-close" aria-label={`Close ${tabTitle(tab)}`} onClick={() => onClose(tab)}>×</button>
    </div>)}
    <button type="button" className="tab-create" disabled={!canCreateTerminal} onClick={onCreateTerminal} aria-label="Create terminal tab" title={canCreateTerminal ? "Create terminal" : "Start the runtime to create a terminal"}>+</button>
    {tabs.tabs.length === 0 && <span className="tabstrip-hint">Open a terminal from the project sidebar</span>}
  </div>;
}

function WorkbenchSurface({ tabs, terminalById, projectId, workspaceId, onRefresh }: {
  tabs: WorkbenchTabState; terminalById: ReadonlyMap<string, TerminalView>; projectId: string; workspaceId: string;
  onRefresh: () => void;
}) {
  return <div className="workbench-surface">
    {tabs.tabs.length === 0 && <div className="workbench-empty"><div className="empty-glyph" aria-hidden="true">⌘</div><h1>Project Workbench</h1><p>Open a terminal to start working in this project.</p></div>}
    {tabs.tabs.map((tab) => tab.kind === "terminal" ? <TerminalTab key={tab.id} projectId={projectId} workspaceId={workspaceId}
      terminal={terminalById.get(tab.terminalId) ?? { id: tab.terminalId, processId: tab.terminalId, state: "disconnected" }}
      active={tab.id === tabs.activeTabId} onRefresh={onRefresh} /> : null)}
  </div>;
}

function WorkbenchStatusBar({ runtimeState, agentStatus, agentReachable, activeTab, terminals, actor }: {
  runtimeState: string; agentStatus: string; agentReachable: boolean; activeTab: WorkbenchTab | undefined; terminals: readonly TerminalView[]; actor: string;
}) {
  const activeTerminal = activeTab?.kind === "terminal" ? terminals.find((terminal) => terminal.id === activeTab.terminalId) : undefined;
  return <footer className="workbench-statusbar"><span><i className={`status-dot ${runtimeState}`} aria-hidden="true" /> Runtime {runtimeLabel(runtimeState)}</span>
    <span role="status"><i className={`status-dot ${agentReachable ? "online" : "offline"}`} aria-hidden="true" /> Agent {agentStatus}</span>
    {activeTerminal !== undefined && <span>Active {activeTab?.kind === "terminal" ? activeTab.title : "tab"} · {activeTerminal.state}</span>}
    <span className="status-spacer" /><span className="status-actor">{actor}</span></footer>;
}

function runtimeLabel(state: string): string {
  return { starting: "Starting", running: "Running", stopping: "Stopping", stopped: "Stopped", absent: "Offline" }[state] ?? state;
}

function tabTitle(tab: WorkbenchTab): string {
  return tab.kind === "terminal" ? tab.title : tab.kind === "editor" ? "Editor" : tab.kind === "preview" ? "Preview"
    : tab.kind === "ai" ? "AI session" : tab.kind === "git" ? "Git" : "Task output";
}
