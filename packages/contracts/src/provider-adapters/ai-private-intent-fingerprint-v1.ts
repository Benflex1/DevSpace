import { createHmac } from "node:crypto";
import canonicalize from "canonicalize";
import * as z from "zod";
import {
  aiProcessGenerationSchema,
  aiProfileRevisionSchema,
  respondToAiStructuredInputCommandSchema,
  sendAiTurnCommandSchema
} from "../ai-sessions.js";
import { configurationKeySchema, uuidV7Schema } from "../primitives.js";

export const AI_PRIVATE_INTENT_FINGERPRINT_ALGORITHM =
  "hmac-sha256-ai-private-intent-v1" as const;
export const AI_PRIVATE_INTENT_FINGERPRINT_INPUT_FORMAT =
  "devspace.ai-private-intent-fingerprint-input/v1" as const;
export const AI_PRIVATE_INTENT_RECORD_SCHEMA_VERSION =
  "devspace.ai-private-intent/v1" as const;
const AI_PRIVATE_INTENT_FINGERPRINT_DOMAIN =
  "devspace.ai-private-intent-fingerprint/v1";

const fingerprintFields = {
  algorithm: z.literal(AI_PRIVATE_INTENT_FINGERPRINT_ALGORITHM),
  keyVersion: configurationKeySchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/u)
};

export const aiPrivateIntentFingerprintIdentityV1Schema =
  z.strictObject(fingerprintFields);
export type AiPrivateIntentFingerprintIdentityV1 = z.infer<
  typeof aiPrivateIntentFingerprintIdentityV1Schema
>;

export const aiPrivateIntentJournalReferenceV1Schema = z.strictObject({
  intentRecordId: uuidV7Schema,
  fingerprint: aiPrivateIntentFingerprintIdentityV1Schema
});

export const aiPrivateIntentRecordIntegrityV1Schema = z.strictObject({
  intentRecordId: uuidV7Schema,
  fingerprint: aiPrivateIntentFingerprintIdentityV1Schema
});

const fingerprintInputCommon = {
  format: z.literal(AI_PRIVATE_INTENT_FINGERPRINT_INPUT_FORMAT),
  intentRecordSchemaVersion: z.literal(AI_PRIVATE_INTENT_RECORD_SCHEMA_VERSION),
  intentRecordId: uuidV7Schema,
  operationId: uuidV7Schema,
  keyVersion: configurationKeySchema,
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  aiSessionId: uuidV7Schema,
  profileId: configurationKeySchema,
  profileRevision: aiProfileRevisionSchema,
  processGeneration: aiProcessGenerationSchema
};

const sendTurnFingerprintInputSchema = z.strictObject({
  ...fingerprintInputCommon,
  operationName: z.literal("ai-session.turn.send"),
  turnId: uuidV7Schema,
  interactionRequestId: z.null(),
  request: sendAiTurnCommandSchema
});

const respondToInputFingerprintInputSchema = z.strictObject({
  ...fingerprintInputCommon,
  operationName: z.literal("ai-session.input.respond"),
  turnId: uuidV7Schema,
  interactionRequestId: uuidV7Schema,
  request: respondToAiStructuredInputCommandSchema
});

function addBindingIssue(
  context: z.core.$RefinementCtx<unknown>,
  path: PropertyKey[]
): void {
  context.addIssue({
    code: "custom",
    path,
    message: "Private intent fingerprint binding does not match the full request"
  });
}

export const aiPrivateIntentFingerprintInputV1Schema = z
  .discriminatedUnion("operationName", [
    sendTurnFingerprintInputSchema,
    respondToInputFingerprintInputSchema
  ])
  .superRefine((input, context) => {
    for (const key of [
      "projectId",
      "workspaceId",
      "aiSessionId",
      "profileId",
      "profileRevision",
      "processGeneration",
      "turnId"
    ] as const) {
      if (input[key] !== input.request[key]) {
        addBindingIssue(context, [key]);
      }
    }
    if (
      input.operationName === "ai-session.turn.send"
      && input.request.command !== "sendTurn"
    ) {
      addBindingIssue(context, ["request", "command"]);
    }
    if (input.operationName === "ai-session.input.respond") {
      if (input.request.command !== "respondToStructuredInput") {
        addBindingIssue(context, ["request", "command"]);
      }
      if (input.interactionRequestId !== input.request.requestId) {
        addBindingIssue(context, ["interactionRequestId"]);
      }
    }
  });
export type AiPrivateIntentFingerprintInputV1 = z.infer<
  typeof aiPrivateIntentFingerprintInputV1Schema
>;

export function canonicalizeAiPrivateIntentFingerprintInputV1(
  input: unknown
): string {
  const canonical = canonicalize(
    aiPrivateIntentFingerprintInputV1Schema.parse(input)
  );
  if (canonical === undefined) {
    throw new TypeError("AI private intent fingerprint input is not JSON");
  }
  return canonical;
}

export function createAiPrivateIntentFingerprintV1(
  input: unknown,
  keyVersion: string,
  key: Uint8Array
): AiPrivateIntentFingerprintIdentityV1 {
  if (key.byteLength === 0) {
    throw new TypeError("AI private intent fingerprint key must not be empty");
  }
  const parsed = aiPrivateIntentFingerprintInputV1Schema.parse(input);
  if (parsed.keyVersion !== keyVersion) {
    throw new TypeError(
      "AI private intent fingerprint key version does not match its canonical input"
    );
  }
  const hmac = createHmac("sha256", key);
  hmac.update(AI_PRIVATE_INTENT_FINGERPRINT_DOMAIN, "utf8");
  hmac.update(Uint8Array.of(0));
  hmac.update(canonicalizeAiPrivateIntentFingerprintInputV1(parsed), "utf8");
  return aiPrivateIntentFingerprintIdentityV1Schema.parse({
    algorithm: AI_PRIVATE_INTENT_FINGERPRINT_ALGORITHM,
    keyVersion,
    digest: hmac.digest("hex")
  });
}

const keyVersionObservationSchema = z.strictObject({
  keyVersion: configurationKeySchema,
  state: z.enum(["active", "verification-only"]),
  dependentReferenceCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
});

export const aiPrivateIntentKeyringPolicyV1Schema = z.strictObject({
  activeKeyVersion: configurationKeySchema,
  versions: z.array(keyVersionObservationSchema).min(1).max(256)
}).superRefine((policy, context) => {
  const versions = new Set<string>();
  let activeCount = 0;
  for (const [index, version] of policy.versions.entries()) {
    if (versions.has(version.keyVersion)) {
      context.addIssue({
        code: "custom",
        path: ["versions", index, "keyVersion"],
        message: "Key versions must be unique"
      });
    }
    versions.add(version.keyVersion);
    if (version.state === "active") {
      activeCount += 1;
      if (version.keyVersion !== policy.activeKeyVersion) {
        context.addIssue({
          code: "custom",
          path: ["versions", index, "state"],
          message: "The active key must match activeKeyVersion"
        });
      }
    }
  }
  if (activeCount !== 1 || !versions.has(policy.activeKeyVersion)) {
    context.addIssue({
      code: "custom",
      path: ["activeKeyVersion"],
      message: "Exactly one installed key version must be active"
    });
  }
});
export type AiPrivateIntentKeyringPolicyV1 = z.infer<
  typeof aiPrivateIntentKeyringPolicyV1Schema
>;

export function canRetireAiPrivateIntentKeyVersionV1(
  input: unknown,
  keyVersion: string
): boolean {
  const policy = aiPrivateIntentKeyringPolicyV1Schema.parse(input);
  const version = policy.versions.find(
    (candidate) => candidate.keyVersion === keyVersion
  );
  return version?.state === "verification-only"
    && version.dependentReferenceCount === 0;
}
