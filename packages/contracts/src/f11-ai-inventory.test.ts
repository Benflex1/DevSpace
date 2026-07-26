import { describe, expect, test } from "vitest";
import {
  AI_EVENT_NDJSON_CONTENT_TYPE,
  completeAgentApiV1Endpoints,
  f11AiAgentApiV1EndpointByOperation,
  f11AiAgentApiV1Endpoints,
  nonAiAgentApiV1Endpoints
} from "./index.js";

const accepted = [
  ["ai-provider.inspect", "POST", "/v1/ai-profiles/inspect", "non-mutating", 200],
  ["ai-session.start", "POST", "/v1/ai-sessions/start", "mutation", 202],
  ["ai-session.resume", "POST", "/v1/ai-sessions/resume", "mutation", 202],
  ["ai-session.turn.send", "POST", "/v1/ai-sessions/send-turn", "mutation", 202],
  ["ai-session.turn.interrupt", "POST", "/v1/ai-sessions/interrupt", "mutation", 202],
  ["ai-session.approval.respond", "POST", "/v1/ai-sessions/respond-approval", "mutation", 202],
  ["ai-session.input.respond", "POST", "/v1/ai-sessions/respond-input", "mutation", 202],
  ["ai-session.stop", "POST", "/v1/ai-sessions/stop", "mutation", 202],
  ["ai-session.events.stream", "GET", "/v1/ai-sessions/{aiSessionId}/events", "non-mutating", 200],
  ["ai-session.events.acknowledge", "POST", "/v1/ai-sessions/acknowledge-events", "non-mutating", 200]
] as const;

describe("F11 AI Session Agent API extension", () => {
  test("is the sole complete-inventory AI authority", () => {
    expect(f11AiAgentApiV1Endpoints.map((endpoint) => [
      endpoint.operation,
      endpoint.method,
      endpoint.path,
      endpoint.classification,
      endpoint.successStatus
    ])).toEqual(accepted);
    expect(nonAiAgentApiV1Endpoints).toHaveLength(26);
    expect(nonAiAgentApiV1Endpoints.some((endpoint) =>
      endpoint.operation.startsWith("ai-session.")
    )).toBe(false);
    expect(completeAgentApiV1Endpoints.filter((endpoint) =>
      endpoint.operation.startsWith("ai-session.") || endpoint.operation === "ai-provider.inspect"
    )).toHaveLength(10);
  });

  test("requires operation journaling for lifecycle/content commands only", () => {
    expect(f11AiAgentApiV1Endpoints.filter((endpoint) => endpoint.journaledMutation))
      .toHaveLength(7);
    expect(f11AiAgentApiV1EndpointByOperation["ai-provider.inspect"].journaledMutation).toBe(false);
    expect(f11AiAgentApiV1EndpointByOperation["ai-session.events.stream"].journaledMutation).toBe(false);
    expect(f11AiAgentApiV1EndpointByOperation["ai-session.events.acknowledge"].journaledMutation)
      .toBe(false);
  });

  test("uses a dedicated bounded NDJSON stream and decimal afterSequence", () => {
    const stream = f11AiAgentApiV1EndpointByOperation["ai-session.events.stream"];
    expect(stream.successContentType).toBe(AI_EVENT_NDJSON_CONTENT_TYPE);
    expect(stream.responseKind).toBe("ndjson-stream");
    expect(stream.querySchema.safeParse({ afterSequence: "0" }).success).toBe(true);
    expect(stream.querySchema.safeParse({ afterSequence: "01" }).success).toBe(false);
    expect(stream.querySchema.safeParse({ afterSequence: "-1" }).success).toBe(false);
    expect(stream.pathParametersSchema.safeParse({
      aiSessionId: "018f1f34-7000-7000-8000-000000000001"
    }).success).toBe(true);
  });

  test("contains no provider-native or executable authority in F11 requests", () => {
    const serializedSchemas = JSON.stringify(f11AiAgentApiV1Endpoints.map((endpoint) =>
      endpoint.requestDataSchema === null ? null : endpoint.requestDataSchema.toJSONSchema()
    ));
    expect(serializedSchemas).not.toMatch(
      /providerThreadId|providerTurnId|containerId|dockerExecId|credential|executable|fixedArgs|environment|cwd/
    );
  });
});
