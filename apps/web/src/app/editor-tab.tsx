"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OnMount } from "@monaco-editor/react";
import type { GitDiffData } from "@devspace/contracts";
import { EDITOR_SAVED_STATUS_DURATION_MS, editorLanguageForPath, markEditorConflict, markEditorSaved, type EditorDocument, updateEditorContent } from "./editor-state.js";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => <div className="editor-tab-message">Loading editor…</div>
});
const MonacoDiffEditor = dynamic(async () => (await import("@monaco-editor/react")).DiffEditor, {
  ssr: false,
  loading: () => <div className="editor-tab-message">Loading diff editor…</div>
});

type ApiFailure = { readonly code?: string; readonly message?: string };

export function EditorTab({ projectId, path, active, tabId, mode, diffKind, onModeChange, onDirtyChange, onSaved }: {
  projectId: string;
  workspaceId: string;
  path: string;
  active: boolean;
  tabId: string;
  mode: "edit" | "changes";
  diffKind: "staged" | "unstaged";
  onModeChange: (mode: "edit" | "changes") => void;
  onDirtyChange: (tabId: string, dirty: boolean) => void;
  onSaved?: () => void;
}) {
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitDiffData | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const documentRef = useRef<EditorDocument | null>(null);
  const saveRef = useRef<(() => Promise<void>) | null>(null);
  const savingRef = useRef(false);
  const savedTimer = useRef<number | null>(null);

  documentRef.current = document;

  useEffect(() => () => {
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
  }, []);

  const loadFile = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const query = new URLSearchParams({ action: "read", path });
      const response = await fetch(`/api/projects/${projectId}/files?${query.toString()}`, { cache: "no-store" });
      const body = await response.json() as { path?: string; content?: string; revision?: string; message?: string };
      if (!response.ok || typeof body.content !== "string" || typeof body.revision !== "string") {
        throw new Error(body.message ?? "The file could not be opened.");
      }
      setDocument({ path: body.path ?? path, content: body.content, savedContent: body.content, revision: body.revision, dirty: false, conflict: null });
    } catch (loadError) {
      setDocument(null);
      setError(loadError instanceof Error ? loadError.message : "The file could not be opened.");
    } finally {
      setLoading(false);
    }
  }, [path, projectId]);

  useEffect(() => {
    if (mode === "edit") loadFile().catch(() => undefined);
  }, [loadFile, mode]);
  useEffect(() => {
    if (mode !== "changes") return;
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    setDiff(null);
    const query = new URLSearchParams({ path, kind: diffKind });
    fetch(`/api/projects/${projectId}/changes/diff?${query.toString()}`, { cache: "no-store" }).then(async (response) => {
      const body = await response.json() as GitDiffData & { message?: string };
      if (!response.ok) throw new Error(body.message ?? "The diff could not be loaded.");
      if (!cancelled) setDiff(body);
    }).catch((diffLoadError) => {
      if (!cancelled) setDiffError(diffLoadError instanceof Error ? diffLoadError.message : "The diff could not be loaded.");
    }).finally(() => { if (!cancelled) setDiffLoading(false); });
    return () => { cancelled = true; };
  }, [diffKind, mode, path, projectId]);
  useEffect(() => { onDirtyChange(tabId, document?.dirty ?? false); }, [document?.dirty, onDirtyChange, tabId]);

  const save = useCallback(async () => {
    const current = documentRef.current;
    if (current === null || !current.dirty || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setStatus("Saving…");
    try {
      const response = await fetch(`/api/projects/${projectId}/files`, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: window.location.origin, "x-devspace-csrf": "1" },
        body: JSON.stringify({ action: "save", path: current.path, content: current.content, expectedRevision: current.revision })
      });
      const body = await response.json() as ApiFailure & { revision?: string };
      if (!response.ok || typeof body.revision !== "string") {
        if (response.status === 409 || body.code === "WORKSPACE_FILE_CHANGED") {
          setDocument((latest) => latest === null ? latest : markEditorConflict(latest,
            body.message ?? "This file changed outside the editor. Reload it before trying again."));
          setStatus(null);
        } else {
          setStatus(body.message ?? "The file could not be saved.");
        }
        return;
      }
      setDocument((latest) => latest === null ? latest : markEditorSaved(latest, body.revision as string));
      setStatus("Saved");
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => { setStatus(null); savedTimer.current = null; }, EDITOR_SAVED_STATUS_DURATION_MS);
      onSaved?.();
    } catch {
      setStatus("Save failed. Check that the Agent is reachable and try again.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [onSaved, projectId]);
  saveRef.current = save;

  const onMount = useCallback<OnMount>((editor, monaco) => {
    const keyboard = monaco as unknown as { readonly KeyMod: { readonly CtrlCmd: number }; readonly KeyCode: { readonly KeyS: number } };
    editor.addCommand(keyboard.KeyMod.CtrlCmd | keyboard.KeyCode.KeyS, () => { saveRef.current?.().catch(() => undefined); });
  }, []);

  return <section className={`editor-tab-surface ${active ? "" : "is-inactive"}`} aria-label={`Editor for ${path}`} aria-hidden={!active}>
    <header className="editor-tab-header">
      <div className="editor-tab-identity"><strong>{path.split("/").at(-1) ?? path}</strong><span>{path}</span></div>
      <div className="editor-tab-actions">
        <div className="editor-mode-toggle" role="group" aria-label="File view mode">
          <button type="button" className={mode === "edit" ? "selected" : ""} onClick={() => onModeChange("edit")}>Edit</button>
          <button type="button" className={mode === "changes" ? "selected" : ""} onClick={() => onModeChange("changes")}>Changes</button>
        </div>
        {mode === "changes" && <span className="editor-diff-kind">{diffKind === "staged" ? "Staged · HEAD → index" : "Unstaged · index → worktree"}</span>}
        {document?.dirty && <span className="editor-dirty-label">Unsaved changes</span>}
        {status !== null && <span className="editor-save-status" role="status">{status}</span>}
        {mode === "edit" && <button type="button" className="editor-save-button" disabled={document === null || !document.dirty || saving} onClick={() => { save().catch(() => undefined); }}>
          {saving ? "Saving…" : "Save"}
        </button>}
      </div>
    </header>
    {document !== null && document.conflict !== null && <div className="editor-tab-conflict" role="alert">
      <span>{document.conflict}</span><button type="button" onClick={() => { loadFile().catch(() => undefined); }}>Reload from workspace</button>
    </div>}
    {mode === "changes" ? diffLoading ? <div className="editor-tab-message">Reviewing changes for {path}…</div> : diffError !== null ? <div className="editor-tab-message error" role="alert">
      <p>{diffError}</p><button type="button" onClick={() => onModeChange("edit")}>Open in Edit mode</button>
    </div> : diff?.available === false ? <div className="editor-tab-message" role="status">
      <p>Diff not available for this file ({diff.reason}).</p><button type="button" onClick={() => onModeChange("edit")}>Open in Edit mode</button>
    </div> : diff?.available === true ? <div className="editor-tab-content">
      <MonacoDiffEditor height="100%" width="100%" language={editorLanguageForPath(path)} theme="vs-dark"
        original={diff.oldContent} modified={diff.newContent} options={{ automaticLayout: true, fontSize: 13, minimap: { enabled: false }, padding: { top: 8 }, scrollBeyondLastLine: false, wordWrap: "on" }} />
    </div> : null : loading ? <div className="editor-tab-message">Opening {path}…</div> : error !== null ? <div className="editor-tab-message error" role="alert">
      <p>{error}</p><button type="button" onClick={() => { loadFile().catch(() => undefined); }}>Retry</button>
    </div> : document !== null ? <div className="editor-tab-content">
      <MonacoEditor height="100%" width="100%" language={editorLanguageForPath(path)} theme="vs-dark" value={document.content} onMount={onMount}
        onChange={(value) => { if (value !== undefined) setDocument((current) => current === null ? current : updateEditorContent(current, value)); }}
        options={{ automaticLayout: true, fontSize: 13, minimap: { enabled: false }, padding: { top: 8 }, scrollBeyondLastLine: false, wordWrap: "on" }} />
    </div> : null}
  </section>;
}
