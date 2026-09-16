import { expect, test } from "vitest";
import {
  evaluateCodexSplitOutcome,
  type CodexSplitGateEvidence
} from "./feasibility-result.js";

function evidence(overrides: Partial<CodexSplitGateEvidence> = {}): CodexSplitGateEvidence {
  return {
    admittedCodexVersion: "0.153.4",
    sections: { A: true, B: true, C: true, D: true, E: true, F: true },
    transportSecurity: "protocol-authenticated",
    liveOperatorProof: true,
    physicalHomeSeparation: true,
    noLocalFallback: true,
    controlModelEgressProven: true,
    executorCannotReachControlEgressProven: true,
    controlRoutingDisabledProven: true,
    securityViolation: false,
    incompleteReason: null,
    unsupportedReason: null,
    evidenceVersion: 1,
    ...overrides
  };
}

test("returns PASS only for complete live evidence with authenticated transport", () => {
  expect(evaluateCodexSplitOutcome(evidence())).toBe("PASS");
  expect(evaluateCodexSplitOutcome(evidence({ transportSecurity: "private-network-only" }))).toBe("PASS-WITH-TRANSPORT-BLOCK");
});

test("returns FAIL before incomplete when a security invariant is disproven", () => {
  expect(evaluateCodexSplitOutcome(evidence({ securityViolation: true, incompleteReason: "operator-aborted" }))).toBe("FAIL");
  expect(evaluateCodexSplitOutcome(evidence({ physicalHomeSeparation: false }))).toBe("FAIL");
  expect(evaluateCodexSplitOutcome(evidence({ noLocalFallback: false }))).toBe("FAIL");
});

test("returns BLOCKED/INCOMPLETE for absent proof, unsupported transport, or an incomplete section", () => {
  expect(evaluateCodexSplitOutcome(evidence({ liveOperatorProof: false }))).toBe("BLOCKED/INCOMPLETE");
  expect(evaluateCodexSplitOutcome(evidence({ incompleteReason: "operator-aborted" }))).toBe("BLOCKED/INCOMPLETE");
  expect(evaluateCodexSplitOutcome(evidence({ transportSecurity: "unproven" }))).toBe("BLOCKED/INCOMPLETE");
  expect(evaluateCodexSplitOutcome(evidence({ sections: { A: true, B: true, C: true, D: false, E: true, F: true } })))
    .toBe("BLOCKED/INCOMPLETE");
  expect(evaluateCodexSplitOutcome(evidence({ controlModelEgressProven: false }))).toBe("BLOCKED/INCOMPLETE");
  expect(evaluateCodexSplitOutcome(evidence({ executorCannotReachControlEgressProven: false }))).toBe("BLOCKED/INCOMPLETE");
  expect(evaluateCodexSplitOutcome(evidence({ controlRoutingDisabledProven: false }))).toBe("BLOCKED/INCOMPLETE");
  expect(evaluateCodexSplitOutcome(evidence({ physicalHomeSeparation: false, incompleteReason: "preflight-incomplete" })))
    .toBe("BLOCKED/INCOMPLETE");
});

test("does not treat mocked evidence as live and rejects malformed or secret-looking evidence", () => {
  expect(evaluateCodexSplitOutcome(evidence({ liveOperatorProof: false, transportSecurity: "protocol-authenticated" })))
    .toBe("BLOCKED/INCOMPLETE");
  expect(() => evaluateCodexSplitOutcome({ ...evidence(), nativeHomeContents: "secret" } as unknown as CodexSplitGateEvidence))
    .toThrow("feasibility-evidence");
  expect(() => evaluateCodexSplitOutcome({ ...evidence(), admittedCodexVersion: "0.154.0" } as unknown as CodexSplitGateEvidence))
    .toThrow("feasibility-evidence");
});
