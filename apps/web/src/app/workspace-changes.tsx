"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { GitInspectionData, GitStatusEntry } from "@devspace/contracts";
import { gitChangeMarker, groupGitChanges } from "./workspace-changes-state.js";

export interface GitCommitFormInput {
  readonly message: string;
  readonly userName?: string;
  readonly userEmail?: string;
}

export function WorkspaceChanges({ status, loading, error, agentReachable, busyAction, onRefresh, onOpenFile, onStage, onUnstage, onCommit }: {
  status: GitInspectionData | null;
  loading: boolean;
  error: string | null;
  agentReachable: boolean;
  busyAction: string | null;
  onRefresh: () => void;
  onOpenFile: (path: string, kind: "staged" | "unstaged") => void;
  onStage: (path: string) => Promise<boolean>;
  onUnstage: (path: string) => Promise<boolean>;
  onCommit: (input: GitCommitFormInput) => Promise<boolean>;
}) {
  const groups = groupGitChanges(status);
  const name = status?.identity.name ?? null;
  const email = status?.identity.email ?? null;
  const hasStaged = groups.staged.length > 0;
  return <section className="sidebar-section changes-sidebar-section" aria-labelledby="changes-heading">
    <div className="sidebar-section-heading"><h2 id="changes-heading">Changes</h2><button type="button" className="icon-button" onClick={onRefresh} aria-label="Refresh Git changes">↻</button></div>
    {status !== null && <div className="git-context"><code>{status.branchName ?? "detached HEAD"}</code><span>{status.aheadCount} ahead · {status.behindCount} behind</span></div>}
    {loading && <p className="sidebar-empty">Inspecting Git status…</p>}
    {!loading && error !== null && <p className="sidebar-empty changes-error" role="alert">{error}<button type="button" className="file-tree-retry" onClick={onRefresh}>Retry</button></p>}
    {!loading && error === null && !agentReachable && <p className="sidebar-empty">The Agent is unavailable.</p>}
    {!loading && error === null && agentReachable && status !== null && groups.changes.length === 0 && groups.staged.length === 0 && <p className="sidebar-empty">Working tree clean.</p>}
    {groups.changes.length > 0 && <GitChangeGroup title="Changes" entries={groups.changes} staged={false} busyAction={busyAction} agentReachable={agentReachable} onOpenFile={onOpenFile} onAction={onStage} />}
    {groups.staged.length > 0 && <GitChangeGroup title="Staged Changes" entries={groups.staged} staged busyAction={busyAction} agentReachable={agentReachable} onOpenFile={onOpenFile} onAction={onUnstage} />}
    <CommitBox status={status} hasStaged={hasStaged} agentReachable={agentReachable} busyAction={busyAction} onCommit={onCommit} name={name} email={email} />
    {status !== null && <p className="git-flow-hint">Fetch and Push are available in the top bar.</p>}
  </section>;
}

function GitChangeGroup({ title, entries, staged, busyAction, agentReachable, onOpenFile, onAction }: {
  title: string; entries: readonly GitStatusEntry[]; staged: boolean; busyAction: string | null; agentReachable: boolean;
  onOpenFile: (path: string, kind: "staged" | "unstaged") => void; onAction: (path: string) => Promise<boolean>;
}) {
  return <div className="git-change-group">
    <div className="git-change-group-heading"><h3>{title}</h3><span>{entries.length}</span></div>
    <ul className="git-change-list">
      {entries.map((entry) => <li key={`${staged ? "staged" : "changes"}:${entry.path}`}>
        <button type="button" className="git-change-file" onClick={() => onOpenFile(entry.path, staged ? "staged" : "unstaged")} title={`Review ${entry.path}`}>
          <code className={`git-change-marker ${entry.classification}`}>{gitChangeMarker(entry, staged)}</code><span>{entry.path}</span>
        </button>
        <button type="button" className="git-change-action" disabled={!agentReachable || busyAction !== null} onClick={() => { onAction(entry.path).catch(() => undefined); }}>
          {busyAction === `${staged ? "unstage" : "stage"}:${entry.path}` ? "…" : staged ? "Unstage" : "Stage"}
        </button>
      </li>)}
    </ul>
  </div>;
}

function CommitBox({ status, hasStaged, agentReachable, busyAction, onCommit, name, email }: {
  status: GitInspectionData | null; hasStaged: boolean; agentReachable: boolean; busyAction: string | null;
  onCommit: (input: GitCommitFormInput) => Promise<boolean>; name: string | null; email: string | null;
}) {
  const [message, setMessage] = useState("");
  const [userName, setUserName] = useState(name ?? "");
  const [userEmail, setUserEmail] = useState(email ?? "");
  useEffect(() => { if (name !== null) setUserName(name); }, [name]);
  useEffect(() => { if (email !== null) setUserEmail(email); }, [email]);
  const needsIdentity = name === null || email === null;
  const disabled = !agentReachable || !hasStaged || message.trim() === "" || busyAction !== null || status === null || (needsIdentity && (userName.trim() === "" || userEmail.trim() === ""));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled) return;
    const succeeded = await onCommit({ message, ...(needsIdentity ? { userName: userName.trim(), userEmail: userEmail.trim() } : {}) });
    if (succeeded) setMessage("");
  };
  return <form className="git-commit-box" onSubmit={(event) => { submit(event).catch(() => undefined); }}>
    <label htmlFor="git-commit-message">Commit message</label>
    <textarea id="git-commit-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Describe the staged changes…" rows={3} maxLength={65_536} />
    {needsIdentity ? <div className="git-identity-fields">
      <label><span>Name</span><input value={userName} onChange={(event) => setUserName(event.target.value)} maxLength={512} autoComplete="name" /></label>
      <label><span>Email</span><input type="email" value={userEmail} onChange={(event) => setUserEmail(event.target.value)} maxLength={512} autoComplete="email" /></label>
    </div> : <p className="git-identity-summary">Commit as <strong>{name}</strong> &lt;{email}&gt;</p>}
    <button type="submit" className="git-commit-button" disabled={disabled}>{busyAction === "commit" ? "Committing…" : "Commit staged"}</button>
    {status !== null && !hasStaged && <p className="git-commit-help">Stage at least one file to commit.</p>}
  </form>;
}
