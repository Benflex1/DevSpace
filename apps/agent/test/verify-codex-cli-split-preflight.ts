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

  const summarize = (result: Awaited<ReturnType<typeof runCodexSplitFeasibilityPreflight>>) => ({
    status: result.status,
    lifecyclePath: result.lifecyclePath,
    ptyProof: result.ptyProof,
    runId: result.evidence.runId,
    readiness: result.evidence.readiness,
    sections: result.evidence.sections,
    transportSecurity: result.evidence.transportSecurity,
    transportEvidence: result.evidence.transportEvidence,
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
  });

  const first = await runCodexSplitFeasibilityPreflight({ configuration, retainOnSuccess: true });
  process.stdout.write(`Codex split infrastructure preflight #1: ${first.status}\n`);
  process.stdout.write(`${JSON.stringify(summarize(first))}\n`);
  if (first.status !== "INFRASTRUCTURE_READY") {
    process.exitCode = 1;
    return;
  }

  const second = await runCodexSplitFeasibilityPreflight({ configuration, retainOnSuccess: false });
  process.stdout.write(`Codex split infrastructure preflight #2: ${second.status}\n`);
  process.stdout.write(`${JSON.stringify(summarize(second))}\n`);
  if (second.status !== "INFRASTRUCTURE_READY" || first.lifecyclePath !== "fresh-create"
    || second.lifecyclePath !== "persisted-reattach") process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const diagnostic = formatCodexSplitDiagnostic("entrypoint", error, "verifier");
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
  process.exitCode = 2;
});
