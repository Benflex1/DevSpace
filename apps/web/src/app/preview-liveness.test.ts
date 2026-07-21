import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  createPreviewLivenessPoller, isPreviewLivenessEligible, PREVIEW_CHANGING_POLL_MS, PREVIEW_STABLE_POLL_MS,
  previewLivenessInterval
} from "./preview-liveness.js";
import { previewPresentationState, type PreviewLifecycleView } from "./preview-lifecycle.js";

const preview = (overrides: Partial<PreviewLifecycleView> = {}): PreviewLifecycleView => ({
  id: "preview-1", workspaceId: "workspace-1", configRevisionId: "revision-1", previewKey: "web", displayName: "Web",
  targetKind: "workspace", targetKey: "workspace", hostname: "web.preview.test", containerPort: 3000,
  desiredState: "active", observedState: "healthy", routePresent: true, runtimeGeneration: 1,
  lastObservationJson: null, lastErrorCode: null, lastErrorMessage: null, ...overrides
});

function timers() {
  let nextId = 1;
  const pending = new Map<number, { callback: () => void; delay: number }>();
  return {
    pending,
    setTimeout: (callback: () => void, delay: number) => {
      const id = nextId++;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id: number) => { pending.delete(id); },
    async runNext() {
      const entry = pending.entries().next().value as [number, { callback: () => void; delay: number }] | undefined;
      if (entry === undefined) return;
      pending.delete(entry[0]);
      entry[1].callback();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
}

describe("preview liveness polling", () => {
  test("keeps Ready active workspace previews eligible at the stable cadence", () => {
    const ready = preview();
    expect(isPreviewLivenessEligible(ready)).toBe(true);
    expect(previewLivenessInterval([ready])).toBe(PREVIEW_STABLE_POLL_MS);
  });

  test("uses the faster cadence while an active preview is waiting", () => {
    expect(previewLivenessInterval([preview({ observedState: "unhealthy", routePresent: false })]))
      .toBe(PREVIEW_CHANGING_POLL_MS);
    expect(previewLivenessInterval([preview({ routePresent: false })])).toBe(PREVIEW_CHANGING_POLL_MS);
  });

  test("does not schedule inactive or service previews", () => {
    expect(previewLivenessInterval([preview({ desiredState: "inactive" })])).toBeNull();
    expect(previewLivenessInterval([preview({ targetKind: "service" })])).toBeNull();
  });

  test("does not create a liveness timer for inactive previews", () => {
    const clock = timers();
    let refreshes = 0;
    const poller = createPreviewLivenessPoller({
      readPreviews: () => [preview({ desiredState: "inactive" })], readVisibility: () => "visible",
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      refreshPreviews: () => { refreshes += 1; return Promise.resolve([]); }
    });
    poller.start();
    expect(clock.pending.size).toBe(0);
    expect(refreshes).toBe(0);
  });

  test("refreshes a Ready preview and schedules from its new liveness state", async () => {
    const clock = timers();
    const visible: "visible" | "hidden" = "visible";
    let current = [preview()];
    let refreshes = 0;
    const poller = createPreviewLivenessPoller({
      readPreviews: () => current, readVisibility: () => visible, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      refreshPreviews: () => { refreshes += 1; current = [preview({ observedState: "unhealthy", routePresent: false })]; return Promise.resolve(current); }
    });
    poller.start();
    expect([...clock.pending.values()][0]?.delay).toBe(PREVIEW_STABLE_POLL_MS);
    await clock.runNext();
    expect(refreshes).toBe(1);
    expect(previewPresentationState(current[0]!)).toBe("waiting");
    expect([...clock.pending.values()][0]?.delay).toBe(PREVIEW_CHANGING_POLL_MS);
  });

  test("uses a preview-only request for liveness polling", async () => {
    const workbench = await readFile(new URL("./project-workbench.tsx", import.meta.url), "utf8");
    const start = workbench.indexOf("const refreshPreviews =");
    const end = workbench.indexOf("const updateTerminalState =", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(workbench.slice(start, end)).toContain("/api/projects/${projectId}/previews");
    expect(workbench.slice(start, end)).not.toContain("/api/projects/${projectId}/tasks");
    expect(workbench.slice(start, end)).not.toContain("refresh()");
  });

  test("pauses while hidden, resumes on visibility, and never creates duplicate timers", async () => {
    const clock = timers();
    let visible: "visible" | "hidden" = "visible";
    let refreshes = 0;
    const poller = createPreviewLivenessPoller({
      readPreviews: () => [preview()], readVisibility: () => visible, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      refreshPreviews: () => { refreshes += 1; return Promise.resolve([preview()]); }
    });
    poller.start(); poller.start();
    expect(clock.pending.size).toBe(1);
    visible = "hidden";
    poller.visibilityChanged();
    expect(clock.pending.size).toBe(0);
    visible = "visible";
    poller.visibilityChanged(); poller.visibilityChanged();
    expect(clock.pending.size).toBe(1);
    await clock.runNext();
    expect(refreshes).toBe(1);
    poller.stop();
    expect(clock.pending.size).toBe(0);
  });
});
