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
    expect(sanitizeLogFields({ failureCategory: "not-a-category" as never, errorCode: "SAFE" }))
      .toEqual({ errorCode: "SAFE" });
  });
});
