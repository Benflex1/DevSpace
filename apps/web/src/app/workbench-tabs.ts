export type WorkbenchTab =
  | { readonly id: `terminal:${string}`; readonly kind: "terminal"; readonly terminalId: string; readonly title: string }
  | { readonly id: string; readonly kind: "editor"; readonly fileId: string }
  | { readonly id: string; readonly kind: "preview"; readonly previewId: string }
  | { readonly id: string; readonly kind: "ai"; readonly sessionId: string }
  | { readonly id: string; readonly kind: "git"; readonly viewId: string }
  | { readonly id: string; readonly kind: "task-output"; readonly taskRunId: string };

export interface WorkbenchTabState {
  readonly tabs: readonly WorkbenchTab[];
  readonly activeTabId: string | null;
}

export const emptyWorkbenchTabs: WorkbenchTabState = { tabs: [], activeTabId: null };

export function terminalTabId(terminalId: string): `terminal:${string}` {
  return `terminal:${terminalId}`;
}

export function openWorkbenchTab(state: WorkbenchTabState, tab: WorkbenchTab): WorkbenchTabState {
  const existing = state.tabs.find((candidate) => candidate.id === tab.id);
  if (existing !== undefined) return { ...state, activeTabId: existing.id };
  return { tabs: [...state.tabs, tab], activeTabId: tab.id };
}

export function activateWorkbenchTab(state: WorkbenchTabState, tabId: string): WorkbenchTabState {
  return state.tabs.some((tab) => tab.id === tabId) ? { ...state, activeTabId: tabId } : state;
}

export function closeWorkbenchTab(state: WorkbenchTabState, tabId: string): WorkbenchTabState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (state.activeTabId !== tabId) return { tabs, activeTabId: state.activeTabId };
  const fallback = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, activeTabId: fallback?.id ?? null };
}

