/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/no-floating-promises */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Profile = { profileId: string; profileRevision: string; displayName: string; availability: { state: "available" | "unavailable"; code?: string }; capabilities: { interrupt: boolean } };
type FileSummary = { files: Array<{ path: string; change: string; oldPath: string | null }>; truncated: boolean };
type Turn = { id: string; state: string; content: { kind: "text"; text: string }; outputText: string; activities: string[]; changedFiles: FileSummary; createdAt: string };
type SessionData = { id: string; title: string; state: string; profileRevision: string; lastSequence: number };
type Event = { eventType: string; eventId: string; sequence: number; turnId: string | null; payload: Record<string, unknown> };

export function AiSessionTab({ projectId, workspaceId, active }: { projectId: string; workspaceId: string; active: boolean }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [session, setSession] = useState<SessionData | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [composer, setComposer] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const lastSequence = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const applyEvent = useCallback((event: Event) => {
    lastSequence.current = Math.max(lastSequence.current, event.sequence);
    if (event.eventType.startsWith("session.")) {
      if (event.eventType === "session.stopped") setSession((current) => current === null ? null : { ...current, state: "stopped" });
      else if (event.eventType === "session.lost") setSession((current) => current === null ? null : { ...current, state: "lost" });
      else if (event.eventType === "session.ready") setSession((current) => current === null ? null : { ...current, state: "active" });
      return;
    }
    if (event.turnId === null) return;
    setTurns((current) => {
      const index = current.findIndex((turn) => turn.id === event.turnId);
      const existing = index < 0 ? { id: event.turnId!, state: "accepted", content: { kind: "text" as const, text: "" }, outputText: "", activities: [], changedFiles: { files: [], truncated: false }, createdAt: new Date().toISOString() } : current[index]!;
      const next = { ...existing };
      if (event.eventType === "turn.accepted") next.content = event.payload.content as Turn["content"];
      if (event.eventType === "turn.started") next.state = "running";
      if (event.eventType === "turn.activity.started" || event.eventType === "turn.output.delta") next.state = "running";
      if (event.eventType === "turn.output.delta") next.outputText += String(event.payload.text ?? "");
      if (event.eventType === "turn.activity.started") next.activities = [...next.activities, String((event.payload.presentation as { summary?: unknown })?.summary ?? "Activity")];
      if (event.eventType === "turn.files.changed") next.changedFiles = event.payload as unknown as FileSummary;
      if (event.eventType === "turn.interrupted") next.state = "interrupted";
      if (event.eventType === "turn.quiesced") next.state = String(event.payload.outcome ?? "completed");
      if (event.eventType === "turn.failed") next.state = "failed";
      if (index < 0) return [...current, next];
      return current.map((turn, candidate) => candidate === index ? next : turn);
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/ai?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
      const body = await response.json() as { profile?: Profile; session?: { session: SessionData; turns: Array<Omit<Turn, "activities"> & { changedFiles: FileSummary }>; events: Event[] } | null; message?: string };
      if (!response.ok || body.profile === undefined) throw new Error(body.message ?? "Codex availability could not be inspected.");
      setProfile(body.profile);
      if (body.session !== null && body.session !== undefined) {
        setSession(body.session.session); lastSequence.current = body.session.session.lastSequence;
        setTurns(body.session.turns.map((turn) => ({ ...turn, activities: [] })));
        for (const event of body.session.events) applyEvent(event);
      } else { setSession(null); setTurns([]); lastSequence.current = 0; }
    } catch (error) { setMessage(error instanceof Error ? error.message : "AI session unavailable."); }
    finally { setLoading(false); }
  }, [applyEvent, projectId, workspaceId]);

  useEffect(() => { void load(); return () => abortRef.current?.abort(); }, [load]);

  useEffect(() => {
    if (!active || session === null || session.state === "stopped") return;
    const controller = new AbortController(); abortRef.current?.abort(); abortRef.current = controller; setReconnecting(false);
    const run = async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/ai/events?workspaceId=${encodeURIComponent(workspaceId)}&sessionId=${encodeURIComponent(session.id)}&afterSequence=${lastSequence.current}`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok || response.body === null) throw new Error("The AI event stream could not be opened.");
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
        while (!controller.signal.aborted) {
          const next = await reader.read(); if (next.done) break; buffer += decoder.decode(next.value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n"); if (!line) continue;
            const frame = JSON.parse(line) as Event | { frameType: string }; if (!("frameType" in frame)) applyEvent(frame);
          }
        }
      } catch (error) { if (!controller.signal.aborted) { setReconnecting(true); setMessage(error instanceof Error ? error.message : "The AI stream disconnected."); } }
    };
    void run(); return () => controller.abort();
  }, [active, applyEvent, projectId, session, workspaceId]);

  const post = async (body: Record<string, unknown>) => {
    const response = await fetch(`/api/projects/${projectId}/ai`, { method: "POST", headers: { "content-type": "application/json", "x-devspace-csrf": "1" }, body: JSON.stringify(body) });
    const result = await response.json() as { sessionId?: string; message?: string };
    if (!response.ok) throw new Error(result.message ?? "AI session action failed.");
    return result;
  };
  const create = async () => { try { await post({ action: "create", workspaceId }); await load(); setMessage(null); } catch (error) { setMessage(error instanceof Error ? error.message : "Session creation failed."); } };
  const send = async () => { const text = composer.trim(); if (!text || session === null) return; setComposer(""); try { await post({ action: "send", workspaceId, sessionId: session.id, content: { kind: "text", text } }); } catch (error) { setComposer(text); setMessage(error instanceof Error ? error.message : "Turn could not be sent."); } };
  const interrupt = async () => { const turn = turns.find((candidate) => candidate.state === "running"); if (turn === undefined || session === null) return; try { await post({ action: "interrupt", workspaceId, sessionId: session.id, turnId: turn.id }); } catch (error) { setMessage(error instanceof Error ? error.message : "Interrupt failed."); } };
  const stop = async () => { if (session === null) return; try { await post({ action: "stop", workspaceId, sessionId: session.id }); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : "Stop failed."); } };
  const restartWorkspace = async () => { try { await fetch(`/api/projects/${projectId}/runtime`, { method: "POST", headers: { "content-type": "application/json", "x-devspace-csrf": "1" }, body: JSON.stringify({ action: "start" }) }); await load(); } catch { setMessage("Workspace restart could not be requested."); } };

  if (loading && profile === null) return <div className="ai-tab-surface" role="status">Inspecting Codex availability…</div>;
  const unavailable = profile?.availability.state === "unavailable";
  const running = turns.some((turn) => turn.state === "running");
  return <section className="ai-tab-surface" aria-label="AI session">
    <header className="ai-tab-header"><div><strong>{session?.title ?? "AI session"}</strong><span className={`ai-status ${session?.state ?? (unavailable ? "unavailable" : "ready")}`}>{reconnecting ? "Reconnecting…" : session?.state ?? (unavailable ? "Unavailable" : "Ready")}</span></div>
      {session !== null && <div className="ai-tab-actions">{running && <button type="button" onClick={() => { void interrupt(); }} aria-label="Interrupt active turn">Interrupt</button>}<button type="button" onClick={() => { void stop(); }} aria-label="Stop AI session">Stop session</button></div>}</header>
    {message !== null && <p className="ai-message" role="status">{message}</p>}
    {session === null ? <div className="ai-empty"><div className="empty-glyph" aria-hidden="true">✦</div><h2>{unavailable ? "Codex unavailable" : "Start an AI session"}</h2><p>{unavailable ? `Codex is not available for this workspace (${profile?.availability.code ?? "unknown"}).` : "Ask Codex to inspect, explain, or change files in this workspace."}</p>{!unavailable && <button type="button" onClick={() => { void create(); }}>Create session</button>}</div> : <>
      <div className="ai-timeline" aria-live="polite">{turns.length === 0 && <p className="ai-empty-copy">Your conversation will appear here.</p>}{turns.map((turn) => <article className="ai-turn" key={turn.id}><div className="ai-turn-label">You <span>{turn.state}</span></div><p className="ai-user-text">{turn.content.text}</p>{turn.activities.length > 0 && <div className="ai-activities">{turn.activities.map((activity, index) => <span key={`${turn.id}-activity-${index}`}>{activity}</span>)}</div>}<div className="ai-assistant"><div className="ai-turn-label">Codex</div><p>{turn.outputText || (turn.state === "running" ? "Working…" : "")}</p></div>{turn.changedFiles.files.length > 0 && <div className="ai-files"><strong>Changed files</strong><ul>{turn.changedFiles.files.map((file) => <li key={`${file.change}:${file.path}`}>{file.change} <code>{file.path}</code>{file.oldPath !== null && <> from <code>{file.oldPath}</code></>}</li>)}</ul>{turn.changedFiles.truncated && <small>Additional files omitted.</small>}</div>}</article>)}</div>
      <form className="ai-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}><textarea value={composer} onChange={(event) => setComposer(event.target.value)} placeholder="Ask Codex…" aria-label="AI prompt" rows={3} disabled={running || session.state === "lost"} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} /><div><small>Ctrl/Cmd + Enter to send</small><button type="submit" disabled={running || composer.trim().length === 0 || session.state === "lost"}>Send</button></div></form>
      {session.state === "lost" && <div className="ai-degraded" role="alert"><strong>Live provider session lost.</strong><span>Committed history is preserved. Restart the workspace before creating a new live attachment.</span><button type="button" onClick={() => { void restartWorkspace(); }}>Restart workspace</button></div>}
    </>}
  </section>;
}
