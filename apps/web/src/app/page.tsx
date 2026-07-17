import { headers } from "next/headers";
import { AddProjectForm } from "./project-form.js";
import { createAgentClient } from "../server/agent-client.js";
import { authenticateHeaders } from "../server/auth.js";
import { readWebRuntimeConfig } from "../server/config.js";
import { getProjectDatabase } from "../server/database.js";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const config = readWebRuntimeConfig();
  const actor = await authenticateHeaders(await headers(), config.auth);
  const database = getProjectDatabase(config.databasePath);
  const projects = database.listProjects();
  const agentStatus = await createAgentClient(config.agentSocketPath).health()
    .then((health) => health.status === "ok" ? "connected" as const : "degraded" as const)
    .catch(() => "unavailable" as const);
  const agentReachable = agentStatus !== "unavailable";

  return <main>
    <header>
      <div><p className="eyebrow">Local development control plane</p><h1>DevSpace</h1></div>
      <div className={`agent-status ${agentReachable ? "online" : "offline"}`} role="status">
        <span aria-hidden="true" /> Agent {agentStatus}
      </div>
    </header>

    <section aria-labelledby="projects-heading">
      <div className="section-heading"><div><h2 id="projects-heading">Projects</h2><p>Persisted trusted repositories.</p></div></div>
      <ProjectList initialProjects={projects} />
    </section>

    <section className="form-card" aria-labelledby="add-heading">
      <h2 id="add-heading">Add Project</h2>
      <p>Inspect a remote Git source through the private Agent before registering it.</p>
      <AddProjectForm agentReachable={agentReachable} />
    </section>
    <footer>Signed in as {actor.identity}</footer>
  </main>;
}

function ProjectList({ initialProjects }: { initialProjects: import("../server/database.js").ProjectView[] }) {
  return <div id="project-list" className="project-list">
    {initialProjects.length === 0 ? <p className="empty">No projects registered yet.</p> : initialProjects.map((project) => <article className="project-card" key={project.id}>
      <div><h3>{project.name}</h3><code>{project.slug}</code></div>
      <dl>
        <div><dt>Repository</dt><dd>{project.repositoryUrl}</dd></div>
        <div><dt>Default branch</dt><dd>{project.defaultBranch}</dd></div>
        <div><dt>Status</dt><dd className="pending">{projectStateLabel(project.state)}</dd></div>
      </dl>
    </article>)}
  </div>;
}

function projectStateLabel(state: import("../server/database.js").ProjectView["state"]): string {
  return {
    registering: "Registered — workspace setup pending",
    ready: "Ready",
    invalid: "Needs attention",
    archived: "Archived"
  }[state];
}
