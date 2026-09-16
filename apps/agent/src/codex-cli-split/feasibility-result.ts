import * as z from "zod";
import { uuidV7Schema } from "@devspace/contracts";
import type { CodexSplitTransportSecurity } from "./transport.js";

export type CodexSplitFeasibilityOutcome =
  | "PASS"
  | "PASS-WITH-TRANSPORT-BLOCK"
  | "FAIL"
  | "BLOCKED/INCOMPLETE";

export type CodexSplitGateSection = "A" | "B" | "C" | "D" | "E" | "F";

const reasonSchema = z.string().min(1).max(256).regex(/^[a-z0-9][a-z0-9./_-]*$/u);

export const codexSplitGateEvidenceSchema = z.strictObject({
  admittedCodexVersion: z.literal("0.153.4"),
  sections: z.strictObject({ A: z.boolean(), B: z.boolean(), C: z.boolean(), D: z.boolean(), E: z.boolean(), F: z.boolean() }),
  transportSecurity: z.enum([
    "protocol-authenticated", "private-network-only", "unproven"
  ] satisfies readonly CodexSplitTransportSecurity[]),
  liveOperatorProof: z.boolean(),
  physicalHomeSeparation: z.boolean(),
  noLocalFallback: z.boolean(),
  controlModelEgressProven: z.boolean(),
  executorCannotReachControlEgressProven: z.boolean(),
  controlRoutingDisabledProven: z.boolean(),
  securityViolation: z.boolean(),
  incompleteReason: reasonSchema.nullable(),
  unsupportedReason: reasonSchema.nullable(),
  evidenceVersion: z.literal(1)
});
export type CodexSplitGateEvidence = z.infer<typeof codexSplitGateEvidenceSchema>;

const codexSplitProcessObservationSchema = z.strictObject({
  role: z.enum(["control", "executor"]),
  projectProcessCount: z.number().int().min(0).max(4096)
});
const codexSplitMountObservationSchema = z.strictObject({
  role: z.enum(["control", "executor"]),
  allowedMounts: z.boolean()
});
const codexSplitNetworkObservationSchema = z.strictObject({
  executionNetworkExpectedMembers: z.boolean(),
  controlEgressExpectedMembers: z.boolean(),
  controlCodexServiceReachableOnEgress: z.boolean(),
  executorEndpointReachableOnExecution: z.boolean(),
  executorEndpointReachableFromControlEgress: z.boolean(),
  executorInternetReachable: z.boolean(),
  executorControlEgressGatewayReachable: z.boolean(),
  executorControlEgressAddressReachable: z.boolean(),
  executorHostReachable: z.boolean(),
  executorUnrelatedServiceReachable: z.boolean(),
  controlForwardingDisabled: z.boolean(),
  controlRoutingCapabilitiesAbsent: z.boolean(),
  controlProxyProcessAbsent: z.boolean(),
  endpointPublished: z.boolean(),
  hostNetworkListener: z.boolean(),
  probeComplete: z.boolean(),
  securityViolation: z.boolean()
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
  "admittedCodexVersion", "sections", "transportSecurity", "liveOperatorProof", "physicalHomeSeparation",
  "noLocalFallback", "controlModelEgressProven", "executorCannotReachControlEgressProven",
  "controlRoutingDisabledProven", "securityViolation", "incompleteReason", "unsupportedReason", "evidenceVersion"
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

export function evaluateCodexSplitOutcome(input: unknown): CodexSplitFeasibilityOutcome {
  const evidence = parseEvidence(input);

  if (evidence.securityViolation) {
    return "FAIL";
  }
  if (evidence.incompleteReason !== null || evidence.unsupportedReason !== null) {
    return "BLOCKED/INCOMPLETE";
  }
  if (!evidence.physicalHomeSeparation || !evidence.noLocalFallback) return "FAIL";
  if (!everyGatePassed(evidence.sections)
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
