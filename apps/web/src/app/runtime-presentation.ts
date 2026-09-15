const runtimeLabels: Readonly<Record<string, string>> = {
  absent: "Not started",
  creating: "Creating",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  degraded: "Degraded",
  failed: "Failed",
  removing: "Removing",
  lost: "Lost"
};

export function runtimePresentationLabel(state: string, runtimeAvailable: boolean): string {
  if (!runtimeAvailable) return "Unavailable";
  return runtimeLabels[state] ?? "Unavailable";
}

export function runtimePresentationMessage(state: string, runtimeAvailable: boolean, activeAction: "start" | "stop" | null): string {
  if (!runtimeAvailable) return "The dedicated rootless runtime is unavailable.";
  if (activeAction === "start" || state === "starting" || state === "creating") {
    return "The workspace runtime is starting. Codex can attach when it reaches Running.";
  }
  if (activeAction === "stop" || state === "stopping" || state === "removing") {
    return "The workspace runtime is stopping. Codex can attach after it reaches Running again.";
  }
  if (state === "running") return "The workspace runtime is running.";
  if (state === "failed" || state === "lost" || state === "degraded") {
    return "The workspace runtime needs attention before Codex can attach.";
  }
  if (state === "stopped" || state === "absent") return "Start the workspace runtime before Codex can start.";
  return "The workspace runtime state is unavailable, so Codex cannot attach safely.";
}
