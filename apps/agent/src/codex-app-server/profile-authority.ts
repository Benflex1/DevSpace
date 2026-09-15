import {
  AI_PROFILE_AUTHORITY_FORMAT,
  aiProviderProfileProjectionSchema,
  mapCodexDiagnosticToPublicAvailability,
  type AiProviderProfileProjection,
  type CodexCapabilitySet,
  type CodexProfileAuthorityInput
} from "@devspace/contracts";
import type { CodexDiscoveryResult } from "./discovery.js";
import { hashAiProviderAuthorityV1 } from "./profile-revision.js";

const CODEX_PROFILE_ID = "codex" as const;

function authorityDocument(input: CodexProfileAuthorityInput) {
  return {
    format: AI_PROFILE_AUTHORITY_FORMAT,
    profileId: CODEX_PROFILE_ID,
    provider: CODEX_PROFILE_ID,
    reportedVersion: input.reportedVersion,
    entrypointSha256: input.entrypointSha256,
    executionArtifactClosureDigest: input.executionArtifactClosureDigest,
    executionArtifactLayout: input.executionArtifactLayout,
    protocolFamily: input.protocolFamily,
    stableSchemaFingerprint: input.stableSchemaFingerprint,
    experimentalSchemaFingerprint: input.experimentalSchemaFingerprint,
    effectiveCapabilities: input.effectiveCapabilities,
    experimentalApi: input.experimentalApi,
    approvalPolicy: input.approvalPolicy,
    approvalsReviewer: input.approvalsReviewer,
    semanticAdapterVersion: input.semanticAdapterVersion,
    compatibilityPolicyVersion: input.compatibilityPolicyVersion,
    probeRuntimeIdentity: input.probeRuntimeIdentity,
    credentialSourceIdentity: input.credentialSourceIdentity,
    runtimeIdentity: input.runtimeIdentity
  } as const;
}

export function codexProfileRevisionForDiscovery(input: CodexProfileAuthorityInput): string {
  return hashAiProviderAuthorityV1(authorityDocument(input));
}

export function discoveryAvailability(
  result: Pick<CodexDiscoveryResult, "compatibility">
): AiProviderProfileProjection["availability"] {
  const diagnostic = result.compatibility.diagnostic ?? "CODEX_PROTOCOL_INCOMPATIBLE";
  if (result.compatibility.transport === "incompatible") {
    const code = mapCodexDiagnosticToPublicAvailability(diagnostic) ?? "PROFILE_DISABLED";
    return { state: "unavailable", code };
  }
  // The current managed profile is writable and therefore cannot be admitted
  // without both command and file approval semantics.
  if (!result.compatibility.capabilities.approvals) {
    return { state: "unavailable", code: "PROFILE_DISABLED" };
  }
  return { state: "available" };
}

export function safeCodexProfileProjection(input: {
  readonly revision: string;
  readonly capabilities: CodexCapabilitySet;
  readonly availability: AiProviderProfileProjection["availability"];
}): AiProviderProfileProjection {
  const availability = input.capabilities.approvals && input.availability.state === "available"
    ? input.availability
    : input.availability.state === "available"
      ? { state: "unavailable" as const, code: "PROFILE_DISABLED" as const }
      : input.availability;
  return aiProviderProfileProjectionSchema.parse({
    profileId: CODEX_PROFILE_ID,
    profileRevision: input.revision,
    provider: CODEX_PROFILE_ID,
    displayName: "Codex",
    capabilities: input.capabilities,
    availability
  });
}

const fakeCapabilities: CodexCapabilitySet = Object.freeze({
  inspect: true,
  start: true,
  resume: false,
  sendTurn: true,
  interrupt: true,
  approvals: true,
  structuredInput: true,
  stop: true,
  streamEvents: true
});

const fakeAuthority: CodexProfileAuthorityInput = {
  providerKind: "codex",
  reportedVersion: "devspace-fake-provider",
  entrypointSha256: "0".repeat(64),
  executionArtifactClosureDigest: "0".repeat(64),
  executionArtifactLayout: "self-contained-native",
  protocolFamily: "stdio-jsonl",
  stableSchemaFingerprint: "0".repeat(64),
  experimentalSchemaFingerprint: "0".repeat(64),
  effectiveCapabilities: fakeCapabilities,
  experimentalApi: true,
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  semanticAdapterVersion: "devspace-fake-provider-v1",
  compatibilityPolicyVersion: "devspace-fake-provider-v1",
  probeRuntimeIdentity: {
    imageId: `sha256:${"0".repeat(32)}`,
    operatingSystem: "fake",
    architecture: "fake",
    containerUser: "fake",
    policyVersion: "codex-probe-runtime-v1"
  },
  credentialSourceIdentity: "devspace-fake-provider",
  runtimeIdentity: {
    projectId: "fake",
    workspaceId: "fake",
    revisionId: "fake",
    runtimePlanHash: "fake",
    runtimeGeneration: 1
  }
};

export function fakeCodexProfileProjection(): AiProviderProfileProjection {
  return safeCodexProfileProjection({
    revision: codexProfileRevisionForDiscovery(fakeAuthority),
    capabilities: fakeCapabilities,
    availability: { state: "available" }
  });
}
