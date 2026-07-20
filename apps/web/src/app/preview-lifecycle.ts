export type PreviewPresentationState = "inactive" | "waiting" | "ready" | "unavailable";
export { previewTabId } from "./workbench-tabs.js";

export interface PreviewLifecycleView {
  readonly id: string;
  readonly workspaceId: string;
  readonly configRevisionId: string;
  readonly previewKey: string;
  readonly displayName: string;
  readonly targetKind: "workspace" | "service";
  readonly targetKey: string;
  readonly hostname: string;
  readonly containerPort: number;
  readonly desiredState: string;
  readonly observedState: string;
  readonly routePresent: boolean;
  readonly runtimeGeneration: number | null;
  readonly lastObservationJson: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
}

export function previewUrl(hostname: string, gateway: { readonly protocol?: "http:" | "https:"; readonly port?: number | null } = {}): string {
  const protocol = gateway.protocol ?? "https:";
  const port = gateway.port === undefined || gateway.port === null ? "" : `:${gateway.port}`;
  return `${protocol}//${hostname}${port}`;
}

export function previewPresentationState(preview: PreviewLifecycleView): PreviewPresentationState {
  if (preview.targetKind === "service") return "unavailable";
  if (preview.desiredState === "inactive" && !preview.routePresent) return "inactive";
  if (preview.routePresent && preview.observedState === "healthy") return "ready";
  if (preview.observedState === "failed" || preview.observedState === "lost") return "unavailable";
  return "waiting";
}

export function previewPresentationLabel(preview: PreviewLifecycleView): string {
  return { inactive: "Inactive", waiting: "Waiting", ready: "Ready", unavailable: "Unavailable" }[previewPresentationState(preview)];
}

export function previewPresentationSymbol(preview: PreviewLifecycleView): "●" | "○" {
  return previewPresentationState(preview) === "ready" ? "●" : "○";
}

export function isPreviewChanging(preview: PreviewLifecycleView): boolean {
  const state = previewPresentationState(preview);
  return state === "waiting" && preview.desiredState === "active"
    && (preview.observedState === "starting" || preview.observedState === "unhealthy" || preview.lastErrorCode === "AGENT_UNAVAILABLE");
}

export function previewStateMessage(preview: PreviewLifecycleView): string {
  if (preview.targetKind === "service") return "Unavailable — unsupported runtime policy for this preview target.";
  switch (previewPresentationState(preview)) {
    case "inactive": return "This preview is inactive.";
    case "waiting": return "Waiting for the application to listen and pass its health check.";
    case "ready": return "The preview route is ready.";
    case "unavailable":
      return preview.lastErrorCode === "RUNTIME_POLICY_VIOLATION"
        ? "Unavailable — unsupported runtime policy for this preview target."
        : preview.lastErrorMessage ?? "Unavailable because the exact preview route is not currently provable.";
  }
}
