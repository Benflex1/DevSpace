/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/no-floating-promises */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appendAiTurnOutput, boundAiSessionTurns, type BrowserAiTurn } from "./ai-session-projection.js";
import { consumeAiEventStream, type BrowserAiEvent } from "./ai-session-stream.js";
import { AiHistoryTruncationNotice, AiOutputTruncationNotice } from "./ai-session-notices.js";
import { replayAiEvents } from "./ai-session-replay.js";
import {
  createAiSessionInitialRetryCoordinator,
  type AiSessionInitialRetrySelection
} from "./ai-session-initial-retry.js";
import { createAiSessionLoadCoordinator } from "./ai-session-load.js";
import { aiSessionMutationControls, createAiSessionRestartCoordinator } from "./ai-session-restart.js";
import { createAiSessionSendReconciliation } from "./ai-session-send-reconciliation.js";
import { createAiSessionStopCoordinator } from "./ai-session-stop.js";

type Profile = { profileId: string; profileRevision: string; displayName: string; availability: { state: "available" | "unavailable"; code?: string }; capabilities: { interrupt: boolean } };
type FileSummary = BrowserAiTurn["changedFiles"];
type Turn = BrowserAiTurn;
type SessionData = { id: string; title: string; state: string; profileRevision: string; lastSequence: number; historyStartSequence: number; historyTruncated: boolean };
type SessionSummary = Pick<SessionData, "id" | "title" | "state" | "lastSequence" | "historyStartSequence" | "historyTruncated"> & { workspaceId: string; createdAt: string; updatedAt: string };
type Event = BrowserAiEvent;
type AiPostError = Error & { turnId: string | undefined; outcome: string | undefined };

export function AiSessionTab({ projectId, workspaceId, active }: { projectId: string; workspaceId: string; active: boolean }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [session, setSession] = useState<SessionData | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [composer, setComposer] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [restartPending, setRestartPending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [initialRetryPending, setInitialRetryPending] = useState(false);
  const [sendReconciliationPending, setSendReconciliationPending] = useState(false);
  const [streamRevision, setStreamRevision] = useState(0);
  const lastSequence = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const selectedSessionId = useRef<string | null>(null);
  const terminal = useRef(false);
  const selectionGeneration = useRef(0);
  const selectedSessionState = useRef<string | null>(null);
  const lastEventId = useRef<string | null>(null);
  const canonicalTurnIds = useRef<Set<string>>(new Set());
  const sendReconciliation = useRef<ReturnType<typeof createAiSessionSendReconciliation> | null>(null);
  const initialRetryCoordinatorRef = useRef<ReturnType<typeof createAiSessionInitialRetryCoordinator> | null>(null);
  sendReconciliation.current ??= createAiSessionSendReconciliation({
    restoreDraft: setComposer,
    setPending: setSendReconciliationPending,
    setMessage
  });

  const applyEvent = useCallback((event: Event): boolean => {
    if (selectedSessionId.current !== event.sessionId) return false;
    if (event.eventType.startsWith("session.")) {
      if (event.eventType === "session.started") { terminal.current = false; selectedSessionState.current = "creating"; setSession((current) => current === null ? null : { ...current, state: "creating", lastSequence: event.sequence }); }
      else if (event.eventType === "session.stopped") { terminal.current = true; selectedSessionState.current = "stopped"; setSession((current) => current === null ? null : { ...current, state: "stopped", lastSequence: event.sequence }); }
      else if (event.eventType === "session.lost") { terminal.current = true; selectedSessionState.current = "lost"; setSession((current) => current === null ? null : { ...current, state: "lost", lastSequence: event.sequence }); }
      else if (event.eventType === "session.ready") { selectedSessionState.current = "active"; setSession((current) => current === null ? null : { ...current, state: "active", lastSequence: event.sequence }); }
      if (event.eventType === "session.stopped" || event.eventType === "session.lost") {
        sendReconciliation.current?.observe({
          sessionId: event.sessionId,
          selectionGeneration: selectionGeneration.current,
          state: event.eventType === "session.stopped" ? "stopped" : "lost",
          canonicalTurnIds: canonicalTurnIds.current
        });
      }
      return true;
    }
    if (event.turnId === null) return true;
    const turnId = event.turnId;
    if (event.eventType === "turn.accepted") canonicalTurnIds.current.add(turnId);
    if (event.eventType === "turn.accepted") {
      sendReconciliation.current?.observe({
        sessionId: event.sessionId,
        selectionGeneration: selectionGeneration.current,
        state: "active",
        canonicalTurnIds: canonicalTurnIds.current
      });
    }
    setTurns((current) => {
      const index = current.findIndex((turn) => turn.id === turnId);
      const existing = index < 0 ? { id: turnId, state: "accepted", content: { kind: "text" as const, text: "" }, outputText: "", outputTruncated: false, activities: [], changedFiles: { files: [], truncated: false }, createdAt: new Date().toISOString() } : current[index]!;
      const next = { ...existing };
      if (event.eventType === "turn.accepted") next.content = event.payload.content as Turn["content"];
      if (event.eventType === "turn.started") next.state = "running";
      if (event.eventType === "turn.activity.started" || event.eventType === "turn.output.delta") next.state = "running";
      if (event.eventType === "turn.activity.started") next.activities = [...next.activities, String((event.payload.presentation as { summary?: unknown })?.summary ?? "Activity")];
      if (event.eventType === "turn.files.changed") next.changedFiles = event.payload as unknown as FileSummary;
      if (event.eventType === "turn.interrupted") next.state = "interrupted";
      if (event.eventType === "turn.quiesced") next.state = String(event.payload.outcome ?? "completed");
      if (event.eventType === "turn.failed") next.state = "failed";
      let updated = index < 0 ? [...current, next] : current.map((turn, candidate) => candidate === index ? next : turn);
      if (event.eventType === "turn.output.delta") updated = appendAiTurnOutput(updated, turnId, String(event.payload.text ?? ""));
      return boundAiSessionTurns(updated);
    });
    return true;
  }, []);

  const loadCoordinator = useMemo(() => createAiSessionLoadCoordinator({
    run: async (requestedSessionId: string | undefined, signal: AbortSignal, isCurrent: () => boolean) => {
      const ensureCurrent = () => {
        if (signal.aborted || !isCurrent()) throw new DOMException("The AI session load was superseded.", "AbortError");
      };
      const query = new URLSearchParams({ workspaceId });
      if (requestedSessionId !== undefined) query.set("sessionId", requestedSessionId);
      const response = await fetch(`/api/projects/${projectId}/ai?${query.toString()}`, { cache: "no-store", signal });
      ensureCurrent();
      const body = await response.json() as {
        profile?: Profile;
        sessions?: SessionSummary[];
        session?: { session: SessionData; turns: Array<Omit<Turn, "activities"> & { changedFiles: FileSummary }>; events: Event[]; interactions?: unknown[] } | null;
        message?: string;
      };
      ensureCurrent();
      if (!response.ok || body.profile === undefined) throw new Error(body.message ?? "Codex availability could not be inspected.");
      let selected = body.session;
      const selectedId = requestedSessionId ?? body.sessions?.[0]?.id;
      if (selected === null && selectedId !== undefined) {
        const exactQuery = new URLSearchParams({ workspaceId, sessionId: selectedId });
        const exactResponse = await fetch(`/api/projects/${projectId}/ai?${exactQuery.toString()}`, { cache: "no-store", signal });
        ensureCurrent();
        const exactBody = await exactResponse.json() as typeof body;
        ensureCurrent();
        if (!exactResponse.ok || exactBody.session === null || exactBody.session === undefined) {
          throw new Error(exactBody.message ?? "The selected AI session could not be loaded.");
        }
        selected = exactBody.session;
      }
      ensureCurrent();
      return { profile: body.profile, selected };
    },
    apply: ({ profile: nextProfile, selected }) => {
      setProfile(nextProfile);
      setMessage(null);
      if (selected !== null && selected !== undefined) {
        selectedSessionId.current = selected.session.id;
        selectedSessionState.current = selected.session.state;
        terminal.current = selected.session.state === "stopped" || selected.session.state === "lost";
        setSession(selected.session); lastSequence.current = selected.session.lastSequence;
        const lastEvent = selected.events.at(-1);
        lastEventId.current = lastEvent?.sequence === selected.session.lastSequence ? lastEvent.eventId : null;
        canonicalTurnIds.current = new Set(selected.turns.map((turn) => turn.id));
        setTurns(replayAiEvents(selected.turns.map((turn) => ({ ...turn, activities: [] })), selected.events));
        sendReconciliation.current?.observe({
          sessionId: selected.session.id,
          selectionGeneration: selectionGeneration.current,
          state: selected.session.state,
          canonicalTurnIds: canonicalTurnIds.current
        });
      } else {
        selectedSessionId.current = null; selectedSessionState.current = null; terminal.current = false; setSession(null); setTurns([]); lastSequence.current = 0; lastEventId.current = null;
        canonicalTurnIds.current = new Set();
      }
    },
    setLoading,
    setMessage,
    setController: (controller) => { loadAbortRef.current = controller; }
  }), [projectId, workspaceId]);

  const cancelWork = useCallback(() => {
    selectionGeneration.current += 1;
    initialRetryCoordinatorRef.current?.invalidate();
    streamAbortRef.current?.abort();
    loadCoordinator.cancel();
    loadAbortRef.current?.abort();
  }, [loadCoordinator]);

  const load = useCallback((requestedSessionId?: string) => {
    cancelWork();
    return loadCoordinator.load(requestedSessionId);
  }, [cancelWork, loadCoordinator]);

  useEffect(() => {
    void load();
    return () => { cancelWork(); };
  }, [cancelWork, load]);

  useEffect(() => {
    if (!active || session === null || session.state === "stopped" || session.state === "lost") return;
    const controller = new AbortController(); streamAbortRef.current?.abort(); streamAbortRef.current = controller; setReconnecting(false);
    const sessionId = session.id;
    const generation = selectionGeneration.current;
    const run = async () => {
      try {
        await consumeAiEventStream({
          initialSequence: lastSequence.current,
          initialEventId: lastEventId.current,
          sessionId,
          signal: controller.signal,
          open: (afterSequence, signal) => fetch(`/api/projects/${projectId}/ai/events?workspaceId=${encodeURIComponent(workspaceId)}&sessionId=${encodeURIComponent(sessionId)}&afterSequence=${afterSequence}`, { signal, cache: "no-store" }),
          apply: (event) => {
            if (generation !== selectionGeneration.current || selectedSessionId.current !== sessionId) { controller.abort(); return; }
            if (!applyEvent(event)) { controller.abort(); return false; }
            lastSequence.current = event.sequence; lastEventId.current = event.eventId;
            return true;
          },
          isTerminal: () => terminal.current || generation !== selectionGeneration.current || selectedSessionId.current !== sessionId
        });
      } catch (error) { if (!controller.signal.aborted) { setReconnecting(true); setMessage(error instanceof Error ? error.message : "The AI stream disconnected."); } }
    };
    void run(); return () => { controller.abort(); if (streamAbortRef.current === controller) streamAbortRef.current = null; };
  }, [active, applyEvent, projectId, session?.id, session?.state, streamRevision, workspaceId]);

  const post = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch(`/api/projects/${projectId}/ai`, { method: "POST", headers: { "content-type": "application/json", "x-devspace-csrf": "1" }, body: JSON.stringify(body) });
    const result = await response.json() as { sessionId?: string; turnId?: string; outcome?: string; message?: string };
    if (!response.ok) {
      const error = new Error(result.message ?? "AI session action failed.") as AiPostError;
      error.turnId = result.turnId;
      error.outcome = result.outcome;
      throw error;
    }
    return result;
  }, [projectId]);
  const stopCoordinator = useMemo(() => createAiSessionStopCoordinator({
    workspaceId,
    post: async (body) => { await post(body); },
    isStreamUnavailable: () => reconnecting,
    reconcile: () => { setStreamRevision((current) => current + 1); },
    setPending: setStopPending,
    setMessage
  }), [post, reconnecting, workspaceId]);
  const initialRetryCoordinator = useMemo(() => createAiSessionInitialRetryCoordinator({
    workspaceId,
    getSelection: () => selectedSessionId.current === null || selectedSessionState.current === null ? null : {
      sessionId: selectedSessionId.current,
      selectionGeneration: selectionGeneration.current,
      state: selectedSessionState.current,
      lastSequence: lastSequence.current
    },
    post,
    load: async (sessionId) => { await loadCoordinator.load(sessionId); },
    setPending: setInitialRetryPending,
    setMessage
  }), [loadCoordinator, post, workspaceId]);
  initialRetryCoordinatorRef.current = initialRetryCoordinator;
  const restartCoordinator = useMemo(() => createAiSessionRestartCoordinator({
    workspaceId,
    post,
    cancel: cancelWork,
    load: async (sessionId) => { await load(sessionId); },
    setPending: setRestartPending,
    setMessage
  }), [cancelWork, load, post, workspaceId]);
  const create = async () => {
    try {
      const result = await post({ action: "create", workspaceId });
      await load(result.sessionId);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Session creation failed.");
    }
  };
  const retryInitialStart = async () => {
    if (session === null) return;
    const selected: AiSessionInitialRetrySelection = {
      sessionId: session.id,
      selectionGeneration: selectionGeneration.current,
      state: session.state,
      lastSequence: session.lastSequence
    };
    if (await initialRetryCoordinator.retry(selected)) setMessage(null);
  };
  const send = async () => {
    const text = composer.trim();
    if (!text || session === null) return;
    const sentSessionId = session.id;
    const sentGeneration = selectionGeneration.current;
    setComposer("");
    try {
      await post({ action: "send", workspaceId, sessionId: sentSessionId, content: { kind: "text", text } });
    } catch (error) {
      const ambiguous = error as AiPostError;
      if (ambiguous.outcome === "ambiguous" && typeof ambiguous.turnId === "string"
        && sentGeneration === selectionGeneration.current && selectedSessionId.current === sentSessionId) {
        if (sendReconciliation.current?.begin({
          sessionId: sentSessionId,
          selectionGeneration: sentGeneration,
          turnId: ambiguous.turnId,
          draft: text
        }) === true) {
          streamAbortRef.current?.abort();
          await loadCoordinator.load(sentSessionId);
          if (sentGeneration === selectionGeneration.current && selectedSessionId.current === sentSessionId) {
            setStreamRevision((current) => current + 1);
          }
        }
      } else if (sentGeneration === selectionGeneration.current && selectedSessionId.current === sentSessionId) {
        setComposer(text);
      }
      if (ambiguous.outcome !== "ambiguous" && selectedSessionId.current === sentSessionId) {
        setMessage(error instanceof Error ? error.message : "Turn could not be sent.");
      }
    }
  };
  const interrupt = async () => { const turn = turns.find((candidate) => candidate.state === "running"); if (turn === undefined || session === null) return; try { await post({ action: "interrupt", workspaceId, sessionId: session.id, turnId: turn.id }); } catch (error) { setMessage(error instanceof Error ? error.message : "Interrupt failed."); } };
  const stop = async () => { if (session === null) return; await stopCoordinator.stop(session.id); };
  const restart = async () => {
    if (session === null) return;
    if (await restartCoordinator.restart(session.id)) setMessage(null);
  };
  const restartWorkspace = async () => { cancelWork(); try { await fetch(`/api/projects/${projectId}/runtime`, { method: "POST", headers: { "content-type": "application/json", "x-devspace-csrf": "1" }, body: JSON.stringify({ action: "start" }) }); await load(); } catch { setMessage("Workspace restart could not be requested."); } };

  if (loading && profile === null) return <div className="ai-tab-surface" role="status">Inspecting Codex availability…</div>;
  const unavailable = profile?.availability.state === "unavailable";
  const running = turns.some((turn) => turn.state === "running");
  const controls = session === null ? null : aiSessionMutationControls(
    session.state,
    running,
    restartPending,
    session.lastSequence,
    initialRetryPending
  );
  return <section className="ai-tab-surface" aria-label="AI session">
    <header className="ai-tab-header"><div><strong>{session?.title ?? "AI session"}</strong><span className={`ai-status ${session?.state ?? (unavailable ? "unavailable" : "ready")}`}>{reconnecting ? "Reconnecting…" : session?.state ?? (unavailable ? "Unavailable" : "Ready")}</span></div>
      {session !== null && controls !== null && <div className="ai-tab-actions">{controls.showInterrupt && <button type="button" onClick={() => { void interrupt(); }} aria-label="Interrupt active turn">Interrupt</button>}{controls.showStop && <button type="button" disabled={stopPending} onClick={() => { void stop(); }} aria-label="Stop AI session">Stop session</button>}</div>}</header>
    {message !== null && <p className="ai-message" role="status">{message}</p>}
    {session === null ? <div className="ai-empty"><div className="empty-glyph" aria-hidden="true">✦</div><h2>{unavailable ? "Codex unavailable" : "Start an AI session"}</h2><p>{unavailable ? `Codex is not available for this workspace (${profile?.availability.code ?? "unknown"}).` : "Ask Codex to inspect, explain, or change files in this workspace."}</p>{!unavailable && <button type="button" onClick={() => { void create(); }}>Create session</button>}</div> : <>
      {session.historyTruncated && <AiHistoryTruncationNotice historyStartSequence={session.historyStartSequence} />}
      {controls?.showInitialRetry && <div className="ai-degraded" role="status"><strong>Codex did not finish starting.</strong><span>Retry startup for this exact session.</span><button type="button" disabled={controls.initialRetryDisabled} onClick={() => { void retryInitialStart(); }}>Retry starting Codex</button></div>}
      <div className="ai-timeline" aria-live="polite">{turns.length === 0 && <p className="ai-empty-copy">Your conversation will appear here.</p>}{turns.map((turn) => <article className="ai-turn" key={turn.id}><div className="ai-turn-label">You <span>{turn.state}</span></div><p className="ai-user-text">{turn.content.text}</p>{turn.activities.length > 0 && <div className="ai-activities">{turn.activities.map((activity, index) => <span key={`${turn.id}-activity-${index}`}>{activity}</span>)}</div>}<div className="ai-assistant"><div className="ai-turn-label">Codex</div><p>{turn.outputText || (turn.state === "running" ? "Working…" : "")}</p>{turn.outputTruncated && <AiOutputTruncationNotice />}</div>{turn.changedFiles.files.length > 0 && <div className="ai-files"><strong>Changed files</strong><ul>{turn.changedFiles.files.map((file) => <li key={`${file.change}:${file.path}`}>{file.change} <code>{file.path}</code>{file.oldPath !== null && <> from <code>{file.oldPath}</code></>}</li>)}</ul>{turn.changedFiles.truncated && <small>Additional files omitted.</small>}</div>}</article>)}</div>
      {controls?.showComposer && <form className="ai-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}><textarea value={composer} onChange={(event) => setComposer(event.target.value)} placeholder="Ask Codex…" aria-label="AI prompt" rows={3} disabled={running || sendReconciliationPending} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} /><div><small>Ctrl/Cmd + Enter to send</small><button type="submit" disabled={running || sendReconciliationPending || composer.trim().length === 0}>Send</button></div></form>}
      {controls?.showRestart && <div className="ai-degraded" role="status"><strong>Codex session stopped.</strong><span>Committed history is preserved. Start a new provider process for this exact session.</span><button type="button" disabled={controls.restartDisabled} onClick={() => { void restart(); }}>Start Codex again</button></div>}
      {session.state === "lost" && <div className="ai-degraded" role="alert"><strong>Live provider session lost.</strong><span>Committed history is preserved. Restart the workspace before creating a new live attachment.</span><button type="button" onClick={() => { void restartWorkspace(); }}>Restart workspace</button></div>}
    </>}
  </section>;
}
