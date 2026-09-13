import canonicalize from "canonicalize";
import * as z from "zod";
import { aiProviderCapabilitiesSchema } from "../ai-sessions.js";
import { configurationKeySchema } from "../primitives.js";
import type { CodexProfileAuthorityInput } from "./codex-app-server.js";

export const AI_PROFILE_AUTHORITY_FORMAT =
  "devspace.ai-provider-profile-authority/v1" as const;
function isUnicodeScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const privateBoundedString = z.string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => !value.includes("\0") && isUnicodeScalarString(value),
    "Must contain Unicode scalar values and no NUL"
  );

const exactRuntimeIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("workspace-default-user") }),
  z.strictObject({
    kind: z.literal("exact-container-user"),
    user: privateBoundedString
  })
]);

const requiredRuntimeCapabilitiesSchema = z.array(configurationKeySchema)
  .max(64)
  .refine(
    (capabilities) => new Set(capabilities).size === capabilities.length,
    "Runtime capabilities must be unique"
  );

const codexDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const codexRuntimeIdentitySchema = z.strictObject({
  projectId: privateBoundedString,
  workspaceId: privateBoundedString,
  revisionId: privateBoundedString,
  runtimePlanHash: privateBoundedString,
  runtimeGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
});
const codexProbeRuntimeIdentitySchema = z.strictObject({
  imageId: privateBoundedString,
  operatingSystem: privateBoundedString,
  architecture: privateBoundedString,
  containerUser: privateBoundedString,
  policyVersion: z.literal("codex-probe-runtime-v1")
});

export const codexProviderAuthorityDocumentV1Schema = z.strictObject({
  format: z.literal(AI_PROFILE_AUTHORITY_FORMAT),
  profileId: z.literal("codex"),
  provider: z.literal("codex"),
  reportedVersion: privateBoundedString,
  entrypointSha256: codexDigestSchema,
  executionArtifactClosureDigest: codexDigestSchema,
  executionArtifactLayout: z.enum([
    "standalone-package",
    "official-node-native-payload",
    "self-contained-native"
  ]),
  protocolFamily: z.literal("stdio-jsonl"),
  stableSchemaFingerprint: codexDigestSchema,
  experimentalSchemaFingerprint: codexDigestSchema.nullable(),
  effectiveCapabilities: aiProviderCapabilitiesSchema,
  experimentalApi: z.boolean(),
  approvalPolicy: z.enum(["on-request", "never", "untrusted"]),
  approvalsReviewer: z.enum(["user", "auto_review", "guardian_subagent"]),
  semanticAdapterVersion: configurationKeySchema,
  compatibilityPolicyVersion: configurationKeySchema,
  probeRuntimeIdentity: codexProbeRuntimeIdentitySchema,
  credentialSourceIdentity: configurationKeySchema,
  runtimeIdentity: codexRuntimeIdentitySchema
});

export type CodexProviderAuthorityDocumentV1 = z.infer<
  typeof codexProviderAuthorityDocumentV1Schema
>;

export type CodexProviderAuthorityInput = CodexProfileAuthorityInput;

export const aiProviderAuthorityDocumentV1Schema = z.strictObject({
  format: z.literal(AI_PROFILE_AUTHORITY_FORMAT),
  profileId: configurationKeySchema,
  provider: configurationKeySchema,
  providerVersion: privateBoundedString,
  adapterVersion: configurationKeySchema,
  executableIdentity: configurationKeySchema,
  launchMode: configurationKeySchema,
  fixedArguments: z.array(privateBoundedString).max(64),
  runtimeIdentity: exactRuntimeIdentitySchema,
  requiredRuntimeCapabilities: requiredRuntimeCapabilitiesSchema,
  credentialSourceHandle: configurationKeySchema,
  capabilities: aiProviderCapabilitiesSchema,
  availabilityInspectionPolicy: z.strictObject({
    executableProbe: configurationKeySchema,
    expectedVersionOutput: privateBoundedString,
    credentialProbe: z.enum(["required", "not-required"]),
    runtimeProbe: z.literal("required-before-acceptance")
  })
});

export type AiProviderAuthorityDocumentV1 = z.infer<
  typeof aiProviderAuthorityDocumentV1Schema
>;

function normalizedAuthorityDocument(
  input: unknown
): AiProviderAuthorityDocumentV1 | CodexProviderAuthorityDocumentV1 {
  const codexParsed = codexProviderAuthorityDocumentV1Schema.safeParse(input);
  if (codexParsed.success) return codexParsed.data;
  const parsed = aiProviderAuthorityDocumentV1Schema.parse(input);
  return {
    ...parsed,
    requiredRuntimeCapabilities: [...parsed.requiredRuntimeCapabilities].sort()
  };
}

export function canonicalizeAiProviderAuthorityV1(input: unknown): string {
  const canonical = canonicalize(normalizedAuthorityDocument(input));
  if (canonical === undefined) {
    throw new TypeError("AI provider authority is not a JSON value");
  }
  return canonical;
}
