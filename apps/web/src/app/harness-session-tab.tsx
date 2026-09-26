"use client";

import { useCallback, useEffect, useState } from "react";
import { nativeAiPresentation } from "./native-ai-presentation.js";
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

export function HarnessSessionTab({ projectId, workspaceId, active }: {
  projectId: string;
  workspaceId: string;
  active: boolean;
}) {
  const [definitions, setDefinitions] = useState<Definition[]>([{ id: "codex", displayName: "Codex", origin: "builtin" }]);
  const [harnessId, setHarnessId] = useState("codex");
  const [session, setSession] = useState<NativeSession | null>(null);
  const [terminal, setTerminal] = useState<TerminalView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/harness?workspaceId=${workspaceId}`, { cache: "no-store" });
    if (!response.ok) return;
    const body = await response.json() as { definitions?: Definition[]; sessions?: NativeSession[] };
    if (Array.isArray(body.definitions) && body.definitions.length > 0) setDefinitions(body.definitions);
    const current = body.sessions?.find((item) => item.state === "active" || item.state === "creating")
      ?? body.sessions?.find((item) => item.resume === true)
      ?? body.sessions?.[0]
      ?? null;
    setSession(current);
    if (current?.terminalSessionId) {
      setTerminal((existing) => {
        const nextState = current.state === "active" || current.state === "creating" ? "active"
          : current.state === "lost" ? "lost" : "disconnected";
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
    }
  }, [projectId, workspaceId]);

  useEffect(() => {
    if (active) refresh().catch(() => undefined);
  }, [active, refresh]);

  const onRefresh = useCallback(() => {
    refresh().catch(() => undefined);
  }, [refresh]);
  const onTerminalStateChange = useCallback((id: string, state: string) => {
    setTerminal((current) => current?.id === id ? { ...current, state } : current);
  }, []);

  const post = async (body: Record<string, unknown>) => {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/harness`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-devspace-csrf": "1" },
        body: JSON.stringify(body)
      });
      const payload = await response.json() as { message?: string };
      if (!response.ok) {
        setMessage(payload.message ?? "The harness action failed.");
        return;
      }
      await refresh();
    } finally {
      setPending(false);
    }
  };

  const presentation = nativeAiPresentation(session);
  const selected = definitions.find((definition) => definition.id === (session?.harnessId ?? harnessId)) ?? definitions[0];
  const displayName = selected?.displayName ?? "Codex";

  return <section className="native-ai-surface" aria-label="Native harness" hidden={!active}>
    <header className="native-ai-header">
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
      {presentation.action === "start" && <button type="button" disabled={pending} onClick={() => { post({ action: "create-native", workspaceId, harnessId }).catch(() => undefined); }}>Start</button>}
      {presentation.action === "resume" && session !== null && <button type="button" disabled={pending} onClick={() => { post({ action: "resume", workspaceId, sessionId: session.id }).catch(() => undefined); }}>Resume</button>}
      {message !== null && <span className="native-ai-message" role="status">{message}</span>}
    </header>
    <div className="native-ai-terminal">
      {terminal !== null
        ? <TerminalTab projectId={projectId} workspaceId={workspaceId} terminal={terminal} active={active} onRefresh={onRefresh} onTerminalStateChange={onTerminalStateChange} />
        : <p className="native-ai-empty">Start a harness to open its terminal.</p>}
    </div>
  </section>;
}
