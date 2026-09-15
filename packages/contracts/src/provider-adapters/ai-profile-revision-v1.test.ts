import { describe, expect, test } from "vitest";
import {
  AI_PROFILE_AUTHORITY_FORMAT,
  canonicalizeAiProviderAuthorityV1
} from "./ai-profile-revision-v1.js";

const authority = {
  format: AI_PROFILE_AUTHORITY_FORMAT,
  profileId: "codex",
  provider: "codex",
  providerVersion: "0.145.0",
  adapterVersion: "codex-app-server-family-v1",
  executableIdentity: "deployment-profile-pinned-codex",
  launchMode: "app-server-stdio",
  fixedArguments: ["app-server", "--stdio"],
  runtimeIdentity: { kind: "workspace-default-user" },
  requiredRuntimeCapabilities: ["stdio-jsonl", "private-supervisor"],
  credentialSourceHandle: "codex-owner-login",
  capabilities: {
    inspect: true,
    start: true,
    resume: true,
    sendTurn: true,
    interrupt: true,
    approvals: true,
    structuredInput: false,
    stop: true,
    streamEvents: true
  },
  availabilityInspectionPolicy: {
    executableProbe: "exact-version-output",
    expectedVersionOutput: "codex-cli 0.145.0",
    credentialProbe: "required",
    runtimeProbe: "required-before-acceptance"
  }
} as const;

describe("AI provider profile revision v1", () => {
  test("is field-order and runtime-capability-order independent", () => {
    const reordered = {
      availabilityInspectionPolicy: authority.availabilityInspectionPolicy,
      capabilities: authority.capabilities,
      credentialSourceHandle: authority.credentialSourceHandle,
      requiredRuntimeCapabilities: [...authority.requiredRuntimeCapabilities].reverse(),
      runtimeIdentity: authority.runtimeIdentity,
      fixedArguments: authority.fixedArguments,
      launchMode: authority.launchMode,
      executableIdentity: authority.executableIdentity,
      adapterVersion: authority.adapterVersion,
      providerVersion: authority.providerVersion,
      provider: authority.provider,
      profileId: authority.profileId,
      format: authority.format
    };
    expect(canonicalizeAiProviderAuthorityV1(reordered))
      .toBe(canonicalizeAiProviderAuthorityV1(authority));
  });

  test.each([
    ["profileId", { profileId: "codex-other" }],
    ["provider", { provider: "other" }],
    ["providerVersion", { providerVersion: "0.146.0" }],
    ["adapterVersion", { adapterVersion: "codex-app-server-family-v2" }],
    ["executableIdentity", { executableIdentity: "other-codex" }],
    ["launchMode", { launchMode: "other-mode" }],
    ["fixedArguments", { fixedArguments: ["app-server"] }],
    ["runtimeIdentity", {
      runtimeIdentity: { kind: "exact-container-user", user: "devspace" }
    }],
    ["requiredRuntimeCapabilities", {
      requiredRuntimeCapabilities: ["stdio-jsonl"]
    }],
    ["credentialSourceHandle", {
      credentialSourceHandle: "another-owner-login"
    }],
    ["capabilities", {
      capabilities: { ...authority.capabilities, resume: false }
    }],
    ["availabilityInspectionPolicy", {
      availabilityInspectionPolicy: {
        ...authority.availabilityInspectionPolicy,
        credentialProbe: "not-required"
      }
    }]
  ] as const)("changes the canonical authority when %s changes", (_field, changed) => {
    expect(canonicalizeAiProviderAuthorityV1({ ...authority, ...changed }))
      .not.toBe(canonicalizeAiProviderAuthorityV1(authority));
  });

  test("rejects omitted, unknown, and secret-value fields", () => {
    const { adapterVersion: _omitted, ...withoutAdapter } = authority;
    expect(() => canonicalizeAiProviderAuthorityV1(withoutAdapter)).toThrow();
    expect(() => canonicalizeAiProviderAuthorityV1({
      ...authority,
      displayName: "Cosmetic name"
    })).toThrow();
    expect(() => canonicalizeAiProviderAuthorityV1({
      ...authority,
      credentialValue: "secret"
    })).toThrow();
    expect(() => canonicalizeAiProviderAuthorityV1({
      ...authority,
      providerVersion: "\ud800"
    })).toThrow();
  });
});
