import { describe, expect, test, vi } from "vitest";
import { availabilityForDiscoveryError, createAiSessionRuntime } from "./ai-session-runtime.js";
import { AgentExecutionError } from "./managed-workspaces.js";

const workspaceId = "018f1f34-7000-7000-8000-000000000002";

describe("Codex discovery availability mapping", () => {
  test("keeps a genuinely missing Codex executable as EXECUTABLE_MISSING", () => {
    expect(availabilityForDiscoveryError(new Error("CODEX_EXECUTABLE_MISSING"))).toEqual({
      state: "unavailable",
      code: "EXECUTABLE_MISSING"
    });
  });

  test("maps a valid executable with an absent exact workspace runtime to a workspace prerequisite", () => {
    const error = new AgentExecutionError({
      code: "WORKSPACE_STATE_CONFLICT",
      message: "The exact workspace runtime is not running.",
      retryable: false,
      details: { workspaceId, desiredState: "running", observedState: "lost", action: "start" }
    });

    expect(availabilityForDiscoveryError(error)).toEqual({
      state: "unavailable",
      code: "WORKSPACE_REQUIREMENT_UNMET"
    });
  });

  test("does not attempt executable discovery before an absent exact runtime is reported", async () => {
    const discovery = vi.fn(() => Promise.reject(new Error("CODEX_EXECUTABLE_MISSING")));
    const runtime = createAiSessionRuntime({
      managed: {
        executionContext: () => Promise.reject(new AgentExecutionError({
            code: "WORKSPACE_STATE_CONFLICT",
            message: "The exact workspace runtime is not running.",
            retryable: false,
            details: { workspaceId, desiredState: "running", observedState: "lost", action: "start" }
          }))
      } as never,
      codexDiscovery: discovery
    });

    await expect(runtime.inspect({ projectId: "018f1f34-7000-7000-8000-000000000001", workspaceId, profileId: "codex" }))
      .resolves.toMatchObject({ availability: { state: "unavailable", code: "WORKSPACE_REQUIREMENT_UNMET" } });
    expect(discovery).not.toHaveBeenCalled();
  });

  test("preserves credential and runtime identity availability reasons", () => {
    expect(availabilityForDiscoveryError(new Error("credential-unavailable"))).toEqual({
      state: "unavailable",
      code: "CREDENTIAL_SOURCE_UNAVAILABLE"
    });
    expect(availabilityForDiscoveryError(new Error("runtime-identity-unavailable"))).toEqual({
      state: "unavailable",
      code: "RUNTIME_IDENTITY_UNAVAILABLE"
    });
  });

  test("does not impersonate executable absence for an unknown internal failure", () => {
    expect(availabilityForDiscoveryError(new Error("unexpected discovery failure"))).toEqual({
      state: "unavailable",
      code: "PROFILE_DISABLED"
    });
  });
});
