import * as z from "zod";
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

function parseEvidence(input: CodexSplitGateEvidence): CodexSplitGateEvidence {
  const parsed = codexSplitGateEvidenceSchema.safeParse(input);
  if (!parsed.success) throw new Error("codex-split-feasibility-evidence", { cause: parsed.error });
  return parsed.data;
}

function everyGatePassed(sections: Readonly<Record<CodexSplitGateSection, boolean>>): boolean {
  return Object.values(sections).every((passed) => passed === true);
}

export function evaluateCodexSplitOutcome(input: CodexSplitGateEvidence): CodexSplitFeasibilityOutcome {
  const evidence = parseEvidence(input);

  if (evidence.securityViolation || !evidence.physicalHomeSeparation || !evidence.noLocalFallback) {
    return "FAIL";
  }
  if (!everyGatePassed(evidence.sections)
    || !evidence.controlModelEgressProven
    || !evidence.executorCannotReachControlEgressProven
    || !evidence.controlRoutingDisabledProven
    || !evidence.liveOperatorProof
    || evidence.incompleteReason !== null
    || evidence.unsupportedReason !== null
    || evidence.transportSecurity === "unproven") {
    return "BLOCKED/INCOMPLETE";
  }
  if (evidence.transportSecurity === "private-network-only") return "PASS-WITH-TRANSPORT-BLOCK";
  return "PASS";
}
