import type { GitInspectionData, WorkspaceInspectionData } from "@devspace/contracts";
import { createAgentClient } from "./agent-client.js";
import { readWebRuntimeConfig } from "./config.js";
import { getProjectDatabase, type ManagedProjectView } from "./database.js";
import { reconcilePrimaryWorkspaceRuntimeOperation, type RuntimeOperationReconciliation } from "./runtime-operation-reconciliation.js";

export type AgentConnectionStatus = "connected" | "degraded" | "unavailable";

export interface DashboardData {
  readonly projects: ReturnType<ReturnType<typeof getProjectDatabase>["listProjectSummaries"]>;
  readonly agentStatus: AgentConnectionStatus;
  readonly agentReachable: boolean;
  readonly runtimeAvailability: "available" | "unavailable";
}

export interface ProjectWorkspaceData {
  readonly project: ManagedProjectView;
  readonly agentStatus: AgentConnectionStatus;
  readonly agentReachable: boolean;
  readonly runtimeAvailability: "available" | "unavailable";
  readonly live: null | {
    readonly storeGit: GitInspectionData;
    readonly workspaceGit: GitInspectionData;
    readonly workspace: WorkspaceInspectionData;
  };
  readonly runtimeOperation: RuntimeOperationReconciliation | null;
}

async function readAgentStatus(agent: ReturnType<typeof createAgentClient>): Promise<{
  status: AgentConnectionStatus;
  reachable: boolean;
  runtimeAvailability: "available" | "unavailable";
  runtimeStatus: Awaited<ReturnType<typeof agent.runtimeStatus>> | null;
}> {
  const status = await agent.health()
    .then((health) => health.status === "ok" ? "connected" as const : "degraded" as const)
    .catch(() => "unavailable" as const);
  const reachable = status !== "unavailable";
  const runtimeStatus = reachable ? await agent.runtimeStatus().catch(() => null) : null;
  return { status, reachable, runtimeAvailability: runtimeStatus?.rootlessRuntime ?? "unavailable", runtimeStatus };
}

export async function loadDashboardData(): Promise<DashboardData> {
  const config = readWebRuntimeConfig();
  const database = getProjectDatabase(config.databasePath);
  const agent = createAgentClient(config.agentSocketPath);
  const agentState = await readAgentStatus(agent);
  return { projects: database.listProjectSummaries(), agentStatus: agentState.status,
    agentReachable: agentState.reachable, runtimeAvailability: agentState.runtimeAvailability };
}

export async function loadProjectWorkspaceData(projectId: string): Promise<ProjectWorkspaceData | null> {
  const config = readWebRuntimeConfig();
  const database = getProjectDatabase(config.databasePath);
  const project = database.getManagedProject(projectId);
  if (project === undefined) return null;
  const agent = createAgentClient(config.agentSocketPath);
  const agentState = await readAgentStatus(agent);
  const agentSnapshot = agentState.reachable ? await agent.snapshot().catch(() => null) : null;
  if (agentSnapshot !== null) database.applyExecutionSnapshot(agentSnapshot);
  let live: ProjectWorkspaceData["live"] = null;
  let runtimeOperation: RuntimeOperationReconciliation | null = null;

  if (project.state === "ready" && project.primaryWorkspace !== null && agentState.reachable) {
    const workspaceId = project.primaryWorkspace.id;
    const inspected = await Promise.all([
      agent.inspectGit(project.id, null), agent.inspectGit(project.id, workspaceId), agent.inspectWorkspace(project.id, workspaceId)
    ]).then(([storeGit, workspaceGit, workspace]) => ({ storeGit, workspaceGit, workspace })).catch(() => null);
    live = inspected;
    runtimeOperation = await reconcilePrimaryWorkspaceRuntimeOperation(project.id, {
      database, agent, snapshot: agentSnapshot, inspection: live?.workspace ?? null,
      runtimeAvailable: agentState.runtimeStatus?.rootlessRuntime === "available"
        && agentState.runtimeStatus.operationJournal === "available"
    });
  }

  const reconciledProject = database.getManagedProject(projectId);
  if (reconciledProject === undefined) return null;
  return { project: reconciledProject, agentStatus: agentState.status, agentReachable: agentState.reachable,
    runtimeAvailability: agentState.runtimeAvailability, live, runtimeOperation };
}
