"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { restartRuntime, type RuntimeRestartAuthorization } from "./runtime-restart.js";
import { runtimeControlState, runtimeRestartControlState, type RuntimeControlAction } from "./runtime-control-state.js";

export function RuntimeControls({ projectId, runtimeState, runtimeAvailable, activeAction, canStart, canStop, retryStart, action: requestedAction, stopLabel, restart = false, onSuccess }: {
  projectId: string; runtimeAvailable: boolean;
  runtimeState: string; activeAction: RuntimeControlAction | null; canStart: boolean; canStop: boolean; retryStart: boolean;
  action?: RuntimeControlAction;
  stopLabel?: string;
  restart?: boolean;
  onSuccess?: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [message, setMessage] = useState("");
  const isRestart = restart;
  const state = runtimeControlState({ runtimeState, runtimeAvailable, activeAction, canStart, canStop,
    ...(requestedAction === undefined ? {} : { requestedAction }) });
  const restartState = isRestart ? runtimeRestartControlState({ runtimeState, runtimeAvailable, activeAction, canStart, canStop, pending }) : null;
  const action = restartState?.mode === "running" ? "stop" : restartState?.mode === "start" ? "start" : state.action;
  const disabled = restartState?.disabled ?? state.disabled;
  const mutate = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true); setMessage(isRestart ? "Restarting workspace…" : action === "start" ? "Starting runtime…" : "Stopping runtime…");
    try {
      const request = async (requested: RuntimeControlAction, rejectInProgress: boolean) => {
        const action = requested;
        const response = await fetch(`/api/projects/${projectId}/runtime`, {
          method: "POST", headers: { "content-type": "application/json", "x-devspace-csrf": "1" },
          body: JSON.stringify({ action })
        });
        const body = await response.json() as { message?: string };
        if (response.status === 202 && rejectInProgress) throw new Error(body.message ?? "The runtime action is still in progress; restart was not completed.");
        if (response.status === 202) { setMessage(body.message ?? "The runtime action is still in progress."); return false; }
        if (!response.ok) throw new Error(body.message ?? "The runtime action failed.");
        return true;
      };
      if (isRestart) {
        const mode = restartState?.mode;
        if (mode === null || mode === undefined) return;
        const readAuthorization = async (): Promise<RuntimeRestartAuthorization> => {
          const response = await fetch(`/api/projects/${projectId}/runtime`, { cache: "no-store" });
          const body = await response.json() as RuntimeRestartAuthorization & { message?: string };
          if (!response.ok) throw new Error(body.message ?? "Fresh runtime authorization could not be obtained.");
          return body;
        };
        await restartRuntime(mode, async (requested) => {
          await request(requested, true);
        }, mode === "running" ? readAuthorization : undefined);
        setMessage("Workspace restarted.");
        router.refresh();
        onSuccess?.();
      } else {
        const completed = await request(action, false);
        if (!completed) return;
        setMessage(action === "start" ? "Runtime is running." : "Runtime is stopped.");
        router.refresh();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : isRestart ? "Workspace restart failed." : "The runtime action failed.");
      if (isRestart) router.refresh();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  return <div className="runtime-controls">
    {isRestart && <button type="button" disabled={disabled || pending} title={restartState?.reason ?? undefined}
      onClick={() => { mutate().catch(() => undefined); }}>
      {pending ? "Restarting…" : "Restart workspace"}
    </button>}
    {!isRestart && activeAction !== null && <button type="button" disabled title="Another runtime action is already in progress.">
      {activeAction === "start" ? "Starting…" : "Stopping…"}
    </button>}
    {!isRestart && activeAction === null && <button type="button" disabled={state.disabled || pending} title={state.reason ?? undefined}
      onClick={() => { mutate().catch(() => undefined); }}>
      {pending ? (action === "start" ? "Starting…" : "Stopping…")
        : action === "start" ? (retryStart ? "Retry start" : "Start runtime") : (stopLabel ?? "Stop runtime")}
    </button>}
    {!runtimeAvailable && <p className="message error">The dedicated rootless runtime is unavailable.</p>}
    {message !== "" && <p className={`message ${message.includes("running") || message.includes("stopped") ? "success" : ""}`} role="status">{message}</p>}
  </div>;
}
