"use client";

import { useCallback, useEffect, useState } from "react";
import { harnessResumeControlEnabled } from "./harness-resume.js";
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
  const [resumeEnabled, setResumeEnabled] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/harness?workspaceId=${workspaceId}`, { cache: "no-store" });
    if (!response.ok) return;
    const body = await response.json() as { definitions?: Definition[]; sessions?: NativeSession[] };
    if (Array.isArray(body.definitions) && body.definitions.length > 0) setDefinitions(body.definitions);
    const current = body.sessions?.find((item) => item.state === "active") ?? body.sessions?.[0] ?? null;
    setSession(current ?? null);
    if (current?.terminalSessionId) {
      setTerminal({
        id: current.terminalSessionId,
        processId: current.processId ?? current.terminalSessionId,
        title: current.title,
        state: current.state === "active" ? "active" : current.state === "lost" ? "lost" : "disconnected"
      });
    }
    setResumeEnabled(harnessResumeControlEnabled(current));
  }, [projectId, workspaceId]);

  useEffect(() => {
    if (active) refresh().catch(() => undefined);
  }, [active, refresh]);

  const post = async (body: Record<string, unknown>) => {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/harness`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json() as { message?: string; terminalId?: string; sessionId?: string; executableSource?: { kind?: string; reportedVersion?: string | null } };
      if (!response.ok) {
        setMessage(payload.message ?? "The harness action failed.");
        return;
      }
      if (payload.executableSource?.kind) {
        setSource(`${payload.executableSource.kind}${payload.executableSource.reportedVersion ? ` ${payload.executableSource.reportedVersion}` : ""}`);
      }
      await refresh();
    } finally {
      setPending(false);
    }
  };

  return <div hidden={!active} className="ai-session-tab">
    <header className="ai-session-header">
      <label>
        Harness
        <select value={harnessId} onChange={(event) => setHarnessId(event.target.value)} disabled={pending}>
          {definitions.map((definition) => <option key={definition.id} value={definition.id}>{definition.displayName}</option>)}
        </select>
      </label>
      <button type="button" disabled={pending} onClick={() => void post({ action: "create-native", workspaceId, harnessId })}>Start</button>
      <button type="button" disabled={pending || !resumeEnabled || session === null} onClick={() => session && void post({ action: "resume", workspaceId, sessionId: session.id })}>Resume</button>
      {source !== null && <span>Source: {source}</span>}
    </header>
    {message !== null && <p role="status">{message}</p>}
    {terminal !== null
      ? <TerminalTab projectId={projectId} workspaceId={workspaceId} terminal={terminal} active={active} onRefresh={() => { refresh().catch(() => undefined); }} onTerminalStateChange={(id, state) => setTerminal((current) => current?.id === id ? { ...current, state } : current)} />
      : <p>Start a native harness to attach its terminal.</p>}
    <p>Legacy structured Codex sessions remain available in the Codex session tab.</p>
  </div>;
}
