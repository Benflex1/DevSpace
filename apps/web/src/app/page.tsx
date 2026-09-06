import Link from "next/link";
import { headers } from "next/headers";
import { AddProjectForm } from "./project-form.js";
import { authenticateHeaders } from "../server/auth.js";
import { readWebRuntimeConfig } from "../server/config.js";
import { loadDashboardData } from "../server/project-workspace.js";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const config = readWebRuntimeConfig();
  const actor = await authenticateHeaders(await headers(), config.auth);
  const { projects, agentStatus, agentReachable, runtimeAvailability } = await loadDashboardData();

  return <main>
    <header>
      <div><p className="eyebrow">Local development control plane</p><h1>DevSpace</h1></div>
      <div className={`agent-status ${agentReachable ? "online" : "offline"}`} role="status">
        <span aria-hidden="true" /> Agent {agentStatus}
      </div>
    </header>

    <section aria-labelledby="projects-heading">
      <div className="section-heading"><div><h2 id="projects-heading">Projects</h2><p>Persisted trusted repositories.</p></div></div>
      <ProjectList projects={projects} runtimeAvailability={runtimeAvailability} />
    </section>

    <section className="form-card" aria-labelledby="add-heading">
      <h2 id="add-heading">Add Project</h2>
      <p>Inspect a public HTTPS source or use a retained GitHub App connection before registering it.</p>
      <AddProjectForm agentReachable={agentReachable} />
    </section>
    <footer>Signed in as {actor.identity}</footer>
  </main>;
}

function ProjectList({ projects, runtimeAvailability }: {
  projects: Awaited<ReturnType<typeof loadDashboardData>>["projects"];
  runtimeAvailability: "available" | "unavailable";
}) {
  return <div id="project-list" className="project-list">
    {projects.length === 0 ? <p className="empty">No projects registered yet.</p> : projects.map((project) =>
      <article className="project-card" key={project.id}>
        <div className="project-card-heading">
          <div><h3>{project.name}</h3><code>{project.slug}</code></div>
          <Link className="project-open-link" href={`/projects/${project.id}`}>Open project</Link>
        </div>
        <dl>
          <div><dt>Repository</dt><dd>{project.repositoryUrl}</dd></div>
          <div><dt>Status</dt><dd className="pending">{projectStateLabel(project.state)}</dd></div>
          <div><dt>Primary workspace</dt><dd>{project.primaryWorkspace?.observedState ?? "Not created"}</dd></div>
          <div><dt>Development runtime</dt><dd>{project.runtime?.observedState ?? "Not created"}</dd></div>
          <div><dt>Runtime service</dt><dd>{runtimeAvailability === "available" ? "Available" : "Unavailable"}</dd></div>
        </dl>
      </article>
    )}
  </div>;
}

function projectStateLabel(state: "registering" | "ready" | "invalid" | "archived"): string {
  return { registering: "Registered — workspace setup pending", ready: "Ready", invalid: "Needs attention", archived: "Archived" }[state];
}
