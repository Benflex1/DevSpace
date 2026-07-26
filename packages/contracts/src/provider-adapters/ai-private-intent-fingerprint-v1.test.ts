import { describe, expect, test } from "vitest";
import * as publicContracts from "../index.js";
import {
  AI_PRIVATE_INTENT_FINGERPRINT_ALGORITHM,
  AI_PRIVATE_INTENT_FINGERPRINT_INPUT_FORMAT,
  AI_PRIVATE_INTENT_RECORD_SCHEMA_VERSION,
  aiPrivateIntentFingerprintInputV1Schema,
  aiPrivateIntentFingerprintIdentityV1Schema,
  aiPrivateIntentJournalReferenceV1Schema,
  aiPrivateIntentKeyringPolicyV1Schema,
  aiPrivateIntentRecordIntegrityV1Schema,
  canRetireAiPrivateIntentKeyVersionV1,
  canonicalizeAiPrivateIntentFingerprintInputV1,
  createAiPrivateIntentFingerprintV1
} from "./ai-private-intent-fingerprint-v1.js";

const projectId = "018f1f34-7000-7000-8000-000000000001";
const workspaceId = "018f1f34-7000-7000-8000-000000000002";
const sessionId = "018f1f34-7000-7000-8000-000000000003";
const turnId = "018f1f34-7000-7000-8000-000000000004";
const operationId = "018f1f34-7000-7000-8000-000000000005";
const intentRecordId = "018f1f34-7000-7000-8000-000000000006";
const requestId = "018f1f34-7000-7000-8000-000000000007";
const profileRevision = `sha256-ai-profile-v1:${"a".repeat(64)}`;
const testVectorKey = new Uint8Array(32).fill(0x5a);

const sendTurnRequest = {
  command: "sendTurn",
  projectId,
  workspaceId,
  aiSessionId: sessionId,
  profileId: "codex",
  profileRevision,
  processGeneration: 3,
  turnId,
  content: { kind: "text", text: "Review this change" }
} as const;

const sendTurnInput = {
  format: AI_PRIVATE_INTENT_FINGERPRINT_INPUT_FORMAT,
  intentRecordSchemaVersion: AI_PRIVATE_INTENT_RECORD_SCHEMA_VERSION,
  intentRecordId,
  operationId,
  keyVersion: "deployment-key-2026-07",
  operationName: "ai-session.turn.send",
  projectId,
  workspaceId,
  aiSessionId: sessionId,
  turnId,
  interactionRequestId: null,
  profileId: "codex",
  profileRevision,
  processGeneration: 3,
  request: sendTurnRequest
} as const;

describe("Agent-private AI intent fingerprint v1", () => {
  test("is absent from the browser/shared package-root API", () => {
    expect("createAiPrivateIntentFingerprintV1" in publicContracts).toBe(false);
    expect("aiPrivateIntentFingerprintIdentityV1Schema" in publicContracts)
      .toBe(false);
    expect("aiPrivateIntentKeyringPolicyV1Schema" in publicContracts)
      .toBe(false);
  });

  test("is strict, deterministic, domain separated, and field-order independent", () => {
    const reordered = {
      request: {
        content: { text: "Review this change", kind: "text" },
        turnId,
        processGeneration: 3,
        profileRevision,
        profileId: "codex",
        aiSessionId: sessionId,
        workspaceId,
        projectId,
        command: "sendTurn"
      },
      processGeneration: 3,
      profileRevision,
      profileId: "codex",
      interactionRequestId: null,
      turnId,
      aiSessionId: sessionId,
      workspaceId,
      projectId,
      operationName: "ai-session.turn.send",
      operationId,
      keyVersion: "deployment-key-2026-07",
      intentRecordId,
      intentRecordSchemaVersion: AI_PRIVATE_INTENT_RECORD_SCHEMA_VERSION,
      format: AI_PRIVATE_INTENT_FINGERPRINT_INPUT_FORMAT
    };
    expect(canonicalizeAiPrivateIntentFingerprintInputV1(reordered))
      .toBe(canonicalizeAiPrivateIntentFingerprintInputV1(sendTurnInput));
    const fingerprint = createAiPrivateIntentFingerprintV1(
      sendTurnInput,
      "deployment-key-2026-07",
      testVectorKey
    );
    expect(fingerprint).toEqual({
      algorithm: AI_PRIVATE_INTENT_FINGERPRINT_ALGORITHM,
      keyVersion: "deployment-key-2026-07",
      digest: "c46b58ccc980094b5a267fef63094b8760a7f8c745e9471b818beb697c6568b5"
    });
    expect(aiPrivateIntentFingerprintInputV1Schema.safeParse({
      ...sendTurnInput,
      extra: true
    }).success).toBe(false);
  });

  test("changes for every operation, intent, authority, generation, and content binding", () => {
    const baseline = createAiPrivateIntentFingerprintV1(
      sendTurnInput,
      "deployment-key-2026-07",
      testVectorKey
    ).digest;
    const changes: unknown[] = [
      { ...sendTurnInput, operationId: requestId },
      { ...sendTurnInput, intentRecordId: requestId },
      {
        ...sendTurnInput,
        request: {
          ...sendTurnRequest,
          content: { kind: "text", text: "Review another change" }
        }
      },
      {
        ...sendTurnInput,
        processGeneration: 4,
        request: { ...sendTurnRequest, processGeneration: 4 }
      },
      {
        ...sendTurnInput,
        profileRevision: `sha256-ai-profile-v1:${"b".repeat(64)}`,
        request: {
          ...sendTurnRequest,
          profileRevision: `sha256-ai-profile-v1:${"b".repeat(64)}`
        }
      }
    ];
    for (const changed of changes) {
      expect(createAiPrivateIntentFingerprintV1(
        changed,
        "deployment-key-2026-07",
        testVectorKey
      ).digest).not.toBe(baseline);
    }
  });

  test("rejects mismatched outer and full-request bindings", () => {
    expect(aiPrivateIntentFingerprintInputV1Schema.safeParse({
      ...sendTurnInput,
      processGeneration: 4
    }).success).toBe(false);
    expect(aiPrivateIntentFingerprintInputV1Schema.safeParse({
      ...sendTurnInput,
      interactionRequestId: requestId
    }).success).toBe(false);
    expect(() => createAiPrivateIntentFingerprintV1(
      sendTurnInput,
      "another-key-version",
      testVectorKey
    )).toThrow(/key version/u);
  });

  test("binds structured-input responses to the exact interaction request", () => {
    const request = {
      command: "respondToStructuredInput",
      projectId,
      workspaceId,
      aiSessionId: sessionId,
      profileId: "codex",
      profileRevision,
      processGeneration: 3,
      turnId,
      requestId,
      answers: [{
        questionId: "scope",
        kind: "text",
        text: "Only contracts"
      }]
    } as const;
    const input = {
      ...sendTurnInput,
      operationName: "ai-session.input.respond",
      interactionRequestId: requestId,
      request
    };
    expect(aiPrivateIntentFingerprintInputV1Schema.safeParse(input).success)
      .toBe(true);
    expect(aiPrivateIntentFingerprintInputV1Schema.safeParse({
      ...input,
      interactionRequestId: operationId
    }).success).toBe(false);
  });

  test("requires the same strict fingerprint identity on journal and intent records", () => {
    const fingerprint = createAiPrivateIntentFingerprintV1(
      sendTurnInput,
      "deployment-key-2026-07",
      testVectorKey
    );
    expect(aiPrivateIntentJournalReferenceV1Schema.parse({
      intentRecordId,
      fingerprint
    }).fingerprint).toEqual(
      aiPrivateIntentRecordIntegrityV1Schema.parse({
        intentRecordId,
        fingerprint
      }).fingerprint
    );
    expect(aiPrivateIntentFingerprintIdentityV1Schema.safeParse({
      ...fingerprint,
      keyValue: "forbidden"
    }).success).toBe(false);
  });

  test("allows retirement only for an unreferenced verification-only version", () => {
    const policy = {
      activeKeyVersion: "key-v2",
      versions: [
        {
          keyVersion: "key-v1",
          state: "verification-only",
          dependentReferenceCount: 1
        },
        {
          keyVersion: "key-v2",
          state: "active",
          dependentReferenceCount: 0
        },
        {
          keyVersion: "key-v0",
          state: "verification-only",
          dependentReferenceCount: 0
        }
      ]
    };
    expect(aiPrivateIntentKeyringPolicyV1Schema.safeParse(policy).success)
      .toBe(true);
    expect(canRetireAiPrivateIntentKeyVersionV1(policy, "key-v0")).toBe(true);
    expect(canRetireAiPrivateIntentKeyVersionV1(policy, "key-v1")).toBe(false);
    expect(canRetireAiPrivateIntentKeyVersionV1(policy, "key-v2")).toBe(false);
    expect(canRetireAiPrivateIntentKeyVersionV1(policy, "missing")).toBe(false);
    expect(aiPrivateIntentKeyringPolicyV1Schema.safeParse({
      ...policy,
      versions: policy.versions.map((version) => ({
        ...version,
        state: "verification-only"
      }))
    }).success).toBe(false);
  });
});
