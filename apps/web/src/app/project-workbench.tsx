"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RuntimeControls } from "./runtime-controls.js";
import { isTerminalAttachableState, isTerminalVisibleState, sortTerminalViewsByTitle, updateTerminalCollectionState } from "./terminal-lifecycle.js";
import { TerminalTab, type TerminalView } from "./terminal-tab.js";
import { isPreviewChanging, previewPresentationLabel, previewPresentationState, previewPresentationSymbol, type PreviewLifecycleView } from "./preview-lifecycle.js";
import { PreviewTab } from "./preview-tab.js";
import {
  activateWorkbenchTab, closeWorkbenchTab, emptyWorkbenchTabs, openWorkbenchTab, previewTabId, terminalTabId, type WorkbenchTab, type WorkbenchTabState
} from "./workbench-tabs.js";

type Task = { key: string; displayName: string };
type TaskRun = { id: string; taskKey: string; processId: string | null; state: string; processState: string | null; exitCode: number | null };
export function ProjectWorkbench({ projectId, workspaceId, projectName, branchName, runtimeState, runtimeRunning, runtimeAvailable,
  agentStatus, agentReachable, activeAction, canStart, canStop, retryStart, initialTasks, initialTaskRuns, initialTerminals, initialPreviews,
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
  initialPreviews: readonly PreviewLifecycleView[];
  repositoryUrl: string;
  actor: string;
}) {
  const [tabs, setTabs] = useState<WorkbenchTabState>(emptyWorkbenchTabs);
  const [terminals, setTerminals] = useState<readonly TerminalView[]>(initialTerminals);
  const terminalLabels = useRef(new Map(initialTerminals.map((terminal) => [terminal.id, terminal.title])));
  const currentTerminals = useRef(initialTerminals);
  const [tasks, setTasks] = useState<readonly Task[]>(initialTasks);
  const [runs, setRuns] = useState<readonly TaskRun[]>(initialTaskRuns);
  const [previews, setPreviews] = useState<readonly PreviewLifecycleView[]>(initialPreviews);
  const currentPreviews = useRef(initialPreviews);
  const [message, setMessage] = useState("");
  currentTerminals.current = terminals;
  currentPreviews.current = previews;
  const getTerminalTitle = useCallback((terminal: TerminalView): string => {
    const existing = terminalLabels.current.get(terminal.id);
    if (existing !== undefined) return existing;
    const used = new Set<number>();
    for (const current of currentTerminals.current) {
      if (!isTerminalVisibleState(current.state)) continue;
      const title = terminalLabels.current.get(current.id) ?? current.title;
      const match = /^Terminal ([1-9][0-9]*)$/u.exec(title);
      if (match !== null) used.add(Number(match[1]));
    }
    let nextNumber = 1;
    while (used.has(nextNumber)) nextNumber += 1;
    const title = `Terminal ${nextNumber}`;
    terminalLabels.current.set(terminal.id, title);
    return title;
  }, []);

  const refresh = useCallback(async (): Promise<{ terminals: TerminalView[]; previews: PreviewLifecycleView[] }> => {
    const [executionResponse, previewResponse] = await Promise.all([
      fetch(`/api/projects/${projectId}/tasks`, { cache: "no-store" }),
      fetch(`/api/projects/${projectId}/previews`, { cache: "no-store" })
    ]);
    let terminals = [...currentTerminals.current];
    if (executionResponse.ok) {
      const data = await executionResponse.json() as { tasks: Task[]; taskRuns: TaskRun[]; terminals: TerminalView[] };
      setTasks(data.tasks);
      setRuns(data.taskRuns);
      setTerminals(data.terminals);
      terminals = data.terminals;
      for (const terminal of data.terminals) getTerminalTitle(terminal);
    }
    let nextPreviews = [...currentPreviews.current];
    if (previewResponse.ok) {
      const data = await previewResponse.json() as { previews: PreviewLifecycleView[] };
      nextPreviews = data.previews;
      setPreviews(data.previews);
    }
    return { terminals, previews: nextPreviews };
  }, [getTerminalTitle, projectId]);
  const updateTerminalState = useCallback((terminalId: string, state: string) => {
    setTerminals((current) => updateTerminalCollectionState(current, terminalId, state));
  }, []);
  const handleRefresh = useCallback(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

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

  useEffect(() => {
    if (!previews.some(isPreviewChanging)) return;
    let stopped = false;
    let timer: number | null = null;
    const schedule = () => {
      if (stopped || document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => {
        timer = null;
        refresh().catch(() => undefined).finally(() => schedule());
      }, 1_500);
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
  }, [previews, refresh]);

  const visibleTerminals = useMemo(() => sortTerminalViewsByTitle(terminals.filter((terminal) => isTerminalVisibleState(terminal.state))), [terminals]);
  const terminalById = useMemo(() => new Map(terminals.map((terminal) => [terminal.id, terminal])), [terminals]);
  const previewById = useMemo(() => new Map(previews.map((preview) => [preview.id, preview])), [previews]);
  useEffect(() => {
    const visibleIds = new Set(visibleTerminals.map((terminal) => terminal.id));
    setTabs((current) => {
      let next = current;
      for (const tab of current.tabs) {
        if (tab.kind === "terminal" && !visibleIds.has(tab.terminalId)) next = closeWorkbenchTab(next, tab.id);
      }
      return next;
    });
  }, [visibleTerminals]);
  useEffect(() => {
    const visibleIds = new Set(previews.map((preview) => preview.id));
    setTabs((current) => {
      let next = current;
      for (const tab of current.tabs) {
        if (tab.kind === "preview" && !visibleIds.has(tab.previewId)) next = closeWorkbenchTab(next, tab.id);
      }
      return next;
    });
  }, [previews]);
  const actionsAvailable = runtimeRunning && runtimeAvailable && agentReachable && agentStatus === "connected";
  const openTerminalTab = useCallback((terminal: TerminalView) => {
    if (!actionsAvailable || !isTerminalAttachableState(terminal.state)) return;
    setTabs((current) => openWorkbenchTab(current, {
      id: terminalTabId(terminal.id), kind: "terminal", terminalId: terminal.id, title: getTerminalTitle(terminal)
    }));
  }, [actionsAvailable, getTerminalTitle]);
  const openPreviewTab = useCallback((preview: PreviewLifecycleView) => {
    setTabs((current) => openWorkbenchTab(current, { id: previewTabId(preview.id), kind: "preview", previewId: preview.id }));
  }, []);
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
  const reloadPreview = async (previewId: string) => {
    setMessage("Reconciling preview…");
    const response = await fetch(`/api/projects/${projectId}/previews`, { method: "POST",
      headers: { "content-type": "application/json", "x-devspace-csrf": "1" }, body: JSON.stringify({ action: "reload", previewId }) });
    const result = await response.json() as { message?: string; previews?: PreviewLifecycleView[] };
    if (Array.isArray(result.previews)) setPreviews(result.previews);
    setMessage(response.ok ? "Preview reconciliation requested." : result.message ?? "Preview reconciliation failed.");
  };

  return <main className="workbench" aria-label={`${projectName} project workbench`}>
    <WorkbenchTopBar projectName={projectName} branchName={branchName} repositoryUrl={repositoryUrl} projectId={projectId}
      runtimeState={runtimeState} runtimeAvailable={runtimeAvailable} activeAction={activeAction} canStart={canStart} canStop={canStop}
      retryStart={retryStart} />
    <div className="workbench-body">
      <WorkbenchSidebar terminals={visibleTerminals} getTerminalTitle={getTerminalTitle} tabs={tabs} actionsAvailable={actionsAvailable} tasks={tasks} runs={runs}
        previews={previews} onOpenPreview={openPreviewTab}
        onOpenTerminal={openTerminalTab} onCreateTerminal={() => { createTerminal().catch(() => setMessage("Terminal creation failed.")); }}
        onRunTask={(taskKey) => { runTask(taskKey).catch(() => setMessage("Task action failed.")); }} />
      <section className="workbench-main" aria-label="Workbench surface">
        <WorkbenchTabStrip tabs={tabs} onActivate={(tabId) => setTabs((current) => activateWorkbenchTab(current, tabId))}
          onClose={closeTab} onCreateTerminal={() => { createTerminal().catch(() => setMessage("Terminal creation failed.")); }}
          canCreateTerminal={actionsAvailable} />
        <WorkbenchSurface tabs={tabs} terminalById={terminalById} previewById={previewById} projectId={projectId} workspaceId={workspaceId}
          onRefresh={handleRefresh} onTerminalStateChange={updateTerminalState} onReloadPreview={reloadPreview} />
        {message !== "" && <p className="workbench-message message" role="status">{message}</p>}
      </section>
    </div>
    <WorkbenchStatusBar runtimeState={runtimeState} agentStatus={agentStatus} agentReachable={agentReachable} actor={actor} />
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

function WorkbenchSidebar({ terminals, getTerminalTitle, tabs, actionsAvailable, tasks, runs, previews, onOpenPreview,
  onOpenTerminal, onCreateTerminal, onRunTask }: {
  terminals: readonly TerminalView[]; getTerminalTitle: (terminal: TerminalView) => string; tabs: WorkbenchTabState; actionsAvailable: boolean; tasks: readonly Task[]; runs: readonly TaskRun[];
  previews: readonly PreviewLifecycleView[]; onOpenPreview: (preview: PreviewLifecycleView) => void;
  onOpenTerminal: (terminal: TerminalView) => void; onCreateTerminal: () => void; onRunTask: (taskKey: string) => void;
}) {
  return <aside className="workbench-sidebar" aria-label="Project navigation">
    <div className="sidebar-heading"><span>Project</span><span className="sidebar-kicker">M1</span></div>
    <nav className="workbench-nav" aria-label="Workbench tools">
      <button type="button" className="workbench-nav-item active"><span aria-hidden="true">▸</span> Terminals <span className="nav-count">{terminals.length}</span></button>
      <button type="button" className="workbench-nav-item"><span aria-hidden="true">≡</span> Tasks <span className="nav-count">{tasks.length}</span></button>
      {["Files", "Git", "AI"].map((item) =>
        <button type="button" className="workbench-nav-item future" disabled key={item} title={`${item} is planned for a later milestone`}>
          <span aria-hidden="true">·</span> {item}<span className="nav-future">Soon</span>
        </button>)}
      <button type="button" className="workbench-nav-item" onClick={() => { const first = previews[0]; if (first !== undefined) onOpenPreview(first); }}>
        <span aria-hidden="true">▾</span> Previews <span className="nav-count">{previews.length}</span>
      </button>
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
    <div className="sidebar-section previews-sidebar-section">
      <div className="sidebar-section-heading"><h2>Previews</h2></div>
      {previews.length === 0 ? <p className="sidebar-empty">No configured previews.</p> : <ul className="preview-list">
        {previews.map((preview) => {
          const tab = tabs.tabs.find((candidate) => candidate.kind === "preview" && candidate.previewId === preview.id);
          const state = previewPresentationState(preview);
          return <li key={preview.id} className={tab?.id === tabs.activeTabId ? "selected" : ""}>
            <button type="button" onClick={() => onOpenPreview(preview)} title={`Open ${preview.displayName} preview`}>
              <span className={`preview-sidebar-state ${state}`} aria-hidden="true">{previewPresentationSymbol(preview)}</span>
              <span><strong>{preview.displayName}</strong><small>{previewPresentationLabel(preview)}</small></span>
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

function WorkbenchSurface({ tabs, terminalById, previewById, projectId, workspaceId, onRefresh, onTerminalStateChange, onReloadPreview }: {
  tabs: WorkbenchTabState; terminalById: ReadonlyMap<string, TerminalView>; previewById: ReadonlyMap<string, PreviewLifecycleView>;
  projectId: string; workspaceId: string; onRefresh: () => void; onTerminalStateChange: (terminalId: string, state: string) => void;
  onReloadPreview: (previewId: string) => Promise<void>;
}) {
  return <div className="workbench-surface">
    {tabs.tabs.length === 0 && <div className="workbench-empty"><div className="empty-glyph" aria-hidden="true">⌘</div><h1>Project Workbench</h1><p>Open a terminal to start working in this project.</p></div>}
    {tabs.tabs.map((tab) => tab.kind === "terminal" ? <TerminalTab key={tab.id} projectId={projectId} workspaceId={workspaceId}
      terminal={terminalById.get(tab.terminalId) ?? { id: tab.terminalId, processId: tab.terminalId, title: tab.title, state: "disconnected" }}
      active={tab.id === tabs.activeTabId} onRefresh={onRefresh} onTerminalStateChange={onTerminalStateChange} />
      : tab.kind === "preview" ? (() => {
        const preview = previewById.get(tab.previewId);
        return preview === undefined ? null : <PreviewTab key={tab.id} preview={preview}
          active={tab.id === tabs.activeTabId} onReload={onReloadPreview} />;
      })() : null)}
  </div>;
}

function WorkbenchStatusBar({ runtimeState, agentStatus, agentReachable, actor }: {
  runtimeState: string; agentStatus: string; agentReachable: boolean; actor: string;
}) {
  return <footer className="workbench-statusbar"><span><i className={`status-dot ${runtimeState}`} aria-hidden="true" /> Runtime {runtimeLabel(runtimeState)}</span>
    <span role="status"><i className={`status-dot ${agentReachable ? "online" : "offline"}`} aria-hidden="true" /> Agent {agentStatus}</span>
    <span className="status-spacer" /><span className="status-actor">{actor}</span></footer>;
}

function runtimeLabel(state: string): string {
  return { starting: "Starting", running: "Running", stopping: "Stopping", stopped: "Stopped", absent: "Offline" }[state] ?? state;
}

function tabTitle(tab: WorkbenchTab): string {
  return tab.kind === "terminal" ? tab.title : tab.kind === "editor" ? "Editor" : tab.kind === "preview" ? "Preview"
    : tab.kind === "ai" ? "AI session" : tab.kind === "git" ? "Git" : "Task output";
}
