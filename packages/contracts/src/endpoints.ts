import * as z from "zod";
import { buildAgentErrorEnvelopeSchema, executableAgentErrorRegistry, type ExecutableAgentErrorCode } from "./errors.js";
import {
  MUTATION_OPERATION_ID_HEADER,
  commonRequestHeadersSchema,
  mutationReceiptSchema,
  mutationRequestHeadersSchema,
  postBodySchema,
  successEnvelopeSchema,
  uuidV7Schema,
  type PostBodySchema,
  type SuccessEnvelopeSchema
} from "./primitives.js";
import {
  activatePreviewDataSchema,
  aiSessionIdentityDataSchema,
  archiveWorkspaceDataSchema,
  capabilitiesDataSchema,
  configurationRuntimePlanDataSchema,
  configurationRevisionDataSchema,
  configurationValidationDataSchema,
  createManagedStoreDataSchema,
  projectFetchDataSchema,
  createTerminalDataSchema,
  createWorkspaceDataSchema,
  gitInspectionDataSchema,
  gitDiffDataRequestSchema,
  gitDiffDataSchema,
  gitWorkspaceFileDataSchema,
  gitCommitDataSchema,
  healthDataSchema,
  inspectGitDataSchema,
  inspectSourceDataSchema,
  listWorkspaceFilesDataSchema,
  projectPushDataSchema,
  previewIdentityDataSchema,
  previewInspectionDataSchema,
  processIdentityDataSchema,
  processInspectionDataSchema,
  rebuildWorkspaceDataSchema,
  removeWorkspaceDataSchema,
  resumeAiSessionDataSchema,
  runtimeStatusDataSchema,
  readWorkspaceFileDataSchema,
  saveWorkspaceFileDataSchema,
  sourceInspectionDataSchema,
  startAiSessionDataSchema,
  startTaskDataSchema,
  terminalIdentityDataSchema,
  workspaceIdentityDataSchema,
  workspaceFileReadResultSchema,
  workspaceFileSaveResultSchema,
  workspaceFilesListResultSchema,
  workspaceInspectionDataSchema
} from "./shapes.js";

export type AgentEndpointClass = "mutation" | "non-mutating" | "websocket-upgrade";
export type AgentHttpMethod = "GET" | "POST";

const noPathParametersSchema = z.strictObject({});
const terminalPathParametersSchema = z.strictObject({ terminalId: uuidV7Schema });
const noQuerySchema = z.undefined();
const noBodySchema = z.undefined();

type ErrorInput = {
  readonly code: ExecutableAgentErrorCode;
  readonly detailsSchema?: z.ZodType;
};

const globalErrors: readonly ErrorInput[] = [
  { code: "PROTOCOL_VERSION_UNSUPPORTED" },
  { code: "REQUEST_INVALID" },
  { code: "AGENT_INTERNAL_ERROR" }
];
const mutationErrors: readonly ErrorInput[] = [
  { code: "OPERATION_CONFLICT" },
  { code: "OPERATION_JOURNAL_UNAVAILABLE" }
];

function resourceDetails(types: readonly string[]) {
  return z.strictObject({
    resource: z.strictObject({ type: z.enum(types as [string, ...string[]]), id: uuidV7Schema })
  });
}

function resourceStateDetails(types: readonly string[], actions: readonly string[]) {
  return z.strictObject({
    resource: z.strictObject({ type: z.enum(types as [string, ...string[]]), id: uuidV7Schema }),
    action: z.enum(actions as [string, ...string[]])
  });
}

function workspaceConflictDetails(action: string) {
  const base = executableAgentErrorRegistry.WORKSPACE_STATE_CONFLICT.detailsSchema;
  return z.strictObject({ ...base.shape, action: z.enum([action]) });
}

function runtimePolicyDetails(policy: string) {
  return z.strictObject({ policy: z.enum([policy]) });
}

function dirtyWorkspaceDetails(requestedAction: "archive" | "remove") {
  return z.strictObject({ workspaceId: uuidV7Schema, requestedAction: z.literal(requestedAction) });
}

export function e(code: ExecutableAgentErrorCode, detailsSchema?: z.ZodType): ErrorInput {
  return detailsSchema === undefined ? { code } : { code, detailsSchema };
}

type ResolvedSuccessDataSchema<
  Classification extends AgentEndpointClass,
  SuccessSchema extends z.ZodType | undefined
> = SuccessSchema extends z.ZodType
  ? SuccessSchema
  : Classification extends "mutation"
    ? typeof mutationReceiptSchema
    : never;

export function endpoint<
  const Operation extends string,
  const Method extends AgentHttpMethod,
  const Path extends `/v1${string}`,
  const Classification extends AgentEndpointClass,
  const SuccessStatus extends 101 | 200 | 202,
  const PathSchema extends z.ZodType | undefined = undefined,
  const RequestSchema extends z.ZodType | undefined = undefined,
  const SuccessSchema extends z.ZodType | undefined = undefined
>(input: {
  readonly operation: Operation;
  readonly method: Method;
  readonly path: Path;
  readonly classification: Classification;
  readonly pathParametersSchema?: PathSchema;
  readonly requestDataSchema?: RequestSchema;
  readonly successStatus: SuccessStatus;
  readonly successDataSchema?: SuccessSchema;
  readonly specificErrors?: readonly ErrorInput[];
}) {
  const journaledMutation = (input.classification === "mutation") as Classification extends "mutation"
    ? true
    : false;
  const errors = [
    ...globalErrors,
    ...(journaledMutation ? mutationErrors : []),
    ...(input.specificErrors ?? [])
  ];
  const errorSchemas = errors.map(({ code, detailsSchema }) => buildAgentErrorEnvelopeSchema(code, detailsSchema));
  return Object.freeze({
    operation: input.operation,
    method: input.method,
    path: input.path,
    classification: input.classification,
    journaledMutation,
    requiredDevSpaceHeaders: Object.freeze([
      "X-DevSpace-Protocol-Version",
      "X-DevSpace-Request-Id",
      "X-DevSpace-Sent-At",
      ...(journaledMutation ? [MUTATION_OPERATION_ID_HEADER] : [])
    ]),
    headersSchema: (journaledMutation ? mutationRequestHeadersSchema : commonRequestHeadersSchema) as
      Classification extends "mutation"
        ? typeof mutationRequestHeadersSchema
        : typeof commonRequestHeadersSchema,
    pathParametersSchema: (input.pathParametersSchema ?? noPathParametersSchema) as
      PathSchema extends z.ZodType ? PathSchema : typeof noPathParametersSchema,
    querySchema: noQuerySchema,
    requestBodySchema: (input.requestDataSchema === undefined
      ? noBodySchema
      : postBodySchema(input.requestDataSchema)) as RequestSchema extends z.ZodType
        ? PostBodySchema<RequestSchema>
        : typeof noBodySchema,
    requestDataSchema: (input.requestDataSchema ?? null) as RequestSchema extends z.ZodType
      ? RequestSchema
      : null,
    successStatus: input.successStatus,
    successBodySchema: (input.successStatus === 101
      ? null
      : successEnvelopeSchema(input.successDataSchema ?? mutationReceiptSchema)) as SuccessStatus extends 101
        ? null
        : SuccessEnvelopeSchema<ResolvedSuccessDataSchema<Classification, SuccessSchema>>,
    successDataSchema: (input.successDataSchema ?? (journaledMutation ? mutationReceiptSchema : null)) as
      SuccessSchema extends z.ZodType
        ? SuccessSchema
        : Classification extends "mutation"
          ? typeof mutationReceiptSchema
          : null,
    errors: Object.freeze(errors.map(({ code, detailsSchema }) => Object.freeze({
      code,
      statuses: executableAgentErrorRegistry[code].statuses,
      schema: buildAgentErrorEnvelopeSchema(code, detailsSchema)
    }))),
    errorSchema: z.union(errorSchemas as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]])
  });
}

const projectNotFound = e("PROJECT_NOT_FOUND");
const configurationNotRegistered = e("CONFIGURATION_NOT_REGISTERED");
const rootlessRuntimeUnavailable = e("ROOTLESS_RUNTIME_UNAVAILABLE");
const sourceUnavailable = e("SOURCE_UNAVAILABLE");
const workspaceNotFound = e("RESOURCE_NOT_FOUND", resourceDetails(["workspace"]));

export const agentApiV1Endpoints = Object.freeze([
  endpoint({ operation: "agent.health.get", method: "GET", path: "/v1/health", classification: "non-mutating", successStatus: 200, successDataSchema: healthDataSchema }),
  endpoint({ operation: "agent.capabilities.get", method: "GET", path: "/v1/capabilities", classification: "non-mutating", successStatus: 200, successDataSchema: capabilitiesDataSchema }),
  endpoint({ operation: "agent.runtime-status.get", method: "GET", path: "/v1/runtime/status", classification: "non-mutating", successStatus: 200, successDataSchema: runtimeStatusDataSchema }),
  endpoint({ operation: "configuration-revision.validate", method: "POST", path: "/v1/configuration-revisions/validate", classification: "non-mutating", requestDataSchema: configurationRevisionDataSchema, successStatus: 200, successDataSchema: configurationValidationDataSchema, specificErrors: [e("CONFIGURATION_INVALID")] }),
  endpoint({ operation: "configuration-revision.register", method: "POST", path: "/v1/configuration-revisions/register", classification: "mutation", requestDataSchema: configurationRevisionDataSchema, successStatus: 202, specificErrors: [e("CONFIGURATION_INVALID")] }),
  endpoint({ operation: "configuration-runtime-plan.register", method: "POST", path: "/v1/configuration-revisions/register-runtime-plan", classification: "mutation", requestDataSchema: configurationRuntimePlanDataSchema, successStatus: 202, specificErrors: [configurationNotRegistered, e("CONFIGURATION_INVALID"), e("RUNTIME_POLICY_VIOLATION", runtimePolicyDetails("runtime-plan-mismatch"))] }),
  endpoint({ operation: "project.source.inspect", method: "POST", path: "/v1/projects/inspect-source", classification: "non-mutating", requestDataSchema: inspectSourceDataSchema, successStatus: 200, successDataSchema: sourceInspectionDataSchema, specificErrors: [e("SOURCE_NOT_FOUND"), sourceUnavailable, e("GITHUB_AUTHORITY_INVALID"), e("GITHUB_CONNECTION_DISABLED"), e("GITHUB_AUTHORITY_GENERATION_STALE"), e("GITHUB_INSTALLATION_REMOVED"), e("GITHUB_INSTALLATION_SUSPENDED"), e("GITHUB_REPOSITORY_ACCESS_UNAVAILABLE"), e("GITHUB_UPSTREAM_TRANSIENT"), e("GITHUB_INSTALLATION_UNAVAILABLE"), e("GITHUB_REPOSITORY_NOT_AUTHORIZED"), e("GITHUB_CONTENTS_PERMISSION_REQUIRED"), e("GITHUB_GIT_AUTHENTICATION_FAILED"), e("GITHUB_TOKEN_LEASE_ACTIVE"), e("RUNTIME_POLICY_VIOLATION", runtimePolicyDetails("source-not-approved"))] }),
  endpoint({ operation: "project.managed-store.create", method: "POST", path: "/v1/projects/create-managed-store", classification: "mutation", requestDataSchema: createManagedStoreDataSchema, successStatus: 202, specificErrors: [e("RESOURCE_STATE_CONFLICT", resourceStateDetails(["project"], ["create"])), e("SOURCE_NOT_FOUND"), e("SOURCE_INVALID"), sourceUnavailable, e("GITHUB_AUTHORITY_INVALID"), e("GITHUB_CONNECTION_DISABLED"), e("GITHUB_AUTHORITY_GENERATION_STALE"), e("GITHUB_INSTALLATION_REMOVED"), e("GITHUB_INSTALLATION_SUSPENDED"), e("GITHUB_REPOSITORY_ACCESS_UNAVAILABLE"), e("GITHUB_UPSTREAM_TRANSIENT"), e("GITHUB_INSTALLATION_UNAVAILABLE"), e("GITHUB_REPOSITORY_NOT_AUTHORIZED"), e("GITHUB_CONTENTS_PERMISSION_REQUIRED"), e("GITHUB_GIT_AUTHENTICATION_FAILED"), e("GITHUB_TOKEN_LEASE_ACTIVE"), e("RUNTIME_POLICY_VIOLATION", runtimePolicyDetails("source-not-approved"))] }),
  endpoint({ operation: "project.fetch", method: "POST", path: "/v1/projects/fetch", classification: "mutation", requestDataSchema: projectFetchDataSchema, successStatus: 202, specificErrors: [projectNotFound, sourceUnavailable, e("GITHUB_AUTHORITY_INVALID"), e("GITHUB_CONNECTION_DISABLED"), e("GITHUB_AUTHORITY_GENERATION_STALE"), e("GITHUB_INSTALLATION_REMOVED"), e("GITHUB_INSTALLATION_SUSPENDED"), e("GITHUB_REPOSITORY_ACCESS_UNAVAILABLE"), e("GITHUB_UPSTREAM_TRANSIENT"), e("GITHUB_INSTALLATION_UNAVAILABLE"), e("GITHUB_REPOSITORY_NOT_AUTHORIZED"), e("GITHUB_CONTENTS_PERMISSION_REQUIRED"), e("GITHUB_GIT_AUTHENTICATION_FAILED"), e("GITHUB_TOKEN_LEASE_ACTIVE")] }),
  endpoint({ operation: "project.push", method: "POST", path: "/v1/projects/push", classification: "mutation", requestDataSchema: projectPushDataSchema, successStatus: 202, specificErrors: [projectNotFound, workspaceNotFound, sourceUnavailable, e("GITHUB_AUTHORITY_INVALID"), e("GITHUB_CONNECTION_DISABLED"), e("GITHUB_AUTHORITY_GENERATION_STALE"), e("GITHUB_INSTALLATION_REMOVED"), e("GITHUB_INSTALLATION_SUSPENDED"), e("GITHUB_REPOSITORY_ACCESS_UNAVAILABLE"), e("GITHUB_UPSTREAM_TRANSIENT"), e("GITHUB_INSTALLATION_UNAVAILABLE"), e("GITHUB_REPOSITORY_NOT_AUTHORIZED"), e("GITHUB_CONTENTS_WRITE_PERMISSION_REQUIRED"), e("GITHUB_GIT_AUTHENTICATION_FAILED"), e("GITHUB_PUSH_INTENT_STALE"), e("GITHUB_PUSH_NON_FAST_FORWARD"), e("GITHUB_PUSH_OUTCOME_UNCERTAIN"), e("GITHUB_TOKEN_LEASE_ACTIVE")] }),
  endpoint({ operation: "project.git.inspect", method: "POST", path: "/v1/projects/inspect-git", classification: "non-mutating", requestDataSchema: inspectGitDataSchema, successStatus: 200, successDataSchema: gitInspectionDataSchema, specificErrors: [projectNotFound, workspaceNotFound, sourceUnavailable, e("GIT_OPERATION_FAILED", z.strictObject({ action: z.literal("inspect") }))] }),
  endpoint({ operation: "project.git.diff", method: "POST", path: "/v1/projects/git-diff", classification: "non-mutating", requestDataSchema: gitDiffDataRequestSchema, successStatus: 200, successDataSchema: gitDiffDataSchema, specificErrors: [projectNotFound, workspaceNotFound, e("WORKSPACE_PATH_INVALID"), e("WORKSPACE_FILE_NOT_FOUND"), e("GIT_OPERATION_FAILED", z.strictObject({ action: z.literal("diff") }))] }),
  endpoint({ operation: "project.git.stage", method: "POST", path: "/v1/projects/stage", classification: "mutation", requestDataSchema: gitWorkspaceFileDataSchema, successStatus: 202, specificErrors: [projectNotFound, workspaceNotFound, e("WORKSPACE_PATH_INVALID"), e("WORKSPACE_FILE_NOT_FOUND"), e("WORKSPACE_FILE_UNSUPPORTED"), e("GIT_OPERATION_FAILED", z.strictObject({ action: z.literal("stage") }))] }),
  endpoint({ operation: "project.git.unstage", method: "POST", path: "/v1/projects/unstage", classification: "mutation", requestDataSchema: gitWorkspaceFileDataSchema, successStatus: 202, specificErrors: [projectNotFound, workspaceNotFound, e("WORKSPACE_PATH_INVALID"), e("WORKSPACE_FILE_NOT_FOUND"), e("GIT_OPERATION_FAILED", z.strictObject({ action: z.literal("unstage") }))] }),
  endpoint({ operation: "project.git.commit", method: "POST", path: "/v1/projects/commit", classification: "mutation", requestDataSchema: gitCommitDataSchema, successStatus: 202, specificErrors: [projectNotFound, workspaceNotFound, e("GIT_NOTHING_TO_COMMIT"), e("GIT_COMMIT_MESSAGE_INVALID"), e("GIT_IDENTITY_REQUIRED"), e("GIT_OPERATION_FAILED", z.strictObject({ action: z.literal("commit") }))] }),
  endpoint({ operation: "workspace.create", method: "POST", path: "/v1/workspaces/create", classification: "mutation", requestDataSchema: createWorkspaceDataSchema, successStatus: 202, specificErrors: [projectNotFound, configurationNotRegistered, e("WORKSPACE_STATE_CONFLICT", workspaceConflictDetails("create")), e("RUNTIME_POLICY_VIOLATION", runtimePolicyDetails("workspace-action-rejected")), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "workspace.inspect", method: "POST", path: "/v1/workspaces/inspect", classification: "non-mutating", requestDataSchema: workspaceIdentityDataSchema, successStatus: 200, successDataSchema: workspaceInspectionDataSchema, specificErrors: [projectNotFound, workspaceNotFound, rootlessRuntimeUnavailable] }),
  endpoint({ operation: "workspace.files.list", method: "POST", path: "/v1/workspaces/files/list", classification: "non-mutating", requestDataSchema: listWorkspaceFilesDataSchema, successStatus: 200, successDataSchema: workspaceFilesListResultSchema, specificErrors: [projectNotFound, workspaceNotFound, e("WORKSPACE_PATH_INVALID"), e("WORKSPACE_FILE_NOT_FOUND"), e("WORKSPACE_DIRECTORY_TOO_LARGE")] }),
  endpoint({ operation: "workspace.files.read", method: "POST", path: "/v1/workspaces/files/read", classification: "non-mutating", requestDataSchema: readWorkspaceFileDataSchema, successStatus: 200, successDataSchema: workspaceFileReadResultSchema, specificErrors: [projectNotFound, workspaceNotFound, e("WORKSPACE_PATH_INVALID"), e("WORKSPACE_FILE_NOT_FOUND"), e("WORKSPACE_FILE_TOO_LARGE"), e("WORKSPACE_FILE_UNSUPPORTED")] }),
  endpoint({ operation: "workspace.files.save", method: "POST", path: "/v1/workspaces/files/save", classification: "non-mutating", requestDataSchema: saveWorkspaceFileDataSchema, successStatus: 200, successDataSchema: workspaceFileSaveResultSchema, specificErrors: [projectNotFound, workspaceNotFound, e("WORKSPACE_PATH_INVALID"), e("WORKSPACE_FILE_NOT_FOUND"), e("WORKSPACE_FILE_TOO_LARGE"), e("WORKSPACE_FILE_UNSUPPORTED"), e("WORKSPACE_FILE_CHANGED")] }),
  endpoint({ operation: "workspace.start", method: "POST", path: "/v1/workspaces/start", classification: "mutation", requestDataSchema: workspaceIdentityDataSchema, successStatus: 202, specificErrors: [projectNotFound, workspaceNotFound, configurationNotRegistered, e("WORKSPACE_STATE_CONFLICT", workspaceConflictDetails("start")), e("RUNTIME_POLICY_VIOLATION", runtimePolicyDetails("workspace-action-rejected")), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "workspace.stop", method: "POST", path: "/v1/workspaces/stop", classification: "mutation", requestDataSchema: workspaceIdentityDataSchema, successStatus: 202, specificErrors: [projectNotFound, workspaceNotFound, e("WORKSPACE_STATE_CONFLICT", workspaceConflictDetails("stop")), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "workspace.rebuild", method: "POST", path: "/v1/workspaces/rebuild", classification: "mutation", requestDataSchema: rebuildWorkspaceDataSchema, successStatus: 202, specificErrors: [projectNotFound, workspaceNotFound, configurationNotRegistered, e("WORKSPACE_STATE_CONFLICT", workspaceConflictDetails("rebuild")), e("RUNTIME_POLICY_VIOLATION", runtimePolicyDetails("workspace-action-rejected")), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "workspace.archive", method: "POST", path: "/v1/workspaces/archive", classification: "mutation", requestDataSchema: archiveWorkspaceDataSchema, successStatus: 202, specificErrors: [projectNotFound, workspaceNotFound, e("WORKSPACE_STATE_CONFLICT", workspaceConflictDetails("archive")), e("DIRTY_WORKSPACE_REQUIRES_ACTION", dirtyWorkspaceDetails("archive")), e("RUNTIME_POLICY_VIOLATION", runtimePolicyDetails("workspace-action-rejected")), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "workspace.remove", method: "POST", path: "/v1/workspaces/remove", classification: "mutation", requestDataSchema: removeWorkspaceDataSchema, successStatus: 202, specificErrors: [projectNotFound, workspaceNotFound, e("WORKSPACE_STATE_CONFLICT", workspaceConflictDetails("remove")), e("DIRTY_WORKSPACE_REQUIRES_ACTION", dirtyWorkspaceDetails("remove")), e("RUNTIME_POLICY_VIOLATION", runtimePolicyDetails("workspace-action-rejected")), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "task.start", method: "POST", path: "/v1/tasks/start", classification: "mutation", requestDataSchema: startTaskDataSchema, successStatus: 202, specificErrors: [projectNotFound, workspaceNotFound, configurationNotRegistered, e("WORKSPACE_STATE_CONFLICT", workspaceConflictDetails("run-task")), e("RESOURCE_STATE_CONFLICT", resourceStateDetails(["task-run", "process"], ["start"])), e("TASK_NOT_DEFINED"), e("RUNTIME_POLICY_VIOLATION", runtimePolicyDetails("task-action-rejected")), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "process.stop", method: "POST", path: "/v1/processes/stop", classification: "mutation", requestDataSchema: processIdentityDataSchema, successStatus: 202, specificErrors: [projectNotFound, e("RESOURCE_NOT_FOUND", resourceDetails(["workspace", "process"])), e("RESOURCE_STATE_CONFLICT", resourceStateDetails(["process"], ["stop"])), e("PROCESS_IDENTITY_MISMATCH"), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "process.inspect", method: "POST", path: "/v1/processes/inspect", classification: "non-mutating", requestDataSchema: processIdentityDataSchema, successStatus: 200, successDataSchema: processInspectionDataSchema, specificErrors: [projectNotFound, e("RESOURCE_NOT_FOUND", resourceDetails(["workspace", "process"])), e("PROCESS_IDENTITY_MISMATCH"), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "terminal.create", method: "POST", path: "/v1/terminals/create", classification: "mutation", requestDataSchema: createTerminalDataSchema, successStatus: 202, specificErrors: [projectNotFound, workspaceNotFound, configurationNotRegistered, e("WORKSPACE_STATE_CONFLICT", workspaceConflictDetails("create-terminal")), e("RESOURCE_STATE_CONFLICT", resourceStateDetails(["terminal"], ["create"])), e("RUNTIME_POLICY_VIOLATION", runtimePolicyDetails("terminal-action-rejected")), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "terminal.close", method: "POST", path: "/v1/terminals/close", classification: "mutation", requestDataSchema: terminalIdentityDataSchema, successStatus: 202, specificErrors: [projectNotFound, e("RESOURCE_NOT_FOUND", resourceDetails(["workspace", "terminal"])), e("RESOURCE_STATE_CONFLICT", resourceStateDetails(["terminal"], ["close"])), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "terminal.stream", method: "GET", path: "/v1/terminals/{terminalId}/stream", classification: "websocket-upgrade", pathParametersSchema: terminalPathParametersSchema, successStatus: 101, specificErrors: [e("RESOURCE_NOT_FOUND", resourceDetails(["terminal"])), e("RESOURCE_STATE_CONFLICT", resourceStateDetails(["terminal"], ["attach"])), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "preview.activate", method: "POST", path: "/v1/previews/activate", classification: "mutation", requestDataSchema: activatePreviewDataSchema, successStatus: 202, specificErrors: [projectNotFound, workspaceNotFound, configurationNotRegistered, e("WORKSPACE_STATE_CONFLICT", workspaceConflictDetails("activate-preview")), e("RESOURCE_STATE_CONFLICT", resourceStateDetails(["preview"], ["activate"])), e("PREVIEW_NOT_DEFINED"), e("RUNTIME_POLICY_VIOLATION", runtimePolicyDetails("preview-action-rejected")), e("PREVIEW_DOMAIN_NOT_APPROVED"), e("GATEWAY_UPDATE_FAILED"), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "preview.deactivate", method: "POST", path: "/v1/previews/deactivate", classification: "mutation", requestDataSchema: previewIdentityDataSchema, successStatus: 202, specificErrors: [projectNotFound, e("RESOURCE_NOT_FOUND", resourceDetails(["workspace", "preview"])), e("RESOURCE_STATE_CONFLICT", resourceStateDetails(["preview"], ["deactivate"])), e("GATEWAY_UPDATE_FAILED"), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "preview.inspect", method: "POST", path: "/v1/previews/inspect", classification: "non-mutating", requestDataSchema: previewIdentityDataSchema, successStatus: 200, successDataSchema: previewInspectionDataSchema, specificErrors: [projectNotFound, e("RESOURCE_NOT_FOUND", resourceDetails(["workspace", "preview"])), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "ai-session.start", method: "POST", path: "/v1/ai-sessions/start", classification: "mutation", requestDataSchema: startAiSessionDataSchema, successStatus: 202, specificErrors: [projectNotFound, workspaceNotFound, configurationNotRegistered, e("WORKSPACE_STATE_CONFLICT", workspaceConflictDetails("start-ai-session")), e("RESOURCE_STATE_CONFLICT", resourceStateDetails(["ai-session"], ["start"])), e("AI_NOT_CONFIGURED"), e("RUNTIME_POLICY_VIOLATION", runtimePolicyDetails("ai-profile-rejected")), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "ai-session.interrupt", method: "POST", path: "/v1/ai-sessions/interrupt", classification: "mutation", requestDataSchema: aiSessionIdentityDataSchema, successStatus: 202, specificErrors: [projectNotFound, e("RESOURCE_NOT_FOUND", resourceDetails(["workspace", "ai-session"])), e("RESOURCE_STATE_CONFLICT", resourceStateDetails(["ai-session"], ["interrupt"])), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "ai-session.stop", method: "POST", path: "/v1/ai-sessions/stop", classification: "mutation", requestDataSchema: aiSessionIdentityDataSchema, successStatus: 202, specificErrors: [projectNotFound, e("RESOURCE_NOT_FOUND", resourceDetails(["workspace", "ai-session"])), e("RESOURCE_STATE_CONFLICT", resourceStateDetails(["ai-session"], ["stop"])), rootlessRuntimeUnavailable] }),
  endpoint({ operation: "ai-session.resume", method: "POST", path: "/v1/ai-sessions/resume", classification: "mutation", requestDataSchema: resumeAiSessionDataSchema, successStatus: 202, specificErrors: [projectNotFound, e("RESOURCE_NOT_FOUND", resourceDetails(["workspace", "ai-session"])), configurationNotRegistered, e("RESOURCE_STATE_CONFLICT", resourceStateDetails(["ai-session"], ["resume"])), e("RUNTIME_POLICY_VIOLATION", runtimePolicyDetails("ai-profile-rejected")), rootlessRuntimeUnavailable] })
] as const);

export type AgentApiV1Endpoint = (typeof agentApiV1Endpoints)[number];
export type AgentApiV1Operation = AgentApiV1Endpoint["operation"];
export type AgentApiV1EndpointByOperation = {
  readonly [Endpoint in AgentApiV1Endpoint as Endpoint["operation"]]: Endpoint;
};
export const agentApiV1EndpointByOperation = Object.freeze(Object.fromEntries(
  agentApiV1Endpoints.map((descriptor) => [descriptor.operation, descriptor])
) as AgentApiV1EndpointByOperation);

/**
 * F09's four AI descriptors were never implemented and are retained only as a
 * historical compatibility inventory. F11 is the sole executable AI authority.
 */
export const f09HistoricalAgentApiV1Endpoints = agentApiV1Endpoints;
const supersededF09AiOperations = [
  "ai-session.start",
  "ai-session.interrupt",
  "ai-session.stop",
  "ai-session.resume"
] as const;
type SupersededF09AiOperation = (typeof supersededF09AiOperations)[number];
export type NonAiAgentApiV1Endpoint = Exclude<
  AgentApiV1Endpoint,
  { readonly operation: SupersededF09AiOperation }
>;
function isNonAiAgentApiV1Endpoint(
  endpoint: AgentApiV1Endpoint
): endpoint is NonAiAgentApiV1Endpoint {
  return !(supersededF09AiOperations as readonly string[]).includes(endpoint.operation);
}
export const nonAiAgentApiV1Endpoints = Object.freeze(
  agentApiV1Endpoints.filter(isNonAiAgentApiV1Endpoint)
);
