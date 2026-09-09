"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RuntimeControls } from "./runtime-controls.js";
import { isTerminalAttachableState, isTerminalSidebarVisible, LOST_TERMINAL_SIDEBAR_EXPIRY_MS, removeTerminalCollectionEntries, sortTerminalViewsByTitle, updateTerminalCollectionState } from "./terminal-lifecycle.js";
import { LOST_TERMINAL_DISMISSED_SESSION_KEY, LostTerminalDialogSession, lostTerminalDialogCopy, lostTerminalDialogStepAfter, lostTerminalSetKey, type LostTerminalDialogStep } from "./lost-terminal-dialog.js";
import { TerminalTab, type TerminalView } from "./terminal-tab.js";
import { createPreviewLivenessPoller, type PreviewLivenessPoller } from "./preview-liveness.js";
import { previewPresentationLabel, previewPresentationState, previewPresentationSymbol, type PreviewLifecycleView } from "./preview-lifecycle.js";
import { PreviewTab } from "./preview-tab.js";
import { AiSessionTab } from "./ai-session-tab.js";
import { EditorTab } from "./editor-tab.js";
import { WorkspaceFileTree } from "./workspace-file-tree.js";
import { IncidentReference } from "./incident-reference.js";
import { useTransientNotice } from "./transient-notice.js";
import {
  activateWorkbenchTab, aiTabId, closeWorkbenchTab, closeWorkbenchTabsForTerminalIds, editorTab, emptyWorkbenchTabs, openWorkbenchTab, previewTabId, terminalTabId, type WorkbenchTab, type WorkbenchTabState
} from "./workbench-tabs.js";

type Task = { key: string; displayName: string };
type TaskRun = { id: string; taskKey: string; processId: string | null; state: string; processState: string | null; exitCode: number | null };
type PushStatus = {
  operationId: string; state: "prepared" | "submitted" | "succeeded" | "failed";
  repository: string; branchName: string; commitOid: string; dirty: boolean;
  aheadCount: number; behindCount: number; errorCode: string | null; message: string | null;
};
export function ProjectWorkbench({ projectId, workspaceId, projectName, branchName, runtimeState, runtimeRunning, runtimeAvailable,
  agentStatus, agentReachable, activeAction, canStart, canStop, retryStart, pushAvailable, initialTasks, initialTaskRuns, initialTerminals, initialPreviews,
  previewGateway, repositoryUrl, actor, initialMessage }: {
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
  pushAvailable: boolean;
  initialTasks: readonly Task[];
  initialTaskRuns: readonly TaskRun[];
  initialTerminals: readonly TerminalView[];
  initialPreviews: readonly PreviewLifecycleView[];
  previewGateway: { readonly protocol: "http:" | "https:"; readonly port: number | null };
  repositoryUrl: string;
  actor: string;
  initialMessage?: string | null;
}) {
  const [tabs, setTabs] = useState<WorkbenchTabState>(emptyWorkbenchTabs);
  const [dirtyEditorIds, setDirtyEditorIds] = useState<ReadonlySet<string>>(new Set());
  const [terminals, setTerminals] = useState<readonly TerminalView[]>(initialTerminals);
  const lostTerminalObservedAt = useRef(new Map<string, number>());
  const [sidebarNow, setSidebarNow] = useState(() => Date.now());
  const currentTerminals = useRef(initialTerminals);
  const [tasks, setTasks] = useState<readonly Task[]>(initialTasks);
  const [runs, setRuns] = useState<readonly TaskRun[]>(initialTaskRuns);
  const [previews, setPreviews] = useState<readonly PreviewLifecycleView[]>(initialPreviews);
  const [fetchingRepository, setFetchingRepository] = useState(false);
  const [preparingPush, setPreparingPush] = useState(false);
  const [confirmingPush, setConfirmingPush] = useState(false);
  const [pushIntent, setPushIntent] = useState<PushStatus | null>(null);
  const [lastPushStatus, setLastPushStatus] = useState<PushStatus | null>(null);
  const currentPreviews = useRef(initialPreviews);
  const previewLivenessPoller = useRef<PreviewLivenessPoller | null>(null);
  const { notice, show: showNotice, clear: clearNotice } = useTransientNotice(initialMessage);
  const [lostDialogIds, setLostDialogIds] = useState<readonly string[]>([]);
  const lostTerminalRecoveryIds = useRef<readonly string[]>([]);
  const lostDialogSession = useRef<LostTerminalDialogSession | null>(null);
  currentTerminals.current = terminals;
  currentPreviews.current = previews;
  const dismissLostTerminalDialog = useCallback((ids: readonly string[]) => {
    const key = lostTerminalSetKey(ids);
    lostDialogSession.current?.dismiss(ids);
    window.sessionStorage.setItem(LOST_TERMINAL_DISMISSED_SESSION_KEY, key);
    setLostDialogIds([]);
  }, []);
  const handleLostTerminalRestartSuccess = useCallback(() => {
    const ids = lostDialogIds;
    lostTerminalRecoveryIds.current = [];
    setTerminals((current) => removeTerminalCollectionEntries(current, ids));
    setTabs((current) => closeWorkbenchTabsForTerminalIds(current, ids));
    dismissLostTerminalDialog(ids);
  }, [dismissLostTerminalDialog, lostDialogIds]);
  const handleLostTerminalRestartInitiated = useCallback(() => {
    const ids = lostDialogIds;
    lostTerminalRecoveryIds.current = ids;
    setTerminals((current) => removeTerminalCollectionEntries(current, ids));
    setTabs((current) => closeWorkbenchTabsForTerminalIds(current, ids));
  }, [lostDialogIds]);
  useEffect(() => {
    const ids = terminals.filter((terminal) => terminal.state === "lost").map((terminal) => terminal.id);
    if (lostDialogSession.current === null) {
      lostDialogSession.current = new LostTerminalDialogSession(window.sessionStorage.getItem(LOST_TERMINAL_DISMISSED_SESSION_KEY));
    }
    const next = lostDialogSession.current.observe(ids);
    if (ids.length === 0) {
      if (lostTerminalRecoveryIds.current.length === 0) setLostDialogIds([]);
    } else if (next.length > 0) setLostDialogIds(next);
  }, [terminals]);
  useEffect(() => {
    const now = Date.now();
    const lostIds = new Set<string>();
    for (const terminal of terminals) {
      if (terminal.state === "lost") {
        lostIds.add(terminal.id);
        if (!lostTerminalObservedAt.current.has(terminal.id)) lostTerminalObservedAt.current.set(terminal.id, now);
      } else {
        lostTerminalObservedAt.current.delete(terminal.id);
      }
    }
    for (const terminalId of lostTerminalObservedAt.current.keys()) {
      if (!lostIds.has(terminalId)) lostTerminalObservedAt.current.delete(terminalId);
    }
    setSidebarNow(now);
    const expiry = [...lostTerminalObservedAt.current.values()].reduce<number | undefined>((earliest, lostAt) => {
      const candidate = lostAt + LOST_TERMINAL_SIDEBAR_EXPIRY_MS;
      return earliest === undefined || candidate < earliest ? candidate : earliest;
    }, undefined);
    if (expiry === undefined) return;
    const timer = window.setTimeout(() => setSidebarNow(Date.now()), Math.max(0, expiry - now));
    return () => window.clearTimeout(timer);
  }, [terminals]);
  useEffect(() => {
    setPreviews(initialPreviews);
    currentPreviews.current = initialPreviews;
  }, [initialPreviews]);
  useEffect(() => {
    if (!pushAvailable) return;
    let cancelled = false;
    fetch(`/api/projects/${projectId}/push`, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const result = await response.json() as { push?: PushStatus | null };
      if (!cancelled && result.push !== undefined && result.push !== null) {
        setLastPushStatus(result.push);
        if (result.push.state === "prepared") setPushIntent(result.push);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId, pushAvailable]);
  const getTerminalTitle = useCallback((terminal: TerminalView): string => {
    return terminal.title;
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
    }
    let nextPreviews = [...currentPreviews.current];
    if (previewResponse.ok) {
      const data = await previewResponse.json() as { previews: PreviewLifecycleView[] };
      nextPreviews = data.previews;
      currentPreviews.current = data.previews;
      setPreviews(data.previews);
    }
    return { terminals, previews: nextPreviews };
  }, [getTerminalTitle, projectId]);
  const refreshPreviews = useCallback(async (): Promise<readonly PreviewLifecycleView[] | null> => {
    const response = await fetch(`/api/projects/${projectId}/previews`, { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json() as { previews: PreviewLifecycleView[] };
    currentPreviews.current = data.previews;
    setPreviews(data.previews);
    return data.previews;
  }, [projectId]);
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
    // TODO: move active preview reconciliation into background server orchestration rather than relying on an open Workbench.
    const poller = createPreviewLivenessPoller({
      readPreviews: () => currentPreviews.current,
      readVisibility: () => document.visibilityState,
      refreshPreviews,
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer)
    });
    previewLivenessPoller.current = poller;
    const handleVisibility = () => poller.visibilityChanged();
    document.addEventListener("visibilitychange", handleVisibility);
    poller.start();
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      poller.stop();
      if (previewLivenessPoller.current === poller) previewLivenessPoller.current = null;
    };
  }, [refreshPreviews]);

  useEffect(() => {
    previewLivenessPoller.current?.previewsChanged();
  }, [previews]);

  const visibleTerminals = useMemo(() => sortTerminalViewsByTitle(terminals.filter((terminal) =>
    isTerminalSidebarVisible(terminal.state, lostTerminalObservedAt.current.get(terminal.id), sidebarNow))), [sidebarNow, terminals]);
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
  const openAiTab = useCallback(() => {
    setTabs((current) => openWorkbenchTab(current, { id: aiTabId(workspaceId), kind: "ai", sessionId: workspaceId }));
  }, [workspaceId]);
  const openEditorTab = useCallback((relativePath: string) => {
    setTabs((current) => openWorkbenchTab(current, editorTab(relativePath)));
  }, []);
  const updateEditorDirty = useCallback((tabId: string, dirty: boolean) => {
    setDirtyEditorIds((current) => {
      if (current.has(tabId) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(tabId); else next.delete(tabId);
      return next;
    });
  }, []);
  const createTerminal = async () => {
    if (!actionsAvailable) return;
    showNotice("Creating terminal…", "pending");
    const response = await fetch(`/api/projects/${projectId}/terminals`, { method: "POST",
      headers: { "content-type": "application/json", "x-devspace-csrf": "1" }, body: JSON.stringify({ action: "create" }) });
    const body = await response.json() as { terminalId?: string; message?: string; incidentId?: string };
    if (!response.ok || body.terminalId === undefined) {
      showNotice(body.message ?? "Terminal creation failed.", "error", body.incidentId);
      return;
    }
    const data = await refresh();
    const terminal = data.terminals.find((candidate) => candidate.id === body.terminalId);
    if (terminal === undefined || !isTerminalAttachableState(terminal.state)) {
      showNotice("Terminal creation succeeded, but its current state is not attachable.", "error");
      return;
    }
    openTerminalTab(terminal);
    clearNotice();
  };
  const closeTab = (tab: WorkbenchTab) => {
    if (tab.kind === "editor" && dirtyEditorIds.has(tab.id) && !window.confirm(`Discard unsaved changes in ${tab.title}?`)) return;
    if (tab.kind === "editor") updateEditorDirty(tab.id, false);
    setTabs((current) => closeWorkbenchTab(current, tab.id));
  };
  const runTask = async (taskKey: string) => {
    if (!actionsAvailable) return;
    showNotice("Starting task…", "pending");
    const response = await fetch(`/api/projects/${projectId}/tasks`, { method: "POST",
      headers: { "content-type": "application/json", "x-devspace-csrf": "1" }, body: JSON.stringify({ action: "run", taskKey }) });
    const result = await response.json() as { message?: string; incidentId?: string };
    showNotice(response.ok ? "Task started." : result.message ?? "Task action failed.", response.ok ? "success" : "error",
      response.ok ? undefined : result.incidentId);
    await refresh();
  };
  const reloadPreview = async (previewId: string) => {
    showNotice("Reconciling preview…", "pending");
    const response = await fetch(`/api/projects/${projectId}/previews`, { method: "POST",
      headers: { "content-type": "application/json", "x-devspace-csrf": "1" }, body: JSON.stringify({ action: "reload", previewId }) });
    const result = await response.json() as { message?: string; previews?: PreviewLifecycleView[]; incidentId?: string };
    if (Array.isArray(result.previews)) setPreviews(result.previews);
    showNotice(response.ok ? "Preview reconciliation requested." : result.message ?? "Preview reconciliation failed.", response.ok ? "success" : "error",
      response.ok ? undefined : result.incidentId);
  };
  const fetchRepository = async () => {
    if (!agentReachable || fetchingRepository) return;
    setFetchingRepository(true);
    showNotice("Fetching repository…", "pending");
    try {
      const response = await fetch(`/api/projects/${projectId}/fetch`, {
        method: "POST", headers: { Origin: window.location.origin, "x-devspace-csrf": "1" }
      });
      const result = await response.json() as { message?: string; incidentId?: string };
      if (response.status === 202) {
        showNotice(result.message ?? "Fetch is still in progress. Retry to reconcile it.", "pending", result.incidentId);
      } else {
        showNotice(response.ok ? "Repository fetched." : result.message ?? "Repository fetch failed.", response.ok ? "success" : "error",
          response.ok ? undefined : result.incidentId);
      }
      if (response.ok) await refresh();
    } catch {
      showNotice("Repository fetch failed safely.", "error");
    } finally {
      setFetchingRepository(false);
    }
  };
  const preparePush = async () => {
    if (!pushAvailable || !agentReachable || preparingPush || confirmingPush) return;
    setPreparingPush(true);
    showNotice("Preparing push…", "pending");
    try {
      const response = await fetch(`/api/projects/${projectId}/push`, {
        method: "POST", headers: { "content-type": "application/json", Origin: window.location.origin, "x-devspace-csrf": "1" },
        body: JSON.stringify({ action: "prepare" })
      });
      const result = await response.json() as PushStatus & { code?: string; message?: string; incidentId?: string };
      if (!response.ok || result.operationId === undefined) {
        showNotice(result.message ?? "Push preparation failed.", "error", result.incidentId);
        return;
      }
      setPushIntent(result);
      setLastPushStatus(result);
      showNotice("Review the captured branch and commit, then confirm the push.", "pending");
    } catch {
      showNotice("Push preparation failed safely.", "error");
    } finally {
      setPreparingPush(false);
    }
  };
  const confirmPush = async () => {
    if (pushIntent === null || confirmingPush) return;
    setConfirmingPush(true);
    showNotice("Pushing the captured commit…", "pending");
    try {
      const response = await fetch(`/api/projects/${projectId}/push`, {
        method: "POST", headers: { "content-type": "application/json", Origin: window.location.origin, "x-devspace-csrf": "1" },
        body: JSON.stringify({ action: "confirm", operationId: pushIntent.operationId })
      });
      const result = await response.json() as PushStatus & { code?: string; message?: string; incidentId?: string };
      if (!response.ok) {
        setLastPushStatus({ ...pushIntent, state: "failed", errorCode: result.code ?? null, message: result.message ?? null });
        setPushIntent(null);
        showNotice(result.message ?? "Repository push failed.", "error", result.incidentId);
        return;
      }
      setLastPushStatus(result);
      setPushIntent(null);
      showNotice("Repository push succeeded.", "success");
    } catch {
      setLastPushStatus({ ...pushIntent, state: "failed", errorCode: "GITHUB_PUSH_OUTCOME_UNCERTAIN", message: "The push outcome is uncertain. Inspect the remote branch before explicitly retrying." });
      setPushIntent(null);
      showNotice("Repository push outcome is uncertain. Inspect the remote branch before retrying.", "error");
    } finally {
      setConfirmingPush(false);
    }
  };

  return <main className="workbench" aria-label={`${projectName} project workbench`}>
    <WorkbenchTopBar projectName={projectName} branchName={branchName} repositoryUrl={repositoryUrl} projectId={projectId}
      runtimeState={runtimeState} runtimeAvailable={runtimeAvailable} activeAction={activeAction} canStart={canStart} canStop={canStop}
      retryStart={retryStart} agentReachable={agentReachable} fetchingRepository={fetchingRepository}
      pushAvailable={pushAvailable} pushingRepository={preparingPush} lastPushStatus={lastPushStatus}
      onPushRepository={() => { preparePush().catch(() => showNotice("Push preparation failed safely.", "error")); }}
      onFetchRepository={() => { fetchRepository().catch(() => showNotice("Repository fetch failed safely.", "error")); }} />
    <div className="workbench-body">
      <WorkbenchSidebar projectId={projectId} workspaceId={workspaceId} agentReachable={agentReachable} onOpenFile={openEditorTab}
        terminals={visibleTerminals} getTerminalTitle={getTerminalTitle} tabs={tabs} actionsAvailable={actionsAvailable} tasks={tasks} runs={runs}
        previews={previews} onOpenPreview={openPreviewTab} onOpenAi={openAiTab}
        onOpenTerminal={openTerminalTab} onCreateTerminal={() => { createTerminal().catch(() => showNotice("Terminal creation failed.", "error")); }}
        onRunTask={(taskKey) => { runTask(taskKey).catch(() => showNotice("Task action failed.", "error")); }} />
      <section className="workbench-main" aria-label="Workbench surface">
        <WorkbenchTabStrip tabs={tabs} onActivate={(tabId) => setTabs((current) => activateWorkbenchTab(current, tabId))}
          onClose={closeTab} onCreateTerminal={() => { createTerminal().catch(() => showNotice("Terminal creation failed.", "error")); }}
          canCreateTerminal={actionsAvailable} dirtyEditorIds={dirtyEditorIds} />
        <WorkbenchSurface tabs={tabs} terminalById={terminalById} previewById={previewById} projectId={projectId} workspaceId={workspaceId}
          onRefresh={handleRefresh} onTerminalStateChange={updateTerminalState} onReloadPreview={reloadPreview} previewGateway={previewGateway}
          onEditorDirtyChange={updateEditorDirty} />
        {notice !== null && <p className={`workbench-message message ${notice.kind}`} role="status">
          <span>{notice.message}</span>
          <IncidentReference incidentId={notice.referenceId} />
        </p>}
      </section>
    </div>
    {lostDialogIds.length > 0 && <LostTerminalDialog key={lostTerminalSetKey(lostDialogIds)} count={lostDialogIds.length} projectId={projectId} runtimeState={runtimeState}
      runtimeAvailable={runtimeAvailable} activeAction={activeAction} canStart={canStart} canStop={canStop} retryStart={retryStart}
      onDismiss={() => {
        lostTerminalRecoveryIds.current = [];
        dismissLostTerminalDialog(lostDialogIds);
      }} onRestartInitiated={handleLostTerminalRestartInitiated} onRestartSuccess={handleLostTerminalRestartSuccess} />}
    {pushIntent !== null && <PushConfirmationDialog intent={pushIntent} confirming={confirmingPush}
      onCancel={() => { if (!confirmingPush) { setPushIntent(null); clearNotice(); } }} onConfirm={() => { confirmPush().catch(() => showNotice("Repository push failed safely.", "error")); }} />}
    <WorkbenchStatusBar runtimeState={runtimeState} agentStatus={agentStatus} agentReachable={agentReachable} actor={actor} />
  </main>;
}

function WorkbenchTopBar({ projectName, branchName, repositoryUrl, projectId, runtimeState, runtimeAvailable, activeAction, canStart,
  canStop, retryStart, agentReachable, fetchingRepository, pushAvailable, pushingRepository, lastPushStatus, onPushRepository, onFetchRepository }: {
  projectName: string; branchName: string; repositoryUrl: string; projectId: string; runtimeState: string; runtimeAvailable: boolean;
  activeAction: "start" | "stop" | null; canStart: boolean; canStop: boolean; retryStart: boolean; agentReachable: boolean;
  fetchingRepository: boolean; pushAvailable: boolean; pushingRepository: boolean; lastPushStatus: PushStatus | null;
  onPushRepository: () => void; onFetchRepository: () => void;
}) {
  return <header className="workbench-topbar">
    <div className="workbench-breadcrumb"><Link href="/" aria-label="Back to Projects">Projects</Link><span aria-hidden="true">/</span><strong>{projectName}</strong></div>
    <div className="workbench-context"><span className="context-item"><span className="context-label">branch</span><code>{branchName}</code></span>
      <a className="topbar-action" href={repositoryUrl} target="_blank" rel="noreferrer">Repository</a>
      {pushAvailable && <button type="button" className="topbar-action push-action" disabled={!agentReachable || pushingRepository || fetchingRepository} onClick={onPushRepository}>
        {pushingRepository ? "Preparing…" : "Push"}
      </button>}
      {lastPushStatus?.state === "failed" && lastPushStatus.errorCode === "GITHUB_PUSH_OUTCOME_UNCERTAIN" &&
        <span className="push-outcome-note" title={`${lastPushStatus.repository} · ${lastPushStatus.branchName} · ${lastPushStatus.commitOid}`}>Last push needs inspection</span>}
      <button type="button" className="topbar-action" disabled={!agentReachable || fetchingRepository} onClick={onFetchRepository}>
        {fetchingRepository ? "Fetching…" : "Fetch repository"}
      </button>
      <span className={`runtime-chip ${runtimeState}`}>{runtimeLabel(runtimeState)}</span>
      <RuntimeControls projectId={projectId} runtimeState={runtimeState} runtimeAvailable={runtimeAvailable} activeAction={activeAction} canStart={canStart}
        canStop={canStop} retryStart={retryStart} />
    </div>
  </header>;
}

function WorkbenchSidebar({ projectId, workspaceId, agentReachable, onOpenFile, terminals, getTerminalTitle, tabs, actionsAvailable, tasks, runs, previews, onOpenPreview, onOpenAi,
  onOpenTerminal, onCreateTerminal, onRunTask }: {
  projectId: string; workspaceId: string; agentReachable: boolean; onOpenFile: (relativePath: string) => void;
  terminals: readonly TerminalView[]; getTerminalTitle: (terminal: TerminalView) => string; tabs: WorkbenchTabState; actionsAvailable: boolean; tasks: readonly Task[]; runs: readonly TaskRun[];
  previews: readonly PreviewLifecycleView[]; onOpenPreview: (preview: PreviewLifecycleView) => void; onOpenAi: () => void;
  onOpenTerminal: (terminal: TerminalView) => void; onCreateTerminal: () => void; onRunTask: (taskKey: string) => void;
}) {
  return <aside className="workbench-sidebar" aria-label="Project navigation">
    <div className="sidebar-heading"><span>Project</span><span className="sidebar-kicker">M1</span></div>
    <nav className="workbench-nav" aria-label="Workbench tools">
      <button type="button" className="workbench-nav-item active"><span aria-hidden="true">▸</span> Terminals <span className="nav-count">{terminals.length}</span></button>
      <button type="button" className="workbench-nav-item"><span aria-hidden="true">≡</span> Tasks <span className="nav-count">{tasks.length}</span></button>
      <button type="button" className="workbench-nav-item" onClick={onOpenAi}>
        <span aria-hidden="true">✦</span> AI<span className="nav-future">Beta</span>
      </button>
      <button type="button" className="workbench-nav-item" onClick={() => { const first = previews[0]; if (first !== undefined) onOpenPreview(first); }}>
        <span aria-hidden="true">▾</span> Previews <span className="nav-count">{previews.length}</span>
      </button>
    </nav>
    <div className="sidebar-section files-sidebar-section">
      <div className="sidebar-section-heading"><h2>Files</h2></div>
      <WorkspaceFileTree projectId={projectId} workspaceId={workspaceId} agentReachable={agentReachable} onOpenFile={onOpenFile} />
    </div>
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

function WorkbenchTabStrip({ tabs, onActivate, onClose, onCreateTerminal, canCreateTerminal, dirtyEditorIds }: {
  tabs: WorkbenchTabState; onActivate: (tabId: string) => void; onClose: (tab: WorkbenchTab) => void; onCreateTerminal: () => void;
  canCreateTerminal: boolean; dirtyEditorIds: ReadonlySet<string>;
}) {
  return <div className="workbench-tabstrip" role="tablist" aria-label="Project tabs">
    {tabs.tabs.map((tab) => <div className={`workbench-tab ${tab.id === tabs.activeTabId ? "active" : ""}`} key={tab.id}>
      <button type="button" role="tab" aria-selected={tab.id === tabs.activeTabId} onClick={() => onActivate(tab.id)}>{tab.kind === "terminal" && <span className="tab-dot" aria-hidden="true" />}
        {tab.kind === "editor" && dirtyEditorIds.has(tab.id) && <span className="editor-tab-dirty" aria-label="Unsaved changes" />}{tabTitle(tab)}</button>
      <button type="button" className="tab-close" aria-label={`Close ${tabTitle(tab)}`} onClick={() => onClose(tab)}>×</button>
    </div>)}
    <button type="button" className="tab-create" disabled={!canCreateTerminal} onClick={onCreateTerminal} aria-label="Create terminal tab" title={canCreateTerminal ? "Create terminal" : "Start the runtime to create a terminal"}>+</button>
    {tabs.tabs.length === 0 && <span className="tabstrip-hint">Open a terminal from the project sidebar</span>}
  </div>;
}

function WorkbenchSurface({ tabs, terminalById, previewById, projectId, workspaceId, onRefresh, onTerminalStateChange, onReloadPreview, previewGateway, onEditorDirtyChange }: {
  tabs: WorkbenchTabState; terminalById: ReadonlyMap<string, TerminalView>; previewById: ReadonlyMap<string, PreviewLifecycleView>;
  projectId: string; workspaceId: string; onRefresh: () => void; onTerminalStateChange: (terminalId: string, state: string) => void;
  onReloadPreview: (previewId: string) => Promise<void>;
  previewGateway: { readonly protocol: "http:" | "https:"; readonly port: number | null };
  onEditorDirtyChange: (tabId: string, dirty: boolean) => void;
}) {
  return <div className="workbench-surface">
    {tabs.tabs.length === 0 && <div className="workbench-empty"><div className="empty-glyph" aria-hidden="true">⌘</div><h1>Project Workbench</h1><p>Open a file or terminal to start working in this project.</p></div>}
    {tabs.tabs.map((tab) => tab.kind === "terminal" ? <TerminalTab key={tab.id} projectId={projectId} workspaceId={workspaceId}
      terminal={terminalById.get(tab.terminalId) ?? { id: tab.terminalId, processId: tab.terminalId, title: tab.title, state: "disconnected" }}
      active={tab.id === tabs.activeTabId} onRefresh={onRefresh} onTerminalStateChange={onTerminalStateChange} />
      : tab.kind === "preview" ? (() => {
        const preview = previewById.get(tab.previewId);
        return preview === undefined ? null : <PreviewTab key={tab.id} preview={preview}
          active={tab.id === tabs.activeTabId} onReload={onReloadPreview} previewGateway={previewGateway} />;
      })() : tab.kind === "ai" ? <AiSessionTab key={tab.id} projectId={projectId} workspaceId={workspaceId} active={tab.id === tabs.activeTabId} />
        : tab.kind === "editor" ? <EditorTab key={tab.id} projectId={projectId} workspaceId={workspaceId} path={tab.fileId} tabId={tab.id}
          active={tab.id === tabs.activeTabId} onDirtyChange={onEditorDirtyChange} /> : null)}
  </div>;
}

function PushConfirmationDialog({ intent, confirming, onCancel, onConfirm }: {
  intent: PushStatus; confirming: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const relation = intent.aheadCount === 0 && intent.behindCount === 0
    ? "Remote branch relation is unchanged or unavailable."
    : `${intent.aheadCount} commit${intent.aheadCount === 1 ? "" : "s"} ahead, ${intent.behindCount} behind`;
  return <div className="push-dialog-backdrop">
    <section className="push-dialog" role="dialog" aria-modal="true" aria-labelledby="push-dialog-title" aria-describedby="push-dialog-description">
      <h2 id="push-dialog-title">Confirm push</h2>
      <p id="push-dialog-description">DevSpace will update the same branch on the selected private GitHub repository with this captured commit.</p>
      <dl className="push-intent-details">
        <div><dt>Repository</dt><dd>{intent.repository}</dd></div>
        <div><dt>Branch</dt><dd><code>{intent.branchName}</code></dd></div>
        <div><dt>Local commit</dt><dd><code>{intent.commitOid}</code></dd></div>
        <div><dt>Remote relation</dt><dd>{relation}</dd></div>
      </dl>
      {intent.dirty && <p className="push-dialog-warning">This workspace still has uncommitted changes; only the captured commit will be pushed.</p>}
      <div className="push-dialog-actions">
        <button type="button" className="push-cancel" disabled={confirming} onClick={onCancel}>Cancel</button>
        <button type="button" className="push-confirm" disabled={confirming} onClick={onConfirm}>
          {confirming ? "Pushing…" : "Confirm push"}
        </button>
      </div>
    </section>
  </div>;
}

function LostTerminalDialog({ count, projectId, runtimeState, runtimeAvailable, activeAction, canStart, canStop, retryStart, onDismiss, onRestartInitiated, onRestartSuccess }: {
  count: number; projectId: string; runtimeState: string; runtimeAvailable: boolean; activeAction: "start" | "stop" | null;
  canStart: boolean; canStop: boolean; retryStart: boolean; onDismiss: () => void; onRestartInitiated: () => void; onRestartSuccess: () => void;
}) {
  const [step, setStep] = useState<LostTerminalDialogStep>("warning");
  const copy = lostTerminalDialogCopy(count);
  const goToStep = (action: "dismiss" | "go-back") => setStep((current) => lostTerminalDialogStepAfter(current, action));
  return <div className="lost-terminal-dialog-backdrop">
    <section className={`lost-terminal-dialog ${step}`} role="dialog" aria-modal="true" aria-labelledby="lost-terminal-dialog-title" aria-describedby="lost-terminal-dialog-description">
      {step === "warning" ? <>
        <h2 id="lost-terminal-dialog-title">Terminal session lost</h2>
        <div className="lost-terminal-warning-summary">
          <span className="lost-terminal-warning-icon" aria-hidden="true">!</span>
          <div>
            <p className="lost-terminal-warning-statement">{copy.warningStatement}</p>
            <p className="lost-terminal-warning-supporting" id="lost-terminal-dialog-description">{copy.warningSupporting}</p>
          </div>
        </div>
        <div className="lost-terminal-dialog-actions">
          <button type="button" className="lost-terminal-dismiss" onClick={() => goToStep("dismiss")}>Dismiss</button>
          <RuntimeControls projectId={projectId} runtimeState={runtimeState} runtimeAvailable={runtimeAvailable} activeAction={activeAction}
            canStart={canStart} canStop={canStop} retryStart={retryStart} restart onRestartInitiated={onRestartInitiated} onSuccess={onRestartSuccess} />
        </div>
      </> : <>
        <h2 id="lost-terminal-dialog-title">{copy.confirmationTitle}</h2>
        <p className="lost-terminal-confirmation-body" id="lost-terminal-dialog-description">{copy.confirmationBody}</p>
        <div className="lost-terminal-dialog-actions lost-terminal-confirmation-actions">
          <button type="button" className="lost-terminal-go-back" onClick={() => goToStep("go-back")}>Go back</button>
          <button type="button" className="lost-terminal-dismiss-anyway" onClick={onDismiss}>Dismiss anyway</button>
        </div>
      </>}
    </section>
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
  return tab.kind === "terminal" ? tab.title : tab.kind === "editor" ? tab.title : tab.kind === "preview" ? "Preview"
    : tab.kind === "ai" ? "AI session" : tab.kind === "git" ? "Git" : "Task output";
}
