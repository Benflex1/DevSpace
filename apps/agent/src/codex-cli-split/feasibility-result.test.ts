import { expect, test } from "vitest";
import {
  codexSplitGateEvidenceSchema,
  codexSplitLiveEvidenceSchema,
  evaluateCodexSplitOutcome,
  type CodexSplitGateEvidence,
  type CodexSplitModelCompatibilityProof
} from "./feasibility-result.js";

const modelProof: CodexSplitModelCompatibilityProof = {
  provenance: "real-native-app-server",
  model: "gpt-6-astra",
  toolModeEvidence: { kind: "protocol", value: "CodeModeOnly" },
  remoteCodeModeObserved: true,
  codeModeProvider: "remote-grpc",
  codeModeHostContainerId: "executor-id",
  execServerContainerId: "executor-id",
  logicalCwd: "/workspace",
  controlProjectProcessCount: 0,
  executorProjectProcessCount: 1,
  codeModeHostProcessObserved: true,
  execServerProcessObserved: true,
  nestedProjectExecObserved: true,
  operationCompleted: true,
  executorHasNativeHome: false
};

function evidence(overrides: Partial<CodexSplitGateEvidence> = {}): CodexSplitGateEvidence {
  return {
    admittedCodexVersion: "0.153.4",
    sections: { A: true, B: true, C: true, D: true, E: true, F: true, G: true, H: true },
    transportSecurity: "protocol-authenticated",
    transportEvidence: { execServer: "protocol-authenticated", codeModeHost: "protocol-authenticated" },
    readiness: "READY_FOR_OPERATOR_TUI",
    realModelProof: modelProof,
    operatorProof: { provenance: "real-native-tui" },
    liveOperatorProof: true,
    physicalHomeSeparation: true,
    noLocalFallback: true,
    controlModelEgressProven: true,
    executorCannotReachControlEgressProven: true,
    controlRoutingDisabledProven: true,
    securityViolation: false,
    incompleteReason: null,
    unsupportedReason: null,
    evidenceVersion: 2,
    ...overrides
  };
}

test("returns PASS only for complete live evidence with authenticated transport", () => {
  expect(evaluateCodexSplitOutcome(evidence())).toBe("PASS");
  expect(evaluateCodexSplitOutcome(evidence({
    transportSecurity: "private-network-only",
    transportEvidence: { execServer: "private-network-only", codeModeHost: "private-network-only" }
  }))).toBe("PASS-WITH-TRANSPORT-BLOCK");
});

test("returns FAIL before incomplete when a security invariant is disproven", () => {
  expect(evaluateCodexSplitOutcome(evidence({ securityViolation: true, incompleteReason: "operator-aborted" }))).toBe("FAIL");
  expect(evaluateCodexSplitOutcome(evidence({ physicalHomeSeparation: false }))).toBe("FAIL");
  expect(evaluateCodexSplitOutcome(evidence({ noLocalFallback: false }))).toBe("FAIL");
});

test("returns BLOCKED/INCOMPLETE for absent proof, unsupported transport, or an incomplete section", () => {
  expect(evaluateCodexSplitOutcome(evidence({ liveOperatorProof: false }))).toBe("BLOCKED/INCOMPLETE");
  expect(evaluateCodexSplitOutcome(evidence({ incompleteReason: "operator-aborted" }))).toBe("BLOCKED/INCOMPLETE");
  expect(evaluateCodexSplitOutcome(evidence({
    transportSecurity: "unproven",
    transportEvidence: { execServer: "unproven", codeModeHost: "unproven" }
  }))).toBe("BLOCKED/INCOMPLETE");
  expect(evaluateCodexSplitOutcome(evidence({ sections: { A: true, B: true, C: true, D: false, E: true, F: true, G: true, H: true } })))
    .toBe("BLOCKED/INCOMPLETE");
  expect(evaluateCodexSplitOutcome(evidence({ controlModelEgressProven: false }))).toBe("BLOCKED/INCOMPLETE");
  expect(evaluateCodexSplitOutcome(evidence({ executorCannotReachControlEgressProven: false }))).toBe("BLOCKED/INCOMPLETE");
  expect(evaluateCodexSplitOutcome(evidence({ controlRoutingDisabledProven: false }))).toBe("BLOCKED/INCOMPLETE");
  expect(evaluateCodexSplitOutcome(evidence({ physicalHomeSeparation: false, incompleteReason: "preflight-incomplete" })))
    .toBe("BLOCKED/INCOMPLETE");
});

test("requires real model compatibility and native operator provenance for either pass state", () => {
  expect(evaluateCodexSplitOutcome(evidence({ realModelProof: null }))).toBe("BLOCKED/INCOMPLETE");
  expect(evaluateCodexSplitOutcome(evidence({ operatorProof: null, liveOperatorProof: false }))).toBe("BLOCKED/INCOMPLETE");
  expect(evaluateCodexSplitOutcome(evidence({ readiness: "INFRASTRUCTURE_READY", realModelProof: null, operatorProof: null, liveOperatorProof: false })))
    .toBe("BLOCKED/INCOMPLETE");
  expect(evaluateCodexSplitOutcome(evidence({
    transportEvidence: { execServer: "private-network-only", codeModeHost: "private-network-only" },
    transportSecurity: "private-network-only"
  }))).toBe("PASS-WITH-TRANSPORT-BLOCK");
});

test("keeps unknown network observations distinct from proven negative observations", () => {
  const liveEvidence = {
    ...evidence(),
    runId: "018f0f00-0000-7000-8000-000000000006",
    processObservations: [],
    mountObservations: [],
    networkObservations: [{
      executionNetworkExpectedMembers: null,
      controlEgressExpectedMembers: null,
      controlCodexServiceReachableOnEgress: null,
      executorEndpointReachableOnExecution: null,
      executorEndpointReachableFromControlEgress: null,
      executorInternetReachable: null,
      executorControlEgressGatewayReachable: null,
      executorControlEgressAddressReachable: null,
      executorHostReachable: null,
      executorUnrelatedServiceReachable: null,
      controlForwardingDisabled: null,
      controlRoutingCapabilitiesAbsent: null,
      controlProxyProcessAbsent: null,
      endpointPublished: null,
      hostNetworkListener: null,
      probeComplete: false,
      securityViolation: null
    }]
  };
  expect(codexSplitLiveEvidenceSchema.parse(liveEvidence).networkObservations[0]?.controlForwardingDisabled).toBeNull();
  expect(evaluateCodexSplitOutcome(liveEvidence)).toBe("PASS");
});

test("does not treat mocked evidence as live and rejects malformed or secret-looking evidence", () => {
  expect(evaluateCodexSplitOutcome(evidence({ liveOperatorProof: false, transportSecurity: "protocol-authenticated" })))
    .toBe("BLOCKED/INCOMPLETE");
  expect(() => evaluateCodexSplitOutcome({ ...evidence(), nativeHomeContents: "secret" }))
    .toThrow("feasibility-evidence");
  expect(() => evaluateCodexSplitOutcome({ ...evidence(), admittedCodexVersion: "0.154.0" }))
    .toThrow("feasibility-evidence");
});

test("evaluates a known live-evidence extension without replacing an incomplete result with a schema error", () => {
  const liveEvidence = {
    ...evidence({
      sections: { A: false, B: false, C: false, D: false, E: false, F: false, G: false, H: false },
      transportSecurity: "unproven",
      liveOperatorProof: false,
      physicalHomeSeparation: false,
      noLocalFallback: false,
      controlModelEgressProven: false,
      executorCannotReachControlEgressProven: false,
      controlRoutingDisabledProven: false,
      incompleteReason: "codex-executor-start-failed"
    }),
    runId: "018f0f00-0000-7000-8000-000000000004",
    processObservations: [{ role: "executor", projectProcessCount: 0, observationComplete: false }],
    mountObservations: [{ role: "control", allowedMounts: true }, { role: "executor", allowedMounts: false }],
    networkObservations: [{
      executionNetworkExpectedMembers: true,
      controlEgressExpectedMembers: true,
      controlCodexServiceReachableOnEgress: false,
      executorEndpointReachableOnExecution: false,
      executorEndpointReachableFromControlEgress: false,
      executorInternetReachable: false,
      executorControlEgressGatewayReachable: false,
      executorControlEgressAddressReachable: false,
      executorHostReachable: false,
      executorUnrelatedServiceReachable: false,
      controlForwardingDisabled: true,
      controlRoutingCapabilitiesAbsent: true,
      controlProxyProcessAbsent: true,
      endpointPublished: false,
      hostNetworkListener: false,
      probeComplete: false,
      securityViolation: false
    }]
  };
  expect(() => codexSplitGateEvidenceSchema.parse(liveEvidence)).toThrow();
  const parsed = codexSplitLiveEvidenceSchema.parse(liveEvidence);
  expect(parsed.runId).toBe("018f0f00-0000-7000-8000-000000000004");
  expect(evaluateCodexSplitOutcome(parsed)).toBe("BLOCKED/INCOMPLETE");
  const unsupported = { ...liveEvidence, unsupportedObservation: true };
  expect(() => codexSplitLiveEvidenceSchema.parse(unsupported)).toThrow();
  expect(() => evaluateCodexSplitOutcome(unsupported)).toThrow("feasibility-evidence");
});

test("keeps incomplete process and network probes distinct from a proven clean result", () => {
  const incomplete = {
    ...evidence({
      sections: { A: false, B: false, C: false, D: false, E: false, F: false, G: false, H: false },
      liveOperatorProof: false,
      incompleteReason: "preflight-incomplete"
    }),
    runId: "018f0f00-0000-7000-8000-000000000005",
    processObservations: [{ role: "control", projectProcessCount: 0, observationComplete: false }],
    mountObservations: [],
    networkObservations: [{
      executionNetworkExpectedMembers: false,
      controlEgressExpectedMembers: false,
      controlCodexServiceReachableOnEgress: false,
      executorEndpointReachableOnExecution: false,
      executorEndpointReachableFromControlEgress: false,
      executorInternetReachable: false,
      executorControlEgressGatewayReachable: false,
      executorControlEgressAddressReachable: false,
      executorHostReachable: false,
      executorUnrelatedServiceReachable: false,
      controlForwardingDisabled: false,
      controlRoutingCapabilitiesAbsent: false,
      controlProxyProcessAbsent: false,
      endpointPublished: false,
      hostNetworkListener: false,
      probeComplete: false,
      securityViolation: false
    }]
  };

  const parsed = codexSplitLiveEvidenceSchema.parse(incomplete);
  expect(parsed.processObservations[0]?.observationComplete).toBe(false);
  expect(parsed.networkObservations[0]?.probeComplete).toBe(false);
  expect(evaluateCodexSplitOutcome(parsed)).toBe("BLOCKED/INCOMPLETE");
});
