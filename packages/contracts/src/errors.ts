import * as z from "zod";
import {
  configurationKeySchema,
  errorMessageSchema,
  projectOptionsRevisionHashSchema,
  resourceReferenceSchema,
  responseMetaSchema,
  uuidV7Schema
} from "./primitives.js";
import { workspaceDesiredStateSchema, workspaceObservedStateSchema } from "./shapes.js";

const emptyDetailsSchema = z.strictObject({});
const protocolDetailsSchema = z.strictObject({
  supportedProtocolVersion: z.literal(1),
  receivedProtocolVersion: z.number().int().min(1).max(2_147_483_647).nullable()
});
const requestFieldSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9.[\]_-]+$/u).nullable();

export const executableAgentErrorRegistry = Object.freeze({
  PROTOCOL_VERSION_UNSUPPORTED: { statuses: [400, 426], retryable: false, detailsSchema: protocolDetailsSchema },
  REQUEST_INVALID: { statuses: [400], retryable: false, detailsSchema: z.strictObject({
    location: z.enum(["headers", "path", "query", "body"]),
    field: requestFieldSchema,
    reason: z.enum(["missing", "malformed", "unknown", "inconsistent"])
  }) },
  OPERATION_CONFLICT: { statuses: [409], retryable: false, detailsSchema: z.strictObject({
    operationId: uuidV7Schema,
    reason: z.enum(["operation-name-mismatch", "request-mismatch"])
  }) },
  OPERATION_JOURNAL_UNAVAILABLE: { statuses: [503], retryable: true, detailsSchema: z.strictObject({
    reason: z.enum(["unavailable", "corrupt"])
  }) },
  CONFIGURATION_INVALID: { statuses: [422], retryable: false, detailsSchema: z.strictObject({
    revisionId: uuidV7Schema,
    reason: z.enum(["configuration-format", "configuration-hash", "cross-reference"])
  }) },
  CONFIGURATION_NOT_REGISTERED: { statuses: [422], retryable: false, detailsSchema: z.strictObject({
    revisionId: uuidV7Schema, revisionHash: projectOptionsRevisionHashSchema
  }) },
  RUNTIME_POLICY_VIOLATION: { statuses: [422], retryable: false, detailsSchema: z.strictObject({
    policy: z.enum(["source-not-approved", "workspace-action-rejected", "task-action-rejected",
      "terminal-action-rejected", "preview-action-rejected", "ai-profile-rejected"])
  }) },
  PROJECT_NOT_FOUND: { statuses: [404], retryable: false, detailsSchema: z.strictObject({ projectId: uuidV7Schema }) },
  RESOURCE_NOT_FOUND: { statuses: [404], retryable: false, detailsSchema: z.strictObject({ resource: resourceReferenceSchema }) },
  SOURCE_NOT_FOUND: { statuses: [404], retryable: false, detailsSchema: z.strictObject({ sourceId: uuidV7Schema }) },
  SOURCE_INVALID: { statuses: [422], retryable: false, detailsSchema: z.strictObject({
    reason: z.enum(["not-a-git-repository", "unsupported-repository-format"])
  }) },
  SOURCE_UNAVAILABLE: { statuses: [503], retryable: true, detailsSchema: emptyDetailsSchema },
  WORKSPACE_STATE_CONFLICT: { statuses: [409], retryable: false, detailsSchema: z.strictObject({
    workspaceId: uuidV7Schema,
    desiredState: workspaceDesiredStateSchema,
    observedState: workspaceObservedStateSchema,
    action: z.enum(["create", "start", "stop", "rebuild", "archive", "remove", "run-task",
      "create-terminal", "activate-preview", "start-ai-session"])
  }) },
  RESOURCE_STATE_CONFLICT: { statuses: [409], retryable: false, detailsSchema: z.strictObject({
    resource: resourceReferenceSchema,
    action: z.enum(["create", "start", "stop", "close", "attach", "activate", "deactivate", "interrupt", "resume"])
  }) },
  DIRTY_WORKSPACE_REQUIRES_ACTION: { statuses: [409], retryable: false, detailsSchema: z.strictObject({
    workspaceId: uuidV7Schema, requestedAction: z.enum(["archive", "remove"])
  }) },
  TASK_NOT_DEFINED: { statuses: [422], retryable: false, detailsSchema: z.strictObject({
    revisionId: uuidV7Schema, taskKey: configurationKeySchema
  }) },
  PROCESS_IDENTITY_MISMATCH: { statuses: [409], retryable: false, detailsSchema: z.strictObject({ processId: uuidV7Schema }) },
  PREVIEW_NOT_DEFINED: { statuses: [422], retryable: false, detailsSchema: z.strictObject({
    revisionId: uuidV7Schema, previewKey: configurationKeySchema
  }) },
  AI_NOT_CONFIGURED: { statuses: [422], retryable: false, detailsSchema: z.strictObject({
    workspaceId: uuidV7Schema, revisionId: uuidV7Schema
  }) },
  PREVIEW_DOMAIN_NOT_APPROVED: { statuses: [422], retryable: false, detailsSchema: z.strictObject({ previewId: uuidV7Schema }) },
  GATEWAY_UPDATE_FAILED: { statuses: [503], retryable: true, detailsSchema: z.strictObject({ previewId: uuidV7Schema }) },
  GITHUB_CONNECTION_NOT_FOUND: { statuses: [404], retryable: false, detailsSchema: emptyDetailsSchema },
  GITHUB_CONNECTION_DISABLED: { statuses: [409], retryable: false, detailsSchema: emptyDetailsSchema },
  GITHUB_AUTHORITY_GENERATION_STALE: { statuses: [409], retryable: false, detailsSchema: emptyDetailsSchema },
  GITHUB_AUTHORITY_INVALID: { statuses: [409, 422, 503], retryable: false, detailsSchema: z.strictObject({
    reason: z.enum(["unconfigured", "invalid", "mismatch", "suspended", "upstream-unavailable", "permission-required"])
  }) },
  GITHUB_INSTALLATION_REMOVED: { statuses: [410], retryable: false, detailsSchema: emptyDetailsSchema },
  GITHUB_INSTALLATION_SUSPENDED: { statuses: [403], retryable: false, detailsSchema: emptyDetailsSchema },
  GITHUB_REPOSITORY_ACCESS_UNAVAILABLE: { statuses: [403, 404], retryable: false, detailsSchema: emptyDetailsSchema },
  GITHUB_UPSTREAM_TRANSIENT: { statuses: [503], retryable: true, detailsSchema: emptyDetailsSchema },
  GITHUB_TOKEN_LEASE_ACTIVE: { statuses: [503], retryable: true, detailsSchema: emptyDetailsSchema },
  GITHUB_CONTENTS_PERMISSION_REQUIRED: { statuses: [403, 422], retryable: false, detailsSchema: emptyDetailsSchema },
  GITHUB_CONTENTS_WRITE_PERMISSION_REQUIRED: { statuses: [403, 422], retryable: false, detailsSchema: emptyDetailsSchema },
  GITHUB_INSTALLATION_UNAVAILABLE: { statuses: [503], retryable: true, detailsSchema: emptyDetailsSchema },
  GITHUB_REPOSITORY_NOT_AUTHORIZED: { statuses: [403, 404], retryable: false, detailsSchema: emptyDetailsSchema },
  GITHUB_GIT_AUTHENTICATION_FAILED: { statuses: [502, 503], retryable: false, detailsSchema: emptyDetailsSchema },
  GITHUB_PUSH_INTENT_STALE: { statuses: [409], retryable: false, detailsSchema: emptyDetailsSchema },
  GITHUB_PUSH_NON_FAST_FORWARD: { statuses: [409], retryable: false, detailsSchema: emptyDetailsSchema },
  GITHUB_PUSH_OUTCOME_UNCERTAIN: { statuses: [503], retryable: false, detailsSchema: emptyDetailsSchema },
  ROOTLESS_RUNTIME_UNAVAILABLE: { statuses: [503], retryable: true, detailsSchema: z.strictObject({ component: z.literal("docker") }) },
  AGENT_INTERNAL_ERROR: { statuses: [500], retryable: true, detailsSchema: z.strictObject({ incidentId: uuidV7Schema }) }
} as const);

export type ExecutableAgentErrorCode = keyof typeof executableAgentErrorRegistry;
export const executableAgentErrorCodes = Object.freeze(
  Object.keys(executableAgentErrorRegistry) as ExecutableAgentErrorCode[]
);

export const f10ExecutableAgentErrorRegistry = Object.freeze({
  EVENT_CURSOR_INVALID: {
    statuses: [400],
    retryable: false,
    detailsSchema: z.strictObject({
      reason: z.enum([
        "missing",
        "malformed",
        "unsupported_version",
        "invalid_agent_boot_id",
        "invalid_sequence",
        "sequence_out_of_range"
      ])
    })
  },
  EVENT_SNAPSHOT_REQUIRED: {
    statuses: [409],
    retryable: false,
    detailsSchema: z.strictObject({
      reason: z.enum(["boot_mismatch", "cursor_expired", "history_unavailable"]),
      currentAgentBootId: uuidV7Schema,
      snapshotPath: z.literal("/v1/snapshot")
    })
  }
} as const);
export type F10ExecutableAgentErrorCode = keyof typeof f10ExecutableAgentErrorRegistry;
export const f10ExecutableAgentErrorCodes = Object.freeze(
  Object.keys(f10ExecutableAgentErrorRegistry) as F10ExecutableAgentErrorCode[]
);
export const completeAgentApiV1ErrorRegistry = Object.freeze({
  ...executableAgentErrorRegistry,
  ...f10ExecutableAgentErrorRegistry
});
export type CompleteAgentApiV1ErrorCode = keyof typeof completeAgentApiV1ErrorRegistry;
export const completeAgentApiV1ErrorCodes = Object.freeze(
  Object.keys(completeAgentApiV1ErrorRegistry) as CompleteAgentApiV1ErrorCode[]
);

export function buildAgentErrorValueSchema<
  Code extends CompleteAgentApiV1ErrorCode
>(code: Code, detailsSchema?: z.ZodType) {
  const registryEntry = completeAgentApiV1ErrorRegistry[code];
  return z.strictObject({
    code: z.literal(code),
    message: errorMessageSchema,
    retryable: z.literal(registryEntry.retryable),
    details: detailsSchema === undefined ? registryEntry.detailsSchema : detailsSchema
  });
}

/** @internal Route-specific narrowing must never be exported from the package root. */
export function buildAgentErrorEnvelopeSchema(
  code: CompleteAgentApiV1ErrorCode,
  detailsSchema?: z.ZodType
) {
  return z.strictObject({
    meta: responseMetaSchema,
    error: buildAgentErrorValueSchema(code, detailsSchema)
  });
}

export const executableAgentErrorSchema = z.union(executableAgentErrorCodes.map(
  (code) => buildAgentErrorEnvelopeSchema(code)
) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
export type ExecutableAgentError = {
  [Code in ExecutableAgentErrorCode]: {
    readonly meta: z.infer<typeof responseMetaSchema>;
    readonly error: {
      readonly code: Code;
      readonly message: string;
      readonly retryable: (typeof executableAgentErrorRegistry)[Code]["retryable"];
      readonly details: z.infer<(typeof executableAgentErrorRegistry)[Code]["detailsSchema"]>;
    };
  };
}[ExecutableAgentErrorCode];

export const f10ExecutableAgentErrorSchema = z.union(f10ExecutableAgentErrorCodes.map(
  (code) => buildAgentErrorEnvelopeSchema(code)
) as unknown as [z.ZodType, z.ZodType]);
export const completeAgentApiV1ErrorSchema = z.union(completeAgentApiV1ErrorCodes.map(
  (code) => buildAgentErrorEnvelopeSchema(code)
) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
