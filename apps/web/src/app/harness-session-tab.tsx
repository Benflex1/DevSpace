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
  resume?: boolean;
};

function preferredInitialSession(sessions: readonly NativeSession[]): NativeSession | null {
  const priority = (session: NativeSession) => session.state === "active" ? 0
    : session.state === "creating" ? 1
      : session.resume === true ? 2 : 3;
  return [...sessions].sort((left, right) => priority(left) - priority(right)
    || (left.id === right.id ? 0 : left.id > right.id ? -1 : 1))[0] ?? null;
}

function sessionOptionLabel(session: NativeSession): string {
  const status = session.state === "active" ? "Running"
    : session.state === "creating" ? "Starting"
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
  const [message, setMessage] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"create-native" | "resume" | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const pending = pendingAction !== null;
  const sessionsRef = useRef<NativeSession[]>([]);
  const selectedNativeSessionIdRef = useRef<string | null>(null);
  const autoSelectPending = useRef(true);
  const awaitingSessionId = useRef<string | null>(null);
  const refreshSequence = useRef(0);
  const scope = useRef({ projectId, workspaceId });

  const selectNativeSession = useCallback((id: string | null) => {
    selectedNativeSessionIdRef.current = id;
    if (awaitingSessionId.current !== id) awaitingSessionId.current = null;
    autoSelectPending.current = false;
    setSelectedNativeSessionId(id);
    const selected = id === null ? null : sessionsRef.current.find((item) => item.id === id) ?? null;
    if (selected === null) {
      setTerminal(null);
      return;
    }
    setTerminal(selected.terminalSessionId === null ? null : {
      id: selected.terminalSessionId,
      processId: selected.processId ?? selected.terminalSessionId,
      title: selected.title,
      state: nativeHarnessTerminalState(selected.state)
    });
  }, []);

  const refresh = useCallback(async (selection?: { readonly exactSessionId: string | null }) => {
    if (scope.current.projectId !== projectId || scope.current.workspaceId !== workspaceId) {
      scope.current = { projectId, workspaceId };
      sessionsRef.current = [];
      selectedNativeSessionIdRef.current = null;
      autoSelectPending.current = true;
      awaitingSessionId.current = null;
      setSessions([]);
      setSelectedNativeSessionId(null);
      setTerminal(null);
    }
    const requestSequence = ++refreshSequence.current;
    const response = await fetch(`/api/projects/${projectId}/harness?workspaceId=${workspaceId}`, { cache: "no-store" });
    if (!response.ok) throw new Error("native-harness-refresh-failed");
    const body = await response.json() as { definitions?: Definition[]; sessions?: NativeSession[] };
    if (requestSequence !== refreshSequence.current || scope.current.projectId !== projectId || scope.current.workspaceId !== workspaceId) {
      if (selection !== undefined) throw new Error("native-harness-refresh-superseded");
      return;
    }
    if (Array.isArray(body.definitions) && body.definitions.length > 0) setDefinitions(body.definitions);
    const nextSessions = Array.isArray(body.sessions) ? body.sessions : [];
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
    let selectedId = selectedNativeSessionIdRef.current;
    if (selection !== undefined) {
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
    if (current?.terminalSessionId) {
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
    }
    if (selection?.exactSessionId != null && current === null) {
      throw new Error("native-harness-session-not-projected");
    }
  }, [projectId, workspaceId]);

  useEffect(() => {
    if (active) refresh().catch(() => undefined);
  }, [active, refresh]);

  const onRefresh = useCallback(() => {
    refresh().catch(() => undefined);
  }, [refresh]);
  const retryRefresh = () => {
    setRefreshFailed(false);
    setMessage(null);
    const expected = awaitingSessionId.current;
    refresh(expected === null ? undefined : { exactSessionId: expected }).catch(() => {
      setRefreshFailed(true);
      setMessage("The native session list could not be refreshed. Retry to attach.");
    });
  };
  const onTerminalStateChange = useCallback((id: string, state: string) => {
    setTerminal((current) => current?.id === id ? { ...current, state } : current);
  }, []);

  const post = async (body: Record<string, unknown>) => {
    const isCreate = body.action === "create-native";
    setPendingAction(isCreate ? "create-native" : "resume");
    setRefreshFailed(false);
    setMessage(null);
    let admitted = false;
    try {
      const response = await fetch(`/api/projects/${projectId}/harness`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-devspace-csrf": "1" },
        body: JSON.stringify(body)
      });
      const payload = await response.json() as { message?: string; sessionId?: string };
      if (!response.ok) {
        setRefreshFailed(true);
        setMessage(payload.message ?? "The harness action failed. Refresh before retrying.");
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
      await refresh(isCreate ? { exactSessionId: awaitingSessionId.current } : undefined);
    } catch {
      setRefreshFailed(true);
      setMessage(admitted
        ? "The session started, but its list could not be refreshed. Retry to attach."
        : "The harness request could not be confirmed. Refresh the session list before trying again.");
    } finally {
      setPendingAction(null);
    }
  };

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
  const presentation = pending || awaitingProjection || refreshFailed
    ? { action: "none" as const, showProviderChooser: false,
        status: pending ? (pendingAction === "resume" ? "Resuming…" : "Starting…")
          : awaitingProjection ? "Waiting for session" : "Refresh required" }
    : nativeAiPresentation(session);
  const selected = definitions.find((definition) => definition.id === (session?.harnessId ?? harnessId)) ?? definitions[0];
  const displayName = selected?.displayName ?? "Codex";

  return <section className="native-ai-surface" aria-label="Native harness" hidden={!active}>
    <header className="native-ai-header">
      {(sessions.length > 1 || (sessions.length > 0 && selectedNativeSessionId === null)) && <label className="native-ai-session">
        <span className="visually-hidden">Native session</span>
        <select
          aria-label="Native session"
          value={selectedNativeSessionId ?? ""}
          onChange={(event) => selectNativeSession(event.target.value === "" ? null : event.target.value)}
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
      {presentation.status !== null && <span className={`native-ai-state${presentation.status === "Running" ? " is-running" : ""}`}>{presentation.status}</span>}
      <span className="native-ai-spacer" />
      {presentation.action === "start" && <button type="button" disabled={pending} onClick={startHarness}>Start</button>}
      {presentation.action === "resume" && session !== null && <button type="button" disabled={pending || session.resume !== true} onClick={resumeSelectedHarness}>Resume</button>}
      {message !== null && <span className="native-ai-message" role="status">{message}</span>}
      {refreshFailed && <button type="button" disabled={pending} onClick={retryRefresh}>Retry refresh</button>}
    </header>
    <div className="native-ai-terminal">
      {pending
        ? <p className="native-ai-empty" role="status">{pendingAction === "resume" ? "Resuming native session…" : "Starting native session…"}</p>
        : awaitingProjection
          ? <p className="native-ai-empty" role="status">Waiting for the new session. Retry refresh if needed.</p>
          : terminal !== null
            ? <TerminalTab projectId={projectId} workspaceId={workspaceId} terminal={terminal} active={active} onRefresh={onRefresh} onTerminalStateChange={onTerminalStateChange} />
            : <p className="native-ai-empty">Start a harness to open its terminal.</p>}
    </div>
  </section>;
}
