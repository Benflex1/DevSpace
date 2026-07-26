import {
  isPreviewDesiredStructuralEdge,
  isPreviewObservedStructuralEdge,
  isProcessDesiredStructuralEdge,
  isProcessObservedStructuralEdge,
  isRuntimeStackObservedStructuralEdge,
  isTerminalStructuralEdge,
  isWorkspaceObservedStructuralEdge,
  isWorkspaceServiceHealthStructuralEdge,
  isWorkspaceServiceObservedStructuralEdge
} from "@devspace/domain";
import * as z from "zod";
import { eventCursorSchema, eventSequenceSchema, parseEventCursor } from "./cursor.js";
import { agentExecutionFailureSchema } from "./execution-failures.js";
import {
  AGENT_API_VERSION,
  errorMessageSchema,
  utcTimestampMsSchema,
  uuidV7Schema
} from "./primitives.js";
import {
  agentResourceReferenceSchema,
  f10ProcessInspectionDataSchema,
  previewResourceReferenceSchema,
  processResourceReferenceSchema,
  projectGitInspectionObservationSchema,
  projectResourceReferenceSchema,
  runtimeStackResourceReferenceSchema,
  serviceResourceReferenceSchema,
  terminalResourceReferenceSchema,
  terminalStateSchema,
  workspaceResourceReferenceSchema,
  workspaceServiceHealthStateSchema,
  workspaceServiceObservedStateSchema,
  type F10ProcessInspectionData
} from "./recovery.js";
import {
  previewInspectionDataSchema,
  previewObservedStateSchema,
  runtimeStackObservedStateSchema,
  workspaceObservedStateSchema,
  type PreviewInspectionData
} from "./shapes.js";

export const AGENT_EVENT_NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8" as const;
export const agentEventNdjsonWireRules = Object.freeze({
  json: "ordinary",
  oneCompleteStrictEventPerLine: true,
  encoding: "utf-8",
  delimiterByte: 0x0a,
  committedEventRequiresDelimiter: true,
  blankLinesAllowed: false,
  crlfAllowed: false,
  rawCarriageReturnInsideLineAllowed: false,
  rawLineFeedInsideLineAllowed: false,
  logicalNewlinesUseJsonEscapes: true,
  propertyOrderSignificant: false,
  singleLineWhitespaceAllowed: true,
  unterminatedFinalJsonCommitted: false
} as const);
export const agentProgressMessageSchema = errorMessageSchema.transform((value) => value);
export type AgentProgressMessage = z.infer<typeof agentProgressMessageSchema>;

const common = {
  protocolVersion: z.literal(AGENT_API_VERSION),
  agentBootId: uuidV7Schema,
  sequence: eventSequenceSchema,
  cursor: eventCursorSchema,
  occurredAt: utcTimestampMsSchema
};
const nullableOperationId = uuidV7Schema.nullable();
const lifecyclePayload = <Schema extends z.ZodType>(state: Schema) => z.strictObject({
  previous: state.nullable(), current: state
});

const rawOperationProgressedEventSchema = z.strictObject({
  ...common,
  operationId: uuidV7Schema,
  resource: agentResourceReferenceSchema.nullable(),
  type: z.literal("operation.progressed"),
  payload: z.strictObject({ message: agentProgressMessageSchema })
});
const rawOperationSucceededEventSchema = z.strictObject({
  ...common,
  operationId: uuidV7Schema,
  resource: agentResourceReferenceSchema.nullable(),
  type: z.literal("operation.succeeded"),
  payload: z.strictObject({})
});
const rawOperationFailedEventSchema = z.strictObject({
  ...common,
  operationId: uuidV7Schema,
  resource: agentResourceReferenceSchema.nullable(),
  type: z.literal("operation.failed"),
  payload: z.strictObject({ error: agentExecutionFailureSchema })
});
const rawProjectInspectedEventSchema = z.strictObject({
  ...common,
  operationId: z.null(),
  resource: projectResourceReferenceSchema,
  type: z.literal("project.inspected"),
  payload: projectGitInspectionObservationSchema
});
const rawWorkspaceObservedStateChangedEventSchema = z.strictObject({
  ...common,
  operationId: nullableOperationId,
  resource: workspaceResourceReferenceSchema,
  type: z.literal("workspace.observed-state.changed"),
  payload: lifecyclePayload(workspaceObservedStateSchema)
});
const rawRuntimeStackObservedStateChangedEventSchema = z.strictObject({
  ...common,
  operationId: nullableOperationId,
  resource: runtimeStackResourceReferenceSchema,
  type: z.literal("runtime-stack.observed-state.changed"),
  payload: lifecyclePayload(runtimeStackObservedStateSchema)
});
const rawServiceObservedStateChangedEventSchema = z.strictObject({
  ...common,
  operationId: nullableOperationId,
  resource: serviceResourceReferenceSchema,
  type: z.literal("service.observed-state.changed"),
  payload: lifecyclePayload(workspaceServiceObservedStateSchema)
});
const rawServiceHealthChangedEventSchema = z.strictObject({
  ...common,
  operationId: nullableOperationId,
  resource: serviceResourceReferenceSchema,
  type: z.literal("service.health.changed"),
  payload: lifecyclePayload(workspaceServiceHealthStateSchema)
});
const rawProcessObservationChangedEventSchema = z.strictObject({
  ...common,
  operationId: nullableOperationId,
  resource: processResourceReferenceSchema,
  type: z.literal("process.observation.changed"),
  payload: z.strictObject({
    previous: f10ProcessInspectionDataSchema.nullable(),
    current: f10ProcessInspectionDataSchema
  })
});
const rawTerminalStateChangedEventSchema = z.strictObject({
  ...common,
  operationId: nullableOperationId,
  resource: terminalResourceReferenceSchema,
  type: z.literal("terminal.state.changed"),
  payload: lifecyclePayload(terminalStateSchema)
});
const rawPreviewStateChangedEventSchema = z.strictObject({
  ...common,
  operationId: nullableOperationId,
  resource: previewResourceReferenceSchema,
  type: z.literal("preview.state.changed"),
  payload: z.strictObject({
    previousState: previewObservedStateSchema.nullable(),
    observation: previewInspectionDataSchema
  })
});
export const agentEventTypes = [
  "operation.progressed",
  "operation.succeeded",
  "operation.failed",
  "project.inspected",
  "workspace.observed-state.changed",
  "runtime-stack.observed-state.changed",
  "service.observed-state.changed",
  "service.health.changed",
  "process.observation.changed",
  "terminal.state.changed",
  "preview.state.changed"
] as const;

function equalJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equalJson(value, right[index]));
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    return keys.length === Object.keys(rightRecord).length
      && keys.every((key) => Object.hasOwn(rightRecord, key) && equalJson(leftRecord[key], rightRecord[key]));
  }
  return false;
}

function addEdgeIssue(context: z.core.$RefinementCtx<unknown>, path: PropertyKey[]): void {
  context.addIssue({ code: "custom", path, message: "State pair is not a structural lifecycle edge" });
}

function validateProcessChange(
  previous: F10ProcessInspectionData | null,
  current: F10ProcessInspectionData,
  context: z.core.$RefinementCtx<unknown>
): void {
  if (previous === null) return;
  if (equalJson(previous, current)) {
    context.addIssue({ code: "custom", path: ["payload"], message: "Process observations must differ" });
    return;
  }
  for (const key of ["projectId", "workspaceId", "processId", "kind"] as const) {
    if (previous[key] !== current[key]) {
      context.addIssue({ code: "custom", path: ["payload", "current", key], message: "Process identity is immutable" });
    }
  }
  for (const key of ["startedAt", "finishedAt", "exitCode"] as const) {
    if (previous[key] !== null && previous[key] !== current[key]) {
      context.addIssue({ code: "custom", path: ["payload", "current", key], message: "Existing process observation values are immutable" });
    }
  }
  const stateChanged = previous.observedState !== current.observedState;
  const desiredChanged = previous.desiredState !== current.desiredState;
  if (stateChanged && !isProcessObservedStructuralEdge(previous.observedState, current.observedState)) {
    addEdgeIssue(context, ["payload", "current", "observedState"]);
  }
  if (desiredChanged && !isProcessDesiredStructuralEdge(previous.desiredState, current.desiredState)) {
    addEdgeIssue(context, ["payload", "current", "desiredState"]);
  }
  if (!stateChanged) {
    if (previous.finishedAt !== current.finishedAt) {
      context.addIssue({ code: "custom", path: ["payload", "current", "finishedAt"], message: "Same-state process events cannot change finishedAt" });
    }
    const allowed = new Set(["desiredState", "startedAt", "exitCode"]);
    const changed = Object.keys(previous).filter((key) =>
      !equalJson(
        previous[key as keyof F10ProcessInspectionData],
        current[key as keyof F10ProcessInspectionData]
      )
    );
    if (changed.some((key) => !allowed.has(key))) {
      context.addIssue({ code: "custom", path: ["payload"], message: "Arbitrary same-state process mutation" });
    }
  }
  if (previous.finishedAt === null && current.finishedAt !== null && !stateChanged) {
    context.addIssue({ code: "custom", path: ["payload", "current", "finishedAt"], message: "finishedAt enrichment requires a terminal state transition" });
  }
  if (previous.exitCode === null && current.exitCode !== null
    && !["exited", "failed", "killed"].includes(current.observedState)) {
    context.addIssue({ code: "custom", path: ["payload", "current", "exitCode"], message: "exitCode enrichment requires a terminal observation" });
  }
}

export function validatePreviewObservationChange(
  previous: PreviewInspectionData | null,
  previousState: PreviewInspectionData["observedState"] | null,
  current: PreviewInspectionData
): boolean {
  if (previous === null) return previousState === null;
  if (previousState !== previous.observedState || equalJson(previous, current)) return false;
  for (const key of ["projectId", "workspaceId", "previewId", "previewKey"] as const) {
    if (previous[key] !== current[key]) return false;
  }
  if (previous.observedState !== current.observedState
    && !isPreviewObservedStructuralEdge(previous.observedState, current.observedState)) return false;
  const changed = Object.keys(previous).filter((key) =>
    !equalJson(previous[key as keyof PreviewInspectionData], current[key as keyof PreviewInspectionData])
  );
  const allowed = new Set(["observedState", "desiredState", "routePresent", "hostname"]);
  if (changed.some((key) => !allowed.has(key))) return false;
  if (previous.desiredState !== current.desiredState
    && !isPreviewDesiredStructuralEdge(previous.desiredState, current.desiredState)) return false;
  return previous.observedState !== current.observedState
    || previous.desiredState !== current.desiredState
    || previous.routePresent !== current.routePresent
    || previous.hostname !== current.hostname;
}

const rawAgentEventSchema = z.discriminatedUnion("type", [
  rawOperationProgressedEventSchema,
  rawOperationSucceededEventSchema,
  rawOperationFailedEventSchema,
  rawProjectInspectedEventSchema,
  rawWorkspaceObservedStateChangedEventSchema,
  rawRuntimeStackObservedStateChangedEventSchema,
  rawServiceObservedStateChangedEventSchema,
  rawServiceHealthChangedEventSchema,
  rawProcessObservationChangedEventSchema,
  rawTerminalStateChangedEventSchema,
  rawPreviewStateChangedEventSchema
]);
type RawAgentEvent = z.infer<typeof rawAgentEventSchema>;

function validateEventObject(event: RawAgentEvent, context: z.core.$RefinementCtx<unknown>): void {
  const cursor = parseEventCursor(event.cursor);
  if (!cursor.ok || cursor.value.agentBootId !== event.agentBootId || cursor.value.sequence !== event.sequence) {
    context.addIssue({ code: "custom", path: ["cursor"], message: "Event cursor must equal boot and sequence" });
  }
  switch (event.type) {
    case "project.inspected":
      if (event.payload.inspection.projectId !== event.resource.projectId) {
        context.addIssue({ code: "custom", path: ["payload", "inspection", "projectId"], message: "Project identity mismatch" });
      }
      break;
    case "workspace.observed-state.changed":
      if (event.payload.previous !== null
        && !isWorkspaceObservedStructuralEdge(event.payload.previous, event.payload.current)) {
        addEdgeIssue(context, ["payload"]);
      }
      break;
    case "runtime-stack.observed-state.changed":
      if (event.payload.previous !== null
        && !isRuntimeStackObservedStructuralEdge(event.payload.previous, event.payload.current)) {
        addEdgeIssue(context, ["payload"]);
      }
      break;
    case "service.observed-state.changed":
      if (event.payload.previous !== null
        && !isWorkspaceServiceObservedStructuralEdge(event.payload.previous, event.payload.current)) {
        addEdgeIssue(context, ["payload"]);
      }
      break;
    case "service.health.changed":
      if (event.payload.previous !== null
        && !isWorkspaceServiceHealthStructuralEdge(event.payload.previous, event.payload.current)) {
        addEdgeIssue(context, ["payload"]);
      }
      break;
    case "terminal.state.changed":
      if (event.payload.previous !== null
        && !isTerminalStructuralEdge(event.payload.previous, event.payload.current)) {
        addEdgeIssue(context, ["payload"]);
      }
      break;
    case "process.observation.changed":
      if (event.resource.projectId !== event.payload.current.projectId
        || event.resource.workspaceId !== event.payload.current.workspaceId
        || event.resource.processId !== event.payload.current.processId) {
        context.addIssue({ code: "custom", path: ["resource"], message: "Process resource identity mismatch" });
      }
      validateProcessChange(event.payload.previous, event.payload.current, context);
      break;
    case "preview.state.changed":
      if (event.resource.projectId !== event.payload.observation.projectId
        || event.resource.workspaceId !== event.payload.observation.workspaceId
        || event.resource.previewId !== event.payload.observation.previewId) {
        context.addIssue({ code: "custom", path: ["resource"], message: "Preview resource identity mismatch" });
      }
      if (event.payload.previousState !== null
        && event.payload.previousState !== event.payload.observation.observedState
        && !isPreviewObservedStructuralEdge(
          event.payload.previousState,
          event.payload.observation.observedState
        )) {
        addEdgeIssue(context, ["payload", "observation", "observedState"]);
      }
      break;
  }
}

function refinedEventSchema<Schema extends z.ZodType>(schema: Schema): Schema {
  return schema.superRefine((event, context) => {
    validateEventObject(event as RawAgentEvent, context);
  });
}

export const operationProgressedEventSchema = refinedEventSchema(rawOperationProgressedEventSchema);
export const operationSucceededEventSchema = refinedEventSchema(rawOperationSucceededEventSchema);
export const operationFailedEventSchema = refinedEventSchema(rawOperationFailedEventSchema);
export const projectInspectedEventSchema = refinedEventSchema(rawProjectInspectedEventSchema);
export const workspaceObservedStateChangedEventSchema = refinedEventSchema(rawWorkspaceObservedStateChangedEventSchema);
export const runtimeStackObservedStateChangedEventSchema = refinedEventSchema(rawRuntimeStackObservedStateChangedEventSchema);
export const serviceObservedStateChangedEventSchema = refinedEventSchema(rawServiceObservedStateChangedEventSchema);
export const serviceHealthChangedEventSchema = refinedEventSchema(rawServiceHealthChangedEventSchema);
export const processObservationChangedEventSchema = refinedEventSchema(rawProcessObservationChangedEventSchema);
export const terminalStateChangedEventSchema = refinedEventSchema(rawTerminalStateChangedEventSchema);
export const previewStateChangedEventSchema = refinedEventSchema(rawPreviewStateChangedEventSchema);

export const agentEventSchema = rawAgentEventSchema.superRefine(validateEventObject);
export type AgentEvent = z.infer<typeof agentEventSchema>;
