"use client";

import { nativeCodexHistoryPageSchema, type NativeCodexHistoryMessage } from "@devspace/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

export function NativeCodexHistoryView({ projectId, workspaceId, sessionId, visible }: {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly visible: boolean;
}) {
  const [messages, setMessages] = useState<NativeCodexHistoryMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [olderHistoryTruncated, setOlderHistoryTruncated] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [snapshot, setSnapshot] = useState<"live" | "settled" | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const pendingRequest = useRef<{ readonly key: string; readonly sequence: number } | null>(null);

  const load = useCallback(async (cursor: string | null, prepend: boolean) => {
    const key = `${prepend ? "older" : "newest"}:${cursor ?? ""}`;
    if (pendingRequest.current?.key === key) return;
    const sequence = ++requestSequence.current;
    pendingRequest.current = { key, sequence };
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({ workspaceId });
    if (cursor !== null) query.set("cursor", cursor);
    try {
      const response = await fetch(`/api/projects/${projectId}/harness/${sessionId}/history?${query.toString()}`, {
        cache: "no-store", headers: { accept: "application/json" }
      });
      if (!response.ok) throw new Error("history-read-failed");
      const page = nativeCodexHistoryPageSchema.parse(await response.json());
      if (sequence !== requestSequence.current) return;
      setMessages((current) => {
        if (!prepend) return page.messages;
        const existing = new Set(current.map((message) => message.id));
        return [...page.messages.filter((message) => !existing.has(message.id)), ...current];
      });
      setOlderCursor(page.olderCursor);
      setOlderHistoryTruncated(page.olderHistoryTruncated);
      setAvailable(page.available);
      setSnapshot(page.snapshot);
    } catch {
      if (sequence === requestSequence.current) setError("Codex conversation history could not be read safely. Refresh to try again.");
    } finally {
      if (pendingRequest.current?.sequence === sequence) pendingRequest.current = null;
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [projectId, sessionId, workspaceId]);

  useEffect(() => {
    if (visible) void load(null, false).catch(() => undefined);
    return () => {
      requestSequence.current += 1;
      pendingRequest.current = null;
    };
  }, [load, visible]);

  const formatTime = (value: string | null): string => {
    if (value === null) return "";
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? "" : date.toLocaleString();
  };

  return <section className="native-history-panel" aria-label="Codex conversation history" hidden={!visible}>
    <header className="native-history-header">
      <div>
        <h2>Conversation history</h2>
        <p>Read-only Codex messages. Tool results, analysis, and status events are omitted.</p>
      </div>
      <div className="native-history-actions">
        <span>{snapshot === "live" ? "Live snapshot" : snapshot === "settled" ? "Saved conversation" : ""}</span>
        <button type="button" onClick={() => void load(null, false)} disabled={loading}>Refresh history</button>
      </div>
    </header>
    {error !== null && <p className="native-history-status" role="alert">{error}</p>}
    {loading && messages.length === 0 && <p className="native-history-status" role="status">Loading Codex conversation history…</p>}
    {!loading && error === null && messages.length === 0 && available === false
      && <p className="native-history-status" role="status">Codex has not written this conversation to its private home yet. Refresh history after a message completes.</p>}
    {!loading && error === null && messages.length === 0 && available === true
      && <p className="native-history-status" role="status">No complete exchanges are available in this snapshot.</p>}
    {olderHistoryTruncated && <p className="native-history-truncated" role="status">Earlier messages are outside the bounded history snapshot.</p>}
    {messages.length > 0 && <ol className="native-history-messages">
      {messages.map((message) => <li key={message.id} className={`native-history-message is-${message.role}`}>
        <header>
          <strong>{message.role === "user" ? "You" : "Codex"}</strong>
          {message.timestamp !== null && <time dateTime={message.timestamp}>{formatTime(message.timestamp)}</time>}
        </header>
        <pre>{message.text}</pre>
      </li>)}
    </ol>}
    {olderCursor !== null && <button className="native-history-older" type="button" disabled={loading}
      onClick={() => void load(olderCursor, true)}>{loading ? "Loading…" : "Load older messages"}</button>}
  </section>;
}
