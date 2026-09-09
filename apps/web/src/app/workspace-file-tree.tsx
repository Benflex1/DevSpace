"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkspaceFileEntry } from "@devspace/contracts";

type DirectoryState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly entries: readonly WorkspaceFileEntry[] }
  | { readonly status: "error"; readonly message: string };

export function WorkspaceFileTree({ projectId, agentReachable, onOpenFile }: {
  projectId: string;
  workspaceId: string;
  agentReachable: boolean;
  onOpenFile: (relativePath: string) => void;
}) {
  const [directories, setDirectories] = useState<ReadonlyMap<string, DirectoryState>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set([""]));

  const loadDirectory = useCallback(async (path: string) => {
    if (!agentReachable) return;
    setDirectories((current) => new Map(current).set(path, { status: "loading" }));
    try {
      const query = new URLSearchParams({ action: "list", path });
      const response = await fetch(`/api/projects/${projectId}/files?${query.toString()}`, { cache: "no-store" });
      const body = await response.json() as { entries?: WorkspaceFileEntry[]; message?: string };
      if (!response.ok || !Array.isArray(body.entries)) {
        throw new Error(body.message ?? "The directory could not be loaded.");
      }
      setDirectories((current) => new Map(current).set(path, { status: "ready", entries: body.entries ?? [] }));
    } catch (error) {
      setDirectories((current) => new Map(current).set(path, {
        status: "error", message: error instanceof Error ? error.message : "The directory could not be loaded."
      }));
    }
  }, [agentReachable, projectId]);

  useEffect(() => {
    if (agentReachable && directories.get("") === undefined) loadDirectory("").catch(() => undefined);
  }, [agentReachable, directories, loadDirectory]);

  const toggleDirectory = (path: string) => {
    const state = directories.get(path);
    if (state?.status === "loading") return;
    if (state?.status === "ready") {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path); else next.add(path);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(path));
    loadDirectory(path).catch(() => undefined);
  };

  return <div className="workspace-file-tree" aria-label="Workspace files">
    {!agentReachable ? <p className="file-tree-state">Agent unavailable. Files will return when it reconnects.</p> :
      <ul className="file-tree-root"><TreeDirectory path="" name="Workspace" depth={0} state={directories.get("")} expanded={expanded.has("")}
        onToggle={toggleDirectory} onOpenFile={onOpenFile} onRetry={(path) => { loadDirectory(path).catch(() => undefined); }} directories={directories} expandedPaths={expanded} /></ul>}
  </div>;
}

function TreeDirectory({ path, name, depth, state, expanded, onToggle, onOpenFile, onRetry, directories, expandedPaths }: {
  path: string;
  name: string;
  depth: number;
  state: DirectoryState | undefined;
  expanded: boolean;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onRetry: (path: string) => void;
  directories: ReadonlyMap<string, DirectoryState>;
  expandedPaths: ReadonlySet<string>;
}) {
  return <li className="file-tree-directory">
    <button type="button" className="file-tree-entry file-tree-directory-button" style={{ paddingLeft: `${8 + depth * 14}px` }}
      onClick={() => onToggle(path)} aria-expanded={expanded} title={expanded ? `Collapse ${name}` : `Expand ${name}`}>
      <span className="file-tree-chevron" aria-hidden="true">{expanded ? "⌄" : "›"}</span>
      <span className="file-tree-icon" aria-hidden="true">▰</span><span>{name}</span>
    </button>
    {expanded && <DirectoryContents path={path} depth={depth} state={state} onOpenFile={onOpenFile} onRetry={onRetry}
      directories={directories} expandedPaths={expandedPaths} onToggle={onToggle} />}
  </li>;
}

function DirectoryContents({ path, depth, state, onOpenFile, onRetry, directories, expandedPaths, onToggle }: {
  path: string;
  depth: number;
  state: DirectoryState | undefined;
  onOpenFile: (path: string) => void;
  onRetry: (path: string) => void;
  directories: ReadonlyMap<string, DirectoryState>;
  expandedPaths: ReadonlySet<string>;
  onToggle: (path: string) => void;
}) {
  if (state === undefined || state.status === "loading") return <p className="file-tree-state nested" style={{ paddingLeft: `${32 + depth * 14}px` }}>Loading…</p>;
  if (state.status === "error") return <p className="file-tree-state nested" style={{ paddingLeft: `${32 + depth * 14}px` }}>
    <span>{state.message}</span><button type="button" className="file-tree-retry" onClick={() => onRetry(path)}>Retry</button>
  </p>;
  if (state.entries.length === 0) return <p className="file-tree-state nested" style={{ paddingLeft: `${32 + depth * 14}px` }}>Empty directory</p>;
  return <ul className="file-tree-children">
    {state.entries.map((entry) => entry.kind === "directory" ?
      <TreeDirectory key={entry.path} path={entry.path} name={entry.name} depth={depth + 1} state={directories.get(entry.path)}
        expanded={expandedPaths.has(entry.path)} onToggle={onToggle} onOpenFile={onOpenFile} onRetry={onRetry}
        directories={directories} expandedPaths={expandedPaths} /> :
      <li key={entry.path}><button type="button" className="file-tree-entry file-tree-file-button" style={{ paddingLeft: `${22 + (depth + 1) * 14}px` }}
        onClick={() => onOpenFile(entry.path)} title={`Open ${entry.path}`}><span className="file-tree-chevron" aria-hidden="true" />
        <span className="file-tree-icon file-icon" aria-hidden="true">▤</span><span>{entry.name}</span></button></li>)}
  </ul>;
}
