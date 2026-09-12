"use client";

import { useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import { disposeDiffEditorResources } from "./monaco-model-lifecycle.js";
import { loadMonaco } from "./monaco-runtime.js";

export function MonacoDiffEditor({ original, modified, language, theme, originalModelPath, modifiedModelPath, options, height = "100%", width = "100%" }: {
  readonly original: string;
  readonly modified: string;
  readonly language: string;
  readonly theme: string;
  readonly originalModelPath: string;
  readonly modifiedModelPath: string;
  readonly options?: Monaco.editor.IStandaloneDiffEditorConstructionOptions;
  readonly height?: string | number;
  readonly width?: string | number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let resources: {
      readonly widget: Monaco.editor.IStandaloneDiffEditor;
      readonly original: Monaco.editor.ITextModel;
      readonly modified: Monaco.editor.ITextModel;
    } | null = null;
    setError(null);

    void loadMonaco().then((monaco) => {
      if (cancelled || containerRef.current === null) return;
      let originalModel: Monaco.editor.ITextModel | null = null;
      let modifiedModel: Monaco.editor.ITextModel | null = null;
      let widget: Monaco.editor.IStandaloneDiffEditor | null = null;
      try {
        originalModel = monaco.editor.createModel(original, language, monaco.Uri.parse(originalModelPath));
        modifiedModel = monaco.editor.createModel(modified, language, monaco.Uri.parse(modifiedModelPath));
        widget = monaco.editor.createDiffEditor(containerRef.current, { ...options, automaticLayout: true });
        widget.setModel({ original: originalModel, modified: modifiedModel });
        monaco.editor.setTheme(theme);
        resources = { widget, original: originalModel, modified: modifiedModel };
      } catch (creationError) {
        if (widget !== null && originalModel !== null && modifiedModel !== null) {
          disposeDiffEditorResources(widget, [originalModel, modifiedModel]);
        } else {
          originalModel?.dispose();
          modifiedModel?.dispose();
        }
        throw creationError;
      }
    }).catch((loadError: unknown) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : "The diff editor could not be initialized.");
    });

    return () => {
      cancelled = true;
      const current = resources;
      resources = null;
      if (current !== null) disposeDiffEditorResources(current.widget, [current.original, current.modified]);
    };
  }, [language, modified, modifiedModelPath, options, original, originalModelPath, theme]);

  return <div ref={containerRef} data-devspace-diff-editor style={{ height, width, position: "relative" }}>
    {error !== null && <div className="editor-tab-message error" role="alert">{error}</div>}
  </div>;
}
