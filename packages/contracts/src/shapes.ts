import {
  previewDesiredStates,
  previewObservedStates,
  processDesiredStates,
  processObservedStates,
  runtimeStackDesiredStates,
  runtimeStackObservedStates,
  workspaceDesiredStates,
  workspaceObservedStates
} from "@devspace/domain";
import * as z from "zod";
import {
  TERMINAL_SUBPROTOCOL,
  canonicalJsonObjectTextSchema,
  configurationKeySchema,
  exitCodeSchema,
  gitBaseRefSchema,
  gitBranchNameSchema,
  gitObjectIdSchema,
  nonNegativeCountSchema,
  projectOptionsRevisionHashSchema,
  remoteRepositoryUrlSchema,
  utcTimestampMsSchema,
  uuidV7Schema
} from "./primitives.js";

export const configurationDocumentSchema = z.strictObject({
  format: z.literal("devspace.project-options/v1"),
  hash: projectOptionsRevisionHashSchema,
  canonicalJson: canonicalJsonObjectTextSchema
});
export const configurationRevisionDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  revisionId: uuidV7Schema,
  configuration: configurationDocumentSchema
});
export const runtimePlanDocumentSchema = z.strictObject({
  format: z.literal("devspace.runtime-plan/v1"),
  hash: projectOptionsRevisionHashSchema,
  canonicalJson: canonicalJsonObjectTextSchema
});
export const configurationRuntimePlanDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  revisionId: uuidV7Schema,
  revisionHash: projectOptionsRevisionHashSchema,
  runtimePlan: runtimePlanDocumentSchema
});
export const revisionIdentitySchema = z.strictObject({
  revisionId: uuidV7Schema,
  revisionHash: projectOptionsRevisionHashSchema
});

export const sourceLocatorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("registered-local"), sourceId: uuidV7Schema }),
  z.strictObject({ kind: z.literal("remote"), url: remoteRepositoryUrlSchema })
]);
export const inspectSourceDataSchema = z.strictObject({ source: sourceLocatorSchema });
export const createManagedStoreDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  source: sourceLocatorSchema
});
export const projectIdentityDataSchema = z.strictObject({ projectId: uuidV7Schema });
export const inspectGitDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema.nullable()
});

export const workspaceIdentityDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema
});
export const createWorkspaceDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  kind: z.enum(["primary", "isolated"]),
  revision: revisionIdentitySchema,
  branchName: gitBranchNameSchema,
  baseRef: gitBaseRefSchema
});
export const rebuildWorkspaceDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  revision: revisionIdentitySchema
});
export const archiveWorkspaceDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  dirtyHandling: z.enum(["reject", "preserve"])
});
export const removeWorkspaceDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  dirtyHandling: z.enum(["reject", "discard"])
});

export const startTaskDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  taskRunId: uuidV7Schema,
  processId: uuidV7Schema,
  taskKey: configurationKeySchema
});
export const processIdentityDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  processId: uuidV7Schema
});
export const createTerminalDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  terminalId: uuidV7Schema
});
export const terminalIdentityDataSchema = createTerminalDataSchema;
export const activatePreviewDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  previewId: uuidV7Schema,
  previewKey: configurationKeySchema
});
export const previewIdentityDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  previewId: uuidV7Schema
});
export const startAiSessionDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  aiSessionId: uuidV7Schema
});
export const aiSessionIdentityDataSchema = startAiSessionDataSchema;
export const resumeAiSessionDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  sourceAiSessionId: uuidV7Schema,
  aiSessionId: uuidV7Schema
}).refine((data) => data.sourceAiSessionId !== data.aiSessionId, {
  path: ["aiSessionId"], message: "sourceAiSessionId and aiSessionId must differ"
});

export const healthDataSchema = z.strictObject({ status: z.enum(["ok", "degraded"]) });
export const capabilitiesDataSchema = z.strictObject({
  protocolVersion: z.literal(1), terminalSubprotocol: z.literal(TERMINAL_SUBPROTOCOL)
});
export const runtimeStatusDataSchema = z.strictObject({
  rootlessRuntime: z.enum(["available", "unavailable"]),
  operationJournal: z.enum(["available", "unavailable", "corrupt"]),
  checkedAt: utcTimestampMsSchema
});
export const configurationValidationDataSchema = z.strictObject({
  valid: z.literal(true),
  revisionId: uuidV7Schema,
  configurationHash: projectOptionsRevisionHashSchema
});

export const sourceInspectionDataSchema = z.strictObject({
  sourceKind: z.enum(["registered-local", "remote"]),
  isGitRepository: z.boolean(),
  defaultBranch: gitBranchNameSchema.nullable(),
  headCommit: gitObjectIdSchema.nullable()
}).superRefine((data, context) => {
  if (!data.isGitRepository && (data.defaultBranch !== null || data.headCommit !== null)) {
    context.addIssue({ code: "custom", message: "Non-Git sources cannot have branch or commit data" });
  }
});

export const gitInspectionDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema.nullable(),
  branchName: gitBranchNameSchema.nullable(),
  headCommit: gitObjectIdSchema.nullable(),
  dirty: z.boolean(),
  aheadCount: nonNegativeCountSchema,
  behindCount: nonNegativeCountSchema
}).superRefine((data, context) => {
  if (data.workspaceId === null && data.dirty) {
    context.addIssue({ code: "custom", path: ["dirty"], message: "Managed project stores are never dirty" });
  }
});

export const workspaceDesiredStateSchema = z.enum(workspaceDesiredStates);
export const workspaceObservedStateSchema = z.enum(workspaceObservedStates);
export const runtimeStackDesiredStateSchema = z.enum(runtimeStackDesiredStates);
export const runtimeStackObservedStateSchema = z.enum(runtimeStackObservedStates);
export const processDesiredStateSchema = z.enum(processDesiredStates);
export const processObservedStateSchema = z.enum(processObservedStates);
export const previewDesiredStateSchema = z.enum(previewDesiredStates);
export const previewObservedStateSchema = z.enum(previewObservedStates);

export const workspaceInspectionDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  kind: z.enum(["primary", "isolated"]),
  revisionId: uuidV7Schema,
  revisionHash: projectOptionsRevisionHashSchema,
  desiredState: workspaceDesiredStateSchema,
  observedState: workspaceObservedStateSchema,
  dirty: z.boolean(),
  runtimeStack: z.strictObject({
    desiredState: runtimeStackDesiredStateSchema,
    observedState: runtimeStackObservedStateSchema
  })
});

export const processInspectionDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  processId: uuidV7Schema,
  kind: z.enum(["task", "terminal", "ai-session"]),
  desiredState: processDesiredStateSchema,
  observedState: processObservedStateSchema,
  exitCode: exitCodeSchema.nullable(),
  startedAt: utcTimestampMsSchema.nullable(),
  finishedAt: utcTimestampMsSchema.nullable()
}).superRefine((data, context) => {
  const terminal = data.observedState === "exited" || data.observedState === "failed" || data.observedState === "killed";
  if (!terminal && data.exitCode !== null) {
    context.addIssue({ code: "custom", path: ["exitCode"], message: "Non-terminal processes cannot have an exit code" });
  }
  if (data.observedState === "queued" && data.startedAt !== null) {
    context.addIssue({ code: "custom", path: ["startedAt"], message: "Queued processes have not started" });
  }
  if ((data.observedState === "running" || data.observedState === "stopping") && data.startedAt === null) {
    context.addIssue({ code: "custom", path: ["startedAt"], message: "Running and stopping processes must have started" });
  }
  if (terminal ? data.finishedAt === null : data.finishedAt !== null) {
    context.addIssue({ code: "custom", path: ["finishedAt"], message: terminal
      ? "Terminal processes must have finished"
      : "Non-terminal processes cannot have finished" });
  }
});

const hostnameSchema = z.string().min(1).max(253).refine((hostname) => hostname.split(".").every(
  (label) => label.length >= 1 && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
));
export const previewInspectionDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  previewId: uuidV7Schema,
  previewKey: configurationKeySchema,
  desiredState: previewDesiredStateSchema,
  observedState: previewObservedStateSchema,
  routePresent: z.boolean(),
  hostname: hostnameSchema
}).superRefine((data, context) => {
  if (data.routePresent && ["inactive", "failed", "lost"].includes(data.observedState)) {
    context.addIssue({ code: "custom", path: ["routePresent"], message: "This preview state cannot have a route" });
  }
});

export type ConfigurationDocument = z.infer<typeof configurationDocumentSchema>;
export type ConfigurationRevisionData = z.infer<typeof configurationRevisionDataSchema>;
export type RuntimePlanDocument = z.infer<typeof runtimePlanDocumentSchema>;
export type ConfigurationRuntimePlanData = z.infer<typeof configurationRuntimePlanDataSchema>;
export type RevisionIdentity = z.infer<typeof revisionIdentitySchema>;
export type SourceLocator = z.infer<typeof sourceLocatorSchema>;
export type InspectSourceData = z.infer<typeof inspectSourceDataSchema>;
export type CreateManagedStoreData = z.infer<typeof createManagedStoreDataSchema>;
export type ProjectIdentityData = z.infer<typeof projectIdentityDataSchema>;
export type InspectGitData = z.infer<typeof inspectGitDataSchema>;
export type WorkspaceIdentityData = z.infer<typeof workspaceIdentityDataSchema>;
export type CreateWorkspaceData = z.infer<typeof createWorkspaceDataSchema>;
export type RebuildWorkspaceData = z.infer<typeof rebuildWorkspaceDataSchema>;
export type ArchiveWorkspaceData = z.infer<typeof archiveWorkspaceDataSchema>;
export type RemoveWorkspaceData = z.infer<typeof removeWorkspaceDataSchema>;
export type StartTaskData = z.infer<typeof startTaskDataSchema>;
export type ProcessIdentityData = z.infer<typeof processIdentityDataSchema>;
export type CreateTerminalData = z.infer<typeof createTerminalDataSchema>;
export type TerminalIdentityData = z.infer<typeof terminalIdentityDataSchema>;
export type ActivatePreviewData = z.infer<typeof activatePreviewDataSchema>;
export type PreviewIdentityData = z.infer<typeof previewIdentityDataSchema>;
export type StartAiSessionData = z.infer<typeof startAiSessionDataSchema>;
export type AiSessionIdentityData = z.infer<typeof aiSessionIdentityDataSchema>;
export type ResumeAiSessionData = z.infer<typeof resumeAiSessionDataSchema>;
export type HealthData = z.infer<typeof healthDataSchema>;
export type CapabilitiesData = z.infer<typeof capabilitiesDataSchema>;
export type RuntimeStatusData = z.infer<typeof runtimeStatusDataSchema>;
export type ConfigurationValidationData = z.infer<typeof configurationValidationDataSchema>;
export type SourceInspectionData = z.infer<typeof sourceInspectionDataSchema>;
export type GitInspectionData = z.infer<typeof gitInspectionDataSchema>;
export type WorkspaceInspectionData = z.infer<typeof workspaceInspectionDataSchema>;
export type ProcessInspectionData = z.infer<typeof processInspectionDataSchema>;
export type PreviewInspectionData = z.infer<typeof previewInspectionDataSchema>;
