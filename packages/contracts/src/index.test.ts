import { expect, test } from "vitest";
import * as packageEntry from "@devspace/contracts";

type AssertFalse<Value extends false> = Value;
type InternalErrorBuilderIsPublic = "buildAgentErrorEnvelopeSchema" extends keyof typeof packageEntry
  ? true
  : false;
type ObsoleteErrorBuilderIsPublic = "agentErrorEnvelopeSchema" extends keyof typeof packageEntry
  ? true
  : false;

test("@devspace/contracts is consumable from its package root without prior build output", () => {
  const internalErrorBuilderIsNotPublic: AssertFalse<InternalErrorBuilderIsPublic> = false;
  const obsoleteErrorBuilderIsNotPublic: AssertFalse<ObsoleteErrorBuilderIsPublic> = false;
  expect(packageEntry.agentApiV1Endpoints).toHaveLength(30);
  expect(packageEntry.f10AgentApiV1Endpoints).toHaveLength(2);
  expect(packageEntry.completeAgentApiV1Endpoints).toHaveLength(38);
  expect(packageEntry.f11AiAgentApiV1Endpoints).toHaveLength(10);
  expect(packageEntry.executableAgentErrorCodes).toHaveLength(23);
  expect(packageEntry.f10ExecutableAgentErrorCodes).toHaveLength(2);
  expect(packageEntry.completeAgentApiV1ErrorCodes).toHaveLength(25);
  expect(packageEntry.agentEventTypes).toHaveLength(11);
  expect(packageEntry.agentExecutionFailureCodes).toHaveLength(18);
  expect(packageEntry.agentSnapshotDataSchema).toBeDefined();
  expect(packageEntry.eventCursorSchema).toBeDefined();
  expect(packageEntry.TERMINAL_SUBPROTOCOL).toBe("devspace.terminal.v1");
  expect("buildAgentErrorEnvelopeSchema" in packageEntry).toBe(false);
  expect("agentErrorEnvelopeSchema" in packageEntry).toBe(false);
  expect(internalErrorBuilderIsNotPublic).toBe(false);
  expect(obsoleteErrorBuilderIsNotPublic).toBe(false);
});
