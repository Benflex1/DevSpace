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
  expect(packageEntry.agentApiV1Endpoints).toHaveLength(29);
  expect(packageEntry.executableAgentErrorCodes).toHaveLength(23);
  expect(packageEntry.TERMINAL_SUBPROTOCOL).toBe("devspace.terminal.v1");
  expect("buildAgentErrorEnvelopeSchema" in packageEntry).toBe(false);
  expect("agentErrorEnvelopeSchema" in packageEntry).toBe(false);
  expect(internalErrorBuilderIsNotPublic).toBe(false);
  expect(obsoleteErrorBuilderIsNotPublic).toBe(false);
});
