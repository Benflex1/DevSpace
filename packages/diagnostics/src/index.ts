export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Closed failure classification shared by Web and Agent-facing diagnostics.
 *
 * Mapping rules:
 * - user-error: invalid input, unsupported configuration, policy, or missing resources.
 * - state-conflict: expected lifecycle, concurrency, or identity conflicts.
 * - dependency-unavailable: the Agent or a required runtime/gateway dependency is unavailable.
 * - transport-failure: a request timed out, was truncated, or could not be delivered.
 * - protocol-failure: a version, serialization, or validated response contract failed.
 * - internal-failure: an unexpected implementation or invariant failure.
 */
export const failureCategories = [
  "user-error",
  "state-conflict",
  "dependency-unavailable",
  "transport-failure",
  "protocol-failure",
  "internal-failure"
] as const;
export type FailureCategory = (typeof failureCategories)[number];

const userErrorCodes = new Set([
  "REQUEST_INVALID", "CONFIGURATION_INVALID", "CONFIGURATION_NOT_REGISTERED", "RUNTIME_POLICY_VIOLATION",
  "PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "SOURCE_NOT_FOUND", "SOURCE_INVALID", "TASK_NOT_DEFINED",
  "PREVIEW_NOT_DEFINED", "AI_NOT_CONFIGURED", "PREVIEW_DOMAIN_NOT_APPROVED", "RUNTIME_PLAN_UNSUPPORTED",
  "RUNTIME_PLAN_INVALID", "PREVIEW_NOT_FOUND", "EVENT_CURSOR_INVALID", "GITHUB_CONNECTION_NOT_FOUND",
  "GITHUB_CONTENTS_PERMISSION_REQUIRED", "GITHUB_REPOSITORY_NOT_AUTHORIZED"
]);
const conflictCodes = new Set([
  "OPERATION_CONFLICT", "WORKSPACE_STATE_CONFLICT", "RESOURCE_STATE_CONFLICT", "DIRTY_WORKSPACE_REQUIRES_ACTION",
  "PROCESS_IDENTITY_MISMATCH", "RUNTIME_ACTION_IN_PROGRESS", "RUNTIME_ACTION_NOT_AUTHORIZED",
  "EXECUTION_ACTION_IN_PROGRESS", "SETUP_IN_PROGRESS", "PREVIEW_ACTION_NOT_AUTHORIZED", "EVENT_SNAPSHOT_REQUIRED",
  "GITHUB_TOKEN_LEASE_ACTIVE"
]);
const dependencyCodes = new Set([
  "AGENT_UNAVAILABLE", "SOURCE_UNAVAILABLE", "OPERATION_JOURNAL_UNAVAILABLE", "ROOTLESS_RUNTIME_UNAVAILABLE",
  "GATEWAY_UPDATE_FAILED", "GITHUB_AUTHORITY_INVALID", "GITHUB_INSTALLATION_UNAVAILABLE"
]);
const transportCodes = new Set([
  "AGENT_REQUEST_TIMEOUT", "AGENT_RESPONSE_TOO_LARGE", "AGENT_TRANSPORT_FAILURE", "GITHUB_GIT_AUTHENTICATION_FAILED"
]);
const protocolCodes = new Set([
  "PROTOCOL_VERSION_UNSUPPORTED", "REQUEST_SERIALIZATION_FAILED", "MALFORMED_RESPONSE", "INVALID_RESPONSE_CONTRACT"
]);

/** Classifies only stable error codes; unknown codes fail closed as internal failures. */
export function classifyFailureCode(code: string): FailureCategory {
  if (userErrorCodes.has(code)) return "user-error";
  if (conflictCodes.has(code)) return "state-conflict";
  if (dependencyCodes.has(code)) return "dependency-unavailable";
  if (transportCodes.has(code)) return "transport-failure";
  if (protocolCodes.has(code)) return "protocol-failure";
  return "internal-failure";
}

const logLevelRank: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export function resolveLogLevel(environment: Readonly<Record<string, string | undefined>> = process.env): LogLevel {
  const value = environment.DEVSPACE_LOG_LEVEL;
  return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "info";
}

export interface LogContext {
  readonly requestId?: string;
  readonly operationId?: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly previewId?: string;
}

export interface LogFields extends LogContext {
  readonly durationMs?: number;
  readonly mode?: string;
  readonly reason?: string;
  readonly action?: string;
  readonly operationName?: string;
  readonly operationState?: string;
  readonly observedState?: string;
  readonly previousState?: string | null;
  readonly currentState?: string;
  readonly desiredState?: string;
  readonly routePresent?: boolean;
  readonly routeStatus?: string;
  readonly statusCode?: number;
  readonly pending?: boolean;
  readonly errorCategory?: string;
  readonly failureCategory?: FailureCategory;
  readonly errorCode?: string;
  readonly incidentId?: string;
  readonly retryable?: boolean;
  readonly healthBreakdown?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

export interface LogRecord extends LogContext {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly component: string;
  readonly subsystem: string;
  readonly event: string;
  readonly message: string;
  readonly durationMs?: number;
  readonly mode?: string;
  readonly reason?: string;
  readonly action?: string;
  readonly operationName?: string;
  readonly operationState?: string;
  readonly observedState?: string;
  readonly previousState?: string | null;
  readonly currentState?: string;
  readonly desiredState?: string;
  readonly routePresent?: boolean;
  readonly routeStatus?: string;
  readonly statusCode?: number;
  readonly pending?: boolean;
  readonly errorCategory?: string;
  readonly failureCategory?: FailureCategory;
  readonly errorCode?: string;
  readonly incidentId?: string;
  readonly retryable?: boolean;
  readonly healthBreakdown?: Readonly<Record<string, string>>;
}

export type LogSink = (line: string, level: LogLevel) => void;

const safeKeys = new Set([
  "requestId", "operationId", "projectId", "workspaceId", "previewId", "durationMs", "mode", "reason", "action",
  "operationName", "operationState", "observedState", "previousState", "currentState", "desiredState", "routePresent",
  "routeStatus", "statusCode", "pending", "errorCategory", "errorCode", "retryable", "healthBreakdown", "endpoint",
  "failureCategory", "incidentId", "detailKeys"
]);
const sensitiveKey = /(?:authorization|cookie|credential|environment|password|secret|token|body|header|content|file|path|url|command|output)/iu;
const sensitiveText = /(?:bearer\s+|(?:authorization|cookie|password|secret|token|credential|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu;

function safeText(value: string): string {
  return value.replace(sensitiveText, "[REDACTED]");
}

function safeValue(key: string, value: unknown): unknown {
  if (sensitiveKey.test(key)) return undefined;
  if (key === "failureCategory") {
    return typeof value === "string" && failureCategories.includes(value as FailureCategory) ? value : undefined;
  }
  if (typeof value === "string") return safeText(value.slice(0, 512));
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  if (key === "detailKeys" && Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").slice(0, 32);
  }
  if (key === "healthBreakdown" && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const result: Record<string, string> = {};
    for (const [subsystem, status] of Object.entries(value)) {
      if (/^[a-z][a-zA-Z0-9-]{0,63}$/u.test(subsystem) && typeof status === "string") result[subsystem] = safeText(status.slice(0, 128));
    }
    return result;
  }
  return undefined;
}

/** Allowlisted diagnostic fields are serialized; request bodies and other arbitrary data are discarded. */
export function sanitizeLogFields(fields: LogFields | undefined): Partial<LogRecord> {
  if (fields === undefined) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!safeKeys.has(key)) continue;
    const sanitized = safeValue(key, value);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

export function serializeLogRecord(record: LogRecord): string {
  return JSON.stringify(record);
}

function defaultSink(line: string, level: LogLevel): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface StructuredLoggerOptions {
  readonly component: string;
  readonly subsystem?: string;
  readonly now?: () => Date;
  readonly sink?: LogSink;
  readonly context?: LogContext;
  readonly level?: LogLevel;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface StructuredLogger {
  readonly context: LogContext;
  child(context: LogContext): StructuredLogger;
  log(level: LogLevel, event: string, message: string, fields?: LogFields): void;
  debug(event: string, message: string, fields?: LogFields): void;
  info(event: string, message: string, fields?: LogFields): void;
  warn(event: string, message: string, fields?: LogFields): void;
  error(event: string, message: string, fields?: LogFields): void;
}

export function createLogger(options: StructuredLoggerOptions): StructuredLogger {
  const now = options.now ?? (() => new Date());
  const sink = options.sink ?? defaultSink;
  const context = options.context ?? {};
  const level = options.level ?? resolveLogLevel(options.environment);
  const loggerLevel = level;
  const logger: StructuredLogger = {
    context,
    child: (childContext) => createLogger({ ...options, context: { ...context, ...childContext } }),
    log: (level, event, message, fields) => {
      if (logLevelRank[level] < logLevelRank[loggerLevel]) return;
      const sanitized = sanitizeLogFields({ ...context, ...fields });
      const record = {
        timestamp: now().toISOString(), level, component: options.component, subsystem: options.subsystem ?? "runtime",
        event: safeText(event.slice(0, 128)), message: safeText(message.slice(0, 512)), ...sanitized
      };
      sink(serializeLogRecord(record), level);
    },
    debug: (event, message, fields) => logger.log("debug", event, message, fields),
    info: (event, message, fields) => logger.log("info", event, message, fields),
    warn: (event, message, fields) => logger.log("warn", event, message, fields),
    error: (event, message, fields) => logger.log("error", event, message, fields)
  };
  return logger;
}
