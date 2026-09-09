"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OnMount } from "@monaco-editor/react";
import { editorLanguageForPath, markEditorConflict, markEditorSaved, type EditorDocument, updateEditorContent } from "./editor-state.js";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => <div className="editor-tab-message">Loading editor…</div>
});

type ApiFailure = { readonly code?: string; readonly message?: string };

export function EditorTab({ projectId, path, active, tabId, onDirtyChange }: {
  projectId: string;
  workspaceId: string;
  path: string;
  active: boolean;
  tabId: string;
  onDirtyChange: (tabId: string, dirty: boolean) => void;
}) {
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const documentRef = useRef<EditorDocument | null>(null);
  const saveRef = useRef<(() => Promise<void>) | null>(null);
  const savingRef = useRef(false);

  documentRef.current = document;

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

  useEffect(() => { loadFile().catch(() => undefined); }, [loadFile]);
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
    } catch {
      setStatus("Save failed. Check that the Agent is reachable and try again.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [projectId]);
  saveRef.current = save;

  const onMount = useCallback<OnMount>((editor, monaco) => {
    const keyboard = monaco as unknown as { readonly KeyMod: { readonly CtrlCmd: number }; readonly KeyCode: { readonly KeyS: number } };
    editor.addCommand(keyboard.KeyMod.CtrlCmd | keyboard.KeyCode.KeyS, () => { saveRef.current?.().catch(() => undefined); });
  }, []);

  return <section className={`editor-tab-surface ${active ? "" : "is-inactive"}`} aria-label={`Editor for ${path}`} aria-hidden={!active}>
    <header className="editor-tab-header">
      <div className="editor-tab-identity"><strong>{path.split("/").at(-1) ?? path}</strong><span>{path}</span></div>
      <div className="editor-tab-actions">
        {document?.dirty && <span className="editor-dirty-label">Unsaved changes</span>}
        {status !== null && <span className="editor-save-status">{status}</span>}
        <button type="button" className="editor-save-button" disabled={document === null || !document.dirty || saving} onClick={() => { save().catch(() => undefined); }}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </header>
    {document !== null && document.conflict !== null && <div className="editor-tab-conflict" role="alert">
      <span>{document.conflict}</span><button type="button" onClick={() => { loadFile().catch(() => undefined); }}>Reload from workspace</button>
    </div>}
    {loading ? <div className="editor-tab-message">Opening {path}…</div> : error !== null ? <div className="editor-tab-message error" role="alert">
      <p>{error}</p><button type="button" onClick={() => { loadFile().catch(() => undefined); }}>Retry</button>
    </div> : document !== null ? <div className="editor-tab-content">
      <MonacoEditor height="100%" width="100%" language={editorLanguageForPath(path)} theme="vs-dark" value={document.content} onMount={onMount}
        onChange={(value) => { if (value !== undefined) setDocument((current) => current === null ? current : updateEditorContent(current, value)); }}
        options={{ automaticLayout: true, fontSize: 13, minimap: { enabled: false }, padding: { top: 8 }, scrollBeyondLastLine: false, wordWrap: "on" }} />
    </div> : null}
  </section>;
}
