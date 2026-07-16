import {
  aiSessionStates,
  terminalStates,
  workspaceServiceDesiredStates,
  workspaceServiceHealthStates,
  workspaceServiceObservedStates
} from "@devspace/domain";
import * as z from "zod";
import { eventCursorSchema, parseEventCursor } from "./cursor.js";
import { agentExecutionFailureSchema } from "./execution-failures.js";
import {
  configurationKeySchema,
  utcTimestampMsSchema,
  uuidV7Schema
} from "./primitives.js";
import {
  aiSessionIdentityDataSchema,
  gitInspectionDataSchema,
  previewInspectionDataSchema,
  processInspectionDataSchema,
  terminalIdentityDataSchema,
  workspaceInspectionDataSchema
} from "./shapes.js";

export const projectResourceReferenceSchema = z.strictObject({
  type: z.literal("project"), projectId: uuidV7Schema
});
export const workspaceResourceReferenceSchema = z.strictObject({
  type: z.literal("workspace"), projectId: uuidV7Schema, workspaceId: uuidV7Schema
});
export const runtimeStackResourceReferenceSchema = z.strictObject({
  type: z.literal("runtime-stack"), projectId: uuidV7Schema, workspaceId: uuidV7Schema
});
export const serviceResourceReferenceSchema = z.strictObject({
  type: z.literal("service"), projectId: uuidV7Schema, workspaceId: uuidV7Schema,
  serviceKey: configurationKeySchema
});
export const processResourceReferenceSchema = z.strictObject({
  type: z.literal("process"), projectId: uuidV7Schema, workspaceId: uuidV7Schema, processId: uuidV7Schema
});
export const terminalResourceReferenceSchema = z.strictObject({
  type: z.literal("terminal"), projectId: uuidV7Schema, workspaceId: uuidV7Schema, terminalId: uuidV7Schema
});
export const previewResourceReferenceSchema = z.strictObject({
  type: z.literal("preview"), projectId: uuidV7Schema, workspaceId: uuidV7Schema, previewId: uuidV7Schema
});
export const aiSessionResourceReferenceSchema = z.strictObject({
  type: z.literal("ai-session"), projectId: uuidV7Schema, workspaceId: uuidV7Schema, aiSessionId: uuidV7Schema
});
export const agentResourceReferenceSchema = z.discriminatedUnion("type", [
  projectResourceReferenceSchema,
  workspaceResourceReferenceSchema,
  runtimeStackResourceReferenceSchema,
  serviceResourceReferenceSchema,
  processResourceReferenceSchema,
  terminalResourceReferenceSchema,
  previewResourceReferenceSchema,
  aiSessionResourceReferenceSchema
]);
export type AgentResourceReference = z.infer<typeof agentResourceReferenceSchema>;

export const projectGitInspectionScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("managed-store") }),
  z.strictObject({ kind: z.literal("workspace"), workspaceId: uuidV7Schema })
]);
export const projectGitInspectionObservationSchema = z.strictObject({
  scope: projectGitInspectionScopeSchema,
  inspection: gitInspectionDataSchema
}).superRefine((data, context) => {
  const expectedWorkspaceId = data.scope.kind === "managed-store" ? null : data.scope.workspaceId;
  if (data.inspection.workspaceId !== expectedWorkspaceId) {
    context.addIssue({ code: "custom", path: ["inspection", "workspaceId"], message: "Git scope identity mismatch" });
  }
});

export const workspaceServiceDesiredStateSchema = z.enum(workspaceServiceDesiredStates);
export const workspaceServiceObservedStateSchema = z.enum(workspaceServiceObservedStates);
export const workspaceServiceHealthStateSchema = z.enum(workspaceServiceHealthStates);
export const terminalStateSchema = z.enum(terminalStates);
export const aiSessionStateSchema = z.enum(aiSessionStates);
export const workspaceServiceObservationSchema = z.strictObject({
  desiredState: workspaceServiceDesiredStateSchema,
  observedState: workspaceServiceObservedStateSchema,
  health: workspaceServiceHealthStateSchema
}).superRefine((data, context) => {
  if (data.observedState !== "running" && data.health !== "unknown") {
    context.addIssue({ code: "custom", path: ["health"], message: "Non-running services have unknown health" });
  }
});

const projectSnapshotResourceSchema = z.strictObject({
  type: z.literal("project"),
  projectId: uuidV7Schema,
  gitInspections: z.array(projectGitInspectionObservationSchema)
}).superRefine((data, context) => {
  const scopes = new Set<string>();
  for (const [index, item] of data.gitInspections.entries()) {
    if (item.inspection.projectId !== data.projectId) {
      context.addIssue({ code: "custom", path: ["gitInspections", index, "inspection", "projectId"], message: "Project identity mismatch" });
    }
    const key = item.scope.kind === "managed-store" ? "managed-store" : `workspace:${item.scope.workspaceId}`;
    if (scopes.has(key)) {
      context.addIssue({ code: "custom", path: ["gitInspections", index, "scope"], message: "Duplicate Git inspection scope" });
    }
    scopes.add(key);
  }
});
const workspaceSnapshotResourceSchema = z.strictObject({
  type: z.literal("workspace"), observation: workspaceInspectionDataSchema
});
const runtimeStackObservationSchema = workspaceInspectionDataSchema.shape.runtimeStack;
const runtimeStackSnapshotResourceSchema = z.strictObject({
  type: z.literal("runtime-stack"),
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  observation: runtimeStackObservationSchema
});
const serviceSnapshotResourceSchema = z.strictObject({
  type: z.literal("service"),
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  serviceKey: configurationKeySchema,
  observation: workspaceServiceObservationSchema
});
const processSnapshotResourceSchema = z.strictObject({
  type: z.literal("process"), observation: processInspectionDataSchema
});
const terminalSnapshotResourceSchema = z.strictObject({
  type: z.literal("terminal"), identity: terminalIdentityDataSchema, state: terminalStateSchema
});
const previewSnapshotResourceSchema = z.strictObject({
  type: z.literal("preview"), observation: previewInspectionDataSchema
});
const aiSessionSnapshotResourceSchema = z.strictObject({
  type: z.literal("ai-session"), identity: aiSessionIdentityDataSchema, state: aiSessionStateSchema
});

export const agentSnapshotResourceSchema = z.discriminatedUnion("type", [
  projectSnapshotResourceSchema,
  workspaceSnapshotResourceSchema,
  runtimeStackSnapshotResourceSchema,
  serviceSnapshotResourceSchema,
  processSnapshotResourceSchema,
  terminalSnapshotResourceSchema,
  previewSnapshotResourceSchema,
  aiSessionSnapshotResourceSchema
]);
export type AgentSnapshotResource = z.infer<typeof agentSnapshotResourceSchema>;

export const agentOperationObservationSchema = z.discriminatedUnion("state", [
  z.strictObject({
    operationId: uuidV7Schema, state: z.literal("accepted"), updatedAt: utcTimestampMsSchema, failure: z.null()
  }),
  z.strictObject({
    operationId: uuidV7Schema, state: z.literal("succeeded"), updatedAt: utcTimestampMsSchema, failure: z.null()
  }),
  z.strictObject({
    operationId: uuidV7Schema, state: z.literal("failed"), updatedAt: utcTimestampMsSchema,
    failure: agentExecutionFailureSchema
  })
]);
export type AgentOperationObservation = z.infer<typeof agentOperationObservationSchema>;

function resourceIdentity(resource: AgentSnapshotResource): string {
  switch (resource.type) {
    case "project": return resource.projectId;
    case "workspace": return resource.observation.workspaceId;
    case "runtime-stack": return resource.workspaceId;
    case "service": return `${resource.workspaceId}\u0000${resource.serviceKey}`;
    case "process": return resource.observation.processId;
    case "terminal": return resource.identity.terminalId;
    case "preview": return resource.observation.previewId;
    case "ai-session": return resource.identity.aiSessionId;
  }
}

export const agentSnapshotDataSchema = z.strictObject({
  agentBootId: uuidV7Schema,
  throughCursor: eventCursorSchema,
  resources: z.array(agentSnapshotResourceSchema),
  operationObservations: z.array(agentOperationObservationSchema)
}).superRefine((data, context) => {
  const cursor = parseEventCursor(data.throughCursor);
  if (!cursor.ok || cursor.value.agentBootId !== data.agentBootId) {
    context.addIssue({ code: "custom", path: ["throughCursor"], message: "Snapshot cursor boot mismatch" });
  }
  const identities = new Set<string>();
  for (const [index, resource] of data.resources.entries()) {
    const key = `${resource.type}\u0000${resourceIdentity(resource)}`;
    if (identities.has(key)) {
      context.addIssue({ code: "custom", path: ["resources", index], message: "Duplicate snapshot resource identity" });
    }
    identities.add(key);
  }
  const operationIds = new Set<string>();
  for (const [index, observation] of data.operationObservations.entries()) {
    if (operationIds.has(observation.operationId)) {
      context.addIssue({ code: "custom", path: ["operationObservations", index, "operationId"], message: "Duplicate operation observation" });
    }
    operationIds.add(observation.operationId);
  }
  for (const [index, resource] of data.resources.entries()) {
    if (resource.type !== "workspace") continue;
    const runtimeStacks = data.resources.filter(
      (candidate): candidate is z.infer<typeof runtimeStackSnapshotResourceSchema> =>
        candidate.type === "runtime-stack"
    );
    const counterpart = runtimeStacks.find((candidate) =>
      candidate.projectId === resource.observation.projectId
      && candidate.workspaceId === resource.observation.workspaceId);
    if (counterpart === undefined
      || counterpart.observation.desiredState !== resource.observation.runtimeStack.desiredState
      || counterpart.observation.observedState !== resource.observation.runtimeStack.observedState) {
      context.addIssue({ code: "custom", path: ["resources", index, "observation", "runtimeStack"], message: "Runtime-stack snapshot counterpart mismatch" });
    }
  }
});
export type AgentSnapshotData = z.infer<typeof agentSnapshotDataSchema>;
