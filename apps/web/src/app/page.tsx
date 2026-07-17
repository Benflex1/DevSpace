import { headers } from "next/headers";
import { AddProjectForm } from "./project-form.js";
import { WorkspaceSetupForm } from "./workspace-setup-form.js";
import { RuntimeControls } from "./runtime-controls.js";
import { createAgentClient } from "../server/agent-client.js";
import { authenticateHeaders } from "../server/auth.js";
import { readWebRuntimeConfig } from "../server/config.js";
import { getProjectDatabase } from "../server/database.js";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const config = readWebRuntimeConfig();
  const actor = await authenticateHeaders(await headers(), config.auth);
  const database = getProjectDatabase(config.databasePath);
  const projects = database.listManagedProjects();
  const agent = createAgentClient(config.agentSocketPath);
  const agentStatus = await agent.health()
    .then((health) => health.status === "ok" ? "connected" as const : "degraded" as const)
    .catch(() => "unavailable" as const);
  const agentReachable = agentStatus !== "unavailable";
  const runtimeAvailability = agentReachable ? await agent.runtimeStatus().then((status) => status.rootlessRuntime).catch(() => "unavailable" as const) : "unavailable" as const;
  const liveStates = new Map((await Promise.all(projects.filter((project) => project.state === "ready" && project.primaryWorkspace !== null).map(async (project) => {
    try {
      const workspaceId = project.primaryWorkspace!.id;
      const [storeGit, workspaceGit, workspace] = await Promise.all([
        agent.inspectGit(project.id, null), agent.inspectGit(project.id, workspaceId), agent.inspectWorkspace(project.id, workspaceId)
      ]);
      return [project.id, { storeGit, workspaceGit, workspace }] as const;
    } catch { return [project.id, null] as const; }
  }))));

  return <main>
    <header>
      <div><p className="eyebrow">Local development control plane</p><h1>DevSpace</h1></div>
      <div className={`agent-status ${agentReachable ? "online" : "offline"}`} role="status">
        <span aria-hidden="true" /> Agent {agentStatus}
      </div>
    </header>

    <section aria-labelledby="projects-heading">
      <div className="section-heading"><div><h2 id="projects-heading">Projects</h2><p>Persisted trusted repositories.</p></div></div>
      <ProjectList initialProjects={projects} liveStates={liveStates} agentReachable={agentReachable} runtimeAvailability={runtimeAvailability} />
    </section>

    <section className="form-card" aria-labelledby="add-heading">
      <h2 id="add-heading">Add Project</h2>
      <p>Inspect a remote Git source through the private Agent before registering it.</p>
      <AddProjectForm agentReachable={agentReachable} />
    </section>
    <footer>Signed in as {actor.identity}</footer>
  </main>;
}

function ProjectList({ initialProjects, liveStates, agentReachable, runtimeAvailability }: {
  initialProjects: import("../server/database.js").ManagedProjectView[];
  liveStates: Map<string, null | {
    storeGit: import("@devspace/contracts").GitInspectionData;
    workspaceGit: import("@devspace/contracts").GitInspectionData;
    workspace: import("@devspace/contracts").WorkspaceInspectionData;
  }>;
  agentReachable: boolean;
  runtimeAvailability: "available" | "unavailable";
}) {
  return <div id="project-list" className="project-list">
    {initialProjects.length === 0 ? <p className="empty">No projects registered yet.</p> : initialProjects.map((project) => {
      const live = liveStates.get(project.id);
      const runtimeState = live?.workspace.runtimeStack.observedState ?? project.runtime?.observedState ?? "absent";
      return <article className="project-card" key={project.id}>
      <div><h3>{project.name}</h3><code>{project.slug}</code></div>
      <dl>
        <div><dt>Repository</dt><dd>{project.repositoryUrl}</dd></div>
        <div><dt>Default branch</dt><dd>{project.defaultBranch}</dd></div>
        <div><dt>Status</dt><dd className="pending">{projectStateLabel(project.state)}</dd></div>
        {project.activeRevision !== null && <div><dt>Project Options</dt><dd>Active revision v{project.activeRevision.number}</dd></div>}
        {project.primaryWorkspace !== null && <>
          <div><dt>Managed repository</dt><dd>{live === undefined || live === null ? "Inspection unavailable" : `Present · ${shortCommit(live.storeGit.headCommit)}`}</dd></div>
          <div><dt>Primary workspace</dt><dd>{project.primaryWorkspace.name} · {project.primaryWorkspace.branchName}</dd></div>
          <div><dt>Workspace state</dt><dd>{live === undefined || live === null ? `${project.primaryWorkspace.observedState} (persisted)` : `${live.workspace.observedState} · ${live.workspaceGit.dirty ? "dirty" : "clean"}`}</dd></div>
          <div><dt>Rootless runtime</dt><dd>{runtimeAvailability === "available" ? "Available" : "Unavailable"}</dd></div>
          <div><dt>Development runtime</dt><dd>{runtimeState === "absent" ? "No container created" : runtimeState === "running" ? "Running" : runtimeState === "stopped" ? "Stopped" : runtimeState}</dd></div>
          {project.runtime?.errorMessage !== null && project.runtime?.errorMessage !== undefined && <div><dt>Runtime error</dt><dd>{project.runtime.errorMessage}</dd></div>}
        </>}
      </dl>
      {project.state === "registering" && <WorkspaceSetupForm projectId={project.id} agentReachable={agentReachable} />}
      {project.state === "ready" && project.primaryWorkspace !== null && <RuntimeControls projectId={project.id}
        runtimeState={runtimeState} runtimeAvailable={runtimeAvailability === "available"} />}
    </article>;
    })}
  </div>;
}

function shortCommit(commit: string | null): string { return commit === null ? "unborn repository" : commit.slice(0, 12); }

function projectStateLabel(state: import("../server/database.js").ProjectView["state"]): string {
  return {
    registering: "Registered — workspace setup pending",
    ready: "Ready",
    invalid: "Needs attention",
    archived: "Archived"
  }[state];
}
