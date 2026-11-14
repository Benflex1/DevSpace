"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nativeCodexHistoryPageSchema, type NativeCodexHistoryMessage } from "@devspace/contracts";

export type NativeCodexHistoryState = {
  readonly messages: readonly NativeCodexHistoryMessage[];
  readonly olderCursor: string | null;
  readonly olderHistoryTruncated: boolean;
  readonly available: boolean | null;
  readonly snapshot: "live" | "settled" | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly loadOlder: () => void;
  readonly refresh: () => void;
};

/**
 * Bounded, read-only provider history. The Agent owns Codex rollout extraction;
 * this hook only pages the authenticated Web route and never inspects terminal
 * bytes, so TUI redraws and escape sequences can never become conversation text.
 */
export function useNativeCodexHistory(input: {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sessionId: string | null;
  readonly displayName: string;
  readonly enabled: boolean;
}): NativeCodexHistoryState {
  const [messages, setMessages] = useState<readonly NativeCodexHistoryMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [olderHistoryTruncated, setOlderHistoryTruncated] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [snapshot, setSnapshot] = useState<"live" | "settled" | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const pendingRequest = useRef<{ readonly key: string; readonly sequence: number } | null>(null);

  const load = useCallback(async (cursor: string | null, prepend: boolean) => {
    const sessionId = input.sessionId;
    if (sessionId === null) return;
    const key = `${prepend ? "older" : "newest"}:${cursor ?? ""}`;
    if (pendingRequest.current?.key === key) return;
    const sequence = ++requestSequence.current;
    pendingRequest.current = { key, sequence };
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({ workspaceId: input.workspaceId });
    if (cursor !== null) query.set("cursor", cursor);
    try {
      const response = await fetch(
        `/api/projects/${input.projectId}/harness/${sessionId}/history?${query.toString()}`,
        { cache: "no-store", headers: { accept: "application/json" } }
      );
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
      if (sequence === requestSequence.current) {
        setError(`${input.displayName} conversation history could not be read safely. Refresh to try again.`);
      }
    } finally {
      if (pendingRequest.current?.sequence === sequence) pendingRequest.current = null;
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [input.displayName, input.projectId, input.sessionId, input.workspaceId]);

  useEffect(() => {
    requestSequence.current += 1;
    pendingRequest.current = null;
    setMessages([]);
    setOlderCursor(null);
    setOlderHistoryTruncated(false);
    setAvailable(null);
    setSnapshot(null);
    setError(null);
    setLoading(false);
    if (input.enabled && input.sessionId !== null) void load(null, false).catch(() => undefined);
    return () => {
      requestSequence.current += 1;
      pendingRequest.current = null;
    };
  }, [input.enabled, input.sessionId, load]);

  const loadOlder = useCallback(() => {
    if (olderCursor === null || loading) return;
    void load(olderCursor, true).catch(() => undefined);
  }, [load, loading, olderCursor]);
  const refresh = useCallback(() => {
    void load(null, false).catch(() => undefined);
  }, [load]);

  return useMemo(() => ({
    messages, olderCursor, olderHistoryTruncated, available, snapshot, loading, error, loadOlder, refresh
  }), [messages, olderCursor, olderHistoryTruncated, available, snapshot, loading, error, loadOlder, refresh]);
}

function formatTime(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleString();
}

export function NativeConversationHistory({ history, displayName }: {
  readonly history: NativeCodexHistoryState;
  readonly displayName: string;
}) {
  return <section className="native-conversation-history" aria-label={`${displayName} conversation history`}>
    <header className="native-conversation-history-header">
      <div>
        <h2>Earlier conversation</h2>
        <p>Readable saved messages. Terminal redraws, tool output, and status events are omitted.</p>
      </div>
      <div className="native-conversation-history-actions">
        <span>{history.snapshot === "live" ? "Live snapshot" : history.snapshot === "settled" ? "Saved conversation" : ""}</span>
        <button type="button" onClick={history.refresh} disabled={history.loading}>Refresh</button>
      </div>
    </header>
    {history.error !== null && <p className="native-conversation-status" role="alert">{history.error}</p>}
    {history.loading && history.messages.length === 0
      && <p className="native-conversation-status" role="status">Loading {displayName} conversation history…</p>}
    {!history.loading && history.error === null && history.messages.length === 0 && history.available === false
      && <p className="native-conversation-status" role="status">
        {displayName} has not written this conversation to its private home yet. Refresh after a message completes.
      </p>}
    {!history.loading && history.error === null && history.messages.length === 0 && history.available === true
      && <p className="native-conversation-status" role="status">No complete exchanges are available in this snapshot.</p>}
    {history.olderHistoryTruncated && <p className="native-conversation-truncated" role="status">
      Earlier messages are outside the bounded history snapshot.
    </p>}
    {history.olderCursor !== null && <button className="native-conversation-older" type="button" disabled={history.loading}
      onClick={history.loadOlder}>{history.loading ? "Loading…" : "Load older messages"}</button>}
    {history.messages.length > 0 && <ol className="native-conversation-messages">
      {history.messages.map((message) => <li key={message.id} className={`native-conversation-message is-${message.role}`}>
        <header>
          <strong>{message.role === "user" ? "You" : displayName}</strong>
          {message.timestamp !== null && <time dateTime={message.timestamp}>{formatTime(message.timestamp)}</time>}
        </header>
        <pre>{message.text}</pre>
      </li>)}
    </ol>}
  </section>;
}
