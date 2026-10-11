import { expect, test, vi } from "vitest";
import { editorDocumentKey, WorkbenchEditorDocuments } from "./workbench-editor-documents.js";
import { confirmEditorReload, confirmWorkbenchLeave, registerBeforeUnloadGuard } from "./workbench-unsaved-changes.js";

function loadDocument(documents: WorkbenchEditorDocuments, workspaceId: string, path: string): string {
  const key = editorDocumentKey(workspaceId, path);
  documents.ensure(key, path);
  const request = documents.beginLoad(key, "initial");
  if (request === null) throw new Error("The initial editor load did not start.");
  documents.resolveLoad(request, { content: `${path} on disk\n`, revision: "r1" });
  return key;
}

test("clean navigation skips confirmation while dirty navigation can be canceled or confirmed", () => {
  const confirm = vi.fn((message: string) => { expect(message).toContain("Leave this Workbench"); return false; });
  expect(confirmWorkbenchLeave(false, confirm)).toBe(true);
  expect(confirm).not.toHaveBeenCalled();
  expect(confirmWorkbenchLeave(true, confirm)).toBe(false);
  expect(confirmWorkbenchLeave(true, () => true)).toBe(true);
  expect(confirm).toHaveBeenCalledTimes(1);
});

test("only explicit reload of the affected dirty document needs confirmation", () => {
  const documents = new WorkbenchEditorDocuments();
  const cleanKey = loadDocument(documents, "workspace-one", "clean.txt");
  const dirtyKey = loadDocument(documents, "workspace-one", "dirty.txt");
  documents.updateContent(dirtyKey, "dirty buffer\n");
  const confirm = vi.fn((message: string) => { expect(message).toContain("dirty.txt"); return false; });

  expect(confirmEditorReload(documents.get(cleanKey)?.document ?? null, confirm)).toBe(true);
  expect(confirmEditorReload(documents.get(dirtyKey)?.document ?? null, confirm)).toBe(false);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(documents.get(dirtyKey)?.document?.content).toBe("dirty buffer\n");
});

test("beforeunload guard reads all open editor documents and removes its listener", () => {
  const documents = new WorkbenchEditorDocuments();
  const cleanKey = loadDocument(documents, "workspace-one", "clean.txt");
  const inactiveKey = loadDocument(documents, "workspace-one", "inactive.ts");
  documents.updateContent(inactiveKey, "inactive unsaved buffer\n");
  const listeners = new Set<(event: BeforeUnloadEvent) => void>();
  const target = {
    addEventListener: (_type: "beforeunload", listener: (event: BeforeUnloadEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: "beforeunload", listener: (event: BeforeUnloadEvent) => void) => { listeners.delete(listener); }
  };
  let navigationConfirmed = false;
  const cleanup = registerBeforeUnloadGuard(target, () => documents.hasUnsavedChanges(), () => navigationConfirmed);
  const listener = [...listeners][0];
  expect(listener).toBeDefined();

  const cancelUnload = vi.fn();
  const canceledEvent = { returnValue: "", preventDefault: cancelUnload } as unknown as BeforeUnloadEvent;
  listener!(canceledEvent);
  expect(cancelUnload).toHaveBeenCalledOnce();
  expect(canceledEvent.returnValue).toBe("");

  documents.markSaved(inactiveKey, "r2", "inactive unsaved buffer\n");
  documents.updateContent(cleanKey, "saved after this edit\n");
  documents.markSaved(cleanKey, "r2", "saved after this edit\n");
  expect(documents.hasUnsavedChanges()).toBe(false);
  const preventCleanUnload = vi.fn();
  const cleanEvent = { returnValue: "", preventDefault: preventCleanUnload } as unknown as BeforeUnloadEvent;
  listener!(cleanEvent);
  expect(preventCleanUnload).not.toHaveBeenCalled();

  documents.updateContent(cleanKey, "dirty again\n");
  navigationConfirmed = true;
  const preventConfirmedUnload = vi.fn();
  const confirmedEvent = { returnValue: "", preventDefault: preventConfirmedUnload } as unknown as BeforeUnloadEvent;
  listener!(confirmedEvent);
  expect(preventConfirmedUnload).not.toHaveBeenCalled();

  cleanup();
  expect(listeners.size).toBe(0);
});
