"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DiffOnMount, OnMount } from "@monaco-editor/react";
import type { GitDiffData } from "@devspace/contracts";
import { classifyDiffResult } from "./editor-diff-state.js";
import { emptyEditorFileLoadState, editorFileKey, requestExplicitEditorFileLoad, requestInitialEditorFileLoad, type EditorFileLoadState } from "./editor-file-lifecycle.js";
import { EDITOR_SAVED_STATUS_DURATION_MS, editorLanguageForPath, markEditorConflict, markEditorSaved, type EditorDocument, updateEditorContent } from "./editor-state.js";
import { editorViewVisibility } from "./editor-view-lifecycle.js";
import { disposeModelsAfterWidget } from "./monaco-model-lifecycle.js";
import { monacoModelPaths } from "./monaco-model-paths.js";
import { loadMonacoReact } from "./monaco-runtime.js";

const MonacoEditor = dynamic(() => loadMonacoReact().then(({ default: Editor }) => Editor), {
  ssr: false,
  loading: () => <div className="editor-tab-message">Loading editor…</div>
});
const MonacoDiffEditor = dynamic(() => loadMonacoReact().then(({ DiffEditor }) => DiffEditor), {
  ssr: false,
  loading: () => <div className="editor-tab-message">Loading diff editor…</div>
});

type ApiFailure = { readonly code?: string; readonly message?: string };

export function EditorTab({ projectId, workspaceId, path, active, tabId, mode, diffKind, onModeChange, onDirtyChange, onDiffNoLongerPresent, onSaved }: {
  projectId: string;
  workspaceId: string;
  path: string;
  active: boolean;
  tabId: string;
  mode: "edit" | "changes";
  diffKind: "staged" | "unstaged";
  onModeChange: (mode: "edit" | "changes") => void;
  onDirtyChange: (tabId: string, dirty: boolean) => void;
  onDiffNoLongerPresent?: (path: string) => void;
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
  const fileLoadStateRef = useRef<EditorFileLoadState>(emptyEditorFileLoadState);
  const saveRef = useRef<(() => Promise<void>) | null>(null);
  const savingRef = useRef(false);
  const savedTimer = useRef<number | null>(null);

  documentRef.current = document;

  useEffect(() => () => {
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
  }, []);

  const loadFile = useCallback(async (intent: "initial" | "retry" | "reload" = "initial") => {
    const fileKey = editorFileKey(projectId, path);
    const request = intent === "initial"
      ? requestInitialEditorFileLoad(fileLoadStateRef.current, fileKey)
      : requestExplicitEditorFileLoad(fileKey);
    if (!request.shouldLoad) return;
    fileLoadStateRef.current = request.state;
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

  useEffect(() => { loadFile("initial").catch(() => undefined); }, [loadFile]);
  useEffect(() => {
    if (mode !== "changes") return;
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    const query = new URLSearchParams({ path, kind: diffKind });
    fetch(`/api/projects/${projectId}/changes/diff?${query.toString()}`, { cache: "no-store" }).then(async (response) => {
      const body = await response.json() as GitDiffData & { message?: string };
      if (!response.ok) throw new Error(body.message ?? "The diff could not be loaded.");
      if (!cancelled) {
        setDiff(body);
        if (classifyDiffResult(body).kind === "no-longer-present") onDiffNoLongerPresent?.(path);
      }
    }).catch((diffLoadError) => {
      if (!cancelled) setDiffError(diffLoadError instanceof Error ? diffLoadError.message : "The diff could not be loaded.");
    }).finally(() => { if (!cancelled) setDiffLoading(false); });
    return () => { cancelled = true; };
  }, [diffKind, mode, onDiffNoLongerPresent, path, projectId]);
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
    const model = editor.getModel();
    if (model !== null) disposeModelsAfterWidget(editor, [model]);
  }, []);
  const onDiffMount = useCallback<DiffOnMount>((editor) => {
    const model = editor.getModel();
    if (model !== null) disposeModelsAfterWidget(editor, [model.original, model.modified]);
  }, []);
  const modelPaths = monacoModelPaths(workspaceId, path, diffKind);
  const diffPresentation = diff === null ? null : classifyDiffResult(diff);
  const viewVisibility = editorViewVisibility(mode);

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
      <span>{document.conflict}</span><button type="button" onClick={() => { loadFile("reload").catch(() => undefined); }}>Reload from workspace</button>
    </div>}
    <div className="editor-tab-view" hidden={viewVisibility.changesHidden}>
      {diffLoading && diff === null && <div className="editor-tab-message">Reviewing changes for {path}…</div>}
      {diffError !== null && <div className="editor-tab-message error" role="alert">
        <p>{diffError}</p><button type="button" onClick={() => onModeChange("edit")}>Open in Edit mode</button>
      </div>}
      {diffError === null && diffPresentation?.kind === "no-longer-present" && <div className="editor-tab-message" role="status">
        <p>{diffPresentation.message}</p><button type="button" onClick={() => onModeChange("edit")}>Open in Edit mode</button>
      </div>}
      {diffError === null && diffPresentation?.kind === "unavailable" && <div className="editor-tab-message" role="status">
        <p>{diffPresentation.message}</p><button type="button" onClick={() => onModeChange("edit")}>Open in Edit mode</button>
      </div>}
      {diffError === null && diff?.available === true && <div className="editor-tab-content">
        <MonacoDiffEditor height="100%" width="100%" language={editorLanguageForPath(path)} theme="vs-dark"
          key={modelPaths.diffOriginal}
          original={diff.oldContent} modified={diff.newContent} originalModelPath={modelPaths.diffOriginal} modifiedModelPath={modelPaths.diffModified}
          keepCurrentOriginalModel keepCurrentModifiedModel onMount={onDiffMount}
          options={{ automaticLayout: true, fontSize: 13, minimap: { enabled: false }, padding: { top: 8 }, scrollBeyondLastLine: false, wordWrap: "on" }} />
      </div>}
    </div>
    <div className="editor-tab-view" hidden={viewVisibility.editHidden}>
      {loading ? <div className="editor-tab-message">Opening {path}…</div> : error !== null ? <div className="editor-tab-message error" role="alert">
        <p>{error}</p><button type="button" onClick={() => { loadFile("retry").catch(() => undefined); }}>Retry</button>
      </div> : document !== null ? <div className="editor-tab-content">
        <MonacoEditor height="100%" width="100%" language={editorLanguageForPath(path)} theme="vs-dark" path={modelPaths.editable} keepCurrentModel value={document.content} onMount={onMount}
          onChange={(value) => { if (value !== undefined) setDocument((current) => current === null ? current : updateEditorContent(current, value)); }}
          options={{ automaticLayout: true, fontSize: 13, minimap: { enabled: false }, padding: { top: 8 }, scrollBeyondLastLine: false, wordWrap: "on" }} />
      </div> : null}
    </div>
  </section>;
}
