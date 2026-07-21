"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { runtimeControlState, type RuntimeControlAction } from "./runtime-control-state.js";

export function RuntimeControls({ projectId, runtimeState, runtimeAvailable, activeAction, canStart, canStop, retryStart, action: requestedAction }: {
  projectId: string; runtimeAvailable: boolean;
  runtimeState: string; activeAction: RuntimeControlAction | null; canStart: boolean; canStop: boolean; retryStart: boolean;
  action?: RuntimeControlAction;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const state = runtimeControlState({ runtimeState, runtimeAvailable, activeAction, canStart, canStop,
    ...(requestedAction === undefined ? {} : { requestedAction }) });
  const { action } = state;
  const mutate = async () => {
    setPending(true); setMessage(action === "start" ? "Starting runtime…" : "Stopping runtime…");
    try {
      const response = await fetch(`/api/projects/${projectId}/runtime`, {
        method: "POST", headers: { "content-type": "application/json", "x-devspace-csrf": "1" },
        body: JSON.stringify({ action })
      });
      const body = await response.json() as { message?: string };
      if (response.status === 202) { setMessage(body.message ?? "The runtime action is still in progress."); setPending(false); return; }
      if (!response.ok) throw new Error(body.message ?? "The runtime action failed.");
      setMessage(action === "start" ? "Runtime is running." : "Runtime is stopped.");
      setPending(false);
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "The runtime action failed."); setPending(false); }
  };
  return <div className="runtime-controls">
    {activeAction !== null && <button type="button" disabled title="Another runtime action is already in progress.">
      {activeAction === "start" ? "Starting…" : "Stopping…"}
    </button>}
    {activeAction === null && <button type="button" disabled={state.disabled || pending} title={state.reason ?? undefined}
      onClick={() => { mutate().catch(() => setPending(false)); }}>
      {pending ? (action === "start" ? "Starting…" : "Stopping…")
        : action === "start" ? (retryStart ? "Retry start" : "Start runtime") : "Stop runtime"}
    </button>}
    {!runtimeAvailable && <p className="message error">The dedicated rootless runtime is unavailable.</p>}
    {message !== "" && <p className={`message ${message.includes("running") || message.includes("stopped") ? "success" : ""}`} role="status">{message}</p>}
  </div>;
}
