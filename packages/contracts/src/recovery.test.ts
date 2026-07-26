import { describe, expect, test } from "vitest";
import {
  agentOperationObservationSchema,
  agentSnapshotDataSchema
} from "@devspace/contracts";

const projectId = "018f1f34-7000-7000-8000-000000000001";
const workspaceId = "018f1f34-7000-7000-8000-000000000002";
const processId = "018f1f34-7000-7000-8000-000000000003";
const terminalId = "018f1f34-7000-7000-8000-000000000004";
const previewId = "018f1f34-7000-7000-8000-000000000005";
const operationId = "018f1f34-7000-7000-8000-000000000007";
const bootId = "018f1f34-7000-7000-8000-000000000008";
const revisionId = "018f1f34-7000-7000-8000-000000000009";
const timestamp = "2026-07-16T12:34:56.789Z";
const revisionHash = `sha256-jcs-v1:${"a".repeat(64)}`;

const runtimeStack = { desiredState: "running", observedState: "running" };
const workspaceObservation = {
  projectId,
  workspaceId,
  kind: "primary",
  revisionId,
  revisionHash,
  desiredState: "running",
  observedState: "running",
  dirty: false,
  runtimeStack
};
const managedInspection = {
  projectId,
  workspaceId: null,
  branchName: "main",
  headCommit: "a".repeat(40),
  dirty: false,
  aheadCount: 0,
  behindCount: 0
};
const workspaceInspection = {
  ...managedInspection,
  workspaceId,
  branchName: "feature/f10",
  dirty: true
};
const processObservation = {
  projectId, workspaceId, processId, kind: "task", desiredState: "running",
  observedState: "running", exitCode: null, startedAt: timestamp, finishedAt: null
};

function fullSnapshot() {
  return {
    agentBootId: bootId,
    throughCursor: `v1.${bootId}.0`,
    resources: [
      {
        type: "project",
        projectId,
        gitInspections: [
          { scope: { kind: "managed-store" }, inspection: managedInspection },
          { scope: { kind: "workspace", workspaceId }, inspection: workspaceInspection }
        ]
      },
      { type: "workspace", observation: workspaceObservation },
      { type: "runtime-stack", projectId, workspaceId, observation: runtimeStack },
      {
        type: "service", projectId, workspaceId, serviceKey: "app",
        observation: { desiredState: "running", observedState: "running", health: "healthy" }
      },
      {
        type: "process",
        observation: processObservation
      },
      { type: "terminal", identity: { projectId, workspaceId, terminalId }, state: "active" },
      {
        type: "preview",
        observation: {
          projectId, workspaceId, previewId, previewKey: "app", desiredState: "active",
          observedState: "healthy", routePresent: true, hostname: "app.example.com"
        }
      }
    ],
    operationObservations: [
      { operationId, state: "accepted", updatedAt: timestamp, failure: null }
    ]
  };
}

describe("F10 Agent snapshot contract", () => {
  test("accepts a complete seven-resource snapshot with multiple project Git scopes", () => {
    expect(agentSnapshotDataSchema.safeParse(fullSnapshot()).success).toBe(true);
  });

  test("accepts empty resources and operation observations at cursor zero", () => {
    expect(agentSnapshotDataSchema.safeParse({
      agentBootId: bootId,
      throughCursor: `v1.${bootId}.0`,
      resources: [],
      operationObservations: []
    }).success).toBe(true);
  });

  test("rejects snapshot cursor boot mismatch", () => {
    const snapshot = fullSnapshot();
    snapshot.throughCursor = `v1.${projectId}.0`;
    expect(agentSnapshotDataSchema.safeParse(snapshot).success).toBe(false);
  });

  test.each([
    ["project", (snapshot: ReturnType<typeof fullSnapshot>) => snapshot.resources.push(snapshot.resources[0]!)],
    ["workspace", (snapshot: ReturnType<typeof fullSnapshot>) => snapshot.resources.push(snapshot.resources[1]!)],
    ["runtime-stack", (snapshot: ReturnType<typeof fullSnapshot>) => snapshot.resources.push(snapshot.resources[2]!)],
    ["service", (snapshot: ReturnType<typeof fullSnapshot>) => snapshot.resources.push(snapshot.resources[3]!)],
    ["process", (snapshot: ReturnType<typeof fullSnapshot>) => snapshot.resources.push(snapshot.resources[4]!)],
    ["terminal", (snapshot: ReturnType<typeof fullSnapshot>) => snapshot.resources.push(snapshot.resources[5]!)],
    ["preview", (snapshot: ReturnType<typeof fullSnapshot>) => snapshot.resources.push(snapshot.resources[6]!)]
  ] as const)("rejects duplicate %s identity", (_type, mutate) => {
    const snapshot = fullSnapshot();
    mutate(snapshot);
    expect(agentSnapshotDataSchema.safeParse(snapshot).success).toBe(false);
  });

  test("rejects duplicate operation IDs", () => {
    const snapshot = fullSnapshot();
    snapshot.operationObservations.push({ ...snapshot.operationObservations[0]! });
    expect(agentSnapshotDataSchema.safeParse(snapshot).success).toBe(false);
  });

  test("rejects duplicate managed-store and workspace Git scopes", () => {
    for (const duplicateIndex of [0, 1]) {
      const snapshot = fullSnapshot();
      const project = snapshot.resources[0] as (typeof snapshot.resources)[0] & {
        gitInspections: unknown[];
      };
      project.gitInspections.push(project.gitInspections[duplicateIndex]!);
      expect(agentSnapshotDataSchema.safeParse(snapshot).success).toBe(false);
    }
  });

  test("rejects scope/inspection and project identity inconsistency", () => {
    const workspaceMismatch = fullSnapshot();
    workspaceMismatch.resources[0] = {
      type: "project", projectId, gitInspections: [{
        scope: { kind: "workspace", workspaceId },
        inspection: { ...workspaceInspection, workspaceId: processId }
      }]
    };
    expect(agentSnapshotDataSchema.safeParse(workspaceMismatch).success).toBe(false);
    const projectMismatch = fullSnapshot();
    projectMismatch.resources[0] = {
      type: "project", projectId, gitInspections: [{
        scope: { kind: "workspace", workspaceId },
        inspection: { ...workspaceInspection, projectId: processId }
      }]
    };
    expect(agentSnapshotDataSchema.safeParse(projectMismatch).success).toBe(false);
  });

  test("rejects missing or divergent runtime-stack counterparts", () => {
    const missing = fullSnapshot();
    missing.resources.splice(2, 1);
    expect(agentSnapshotDataSchema.safeParse(missing).success).toBe(false);
    const divergent = fullSnapshot();
    divergent.resources[2] = {
      type: "runtime-stack", projectId, workspaceId,
      observation: { ...runtimeStack, observedState: "degraded" }
    };
    expect(agentSnapshotDataSchema.safeParse(divergent).success).toBe(false);
  });

  test("rejects nested unknown properties", () => {
    const snapshot = fullSnapshot();
    const invalid = {
      ...snapshot,
      resources: [
        ...snapshot.resources.slice(0, 4),
        { type: "process", observation: { ...processObservation, output: "forbidden" } },
        ...snapshot.resources.slice(5)
      ]
    };
    expect(agentSnapshotDataSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("F10 Agent operation observations", () => {
  test.each([
    { operationId, state: "accepted", updatedAt: timestamp, failure: null },
    { operationId, state: "running", updatedAt: timestamp, failure: null },
    { operationId, state: "succeeded", updatedAt: timestamp, failure: null },
    {
      operationId, state: "failed", updatedAt: timestamp,
      failure: {
        code: "AGENT_INTERNAL_ERROR", message: "redacted", retryable: true,
        details: { incidentId: revisionId }
      }
    }
  ])("accepts $state", (observation) => {
    expect(agentOperationObservationSchema.safeParse(observation).success).toBe(true);
  });

  test("rejects failure/state mismatch", () => {
    expect(agentOperationObservationSchema.safeParse({
      operationId, state: "accepted", updatedAt: timestamp,
      failure: { code: "SOURCE_UNAVAILABLE", message: "redacted", retryable: true, details: {} }
    }).success).toBe(false);
    expect(agentOperationObservationSchema.safeParse({
      operationId, state: "failed", updatedAt: timestamp, failure: null
    }).success).toBe(false);
  });
});
