import { describe, expect, expectTypeOf, test } from "vitest";
import {
  type AgentExecutionFailure,
  type AgentExecutionFailureCode,
  type AgentExecutionFailureForOperation,
  type AgentMutationOperation,
  agentExecutionFailureApplicability,
  agentExecutionFailureCodes,
  agentExecutionFailureSchema
} from "@devspace/contracts";

type AssertTrue<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;
type HasCode<Failure, Code extends string> = Extract<Failure, { readonly code: Code }> extends never
  ? false
  : true;
type RegisterFailure = AgentExecutionFailureForOperation<"configuration-revision.register">;
type PreviewActivateFailure = AgentExecutionFailureForOperation<"preview.activate">;
type PreviewActivateCodes =
  | "PROJECT_NOT_FOUND"
  | "RESOURCE_NOT_FOUND"
  | "CONFIGURATION_NOT_REGISTERED"
  | "WORKSPACE_STATE_CONFLICT"
  | "RESOURCE_STATE_CONFLICT"
  | "PREVIEW_NOT_DEFINED"
  | "RUNTIME_POLICY_VIOLATION"
  | "PREVIEW_DOMAIN_NOT_APPROVED"
  | "GATEWAY_UPDATE_FAILED"
  | "ROOTLESS_RUNTIME_UNAVAILABLE"
  | "AGENT_INTERNAL_ERROR";
const registerHasInternal: AssertTrue<HasCode<RegisterFailure, "AGENT_INTERNAL_ERROR">> = true;
const registerHasRuntimeFailure: AssertFalse<HasCode<RegisterFailure, "ROOTLESS_RUNTIME_UNAVAILABLE">> = false;
const registerHasResourceFailure: AssertFalse<HasCode<RegisterFailure, "RESOURCE_STATE_CONFLICT">> = false;
const previewHasProjectFailure: AssertTrue<HasCode<PreviewActivateFailure, "PROJECT_NOT_FOUND">> = true;
const previewHasGatewayFailure: AssertTrue<HasCode<PreviewActivateFailure, "GATEWAY_UPDATE_FAILED">> = true;
const previewHasSourceFailure: AssertFalse<HasCode<PreviewActivateFailure, "SOURCE_UNAVAILABLE">> = false;

const id = "018f1f34-7000-7000-8000-000000000001";
const hash = `sha256-jcs-v1:${"a".repeat(64)}`;
const failure = (code: string, retryable: boolean, details: object) => ({
  code, message: "Operator-safe redacted failure", retryable, details
});

const independentApplicability = {
  "configuration-revision.register": ["AGENT_INTERNAL_ERROR"],
  "configuration-runtime-plan.register": ["CONFIGURATION_NOT_REGISTERED", "RUNTIME_POLICY_VIOLATION", "AGENT_INTERNAL_ERROR"],
  "project.managed-store.create": ["RESOURCE_STATE_CONFLICT", "SOURCE_NOT_FOUND", "SOURCE_INVALID", "SOURCE_UNAVAILABLE", "GITHUB_AUTHORITY_INVALID", "GITHUB_CONTENTS_PERMISSION_REQUIRED", "GITHUB_CONNECTION_DISABLED", "GITHUB_AUTHORITY_GENERATION_STALE", "GITHUB_INSTALLATION_REMOVED", "GITHUB_INSTALLATION_SUSPENDED", "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE", "GITHUB_UPSTREAM_TRANSIENT", "GITHUB_INSTALLATION_UNAVAILABLE", "GITHUB_REPOSITORY_NOT_AUTHORIZED", "GITHUB_GIT_AUTHENTICATION_FAILED", "GITHUB_TOKEN_LEASE_ACTIVE", "RUNTIME_POLICY_VIOLATION", "AGENT_INTERNAL_ERROR"],
  "project.fetch": ["PROJECT_NOT_FOUND", "SOURCE_UNAVAILABLE", "GITHUB_AUTHORITY_INVALID", "GITHUB_CONTENTS_PERMISSION_REQUIRED", "GITHUB_CONNECTION_DISABLED", "GITHUB_AUTHORITY_GENERATION_STALE", "GITHUB_INSTALLATION_REMOVED", "GITHUB_INSTALLATION_SUSPENDED", "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE", "GITHUB_UPSTREAM_TRANSIENT", "GITHUB_INSTALLATION_UNAVAILABLE", "GITHUB_REPOSITORY_NOT_AUTHORIZED", "GITHUB_GIT_AUTHENTICATION_FAILED", "GITHUB_TOKEN_LEASE_ACTIVE", "AGENT_INTERNAL_ERROR"],
  "project.push": ["PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND", "SOURCE_UNAVAILABLE", "GITHUB_AUTHORITY_INVALID", "GITHUB_CONTENTS_WRITE_PERMISSION_REQUIRED", "GITHUB_CONNECTION_DISABLED", "GITHUB_AUTHORITY_GENERATION_STALE", "GITHUB_INSTALLATION_REMOVED", "GITHUB_INSTALLATION_SUSPENDED", "GITHUB_REPOSITORY_ACCESS_UNAVAILABLE", "GITHUB_UPSTREAM_TRANSIENT", "GITHUB_INSTALLATION_UNAVAILABLE", "GITHUB_REPOSITORY_NOT_AUTHORIZED", "GITHUB_GIT_AUTHENTICATION_FAILED", "GITHUB_PUSH_INTENT_STALE", "GITHUB_PUSH_NON_FAST_FORWARD", "GITHUB_PUSH_OUTCOME_UNCERTAIN", "GITHUB_TOKEN_LEASE_ACTIVE", "AGENT_INTERNAL_ERROR"],
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
} as const;

const validFailures = [
  failure("CONFIGURATION_NOT_REGISTERED", false, { revisionId: id, revisionHash: hash }),
  failure("RUNTIME_POLICY_VIOLATION", false, { policy: "source-not-approved" }),
  failure("PROJECT_NOT_FOUND", false, { projectId: id }),
  failure("RESOURCE_NOT_FOUND", false, { resource: { type: "workspace", id } }),
  failure("SOURCE_NOT_FOUND", false, { sourceId: id }),
  failure("SOURCE_INVALID", false, { reason: "not-a-git-repository" }),
  failure("SOURCE_UNAVAILABLE", true, {}),
  failure("GITHUB_CONTENTS_PERMISSION_REQUIRED", false, {}),
  failure("GITHUB_CONTENTS_WRITE_PERMISSION_REQUIRED", false, {}),
  failure("GITHUB_AUTHORITY_INVALID", false, { reason: "permission-required" }),
  failure("GITHUB_CONNECTION_DISABLED", false, {}),
  failure("GITHUB_AUTHORITY_GENERATION_STALE", false, {}),
  failure("GITHUB_INSTALLATION_REMOVED", false, {}),
  failure("GITHUB_INSTALLATION_SUSPENDED", false, {}),
  failure("GITHUB_REPOSITORY_ACCESS_UNAVAILABLE", false, {}),
  failure("GITHUB_UPSTREAM_TRANSIENT", true, {}),
  failure("GITHUB_INSTALLATION_UNAVAILABLE", true, {}),
  failure("GITHUB_REPOSITORY_NOT_AUTHORIZED", false, {}),
  failure("GITHUB_GIT_AUTHENTICATION_FAILED", false, {}),
  failure("GITHUB_TOKEN_LEASE_ACTIVE", true, {}),
  failure("GITHUB_PUSH_INTENT_STALE", false, {}),
  failure("GITHUB_PUSH_NON_FAST_FORWARD", false, {}),
  failure("GITHUB_PUSH_OUTCOME_UNCERTAIN", false, {}),
  failure("WORKSPACE_STATE_CONFLICT", false, {
    workspaceId: id, desiredState: "running", observedState: "stopped", action: "start"
  }),
  failure("RESOURCE_STATE_CONFLICT", false, { resource: { type: "process", id }, action: "stop" }),
  failure("DIRTY_WORKSPACE_REQUIRES_ACTION", false, { workspaceId: id, requestedAction: "archive" }),
  failure("TASK_NOT_DEFINED", false, { revisionId: id, taskKey: "test" }),
  failure("PROCESS_IDENTITY_MISMATCH", false, { processId: id }),
  failure("PREVIEW_NOT_DEFINED", false, { revisionId: id, previewKey: "app" }),
  failure("AI_NOT_CONFIGURED", false, { workspaceId: id, revisionId: id }),
  failure("PREVIEW_DOMAIN_NOT_APPROVED", false, { previewId: id }),
  failure("GATEWAY_UPDATE_FAILED", true, { previewId: id }),
  failure("ROOTLESS_RUNTIME_UNAVAILABLE", true, { component: "docker" }),
  failure("AGENT_INTERNAL_ERROR", true, { incidentId: id })
];

describe("F10 AgentExecutionFailure", () => {
  test("preserves exact global and per-operation declaration unions", () => {
    expectTypeOf<AgentExecutionFailureCode>().toEqualTypeOf<typeof agentExecutionFailureCodes[number]>();
    expectTypeOf<AgentExecutionFailure["code"]>().toEqualTypeOf<typeof agentExecutionFailureCodes[number]>();
    expectTypeOf<RegisterFailure["code"]>().toEqualTypeOf<"AGENT_INTERNAL_ERROR">();
    expectTypeOf<PreviewActivateFailure["code"]>().toEqualTypeOf<PreviewActivateCodes>();
    expectTypeOf<AgentMutationOperation>().toEqualTypeOf<keyof typeof agentExecutionFailureApplicability>();
    expect(registerHasInternal).toBe(true);
    expect(registerHasRuntimeFailure).toBe(false);
    expect(registerHasResourceFailure).toBe(false);
    expect(previewHasProjectFailure).toBe(true);
    expect(previewHasGatewayFailure).toBe(true);
    expect(previewHasSourceFailure).toBe(false);
    expectTypeOf<RegisterFailure>().toMatchTypeOf<AgentExecutionFailure>();
    expectTypeOf<PreviewActivateFailure>().toMatchTypeOf<AgentExecutionFailure>();
  });

  test("contains exactly the accepted 30 variants", () => {
    expect(agentExecutionFailureCodes).toHaveLength(34);
    expect(new Set(agentExecutionFailureCodes).size).toBe(34);
    for (const value of validFailures) {
      expect(agentExecutionFailureSchema.safeParse(value).success, value.code).toBe(true);
    }
  });

  test.each([
    "PROTOCOL_VERSION_UNSUPPORTED",
    "REQUEST_INVALID",
    "OPERATION_CONFLICT",
    "OPERATION_JOURNAL_UNAVAILABLE",
    "CONFIGURATION_INVALID",
    "EVENT_CURSOR_INVALID",
    "EVENT_SNAPSHOT_REQUIRED"
  ])("excludes %s", (code) => {
    expect(agentExecutionFailureCodes).not.toContain(code);
    expect(agentExecutionFailureSchema.safeParse(failure(code, false, {})).success).toBe(false);
  });

  test("preserves strict details and retryability literals", () => {
    expect(agentExecutionFailureSchema.safeParse(
      failure("SOURCE_UNAVAILABLE", false, {})
    ).success).toBe(false);
    expect(agentExecutionFailureSchema.safeParse(
      failure("GATEWAY_UPDATE_FAILED", true, { previewId: id, rawError: "forbidden" })
    ).success).toBe(false);
  });

  test("matches every independent operation applicability row", () => {
    expect(Object.keys(agentExecutionFailureApplicability)).toEqual(Object.keys(independentApplicability));
    for (const [operation, expectedCodes] of Object.entries(independentApplicability)) {
      expect(agentExecutionFailureApplicability[
        operation as keyof typeof agentExecutionFailureApplicability
      ].codes, operation).toEqual(expectedCodes);
    }
  });

  test("retains route-specific resource, action, and policy narrowing", () => {
    const start = agentExecutionFailureApplicability["workspace.start"].schema;
    expect(start.safeParse(failure("RESOURCE_NOT_FOUND", false, {
      resource: { type: "workspace", id }
    })).success).toBe(true);
    expect(start.safeParse(failure("RESOURCE_NOT_FOUND", false, {
      resource: { type: "process", id }
    })).success).toBe(false);
    expect(start.safeParse(failure("WORKSPACE_STATE_CONFLICT", false, {
      workspaceId: id, desiredState: "running", observedState: "stopped", action: "start"
    })).success).toBe(true);
    expect(start.safeParse(failure("WORKSPACE_STATE_CONFLICT", false, {
      workspaceId: id, desiredState: "running", observedState: "stopped", action: "stop"
    })).success).toBe(false);
    expect(start.safeParse(failure("RUNTIME_POLICY_VIOLATION", false, {
      policy: "workspace-action-rejected"
    })).success).toBe(true);
    expect(start.safeParse(failure("RUNTIME_POLICY_VIOLATION", false, {
      policy: "task-action-rejected"
    })).success).toBe(false);
  });

  test("does not widen a narrow row to the full 30-code union", () => {
    const register = agentExecutionFailureApplicability["configuration-revision.register"].schema;
    expect(register.safeParse(failure("AGENT_INTERNAL_ERROR", true, { incidentId: id })).success).toBe(true);
    expect(register.safeParse(failure("SOURCE_UNAVAILABLE", true, {})).success).toBe(false);
  });
});
