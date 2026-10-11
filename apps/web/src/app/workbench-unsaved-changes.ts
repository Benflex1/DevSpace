import type { EditorDocument } from "./editor-state.js";

export const WORKBENCH_LEAVE_CONFIRMATION = "Leave this Workbench and discard its unsaved editor changes?";

export function confirmWorkbenchLeave(hasUnsavedChanges: boolean, confirm: (message: string) => boolean): boolean {
  return !hasUnsavedChanges || confirm(WORKBENCH_LEAVE_CONFIRMATION);
}

export function confirmEditorReload(document: EditorDocument | null, confirm: (message: string) => boolean): boolean {
  return document === null || !document.dirty || confirm(`Reload ${document.path} from the workspace and discard its unsaved changes?`);
}

type BeforeUnloadListener = (event: BeforeUnloadEvent) => void;
type BeforeUnloadTarget = {
  addEventListener(type: "beforeunload", listener: BeforeUnloadListener): void;
  removeEventListener(type: "beforeunload", listener: BeforeUnloadListener): void;
};

export function registerBeforeUnloadGuard(target: BeforeUnloadTarget, hasUnsavedChanges: () => boolean,
  leaveConfirmed: () => boolean = () => false): () => void {
  const onBeforeUnload: BeforeUnloadListener = (event) => {
    if (!hasUnsavedChanges() || leaveConfirmed()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  target.addEventListener("beforeunload", onBeforeUnload);
  return () => target.removeEventListener("beforeunload", onBeforeUnload);
}
