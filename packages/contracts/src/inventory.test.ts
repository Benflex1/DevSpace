import { describe, expect, test } from "vitest";
import {
  MUTATION_OPERATION_ID_HEADER,
  agentApiV1EndpointByOperation,
  agentApiV1Endpoints,
  githubAgentApiV1EndpointByOperation,
  githubAgentApiV1Endpoints,
  generateAgentApiV1JsonSchema
} from "./index.js";

const id = "018f1f34-7abc-7def-8abc-0123456789ab";
const id2 = "018f1f34-7abc-7def-9abc-0123456789ac";
const timestamp = "2026-07-15T12:34:56.789Z";
const hash = `sha256-jcs-v1:${"a".repeat(64)}`;
const project = { projectId: id };
const workspace = { projectId: id, workspaceId: id2 };
const process = { ...workspace, processId: id };
const terminal = { ...workspace, terminalId: id };
const preview = { ...workspace, revisionId: id, previewId: id };
const aiSession = { ...workspace, aiSessionId: id };

const requestData: Record<string, unknown> = {
  "configuration-revision.validate": { ...project, revisionId: id2, configuration: {
    format: "devspace.project-options/v1", hash, canonicalJson: '{"aiProfile":null}'
  } },
  "configuration-revision.register": { ...project, revisionId: id2, configuration: {
    format: "devspace.project-options/v1", hash, canonicalJson: '{"aiProfile":null}'
  } },
  "configuration-runtime-plan.register": { ...project, revisionId: id2, revisionHash: hash, runtimePlan: {
    format: "devspace.runtime-plan/v1", hash, canonicalJson: '{"format":"devspace.runtime-plan/v1"}'
  } },
  "github.installation.refresh": { connectionId: id },
  "github.repositories.resolve": { connectionId: id, repositoryId: "9007199254740993" },
  "project.source.inspect": { source: { kind: "registered-local", sourceId: id } },
  "project.managed-store.create": { ...project, source: { kind: "remote", url: "https://example.com/repository.git" } },
  "project.fetch": project,
  "project.git.inspect": { ...project, workspaceId: null },
  "workspace.create": { ...workspace, projectSlug: "project", workspaceSlug: "workspace", kind: "isolated", revision: { revisionId: id, revisionHash: hash }, branchName: "feature/f09", baseRef: { kind: "branch", branchName: "main" } },
  "workspace.inspect": workspace,
  "workspace.start": workspace,
  "workspace.stop": workspace,
  "workspace.rebuild": { ...workspace, revision: { revisionId: id, revisionHash: hash } },
  "workspace.archive": { ...workspace, dirtyHandling: "preserve" },
  "workspace.remove": { ...workspace, dirtyHandling: "discard" },
  "task.start": { ...workspace, taskRunId: id, processId: id2, taskKey: "test" },
  "process.stop": process,
  "process.inspect": process,
  "terminal.create": terminal,
  "terminal.close": terminal,
  "preview.activate": { ...preview, previewKey: "app", hostname: "project-workspace-app-a1b2.example.com",
    projectSlug: "project", workspaceSlug: "workspace" },
  "preview.deactivate": preview,
  "preview.inspect": preview,
  "ai-session.start": aiSession,
  "ai-session.interrupt": aiSession,
  "ai-session.stop": aiSession,
  "ai-session.resume": { ...workspace, sourceAiSessionId: id, aiSessionId: id2 }
};

const responseData: Record<string, unknown> = {
  "agent.health.get": { status: "ok" },
  "agent.capabilities.get": { protocolVersion: 1, terminalSubprotocol: "devspace.terminal.v1" },
  "agent.runtime-status.get": { rootlessRuntime: "available", operationJournal: "available", checkedAt: timestamp },
  "configuration-revision.validate": { valid: true, revisionId: id2, configurationHash: hash },
  "github.installation.refresh": { connectionId: id, installationId: "42", accountId: "9007199254740993", accountType: "Organization",
    accountLogin: "owner", repositorySelection: "selected", permissions: { metadata: "read", contents: "read" }, status: "connected",
    verifiedAt: timestamp, cleanupDegraded: false },
  "github.repositories.resolve": { repository: { repositoryId: "9007199254740993", ownerLogin: "owner", name: "repo", fullName: "owner/repo",
    cleanHttpsUrl: "https://github.com/owner/repo.git", defaultBranch: "main", private: true, archived: false, disabled: false }, cleanupDegraded: false },
  "project.source.inspect": { sourceKind: "remote", isGitRepository: true, defaultBranch: "main", headCommit: "a".repeat(40) },
  "project.git.inspect": { ...project, workspaceId: null, branchName: "main", headCommit: "a".repeat(40), dirty: false, aheadCount: 0, behindCount: 0 },
  "workspace.inspect": { ...workspace, kind: "primary", revisionId: id, revisionHash: hash, desiredState: "running", observedState: "running", dirty: false, runtimeStack: { desiredState: "running", observedState: "running" } },
  "process.inspect": { ...process, kind: "task", desiredState: "running", observedState: "running", exitCode: null, startedAt: timestamp, finishedAt: null },
  "preview.inspect": { projectId: id, workspaceId: id2, previewId: id, previewKey: "app", desiredState: "active",
    observedState: "healthy", routePresent: true, hostname: "app.example.com" }
};

describe("Agent API v1 executable endpoint inventory", () => {
  test("has the exact accepted classification counts", () => {
    expect(agentApiV1Endpoints).toHaveLength(30);
    expect(agentApiV1Endpoints.filter((endpoint) => endpoint.classification === "mutation")).toHaveLength(20);
    expect(agentApiV1Endpoints.filter((endpoint) => endpoint.classification === "non-mutating")).toHaveLength(9);
    expect(agentApiV1Endpoints.filter((endpoint) => endpoint.classification === "websocket-upgrade")).toHaveLength(1);
  });

  test("has unique stable identities and only executable F09 routes", () => {
    const operations = agentApiV1Endpoints.map((endpoint) => endpoint.operation);
    const routes = agentApiV1Endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`);
    expect(new Set(operations).size).toBe(30);
    expect(new Set(routes).size).toBe(30);
    expect(agentApiV1Endpoints.every((endpoint) => endpoint.path.startsWith("/v1"))).toBe(true);
    expect(operations.join(" ")).not.toMatch(/reconciliation|snapshot|event/u);
    expect(Object.keys(agentApiV1EndpointByOperation)).toEqual(operations);
  });

  test("includes live refresh and exact repository resolution in the GitHub inventory", () => {
    expect(githubAgentApiV1Endpoints).toHaveLength(6);
    expect(githubAgentApiV1EndpointByOperation["github.installation.refresh"].path).toBe("/v1/github/installations/refresh");
    expect(githubAgentApiV1EndpointByOperation["github.repositories.resolve"].path).toBe("/v1/github/repositories/resolve");
  });

  test("makes every required contract and error row inspectable", () => {
    for (const endpoint of agentApiV1Endpoints) {
      expect(endpoint.pathParametersSchema).toBeDefined();
      expect(endpoint.querySchema).toBeDefined();
      expect(endpoint.requestBodySchema).toBeDefined();
      expect(endpoint.successStatus).toBeOneOf([101, 200, 202]);
      expect(endpoint.successStatus === 101
        ? endpoint.successBodySchema === null
        : endpoint.successBodySchema !== null).toBe(true);
      expect(endpoint.errors.length).toBeGreaterThanOrEqual(3);
      expect(endpoint.errorSchema).toBeDefined();
    }
  });

  test("validates a complete request and success fixture for every executable endpoint", () => {
    const commonHeaders = {
      "X-DevSpace-Protocol-Version": "1",
      "X-DevSpace-Request-Id": id,
      "X-DevSpace-Sent-At": timestamp
    };
    const meta = { protocolVersion: 1, requestId: id, respondedAt: timestamp };
    for (const endpoint of agentApiV1Endpoints) {
      expect(endpoint.headersSchema.safeParse(endpoint.journaledMutation
        ? { ...commonHeaders, "X-DevSpace-Operation-Id": id2 }
        : commonHeaders).success).toBe(true);
      expect(endpoint.pathParametersSchema.safeParse(endpoint.operation === "terminal.stream"
        ? { terminalId: id }
        : {}).success).toBe(true);
      expect(endpoint.querySchema.safeParse(undefined).success).toBe(true);
      expect(endpoint.requestBodySchema.safeParse(endpoint.method === "POST"
        ? { data: requestData[endpoint.operation] }
        : undefined).success, endpoint.operation).toBe(true);
      if (endpoint.successBodySchema !== null) {
        expect(endpoint.successBodySchema.safeParse({
          meta,
          data: endpoint.journaledMutation ? { operationId: id2 } : responseData[endpoint.operation]
        }).success, endpoint.operation).toBe(true);
      }
    }
  });

  test("requires the sole operation identity on all and only mutations", () => {
    for (const endpoint of agentApiV1Endpoints) {
      expect(endpoint.requiredDevSpaceHeaders.includes(MUTATION_OPERATION_ID_HEADER)).toBe(endpoint.journaledMutation);
      expect(endpoint.successStatus === 202).toBe(endpoint.journaledMutation);
    }
  });

  test("generates complete v1 named request, success, route-error, and F10 definitions", () => {
    const generated = generateAgentApiV1JsonSchema();
    expect(generated.description).toContain("Structural JSON Schema projection");
    expect(generated.$comment).toContain("Authoritative runtime Zod validation");
    expect(generated.$comment).toContain("semantic refinements");
    expect(generated["x-devspace-endpoint-count"]).toBe(44);
    const definitions = generated.$defs as Record<string, unknown>;
    expect(definitions["operation.workspace.create.requestBody"]).toBeDefined();
    expect(definitions["operation.workspace.create.successBody"]).toBeDefined();
    expect(definitions["operation.workspace.create.errors"]).toBeDefined();
    expect(definitions["operation.github.installation.verify.requestBody"]).toBeDefined();
    expect(definitions["operation.github.repositories.list.successBody"]).toBeDefined();
    expect(definitions["operation.terminal.stream.requestBody"]).toBeUndefined();
    expect(definitions.EventCursor).toBeDefined();
    expect(definitions.EventSequence).toBeDefined();
    expect(definitions.AgentSnapshotData).toBeDefined();
    expect(definitions.AgentSnapshotResource).toBeDefined();
    expect(definitions.AgentExecutionFailure).toBeDefined();
    expect(definitions.AgentEvent).toBeDefined();
    const eventCursor = definitions.EventCursor as Record<string, unknown>;
    expect(eventCursor.description).toContain("9007199254740991");
    expect(eventCursor.$comment).toContain("does not encode the exact maximum");
    expect(definitions["operation.snapshot.get.successBody"]).toBeDefined();
    expect(definitions["operation.event.stream.successBody"]).toBeUndefined();
    expect(Object.keys(definitions).join(" ")).not.toMatch(
      /operation\.cancelled|process\.output|process\.started|process\.exited|reconciliation/ui
    );
    expect(generated.$comment).toContain("stream continuity");
    expect(generated.$comment).toContain("snapshot atomicity");
    expect(generated.$comment).toContain("retention");
    expect(generated.$comment).toContain("parseEventCursor");
    expect(generated.$comment).toContain("validatePreviewObservationChange");
    expect(generated.$comment).toContain("standalone agentEventSchema cannot prove");
  });
});
