import { createLogger } from "@devspace/diagnostics";
import { describe, expect, test } from "vitest";
import { AgentResponseError, AgentUnavailableError } from "./agent-client.js";
import { SafeWebFailure, normalizeUserFacingFailure } from "./user-facing-failure.js";

const agentIncidentId = "018f0f00-0000-7000-8000-000000000098";
const webIncidentId = "018f0f00-0000-7000-8000-000000000099";

function normalize(error: unknown, logs: string[], createIncidentId = () => webIncidentId) {
  return normalizeUserFacingFailure(error, {
    fallbackMessage: "The action failed safely.",
    event: "web.action.failed",
    logMessage: "User-facing action failed",
    context: {
      requestId: "018f0f00-0000-7000-8000-000000000001",
      operationId: "018f0f00-0000-7000-8000-000000000002",
      projectId: "018f0f00-0000-7000-8000-000000000003",
      workspaceId: "018f0f00-0000-7000-8000-000000000004",
      previewId: "018f0f00-0000-7000-8000-000000000005"
    },
    createIncidentId,
    logger: createLogger({ component: "web", subsystem: "test", sink: (line) => logs.push(line) })
  });
}

describe("user-facing failure normalization", () => {
  test.each([
    ["transport", new AgentUnavailableError("AGENT_REQUEST_TIMEOUT", "transport-failure"), "transport-failure"],
    ["protocol", new AgentUnavailableError("INVALID_RESPONSE_CONTRACT", "protocol-failure"), "protocol-failure"]
  ])("creates a deterministic Web incident for %s failures", (_name, error, category) => {
    const logs: string[] = [];
    const projection = normalize(error, logs);
    expect(projection).toMatchObject({ incidentId: webIncidentId, failureCategory: category });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      incidentId: webIncidentId,
      failureCategory: category,
      requestId: "018f0f00-0000-7000-8000-000000000001",
      operationId: "018f0f00-0000-7000-8000-000000000002",
      projectId: "018f0f00-0000-7000-8000-000000000003",
      workspaceId: "018f0f00-0000-7000-8000-000000000004",
      previewId: "018f0f00-0000-7000-8000-000000000005"
    });
  });

  test("preserves an Agent incident exactly in both projection and Web log", () => {
    const logs: string[] = [];
    let generated = false;
    const projection = normalize(new AgentResponseError(
      "AGENT_INTERNAL_ERROR", "The Agent failed safely.", true, agentIncidentId
    ), logs, () => {
      generated = true;
      return webIncidentId;
    });
    expect(generated).toBe(false);
    expect(projection.incidentId).toBe(agentIncidentId);
    expect(JSON.parse(logs[0]!)).toMatchObject({ incidentId: agentIncidentId });
  });

  test.each([
    "private/config/runtime-plan.json",
    "a".repeat(64),
    "workspace-agent.internal",
    "10.42.0.17",
    "run docker inspect container",
    "customer-blue-runtime-primary"
  ])("never projects benign-looking private Agent text: %s", (privateMessage) => {
    const logs: string[] = [];
    const projection = normalize(new AgentResponseError("RESOURCE_NOT_FOUND", privateMessage), logs);
    expect(projection).toMatchObject({
      message: "The Agent no longer has the requested resource.",
      code: "RESOURCE_NOT_FOUND",
      failureCategory: "user-error"
    });
    expect(JSON.stringify({ projection, logs })).not.toContain(privateMessage);
  });

  test("unknown Agent codes and messages become bounded internal failures", () => {
    const logs: string[] = [];
    const projection = normalize(new AgentResponseError(
      "PRIVATE_AGENT_FAILURE",
      "harmless-looking-private-label",
      false,
      undefined,
      "user-error"
    ), logs);
    expect(projection).toMatchObject({
      message: "The action failed safely.",
      code: "WEB_INTERNAL_ERROR",
      failureCategory: "internal-failure",
      incidentId: webIncidentId
    });
    expect(JSON.stringify({ projection, logs })).not.toContain("harmless-looking-private-label");
  });

  test("Agent-derived wrappers cannot rebrand Agent text as Web-owned", () => {
    const logs: string[] = [];
    const projection = normalize(new SafeWebFailure("SOURCE_INVALID", "private-source-label", {
      messageOwnership: "agent-code"
    }), logs);
    expect(projection.message).toBe("The repository source is not supported.");
    expect(JSON.stringify(projection)).not.toContain("private-source-label");
  });

  test("keeps explicitly Web-owned SafeWebFailure messages specific", () => {
    const logs: string[] = [];
    const projection = normalize(new SafeWebFailure(
      "RUNTIME_ACTION_NOT_AUTHORIZED",
      "The requested runtime action is not valid for the authoritative current state."
    ), logs);
    expect(projection.message).toBe("The requested runtime action is not valid for the authoritative current state.");
    expect(projection).not.toHaveProperty("incidentId");
  });

  test.each([
    new SafeWebFailure("REQUEST_INVALID", "Choose a valid action."),
    new SafeWebFailure("WORKSPACE_STATE_CONFLICT", "The workspace is already stopped.")
  ])("does not create incidents for expected failures", (error) => {
    const logs: string[] = [];
    const projection = normalize(error, logs);
    expect(projection).not.toHaveProperty("incidentId");
    expect(logs).toHaveLength(0);
  });

  test("projects and logs no raw unknown error data", () => {
    const logs: string[] = [];
    const secret = "token=top-secret /srv/private https://internal.invalid Authorization: bearer-secret --password";
    const projection = normalize(new Error(secret), logs);
    const output = JSON.stringify({ projection, logs });
    expect(projection.message).toBe("The action failed safely.");
    for (const sensitive of ["top-secret", "/srv/private", "internal.invalid", "bearer-secret", "--password"]) {
      expect(output).not.toContain(sensitive);
    }
  });

  test("uses only code-owned text and never serializes private Agent details", () => {
    const logs: string[] = [];
    const error = new AgentResponseError(
      "AGENT_INTERNAL_ERROR",
      "token=top-secret at /srv/private from https://internal.invalid using --password",
      true,
      agentIncidentId
    );
    Object.assign(error, { details: { headers: { authorization: "Bearer hidden" }, body: "private" } });
    const projection = normalize(error, logs);
    const output = JSON.stringify({ projection, logs });
    expect(projection.message).toBe("The DevSpace Agent encountered an unexpected error.");
    expect(output).not.toMatch(/top-secret|srv\/private|internal\.invalid|Bearer hidden|"details"|"body"/u);
  });
});
