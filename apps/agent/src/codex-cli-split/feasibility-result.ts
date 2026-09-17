import * as z from "zod";
import { uuidV7Schema } from "@devspace/contracts";
import type { CodexSplitTransportSecurity } from "./transport.js";

export type CodexSplitFeasibilityOutcome =
  | "PASS"
  | "PASS-WITH-TRANSPORT-BLOCK"
  | "FAIL"
  | "BLOCKED/INCOMPLETE";

export type CodexSplitGateSection = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";

export type CodexSplitReadinessState =
  | "INFRASTRUCTURE_READY"
  | "MODEL_REMOTE_COMPATIBLE"
  | "READY_FOR_OPERATOR_TUI"
  | "BLOCKED/INCOMPLETE";

const reasonSchema = z.string().min(1).max(256).regex(/^[a-z0-9][a-z0-9./_-]*$/u);
const transportSecurityValues = [
  "protocol-authenticated", "private-network-only", "unproven"
] as const satisfies readonly CodexSplitTransportSecurity[];

const transportEvidenceSchema = z.strictObject({
  execServer: z.enum(transportSecurityValues),
  codeModeHost: z.enum(transportSecurityValues)
});
export type CodexSplitTransportEvidence = z.infer<typeof transportEvidenceSchema>;

const toolModeEvidenceSchema = z.union([
  z.strictObject({ kind: z.literal("protocol"), value: z.literal("CodeModeOnly") }),
  z.strictObject({
    kind: z.literal("pinned-model-metadata-plus-runtime"),
    model: z.literal("gpt-6-astra"),
    remoteCodeModeObserved: z.literal(true)
  })
]);
export type CodexSplitToolModeEvidence = z.infer<typeof toolModeEvidenceSchema>;

const modelCompatibilityProofSchema = z.strictObject({
  provenance: z.literal("real-native-app-server"),
  model: z.literal("gpt-6-astra"),
  toolModeEvidence: toolModeEvidenceSchema,
  remoteCodeModeObserved: z.literal(true),
  codeModeProvider: z.literal("remote-grpc"),
  codeModeHostContainerId: z.string().min(1).max(128),
  execServerContainerId: z.string().min(1).max(128),
  logicalCwd: z.literal("/workspace"),
  controlProjectProcessCount: z.literal(0),
  executorProjectProcessCount: z.number().int().min(0).max(4096),
  codeModeHostProcessObserved: z.literal(true),
  execServerProcessObserved: z.literal(true),
  nestedProjectExecObserved: z.literal(true),
  operationCompleted: z.literal(true),
  executorHasNativeHome: z.literal(false)
});
export type CodexSplitModelCompatibilityProof = z.infer<typeof modelCompatibilityProofSchema>;

const operatorProofSchema = z.strictObject({ provenance: z.literal("real-native-tui") });
export type CodexSplitOperatorProof = z.infer<typeof operatorProofSchema>;

const gateSectionsSchema = z.strictObject({
  A: z.boolean(), B: z.boolean(), C: z.boolean(), D: z.boolean(),
  E: z.boolean(), F: z.boolean(), G: z.boolean(), H: z.boolean()
});

export const codexSplitGateEvidenceSchema = z.strictObject({
  admittedCodexVersion: z.literal("0.153.4"),
  sections: gateSectionsSchema,
  transportSecurity: z.enum(transportSecurityValues),
  transportEvidence: transportEvidenceSchema,
  readiness: z.enum([
    "INFRASTRUCTURE_READY", "MODEL_REMOTE_COMPATIBLE", "READY_FOR_OPERATOR_TUI", "BLOCKED/INCOMPLETE"
  ] satisfies readonly CodexSplitReadinessState[]),
  realModelProof: modelCompatibilityProofSchema.nullable(),
  operatorProof: operatorProofSchema.nullable(),
  liveOperatorProof: z.boolean(),
  physicalHomeSeparation: z.boolean(),
  noLocalFallback: z.boolean(),
  controlModelEgressProven: z.boolean(),
  executorCannotReachControlEgressProven: z.boolean(),
  controlRoutingDisabledProven: z.boolean(),
  securityViolation: z.boolean(),
  incompleteReason: reasonSchema.nullable(),
  unsupportedReason: reasonSchema.nullable(),
  evidenceVersion: z.literal(2)
});
export type CodexSplitGateEvidence = z.infer<typeof codexSplitGateEvidenceSchema>;

const codexSplitProcessObservationSchema = z.strictObject({
  role: z.enum(["control", "executor"]),
  projectProcessCount: z.number().int().min(0).max(4096),
  observationComplete: z.boolean()
});
const codexSplitMountObservationSchema = z.strictObject({
  role: z.enum(["control", "executor"]),
  allowedMounts: z.boolean()
});
const codexSplitNetworkObservationSchema = z.strictObject({
  executionNetworkExpectedMembers: z.boolean().nullable(),
  controlEgressExpectedMembers: z.boolean().nullable(),
  controlCodexServiceReachableOnEgress: z.boolean().nullable(),
  executorEndpointReachableOnExecution: z.boolean().nullable(),
  executorEndpointReachableFromControlEgress: z.boolean().nullable(),
  executorInternetReachable: z.boolean().nullable(),
  executorControlEgressGatewayReachable: z.boolean().nullable(),
  executorControlEgressAddressReachable: z.boolean().nullable(),
  executorHostReachable: z.boolean().nullable(),
  executorUnrelatedServiceReachable: z.boolean().nullable(),
  controlForwardingDisabled: z.boolean().nullable(),
  controlRoutingCapabilitiesAbsent: z.boolean().nullable(),
  controlProxyProcessAbsent: z.boolean().nullable(),
  endpointPublished: z.boolean().nullable(),
  hostNetworkListener: z.boolean().nullable(),
  probeComplete: z.boolean(),
  securityViolation: z.boolean().nullable()
});

/** The bounded, explicitly known extension emitted by the live verifier. */
export const codexSplitLiveEvidenceSchema = z.strictObject({
  ...codexSplitGateEvidenceSchema.shape,
  runId: uuidV7Schema,
  processObservations: z.array(codexSplitProcessObservationSchema).max(4096),
  mountObservations: z.array(codexSplitMountObservationSchema).max(16),
  networkObservations: z.array(codexSplitNetworkObservationSchema).max(16)
});
export type CodexSplitLiveGateEvidence = z.infer<typeof codexSplitLiveEvidenceSchema>;

const baseEvidenceKeys = [
  "admittedCodexVersion", "sections", "transportSecurity", "transportEvidence", "readiness",
  "realModelProof", "operatorProof", "liveOperatorProof", "physicalHomeSeparation", "noLocalFallback",
  "controlModelEgressProven", "executorCannotReachControlEgressProven", "controlRoutingDisabledProven",
  "securityViolation", "incompleteReason", "unsupportedReason", "evidenceVersion"
] as const;
const liveEvidenceKeys = new Set(["runId", "processObservations", "mountObservations", "networkObservations"]);

function hasLiveEvidenceExtension(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    && [...liveEvidenceKeys].some((key) => Object.prototype.hasOwnProperty.call(input, key));
}

function parseEvidence(input: unknown): CodexSplitGateEvidence {
  if (hasLiveEvidenceExtension(input)) {
    const live = codexSplitLiveEvidenceSchema.safeParse(input);
    if (!live.success) throw new Error("codex-split-feasibility-evidence", { cause: live.error });
    const base = codexSplitGateEvidenceSchema.safeParse(Object.fromEntries(
      baseEvidenceKeys.map((key) => [key, live.data[key]])
    ));
    if (!base.success) throw new Error("codex-split-feasibility-evidence", { cause: base.error });
    return base.data;
  }
  const base = codexSplitGateEvidenceSchema.safeParse(input);
  if (!base.success) throw new Error("codex-split-feasibility-evidence", { cause: base.error });
  return base.data;
}

function everyGatePassed(sections: Readonly<Record<CodexSplitGateSection, boolean>>): boolean {
  return Object.values(sections).every((passed) => passed === true);
}

function aggregateTransportSecurity(transport: CodexSplitTransportEvidence): CodexSplitTransportSecurity {
  if (transport.execServer === "unproven" || transport.codeModeHost === "unproven") return "unproven";
  if (transport.execServer === "private-network-only" || transport.codeModeHost === "private-network-only") {
    return "private-network-only";
  }
  return "protocol-authenticated";
}

export function evaluateCodexSplitOutcome(input: unknown): CodexSplitFeasibilityOutcome {
  const evidence = parseEvidence(input);

  if (evidence.securityViolation) return "FAIL";
  if (evidence.incompleteReason !== null || evidence.unsupportedReason !== null) return "BLOCKED/INCOMPLETE";
  if (!evidence.physicalHomeSeparation || !evidence.noLocalFallback) return "FAIL";
  if (aggregateTransportSecurity(evidence.transportEvidence) !== evidence.transportSecurity) {
    return "BLOCKED/INCOMPLETE";
  }
  if (evidence.readiness !== "READY_FOR_OPERATOR_TUI"
    || evidence.realModelProof === null
    || evidence.operatorProof === null
    || !everyGatePassed(evidence.sections)
    || !evidence.controlModelEgressProven
    || !evidence.executorCannotReachControlEgressProven
    || !evidence.controlRoutingDisabledProven
    || !evidence.liveOperatorProof
    || evidence.transportSecurity === "unproven") {
    return "BLOCKED/INCOMPLETE";
  }
  if (evidence.transportSecurity === "private-network-only") return "PASS-WITH-TRANSPORT-BLOCK";
  return "PASS";
}
