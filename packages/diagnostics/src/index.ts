export type LogLevel = "debug" | "info" | "warn" | "error";

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
  readonly errorCode?: string;
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
  readonly errorCode?: string;
  readonly retryable?: boolean;
  readonly healthBreakdown?: Readonly<Record<string, string>>;
}

export type LogSink = (line: string, level: LogLevel) => void;

const safeKeys = new Set([
  "requestId", "operationId", "projectId", "workspaceId", "previewId", "durationMs", "mode", "reason", "action",
  "operationName", "operationState", "observedState", "previousState", "currentState", "desiredState", "routePresent",
  "routeStatus", "statusCode", "pending", "errorCategory", "errorCode", "retryable", "healthBreakdown", "endpoint",
  "incidentId", "detailKeys"
]);
const sensitiveKey = /(?:authorization|cookie|credential|environment|password|secret|token|body|header|content|file|path|url|command|output)/iu;
const sensitiveText = /(?:bearer\s+|(?:authorization|cookie|password|secret|token|credential|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu;

function safeText(value: string): string {
  return value.replace(sensitiveText, "[REDACTED]");
}

function safeValue(key: string, value: unknown): unknown {
  if (sensitiveKey.test(key)) return undefined;
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
