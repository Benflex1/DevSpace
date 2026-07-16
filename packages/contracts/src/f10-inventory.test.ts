import { describe, expect, test } from "vitest";
import {
  AGENT_EVENT_NDJSON_CONTENT_TYPE,
  agentApiV1Endpoints,
  completeAgentApiV1Endpoints,
  completeAgentApiV1ErrorCodes,
  f10AgentApiV1EndpointByOperation,
  f10AgentApiV1Endpoints,
  f10ExecutableAgentErrorCodes,
  executableAgentErrorCodes
} from "@devspace/contracts";

const acceptedF10 = [
  ["snapshot.get", "GET", "/v1/snapshot", "non-mutating", 200],
  ["event.stream", "GET", "/v1/events", "non-mutating", 200]
] as const;
const acceptedErrors = {
  "snapshot.get": [
    ["PROTOCOL_VERSION_UNSUPPORTED", [400, 426]],
    ["REQUEST_INVALID", [400]],
    ["AGENT_INTERNAL_ERROR", [500]]
  ],
  "event.stream": [
    ["PROTOCOL_VERSION_UNSUPPORTED", [400, 426]],
    ["EVENT_CURSOR_INVALID", [400]],
    ["REQUEST_INVALID", [400]],
    ["EVENT_SNAPSHOT_REQUIRED", [409]],
    ["AGENT_INTERNAL_ERROR", [500]]
  ]
} as const;

describe("F09, F10, and complete Agent API v1 inventory composition", () => {
  test("preserves the exact F09 classification counts", () => {
    expect(agentApiV1Endpoints).toHaveLength(29);
    expect(agentApiV1Endpoints.filter((endpoint) => endpoint.classification === "mutation")).toHaveLength(19);
    expect(agentApiV1Endpoints.filter((endpoint) => endpoint.classification === "non-mutating")).toHaveLength(9);
    expect(agentApiV1Endpoints.filter((endpoint) => endpoint.classification === "websocket-upgrade")).toHaveLength(1);
  });

  test("matches the independent exact F10 route matrix", () => {
    expect(f10AgentApiV1Endpoints.map((endpoint) => [
      endpoint.operation, endpoint.method, endpoint.path, endpoint.classification, endpoint.successStatus
    ])).toEqual(acceptedF10);
    for (const endpoint of f10AgentApiV1Endpoints) {
      expect(endpoint.journaledMutation).toBe(false);
      expect(endpoint.requestBodySchema.safeParse(undefined).success).toBe(true);
      expect(endpoint.errors.map((error) => [error.code, error.statuses]))
        .toEqual(acceptedErrors[endpoint.operation]);
    }
    expect(f10AgentApiV1EndpointByOperation["snapshot.get"].querySchema.safeParse(undefined).success).toBe(true);
    expect(f10AgentApiV1EndpointByOperation["event.stream"].querySchema.safeParse(undefined).success).toBe(false);
    expect(f10AgentApiV1EndpointByOperation["event.stream"].successContentType)
      .toBe(AGENT_EVENT_NDJSON_CONTENT_TYPE);
    expect(f10AgentApiV1EndpointByOperation["event.stream"].responseKind).toBe("ndjson-stream");
    expect(f10AgentApiV1EndpointByOperation["event.stream"].errorsAfterSuccessBegins).toBe(false);
  });

  test("composes the exact complete v1 counts", () => {
    expect(completeAgentApiV1Endpoints).toHaveLength(31);
    expect(completeAgentApiV1Endpoints.filter((endpoint) => endpoint.classification === "mutation")).toHaveLength(19);
    expect(completeAgentApiV1Endpoints.filter((endpoint) => endpoint.classification === "non-mutating")).toHaveLength(11);
    expect(completeAgentApiV1Endpoints.filter((endpoint) => endpoint.classification === "websocket-upgrade")).toHaveLength(1);
    expect(new Set(completeAgentApiV1Endpoints.map((endpoint) => endpoint.operation)).size).toBe(31);
  });

  test("keeps error registry views exactly separated", () => {
    expect(executableAgentErrorCodes).toHaveLength(23);
    expect(f10ExecutableAgentErrorCodes).toEqual(["EVENT_CURSOR_INVALID", "EVENT_SNAPSHOT_REQUIRED"]);
    expect(completeAgentApiV1ErrorCodes).toHaveLength(25);
    expect(new Set(completeAgentApiV1ErrorCodes).size).toBe(25);
    expect(executableAgentErrorCodes).not.toContain("EVENT_CURSOR_INVALID");
    expect(executableAgentErrorCodes).not.toContain("EVENT_SNAPSHOT_REQUIRED");
  });
});
