import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { ProjectWorkbench } from "../../project-workbench.js";
import { WorkspaceSetupForm } from "../../workspace-setup-form.js";
import { authenticateHeaders } from "../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../server/config.js";
import { loadProjectWorkspaceData } from "../../../server/project-workspace.js";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const config = readWebRuntimeConfig();
  const actor = await authenticateHeaders(await headers(), config.auth);
  const { projectId } = await params;
  const data = await loadProjectWorkspaceData(projectId);
  if (data === null) notFound();

  const { project, agentStatus, agentReachable, runtimeAvailability, live, runtimeOperation } = data;
  const activeAction = runtimeOperation?.activeAction ?? null;
  const inspectedWorkspace = runtimeOperation?.inspection ?? live?.workspace ?? null;
  const workspaceState = activeAction === "start" ? "starting" : activeAction === "stop" ? "stopping"
    : inspectedWorkspace?.observedState ?? `${project.primaryWorkspace?.observedState ?? "unknown"} (persisted)`;
  const inspectedRuntimeState = inspectedWorkspace?.runtimeStack.observedState ?? project.runtime?.observedState ?? "absent";
  const runtimeState = activeAction === "start" ? "starting" : activeAction === "stop" ? "stopping" : inspectedRuntimeState;

  if (project.state === "ready" && project.primaryWorkspace !== null) {
    return <ProjectWorkbench projectId={project.id} workspaceId={project.primaryWorkspace.id} projectName={project.name}
      branchName={project.primaryWorkspace.branchName} repositoryUrl={project.repositoryUrl} runtimeState={runtimeState}
      runtimeRunning={runtimeState === "running"} runtimeAvailable={runtimeAvailability === "available"} agentStatus={agentStatus}
      agentReachable={agentReachable} activeAction={activeAction} canStart={runtimeOperation?.canStart === true}
      canStop={runtimeOperation?.canStop === true} retryStart={runtimeOperation?.canRetryStart === true}
      initialTasks={project.tasks} initialTaskRuns={project.taskRuns} initialTerminals={project.terminals} initialPreviews={project.previews}
      previewGateway={{ protocol: config.previewGatewayProtocol, port: config.previewGatewayPort }} actor={actor.identity} />;
  }

  return <main className="project-page">
    <header className="project-header">
      <div><p className="eyebrow">Project workspace</p><h1>{project.name}</h1><p className="project-repository">{project.repositoryUrl}</p></div>
      <div className={`agent-status ${agentReachable ? "online" : "offline"}`} role="status">
        <span aria-hidden="true" /> Agent {agentStatus}
      </div>
    </header>
    <p><Link href="/">← Back to Projects</Link></p>

    <section className="project-summary" aria-labelledby="project-summary-heading">
      <div className="section-heading"><div><h2 id="project-summary-heading">Project overview</h2><p>{project.slug} · default branch {project.defaultBranch}</p></div></div>
      <dl>
        <div><dt>Project status</dt><dd>{projectStateLabel(project.state)}</dd></div>
        <div><dt>Primary workspace</dt><dd>{project.primaryWorkspace?.name ?? "Not created"} · {workspaceState}</dd></div>
        <div><dt>Development runtime</dt><dd>{runtimeState === "absent" ? "No container created" : runtimeStateLabel(runtimeState)}</dd></div>
        <div><dt>Rootless runtime</dt><dd>{runtimeAvailability === "available" ? "Available" : "Unavailable"}</dd></div>
        {project.activeRevision !== null && <div><dt>Project Options</dt><dd>Active revision v{project.activeRevision.number}</dd></div>}
        {project.runtime?.errorMessage !== null && project.runtime?.errorMessage !== undefined && <div><dt>Runtime error</dt><dd>{project.runtime.errorMessage}</dd></div>}
      </dl>
    </section>

    {project.state === "registering" && <section className="workspace-section" aria-labelledby="setup-heading">
      <h2 id="setup-heading">Workspace setup</h2>
      <p>Configure the primary workspace and its immutable Project Options.</p>
      <WorkspaceSetupForm projectId={project.id} agentReachable={agentReachable} previewBases={config.previewBases} />
    </section>}

    <footer>Signed in as {actor.identity}</footer>
  </main>;
}

function projectStateLabel(state: "registering" | "ready" | "invalid" | "archived"): string {
  return { registering: "Registered — workspace setup pending", ready: "Ready", invalid: "Needs attention", archived: "Archived" }[state];
}

function runtimeStateLabel(state: string): string {
  return { starting: "Starting", running: "Running", stopping: "Stopping", stopped: "Stopped" }[state] ?? state;
}
