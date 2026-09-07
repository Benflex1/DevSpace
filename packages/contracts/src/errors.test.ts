import { describe, expect, test } from "vitest";
import {
  agentApiV1EndpointByOperation,
  githubAgentApiV1EndpointByOperation,
  executableAgentErrorCodes,
  executableAgentErrorRegistry,
  executableAgentErrorSchema
} from "./index.js";

const id = "018f1f34-7abc-7def-8abc-0123456789ab";
const meta = { protocolVersion: 1, requestId: id, respondedAt: "2026-07-15T12:34:56.789Z" };
const envelope = (code: string, retryable: boolean, details: object) => ({
  meta, error: { code, message: "Operator-safe message", retryable, details }
});

describe("executable Agent error registry", () => {
  test("contains exactly the accepted executable errors", () => {
    expect(executableAgentErrorCodes).toHaveLength(40);
    expect(new Set(executableAgentErrorCodes).size).toBe(40);
    expect(executableAgentErrorCodes).not.toContain("EVENT_SNAPSHOT_REQUIRED");
    expect(executableAgentErrorCodes).not.toContain("EVENT_CURSOR_INVALID");
    expect(executableAgentErrorCodes.join(" ")).not.toMatch(/RUNTIME_PLAN|ATTACHMENT_GRANT|REQUEST_HASH/u);
  });

  test.each([
    ["SOURCE_UNAVAILABLE", true],
    ["ROOTLESS_RUNTIME_UNAVAILABLE", true],
    ["AGENT_INTERNAL_ERROR", true],
    ["AI_NOT_CONFIGURED", false],
    ["REQUEST_INVALID", false]
  ] as const)("fixes %s retryability to %s", (code, retryable) => {
    expect(executableAgentErrorRegistry[code].retryable).toBe(retryable);
  });

  test("uses exact strict AI_NOT_CONFIGURED details", () => {
    const valid = envelope("AI_NOT_CONFIGURED", false, { workspaceId: id, revisionId: id });
    expect(executableAgentErrorSchema.safeParse(valid).success).toBe(true);
    expect(executableAgentErrorSchema.safeParse({
      ...valid, error: { ...valid.error, details: { ...valid.error.details, profileKey: "default" } }
    }).success).toBe(false);
  });

  test("all endpoint references resolve and every registry code is used", () => {
    const used = new Set<string>();
    for (const endpoint of [...Object.values(agentApiV1EndpointByOperation), ...Object.values(githubAgentApiV1EndpointByOperation)]) {
      expect(endpoint.errors.length).toBeGreaterThan(0);
      for (const error of endpoint.errors) {
        expect(executableAgentErrorCodes).toContain(error.code);
        used.add(error.code);
      }
    }
    expect(used).toEqual(new Set(executableAgentErrorCodes));
  });

  test("route-specific unions reject globally known but inapplicable errors", () => {
    const health = agentApiV1EndpointByOperation["agent.health.get"];
    expect(health.errorSchema.safeParse(envelope("SOURCE_UNAVAILABLE", true, {})).success).toBe(false);
    const gitInspect = agentApiV1EndpointByOperation["project.git.inspect"];
    expect(gitInspect.errorSchema.safeParse(envelope(
      "ROOTLESS_RUNTIME_UNAVAILABLE", true, { component: "docker" }
    )).success).toBe(false);
  });

  test("route-specific detail discriminators remain narrow", () => {
    const stream = agentApiV1EndpointByOperation["terminal.stream"];
    expect(stream.errorSchema.safeParse(envelope("RESOURCE_STATE_CONFLICT", false, {
      resource: { type: "terminal", id }, action: "attach"
    })).success).toBe(true);
    expect(stream.errorSchema.safeParse(envelope("RESOURCE_STATE_CONFLICT", false, {
      resource: { type: "terminal", id }, action: "close"
    })).success).toBe(false);
  });
});
