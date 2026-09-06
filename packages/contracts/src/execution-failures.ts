import * as z from "zod";
import { agentApiV1EndpointByOperation } from "./endpoints.js";
import {
  buildAgentErrorValueSchema,
  executableAgentErrorRegistry,
  type ExecutableAgentErrorCode
} from "./errors.js";

export const agentExecutionFailureCodes = [
  "CONFIGURATION_NOT_REGISTERED",
  "RUNTIME_POLICY_VIOLATION",
  "PROJECT_NOT_FOUND",
  "RESOURCE_NOT_FOUND",
  "SOURCE_NOT_FOUND",
  "SOURCE_INVALID",
  "SOURCE_UNAVAILABLE",
  "GITHUB_CONTENTS_PERMISSION_REQUIRED",
  "GITHUB_AUTHORITY_INVALID",
  "GITHUB_CONNECTION_DISABLED",
  "GITHUB_AUTHORITY_GENERATION_STALE",
  "GITHUB_INSTALLATION_REMOVED",
  "GITHUB_INSTALLATION_SUSPENDED",
  "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE",
  "GITHUB_UPSTREAM_TRANSIENT",
  "GITHUB_INSTALLATION_UNAVAILABLE",
  "GITHUB_REPOSITORY_NOT_AUTHORIZED",
  "GITHUB_GIT_AUTHENTICATION_FAILED",
  "GITHUB_TOKEN_LEASE_ACTIVE",
  "WORKSPACE_STATE_CONFLICT",
  "RESOURCE_STATE_CONFLICT",
  "DIRTY_WORKSPACE_REQUIRES_ACTION",
  "TASK_NOT_DEFINED",
  "PROCESS_IDENTITY_MISMATCH",
  "PREVIEW_NOT_DEFINED",
  "AI_NOT_CONFIGURED",
  "PREVIEW_DOMAIN_NOT_APPROVED",
  "GATEWAY_UPDATE_FAILED",
  "ROOTLESS_RUNTIME_UNAVAILABLE",
  "AGENT_INTERNAL_ERROR"
] as const satisfies readonly ExecutableAgentErrorCode[];
export type AgentExecutionFailureCode = (typeof agentExecutionFailureCodes)[number];

const builtAgentExecutionFailureSchema = z.discriminatedUnion("code", agentExecutionFailureCodes.map(
  (code) => buildAgentErrorValueSchema(code)
) as unknown as [z.ZodObject, ...z.ZodObject[]]);
export type AgentExecutionFailure = {
  [Code in AgentExecutionFailureCode]: {
    readonly code: Code;
    readonly message: string;
    readonly retryable: (typeof executableAgentErrorRegistry)[Code]["retryable"];
    readonly details: z.infer<(typeof executableAgentErrorRegistry)[Code]["detailsSchema"]>;
  };
}[AgentExecutionFailureCode];
export const agentExecutionFailureSchema: z.ZodType<AgentExecutionFailure> =
  builtAgentExecutionFailureSchema as unknown as z.ZodType<AgentExecutionFailure>;

const applicabilityCodes = {
  "configuration-revision.register": ["AGENT_INTERNAL_ERROR"],
  "configuration-runtime-plan.register": ["CONFIGURATION_NOT_REGISTERED", "RUNTIME_POLICY_VIOLATION", "AGENT_INTERNAL_ERROR"],
  "project.managed-store.create": ["RESOURCE_STATE_CONFLICT", "SOURCE_NOT_FOUND", "SOURCE_INVALID", "SOURCE_UNAVAILABLE", "GITHUB_AUTHORITY_INVALID", "GITHUB_CONTENTS_PERMISSION_REQUIRED", "GITHUB_CONNECTION_DISABLED", "GITHUB_AUTHORITY_GENERATION_STALE", "GITHUB_INSTALLATION_REMOVED", "GITHUB_INSTALLATION_SUSPENDED", "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE", "GITHUB_UPSTREAM_TRANSIENT", "GITHUB_INSTALLATION_UNAVAILABLE", "GITHUB_REPOSITORY_NOT_AUTHORIZED", "GITHUB_GIT_AUTHENTICATION_FAILED", "GITHUB_TOKEN_LEASE_ACTIVE", "RUNTIME_POLICY_VIOLATION", "AGENT_INTERNAL_ERROR"],
  "project.fetch": ["PROJECT_NOT_FOUND", "SOURCE_UNAVAILABLE", "GITHUB_AUTHORITY_INVALID", "GITHUB_CONTENTS_PERMISSION_REQUIRED", "GITHUB_CONNECTION_DISABLED", "GITHUB_AUTHORITY_GENERATION_STALE", "GITHUB_INSTALLATION_REMOVED", "GITHUB_INSTALLATION_SUSPENDED", "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE", "GITHUB_UPSTREAM_TRANSIENT", "GITHUB_INSTALLATION_UNAVAILABLE", "GITHUB_REPOSITORY_NOT_AUTHORIZED", "GITHUB_GIT_AUTHENTICATION_FAILED", "GITHUB_TOKEN_LEASE_ACTIVE", "AGENT_INTERNAL_ERROR"],
  "workspace.create": ["PROJECT_NOT_FOUND", "CONFIGURATION_NOT_REGISTERED", "WORKSPACE_STATE_CONFLICT", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE", "AGENT_INTERNAL_ERROR"],
  "workspace.start": ["PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "CONFIGURATION_NOT_REGISTERED", "WORKSPACE_STATE_CONFLICT", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE", "AGENT_INTERNAL_ERROR"],
  "workspace.stop": ["PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "WORKSPACE_STATE_CONFLICT", "ROOTLESS_RUNTIME_UNAVAILABLE", "AGENT_INTERNAL_ERROR"],
  "workspace.rebuild": ["PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "CONFIGURATION_NOT_REGISTERED", "WORKSPACE_STATE_CONFLICT", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE", "AGENT_INTERNAL_ERROR"],
  "workspace.archive": ["PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "WORKSPACE_STATE_CONFLICT", "DIRTY_WORKSPACE_REQUIRES_ACTION", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE", "AGENT_INTERNAL_ERROR"],
  "workspace.remove": ["PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "WORKSPACE_STATE_CONFLICT", "DIRTY_WORKSPACE_REQUIRES_ACTION", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE", "AGENT_INTERNAL_ERROR"],
  "task.start": ["PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "CONFIGURATION_NOT_REGISTERED", "WORKSPACE_STATE_CONFLICT", "RESOURCE_STATE_CONFLICT", "TASK_NOT_DEFINED", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE", "AGENT_INTERNAL_ERROR"],
  "process.stop": ["PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "RESOURCE_STATE_CONFLICT", "PROCESS_IDENTITY_MISMATCH", "ROOTLESS_RUNTIME_UNAVAILABLE", "AGENT_INTERNAL_ERROR"],
  "terminal.create": ["PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "CONFIGURATION_NOT_REGISTERED", "WORKSPACE_STATE_CONFLICT", "RESOURCE_STATE_CONFLICT", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE", "AGENT_INTERNAL_ERROR"],
  "terminal.close": ["PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "RESOURCE_STATE_CONFLICT", "ROOTLESS_RUNTIME_UNAVAILABLE", "AGENT_INTERNAL_ERROR"],
  "preview.activate": ["PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "CONFIGURATION_NOT_REGISTERED", "WORKSPACE_STATE_CONFLICT", "RESOURCE_STATE_CONFLICT", "PREVIEW_NOT_DEFINED", "RUNTIME_POLICY_VIOLATION", "PREVIEW_DOMAIN_NOT_APPROVED", "GATEWAY_UPDATE_FAILED", "ROOTLESS_RUNTIME_UNAVAILABLE", "AGENT_INTERNAL_ERROR"],
  "preview.deactivate": ["PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "RESOURCE_STATE_CONFLICT", "GATEWAY_UPDATE_FAILED", "ROOTLESS_RUNTIME_UNAVAILABLE", "AGENT_INTERNAL_ERROR"],
  "ai-session.start": ["PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "CONFIGURATION_NOT_REGISTERED", "WORKSPACE_STATE_CONFLICT", "RESOURCE_STATE_CONFLICT", "AI_NOT_CONFIGURED", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE", "AGENT_INTERNAL_ERROR"],
  "ai-session.interrupt": ["PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "RESOURCE_STATE_CONFLICT", "ROOTLESS_RUNTIME_UNAVAILABLE", "AGENT_INTERNAL_ERROR"],
  "ai-session.stop": ["PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "RESOURCE_STATE_CONFLICT", "ROOTLESS_RUNTIME_UNAVAILABLE", "AGENT_INTERNAL_ERROR"],
  "ai-session.resume": ["PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "CONFIGURATION_NOT_REGISTERED", "RESOURCE_STATE_CONFLICT", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE", "AGENT_INTERNAL_ERROR"]
} as const satisfies Readonly<Record<string, readonly AgentExecutionFailureCode[]>>;

export type AgentMutationOperation = keyof typeof applicabilityCodes;
export type AgentExecutionFailureForOperation<Operation extends AgentMutationOperation> = Extract<
  AgentExecutionFailure,
  { readonly code: (typeof applicabilityCodes)[Operation][number] }
>;
export type AgentExecutionFailureApplicability = {
  readonly [Operation in AgentMutationOperation]: {
    readonly codes: (typeof applicabilityCodes)[Operation];
    readonly schema: z.ZodType<AgentExecutionFailureForOperation<Operation>>;
  };
};

function routeDetailsSchema(operation: AgentMutationOperation, code: AgentExecutionFailureCode): z.ZodType {
  const route = agentApiV1EndpointByOperation[operation];
  const error = route.errors.find((candidate) => candidate.code === code);
  return error?.schema.shape.error.shape.details
    ?? executableAgentErrorRegistry[code].detailsSchema;
}

export const agentExecutionFailureApplicability = Object.freeze(Object.fromEntries(
  Object.entries(applicabilityCodes).map(([operation, codes]) => [
    operation,
    Object.freeze({
      codes: Object.freeze([...codes]),
      schema: z.discriminatedUnion("code", codes.map((code) =>
        buildAgentErrorValueSchema(
          code,
          routeDetailsSchema(operation as AgentMutationOperation, code)
        )
      ) as unknown as [z.ZodObject, ...z.ZodObject[]])
    })
  ])
) as unknown as AgentExecutionFailureApplicability);
