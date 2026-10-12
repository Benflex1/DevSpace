import {
  revisionIdentitySchema,
  type AgentSnapshotData,
  type AdoptConfigurationRevisionData,
  type ConfigurationRevisionData,
  type ConfigurationRuntimePlanData,
  type RevisionIdentity
} from "@devspace/contracts";
import {
  canonicalizeProjectOptionsV1,
  canonicalizeRuntimePlanV1,
  compileRuntimePlanV1,
  hashProjectOptionsV1,
  hashRuntimePlanV1,
  parseProjectOptionsV1
} from "@devspace/project-options";
import { getApprovedPreviewBases, type ApprovedPreviewBaseRegistry } from "@devspace/security";
import { v7 as uuidv7 } from "uuid";
import { materializePreviews } from "./preview-persistence.js";
import { AgentResponseError, type WorkspaceAgentClient } from "./agent-client.js";
import { ProjectSetupConflictError } from "./database.js";

export class ProjectOptionsValidationError extends Error {
  constructor(readonly field: string, message: string) { super(message); this.name = "ProjectOptionsValidationError"; }
}

export class ProjectOptionsAdoptionError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly retryable = false) {
    super(message); this.name = "ProjectOptionsAdoptionError";
  }
}

export type ProjectOptionsAdoptionAgent = Pick<WorkspaceAgentClient,
  "snapshot" | "runtimeStatus" | "inspectWorkspace" | "registerRevision" | "registerRuntimePlan" | "adoptConfigurationRevision">;

export interface ProjectOptionsAdoptionDependencies {
  readonly database: ProjectOptionsStateDatabase;
  readonly agent: ProjectOptionsAdoptionAgent;
  readonly previewBaseRegistry: ApprovedPreviewBaseRegistry;
  readonly createId?: () => string;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly nowMonotonic?: () => number;
  readonly timeoutMs?: number;
}

type ProjectOptionsStateDatabase = Pick<ReturnType<typeof import("./database.js").openProjectDatabase>,
  "getProjectOptionsState" | "getPendingProjectOptionsApply" | "getCompletedProjectOptionsApply" | "createProjectOptionsDraft"
  | "reserveProjectOptionsApply" | "markProjectOptionsApplyRunning" | "markProjectOptionsAdoptionSubmitted"
  | "activateProjectOptionsRevision" | "failProjectOptionsApply" | "getOrCreateRevisionOperation" | "finishOperation" | "listPreviews">;

function compileOptions(value: unknown) {
  let options: ReturnType<typeof parseProjectOptionsV1>;
  try { options = parseProjectOptionsV1(value); }
  catch (error) {
    throw new ProjectOptionsValidationError("options", error instanceof Error ? error.message : "Project Options are invalid.");
  }
  if (options.previews.some((preview) => preview.target.kind !== "workspace")) {
    throw new ProjectOptionsValidationError("previews", "Only workspace preview targets can be applied in this release.");
  }
  let plan: ReturnType<typeof compileRuntimePlanV1>;
  try { plan = compileRuntimePlanV1(options); }
  catch (error) {
    throw new ProjectOptionsValidationError("options", error instanceof Error ? error.message : "The runtime plan could not be compiled.");
  }
  return {
    options,
    configurationJson: canonicalizeProjectOptionsV1(options),
    configurationHash: hashProjectOptionsV1(options),
    plan,
    planJson: canonicalizeRuntimePlanV1(plan),
    planHash: hashRuntimePlanV1(plan)
  };
}

function activeOptions(state: ReturnType<ProjectOptionsStateDatabase["getProjectOptionsState"]>) {
  try {
    const options = parseProjectOptionsV1(JSON.parse(state.activeRevision.configurationJson));
    if (canonicalizeProjectOptionsV1(options) !== state.activeRevision.configurationJson
      || hashProjectOptionsV1(options) !== state.activeRevision.configurationHash) throw new Error("active-revision-hash-mismatch");
    return options;
  } catch {
    throw new ProjectOptionsAdoptionError("CONFIGURATION_INVALID", "The active Project Options revision could not be verified.", 409);
  }
}

function assertSupportedOptionsEdit(current: ReturnType<typeof parseProjectOptionsV1>, next: ReturnType<typeof parseProjectOptionsV1>): void {
  if (current.developmentEnvironment.source.kind !== "image" || next.developmentEnvironment.source.kind !== "image") {
    throw new ProjectOptionsValidationError("developmentEnvironment.source", "Only development container image references can be changed in this release.");
  }
  const otherDevelopmentSettings = { ...next.developmentEnvironment,
    source: current.developmentEnvironment.source, ports: current.developmentEnvironment.ports };
  if (JSON.stringify(otherDevelopmentSettings) !== JSON.stringify(current.developmentEnvironment)) {
    throw new ProjectOptionsValidationError("developmentEnvironment", "Only the image reference and ports used by workspace previews can be changed here.");
  }
  const expectedPreviewPorts = next.previews.map((preview) => ({ name: preview.key, containerPort: preview.containerPort, protocol: "tcp" as const }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const configuredPorts = next.developmentEnvironment.ports.map((port) => ({ ...port }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(configuredPorts) !== JSON.stringify(expectedPreviewPorts)) {
    throw new ProjectOptionsValidationError("developmentEnvironment.ports", "Workspace ports must match the configured previews exactly.");
  }
  for (const key of ["namedVolumes", "services", "aiProfile", "resources"] as const) {
    if (JSON.stringify(next[key]) !== JSON.stringify(current[key])) {
      throw new ProjectOptionsValidationError(key, `The ${key} setting is outside this Project Options editing slice.`);
    }
  }
}

function materializeCandidatePreviews(input: {
  readonly state: ReturnType<ProjectOptionsStateDatabase["getProjectOptionsState"]>;
  readonly configurationRevisionId: string;
  readonly options: ReturnType<typeof parseProjectOptionsV1>;
  readonly previewIds: Readonly<Record<string, string>>;
  readonly previewBaseRegistry: ApprovedPreviewBaseRegistry;
  readonly now: string;
}) {
  try {
    return materializePreviews({
      projectId: input.state.project.id,
      projectSlug: input.state.project.slug,
      workspaceId: input.state.workspace.id,
      workspaceSlug: input.state.workspace.slug,
      configRevisionId: input.configurationRevisionId,
      previews: input.options.previews,
      ids: input.previewIds,
      previewBaseRegistry: input.previewBaseRegistry,
      now: input.now
    });
  } catch (error) {
    throw new ProjectOptionsValidationError("previews", error instanceof Error ? error.message : "Preview configuration is not approved.");
  }
}

async function waitForOperation(agent: ProjectOptionsAdoptionAgent, operationId: string, timeoutMs: number,
  dependencies: { wait?: (ms: number) => Promise<void>; nowMonotonic?: () => number }): Promise<"succeeded" | "failed" | "pending"> {
  const now = dependencies.nowMonotonic ?? (() => Date.now());
  const wait = dependencies.wait ?? (async (milliseconds) => await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;
  let delay = 25;
  do {
    const snapshot = await agent.snapshot().catch(() => null);
    const observation = snapshot?.operationObservations.find((item) => item.operationId === operationId);
    if (observation?.state === "succeeded") return "succeeded";
    if (observation?.state === "failed") return "failed";
    if (now() >= deadline) return "pending";
    await wait(Math.min(delay, deadline - now()));
    delay = Math.min(Math.ceil(delay * 1.7), 1_000);
  } while (now() < deadline);
  return "pending";
}

function operationFailure(snapshot: AgentSnapshotData, operationId: string) {
  return snapshot.operationObservations.find((item) => item.operationId === operationId)?.failure ?? null;
}

export function readProjectOptions(projectId: string, dependencies: Pick<ProjectOptionsAdoptionDependencies, "database" | "previewBaseRegistry">) {
  const state = dependencies.database.getProjectOptionsState(projectId);
  const options = activeOptions(state);
  const draft = state.drafts[0];
  return {
    projectId,
    workspaceId: state.workspace.id,
    activeRevision: { id: state.activeRevision.id, number: state.activeRevision.revisionNumber,
      hash: state.activeRevision.configurationHash, options },
    draft: draft === undefined ? null : { id: draft.id, number: draft.revisionNumber, hash: draft.configurationHash,
      options: parseProjectOptionsV1(JSON.parse(draft.configurationJson)) },
    pendingApply: state.pendingApply === null ? null : (() => {
      const pending = dependencies.database.getPendingProjectOptionsApply(projectId);
      return pending === null ? null : {
        operationId: pending.operation.operationId,
        state: pending.operation.state,
        phase: pending.phase,
        expectedRevision: pending.expectedRevision,
        candidateRevision: pending.candidateRevision
      };
    })(),
    previews: dependencies.database.listPreviews(projectId, state.workspace.id),
    approvedPreviewBaseIds: getApprovedPreviewBases(dependencies.previewBaseRegistry).map((base) => base.id)
  };
}

export function saveProjectOptionsDraft(input: {
  readonly projectId: string; readonly actor: string; readonly expectedRevision: RevisionIdentity; readonly options: unknown;
}, dependencies: Pick<ProjectOptionsAdoptionDependencies, "database" | "previewBaseRegistry" | "createId">) {
  const expectedRevision = revisionIdentitySchema.parse(input.expectedRevision);
  const state = dependencies.database.getProjectOptionsState(input.projectId);
  const compiled = compileOptions(input.options);
  assertSupportedOptionsEdit(activeOptions(state), compiled.options);
  const createId = dependencies.createId ?? uuidv7;
  const revisionId = createId();
  const previewIds = Object.fromEntries(compiled.options.previews.map((preview) => [preview.key, createId()]));
  // Materialization uses the same approved registry and hostname composer as the active setup path.
  materializeCandidatePreviews({ state, configurationRevisionId: revisionId, options: compiled.options,
    previewIds, previewBaseRegistry: dependencies.previewBaseRegistry, now: new Date().toISOString() });
  const revision = dependencies.database.createProjectOptionsDraft({ projectId: input.projectId,
    workspaceId: state.workspace.id, expectedRevision, revisionId,
    configurationJson: compiled.configurationJson, configurationHash: compiled.configurationHash,
    compiledRuntimePlanJson: compiled.planJson, runtimePlanHash: compiled.planHash, actor: input.actor });
  return { id: revision.id, number: revision.revisionNumber, hash: revision.configurationHash,
    options: parseProjectOptionsV1(JSON.parse(revision.configurationJson)) };
}

function revisionData(input: { projectId: string; revisionId: string; configurationJson: string; configurationHash: string }): ConfigurationRevisionData {
  return { projectId: input.projectId, revisionId: input.revisionId,
    configuration: { format: "devspace.project-options/v1", hash: input.configurationHash, canonicalJson: input.configurationJson } };
}

function runtimePlanData(input: { projectId: string; revisionId: string; revisionHash: string; planJson: string; planHash: string }): ConfigurationRuntimePlanData {
  return { projectId: input.projectId, revisionId: input.revisionId, revisionHash: input.revisionHash,
    runtimePlan: { format: "devspace.runtime-plan/v1", canonicalJson: input.planJson, hash: input.planHash } };
}

export async function applyProjectOptions(input: {
  readonly projectId: string; readonly actor: string; readonly expectedRevision: RevisionIdentity; readonly candidateRevisionId: string;
}, dependencies: ProjectOptionsAdoptionDependencies): Promise<{
  readonly state: "applied" | "pending";
  readonly operationId: string;
  readonly activeRevisionId: string;
  readonly runtimeState: "absent" | "unknown";
  readonly message: string;
}> {
  const expectedRevision = revisionIdentitySchema.parse(input.expectedRevision);
  const state = dependencies.database.getProjectOptionsState(input.projectId);
  if (state.activeRevision.id === input.candidateRevisionId) {
    const completed = dependencies.database.getCompletedProjectOptionsApply(input.projectId, input.candidateRevisionId);
    let progress: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(completed?.progressJson ?? "null");
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) progress = parsed as Record<string, unknown>;
    } catch { /* malformed completion evidence is not accepted as idempotent success */ }
    const priorExpected = revisionIdentitySchema.safeParse(progress?.["expectedRevision"]);
    if (completed !== null && priorExpected.success && priorExpected.data.revisionId === expectedRevision.revisionId
      && priorExpected.data.revisionHash === expectedRevision.revisionHash) {
      return { state: "applied", operationId: completed.operationId, activeRevisionId: state.activeRevision.id,
        runtimeState: "unknown", message: "This Project Options revision is already active." };
    }
    throw new ProjectSetupConflictError("This Project Options revision is already active or is not the expected saved draft.");
  }
  const candidate = state.drafts.find((revision) => revision.id === input.candidateRevisionId);
  if (candidate === undefined || candidate.compiledRuntimePlanJson === null || candidate.runtimePlanHash === null) {
    throw new ProjectSetupConflictError("The candidate Project Options revision is not a saved draft.");
  }
  const candidateRevision = { revisionId: candidate.id, revisionHash: candidate.configurationHash };
  const options = parseProjectOptionsV1(JSON.parse(candidate.configurationJson));
  assertSupportedOptionsEdit(activeOptions(state), options);
  const compiled = compileOptions(options);
  if (compiled.configurationHash !== candidate.configurationHash || compiled.planJson !== candidate.compiledRuntimePlanJson
    || compiled.planHash !== candidate.runtimePlanHash) {
    throw new ProjectOptionsAdoptionError("CONFIGURATION_INVALID", "The saved Project Options draft failed integrity validation.", 409);
  }

  const existingPending = dependencies.database.getPendingProjectOptionsApply(input.projectId);
  const createId = dependencies.createId ?? uuidv7;
  const generatedPreviewIds = Object.fromEntries(options.previews.map((preview) => [preview.key, createId()]));
  const reservation = dependencies.database.reserveProjectOptionsApply({
    projectId: input.projectId, workspaceId: state.workspace.id, actor: input.actor,
    expectedRevision, candidateRevision, previewIds: generatedPreviewIds
  });
  const { operation, previewIds } = reservation;
  dependencies.database.markProjectOptionsApplyRunning(operation.operationId);
  const pendingResult = () => ({ state: "pending" as const, operationId: operation.operationId,
    activeRevisionId: expectedRevision.revisionId, runtimeState: "unknown" as const,
    message: "Apply is still running. The prior configuration remains active until the Web application confirms Agent adoption and activates the revision." });
  const failBeforeAgentAdoption = (code: string, message: string, status = 409): never => {
    dependencies.database.failProjectOptionsApply(operation.operationId, { code, message });
    throw new ProjectOptionsAdoptionError(code, message, status);
  };

  const timeoutMs = dependencies.timeoutMs ?? 120_000;
  const applyObservation = await dependencies.agent.snapshot().catch(() => null);
  const priorAdoption = applyObservation?.operationObservations.find((item) => item.operationId === operation.operationId);
  if (priorAdoption?.state === "failed") {
    const failure = operationFailure(applyObservation!, operation.operationId)!;
    failBeforeAgentAdoption(failure.code, failure.message, 409);
  }

  const revisionRegistration = dependencies.database.getOrCreateRevisionOperation({ projectId: input.projectId,
    actor: input.actor, operationName: "configuration-revision.register", revisionId: candidate.id });
  if (revisionRegistration.state !== "succeeded") {
    try {
      await dependencies.agent.registerRevision(revisionRegistration.operationId,
        revisionData({ projectId: input.projectId, revisionId: candidate.id, configurationJson: candidate.configurationJson,
          configurationHash: candidate.configurationHash }));
    } catch (error) {
      if (error instanceof AgentResponseError) {
        dependencies.database.finishOperation(revisionRegistration.operationId, { state: "failed", code: error.code, message: error.message });
        failBeforeAgentAdoption(error.code, error.message, 422);
      }
      return pendingResult();
    }
    const outcome = await waitForOperation(dependencies.agent, revisionRegistration.operationId, timeoutMs, dependencies);
    if (outcome === "failed") {
      const snapshot = await dependencies.agent.snapshot().catch(() => null);
      const failure = snapshot === null ? null : operationFailure(snapshot, revisionRegistration.operationId);
      const code = failure?.code ?? "AGENT_INTERNAL_ERROR";
      const message = failure?.message ?? "Candidate configuration registration failed.";
      dependencies.database.finishOperation(revisionRegistration.operationId, { state: "failed", code, message });
      failBeforeAgentAdoption(code, message, 422);
    }
    if (outcome === "pending") return pendingResult();
    dependencies.database.finishOperation(revisionRegistration.operationId, { state: "succeeded" });
  }

  const planRegistration = dependencies.database.getOrCreateRevisionOperation({ projectId: input.projectId,
    actor: input.actor, operationName: "configuration-runtime-plan.register", revisionId: candidate.id });
  if (planRegistration.state !== "succeeded") {
    try {
      await dependencies.agent.registerRuntimePlan(planRegistration.operationId,
        runtimePlanData({ projectId: input.projectId, revisionId: candidate.id, revisionHash: candidate.configurationHash,
          planJson: candidate.compiledRuntimePlanJson, planHash: candidate.runtimePlanHash }));
    } catch (error) {
      if (error instanceof AgentResponseError) {
        dependencies.database.finishOperation(planRegistration.operationId, { state: "failed", code: error.code, message: error.message });
        failBeforeAgentAdoption(error.code, error.message, 422);
      }
      return pendingResult();
    }
    const outcome = await waitForOperation(dependencies.agent, planRegistration.operationId, timeoutMs, dependencies);
    if (outcome === "failed") {
      const snapshot = await dependencies.agent.snapshot().catch(() => null);
      const failure = snapshot === null ? null : operationFailure(snapshot, planRegistration.operationId);
      const code = failure?.code ?? "RUNTIME_POLICY_VIOLATION";
      const message = failure?.message ?? "Candidate runtime plan registration failed.";
      dependencies.database.finishOperation(planRegistration.operationId, { state: "failed", code, message });
      failBeforeAgentAdoption(code, message, 422);
    }
    if (outcome === "pending") return pendingResult();
    dependencies.database.finishOperation(planRegistration.operationId, { state: "succeeded" });
  }

  let adoptionSucceeded = priorAdoption?.state === "succeeded";
  const adoptionWasSubmitted = existingPending?.phase === "adoption-submitted" || priorAdoption !== undefined;
  if (!adoptionWasSubmitted) {
    const runtime = await dependencies.agent.runtimeStatus().catch(() => null);
    if (runtime?.rootlessRuntime !== "available" || runtime.operationJournal !== "available") {
      failBeforeAgentAdoption("ROOTLESS_RUNTIME_UNAVAILABLE", "The dedicated rootless runtime or Agent operation journal is unavailable.", 503);
    }
    const inspection = await dependencies.agent.inspectWorkspace(input.projectId, state.workspace.id).catch(() => null);
    if (inspection === null) {
      dependencies.database.failProjectOptionsApply(operation.operationId, { code: "AGENT_UNAVAILABLE", message: "The Agent workspace inspection is unavailable." });
      throw new ProjectOptionsAdoptionError("AGENT_UNAVAILABLE", "The Agent workspace inspection is unavailable.", 503);
    }
    const oldRevision = inspection.revisionId === expectedRevision.revisionId && inspection.revisionHash === expectedRevision.revisionHash;
    if (!oldRevision || inspection.observedState !== "stopped"
      || (inspection.runtimeStack.observedState !== "absent" && inspection.runtimeStack.observedState !== "stopped")) {
      failBeforeAgentAdoption("WORKSPACE_STATE_CONFLICT", "The existing workspace must be stopped under the expected configuration before Apply.", 409);
    }
    const activeAgentResource = (applyObservation?.resources ?? []).some((resource) =>
      (resource.type === "process" && resource.observation.workspaceId === state.workspace.id
        && !["exited", "failed", "killed"].includes(resource.observation.observedState))
      || (resource.type === "terminal" && resource.identity.workspaceId === state.workspace.id
        && ["creating", "active", "disconnected", "closing"].includes(resource.state)));
    if (activeAgentResource) failBeforeAgentAdoption("WORKSPACE_STATE_CONFLICT", "An Agent process or terminal is still active in this workspace.", 409);
  }

  if (!adoptionSucceeded) {
    const adoptionRequest: AdoptConfigurationRevisionData = {
      projectId: input.projectId, workspaceId: state.workspace.id, expectedRevision, candidateRevision,
      previousPreviews: dependencies.database.listPreviews(input.projectId, state.workspace.id)
        .filter((preview) => preview.targetKind === "workspace")
        .map((preview) => ({ previewId: preview.id, previewKey: preview.previewKey, hostname: preview.hostname }))
    };
    dependencies.database.markProjectOptionsAdoptionSubmitted(operation.operationId);
    try { await dependencies.agent.adoptConfigurationRevision(operation.operationId, adoptionRequest); }
    catch (error) {
      if (error instanceof AgentResponseError) {
        dependencies.database.failProjectOptionsApply(operation.operationId, { code: error.code, message: error.message });
        throw new ProjectOptionsAdoptionError(error.code, error.message, 409);
      }
      return pendingResult();
    }
    const outcome = await waitForOperation(dependencies.agent, operation.operationId, timeoutMs, dependencies);
    if (outcome === "failed") {
      const snapshot = await dependencies.agent.snapshot().catch(() => null);
      const failure = snapshot === null ? null : operationFailure(snapshot, operation.operationId);
      const code = failure?.code ?? "AGENT_INTERNAL_ERROR";
      const message = failure?.message ?? "The Agent could not safely adopt the candidate revision.";
      dependencies.database.failProjectOptionsApply(operation.operationId, { code, message });
      throw new ProjectOptionsAdoptionError(code, message, 409);
    }
    if (outcome === "pending") return pendingResult();
    adoptionSucceeded = true;
  }

  if (!adoptionSucceeded) return pendingResult();
  const adoptedInspection = await dependencies.agent.inspectWorkspace(input.projectId, state.workspace.id).catch(() => null);
  if (adoptedInspection === null || adoptedInspection.revisionId !== candidate.id
    || adoptedInspection.revisionHash !== candidate.configurationHash || adoptedInspection.observedState !== "stopped"
    || adoptedInspection.runtimeStack.observedState !== "absent") return pendingResult();

  const pending = dependencies.database.getPendingProjectOptionsApply(input.projectId);
  const activationState = dependencies.database.getProjectOptionsState(input.projectId);
  const previewRows = materializeCandidatePreviews({ state: activationState, configurationRevisionId: candidate.id,
    options, previewIds: pending?.previewIds ?? previewIds,
    previewBaseRegistry: dependencies.previewBaseRegistry, now: new Date().toISOString() });
  try {
    const active = dependencies.database.activateProjectOptionsRevision({ operationId: operation.operationId,
      projectId: input.projectId, workspaceId: state.workspace.id, expectedRevision, candidateRevision,
      imageReference: compiled.plan.developmentContainer.source.imageReference, previewRows });
    return { state: "applied", operationId: operation.operationId, activeRevisionId: active.id,
      runtimeState: "absent", message: "Project Options are active. The next Start will create the development container from the new image and runtime plan." };
  } catch {
    // Agent ownership has changed. Keep the SQLite Apply reservation pending so
    // the same operation can replay activation after a failure or process restart.
    return pendingResult();
  }
}
