"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { updateSuggestedField, type SuggestedFieldState } from "./project-form-fields.js";

interface ProjectResult { id: string; name: string; slug: string; repositoryUrl: string; defaultBranch: string; state: string }
interface Connection {
  status: string; connectionId?: string | null; accountLogin?: string; accountId?: string; accountType?: string;
  repositorySelection?: string; permissions?: Record<string, "read" | "write">; cleanupDegraded?: boolean;
  lifecycleState?: string; lifecycleGeneration?: number; cleanupState?: string; lastAuthorityFailureCode?: string | null;
  pendingAttempt?: { connectionId: string; lifecycleGeneration: number; status: string; expiresAt: string } | null;
}
interface Repository {
  repositoryId: string; ownerLogin: string; name: string; fullName: string; defaultBranch: string;
  private: boolean; archived: boolean; disabled: boolean;
}

function suggestedName(value: string): string {
  const last = value.replace(/\/$/u, "").split("/").at(-1)?.replace(/\.git$/u, "") ?? "";
  return last.replaceAll(/[-_]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}
function suggestedSlug(value: string): string {
  const last = value.replace(/\/$/u, "").split("/").at(-1)?.replace(/\.git$/u, "") ?? "";
  return last.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

export function AddProjectForm({ agentReachable }: { agentReachable: boolean }) {
  const [sourceKind, setSourceKind] = useState<"remote" | "github-app">("remote");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [connection, setConnection] = useState<Connection>({ status: "loading" });
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [continuation, setContinuation] = useState<string | null>(null);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [name, setName] = useState<SuggestedFieldState>({ value: "", source: "auto" });
  const [slug, setSlug] = useState<SuggestedFieldState>({ value: "", source: "auto" });
  const [branch, setBranch] = useState<SuggestedFieldState>({ value: "", source: "auto" });
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loadingGithub, setLoadingGithub] = useState(false);

  const loadConnection = useCallback(async () => {
    setLoadingGithub(true);
    try {
      const response = await fetch("/api/integrations/github/connection", { cache: "no-store" });
      setConnection(await response.json() as Connection);
    } catch { setConnection({ status: "failed" }); }
    finally { setLoadingGithub(false); }
  }, []);
  useEffect(() => { loadConnection().catch(() => undefined); }, [loadConnection]);

  const listRepositories = async (next?: string) => {
    setLoadingGithub(true); setMessage("");
    try {
      const query = new URLSearchParams({ pageSize: "25", ...(next === undefined ? {} : { continuation: next }) });
      const response = await fetch(`/api/integrations/github/repositories?${query}`, { cache: "no-store" });
      const body = await response.json() as { repositories?: Repository[]; continuation?: string | null; message?: string; cleanupDegraded?: boolean };
      if (!response.ok || body.repositories === undefined) throw new Error(body.message ?? "Repositories could not be listed.");
      setRepositories(next === undefined ? body.repositories : [...repositories, ...body.repositories]);
      setContinuation(body.continuation ?? null);
      if (body.cleanupDegraded) setConnection((current) => ({ ...current, cleanupDegraded: true, status: "degraded" }));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Repositories could not be listed."); }
    finally { setLoadingGithub(false); }
  };
  const refreshGithub = async () => {
    setLoadingGithub(true); setMessage("");
    try {
      const response = await fetch("/api/integrations/github/refresh", { method: "POST", headers: { Origin: window.location.origin, "X-DevSpace-CSRF": "1" } });
      const body = await response.json() as Connection & { message?: string };
      if (!response.ok) throw new Error(body.message ?? "GitHub access could not be refreshed.");
      setConnection(body); setRepositories([]); setContinuation(null);
      await listRepositories();
    } catch (error) { setMessage(error instanceof Error ? error.message : "GitHub access could not be refreshed."); }
    finally { setLoadingGithub(false); }
  };
  const disconnectGithub = async () => {
    if (connection.connectionId === null || connection.connectionId === undefined) return;
    if (!window.confirm("Disconnect this GitHub App connection? DevSpace will keep all projects, worktrees, commits, and local changes, but private GitHub access will stop until you reconnect.")) return;
    setLoadingGithub(true); setMessage("");
    try {
      const response = await fetch("/api/integrations/github/disconnect", { method: "POST",
        headers: { "content-type": "application/json", Origin: window.location.origin, "X-DevSpace-CSRF": "1" },
        body: JSON.stringify({ connectionId: connection.connectionId }) });
      const body = await response.json() as Connection & { message?: string };
      if (!response.ok) throw new Error(body.message ?? "GitHub disconnect is pending.");
      setConnection(body); setRepositories([]); setContinuation(null); setSelectedRepositoryId("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "GitHub disconnect is pending."); }
    finally { setLoadingGithub(false); }
  };
  const reconnectGithub = async () => {
    if (connection.connectionId === null || connection.connectionId === undefined) return;
    setLoadingGithub(true); setMessage("");
    try {
      const response = await fetch("/api/integrations/github/reconnect", { method: "POST",
        headers: { "content-type": "application/json", Origin: window.location.origin, "X-DevSpace-CSRF": "1" },
        body: JSON.stringify({ connectionId: connection.connectionId }) });
      const body = await response.json() as { installationUrl?: string; message?: string };
      if (!response.ok || body.installationUrl === undefined) throw new Error(body.message ?? "GitHub reconnect could not be started.");
      window.location.assign(body.installationUrl);
    } catch (error) { setMessage(error instanceof Error ? error.message : "GitHub reconnect could not be started."); setLoadingGithub(false); }
  };
  const connectGithub = async () => {
    setLoadingGithub(true); setMessage("");
    try {
      const response = await fetch("/api/integrations/github/connection-attempts", { method: "POST", headers: { Origin: window.location.origin, "X-DevSpace-CSRF": "1" } });
      const body = await response.json() as { installationUrl?: string; message?: string };
      if (!response.ok || body.installationUrl === undefined) throw new Error(body.message ?? "Connection could not be started.");
      window.location.assign(body.installationUrl);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Connection could not be started."); setLoadingGithub(false); }
  };
  const chooseRepository = (repository: Repository) => {
    setSelectedRepositoryId(repository.repositoryId);
    setName((current) => updateSuggestedField(current, suggestedName(repository.name)));
    setSlug((current) => updateSuggestedField(current, suggestedSlug(repository.name)));
    setBranch((current) => updateSuggestedField(current, repository.defaultBranch));
  };
  const onRepositoryChange = (value: string) => {
    setRepositoryUrl(value);
    setName((current) => updateSuggestedField(current, suggestedName(value)));
    setSlug((current) => updateSuggestedField(current, suggestedSlug(value)));
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSubmitting(true); setMessage(sourceKind === "remote" ? "Inspecting repository…" : "Registering GitHub repository…");
    try {
      const body = sourceKind === "remote"
        ? { sourceKind, repositoryUrl, name: name.value, slug: slug.value, defaultBranch: branch.value }
        : { sourceKind, connectionId: connection.connectionId, repositoryId: selectedRepositoryId, name: name.value, slug: slug.value, defaultBranch: branch.value };
      const response = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json", "x-devspace-csrf": "1" }, body: JSON.stringify(body) });
      const result = await response.json() as { project?: ProjectResult; message?: string };
      if (!response.ok || result.project === undefined) throw new Error(result.message ?? "Project registration failed.");
      setMessage("Project registered. Workspace setup is pending."); window.location.reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Project registration failed."); setSubmitting(false); }
  };
  const connected = connection.status === "connected" || connection.status === "degraded";
  const lifecycleBlocked = ["disconnect-pending", "disconnected", "reconnect-pending", "installation-removed", "installation-suspended", "permission-required", "repository-access-unavailable", "transient-error"].includes(connection.status);
  const reconnectable = connection.connectionId !== null && connection.connectionId !== undefined && lifecycleBlocked;
  const selected = repositories.find((repository) => repository.repositoryId === selectedRepositoryId);

  return <form onSubmit={(event) => { submit(event).catch(() => { setMessage("Project registration failed."); setSubmitting(false); }); }}>
    <fieldset className="source-choice"><legend>Repository source</legend>
      <label><input type="radio" name="sourceKind" checked={sourceKind === "remote"} onChange={() => { setSourceKind("remote"); setBranch((current) => updateSuggestedField(current, "")); }} /> HTTPS repository URL</label>
      <label><input type="radio" name="sourceKind" checked={sourceKind === "github-app"} onChange={() => { setSourceKind("github-app"); loadConnection().catch(() => undefined); }} /> Connected GitHub repository</label>
    </fieldset>
    {sourceKind === "remote" ? <label>Repository URL <small>HTTPS only; no credentials or query parameters</small><input name="repositoryUrl" type="url" required placeholder="https://github.com/owner/repository.git" value={repositoryUrl} onChange={(event) => onRepositoryChange(event.target.value)} /></label>
      : <section className="github-selection" aria-label="Connected GitHub repository">
        {connected && <p>Verified {connection.accountType} <strong>{connection.accountLogin}</strong>{connection.repositorySelection === "selected" ? " (selected repositories)" : " (all repositories)"}. Contents read: <strong>{connection.permissions?.contents === "read" || connection.permissions?.contents === "write" ? "effective" : "required"}</strong>.</p>}
        {connection.status === "disconnect-pending" && <p>Disconnect is pending while active GitHub token work settles.</p>}
        {connection.status === "disconnected" && <p>GitHub access is disconnected. DevSpace has retained your projects and local work.</p>}
        {connection.status === "reconnect-pending" && <p>GitHub reconnect is pending. Complete the GitHub App installation flow to restore private read access.</p>}
        {connection.status === "installation-removed" && <p>GitHub no longer has this installation. Re-authorize the DevSpace GitHub App to restore access.</p>}
        {connection.status === "installation-suspended" && <p>The GitHub installation is suspended. Resolve that in GitHub, then reconnect.</p>}
        {connection.status === "permission-required" && <p>The GitHub installation needs metadata and Contents read permission before private access can resume.</p>}
        {connection.status === "repository-access-unavailable" && <p>The selected repository is no longer authorized by this GitHub installation.</p>}
        {connection.status === "transient-error" && <p>GitHub is temporarily unavailable. Try again later.</p>}
        {connected && connection.pendingAttempt !== null && connection.pendingAttempt !== undefined
          && connection.pendingAttempt.connectionId !== connection.connectionId
          && <p>A separate GitHub setup attempt is pending; this retained connection remains available.</p>}
        {connection.cleanupDegraded && <p className="error" role="alert">Token cleanup is degraded. New private Git minting is blocked until cleanup or expiry.</p>}
        {!connected && !reconnectable && connection.status !== "unconfigured" && <button type="button" disabled={loadingGithub || !agentReachable} onClick={() => void connectGithub()}>{connection.status === "failed" || connection.status === "pending" ? "Retry GitHub connection" : "Connect GitHub App"}</button>}
        {connection.status === "unconfigured" && <p>GitHub App access has not been configured by the administrator.</p>}
        {connected && <div className="github-actions"><button type="button" disabled={loadingGithub} onClick={() => void refreshGithub()}>Refresh GitHub access</button><button type="button" disabled={loadingGithub} onClick={() => void listRepositories()}>List authorized repositories</button><button type="button" disabled={loadingGithub} onClick={() => void disconnectGithub()}>Disconnect GitHub</button></div>}
        {reconnectable && <button type="button" disabled={loadingGithub || !agentReachable || connection.status === "disconnect-pending" || connection.status === "reconnect-pending"} onClick={() => void reconnectGithub()}>Reconnect GitHub App</button>}
        {repositories.length > 0 && <label>Authorized repository<select required value={selectedRepositoryId} onChange={(event) => { const repository = repositories.find((candidate) => candidate.repositoryId === event.target.value); if (repository !== undefined) chooseRepository(repository); }}><option value="">Select a repository</option>{repositories.map((repository) => <option key={repository.repositoryId} value={repository.repositoryId} disabled={repository.archived || repository.disabled}>{repository.fullName}{repository.archived ? " · archived" : repository.disabled ? " · disabled" : ""}</option>)}</select></label>}
        {continuation !== null && <button type="button" disabled={loadingGithub} onClick={() => void listRepositories(continuation)}>Load more repositories</button>}
        {selected !== undefined && <p>Selected <strong>{selected.fullName}</strong>; authority is retained by its immutable GitHub repository ID.</p>}
      </section>}
    <div className="form-row"><label>Project name<input name="name" required maxLength={100} value={name.value} onChange={(event) => setName({ value: event.target.value, source: "user" })} /></label><label>Project slug<input name="slug" required maxLength={64} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={slug.value} onChange={(event) => setSlug({ value: event.target.value, source: "user" })} /></label></div>
    <label>Default branch <small>optional override</small><input name="defaultBranch" placeholder="Detected from repository" value={branch.value} onChange={(event) => setBranch({ value: event.target.value, source: "user" })} /></label>
    <button type="submit" disabled={submitting || !agentReachable || (sourceKind === "github-app" && (!connected || selectedRepositoryId === ""))}>{submitting ? "Registering…" : sourceKind === "remote" ? "Inspect and register" : "Register project"}</button>
    {!agentReachable && <p className="message error">Start the DevSpace Agent before adding a project.</p>}
    {message !== "" && <p className={`message ${message.includes("pending") ? "success" : ""}`} role="status">{message}</p>}
  </form>;
}
