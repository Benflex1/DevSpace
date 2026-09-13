import { createHash } from "node:crypto";
import path from "node:path";
import {
  CODEX_COMPATIBILITY_POLICY_VERSION,
  CODEX_MINIMUM_SUPPORTED_VERSION,
  CODEX_SEMANTIC_ADAPTER_VERSION,
  type CodexCapabilitySet,
  type CodexCompatibilityDiagnostic,
  type CodexCompatibilityFeatureResult,
  type CodexFeature,
  type CodexProfileAuthorityInput,
  type CodexProbeRuntimeIdentity
} from "@devspace/contracts";
import type { DockerEngineClient } from "../docker-runtime.js";
import {
  CODEX_AUTH_CREDENTIAL_SOURCE_IDENTITY
} from "../codex-credential-authority.js";
import type { WorkspaceExecutionContext } from "../managed-workspaces.js";
import {
  resolveCodexExecutionArtifact,
  stageCodexExecutionArtifact,
  type CodexExecutionArtifact,
  type StagedCodexExecutionArtifact
} from "./artifact-identity.js";
import { CodexDiscoveryCache, type CodexDiscoveryCacheKey, type CodexDiscoveryCacheValue } from "./discovery-cache.js";
import { evaluateCodexCompatibility } from "./schema-compatibility.js";
import { loadCodexSchemaBundle } from "./schema-bundle.js";
import { createCodexProbeRuntime, type CodexProbeResult, type CodexProbeRuntime } from "./probe-runtime.js";
import type { CodexCompatibilityEvaluation } from "./types.js";

const CODEX_SCHEMA_COMMAND_CONTRACT = "codex-app-server-schema-v1" as const;
const emptySchemaFingerprint = createHash("sha256").update("", "utf8").digest("hex");
const discoveryInFlight = new Map<string, Promise<CodexDiscoveryResult>>();

export interface CodexDiscoveryResult {
  readonly artifact: CodexExecutionArtifact;
  readonly stagedArtifact: StagedCodexExecutionArtifact;
  readonly probe: CodexProbeResult;
  readonly compatibility: CodexCompatibilityEvaluation;
  readonly profileAuthority: CodexProfileAuthorityInput;
}

export function parseCodexVersion(output: string): string | null {
  if (typeof output !== "string" || output.length > 256) return null;
  const match = /^(?:codex-cli|codex)\s+(\d+\.\d+\.\d+)$/iu.exec(output.trim());
  return match?.[1] ?? null;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index]! !== rightParts[index]!) return leftParts[index]! < rightParts[index]! ? -1 : 1;
  }
  return 0;
}

function unavailableCapabilities(): CodexCapabilitySet {
  return {
    inspect: true, start: true, resume: false, sendTurn: true, interrupt: false,
    approvals: false, structuredInput: false, stop: true, streamEvents: true
  };
}

function unavailableFeatures(diagnostic: CodexCompatibilityDiagnostic): Record<CodexFeature, CodexCompatibilityFeatureResult> {
  return {
    basicSession: { feature: "basicSession", state: "incompatible", reason: diagnostic },
    approvals: { feature: "approvals", state: "incompatible", reason: diagnostic },
    structuredInput: { feature: "structuredInput", state: "missing", reason: diagnostic },
    interrupt: { feature: "interrupt", state: "missing", reason: diagnostic }
  };
}

function unavailableEvaluation(diagnostic: CodexCompatibilityDiagnostic): CodexCompatibilityEvaluation {
  return {
    transport: "incompatible", features: unavailableFeatures(diagnostic), capabilities: unavailableCapabilities(), diagnostic,
    stableSchemaFingerprint: emptySchemaFingerprint, experimentalSchemaFingerprint: emptySchemaFingerprint
  };
}

function experimentalFingerprint(probe: CodexProbeResult, compatibility: CodexCompatibilityEvaluation): string | null {
  return compatibility.transport === "compatible"
    && [...probe.schemaFiles.keys()].some((file) => file.startsWith("experimental/"))
    ? compatibility.experimentalSchemaFingerprint : null;
}

function cacheKey(artifact: CodexExecutionArtifact, runtime: CodexProbeRuntimeIdentity): CodexDiscoveryCacheKey {
  return {
    closureDigest: artifact.closureDigest, probeRuntimeIdentity: runtime,
    schemaCommandContract: CODEX_SCHEMA_COMMAND_CONTRACT, cacheFormat: "codex-discovery-cache-v1",
    semanticAdapterVersion: CODEX_SEMANTIC_ADAPTER_VERSION, compatibilityPolicyVersion: CODEX_COMPATIBILITY_POLICY_VERSION
  };
}

function compatibilityFromCache(value: CodexDiscoveryCacheValue): CodexCompatibilityEvaluation {
  return {
    transport: value.diagnostic === null || value.diagnostic === "CODEX_APPROVAL_PROTOCOL_UNAVAILABLE"
      ? "compatible" : "incompatible",
    features: value.featureResults, capabilities: value.capabilities, diagnostic: value.diagnostic,
    stableSchemaFingerprint: value.stableSchemaFingerprint,
    experimentalSchemaFingerprint: value.experimentalSchemaFingerprint ?? emptySchemaFingerprint
  };
}

function cacheValue(input: {
  readonly key: CodexDiscoveryCacheKey;
  readonly reportedVersion: string;
  readonly compatibility: CodexCompatibilityEvaluation;
  readonly experimentalSchemaFingerprint: string | null;
}): CodexDiscoveryCacheValue {
  return {
    key: input.key, reportedVersion: input.reportedVersion,
    stableSchemaFingerprint: input.compatibility.stableSchemaFingerprint,
    experimentalSchemaFingerprint: input.experimentalSchemaFingerprint,
    featureResults: input.compatibility.features, capabilities: input.compatibility.capabilities,
    diagnostic: input.compatibility.diagnostic
  };
}

function profileAuthority(input: {
  readonly artifact: CodexExecutionArtifact;
  readonly runtime: CodexProbeRuntimeIdentity;
  readonly version: string;
  readonly compatibility: CodexCompatibilityEvaluation;
  readonly experimentalSchemaFingerprint: string | null;
  readonly workspaceContext: WorkspaceExecutionContext;
}): CodexProfileAuthorityInput {
  return {
    providerKind: "codex", reportedVersion: input.version,
    entrypointSha256: input.artifact.entrypointSha256,
    executionArtifactClosureDigest: input.artifact.closureDigest,
    executionArtifactLayout: input.artifact.layout, protocolFamily: "stdio-jsonl",
    stableSchemaFingerprint: input.compatibility.stableSchemaFingerprint,
    experimentalSchemaFingerprint: input.experimentalSchemaFingerprint,
    effectiveCapabilities: input.compatibility.capabilities,
    experimentalApi: input.experimentalSchemaFingerprint !== null,
    approvalPolicy: "on-request", approvalsReviewer: "user",
    semanticAdapterVersion: CODEX_SEMANTIC_ADAPTER_VERSION,
    compatibilityPolicyVersion: CODEX_COMPATIBILITY_POLICY_VERSION,
    probeRuntimeIdentity: input.runtime,
    credentialSourceIdentity: CODEX_AUTH_CREDENTIAL_SOURCE_IDENTITY,
    runtimeIdentity: {
      projectId: input.workspaceContext.projectId, workspaceId: input.workspaceContext.workspaceId,
      revisionId: input.workspaceContext.revisionId, runtimePlanHash: input.workspaceContext.runtimePlanHash,
      runtimeGeneration: input.workspaceContext.generation
    }
  };
}

async function evaluateDiscovered(input: {
  readonly artifact: CodexExecutionArtifact;
  readonly stagedArtifact: StagedCodexExecutionArtifact;
  readonly probeRuntime: CodexProbeRuntime;
  readonly workspaceContext: WorkspaceExecutionContext;
  readonly stateRoot: string;
}): Promise<CodexDiscoveryResult> {
  const runtime = input.probeRuntime.inspect === undefined
    ? null
    : await input.probeRuntime.inspect({ managedContainerId: input.workspaceContext.ownership.developmentContainer.id,
      stagedArtifact: input.stagedArtifact, workspaceContext: input.workspaceContext });
  const probe = runtime === null
    ? await input.probeRuntime.probe({ managedContainerId: input.workspaceContext.ownership.developmentContainer.id,
      stagedArtifact: input.stagedArtifact, workspaceContext: input.workspaceContext })
    : null;
  const runtimeIdentity = runtime ?? probe!.runtime;
  const key = cacheKey(input.artifact, runtimeIdentity);
  const cache = new CodexDiscoveryCache(input.stateRoot);
  const cached = await cache.read(key);
  if (cached !== null) {
    const compatibility = compatibilityFromCache(cached);
    const cachedProbe: CodexProbeResult = {
      runtime: runtimeIdentity, versionOutput: `codex-cli ${cached.reportedVersion}`, schemaFiles: new Map()
    };
    return {
      artifact: input.artifact, stagedArtifact: input.stagedArtifact, probe: cachedProbe, compatibility,
      profileAuthority: profileAuthority({ artifact: input.artifact, runtime: runtimeIdentity, version: cached.reportedVersion,
        compatibility, experimentalSchemaFingerprint: cached.experimentalSchemaFingerprint, workspaceContext: input.workspaceContext })
    };
  }

  const observedProbe = probe ?? await input.probeRuntime.probe({
    managedContainerId: input.workspaceContext.ownership.developmentContainer.id,
    stagedArtifact: input.stagedArtifact, workspaceContext: input.workspaceContext
  });
  const reportedVersion = parseCodexVersion(observedProbe.versionOutput);
  let compatibility: CodexCompatibilityEvaluation;
  if (reportedVersion === null) compatibility = unavailableEvaluation("CODEX_VERSION_UNREADABLE");
  else if (compareVersions(reportedVersion, CODEX_MINIMUM_SUPPORTED_VERSION) < 0) compatibility = unavailableEvaluation("CODEX_VERSION_BELOW_MINIMUM");
  else {
    try {
      compatibility = evaluateCodexCompatibility(loadCodexSchemaBundle(observedProbe.schemaFiles));
    } catch {
      compatibility = unavailableEvaluation("CODEX_SCHEMA_DISCOVERY_FAILED");
    }
  }
  const experimental = experimentalFingerprint(observedProbe, compatibility);
  try {
    await cache.write(cacheValue({ key, reportedVersion: reportedVersion ?? "0.0.0", compatibility,
      experimentalSchemaFingerprint: experimental }));
  } catch {
    // Compatibility remains valid when the private cache is temporarily unavailable.
  }
  return {
    artifact: input.artifact, stagedArtifact: input.stagedArtifact, probe: observedProbe, compatibility,
    profileAuthority: profileAuthority({ artifact: input.artifact, runtime: observedProbe.runtime,
      version: reportedVersion ?? "0.0.0", compatibility, experimentalSchemaFingerprint: experimental,
      workspaceContext: input.workspaceContext })
  };
}

export async function discoverCodex(input: {
  readonly configuredPath: string;
  readonly managedContainerId: string;
  readonly workspaceContext: WorkspaceExecutionContext;
  readonly stateRoot: string;
  readonly docker: DockerEngineClient;
  readonly createId: () => string;
  readonly probeRuntime?: CodexProbeRuntime;
}): Promise<CodexDiscoveryResult> {
  const artifact = await resolveCodexExecutionArtifact(input.configuredPath);
  const stagedArtifact = await stageCodexExecutionArtifact({ artifact, stateRoot: input.stateRoot });
  const flightKey = `${pathKey(input.stateRoot)}:${artifact.closureDigest}`;
  const existing = discoveryInFlight.get(flightKey);
  if (existing !== undefined) return await existing;
  const probeRuntime = input.probeRuntime ?? createCodexProbeRuntime({ docker: input.docker, createId: input.createId });
  const promise = evaluateDiscovered({ artifact, stagedArtifact, probeRuntime, workspaceContext: input.workspaceContext, stateRoot: input.stateRoot });
  discoveryInFlight.set(flightKey, promise);
  try { return await promise; }
  finally { discoveryInFlight.delete(flightKey); }
}

function pathKey(value: string): string {
  return value.replaceAll("\\", "/");
}
