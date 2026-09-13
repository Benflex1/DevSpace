import * as z from "zod";

export const CODEX_MINIMUM_SUPPORTED_VERSION = "0.145.0" as const;
export const CODEX_SEMANTIC_ADAPTER_VERSION = "codex-app-server-family-v1" as const;
export const CODEX_COMPATIBILITY_POLICY_VERSION = "codex-compatibility-v1" as const;

export type CodexSurface = "stable" | "experimental";
export type CodexFeature =
  | "basicSession"
  | "approvals"
  | "structuredInput"
  | "interrupt";

export type CodexCapabilitySet = Readonly<{
  inspect: true;
  start: true;
  resume: boolean;
  sendTurn: true;
  interrupt: boolean;
  approvals: boolean;
  structuredInput: boolean;
  stop: true;
  streamEvents: true;
}>;

/** Agent-private discovery/compatibility diagnostic; never a browser or SQLite field. */
export const codexCompatibilityDiagnostics = Object.freeze([
  "CODEX_EXECUTABLE_MISSING",
  "CODEX_EXECUTABLE_INTEGRITY_CHANGED",
  "CODEX_UNRECOGNIZED_EXECUTION_FORM",
  "CODEX_VERSION_UNREADABLE",
  "CODEX_VERSION_BELOW_MINIMUM",
  "CODEX_PROBE_RUNTIME_UNAVAILABLE",
  "CODEX_SCHEMA_DISCOVERY_FAILED",
  "CODEX_PROTOCOL_INCOMPATIBLE",
  "CODEX_APPROVAL_PROTOCOL_UNAVAILABLE",
  "CODEX_REQUIRED_CAPABILITY_UNAVAILABLE",
  "CODEX_INITIALIZE_NEGOTIATION_FAILED",
  "CODEX_UNKNOWN_BLOCKING_REQUEST",
  "CODEX_PROFILE_CHANGED",
  "CODEX_DISCOVERY_CACHE_INVALID"
] as const);

export type CodexCompatibilityDiagnostic =
  typeof codexCompatibilityDiagnostics[number];

/** Existing bounded Web availability vocabulary; private discovery codes map into it. */
export type CodexPublicAvailabilityDiagnostic =
  | "PROFILE_DISABLED"
  | "EXECUTABLE_MISSING"
  | "VERSION_MISMATCH"
  | "RUNTIME_IDENTITY_UNAVAILABLE"
  | "CREDENTIAL_SOURCE_UNAVAILABLE"
  | "WORKSPACE_REQUIREMENT_UNMET";

/** Safe session-loss vocabulary added for an unknown blocking provider request. */
export type CodexPublicSessionDiagnostic = "CODEX_UNKNOWN_BLOCKING_REQUEST";

export function mapCodexDiagnosticToPublicAvailability(
  diagnostic: CodexCompatibilityDiagnostic
): CodexPublicAvailabilityDiagnostic | null {
  switch (diagnostic) {
    case "CODEX_EXECUTABLE_MISSING":
      return "EXECUTABLE_MISSING";
    case "CODEX_VERSION_UNREADABLE":
    case "CODEX_VERSION_BELOW_MINIMUM":
      return "VERSION_MISMATCH";
    case "CODEX_PROBE_RUNTIME_UNAVAILABLE":
      return "RUNTIME_IDENTITY_UNAVAILABLE";
    case "CODEX_UNKNOWN_BLOCKING_REQUEST":
    case "CODEX_PROFILE_CHANGED":
      return null;
    default:
      return "PROFILE_DISABLED";
  }
}

export const codexAppServerProtocolMethods = Object.freeze({
  clientRequests: Object.freeze([
    "initialize",
    "thread/start",
    "thread/resume",
    "turn/start",
    "turn/interrupt"
  ]),
  clientNotifications: Object.freeze(["initialized"]),
  serverNotifications: Object.freeze([
    "thread/started",
    "turn/started",
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "turn/completed"
  ]),
  stableServerRequests: Object.freeze([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval"
  ]),
  experimentalServerRequests: Object.freeze([
    "item/tool/requestUserInput"
  ])
} as const);

const codexFixtureMethodListSchema = z.array(z.string().min(1)).max(128);

export const codexAppServerFixtureManifestSchema = z.strictObject({
  baselineVersion: z.literal(CODEX_MINIMUM_SUPPORTED_VERSION),
  cliVersion: z.string().min(1).max(128),
  versionOutput: z.string().min(1).max(256),
  cliBinarySha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  stableGenerationCommand: z.literal(
    "codex app-server generate-json-schema --out <directory>"
  ),
  experimentalGenerationCommand: z.literal(
    "codex app-server generate-json-schema --experimental --out <directory>"
  ),
  transport: z.strictObject({
    mode: z.literal("stdio-jsonl"),
    tty: z.literal(false),
    stdout: z.literal("protocol-only"),
    stderr: z.literal("private-diagnostics")
  }),
  officialSource: z.string().url(),
  upstreamLicense: z.literal("Apache-2.0"),
  fixtures: z.array(z.strictObject({
    scope: z.enum(["stable-default", "experimental"]),
    file: z.string().regex(/^(?:stable|experimental)\/[A-Za-z0-9]+\.json$/u),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u)
  })).max(16),
  methods: z.strictObject({
    clientRequests: codexFixtureMethodListSchema,
    clientNotifications: codexFixtureMethodListSchema,
    serverNotifications: codexFixtureMethodListSchema,
    stableServerRequests: codexFixtureMethodListSchema,
    experimentalServerRequests: codexFixtureMethodListSchema
  })
});

export type CodexCompatibilityFeatureResult = Readonly<{
  feature: CodexFeature;
  state: "supported" | "missing" | "incompatible";
  reason: string | null;
}>;

export type CodexArtifactLayout =
  | "standalone-package"
  | "official-node-native-payload"
  | "self-contained-native";

export interface CodexProbeRuntimeIdentity {
  readonly imageId: string;
  readonly operatingSystem: string;
  readonly architecture: string;
  readonly containerUser: string;
  readonly policyVersion: "codex-probe-runtime-v1";
}

export interface CodexProfileAuthorityInput {
  readonly providerKind: "codex";
  readonly reportedVersion: string;
  readonly entrypointSha256: string;
  readonly executionArtifactClosureDigest: string;
  readonly executionArtifactLayout: CodexArtifactLayout;
  readonly protocolFamily: "stdio-jsonl";
  readonly stableSchemaFingerprint: string;
  readonly experimentalSchemaFingerprint: string | null;
  readonly effectiveCapabilities: CodexCapabilitySet;
  readonly experimentalApi: boolean;
  readonly approvalPolicy: "on-request";
  readonly approvalsReviewer: "user";
  readonly semanticAdapterVersion: string;
  readonly compatibilityPolicyVersion: string;
  readonly probeRuntimeIdentity: CodexProbeRuntimeIdentity;
  readonly credentialSourceIdentity: string;
  readonly runtimeIdentity: {
    readonly projectId: string;
    readonly workspaceId: string;
    readonly revisionId: string;
    readonly runtimePlanHash: string;
    readonly runtimeGeneration: number;
  };
}
