export type NativeSessionPresentation = {
  readonly state: string;
  readonly resume?: boolean;
  readonly harnessId?: string | null;
  readonly admissionStatus?: "preparing" | "admitting" | "admitted" | "uncertain" | "unknown";
};

export type NativeAiAction = "start" | "resume" | "none";

export function nativeAiPresentation(session: NativeSessionPresentation | null): {
  readonly action: NativeAiAction;
  readonly showProviderChooser: boolean;
  readonly status: string | null;
} {
  if (session?.state === "active") {
    return { action: "none", showProviderChooser: false, status: "Running" };
  }
  if (session?.state === "creating") {
    const status = session.admissionStatus === "preparing" ? "Preparing harness home…"
      : session.admissionStatus === "admitting" ? "Admission in progress"
        : session.admissionStatus === "admitted" ? "Waiting for session projection"
          : session.admissionStatus === "uncertain" ? "Admission uncertain"
            : "Checking admission";
    return { action: "none", showProviderChooser: false, status };
  }
  if (session?.resume === true && session.state === "lost") {
    return { action: "resume", showProviderChooser: false, status: "Connection lost" };
  }
  if (session?.resume === true) {
    return { action: "resume", showProviderChooser: false, status: "Stopped" };
  }
  if (session?.state === "lost") {
    return { action: "start", showProviderChooser: true, status: "Connection lost" };
  }
  if (session?.state === "stopped" || session?.state === "failed") {
    return { action: "start", showProviderChooser: true, status: session.state === "failed" ? "Failed" : "Stopped" };
  }
  return { action: "start", showProviderChooser: true, status: null };
}
