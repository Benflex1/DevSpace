"use client";

import { useState, type FormEvent } from "react";

interface ProjectResult { id: string; name: string; slug: string; repositoryUrl: string; defaultBranch: string; state: string }

function suggestedName(url: string): string {
  const last = url.replace(/\/$/u, "").split("/").at(-1)?.replace(/\.git$/u, "") ?? "";
  return last.replaceAll(/[-_]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}
function suggestedSlug(url: string): string {
  const last = url.replace(/\/$/u, "").split("/").at(-1)?.replace(/\.git$/u, "") ?? "";
  return last.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

export function AddProjectForm({ agentReachable }: { agentReachable: boolean }) {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [branch, setBranch] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const onRepositoryChange = (value: string) => {
    setRepositoryUrl(value);
    if (name === "") setName(suggestedName(value));
    if (slug === "") setSlug(suggestedSlug(value));
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSubmitting(true); setMessage("Inspecting repository…");
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", "x-devspace-csrf": "1" },
        body: JSON.stringify({ repositoryUrl, name, slug, defaultBranch: branch })
      });
      const body = await response.json() as { project?: ProjectResult; message?: string };
      if (!response.ok || body.project === undefined) throw new Error(body.message ?? "Project registration failed.");
      setMessage("Project registered. Workspace setup is pending.");
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Project registration failed.");
      setSubmitting(false);
    }
  };

  return <form onSubmit={(event) => { submit(event).catch(() => { setMessage("Project registration failed."); setSubmitting(false); }); }}>
    <label>Repository URL <small>HTTPS only; no credentials or query parameters</small><input name="repositoryUrl" type="url" required placeholder="https://github.com/owner/repository.git" value={repositoryUrl} onChange={(event) => onRepositoryChange(event.target.value)} /></label>
    <div className="form-row">
      <label>Project name<input name="name" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Project slug<input name="slug" required maxLength={64} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={slug} onChange={(event) => setSlug(event.target.value)} /></label>
    </div>
    <label>Default branch <small>optional override</small><input name="defaultBranch" placeholder="Detected from repository HEAD" value={branch} onChange={(event) => setBranch(event.target.value)} /></label>
    <button type="submit" disabled={submitting || !agentReachable}>{submitting ? "Registering…" : "Inspect and register"}</button>
    {!agentReachable && <p className="message error">Start the DevSpace Agent before adding a project.</p>}
    {message !== "" && <p className={`message ${message.includes("pending") ? "success" : ""}`} role="status">{message}</p>}
  </form>;
}
