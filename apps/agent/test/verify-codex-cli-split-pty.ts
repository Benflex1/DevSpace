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
  process.stdout.write(`Codex split PTY feasibility: ${result.status}\n`);
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    ptyProof: result.ptyProof,
    runId: result.evidence.runId,
    transportSecurity: result.evidence.transportSecurity,
    securityViolation: result.evidence.securityViolation,
    incompleteReason: result.evidence.incompleteReason
  })}\n`);
  if (result.status !== "READY_FOR_OPERATOR_TUI") process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const diagnostic = formatCodexSplitDiagnostic("entrypoint", error, "verifier");
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
  process.exitCode = 2;
});
