export type NativeSessionPresentation = {
  readonly state: string;
  readonly resume?: boolean;
  readonly harnessId?: string | null;
};

export type NativeAiAction = "start" | "resume" | "none";

export function nativeAiPresentation(session: NativeSessionPresentation | null): {
  readonly action: NativeAiAction;
  readonly showProviderChooser: boolean;
  readonly status: string | null;
} {
  if (session !== null && (session.state === "active" || session.state === "creating")) {
    return { action: "none", showProviderChooser: false, status: "Running" };
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
    return { action: "start", showProviderChooser: true, status: "Stopped" };
  }
  return { action: "start", showProviderChooser: true, status: null };
}
