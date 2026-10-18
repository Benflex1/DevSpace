"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { nativeAiPresentation } from "./native-ai-presentation.js";
import { nativeHarnessTerminalState } from "./terminal-lifecycle.js";
import { TerminalTab, type TerminalView } from "./terminal-tab.js";

type Definition = { id: string; displayName: string; origin: string };
type NativeSession = {
  id: string;
  harnessId: string | null;
  state: string;
  terminalSessionId: string | null;
  processId: string | null;
  title: string;
  processGeneration?: number;
  resume?: boolean;
  admissionStatus?: "preparing" | "admitting" | "admitted" | "uncertain" | "unknown";
};

type AdmissionAction = "create-native" | "resume" | "retry-native";

function preferredInitialSession(sessions: readonly NativeSession[]): NativeSession | null {
  const priority = (session: NativeSession) => session.state === "active" ? 0
    : session.state === "creating" ? 1
      : session.resume === true ? 2 : 3;
  return [...sessions].sort((left, right) => priority(left) - priority(right)
    || (left.id === right.id ? 0 : left.id > right.id ? -1 : 1))[0] ?? null;
}

function sessionOptionLabel(session: NativeSession): string {
  const status = session.state === "active" ? "Running"
    : session.state === "creating" ? session.admissionStatus === "uncertain" ? "Admission uncertain" : "Starting"
      : session.state === "lost" ? "Connection lost"
        : session.state === "stopped" ? "Stopped" : session.state;
  return `${session.title} · ${status} · ${session.id.slice(-6)}`;
}

export function HarnessSessionTab({ projectId, workspaceId, active }: {
  projectId: string;
  workspaceId: string;
  active: boolean;
}) {
  const [definitions, setDefinitions] = useState<Definition[]>([{ id: "codex", displayName: "Codex", origin: "builtin" }]);
  const [harnessId, setHarnessId] = useState("codex");
  const [sessions, setSessions] = useState<NativeSession[]>([]);
  const [selectedNativeSessionId, setSelectedNativeSessionId] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<TerminalView | null>(null);
  const [attachmentState, setAttachmentState] = useState<"connecting" | "attached" | "reconnecting" | "failed" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<AdmissionAction | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [discoveringAdmission, setDiscoveringAdmission] = useState(false);
  const [pollExhaustedSessionId, setPollExhaustedSessionId] = useState<string | null>(null);
  const pending = pendingAction !== null;
  const sessionsRef = useRef<NativeSession[]>([]);
  const selectedNativeSessionIdRef = useRef<string | null>(null);
  const autoSelectPending = useRef(true);
  const awaitingSessionId = useRef<string | null>(null);
  const refreshSequence = useRef(0);
  const selectionSequence = useRef(0);
  const scope = useRef({ projectId, workspaceId });
  const uncertainCreateBaseline = useRef<Set<string> | null>(null);
  const admissionRetryKeys = useRef(new Set<string>());
  const admissionPollAttempts = useRef(new Map<string, number>());
  const activePostKeys = useRef(new Set<string>());

  const selectNativeSession = useCallback((id: string | null) => {
    selectionSequence.current += 1;
    selectedNativeSessionIdRef.current = id;
    if (awaitingSessionId.current !== id) awaitingSessionId.current = null;
    autoSelectPending.current = false;
    setSelectedNativeSessionId(id);
    const selected = id === null ? null : sessionsRef.current.find((item) => item.id === id) ?? null;
    if (selected === null) {
      setTerminal(null);
      setAttachmentState(null);
      return;
    }
    const terminalIsOpenable = selected.state === "active" && selected.terminalSessionId !== null;
    setTerminal(!terminalIsOpenable ? null : {
      id: selected.terminalSessionId!,
      processId: selected.processId ?? selected.terminalSessionId!,
      title: selected.title,
      state: nativeHarnessTerminalState(selected.state)
    });
    setAttachmentState(terminalIsOpenable ? "connecting" : null);
  }, []);

  const refresh = useCallback(async (selection?: { readonly exactSessionId: string | null }) => {
    if (scope.current.projectId !== projectId || scope.current.workspaceId !== workspaceId) {
      scope.current = { projectId, workspaceId };
      sessionsRef.current = [];
      selectedNativeSessionIdRef.current = null;
      autoSelectPending.current = true;
      awaitingSessionId.current = null;
      uncertainCreateBaseline.current = null;
      admissionPollAttempts.current.clear();
      admissionRetryKeys.current.clear();
      setDiscoveringAdmission(false);
      setPollExhaustedSessionId(null);
      setSessions([]);
      setSelectedNativeSessionId(null);
      setTerminal(null);
      setAttachmentState(null);
    }
    const requestSequence = ++refreshSequence.current;
    const requestSelectionSequence = selectionSequence.current;
    const response = await fetch(`/api/projects/${projectId}/harness?workspaceId=${workspaceId}`, { cache: "no-store" });
    if (!response.ok) throw new Error("native-harness-refresh-failed");
    const body = await response.json() as { definitions?: Definition[]; sessions?: NativeSession[] };
    if (requestSequence !== refreshSequence.current || scope.current.projectId !== projectId || scope.current.workspaceId !== workspaceId) {
      if (selection !== undefined) throw new Error("native-harness-refresh-superseded");
      return;
    }
    setRefreshFailed(false);
    if (Array.isArray(body.definitions) && body.definitions.length > 0) setDefinitions(body.definitions);
    const nextSessions = Array.isArray(body.sessions) ? body.sessions : [];
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
    const baseline = uncertainCreateBaseline.current;
    const discovered = baseline === null ? null : [...nextSessions]
      .filter((item) => !baseline.has(item.id) && (item.state === "creating" || item.state === "active"))
      .sort((left, right) => left.id === right.id ? 0 : left.id > right.id ? -1 : 1)[0] ?? null;
    const selectionIsCurrent = selectionSequence.current === requestSelectionSequence;
    let selectedId = selectedNativeSessionIdRef.current;
    if (discovered !== null && selectionIsCurrent) {
      selectedId = discovered.id;
      uncertainCreateBaseline.current = null;
      setDiscoveringAdmission(false);
      awaitingSessionId.current = null;
      autoSelectPending.current = false;
      selectedNativeSessionIdRef.current = selectedId;
      setSelectedNativeSessionId(selectedId);
    } else if (selection !== undefined && selectionIsCurrent) {
      const exactSession = selection.exactSessionId === null
        ? null
        : nextSessions.find((item) => item.id === selection.exactSessionId) ?? null;
      if (exactSession !== null) {
        selectedId = exactSession.id;
        awaitingSessionId.current = null;
      } else if (selection.exactSessionId !== null) {
        // Admission succeeded; do not fall back to an older session while projection catches up.
        selectedId = selection.exactSessionId;
        awaitingSessionId.current = selectedId;
      } else if (selectedId !== null && !nextSessions.some((item) => item.id === selectedId)) {
        selectedId = null;
      }
      autoSelectPending.current = false;
      selectedNativeSessionIdRef.current = selectedId;
      setSelectedNativeSessionId(selectedId);
    } else if (selectedId !== null && !nextSessions.some((item) => item.id === selectedId)) {
      if (awaitingSessionId.current !== selectedId) {
        selectedId = null;
        selectedNativeSessionIdRef.current = null;
        autoSelectPending.current = false;
        setSelectedNativeSessionId(null);
      }
    } else if (selectedId === null && autoSelectPending.current && nextSessions.length > 0) {
      selectedId = preferredInitialSession(nextSessions)?.id ?? null;
      selectedNativeSessionIdRef.current = selectedId;
      autoSelectPending.current = false;
      setSelectedNativeSessionId(selectedId);
    }
    const current = selectedId === null ? null : nextSessions.find((item) => item.id === selectedId) ?? null;
    if (current !== null && awaitingSessionId.current === current.id) awaitingSessionId.current = null;
    if (current?.state === "active" && current.terminalSessionId) {
      setTerminal((existing) => {
        const nextState = nativeHarnessTerminalState(current.state);
        if (existing?.id === current.terminalSessionId && existing.state === nextState && existing.title === current.title) {
          return existing;
        }
        return {
          id: current.terminalSessionId!,
          processId: current.processId ?? current.terminalSessionId!,
          title: current.title,
          state: nextState
        };
      });
    } else {
      setTerminal(null);
      setAttachmentState(null);
    }
    if (selectionIsCurrent && selection?.exactSessionId != null && current === null) {
      throw new Error("native-harness-session-not-projected");
    }
  }, [projectId, workspaceId]);

  const selectCurrentLiveSession = () => {
    const current = preferredInitialSession(sessionsRef.current.filter((item) => item.state === "active" || item.state === "creating"));
    if (current !== null) selectNativeSession(current.id);
  };

  const post = async (body: Record<string, unknown>) => {
    const action = body.action as AdmissionAction;
    const isCreate = action === "create-native";
    const isRetry = action === "retry-native";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    const generation = typeof body.processGeneration === "number" ? body.processGeneration : 0;
    const actionIdentity = isCreate
      ? (typeof body.harnessId === "string" ? body.harnessId : "")
      : (sessionId ?? "") + ":" + generation;
    const postKey = projectId + ":" + workspaceId + ":" + action + ":" + actionIdentity;
    if (activePostKeys.current.has(postKey)) return;
    activePostKeys.current.add(postKey);
    const operation = isCreate ? "native-harness.start" : isRetry ? "native-harness.retry" : "native-harness.resume";
    const baseline = new Set(sessionsRef.current.map((item) => item.id));
    const requestDetail = {
      action: operation,
      workspaceId,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(typeof body.harnessId === "string" ? { harnessId: body.harnessId } : {})
    };
    try { performance.mark("devspace.native-harness.request-started", { detail: requestDetail }); }
    catch { /* performance diagnostics must not affect admission */ }
    setPendingAction(action);
    setRefreshFailed(false);
    setMessage(null);
    let admitted = false;
    try {
      const response = await fetch(`/api/projects/${projectId}/harness`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-devspace-csrf": "1" },
        body: JSON.stringify(body)
      });
      const payload = await response.json() as { message?: string; code?: string; sessionId?: string };
      try {
        performance.mark(response.ok ? "devspace.native-harness.request-succeeded" : "devspace.native-harness.request-failed", {
          detail: {
            ...requestDetail,
            ...(typeof payload.sessionId === "string" ? { sessionId: payload.sessionId } : {}),
            statusCode: response.status
          }
        });
      } catch { /* performance diagnostics must not affect admission */ }
      if (!response.ok) {
        if (isCreate && (response.status >= 500 || payload.code === "HARNESS_ADMISSION_UNCERTAIN")) {
          uncertainCreateBaseline.current = baseline;
          setDiscoveringAdmission(true);
          setMessage("The start response was interrupted. Checking the existing session.");
          try { await refresh(); } catch { setRefreshFailed(true); }
        } else if (response.status === 409 || response.status === 422) {
          setMessage(payload.message ?? "The session state changed. Refreshing the current session.");
          try {
            await refresh(sessionId === undefined ? undefined : { exactSessionId: sessionId });
            selectCurrentLiveSession();
          } catch { setRefreshFailed(true); }
        } else if (isRetry && sessionId !== undefined) {
          setMessage(payload.message ?? "The existing admission could not be reconciled. Refresh its status.");
          try { await refresh({ exactSessionId: sessionId }); } catch { setRefreshFailed(true); }
        } else {
          setRefreshFailed(true);
          setMessage(payload.message ?? "The harness action failed. Refresh before retrying.");
        }
        return;
      }
      admitted = true;
      if (isCreate) {
        if (typeof payload.sessionId !== "string" || payload.sessionId.length === 0) {
          throw new Error("native-harness-session-id-missing");
        }
        awaitingSessionId.current = payload.sessionId;
        selectNativeSession(payload.sessionId);
      }
      if (sessionId !== undefined && !isCreate) selectNativeSession(sessionId);
      await refresh({ exactSessionId: isCreate ? awaitingSessionId.current : sessionId ?? null });
    } catch {
      if (!admitted) {
        try { performance.mark("devspace.native-harness.request-uncertain", { detail: requestDetail }); }
        catch { /* performance diagnostics must not affect admission */ }
      }
      if (isCreate && !admitted) {
        uncertainCreateBaseline.current = baseline;
        setDiscoveringAdmission(true);
        setMessage("The start response was interrupted. Checking the existing session.");
        try { await refresh(); } catch { setRefreshFailed(true); }
      } else if (!admitted && sessionId !== undefined) {
        setMessage("The session request could not be confirmed. Checking the same session.");
        try { await refresh({ exactSessionId: sessionId }); } catch { setRefreshFailed(true); }
      } else {
        setRefreshFailed(true);
        setMessage(admitted
          ? "The session was admitted, but its status could not be refreshed. Retry refresh to attach."
          : "The harness request could not be confirmed. Refresh the session list before trying again.");
      }
    } finally {
      activePostKeys.current.delete(postKey);
      setPendingAction(null);
    }
  };

  useEffect(() => {
    if (active) refresh().then(() => setRefreshFailed(false)).catch(() => setRefreshFailed(true));
  }, [active, refresh]);

  useEffect(() => {
    if (!active || !refreshFailed || selectedNativeSessionId !== null || discoveringAdmission) return;
    let cancelled = false;
    let timer: number | null = null;
    let attempts = 0;
    const retry = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        await refresh();
        setRefreshFailed(false);
        return;
      } catch {
        if (cancelled || attempts >= 6) return;
      }
      timer = window.setTimeout(() => { void retry().catch(() => undefined); }, Math.min(5_000, 1_000 * (2 ** Math.min(attempts - 1, 3))));
    };
    timer = window.setTimeout(() => { void retry().catch(() => undefined); }, 1_000);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [active, discoveringAdmission, refresh, refreshFailed, selectedNativeSessionId]);

  const onRefresh = useCallback(() => {
    refresh().then(() => setRefreshFailed(false)).catch(() => {
      setRefreshFailed(true);
      setMessage("The native session status could not be refreshed.");
    });
  }, [refresh]);
  const retryRefresh = () => {
    setRefreshFailed(false);
    setPollExhaustedSessionId(null);
    if (selectedNativeSessionId !== null) admissionPollAttempts.current.delete(selectedNativeSessionId);
    setMessage(null);
    const selected = selectedNativeSessionIdRef.current;
    const current = selected === null ? null : sessionsRef.current.find((item) => item.id === selected) ?? null;
    const expected = awaitingSessionId.current ?? (current?.state === "creating" ? current.id : null);
    refresh(expected === null ? undefined : { exactSessionId: expected }).catch(() => {
      setRefreshFailed(true);
      setMessage("The native session list could not be refreshed. Retry to attach.");
    });
  };
  const onTerminalStateChange = useCallback((id: string, state: string) => {
    setTerminal((current) => current?.id === id ? { ...current, state } : current);
  }, []);
  const onTerminalAttachmentChange = useCallback((id: string, state: "connecting" | "attached" | "reconnecting" | "failed") => {
    setAttachmentState((current) => terminal?.id === id ? state : current);
  }, [terminal?.id]);

  const startHarness = () => {
    post({ action: "create-native", workspaceId, harnessId }).catch(() => undefined);
  };
  const resumeSelectedHarness = () => {
    const selectedId = selectedNativeSessionIdRef.current;
    const current = selectedId === null ? null : sessionsRef.current.find((item) => item.id === selectedId) ?? null;
    if (current === null || current.resume !== true || (current.state !== "stopped" && current.state !== "lost")) {
      setMessage("The selected native session is no longer resumable. Refresh the session list and choose a session.");
      return;
    }
    post({ action: "resume", workspaceId, sessionId: current.id }).catch(() => undefined);
  };

  const session = selectedNativeSessionId === null
    ? null
    : sessions.find((item) => item.id === selectedNativeSessionId) ?? null;
  const awaitingProjection = selectedNativeSessionId !== null && session === null
    && awaitingSessionId.current === selectedNativeSessionId;
  const admissionPollSessionId = session?.state === "creating" ? session.id : awaitingProjection ? selectedNativeSessionId : null;
  useEffect(() => {
    if (!active || admissionPollSessionId === null) return;
    let cancelled = false;
    let timer: number | null = null;
    const poll = async (previousAttempt: number): Promise<void> => {
      if (cancelled) return;
      const attempt = previousAttempt + 1;
      admissionPollAttempts.current.set(admissionPollSessionId, attempt);
      try { await refresh({ exactSessionId: admissionPollSessionId }); }
      catch { /* keep checking this exact admission within the bounded retry window */ }
      if (cancelled) return;
      const latest = sessionsRef.current.find((item) => item.id === admissionPollSessionId) ?? null;
      const stillPending = latest?.state === "creating"
        || (latest === null && awaitingSessionId.current === admissionPollSessionId);
      if (!stillPending) {
        admissionPollAttempts.current.delete(admissionPollSessionId);
        setPollExhaustedSessionId(null);
        return;
      }
      if (attempt >= 24) {
        setPollExhaustedSessionId(admissionPollSessionId);
        return;
      }
      const delay = Math.min(5_000, 1_000 * (2 ** Math.min(attempt, 3)));
      timer = window.setTimeout(() => { void poll(attempt).catch(() => undefined); }, delay);
    };
    const previousAttempt = admissionPollAttempts.current.get(admissionPollSessionId) ?? 0;
    const initialDelay = previousAttempt === 0 ? 1_000 : Math.min(5_000, 1_000 * (2 ** Math.min(previousAttempt, 3)));
    timer = window.setTimeout(() => { void poll(previousAttempt).catch(() => undefined); }, initialDelay);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [active, admissionPollSessionId, refresh]);

  useEffect(() => {
    if (!active || !discoveringAdmission || uncertainCreateBaseline.current === null) return;
    let cancelled = false;
    let timer: number | null = null;
    let attempts = 0;
    const poll = async () => {
      if (cancelled || uncertainCreateBaseline.current === null) return;
      attempts += 1;
      try { await refresh(); } catch { /* admission discovery remains bounded and retries the list */ }
      if (cancelled || uncertainCreateBaseline.current === null) return;
      if (attempts >= 24) {
        setDiscoveringAdmission(false);
        setMessage("The start outcome is still being checked. Refresh the session list to continue.");
        return;
      }
      const delay = Math.min(5_000, 1_000 * (2 ** Math.min(attempts, 3)));
      timer = window.setTimeout(() => { void poll().catch(() => undefined); }, delay);
    };
    timer = window.setTimeout(() => { void poll().catch(() => undefined); }, 1_000);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [active, discoveringAdmission, refresh]);

  useEffect(() => {
    if (!active || session?.state !== "creating" || session.admissionStatus !== "uncertain"
      || session.processGeneration === undefined) return;
    const retryKey = session.id + ":" + session.processGeneration;
    if (admissionRetryKeys.current.has(retryKey)) return;
    admissionRetryKeys.current.add(retryKey);
    void post({ action: "retry-native", workspaceId, sessionId: session.id, processGeneration: session.processGeneration }).catch(() => undefined);
  }, [active, post, session?.id, session?.state, session?.admissionStatus, session?.processGeneration, workspaceId]);

  useEffect(() => {
    setAttachmentState(terminal === null ? null : "connecting");
  }, [terminal?.id]);

  const basePresentation = nativeAiPresentation(session);
  const activeStatus = attachmentState === "attached" ? "Attached"
    : attachmentState === "failed" ? "Connection failed"
      : attachmentState === "reconnecting" ? "Reconnecting…" : "Connecting…";
  const presentation = pending || discoveringAdmission || awaitingProjection || (refreshFailed && session === null)
    ? { action: "none" as const, showProviderChooser: false,
        status: pending ? pendingAction === "resume" ? "Resuming…"
          : pendingAction === "retry-native" ? "Reconciling admission…" : "Starting…"
          : discoveringAdmission ? "Confirming admission"
            : awaitingProjection ? "Waiting for session projection" : "Refresh required" }
    : {
      ...basePresentation,
      status: session?.state === "active" ? activeStatus : basePresentation.status
    };
  const selected = definitions.find((definition) => definition.id === (session?.harnessId ?? harnessId)) ?? definitions[0];
  const displayName = selected?.displayName ?? "Codex";

  return <section className="native-ai-surface" aria-label="Native harness" hidden={!active}>
    <header className="native-ai-header">
      {(sessions.length > 1 || (sessions.length > 0 && selectedNativeSessionId === null)) && <label className="native-ai-session">
        <span className="visually-hidden">Native session</span>
        <select
          aria-label="Native session"
          value={selectedNativeSessionId ?? ""}
          onChange={(event) => {
            uncertainCreateBaseline.current = null;
            setDiscoveringAdmission(false);
            selectNativeSession(event.target.value === "" ? null : event.target.value);
          }}
          disabled={pending}
        >
          {selectedNativeSessionId === null && <option value="">Select a native session</option>}
          {sessions.map((item) => <option key={item.id} value={item.id}>{sessionOptionLabel(item)}</option>)}
        </select>
      </label>}
      {presentation.showProviderChooser
        ? <label className="native-ai-provider">
          <span className="visually-hidden">Harness</span>
          <select value={harnessId} onChange={(event) => setHarnessId(event.target.value)} disabled={pending} aria-label="Harness">
            {definitions.map((definition) => <option key={definition.id} value={definition.id}>{definition.displayName}</option>)}
          </select>
        </label>
        : <strong className="native-ai-name">{displayName}</strong>}
      {presentation.status !== null && <span className={`native-ai-state${presentation.status === "Running" || presentation.status === "Attached" ? " is-running" : ""}`}>{presentation.status}</span>}
      <span className="native-ai-spacer" />
      {presentation.action === "start" && <button type="button" disabled={pending} onClick={startHarness}>Start</button>}
      {presentation.action === "resume" && session !== null && <button type="button" disabled={pending || session.resume !== true} onClick={resumeSelectedHarness}>Resume</button>}
      {session?.state === "creating" && session.admissionStatus === "uncertain" && session.processGeneration !== undefined
        && <button type="button" disabled={pending} onClick={() => {
          admissionRetryKeys.current.add(session.id + ":" + session.processGeneration);
          void post({ action: "retry-native", workspaceId, sessionId: session.id, processGeneration: session.processGeneration }).catch(() => undefined);
        }}>Reconcile admission</button>}
      {message !== null && <span className="native-ai-message" role="status">{message}</span>}
      {(refreshFailed || pollExhaustedSessionId === selectedNativeSessionId) && <button type="button" disabled={pending} onClick={retryRefresh}>Retry refresh</button>}
    </header>
    <div className="native-ai-terminal">
      {pending
        ? <p className="native-ai-empty" role="status">{pendingAction === "resume" ? "Resuming native session…"
          : pendingAction === "retry-native" ? "Reconciling the existing admission…" : "Starting native session…"}</p>
        : discoveringAdmission
          ? <p className="native-ai-empty" role="status">Checking for the existing native session…</p>
          : awaitingProjection
            ? <p className="native-ai-empty" role="status">Waiting for the new session projection.</p>
          : session?.state === "creating"
            ? <p className="native-ai-empty" role="status">{session.admissionStatus === "preparing" ? "Preparing the harness home…"
              : session.admissionStatus === "admitting" ? "The Agent is admitting the harness…"
                : session.admissionStatus === "admitted" ? "Waiting for the admitted session to appear…"
                  : session.admissionStatus === "uncertain" ? "Checking the exact existing admission…"
                    : "Checking the current admission state…"}</p>
          : terminal !== null
            ? <TerminalTab projectId={projectId} workspaceId={workspaceId} terminal={terminal} active={active}
                {...(selectedNativeSessionId === null ? {} : { nativeHarnessSessionId: selectedNativeSessionId })}
                onRefresh={onRefresh} onTerminalStateChange={onTerminalStateChange}
                onAttachmentStateChange={onTerminalAttachmentChange} />
            : <p className="native-ai-empty">Start a harness to open its terminal.</p>}
    </div>
  </section>;
}
