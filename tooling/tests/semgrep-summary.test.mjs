import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeMarkdownTableCell,
  formatScannerErrorDiagnostics,
  parseSemgrepReportText,
  renderSummary,
  truncateMessage
} from "../semgrep-summary.mjs";

function finding(overrides = {}) {
  return {
    check_id: "javascript.test.example",
    path: "apps/web/src/example.ts",
    start: { line: 12, col: 1 },
    end: { line: 12, col: 2 },
    extra: { severity: "WARNING", message: "Example finding message." },
    ...overrides
  };
}

function report(overrides = {}) {
  return {
    version: "1.171.0",
    results: [],
    errors: [],
    paths: { scanned: ["apps/web/src/example.ts"] },
    ...overrides
  };
}

test("renders an empty successful report", () => {
  const summary = renderSummary(report(), { configuration: "p/default" });
  assert.match(summary, /Total findings: \*\*0\*\*/u);
  assert.match(summary, /Files scanned: \*\*1\*\*/u);
  assert.match(summary, /No findings detected\./u);
  assert.match(summary, /Monitoring-only/u);
});

test("groups findings by reported severity", () => {
  const summary = renderSummary(report({ results: [
    finding({ extra: { severity: "ERROR", message: "Error." } }),
    finding({ extra: { severity: "WARNING", message: "Warning." } }),
    finding({ extra: { severity: "INFO", message: "Info." } })
  ] }));
  assert.match(summary, /Reported severity counts: ERROR: 1; WARNING: 1; INFO: 1; UNKNOWN: 0/u);
});

test("orders findings deterministically regardless of input order", () => {
  const findings = [
    finding({ check_id: "z-rule", path: "z.ts", start: { line: 4 }, extra: { severity: "INFO", message: "Z." } }),
    finding({ check_id: "a-rule", path: "a.ts", start: { line: 2 }, extra: { severity: "ERROR", message: "A." } }),
    finding({ check_id: "b-rule", path: "b.ts", start: { line: 3 }, extra: { severity: "WARNING", message: "B." } })
  ];
  assert.equal(renderSummary(report({ results: findings })), renderSummary(report({ results: [...findings].reverse() })));
});

test("reports missing optional severity as UNKNOWN", () => {
  const summary = renderSummary(report({ results: [finding({ extra: { message: "No severity." } })] }));
  assert.match(summary, /Reported severity counts: ERROR: 0; WARNING: 0; INFO: 0; UNKNOWN: 1/u);
  assert.match(summary, /\| UNKNOWN \|/u);
});

test("escapes Markdown table content", () => {
  const summary = renderSummary(report({ results: [finding({
    path: "apps/web/a|b.ts",
    extra: { severity: "WARNING", message: "Pipe | and \\ slash." }
  })] }));
  assert.match(summary, /apps\/web\/a\\\|b\.ts/u);
  assert.ok(summary.includes("Pipe \\| and \\\\ slash."));
  assert.equal(escapeMarkdownTableCell("a|b"), "a\\|b");
});

test("truncates unbounded messages", () => {
  const longMessage = "x".repeat(100);
  const summary = renderSummary(report({ results: [finding({ extra: { severity: "WARNING", message: longMessage } })] }), {
    maxMessageLength: 24
  });
  assert.match(summary, /x{23}…/u);
  assert.doesNotMatch(summary, new RegExp("x".repeat(25), "u"));
  assert.equal(truncateMessage("abcdef", 4), "abc…");
});

test("rejects malformed JSON", () => {
  assert.throws(() => parseSemgrepReportText("{not-json"), /Malformed Semgrep JSON report/u);
  assert.throws(() => parseSemgrepReportText(JSON.stringify({ results: [] })), /results and errors arrays/u);
});

test("omits raw diagnostics from Semgrep errors when safe structured fields are absent", () => {
  const summary = renderSummary(report({ errors: [
    { code: "parse-error", long_msg: "Could not parse the file." },
    { error: "Rule loading failed." }
  ] }));
  assert.match(summary, /Scanner errors: \*\*2\*\*/u);
  assert.match(summary, /diagnostic=\(diagnostic omitted\)/u);
  assert.doesNotMatch(summary, /Could not parse the file|Rule loading failed/u);
});

test("formats bounded scanner-error diagnostics without source excerpts or sensitive values", () => {
  const output = formatScannerErrorDiagnostics([
    {
      type: "SourceParseError",
      code: 3,
      path: "/src/apps/agent/src/workspace.ts",
      short_msg: "parse error",
      long_msg: "Full source excerpt: const credential = 'do-not-print';",
      spans: [{ file: "/src/apps/agent/src/workspace.ts", start: { line: 17, col: 9 }, end: { line: 17, col: 10 } }]
    },
    {
      type: "SemgrepError",
      code: 2,
      path: "/runner/private/source.ts",
      short_msg: "token=secret-value ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 GITHUB_TOKEN=another-secret",
      long_msg: "Must not be printed either."
    }
  ]);

  assert.match(output, /type=SourceParseError; code=3; location=apps\/agent\/src\/workspace\.ts:17:9; diagnostic=parse error/u);
  assert.match(output, /location=\(absolute path omitted\); diagnostic=token=\[REDACTED\] \[REDACTED\] GITHUB_TOKEN=\[REDACTED\]/u);
  assert.doesNotMatch(output, /do-not-print|Full source excerpt|Must not be printed|\/runner\/private/u);
  assert.doesNotMatch(output, /ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456|secret-value|another-secret/u);
});

test("limits displayed findings while retaining the total", () => {
  const summary = renderSummary(report({ results: [
    finding({ path: "a.ts", start: { line: 1 }, extra: { severity: "ERROR", message: "First." } }),
    finding({ path: "b.ts", start: { line: 2 }, extra: { severity: "WARNING", message: "Second." } })
  ] }), { maxFindings: 1 });
  assert.match(summary, /Showing 1 of 2 findings/u);
  assert.match(summary, /First\./u);
  assert.doesNotMatch(summary, /Second\./u);
});

test("does not emit Semgrep source snippets", () => {
  const summary = renderSummary(report({ results: [finding({
    extra: {
      severity: "WARNING",
      message: "Only the message belongs in the summary.",
      lines: "const secret = 'do-not-display';",
      metavars: { "$X": { abstract_content: "secret" } }
    }
  })] }));
  assert.doesNotMatch(summary, /do-not-display/u);
  assert.doesNotMatch(summary, /abstract_content/u);
  assert.doesNotMatch(summary, /const secret/u);
});
