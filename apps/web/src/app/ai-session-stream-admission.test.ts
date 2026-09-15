import { describe, expect, test } from "vitest";
import { aiSessionStreamAdmission } from "./ai-session-stream-admission.js";

const base = {
  active: true,
  sessionState: "creating",
  runtimeState: "running",
  runtimeAvailable: true,
  activeAction: null as "start" | "stop" | null,
  providerAvailable: true
};

describe("AI session stream admission", () => {
  test("allows a creating session to observe session.ready", () => {
    expect(aiSessionStreamAdmission(base)).toEqual({ allowed: true, reason: "allowed" });
  });

  test("blocks a persisted nonterminal session while its exact workspace runtime is stopped", () => {
    expect(aiSessionStreamAdmission({ ...base, sessionState: "active", runtimeState: "stopped" })).toEqual({
      allowed: false,
      reason: "workspace-runtime-unavailable"
    });
  });

  test("blocks terminal or invalid session lifecycle states", () => {
    expect(aiSessionStreamAdmission({ ...base, sessionState: "lost" })).toEqual({ allowed: false, reason: "session-not-live" });
    expect(aiSessionStreamAdmission({ ...base, sessionState: "failed" })).toEqual({ allowed: false, reason: "session-not-live" });
  });

  test("blocks an unavailable provider without requiring a provider-ready session state", () => {
    expect(aiSessionStreamAdmission({ ...base, providerAvailable: false })).toEqual({ allowed: false, reason: "provider-unavailable" });
  });
});
