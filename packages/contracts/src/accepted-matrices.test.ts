import { describe, expect, expectTypeOf, test } from "vitest";
import {
  agentApiV1EndpointByOperation,
  agentApiV1Endpoints,
  type AgentApiV1Operation
} from "@devspace/contracts";

const acceptedEndpoints = [
  ["agent.health.get", "GET", "/v1/health", "non-mutating", 200, false],
  ["agent.capabilities.get", "GET", "/v1/capabilities", "non-mutating", 200, false],
  ["agent.runtime-status.get", "GET", "/v1/runtime/status", "non-mutating", 200, false],
  ["configuration-revision.validate", "POST", "/v1/configuration-revisions/validate", "non-mutating", 200, false],
  ["configuration-revision.register", "POST", "/v1/configuration-revisions/register", "mutation", 202, true],
  ["configuration-runtime-plan.register", "POST", "/v1/configuration-revisions/register-runtime-plan", "mutation", 202, true],
  ["project.source.inspect", "POST", "/v1/projects/inspect-source", "non-mutating", 200, false],
  ["project.managed-store.create", "POST", "/v1/projects/create-managed-store", "mutation", 202, true],
  ["project.fetch", "POST", "/v1/projects/fetch", "mutation", 202, true],
  ["project.push", "POST", "/v1/projects/push", "mutation", 202, true],
  ["project.git.inspect", "POST", "/v1/projects/inspect-git", "non-mutating", 200, false],
  ["workspace.create", "POST", "/v1/workspaces/create", "mutation", 202, true],
  ["workspace.inspect", "POST", "/v1/workspaces/inspect", "non-mutating", 200, false],
  ["workspace.files.list", "POST", "/v1/workspaces/files/list", "non-mutating", 200, false],
  ["workspace.files.read", "POST", "/v1/workspaces/files/read", "non-mutating", 200, false],
  ["workspace.files.save", "POST", "/v1/workspaces/files/save", "non-mutating", 200, false],
  ["workspace.start", "POST", "/v1/workspaces/start", "mutation", 202, true],
  ["workspace.stop", "POST", "/v1/workspaces/stop", "mutation", 202, true],
  ["workspace.rebuild", "POST", "/v1/workspaces/rebuild", "mutation", 202, true],
  ["workspace.archive", "POST", "/v1/workspaces/archive", "mutation", 202, true],
  ["workspace.remove", "POST", "/v1/workspaces/remove", "mutation", 202, true],
  ["task.start", "POST", "/v1/tasks/start", "mutation", 202, true],
  ["process.stop", "POST", "/v1/processes/stop", "mutation", 202, true],
  ["process.inspect", "POST", "/v1/processes/inspect", "non-mutating", 200, false],
  ["terminal.create", "POST", "/v1/terminals/create", "mutation", 202, true],
  ["terminal.close", "POST", "/v1/terminals/close", "mutation", 202, true],
  ["terminal.stream", "GET", "/v1/terminals/{terminalId}/stream", "websocket-upgrade", 101, false],
  ["preview.activate", "POST", "/v1/previews/activate", "mutation", 202, true],
  ["preview.deactivate", "POST", "/v1/previews/deactivate", "mutation", 202, true],
  ["preview.inspect", "POST", "/v1/previews/inspect", "non-mutating", 200, false],
  ["ai-session.start", "POST", "/v1/ai-sessions/start", "mutation", 202, true],
  ["ai-session.interrupt", "POST", "/v1/ai-sessions/interrupt", "mutation", 202, true],
  ["ai-session.stop", "POST", "/v1/ai-sessions/stop", "mutation", 202, true],
  ["ai-session.resume", "POST", "/v1/ai-sessions/resume", "mutation", 202, true]
] as const;
type AcceptedOperation = (typeof acceptedEndpoints)[number][0];

const G = ["PROTOCOL_VERSION_UNSUPPORTED", "REQUEST_INVALID", "AGENT_INTERNAL_ERROR"] as const;
const M = ["OPERATION_CONFLICT", "OPERATION_JOURNAL_UNAVAILABLE"] as const;
const readErrors = (...specific: readonly string[]) => [...G, ...specific];
const mutationErrors = (...specific: readonly string[]) => [...G, ...M, ...specific];

const acceptedStatuses: Readonly<Record<string, readonly number[]>> = {
  PROTOCOL_VERSION_UNSUPPORTED: [400, 426], REQUEST_INVALID: [400], AGENT_INTERNAL_ERROR: [500],
  OPERATION_CONFLICT: [409], OPERATION_JOURNAL_UNAVAILABLE: [503], CONFIGURATION_INVALID: [422],
  CONFIGURATION_NOT_REGISTERED: [422], RUNTIME_POLICY_VIOLATION: [422], PROJECT_NOT_FOUND: [404],
  RESOURCE_NOT_FOUND: [404], SOURCE_NOT_FOUND: [404], SOURCE_INVALID: [422], SOURCE_UNAVAILABLE: [503],
  WORKSPACE_PATH_INVALID: [422], WORKSPACE_FILE_NOT_FOUND: [404], WORKSPACE_FILE_TOO_LARGE: [413],
  WORKSPACE_DIRECTORY_TOO_LARGE: [413], WORKSPACE_FILE_UNSUPPORTED: [422], WORKSPACE_FILE_CHANGED: [409],
  WORKSPACE_STATE_CONFLICT: [409], RESOURCE_STATE_CONFLICT: [409], DIRTY_WORKSPACE_REQUIRES_ACTION: [409],
  TASK_NOT_DEFINED: [422], PROCESS_IDENTITY_MISMATCH: [409], PREVIEW_NOT_DEFINED: [422],
  AI_NOT_CONFIGURED: [422], PREVIEW_DOMAIN_NOT_APPROVED: [422], GATEWAY_UPDATE_FAILED: [503],
  GITHUB_CONNECTION_NOT_FOUND: [404], GITHUB_AUTHORITY_INVALID: [409, 422, 503], GITHUB_TOKEN_LEASE_ACTIVE: [503],
  GITHUB_CONNECTION_DISABLED: [409], GITHUB_AUTHORITY_GENERATION_STALE: [409], GITHUB_INSTALLATION_REMOVED: [410],
  GITHUB_INSTALLATION_SUSPENDED: [403], GITHUB_REPOSITORY_ACCESS_UNAVAILABLE: [403, 404], GITHUB_UPSTREAM_TRANSIENT: [503],
  GITHUB_CONTENTS_PERMISSION_REQUIRED: [403, 422], GITHUB_CONTENTS_WRITE_PERMISSION_REQUIRED: [403, 422],
  GITHUB_INSTALLATION_UNAVAILABLE: [503],
  GITHUB_PUSH_INTENT_STALE: [409], GITHUB_PUSH_NON_FAST_FORWARD: [409], GITHUB_PUSH_OUTCOME_UNCERTAIN: [503],
  GITHUB_REPOSITORY_NOT_AUTHORIZED: [403, 404], GITHUB_GIT_AUTHENTICATION_FAILED: [502, 503],
  ROOTLESS_RUNTIME_UNAVAILABLE: [503]
};

const acceptedRouteErrors: Readonly<Record<string, readonly string[]>> = {
  "agent.health.get": readErrors(),
  "agent.capabilities.get": readErrors(),
  "agent.runtime-status.get": readErrors(),
  "configuration-revision.validate": readErrors("CONFIGURATION_INVALID"),
  "configuration-revision.register": mutationErrors("CONFIGURATION_INVALID"),
  "configuration-runtime-plan.register": mutationErrors("CONFIGURATION_NOT_REGISTERED", "CONFIGURATION_INVALID", "RUNTIME_POLICY_VIOLATION"),
  "project.source.inspect": readErrors("SOURCE_NOT_FOUND", "SOURCE_UNAVAILABLE", "GITHUB_AUTHORITY_INVALID", "GITHUB_CONNECTION_DISABLED", "GITHUB_AUTHORITY_GENERATION_STALE", "GITHUB_INSTALLATION_REMOVED", "GITHUB_INSTALLATION_SUSPENDED", "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE", "GITHUB_UPSTREAM_TRANSIENT", "GITHUB_INSTALLATION_UNAVAILABLE", "GITHUB_REPOSITORY_NOT_AUTHORIZED", "GITHUB_CONTENTS_PERMISSION_REQUIRED", "GITHUB_GIT_AUTHENTICATION_FAILED", "GITHUB_TOKEN_LEASE_ACTIVE", "RUNTIME_POLICY_VIOLATION"),
  "project.managed-store.create": mutationErrors("RESOURCE_STATE_CONFLICT", "SOURCE_NOT_FOUND", "SOURCE_INVALID", "SOURCE_UNAVAILABLE", "GITHUB_AUTHORITY_INVALID", "GITHUB_CONNECTION_DISABLED", "GITHUB_AUTHORITY_GENERATION_STALE", "GITHUB_INSTALLATION_REMOVED", "GITHUB_INSTALLATION_SUSPENDED", "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE", "GITHUB_UPSTREAM_TRANSIENT", "GITHUB_INSTALLATION_UNAVAILABLE", "GITHUB_REPOSITORY_NOT_AUTHORIZED", "GITHUB_CONTENTS_PERMISSION_REQUIRED", "GITHUB_GIT_AUTHENTICATION_FAILED", "GITHUB_TOKEN_LEASE_ACTIVE", "RUNTIME_POLICY_VIOLATION"),
  "project.fetch": mutationErrors("PROJECT_NOT_FOUND", "SOURCE_UNAVAILABLE", "GITHUB_AUTHORITY_INVALID", "GITHUB_CONNECTION_DISABLED", "GITHUB_AUTHORITY_GENERATION_STALE", "GITHUB_INSTALLATION_REMOVED", "GITHUB_INSTALLATION_SUSPENDED", "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE", "GITHUB_UPSTREAM_TRANSIENT", "GITHUB_INSTALLATION_UNAVAILABLE", "GITHUB_REPOSITORY_NOT_AUTHORIZED", "GITHUB_CONTENTS_PERMISSION_REQUIRED", "GITHUB_GIT_AUTHENTICATION_FAILED", "GITHUB_TOKEN_LEASE_ACTIVE"),
  "project.push": mutationErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "SOURCE_UNAVAILABLE", "GITHUB_AUTHORITY_INVALID", "GITHUB_CONNECTION_DISABLED", "GITHUB_AUTHORITY_GENERATION_STALE", "GITHUB_INSTALLATION_REMOVED", "GITHUB_INSTALLATION_SUSPENDED", "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE", "GITHUB_UPSTREAM_TRANSIENT", "GITHUB_INSTALLATION_UNAVAILABLE", "GITHUB_REPOSITORY_NOT_AUTHORIZED", "GITHUB_CONTENTS_WRITE_PERMISSION_REQUIRED", "GITHUB_GIT_AUTHENTICATION_FAILED", "GITHUB_PUSH_INTENT_STALE", "GITHUB_PUSH_NON_FAST_FORWARD", "GITHUB_PUSH_OUTCOME_UNCERTAIN", "GITHUB_TOKEN_LEASE_ACTIVE"),
  "project.git.inspect": readErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "SOURCE_UNAVAILABLE"),
  "workspace.create": mutationErrors("PROJECT_NOT_FOUND", "CONFIGURATION_NOT_REGISTERED", "WORKSPACE_STATE_CONFLICT", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "workspace.inspect": readErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "workspace.files.list": readErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "WORKSPACE_PATH_INVALID", "WORKSPACE_FILE_NOT_FOUND", "WORKSPACE_DIRECTORY_TOO_LARGE"),
  "workspace.files.read": readErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "WORKSPACE_PATH_INVALID", "WORKSPACE_FILE_NOT_FOUND", "WORKSPACE_FILE_TOO_LARGE", "WORKSPACE_FILE_UNSUPPORTED"),
  "workspace.files.save": readErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "WORKSPACE_PATH_INVALID", "WORKSPACE_FILE_NOT_FOUND", "WORKSPACE_FILE_TOO_LARGE", "WORKSPACE_FILE_UNSUPPORTED", "WORKSPACE_FILE_CHANGED"),
  "workspace.start": mutationErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "CONFIGURATION_NOT_REGISTERED", "WORKSPACE_STATE_CONFLICT", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "workspace.stop": mutationErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "WORKSPACE_STATE_CONFLICT", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "workspace.rebuild": mutationErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "CONFIGURATION_NOT_REGISTERED", "WORKSPACE_STATE_CONFLICT", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "workspace.archive": mutationErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "WORKSPACE_STATE_CONFLICT", "DIRTY_WORKSPACE_REQUIRES_ACTION", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "workspace.remove": mutationErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "WORKSPACE_STATE_CONFLICT", "DIRTY_WORKSPACE_REQUIRES_ACTION", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "task.start": mutationErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "CONFIGURATION_NOT_REGISTERED", "WORKSPACE_STATE_CONFLICT", "RESOURCE_STATE_CONFLICT", "TASK_NOT_DEFINED", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "process.stop": mutationErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "RESOURCE_STATE_CONFLICT", "PROCESS_IDENTITY_MISMATCH", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "process.inspect": readErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "PROCESS_IDENTITY_MISMATCH", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "terminal.create": mutationErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "CONFIGURATION_NOT_REGISTERED", "WORKSPACE_STATE_CONFLICT", "RESOURCE_STATE_CONFLICT", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "terminal.close": mutationErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "RESOURCE_STATE_CONFLICT", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "terminal.stream": readErrors("RESOURCE_NOT_FOUND", "RESOURCE_STATE_CONFLICT", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "preview.activate": mutationErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "CONFIGURATION_NOT_REGISTERED", "WORKSPACE_STATE_CONFLICT", "RESOURCE_STATE_CONFLICT", "PREVIEW_NOT_DEFINED", "RUNTIME_POLICY_VIOLATION", "PREVIEW_DOMAIN_NOT_APPROVED", "GATEWAY_UPDATE_FAILED", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "preview.deactivate": mutationErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "RESOURCE_STATE_CONFLICT", "GATEWAY_UPDATE_FAILED", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "preview.inspect": readErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "ai-session.start": mutationErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "CONFIGURATION_NOT_REGISTERED", "WORKSPACE_STATE_CONFLICT", "RESOURCE_STATE_CONFLICT", "AI_NOT_CONFIGURED", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "ai-session.interrupt": mutationErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "RESOURCE_STATE_CONFLICT", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "ai-session.stop": mutationErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "RESOURCE_STATE_CONFLICT", "ROOTLESS_RUNTIME_UNAVAILABLE"),
  "ai-session.resume": mutationErrors("PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "CONFIGURATION_NOT_REGISTERED", "RESOURCE_STATE_CONFLICT", "RUNTIME_POLICY_VIOLATION", "ROOTLESS_RUNTIME_UNAVAILABLE")
};

describe("independent accepted F09 matrices", () => {
  test("matches every exact endpoint method, path, class, status, and mutation flag", () => {
    expectTypeOf<AgentApiV1Operation>().toEqualTypeOf<AcceptedOperation>();
    expect(agentApiV1Endpoints.map((endpoint) => [
      endpoint.operation,
      endpoint.method,
      endpoint.path,
      endpoint.classification,
      endpoint.successStatus,
      endpoint.journaledMutation
    ])).toEqual(acceptedEndpoints);
  });

  test("matches every route's exact error codes and statuses", () => {
    expect(Object.keys(acceptedRouteErrors)).toEqual(acceptedEndpoints.map(([operation]) => operation));
    for (const [operation, expectedCodes] of Object.entries(acceptedRouteErrors)) {
      const endpoint = agentApiV1EndpointByOperation[operation as keyof typeof agentApiV1EndpointByOperation];
      expect(endpoint.errors.map((error) => [error.code, error.statuses]), operation).toEqual(
        expectedCodes.map((code) => [code, acceptedStatuses[code]])
      );
    }
  });
});
