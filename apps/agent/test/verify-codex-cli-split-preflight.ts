import {
  formatCodexSplitDiagnostic,
  parseCodexSplitVerifyEnvironment,
  runCodexSplitFeasibilityPreflight
} from "../src/codex-cli-split/feasibility-verifier.js";

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

  const result = await runCodexSplitFeasibilityPreflight({ configuration });
  process.stdout.write(`Codex split feasibility preflight: ${result.status}\n`);
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    runId: result.evidence.runId,
    sections: result.evidence.sections,
    transportSecurity: result.evidence.transportSecurity,
    physicalHomeSeparation: result.evidence.physicalHomeSeparation,
    noLocalFallback: result.evidence.noLocalFallback,
    controlModelEgressProven: result.evidence.controlModelEgressProven,
    executorCannotReachControlEgressProven: result.evidence.executorCannotReachControlEgressProven,
    controlRoutingDisabledProven: result.evidence.controlRoutingDisabledProven,
    securityViolation: result.evidence.securityViolation,
    incompleteReason: result.evidence.incompleteReason,
    unsupportedReason: result.evidence.unsupportedReason,
    processObservations: result.evidence.processObservations,
    mountObservations: result.evidence.mountObservations,
    networkObservations: result.evidence.networkObservations
  })}\n`);
  if (result.status === "BLOCKED/INCOMPLETE") process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const diagnostic = formatCodexSplitDiagnostic("entrypoint", error, "verifier");
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
  process.exitCode = 2;
});
