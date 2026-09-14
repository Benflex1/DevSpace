import { describe, expect, test } from "vitest";
import type {
  AiProviderProfileProjection,
  CodexCapabilitySet,
  CodexProfileAuthorityInput
} from "@devspace/contracts";
import type { CodexDiscoveryResult } from "./discovery.js";
import {
  codexProfileRevisionForDiscovery,
  discoveryAvailability,
  safeCodexProfileProjection
} from "./profile-authority.js";

const capabilities: CodexCapabilitySet = {
  inspect: true,
  start: true,
  resume: true,
  sendTurn: true,
  interrupt: true,
  approvals: true,
  structuredInput: true,
  stop: true,
  streamEvents: true
};

const authority: CodexProfileAuthorityInput = {
  providerKind: "codex",
  reportedVersion: "0.153.4",
  entrypointSha256: "1".repeat(64),
  executionArtifactClosureDigest: "2".repeat(64),
  executionArtifactLayout: "official-node-native-payload",
  protocolFamily: "stdio-jsonl",
  stableSchemaFingerprint: "3".repeat(64),
  experimentalSchemaFingerprint: "4".repeat(64),
  effectiveCapabilities: capabilities,
  experimentalApi: true,
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  semanticAdapterVersion: "codex-app-server-family-v1",
  compatibilityPolicyVersion: "codex-compatibility-v1",
  probeRuntimeIdentity: {
    imageId: `sha256:${"5".repeat(32)}`,
    operatingSystem: "linux",
    architecture: "amd64",
    containerUser: "1000:1000",
    policyVersion: "codex-probe-runtime-v1"
  },
  credentialSourceIdentity: "codex-owner-login",
  runtimeIdentity: {
    projectId: "project",
    workspaceId: "workspace",
    revisionId: "revision",
    runtimePlanHash: "runtime-plan",
    runtimeGeneration: 1
  }
};

function discovery(overrides: Partial<CodexDiscoveryResult>): CodexDiscoveryResult {
  return {
    artifact: {} as CodexDiscoveryResult["artifact"],
    stagedArtifact: {} as CodexDiscoveryResult["stagedArtifact"],
    probe: {} as CodexDiscoveryResult["probe"],
    compatibility: {
      transport: "compatible",
      features: {
        basicSession: { feature: "basicSession", state: "supported", reason: null },
        approvals: { feature: "approvals", state: "supported", reason: null },
        structuredInput: { feature: "structuredInput", state: "supported", reason: null },
        interrupt: { feature: "interrupt", state: "supported", reason: null }
      },
      capabilities,
      diagnostic: null,
      stableSchemaFingerprint: authority.stableSchemaFingerprint,
      experimentalSchemaFingerprint: authority.experimentalSchemaFingerprint
    },
    profileAuthority: authority,
    ...overrides
  };
}

describe("Codex profile authority", () => {
  test.each([
    "reportedVersion",
    "entrypointSha256",
    "executionArtifactClosureDigest",
    "executionArtifactLayout",
    "stableSchemaFingerprint",
    "experimentalSchemaFingerprint",
    "effectiveCapabilities",
    "experimentalApi",
    "approvalPolicy",
    "approvalsReviewer",
    "semanticAdapterVersion",
    "compatibilityPolicyVersion",
    "probeRuntimeIdentity",
    "credentialSourceIdentity",
    "runtimeIdentity"
  ] as const)("changes the revision when %s changes", (field) => {
    const changed = { ...authority };
    if (field === "reportedVersion") changed[field] = "0.153.5";
    else if (field === "entrypointSha256") changed[field] = "6".repeat(64);
    else if (field === "executionArtifactClosureDigest") changed[field] = "7".repeat(64);
    else if (field === "stableSchemaFingerprint") changed[field] = "8".repeat(64);
    else if (field === "effectiveCapabilities") changed[field] = { ...capabilities, interrupt: false };
    else if (field === "probeRuntimeIdentity") changed[field] = { ...authority[field], architecture: "arm64" };
    else if (field === "runtimeIdentity") changed[field] = { ...authority[field], runtimeGeneration: 2 };
    else if (field === "experimentalSchemaFingerprint") changed[field] = null;
    else if (field === "experimentalApi") changed[field] = false;
    else if (field === "approvalPolicy") changed[field] = "never";
    else if (field === "approvalsReviewer") changed[field] = "auto_review";
    else if (field === "executionArtifactLayout") changed[field] = "self-contained-native";
    else changed[field] = `${String(authority[field])}-changed` as never;
    expect(codexProfileRevisionForDiscovery(changed)).not.toBe(codexProfileRevisionForDiscovery(authority));
  });

  test("excludes cosmetic display metadata from the revision", () => {
    expect(codexProfileRevisionForDiscovery(authority)).toBe(
      codexProfileRevisionForDiscovery({ ...authority })
    );
    const projection = safeCodexProfileProjection({
      revision: codexProfileRevisionForDiscovery(authority), capabilities, availability: { state: "available" }
    });
    expect(projection.displayName).toBe("Codex");
  });

  test("admits compatible 0.153.4 evidence with the writable approval profile", () => {
    const result = discovery({});
    expect(discoveryAvailability(result)).toEqual({ state: "available" });
    expect(safeCodexProfileProjection({
      revision: codexProfileRevisionForDiscovery(result.profileAuthority),
      capabilities: result.compatibility.capabilities,
      availability: discoveryAvailability(result)
    }).capabilities.approvals).toBe(true);
  });

  test("admits the image default user represented by an empty Docker user", () => {
    const result = discovery({
      profileAuthority: {
        ...authority,
        probeRuntimeIdentity: { ...authority.probeRuntimeIdentity, containerUser: "" }
      }
    });
    expect(() => codexProfileRevisionForDiscovery(result.profileAuthority)).not.toThrow();
    expect(discoveryAvailability(result)).toEqual({ state: "available" });
  });

  test("rejects a below-minimum result without weakening approval authority", () => {
    const result = discovery({
      profileAuthority: { ...authority, reportedVersion: "0.144.0" },
      compatibility: {
        ...discovery({}).compatibility,
        transport: "incompatible",
        diagnostic: "CODEX_VERSION_BELOW_MINIMUM",
        capabilities: { ...capabilities, approvals: false, structuredInput: false, interrupt: false }
      }
    });
    expect(discoveryAvailability(result)).toEqual({ state: "unavailable", code: "VERSION_MISMATCH" });
  });

  test("fails closed when approvals are not structurally supported", () => {
    const result = discovery({
      compatibility: {
        ...discovery({}).compatibility,
        diagnostic: "CODEX_APPROVAL_PROTOCOL_UNAVAILABLE",
        capabilities: { ...capabilities, approvals: false }
      }
    });
    expect(discoveryAvailability(result)).toEqual({ state: "unavailable", code: "PROFILE_DISABLED" });
    const projection: AiProviderProfileProjection = safeCodexProfileProjection({
      revision: codexProfileRevisionForDiscovery(result.profileAuthority),
      capabilities: result.compatibility.capabilities,
      availability: { state: "available" }
    });
    expect(projection.availability).toEqual({ state: "unavailable", code: "PROFILE_DISABLED" });
  });
});
