"use client";

import { useState } from "react";
import type { BrowserAiTurn } from "./ai-session-projection.js";
import { AiSessionTab } from "./ai-session-tab.js";
import { HarnessSessionTab } from "./harness-session-tab.js";

export function AiWorkbenchTab({ projectId, workspaceId, active, onOpenChangedFile }: {
  projectId: string;
  workspaceId: string;
  active: boolean;
  onOpenChangedFile: (file: BrowserAiTurn["changedFiles"]["files"][number]) => void | Promise<void>;
}) {
  const [mode, setMode] = useState<"native" | "legacy">("native");
  return <div className="ai-workbench" hidden={!active}>
    <div className="ai-mode-switch" role="tablist" aria-label="AI presentation">
      <button type="button" role="tab" aria-selected={mode === "native"} onClick={() => setMode("native")}>Native</button>
      <button type="button" role="tab" aria-selected={mode === "legacy"} onClick={() => setMode("legacy")}>Legacy</button>
    </div>
    <div className="ai-mode-panel" hidden={mode !== "native"}>
      <HarnessSessionTab projectId={projectId} workspaceId={workspaceId} active={active && mode === "native"} />
    </div>
    <div className="ai-mode-panel" hidden={mode !== "legacy"}>
      <AiSessionTab projectId={projectId} workspaceId={workspaceId} active={active && mode === "legacy"} onOpenChangedFile={onOpenChangedFile} />
    </div>
  </div>;
}
