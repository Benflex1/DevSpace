import { describe, expect, test } from "vitest";
import {
  isPreviewChanging, previewPresentationLabel, previewPresentationState, previewStateMessage, previewUrl, type PreviewLifecycleView
} from "./preview-lifecycle.js";
import { previewTabId } from "./workbench-tabs.js";

const basePreview: PreviewLifecycleView = {
  id: "0190a000-0000-7000-8000-000000000001", workspaceId: "0190a000-0000-7000-8000-000000000002",
  configRevisionId: "0190a000-0000-7000-8000-000000000003", previewKey: "web", displayName: "Web",
  targetKind: "workspace", targetKey: "workspace", hostname: "alpha-primary-web-0190a000.preview.example.com",
  containerPort: 3000, desiredState: "active", observedState: "healthy", routePresent: true, runtimeGeneration: 1,
  lastObservationJson: null, lastErrorCode: null, lastErrorMessage: null
};

describe("preview presentation lifecycle", () => {
  test("requires both a healthy observation and an exact route before Ready", () => {
    expect(previewPresentationState(basePreview)).toBe("ready");
    expect(previewPresentationLabel(basePreview)).toBe("Ready");
    expect(previewPresentationState({ ...basePreview, routePresent: false })).toBe("waiting");
    expect(isPreviewChanging({ ...basePreview, routePresent: false, observedState: "unhealthy" })).toBe(true);
  });

  test("keeps a health timeout Waiting and maps infrastructure/policy failures to Unavailable", () => {
    expect(previewPresentationState({ ...basePreview, routePresent: false, observedState: "unhealthy", lastErrorMessage: "health-attempt-timeout" })).toBe("waiting");
    expect(previewPresentationState({ ...basePreview, routePresent: false, observedState: "failed", lastErrorCode: "GATEWAY_UPDATE_FAILED" })).toBe("unavailable");
    expect(previewStateMessage({ ...basePreview, targetKind: "service", routePresent: false })).toContain("unsupported runtime policy");
    expect(previewPresentationState({ ...basePreview, targetKind: "service", routePresent: false })).toBe("unavailable");
  });

  test("preserves Inactive and exact hostname navigation identity", () => {
    expect(previewPresentationState({ ...basePreview, desiredState: "inactive", routePresent: false })).toBe("inactive");
    expect(previewUrl(basePreview.hostname)).toBe(`https://${basePreview.hostname}`);
    expect(previewTabId(basePreview.id)).toBe(`preview:${basePreview.id}`);
  });
});
