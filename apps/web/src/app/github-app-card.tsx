"use client";

import { useCallback, useEffect, useState } from "react";

type Connection = { status: string; accountLogin?: string; accountId?: string; accountType?: string; repositorySelection?: string; cleanupDegraded?: boolean };
type Repository = { repositoryId: string; fullName: string; defaultBranch: string; private: boolean; archived: boolean; disabled: boolean };

export function GithubAppCard() {
  const [connection, setConnection] = useState<Connection>({ status: "pending" });
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [continuation, setContinuation] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const loadConnection = useCallback(async () => {
    setBusy(true);
    try { setConnection(await (await fetch("/api/integrations/github/connection", { cache: "no-store" })).json() as Connection); }
    catch { setConnection({ status: "failed" }); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { loadConnection().catch(() => undefined); }, [loadConnection]);
  const connect = async () => {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/integrations/github/connection-attempts", { method: "POST",
        headers: { Origin: window.location.origin, "X-DevSpace-CSRF": "1" } });
      const body = await response.json() as { installationUrl?: string; message?: string };
      if (!response.ok || body.installationUrl === undefined) throw new Error(body.message ?? "Connection could not be started.");
      window.location.assign(body.installationUrl);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Connection could not be started."); setBusy(false); }
  };
  const list = async (next?: string) => {
    setBusy(true); setMessage(null);
    try {
      const query = new URLSearchParams({ pageSize: "25", ...(next === undefined ? {} : { continuation: next }) });
      const response = await fetch(`/api/integrations/github/repositories?${query}`, { cache: "no-store" });
      const body = await response.json() as { repositories?: Repository[]; continuation?: string | null; cleanupDegraded?: boolean; message?: string };
      if (!response.ok || body.repositories === undefined) throw new Error(body.message ?? "Repositories could not be listed.");
      setRepositories(next === undefined ? body.repositories : [...repositories, ...body.repositories]);
      setContinuation(body.continuation ?? null);
      if (body.cleanupDegraded) setConnection((current) => ({ ...current, status: "degraded", cleanupDegraded: true }));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Repositories could not be listed."); }
    finally { setBusy(false); }
  };
  const connected = connection.status === "connected" || connection.status === "degraded";
  return <section className="form-card github-card" aria-labelledby="github-heading">
    <div className="section-heading"><div><h2 id="github-heading">Private GitHub repositories</h2>
      <p>GitHub App access for the administrator-configured account.</p></div>
      <span className={`github-state github-${connection.status}`} role="status">{busy ? "Loading" : connection.status}</span>
    </div>
    {connected && <p>Verified {connection.accountType} <strong>{connection.accountLogin}</strong> <code>{connection.accountId}</code>
      {connection.repositorySelection === "selected" ? " (selected repositories)" : " (all repositories)"}.</p>}
    {connection.cleanupDegraded && <p className="error" role="alert">Token cleanup is degraded. New token minting is blocked until cleanup or expiry.</p>}
    {!connected && connection.status !== "unconfigured" && <button type="button" disabled={busy} onClick={() => void connect()}>
      {connection.status === "failed" || connection.status === "pending" ? "Retry GitHub connection" : "Connect GitHub App"}
    </button>}
    {connection.status === "unconfigured" && <p>GitHub App access has not been configured by the administrator.</p>}
    {connected && repositories.length === 0 && <button type="button" disabled={busy} onClick={() => void list()}>List authorized repositories</button>}
    {repositories.length > 0 && <div><ul className="github-repositories">{repositories.map((repository) => <li key={repository.repositoryId}>
      <strong>{repository.fullName}</strong> <code>{repository.defaultBranch}</code>
      <span>{repository.private ? "Private" : "Public"}{repository.archived ? " · Archived" : ""}{repository.disabled ? " · Disabled" : ""}</span>
    </li>)}</ul>{continuation !== null && <button type="button" disabled={busy} onClick={() => void list(continuation)}>Load more</button>}</div>}
    {message !== null && <p className="error" role="alert">{message}</p>}
  </section>;
}
