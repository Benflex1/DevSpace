"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { restartRuntime, type RuntimeRestartAuthorization } from "./runtime-restart.js";
import { IncidentReference } from "./incident-reference.js";
import { runtimeControlState, runtimeRestartControlState, type RuntimeControlAction } from "./runtime-control-state.js";
import { useTransientNotice } from "./transient-notice.js";

export function RuntimeControls({ projectId, runtimeState, runtimeAvailable, activeAction, canStart, canStop, retryStart, action: requestedAction, stopLabel, restart = false, onSuccess, onRestartInitiated }: {
  projectId: string; runtimeAvailable: boolean;
  runtimeState: string; activeAction: RuntimeControlAction | null; canStart: boolean; canStop: boolean; retryStart: boolean;
  action?: RuntimeControlAction;
  stopLabel?: string;
  restart?: boolean;
  onSuccess?: () => void;
  onRestartInitiated?: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const { notice, show: showNotice } = useTransientNotice();
  const isRestart = restart;
  const state = runtimeControlState({ runtimeState, runtimeAvailable, activeAction, canStart, canStop,
    ...(requestedAction === undefined ? {} : { requestedAction }) });
  const restartState = isRestart ? runtimeRestartControlState({ runtimeState, runtimeAvailable, activeAction, canStart, canStop, pending }) : null;
  const action = restartState?.mode === "running" ? "stop" : restartState?.mode === "start" ? "start" : state.action;
  const disabled = restartState?.disabled ?? state.disabled;
  const observedTransition = activeAction === null && ["creating", "starting", "stopping", "removing"].includes(runtimeState);
  const mutate = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true); showNotice(isRestart ? "Restarting workspace…" : action === "start" ? "Starting runtime…" : "Stopping runtime…", "pending");
    try {
      const request = async (requested: RuntimeControlAction, rejectInProgress: boolean) => {
        const action = requested;
        const response = await fetch(`/api/projects/${projectId}/runtime`, {
          method: "POST", headers: { "content-type": "application/json", "x-devspace-csrf": "1" },
          body: JSON.stringify({ action })
        });
        const body = await response.json() as { message?: string; incidentId?: string };
        if (response.status === 202 && rejectInProgress) throw new RuntimeActionError(
          body.message ?? "The runtime action is still in progress; restart was not completed.", body.incidentId);
        if (response.status === 202) {
          showNotice(body.message ?? "The runtime action is still in progress.", "info");
          // Seed the Workbench's canonical runtime observation poller. A 202
          // is not evidence that the requested state has been reached.
          router.refresh();
          return false;
        }
        if (!response.ok) throw new RuntimeActionError(body.message ?? "The runtime action failed.", body.incidentId);
        return true;
      };
      if (isRestart) {
        const mode = restartState?.mode;
        if (mode === null || mode === undefined) return;
        onRestartInitiated?.();
        const readAuthorization = async (): Promise<RuntimeRestartAuthorization> => {
          const response = await fetch(`/api/projects/${projectId}/runtime`, { cache: "no-store" });
          const body = await response.json() as RuntimeRestartAuthorization & { message?: string };
          if (!response.ok) throw new Error(body.message ?? "Fresh runtime authorization could not be obtained.");
          return body;
        };
        await restartRuntime(mode, async (requested) => {
          await request(requested, true);
        }, mode === "running" ? readAuthorization : undefined);
        showNotice("Workspace restarted.", "success");
        router.refresh();
        onSuccess?.();
      } else {
        const completed = await request(action, false);
        if (!completed) return;
        showNotice(action === "start" ? "Runtime is running." : "Runtime is stopped.", "success");
        router.refresh();
      }
    } catch (error) {
      showNotice(error instanceof Error ? error.message : isRestart ? "Workspace restart failed." : "The runtime action failed.", "error",
        error instanceof RuntimeActionError ? error.incidentId : undefined);
      router.refresh();
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
    {!isRestart && (activeAction !== null || observedTransition) && <button type="button" disabled title={state.reason ?? "The workspace runtime is still changing state."}>
      {(activeAction ?? (runtimeState === "stopping" || runtimeState === "removing" ? "stop" : "start")) === "start" ? "Starting…" : "Stopping…"}
    </button>}
    {!isRestart && activeAction === null && !observedTransition && <button type="button" disabled={state.disabled || pending} title={state.reason ?? undefined}
      onClick={() => { mutate().catch(() => undefined); }}>
      {pending ? (action === "start" ? "Starting…" : "Stopping…")
        : action === "start" ? (retryStart ? "Retry start" : "Start runtime") : (stopLabel ?? "Stop runtime")}
    </button>}
    {!runtimeAvailable && <p className="message error">The dedicated rootless runtime is unavailable.</p>}
    {notice !== null && <p className={`message ${notice.kind}`} role="status"><span>{notice.message}</span>
      <IncidentReference incidentId={notice.referenceId} />
    </p>}
  </div>;
}

class RuntimeActionError extends Error {
  constructor(message: string, readonly incidentId?: string) {
    super(message);
    this.name = "RuntimeActionError";
  }
}
