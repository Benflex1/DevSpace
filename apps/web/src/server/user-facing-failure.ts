import {
  classifyFailureCode, createLogger, type FailureCategory, type LogContext, type StructuredLogger
} from "@devspace/diagnostics";
import { v7 as uuidv7 } from "uuid";
import { AgentResponseError, AgentUnavailableError } from "./agent-client.js";
import { codeOwnedFailureMessage } from "./failure-policy.js";

export interface SafeFailureMetadata {
  readonly failureCategory?: FailureCategory;
  readonly retryable?: boolean;
  readonly incidentId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly operationId?: string | undefined;
  readonly diagnosticContext?: LogContext | undefined;
  readonly messageOwnership?: "web" | "agent-code";
}

/** A Web-owned error whose message and metadata are explicitly safe for browser projection. */
export class SafeWebFailure extends Error {
  readonly failureCategory: FailureCategory;
  readonly retryable: boolean;
  readonly incidentId: string | undefined;
  readonly requestId: string | undefined;
  readonly operationId: string | undefined;
  readonly diagnosticContext: LogContext;
  readonly messageOwnership: "web" | "agent-code";

  constructor(readonly code: string, message: string, metadata: SafeFailureMetadata = {}) {
    super(message);
    this.name = "SafeWebFailure";
    this.failureCategory = metadata.failureCategory ?? classifyFailureCode(code);
    this.retryable = metadata.retryable ?? false;
    this.incidentId = metadata.incidentId;
    this.requestId = metadata.requestId;
    this.operationId = metadata.operationId;
    this.diagnosticContext = metadata.diagnosticContext ?? {};
    this.messageOwnership = metadata.messageOwnership ?? "web";
  }
}

export interface UserFacingFailure {
  readonly message: string;
  readonly code: string;
  readonly failureCategory: FailureCategory;
  readonly retryable: boolean;
  readonly incidentId?: string;
}

const incidentCategories = new Set<FailureCategory>([
  "dependency-unavailable", "transport-failure", "protocol-failure", "internal-failure"
]);

function codeOwnedFailure(error: {
  readonly code: string;
  readonly retryable: boolean;
  readonly incidentId: string | undefined;
  readonly failureCategory: FailureCategory;
}, fallbackMessage: string): UserFacingFailure {
  const message = codeOwnedFailureMessage(error.code);
  if (message === undefined) {
    return {
      message: fallbackMessage,
      code: "WEB_INTERNAL_ERROR",
      failureCategory: "internal-failure",
      retryable: false,
      ...(error.incidentId === undefined ? {} : { incidentId: error.incidentId })
    };
  }
  return {
    message,
    code: error.code,
    failureCategory: error.failureCategory,
    retryable: error.retryable,
    ...(error.incidentId === undefined ? {} : { incidentId: error.incidentId })
  };
}

function trustedFailure(error: unknown, fallbackMessage: string): UserFacingFailure {
  if (error instanceof AgentResponseError || error instanceof AgentUnavailableError) {
    return codeOwnedFailure(error, fallbackMessage);
  }
  if (error instanceof SafeWebFailure) {
    if (error.messageOwnership === "agent-code") return codeOwnedFailure(error, fallbackMessage);
    return {
      message: error.message,
      code: error.code,
      failureCategory: error.failureCategory,
      retryable: error.retryable,
      ...(error.incidentId === undefined ? {} : { incidentId: error.incidentId })
    };
  }
  return {
    message: fallbackMessage,
    code: "WEB_INTERNAL_ERROR",
    failureCategory: "internal-failure",
    retryable: false
  };
}

/**
 * Sole M1 boundary for incident identity and safe browser projection.
 * Existing Agent incident IDs win; Web creates a UUIDv7 only for incident categories.
 */
export function normalizeUserFacingFailure(error: unknown, options: {
  readonly fallbackMessage: string;
  readonly event: string;
  readonly logMessage: string;
  readonly context?: LogContext;
  readonly logger?: StructuredLogger;
  readonly createIncidentId?: () => string;
}): UserFacingFailure {
  const failure = trustedFailure(error, options.fallbackMessage);
  if (!incidentCategories.has(failure.failureCategory)) return failure;
  const incidentId = failure.incidentId ?? (options.createIncidentId ?? uuidv7)();
  const projection = { ...failure, incidentId };
  const correlation = error instanceof AgentResponseError
    || error instanceof AgentUnavailableError
    || error instanceof SafeWebFailure
    ? {
        ...error.diagnosticContext,
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
        ...(error.operationId === undefined ? {} : { operationId: error.operationId })
      }
    : {};
  (options.logger ?? createLogger({ component: "web", subsystem: "user-facing-failure" })).error(
    options.event,
    options.logMessage,
    {
      ...correlation,
      ...options.context,
      failureCategory: projection.failureCategory,
      errorCode: projection.code,
      retryable: projection.retryable,
      incidentId
    }
  );
  return projection;
}
