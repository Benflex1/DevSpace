import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MAX_FINDINGS = 25;
export const DEFAULT_MESSAGE_LENGTH = 240;
const MAX_SCANNER_ERROR_DIAGNOSTIC_LENGTH = 180;
const MAX_SCANNER_ERRORS_DISPLAYED = 10;

const severityOrder = new Map([
  ["ERROR", 0],
  ["WARNING", 1],
  ["INFO", 2],
  ["UNKNOWN", 3]
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareNumbers(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function findingSeverity(result) {
  const severity = result.extra?.severity;
  if (typeof severity !== "string" || severity.trim() === "") return "UNKNOWN";
  return severity.trim().toUpperCase();
}

function severityRank(severity) {
  return severityOrder.get(severity) ?? 3;
}

function findingPath(result) {
  const value = stringOr(result.path, "(unknown)").replaceAll("\\", "/");
  if (value === "(unknown)") return value;
  if (value.startsWith("./")) return value.slice(2);
  if (value.startsWith("/src/")) return value.slice("/src/".length);
  return value.startsWith("/") ? "(absolute path omitted)" : value;
}

function findingLine(result) {
  const line = result.start?.line;
  return Number.isInteger(line) && line > 0 ? line : null;
}

function findingRuleId(result) {
  return stringOr(result.check_id, "(unknown rule)");
}

function findingMessage(result) {
  const message = stringOr(result.extra?.message, "(no message)");
  return message.replace(/\s+/gu, " ").trim();
}

function normalizedFinding(result) {
  return {
    severity: findingSeverity(result),
    ruleId: findingRuleId(result),
    path: findingPath(result),
    line: findingLine(result),
    message: findingMessage(result)
  };
}

function compareFindings(left, right) {
  let comparison = compareNumbers(severityRank(left.severity), severityRank(right.severity));
  if (comparison !== 0) return comparison;
  comparison = compareText(left.severity, right.severity);
  if (comparison !== 0) return comparison;
  comparison = compareText(left.path, right.path);
  if (comparison !== 0) return comparison;
  comparison = compareNumbers(left.line ?? Number.MAX_SAFE_INTEGER, right.line ?? Number.MAX_SAFE_INTEGER);
  if (comparison !== 0) return comparison;
  comparison = compareText(left.ruleId, right.ruleId);
  if (comparison !== 0) return comparison;
  return compareText(left.message, right.message);
}

export function parseSemgrepReportText(text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed Semgrep JSON report: ${detail}`, { cause: error });
  }

  if (!isRecord(report) || !Array.isArray(report.results) || !Array.isArray(report.errors)) {
    throw new Error("Malformed Semgrep JSON report: expected an object with results and errors arrays.");
  }

  for (const [index, result] of report.results.entries()) {
    if (!isRecord(result)) {
      throw new Error(`Malformed Semgrep JSON report: results[${index}] must be an object.`);
    }
  }

  return report;
}

export function truncateMessage(value, maxLength = DEFAULT_MESSAGE_LENGTH) {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new Error("Message truncation length must be a positive integer.");
  }
  if (value.length <= maxLength) return value;
  if (maxLength === 1) return "…";
  return `${value.slice(0, maxLength - 1)}…`;
}

export function escapeMarkdownTableCell(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

function severityCounts(findings) {
  const counts = new Map();
  for (const finding of findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => {
    const rankComparison = compareNumbers(severityRank(left), severityRank(right));
    return rankComparison === 0 ? compareText(left, right) : rankComparison;
  });
}

function scannedFileCount(report) {
  return Array.isArray(report.paths?.scanned) ? report.paths.scanned.length : "unknown";
}

function scannerErrorMessage(error) {
  if (!isRecord(error)) return "(diagnostic omitted)";
  if (Array.isArray(error.type) && error.type[0] === "PartialParsing" && Array.isArray(error.type[1])) {
    const locations = error.type[1].filter(isRecord);
    const displayed = locations.slice(0, 3).map((location) => scannerErrorLocation({
      path: location.path,
      start: location.start
    }));
    const suffix = locations.length > 3 ? `; ${locations.length - 3} more omitted` : "";
    const positions = displayed.length > 0 ? `: ${displayed.join(", ")}${suffix}` : "";
    return truncateMessage(`partial parser recovery; ${locations.length} skipped-token location(s)${positions}`, MAX_SCANNER_ERROR_DIAGNOSTIC_LENGTH);
  }
  return safeScannerText(error.short_msg, "(diagnostic omitted)");
}

function safeScannerText(value, fallback, maxLength = MAX_SCANNER_ERROR_DIAGNOSTIC_LENGTH) {
  if (typeof value !== "string") return fallback;
  const sanitized = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\b([A-Z0-9_-]*(?:ACCESS[_-]?TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE[_-]?KEY|API[_-]?KEY|AUTHORIZATION)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/giu, "[REDACTED]")
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized === "" ? fallback : truncateMessage(sanitized, maxLength);
}

function errorPathValue(value) {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  return stringOr(value.ppath, stringOr(value.fpath, ""));
}

function scannerErrorPath(error) {
  const firstSpan = Array.isArray(error?.spans) ? error.spans.find(isRecord) : undefined;
  const rawPath = errorPathValue(error?.path) || errorPathValue(firstSpan?.file);
  if (rawPath === "") return "unknown";
  const normalized = rawPath.trim().replaceAll("\\", "/");
  if (normalized.startsWith("/src/")) return safeScannerText(normalized.slice("/src/".length), "unknown", 120);
  if (normalized.startsWith("./")) return safeScannerText(normalized.slice(2), "unknown", 120);
  if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)
    || normalized.split("/").some((segment) => segment === "..")) {
    return "(absolute path omitted)";
  }
  return safeScannerText(normalized, "unknown", 120);
}

function scannerErrorLocation(error) {
  const firstSpan = Array.isArray(error?.spans) ? error.spans.find(isRecord) : undefined;
  const start = isRecord(firstSpan?.start) ? firstSpan.start : isRecord(error?.start) ? error.start : null;
  const line = Number.isInteger(start?.line) && start.line > 0 ? start.line : null;
  const column = Number.isInteger(start?.col) && start.col > 0 ? start.col : null;
  const position = line === null ? "" : `:${line}${column === null ? "" : `:${column}`}`;
  return `${scannerErrorPath(error)}${position}`;
}

function scannerErrorType(error) {
  if (!isRecord(error)) return "unknown";
  const value = Array.isArray(error.type) ? error.type.filter((part) => typeof part === "string").join("/") : error.type;
  return safeScannerText(value, "unknown", 80);
}

function scannerErrorCode(error) {
  return isRecord(error) && Number.isSafeInteger(error.code) ? String(error.code) : "unknown";
}

function formatScannerError(error, index) {
  return `scanner error ${index}: type=${scannerErrorType(error)}; code=${scannerErrorCode(error)}; location=${scannerErrorLocation(error)}; diagnostic=${scannerErrorMessage(error)}`;
}

export function formatScannerErrorDiagnostics(errors) {
  if (!Array.isArray(errors)) throw new Error("Scanner errors must be an array.");
  const lines = ["Semgrep scanner errors:"];
  for (const [index, error] of errors.slice(0, MAX_SCANNER_ERRORS_DISPLAYED).entries()) {
    lines.push(formatScannerError(error, index + 1));
  }
  if (errors.length > MAX_SCANNER_ERRORS_DISPLAYED) {
    lines.push(`${errors.length - MAX_SCANNER_ERRORS_DISPLAYED} additional scanner errors omitted.`);
  }
  return lines.join("\n");
}

export function renderSummary(report, options = {}) {
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const maxMessageLength = options.maxMessageLength ?? DEFAULT_MESSAGE_LENGTH;
  if (!Number.isInteger(maxFindings) || maxFindings < 0) {
    throw new Error("Finding display limit must be a non-negative integer.");
  }

  const findings = report.results.map(normalizedFinding).sort(compareFindings);
  const counts = severityCounts(findings);
  const countMap = new Map(counts);
  const countText = ["ERROR", "WARNING", "INFO", "UNKNOWN"]
    .map((severity) => [severity, countMap.get(severity) ?? 0])
    .concat(counts.filter(([severity]) => !["ERROR", "WARNING", "INFO", "UNKNOWN"].includes(severity)))
    .map(([severity, count]) => `${severity}: ${count}`)
    .join("; ");
  const displayedFindings = findings.slice(0, maxFindings);
  const lines = [
    "## Semgrep CE",
    "",
    `- Semgrep version: \`${escapeMarkdownTableCell(stringOr(options.scannerVersion, stringOr(report.version, "unknown")))}\``,
    `- Configuration: \`${escapeMarkdownTableCell(stringOr(options.configuration, "unknown"))}\``,
    `- Total findings: **${findings.length}**`,
    `- Reported severity counts: ${countText}`,
    `- Files scanned: **${scannedFileCount(report)}**`,
    `- Scanner errors: **${report.errors.length}**`,
    "",
    "> **Monitoring-only:** findings are reported for review and do not fail this workflow. Scanner, report, and summary-generation failures remain blocking.",
    "",
    "### Findings"
  ];

  if (findings.length === 0) {
    lines.push("No findings detected.");
  } else {
    lines.push(`Showing ${displayedFindings.length} of ${findings.length} findings; the complete JSON report is retained in the **semgrep-results** artifact.`);
    lines.push("", "| Severity | Rule ID | Path | Start line | Message |", "| --- | --- | --- | ---: | --- |");
    for (const finding of displayedFindings) {
      lines.push(`| ${escapeMarkdownTableCell(finding.severity)} | ${escapeMarkdownTableCell(finding.ruleId)} | ${escapeMarkdownTableCell(finding.path)} | ${finding.line ?? "unknown"} | ${escapeMarkdownTableCell(truncateMessage(finding.message, maxMessageLength))} |`);
    }
  }

  lines.push("", "### Scanner errors");
  if (report.errors.length === 0) {
    lines.push("None.");
  } else {
    for (const line of formatScannerErrorDiagnostics(report.errors).split("\n").slice(1)) {
      lines.push(`- ${escapeMarkdownTableCell(line)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function parseArguments(argv) {
  const options = { input: null, output: null, checkScannerErrors: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check-scanner-errors") {
      options.checkScannerErrors = true;
      continue;
    }
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    const [name, inlineValue] = argument.split("=", 2);
    if (!["--input", "--output", "--configuration", "--scanner-version", "--max-findings"].includes(name)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}.`);
    }
    if (name === "--max-findings") {
      const maxFindings = Number(value);
      if (!Number.isInteger(maxFindings) || maxFindings < 0) throw new Error("--max-findings must be a non-negative integer.");
      options.maxFindings = maxFindings;
    } else if (name === "--input") {
      options.input = value;
    } else if (name === "--output") {
      options.output = value;
    } else if (name === "--configuration") {
      options.configuration = value;
    } else if (name === "--scanner-version") {
      options.scannerVersion = value;
    }
  }
  return options;
}

function usage() {
  return [
    "Usage: node tooling/semgrep-summary.mjs --input REPORT.json [options]",
    "",
    "Options:",
    "  --output PATH                 Write Markdown to PATH instead of stdout.",
    "  --configuration NAME          Configuration name shown in the summary.",
    "  --scanner-version VERSION     Scanner version shown in the summary.",
    "  --max-findings COUNT          Maximum findings shown in the table (default: 25).",
    "  --check-scanner-errors        Validate the report and fail when errors are present.",
    "  --help                        Show this help."
  ].join("\n");
}

async function readInput(input) {
  if (input === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  }
  return readFile(input, "utf8");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.input === null) throw new Error("--input is required.");

  const report = parseSemgrepReportText(await readInput(options.input));
  if (options.checkScannerErrors) {
    if (report.errors.length > 0) {
      process.stderr.write(`${formatScannerErrorDiagnostics(report.errors)}\n`);
      throw new Error(`Semgrep JSON report contains ${report.errors.length} scanner error(s).`);
    }
    return;
  }

  const summary = renderSummary(report, options);
  if (options.output === null) process.stdout.write(summary);
  else await writeFile(options.output, summary, "utf8");
}

const invokedPath = process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  main().catch((error) => {
    process.stderr.write(`Semgrep summary generation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
