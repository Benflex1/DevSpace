import { expect, test } from "vitest";
import { nativeAiPresentation } from "./native-ai-presentation.js";

test("an active native session has no creation or resume action and no provider chooser", () => {
  expect(nativeAiPresentation({ state: "active" })).toEqual({ action: "none", showProviderChooser: false, status: "Running" });
});

test("admission progress is not presented as a running harness", () => {
  expect(nativeAiPresentation({ state: "creating", admissionStatus: "preparing" }).status).toBe("Preparing harness home…");
  expect(nativeAiPresentation({ state: "creating", admissionStatus: "admitting" }).status).toBe("Admission in progress");
  expect(nativeAiPresentation({ state: "creating", admissionStatus: "admitted" }).status).toBe("Waiting for session projection");
  expect(nativeAiPresentation({ state: "creating", admissionStatus: "uncertain" }).status).toBe("Admission uncertain");
  expect(nativeAiPresentation({ state: "creating", admissionStatus: "unknown" }).status).toBe("Checking admission");
  expect(nativeAiPresentation({ state: "creating", admissionStatus: "uncertain" }).action).toBe("none");
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
