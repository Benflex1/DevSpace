import {
  canonicalizeProjectOptionsV1,
  canonicalizeRuntimePlanV1,
  compileRuntimePlanV1,
  hashProjectOptionsV1,
  hashRuntimePlanV1,
  parseProjectOptionsV1
} from "@devspace/project-options";
import { gitBranchNameSchema } from "@devspace/contracts";
import {
  composePreviewHostname,
  validateDnsLabel,
  validatePreviewHostnamePattern,
  type ApprovedPreviewBaseRegistry
} from "@devspace/security";
import type { WorkspaceAgentClient } from "./agent-client.js";
import type { ManagedProjectView, ProjectDatabase } from "./database.js";
import { persistedFailureMessage } from "./failure-policy.js";
import { SafeWebFailure, type SafeFailureMetadata } from "./user-facing-failure.js";

export class WorkspaceSetupValidationError extends Error {
  constructor(message: string) { super(message); this.name = "WorkspaceSetupValidationError"; }
}
export class WorkspaceSetupExecutionError extends SafeWebFailure {
  constructor(code: string, message: string, metadata: SafeFailureMetadata = {}) {
    super(code, message, metadata);
    this.name = "WorkspaceSetupExecutionError";
  }
}

export interface WorkspaceSetupInput {
  readonly imageReference: string;
  readonly tasks?: readonly { readonly key: string; readonly displayName: string; readonly executable: string; readonly args: readonly string[] }[];
  readonly preview?: { readonly key: string; readonly displayName: string; readonly containerPort: number; readonly domainBaseId: string };
}
export type WorkspaceSetupAgent = Pick<WorkspaceAgentClient,
  "health" | "inspectSource" | "registerRevision" | "registerRuntimePlan" | "createManagedStore" | "fetchProject" |
  "createWorkspace" | "snapshot" | "inspectGit" | "inspectWorkspace">;

export function parseWorkspaceSetupInput(value: unknown): WorkspaceSetupInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceSetupValidationError("Enter development environment details.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["imageReference", "tasks", "preview"].includes(key))) {
    throw new WorkspaceSetupValidationError("The request contains unknown fields.");
  }
  const imageReference = typeof record.imageReference === "string" ? record.imageReference.trim() : "";
  const hasControlCharacter = [...imageReference].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (imageReference.length < 1 || imageReference.length > 512 || hasControlCharacter) {
    throw new WorkspaceSetupValidationError("Enter a valid development container image reference.");
  }
  const taskValues = record.tasks === undefined ? [] : record.tasks;
  if (!Array.isArray(taskValues) || taskValues.length > 10) throw new WorkspaceSetupValidationError("Enter valid task definitions.");
  const tasks = taskValues.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceSetupValidationError("Enter valid task definitions.");
    const task = value as Record<string, unknown>;
    if (Object.keys(task).some((key) => !["key", "displayName", "executable", "args"].includes(key))
      || typeof task.key !== "string" || !/^[a-z][a-z0-9-]*$/u.test(task.key)
      || typeof task.displayName !== "string" || task.displayName.trim().length < 1 || task.displayName.length > 120
      || typeof task.executable !== "string" || task.executable.trim().length < 1 || task.executable.length > 512
      || !Array.isArray(task.args) || task.args.length > 100 || task.args.some((argument) => typeof argument !== "string" || argument.length > 2_048)) {
      throw new WorkspaceSetupValidationError("Each task needs a valid key, display name, executable, and ordered arguments.");
    }
    return { key: task.key, displayName: task.displayName.trim(), executable: task.executable.trim(), args: task.args as string[] };
  });
  if (new Set(tasks.map((task) => task.key)).size !== tasks.length) throw new WorkspaceSetupValidationError("Task keys must be unique.");
  if (record.preview === undefined) return { imageReference, tasks };
  if (record.preview === null || typeof record.preview !== "object" || Array.isArray(record.preview)) {
    throw new WorkspaceSetupValidationError("Enter valid preview details.");
  }
  const preview = record.preview as Record<string, unknown>;
  const containerPort = preview.containerPort;
  if (Object.keys(preview).some((key) => !["key", "displayName", "containerPort", "domainBaseId"].includes(key))
    || typeof preview.key !== "string" || !/^[a-z][a-z0-9-]*$/u.test(preview.key)
    || typeof preview.displayName !== "string" || preview.displayName.trim().length < 1 || preview.displayName.length > 120
    || typeof containerPort !== "number" || !Number.isSafeInteger(containerPort) || containerPort < 1 || containerPort > 65535
    || typeof preview.domainBaseId !== "string" || !/^[a-z][a-z0-9-]*$/u.test(preview.domainBaseId)) {
    throw new WorkspaceSetupValidationError("Enter a valid workspace preview key, display name, container port, and approved preview base.");
  }
  return { imageReference, tasks, preview: {
    key: preview.key, displayName: preview.displayName.trim(), containerPort, domainBaseId: preview.domainBaseId
  } };
}

const initialPreviewHostnamePattern = "{project}-{shortId}";

function assertApprovedPreviewBase(input: WorkspaceSetupInput, projectSlug: string, registry: ApprovedPreviewBaseRegistry | undefined): void {
  if (input.preview === undefined) return;
  if (registry === undefined) throw new WorkspaceSetupValidationError("Previews are unavailable because no approved preview base registry is configured.");
  const pattern = validatePreviewHostnamePattern(initialPreviewHostnamePattern);
  const project = validateDnsLabel(projectSlug, "projectSlug");
  const workspace = validateDnsLabel("primary", "workspaceSlug");
  const preview = validateDnsLabel(input.preview.key, "previewKey");
  // Preview IDs are UUIDv7 values; only their fixed eight-character prefix affects this check.
  const shortId = validateDnsLabel("00000000", "previewShortId");
  if (!pattern.ok || !project.ok || !workspace.ok || !preview.ok || !shortId.ok) {
    throw new WorkspaceSetupValidationError("The default preview hostname pattern is invalid.");
  }
  const composed = composePreviewHostname(pattern.value, {
    project: project.value, shortId: shortId.value
  }, input.preview.domainBaseId, registry);
  if (!composed.ok) {
    if (composed.error.code === "PREVIEW_BASE_UNKNOWN") throw new WorkspaceSetupValidationError("Select an approved preview base.");
    throw new WorkspaceSetupValidationError(`The preview hostname cannot be composed safely: ${composed.error.code}.`);
  }
}

function initialProjectOptions(input: WorkspaceSetupInput) {
  return parseProjectOptionsV1({
    schemaVersion: 1,
    developmentEnvironment: {
      source: { kind: "image", imageReference: input.imageReference },
      ...(input.preview === undefined ? {} : { ports: [{ name: input.preview.key, containerPort: input.preview.containerPort }] })
    },
    previews: input.preview === undefined ? [] : [{
      key: input.preview.key, displayName: input.preview.displayName, target: { kind: "workspace" },
      containerPort: input.preview.containerPort, domainBaseId: input.preview.domainBaseId,
      hostnamePattern: initialPreviewHostnamePattern
    }],
    tasks: (input.tasks ?? []).map((task) => ({ key: task.key, displayName: task.displayName,
      command: { executable: task.executable, args: task.args, workingDirectory: ".", environment: {} },
      interactive: false, longRunning: false, timeoutSeconds: null, concurrencyPolicy: "reject", successExitCodes: [0], logRetentionDays: null }))
  });
}

async function completeMutation(
  database: ProjectDatabase,
  agent: Pick<WorkspaceAgentClient, "snapshot">,
  operation: ReturnType<ProjectDatabase["getOrCreateOperation"]>,
  execute: () => Promise<void>,
  polling: { deadline: number; now: () => number; sleep: (milliseconds: number) => Promise<void> }
): Promise<void> {
  if (operation.state === "succeeded") return;
  if (operation.state === "failed") {
    const code = operation.errorCode ?? "SETUP_FAILED";
    throw new WorkspaceSetupExecutionError(code, persistedFailureMessage(code), { messageOwnership: "agent-code" });
  }
  await execute();
  let delayMs = 25;
  while (polling.now() < polling.deadline) {
    const observation = (await agent.snapshot()).operationObservations.find((item) => item.operationId === operation.operationId);
    if (observation?.state === "failed") {
      database.finishOperation(operation.operationId, {
        state: "failed", code: observation.failure.code, message: persistedFailureMessage(observation.failure.code)
      });
      const details = observation.failure.details;
      const incidentId = "incidentId" in details ? details.incidentId : undefined;
      throw new WorkspaceSetupExecutionError(observation.failure.code, persistedFailureMessage(observation.failure.code), {
        retryable: observation.failure.retryable,
        operationId: operation.operationId,
        messageOwnership: "agent-code",
        ...(incidentId === undefined ? {} : { incidentId })
      });
    }
    if (observation?.state === "succeeded") {
      database.finishOperation(operation.operationId, { state: "succeeded" });
      return;
    }
    const remaining = polling.deadline - polling.now();
    if (remaining <= 0) break;
    await polling.sleep(Math.min(delayMs, remaining));
    delayMs = Math.min(Math.ceil(delayMs * 1.7), 1_000);
  }
  throw new WorkspaceSetupExecutionError("SETUP_IN_PROGRESS", "Workspace setup is still running safely. Retry to continue observing the same setup.");
}

export async function setupPrimaryWorkspace(input: WorkspaceSetupInput, projectId: string, actor: string, dependencies: {
  readonly database: ProjectDatabase; readonly agent: WorkspaceSetupAgent;
  readonly previewBaseRegistry?: ApprovedPreviewBaseRegistry;
  readonly orchestrationTimeoutMs?: number; readonly nowMonotonic?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): Promise<{
  readonly project: ManagedProjectView;
  readonly git: Awaited<ReturnType<WorkspaceAgentClient["inspectGit"]>>;
  readonly workspace: Awaited<ReturnType<WorkspaceAgentClient["inspectWorkspace"]>>;
}> {
  const registeredProject = dependencies.database.getManagedProject(projectId);
  if (registeredProject === undefined) throw new WorkspaceSetupValidationError("The project no longer exists.");
  assertApprovedPreviewBase(input, registeredProject.slug, dependencies.previewBaseRegistry);
  await dependencies.agent.health();
  const options = initialProjectOptions(input);
  const configurationJson = canonicalizeProjectOptionsV1(options);
  const configurationHash = hashProjectOptionsV1(options);
  const runtimePlan = compileRuntimePlanV1(options);
  const compiledRuntimePlanJson = canonicalizeRuntimePlanV1(runtimePlan);
  const runtimePlanHash = hashRuntimePlanV1(runtimePlan);
  const setup = dependencies.database.preparePrimaryWorkspace({ projectId, configurationJson, configurationHash,
    compiledRuntimePlanJson, runtimePlanHash, actor });
  const nowMonotonic = dependencies.nowMonotonic ?? (() => Date.now());
  const polling = {
    deadline: nowMonotonic() + (dependencies.orchestrationTimeoutMs ?? 120_000), now: nowMonotonic,
    sleep: dependencies.sleep ?? (async (milliseconds: number) => await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  };

  if (setup.project.state !== "ready") {
    const revisionData = {
      projectId, revisionId: setup.revision.id,
      configuration: { format: "devspace.project-options/v1" as const, hash: configurationHash, canonicalJson: configurationJson }
    };
    const register = dependencies.database.getOrCreateOperation({
      projectId, actor, operationName: "configuration-revision.register", resourceType: "configuration-revision", resourceId: setup.revision.id
    });
    await completeMutation(dependencies.database, dependencies.agent, register, async () => {
      await dependencies.agent.registerRevision(register.operationId, revisionData);
    }, polling);

    const registerRuntimePlan = dependencies.database.getOrCreateOperation({
      projectId, actor, operationName: "configuration-runtime-plan.register", resourceType: "configuration-revision", resourceId: setup.revision.id
    });
    await completeMutation(dependencies.database, dependencies.agent, registerRuntimePlan, async () => {
      await dependencies.agent.registerRuntimePlan(registerRuntimePlan.operationId, {
        projectId, revisionId: setup.revision.id, revisionHash: configurationHash,
        runtimePlan: { format: "devspace.runtime-plan/v1", hash: runtimePlanHash, canonicalJson: compiledRuntimePlanJson }
      });
    }, polling);

    const createStore = dependencies.database.getOrCreateOperation({
      projectId, actor, operationName: "project.managed-store.create", resourceType: "project", resourceId: projectId
    });
    await completeMutation(dependencies.database, dependencies.agent, createStore, async () => {
      await dependencies.agent.createManagedStore(createStore.operationId, {
        projectId, source: { kind: "remote", url: setup.project.repositoryUrl }
      });
    }, polling);

    const fetch = dependencies.database.getOrCreateOperation({
      projectId, actor, operationName: "project.fetch", resourceType: "project", resourceId: projectId
    });
    await completeMutation(dependencies.database, dependencies.agent, fetch, async () => {
      await dependencies.agent.fetchProject(fetch.operationId, projectId);
    }, polling);

    const branchName = gitBranchNameSchema.parse(setup.project.defaultBranch);
    const createWorkspace = dependencies.database.getOrCreateOperation({
      projectId, actor, operationName: "workspace.create", resourceType: "workspace", resourceId: setup.workspaceId
    });
    await completeMutation(dependencies.database, dependencies.agent, createWorkspace, async () => {
      await dependencies.agent.createWorkspace(createWorkspace.operationId, {
        projectId, workspaceId: setup.workspaceId, projectSlug: setup.project.slug, workspaceSlug: setup.workspaceSlug, kind: "primary",
        revision: { revisionId: setup.revision.id, revisionHash: configurationHash },
        branchName,
        baseRef: { kind: "branch", branchName }
      });
    }, polling);
  }

  const [git, workspace] = await Promise.all([
    dependencies.agent.inspectGit(projectId, setup.workspaceId),
    dependencies.agent.inspectWorkspace(projectId, setup.workspaceId)
  ]);
  if (workspace.observedState !== "stopped" || workspace.runtimeStack.observedState !== "absent") {
    throw new WorkspaceSetupExecutionError("WORKSPACE_STATE_CONFLICT", "The primary workspace was created but is not safely stopped without a runtime.");
  }
  const project = dependencies.database.finalizePrimaryWorkspace({
    projectId, revisionId: setup.revision.id, workspaceId: setup.workspaceId,
    branchName: setup.project.defaultBranch, baseRef: setup.project.defaultBranch, actor,
    dirtyState: git.dirty ? "dirty" : "clean"
  });
  return { project, git, workspace };
}
