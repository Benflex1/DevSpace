"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function RuntimeControls({ projectId, runtimeAvailable, activeAction, canStart, canStop, retryStart, action: requestedAction }: {
  projectId: string; runtimeAvailable: boolean;
  activeAction: "start" | "stop" | null; canStart: boolean; canStop: boolean; retryStart: boolean;
  action?: "start" | "stop";
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const action = requestedAction ?? (canStop ? "stop" : "start");
  const actionable = activeAction === null && runtimeAvailable && (action === "stop" ? canStop : canStart);
  const mutate = async () => {
    setPending(true); setMessage(action === "start" ? "Starting environment…" : "Stopping environment…");
    try {
      const response = await fetch(`/api/projects/${projectId}/runtime`, {
        method: "POST", headers: { "content-type": "application/json", "x-devspace-csrf": "1" },
        body: JSON.stringify({ action })
      });
      const body = await response.json() as { message?: string };
      if (response.status === 202) { setMessage(body.message ?? "The runtime action is still in progress."); setPending(false); return; }
      if (!response.ok) throw new Error(body.message ?? "The runtime action failed.");
      setMessage(action === "start" ? "Environment is running." : "Environment is stopped.");
      setPending(false);
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "The runtime action failed."); setPending(false); }
  };
  return <div className="runtime-controls">
    {activeAction !== null && <button type="button" disabled>
      {activeAction === "start" ? "Starting…" : "Stopping…"}
    </button>}
    {actionable && <button type="button" disabled={pending} onClick={() => { mutate().catch(() => setPending(false)); }}>
      {pending ? (action === "start" ? "Starting…" : "Stopping…")
        : action === "start" ? (retryStart ? "Retry start" : "Start environment") : "Stop environment"}
    </button>}
    {!runtimeAvailable && <p className="message error">The dedicated rootless runtime is unavailable.</p>}
    {message !== "" && <p className={`message ${message.includes("running") || message.includes("stopped") ? "success" : ""}`} role="status">{message}</p>}
  </div>;
}
