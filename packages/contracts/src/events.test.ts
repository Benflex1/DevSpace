import { describe, expect, test } from "vitest";
import {
  aiSessionStateChangedEventSchema,
  agentEventSchema,
  agentEventTypes,
  operationFailedEventSchema,
  operationProgressedEventSchema,
  operationSucceededEventSchema,
  previewStateChangedEventSchema,
  processObservationChangedEventSchema,
  projectInspectedEventSchema,
  runtimeStackObservedStateChangedEventSchema,
  serviceHealthChangedEventSchema,
  serviceObservedStateChangedEventSchema,
  terminalStateChangedEventSchema,
  validatePreviewObservationChange,
  type PreviewInspectionData,
  workspaceObservedStateChangedEventSchema
} from "@devspace/contracts";

const projectId = "018f1f34-7000-7000-8000-000000000001";
const workspaceId = "018f1f34-7000-7000-8000-000000000002";
const processId = "018f1f34-7000-7000-8000-000000000003";
const terminalId = "018f1f34-7000-7000-8000-000000000004";
const previewId = "018f1f34-7000-7000-8000-000000000005";
const aiSessionId = "018f1f34-7000-7000-8000-000000000006";
const operationId = "018f1f34-7000-7000-8000-000000000007";
const bootId = "018f1f34-7000-7000-8000-000000000008";
const timestamp = "2026-07-16T12:34:56.789Z";
const later = "2026-07-16T12:35:56.789Z";

const common = {
  protocolVersion: 1,
  agentBootId: bootId,
  sequence: 1,
  cursor: `v1.${bootId}.1`,
  occurredAt: timestamp
};
const projectResource = { type: "project", projectId };
const workspaceResource = { type: "workspace", projectId, workspaceId };
const stackResource = { type: "runtime-stack", projectId, workspaceId };
const serviceResource = { type: "service", projectId, workspaceId, serviceKey: "app" };
const processResource = { type: "process", projectId, workspaceId, processId };
const terminalResource = { type: "terminal", projectId, workspaceId, terminalId };
const previewResource = { type: "preview", projectId, workspaceId, previewId };
const aiResource = { type: "ai-session", projectId, workspaceId, aiSessionId };
const processObservation = {
  projectId, workspaceId, processId, kind: "task", desiredState: "running",
  observedState: "queued", exitCode: null, startedAt: null, finishedAt: null
};
const previewObservation = {
  projectId, workspaceId, previewId, previewKey: "app", desiredState: "inactive",
  observedState: "inactive", routePresent: false, hostname: null
};
const projectInspectionPayload = {
  scope: { kind: "managed-store" },
  inspection: {
    projectId, workspaceId: null, branchName: "main", headCommit: "a".repeat(40),
    dirty: false, aheadCount: 0, behindCount: 0
  }
};

const representativeEvents = [
  { ...common, operationId, resource: null, type: "operation.progressed", payload: { message: "Working" } },
  { ...common, operationId, resource: processResource, type: "operation.succeeded", payload: {} },
  {
    ...common, operationId, resource: workspaceResource, type: "operation.failed",
    payload: { error: {
      code: "AGENT_INTERNAL_ERROR", message: "redacted", retryable: true, details: { incidentId: projectId }
    } }
  },
  { ...common, operationId: null, resource: projectResource, type: "project.inspected", payload: projectInspectionPayload },
  {
    ...common, operationId: null, resource: workspaceResource,
    type: "workspace.observed-state.changed", payload: { previous: "stopped", current: "starting" }
  },
  {
    ...common, operationId, resource: stackResource,
    type: "runtime-stack.observed-state.changed", payload: { previous: "stopped", current: "starting" }
  },
  {
    ...common, operationId, resource: serviceResource,
    type: "service.observed-state.changed", payload: { previous: "stopped", current: "starting" }
  },
  {
    ...common, operationId: null, resource: serviceResource,
    type: "service.health.changed", payload: { previous: "starting", current: "healthy" }
  },
  {
    ...common, operationId: null, resource: processResource,
    type: "process.observation.changed", payload: { previous: null, current: processObservation }
  },
  {
    ...common, operationId, resource: terminalResource,
    type: "terminal.state.changed", payload: { previous: "creating", current: "active" }
  },
  {
    ...common, operationId: null, resource: previewResource,
    type: "preview.state.changed", payload: { previousState: null, observation: previewObservation }
  },
  {
    ...common, operationId, resource: aiResource,
    type: "ai-session.state.changed", payload: { previous: "creating", current: "active" }
  }
] as const;

describe("F10 exact event union", () => {
  test("contains exactly 12 accepted discriminators and representative valid events", () => {
    expect(agentEventTypes).toHaveLength(12);
    expect(representativeEvents.map((event) => event.type)).toEqual(agentEventTypes);
    for (const event of representativeEvents) {
      expect(agentEventSchema.safeParse(event).success, event.type).toBe(true);
    }
  });

  test.each([
    "operation.cancelled",
    "process.output.available",
    "process.started",
    "process.exited",
    "reconciliation.completed"
  ])("rejects removed/non-executable event %s", (type) => {
    expect(agentEventSchema.safeParse({
      ...common, operationId: null, resource: null, type, payload: {}
    }).success).toBe(false);
  });

  test("rejects event sequence zero and cursor/boot/sequence mismatch", () => {
    expect(agentEventSchema.safeParse({
      ...representativeEvents[0], sequence: 0, cursor: `v1.${bootId}.0`
    }).success).toBe(false);
    expect(agentEventSchema.safeParse({
      ...representativeEvents[0], cursor: `v1.${bootId}.2`
    }).success).toBe(false);
    expect(agentEventSchema.safeParse({
      ...representativeEvents[0], agentBootId: projectId
    }).success).toBe(false);
  });

  test("enforces operation/resource/payload associations and nested strictness", () => {
    expect(agentEventSchema.safeParse({
      ...representativeEvents[0], operationId: null
    }).success).toBe(false);
    expect(agentEventSchema.safeParse({
      ...representativeEvents[3], operationId
    }).success).toBe(false);
    expect(agentEventSchema.safeParse({
      ...representativeEvents[3], resource: workspaceResource
    }).success).toBe(false);
    expect(agentEventSchema.safeParse({
      ...representativeEvents[1], payload: { result: "extra" }
    }).success).toBe(false);
    expect(agentEventSchema.safeParse({
      ...representativeEvents[0], payload: { message: "Working", metadata: {} }
    }).success).toBe(false);
  });

  test("public per-event schemas are fully refined authorities", () => {
    const schemas = [
      operationProgressedEventSchema,
      operationSucceededEventSchema,
      operationFailedEventSchema,
      projectInspectedEventSchema,
      workspaceObservedStateChangedEventSchema,
      runtimeStackObservedStateChangedEventSchema,
      serviceObservedStateChangedEventSchema,
      serviceHealthChangedEventSchema,
      processObservationChangedEventSchema,
      terminalStateChangedEventSchema,
      previewStateChangedEventSchema,
      aiSessionStateChangedEventSchema
    ];
    for (const [index, event] of representativeEvents.entries()) {
      expect(schemas[index]!.safeParse(event).success, event.type).toBe(true);
      expect(schemas[index]!.safeParse({ ...event, cursor: `v1.${bootId}.2` }).success, event.type).toBe(false);
    }
  });

  test("public workspace schema rejects impossible edges and cursor mismatch", () => {
    const workspace = representativeEvents[4];
    expect(workspaceObservedStateChangedEventSchema.safeParse({
      ...workspace,
      payload: { previous: "running", current: "archived" }
    }).success).toBe(false);
    expect(workspaceObservedStateChangedEventSchema.safeParse({
      ...workspace,
      cursor: `v1.${bootId}.2`
    }).success).toBe(false);
    expect(agentEventSchema.safeParse({
      ...workspace,
      payload: { previous: "running", current: "archived" }
    }).success).toBe(false);
  });

  test("enforces project Git resource/scope/inspection consistency and excludes source inspection", () => {
    expect(agentEventSchema.safeParse({
      ...representativeEvents[3],
      payload: {
        scope: { kind: "workspace", workspaceId },
        inspection: { ...projectInspectionPayload.inspection, workspaceId }
      }
    }).success).toBe(true);
    expect(agentEventSchema.safeParse({
      ...representativeEvents[3],
      payload: { ...projectInspectionPayload, inspection: {
        ...projectInspectionPayload.inspection, projectId: workspaceId
      } }
    }).success).toBe(false);
    expect(agentEventSchema.safeParse({
      ...representativeEvents[3],
      payload: { scope: { kind: "source" }, inspection: projectInspectionPayload.inspection }
    }).success).toBe(false);
  });
});

describe("F10 generic lifecycle events", () => {
  test("accepts first observations and structural edges", () => {
    expect(agentEventSchema.safeParse({
      ...representativeEvents[4], payload: { previous: null, current: "removed" }
    }).success).toBe(true);
    expect(agentEventSchema.safeParse(representativeEvents[4]).success).toBe(true);
  });

  test("rejects no-op and impossible edges", () => {
    expect(agentEventSchema.safeParse({
      ...representativeEvents[4], payload: { previous: "running", current: "running" }
    }).success).toBe(false);
    expect(agentEventSchema.safeParse({
      ...representativeEvents[4], payload: { previous: "running", current: "archived" }
    }).success).toBe(false);
    expect(agentEventSchema.safeParse({
      ...representativeEvents[7], payload: { previous: "healthy", current: "starting" }
    }).success).toBe(false);
  });
});

function processEvent(previous: object | null, current: object) {
  return {
    ...common, operationId: null, resource: processResource,
    type: "process.observation.changed", payload: { previous, current }
  };
}

describe("F10 process observation event", () => {
  test("accepts first observation and structural observed-state transition", () => {
    expect(agentEventSchema.safeParse(processEvent(null, processObservation)).success).toBe(true);
    expect(agentEventSchema.safeParse(processEvent(
      processObservation,
      { ...processObservation, observedState: "starting" }
    )).success).toBe(true);
  });

  test("accepts structural desired-state transition and starting timestamp enrichment", () => {
    const starting = { ...processObservation, observedState: "starting" };
    expect(agentEventSchema.safeParse(processEvent(
      starting,
      { ...starting, desiredState: "stopped" }
    )).success).toBe(true);
    expect(agentEventSchema.safeParse(processEvent(
      starting,
      { ...starting, startedAt: timestamp }
    )).success).toBe(true);
  });

  test("accepts terminal exit-code enrichment", () => {
    const exited = {
      ...processObservation, observedState: "exited", startedAt: timestamp, finishedAt: later
    };
    expect(agentEventSchema.safeParse(processEvent(
      exited,
      { ...exited, exitCode: 0 }
    )).success).toBe(true);
  });

  test("rejects identical, identity-mismatched, immutable-value, and arbitrary changes", () => {
    expect(agentEventSchema.safeParse(processEvent(processObservation, processObservation)).success).toBe(false);
    expect(agentEventSchema.safeParse({
      ...processEvent(null, processObservation),
      resource: { ...processResource, processId: terminalId }
    }).success).toBe(false);
    const starting = { ...processObservation, observedState: "starting", startedAt: timestamp };
    expect(agentEventSchema.safeParse(processEvent(starting, { ...starting, startedAt: later })).success).toBe(false);
    const exited = {
      ...processObservation, observedState: "exited", startedAt: timestamp, finishedAt: later, exitCode: 0
    };
    expect(agentEventSchema.safeParse(processEvent(exited, { ...exited, finishedAt: timestamp })).success).toBe(false);
    expect(agentEventSchema.safeParse(processEvent(exited, { ...exited, exitCode: 1 })).success).toBe(false);
    expect(agentEventSchema.safeParse(processEvent(starting, { ...starting, kind: "terminal" })).success).toBe(false);
    expect(processObservationChangedEventSchema.safeParse(processEvent(
      starting, { ...starting, startedAt: later }
    )).success).toBe(false);
    expect(processObservationChangedEventSchema.safeParse({
      ...processEvent(starting, { ...starting, desiredState: "stopped" }),
      cursor: `v1.${bootId}.2`
    }).success).toBe(false);
  });
});

describe("F10 preview recovery event", () => {
  const healthy = {
    ...previewObservation, desiredState: "active", observedState: "healthy",
    routePresent: true, hostname: "app.example.com"
  } satisfies PreviewInspectionData;

  test("accepts first observation and structural observed-state transition", () => {
    expect(agentEventSchema.safeParse(representativeEvents[10]).success).toBe(true);
    expect(agentEventSchema.safeParse({
      ...representativeEvents[10],
      payload: { previousState: "starting", observation: healthy }
    }).success).toBe(true);
  });

  test("validates retained full-observation desired-only and route/hostname changes", () => {
    expect(validatePreviewObservationChange(
      healthy,
      "healthy",
      { ...healthy, desiredState: "inactive" }
    )).toBe(true);
    const withoutRoute = { ...healthy, routePresent: false, hostname: null };
    expect(validatePreviewObservationChange(
      withoutRoute,
      "healthy",
      healthy
    )).toBe(true);
  });

  test("rejects identity mismatch, no-op, invalid hostname/route, and impossible edge", () => {
    expect(agentEventSchema.safeParse({
      ...representativeEvents[10],
      resource: { ...previewResource, previewId: terminalId }
    }).success).toBe(false);
    expect(validatePreviewObservationChange(healthy, "healthy", healthy)).toBe(false);
    expect(agentEventSchema.safeParse({
      ...representativeEvents[10],
      payload: { previousState: "healthy", observation: { ...healthy, routePresent: false } }
    }).success).toBe(false);
    expect(agentEventSchema.safeParse({
      ...representativeEvents[10],
      payload: { previousState: "healthy", observation: {
        ...healthy, observedState: "starting"
      } }
    }).success).toBe(false);
  });
});
