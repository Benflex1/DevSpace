import { completeAgentApiV1ErrorCodes } from "@devspace/contracts";
import { classifyFailureCode } from "@devspace/diagnostics";
import { describe, expect, test } from "vitest";
import {
  agentFailureUserMessageByCode,
  codeOwnedFailureMessage,
  webAgentFailureCodes
} from "./failure-policy.js";

describe("stable failure policy", () => {
  test("classifies the complete Agent error inventory without silent internal fallthrough", () => {
    expect(Object.keys(agentFailureUserMessageByCode).sort()).toEqual([...completeAgentApiV1ErrorCodes].sort());
    for (const code of completeAgentApiV1ErrorCodes) {
      expect(classifyFailureCode(code) === "internal-failure").toBe(code === "AGENT_INTERNAL_ERROR");
    }
  });

  test("keeps every Web-only Agent boundary code explicit and classified", () => {
    expect([...webAgentFailureCodes].sort()).toEqual([
      "AGENT_REQUEST_TIMEOUT",
      "AGENT_RESPONSE_TOO_LARGE",
      "AGENT_TRANSPORT_FAILURE",
      "AGENT_UNAVAILABLE",
      "INVALID_RESPONSE_CONTRACT",
      "MALFORMED_RESPONSE",
      "REQUEST_SERIALIZATION_FAILED"
    ]);
    for (const code of webAgentFailureCodes) {
      expect(codeOwnedFailureMessage(code)).toBeTypeOf("string");
      expect(classifyFailureCode(code)).not.toBe("internal-failure");
    }
  });

  test("keeps useful expected messages code-owned", () => {
    expect(codeOwnedFailureMessage("RESOURCE_NOT_FOUND")).toBe("The Agent no longer has the requested resource.");
    expect(codeOwnedFailureMessage("WORKSPACE_STATE_CONFLICT")).toBe(
      "The workspace is not in a state that allows this action."
    );
    expect(codeOwnedFailureMessage("NOT_A_REAL_AGENT_CODE")).toBeUndefined();
  });
});
