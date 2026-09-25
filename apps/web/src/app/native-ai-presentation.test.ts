import { expect, test } from "vitest";
import { nativeAiPresentation } from "./native-ai-presentation.js";

test("a live native session has no creation or resume action and no provider chooser", () => {
  for (const state of ["active", "creating"]) {
    expect(nativeAiPresentation({ state })).toEqual({ action: "none", showProviderChooser: false, status: "Running" });
  }
});

test("resume is offered only when the session can resume", () => {
  expect(nativeAiPresentation({ state: "stopped", resume: true })).toEqual({
    action: "resume", showProviderChooser: false, status: "Stopped"
  });
  expect(nativeAiPresentation({ state: "lost", resume: true })).toEqual({
    action: "resume", showProviderChooser: false, status: "Connection lost"
  });
  expect(nativeAiPresentation({ state: "stopped", resume: false }).action).toBe("start");
  expect(nativeAiPresentation({ state: "lost" }).action).toBe("start");
  expect(nativeAiPresentation(null)).toEqual({ action: "start", showProviderChooser: true, status: null });
});

test("provider selection belongs to session creation", () => {
  expect(nativeAiPresentation(null).showProviderChooser).toBe(true);
  expect(nativeAiPresentation({ state: "failed", resume: false }).showProviderChooser).toBe(true);
  expect(nativeAiPresentation({ state: "active" }).showProviderChooser).toBe(false);
  expect(nativeAiPresentation({ state: "stopped", resume: true }).showProviderChooser).toBe(false);
});
