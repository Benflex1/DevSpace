"use client";

import { useState } from "react";
import {
  previewPresentationLabel, previewPresentationState, previewStateMessage, previewUrl, type PreviewLifecycleView
} from "./preview-lifecycle.js";

export function PreviewTab({ preview, active, onReload }: {
  preview: PreviewLifecycleView;
  active: boolean;
  onReload: (previewId: string) => Promise<void>;
}) {
  const [reloading, setReloading] = useState(false);
  const state = previewPresentationState(preview);
  const url = previewUrl(preview.hostname);
  const reload = async () => {
    if (reloading) return;
    setReloading(true);
    try { await onReload(preview.id); } finally { setReloading(false); }
  };

  return <section className={`preview-tab-surface ${active ? "is-active" : "is-inactive"}`} aria-hidden={!active}
    aria-label={`${preview.displayName} preview`} role={active ? "region" : undefined}>
    <header className="preview-tab-header">
      <div><strong>{preview.displayName}</strong><span className={`preview-state ${state}`}>{previewPresentationLabel(preview)}</span></div>
      <div className="preview-tab-actions">
        <button type="button" onClick={() => { reload().catch(() => undefined); }} disabled={reloading || state === "inactive"}
          title={state === "inactive" ? "Start the workspace runtime before reconciling this preview" : "Reconcile this preview route"}>
          {reloading ? "Reloading…" : "Reload"}
        </button>
        <a href={url} target="_blank" rel="noreferrer">Open Externally</a>
      </div>
    </header>
    <p className="preview-hostname"><code>{preview.hostname}</code></p>
    {state === "ready" && active ? <iframe className="preview-frame" src={url} title={`${preview.displayName} preview`} />
      : <div className={`preview-state-panel ${state}`}><span className="preview-state-glyph" aria-hidden="true">{state === "waiting" ? "○" : "!"}</span>
        <h2>{previewPresentationLabel(preview)}</h2><p>{previewStateMessage(preview)}</p>
        {state === "unavailable" && <p className="preview-embed-help">The application controls its own CSP and frame policy. Open Externally remains available.</p>}
      </div>}
  </section>;
}
