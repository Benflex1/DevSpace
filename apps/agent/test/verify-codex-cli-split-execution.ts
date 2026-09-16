import {
  createCodexSplitTerminalOperator,
  formatCodexSplitDiagnostic,
  parseCodexSplitVerifyEnvironment,
  runCodexSplitFeasibilityGate
} from "../src/codex-cli-split/feasibility-verifier.js";
import { evaluateCodexSplitOutcome } from "../src/codex-cli-split/feasibility-result.js";

async function main(): Promise<void> {
  let configuration;
  try {
    configuration = parseCodexSplitVerifyEnvironment(process.env);
  } catch (error) {
    const diagnostic = formatCodexSplitDiagnostic("setup", error, "verifier");
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    process.exitCode = 2;
    return;
  }

  const evidence = await runCodexSplitFeasibilityGate({
    configuration,
    operator: createCodexSplitTerminalOperator()
  });
  const outcome = evaluateCodexSplitOutcome(evidence);
  process.stdout.write(`Codex split feasibility result: ${outcome}\n`);
  process.stdout.write(`${JSON.stringify({
    outcome,
    runId: evidence.runId,
    sections: evidence.sections,
    transportSecurity: evidence.transportSecurity,
    liveOperatorProof: evidence.liveOperatorProof,
    physicalHomeSeparation: evidence.physicalHomeSeparation,
    noLocalFallback: evidence.noLocalFallback,
    controlModelEgressProven: evidence.controlModelEgressProven,
    executorCannotReachControlEgressProven: evidence.executorCannotReachControlEgressProven,
    controlRoutingDisabledProven: evidence.controlRoutingDisabledProven,
    securityViolation: evidence.securityViolation,
    incompleteReason: evidence.incompleteReason,
    unsupportedReason: evidence.unsupportedReason,
    processObservations: evidence.processObservations,
    mountObservations: evidence.mountObservations,
    networkObservations: evidence.networkObservations
  })}\n`);
  if (outcome === "FAIL" || outcome === "BLOCKED/INCOMPLETE") process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const diagnostic = formatCodexSplitDiagnostic("entrypoint", error, "verifier");
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
  process.exitCode = 2;
});
