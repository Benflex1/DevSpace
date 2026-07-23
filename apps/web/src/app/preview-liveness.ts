import { previewPresentationState, type PreviewLifecycleView } from "./preview-lifecycle.js";

export const PREVIEW_CHANGING_POLL_MS = 1_500;
export const PREVIEW_STABLE_POLL_MS = 4_000;

export function isPreviewLivenessEligible(preview: PreviewLifecycleView): boolean {
  return preview.targetKind === "workspace" && preview.desiredState === "active";
}

export function previewLivenessInterval(previews: readonly PreviewLifecycleView[]): number | null {
  const active = previews.filter(isPreviewLivenessEligible);
  if (active.length === 0) return null;
  return active.some((preview) => previewPresentationState(preview) === "waiting")
    ? PREVIEW_CHANGING_POLL_MS : PREVIEW_STABLE_POLL_MS;
}

export interface PreviewLivenessPollerOptions {
  readonly readPreviews: () => readonly PreviewLifecycleView[];
  readonly readVisibility: () => "visible" | "hidden";
  readonly refreshPreviews: () => Promise<readonly PreviewLifecycleView[] | null>;
  readonly setTimeout: (callback: () => void, delay: number) => number;
  readonly clearTimeout: (timer: number) => void;
}

export interface PreviewLivenessPoller {
  readonly start: () => void;
  readonly stop: () => void;
  readonly visibilityChanged: () => void;
  readonly previewsChanged: () => void;
}

export function createPreviewLivenessPoller(options: PreviewLivenessPollerOptions): PreviewLivenessPoller {
  let stopped = false;
  let started = false;
  let inFlight = false;
  let timer: number | null = null;
  let scheduledDelay: number | null = null;
  let current = options.readPreviews();

  const clear = () => {
    if (timer === null) return;
    options.clearTimeout(timer);
    timer = null;
    scheduledDelay = null;
  };
  const schedule = () => {
    if (!started || stopped || options.readVisibility() !== "visible" || timer !== null) return;
    current = options.readPreviews();
    const delay = previewLivenessInterval(current);
    if (delay === null) return;
    scheduledDelay = delay;
    timer = options.setTimeout(() => {
      timer = null;
      scheduledDelay = null;
      if (stopped || options.readVisibility() !== "visible" || inFlight) return;
      inFlight = true;
      void options.refreshPreviews().then((next) => {
        if (next !== null) current = next;
      }).catch(() => undefined).finally(() => {
        inFlight = false;
        schedule();
      });
    }, delay);
  };
  const previewsChanged = () => {
    current = options.readPreviews();
    if (!started || stopped) return;
    if (options.readVisibility() !== "visible") {
      clear();
      return;
    }
    const delay = previewLivenessInterval(current);
    if (delay === null) {
      clear();
      return;
    }
    if (inFlight) return;
    if (timer !== null && scheduledDelay === delay) return;
    clear();
    schedule();
  };
  return {
    start: () => {
      if (started) return;
      started = true;
      schedule();
    },
    stop: () => {
      stopped = true;
      clear();
    },
    visibilityChanged: () => {
      if (options.readVisibility() === "hidden") clear();
      else schedule();
    },
    previewsChanged
  };
}
