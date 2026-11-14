import { aiTabId, editorTab, previewTabId, projectOptionsTab, terminalTabId, type WorkbenchTab, type WorkbenchTabState } from "./workbench-tabs.js";
import { isTerminalOpenableState } from "./terminal-lifecycle.js";

const STORAGE_VERSION = 1;

export function workbenchTabStorageKey(projectId: string, workspaceId: string): string {
  return `devspace:workbench-tab:v${STORAGE_VERSION}:${encodeURIComponent(projectId)}:${encodeURIComponent(workspaceId)}`;
}

export function serializeActiveWorkbenchTab(projectId: string, workspaceId: string, state: WorkbenchTabState): string | null {
  const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId);
  if (tab === undefined) return null;
  return JSON.stringify({ version: STORAGE_VERSION, projectId, workspaceId, tab });
}

export function restoreActiveWorkbenchTab(raw: string | null, projectId: string, workspaceId: string,
  terminals: readonly { readonly id: string; readonly state: string; readonly title: string }[],
  previews: readonly { readonly id: string }[]): WorkbenchTabState | null {
  if (raw === null || raw.length > 4096) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== STORAGE_VERSION || record.projectId !== projectId || record.workspaceId !== workspaceId
    || typeof record.tab !== "object" || record.tab === null) return null;
  const tab = record.tab as Record<string, unknown>;
  let valid: WorkbenchTab | null = null;
  if (tab.kind === "ai" && tab.sessionId === workspaceId && tab.id === aiTabId(workspaceId)) {
    valid = { id: aiTabId(workspaceId), kind: "ai", sessionId: workspaceId };
  } else if (tab.kind === "project-options" && tab.id === "project-options") {
    valid = projectOptionsTab();
  } else if (tab.kind === "terminal" && typeof tab.terminalId === "string") {
    const terminal = terminals.find((item) => item.id === tab.terminalId && isTerminalOpenableState(item.state));
    if (terminal !== undefined && tab.id === terminalTabId(terminal.id)) {
      valid = { id: terminalTabId(terminal.id), kind: "terminal", terminalId: terminal.id, title: terminal.title };
    }
  } else if (tab.kind === "preview" && typeof tab.previewId === "string") {
    const preview = previews.find((item) => item.id === tab.previewId);
    if (preview !== undefined && tab.id === previewTabId(preview.id)) valid = { id: previewTabId(preview.id), kind: "preview", previewId: preview.id };
  } else if (tab.kind === "editor" && typeof tab.fileId === "string" && tab.id === editorTab(tab.fileId).id) {
    // The editor re-reads the saved workspace file on mount. Only its path crosses refresh.
    valid = editorTab(tab.fileId);
  }
  return valid === null ? null : { tabs: [valid], activeTabId: valid.id };
}
