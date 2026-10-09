import { describe, expect, test } from "vitest";
import {
  classifyFailureCode, createLogger, failureCategories, resolveLogLevel, sanitizeLogFields, serializeLogRecord, type LogRecord
} from "./index.js";

describe("structured diagnostics logging", () => {
  test("serializes stable JSON records with correlation and timing fields", () => {
    const lines: string[] = [];
    const logger = createLogger({ component: "web", subsystem: "preview", now: () => new Date("2026-07-22T12:00:00.000Z"), sink: (line) => lines.push(line) });
    logger.info("preview.reconciliation.completed", "Preview reconciliation completed", {
      requestId: "req-1", operationId: "op-1", projectId: "project-1", workspaceId: "workspace-1", previewId: "preview-1", durationMs: 123
    });
    expect(serializeLogRecord(JSON.parse(lines[0]!) as LogRecord)).not.toContain("\n");
    expect(JSON.parse(lines[0]!)).toMatchObject({ timestamp: "2026-07-22T12:00:00.000Z", level: "info", component: "web",
      subsystem: "preview", event: "preview.reconciliation.completed", message: "Preview reconciliation completed",
      requestId: "req-1", operationId: "op-1", projectId: "project-1", workspaceId: "workspace-1", previewId: "preview-1", durationMs: 123 });
  });

  test("drops unsafe fields and redacts secret-shaped text", () => {
    expect(sanitizeLogFields({ token: "secret", requestBody: { password: "secret" }, message: "token=secret", errorCode: "SAFE_CODE" })).toEqual({
      errorCode: "SAFE_CODE"
    });
    const lines: string[] = [];
    createLogger({ component: "agent", sink: (line) => lines.push(line) }).warn("health.check", "authorization=top-secret", { reason: "bearer top-secret" });
    const output = lines.join("");
    expect(output).not.toContain("top-secret");
    expect(output).not.toContain("requestBody");
  });

  test("keeps startup corruption diagnostics to known stages and reason classes", () => {
    expect(sanitizeLogFields({ stage: "creation-journal-bindings",
      corruptionReason: "runtime-creation-record-is-not-bound-to-its-durable-operation" })).toEqual({
      stage: "creation-journal-bindings",
      corruptionReason: "runtime-creation-record-is-not-bound-to-its-durable-operation"
    });
    expect(sanitizeLogFields({ stage: "/private/path", corruptionReason: "private path contains workspace id" })).toEqual({});
  });

  test("keeps only bounded native artifact staging diagnostics", () => {
    const fields = sanitizeLogFields({
      phase: "artifact-entry-readback", failureCode: "codex-artifact-readback-timeout", errorClass: "Error",
      containerId: "a".repeat(64), artifactLayout: "standalone-package", entryRelative: "bin/codex",
      elapsedMs: 10_000, cleanupElapsedMs: 12, cacheState: "hit",
      hostPath: "/private/host/secret", stderr: "credential=hidden", entryRelativeBad: "../../etc/passwd"
    });

    expect(fields).toMatchObject({
      phase: "artifact-entry-readback", failureCode: "codex-artifact-readback-timeout", errorClass: "Error",
      containerId: "a".repeat(64), artifactLayout: "standalone-package", entryRelative: "bin/codex",
      elapsedMs: 10_000, cleanupElapsedMs: 12, cacheState: "hit"
    });
    expect(fields).not.toHaveProperty("hostPath");
    expect(fields).not.toHaveProperty("stderr");
    expect(sanitizeLogFields({
      phase: "unexpected", failureCode: "secret=/private/path", errorClass: "VeryLongUntrustedClassName",
      containerId: "not-a-container", artifactLayout: "unknown-layout", entryRelative: "../secret",
      elapsedMs: -1, cleanupElapsedMs: 999_999_999, cacheState: "private-cache" as never
    })).toEqual({});
  });

  test("keeps bounded native admission timing identifiers and rejects sensitive timing fields", () => {
    const sessionId = "018f1f34-7000-7000-8000-000000000003";
    const terminalId = "018f1f34-7000-7000-8000-000000000005";
    expect(sanitizeLogFields({
      requestId: "018f1f34-7000-7000-8000-000000000006", sessionId, terminalId,
      harnessId: "codex", processGeneration: 2, phase: "serialization-wait",
      durationMs: 18.75, outcome: "success", environment: { CODEX_HOME: "/private" },
      prompt: "do not log", terminalOutput: "do not log", privatePath: "/private/home"
    })).toEqual({
      requestId: "018f1f34-7000-7000-8000-000000000006", sessionId, terminalId,
      harnessId: "codex", processGeneration: 2, phase: "serialization-wait",
      durationMs: 18.75, outcome: "success"
    });
    expect(sanitizeLogFields({
      sessionId: "not-an-id", harnessId: "/private/path", processGeneration: 0,
      phase: "private-home-copy", outcome: "unknown" as never
    })).toEqual({});
    expect(sanitizeLogFields({ phase: "workspace-runtime-validation", durationMs: 1, outcome: "success" }))
      .toEqual({ phase: "workspace-runtime-validation", durationMs: 1, outcome: "success" });
  });

  test("filters debug records at the safe info default and enables them explicitly", () => {
    expect(resolveLogLevel({})).toBe("info");
    expect(resolveLogLevel({ DEVSPACE_LOG_LEVEL: "not-a-level" })).toBe("info");
    const infoLines: string[] = [];
    createLogger({ component: "web", sink: (line) => infoLines.push(line), environment: {} }).debug("debug.detail", "hidden");
    expect(infoLines).toHaveLength(0);
    const debugLines: string[] = [];
    createLogger({ component: "web", sink: (line) => debugLines.push(line), environment: { DEVSPACE_LOG_LEVEL: "debug" } }).debug("debug.detail", "visible");
    expect(debugLines).toHaveLength(1);
  });

  test("provides a closed stable mapping covering every failure category", () => {
    expect([
      classifyFailureCode("REQUEST_INVALID"),
      classifyFailureCode("WORKSPACE_STATE_CONFLICT"),
      classifyFailureCode("AGENT_UNAVAILABLE"),
      classifyFailureCode("AGENT_REQUEST_TIMEOUT"),
      classifyFailureCode("INVALID_RESPONSE_CONTRACT"),
      classifyFailureCode("UNKNOWN_PRIVATE_FAILURE")
    ]).toEqual(failureCategories);
    expect(classifyFailureCode("GIT_MUTATION_OUTCOME_UNCERTAIN")).toBe("state-conflict");
    expect(sanitizeLogFields({ failureCategory: "not-a-category" as never, errorCode: "SAFE" }))
      .toEqual({ errorCode: "SAFE" });
  });
});
