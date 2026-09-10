import { expect, test } from "vitest";
import { editorDocumentKey, WorkbenchEditorDocuments } from "./workbench-editor-documents.js";

const key = editorDocumentKey("workspace-one", "README.md");

test("loads an open document once and keeps the edited buffer attached across remounts", () => {
  const documents = new WorkbenchEditorDocuments();
  documents.ensure(key, "README.md");
  const firstLoad = documents.beginLoad(key, "initial");
  expect(firstLoad).not.toBeNull();
  expect(documents.beginLoad(key, "initial")).toBeNull();

  expect(documents.resolveLoad(firstLoad!, { content: "disk\n", revision: "r1" })).toBe(true);
  expect(documents.beginLoad(key, "initial")).toBeNull();
  documents.updateContent(key, "exact unsaved buffer\n");

  const remounted = documents.ensure(key, "README.md");
  expect(remounted.document).toMatchObject({ content: "exact unsaved buffer\n", savedContent: "disk\n", revision: "r1", dirty: true });
  expect(remounted.loadState).toBe("loaded");
});

test("rejects a stale read response after a newer load generation has started", () => {
  const documents = new WorkbenchEditorDocuments();
  documents.ensure(key, "README.md");
  const initial = documents.beginLoad(key, "initial");
  expect(initial).not.toBeNull();
  expect(documents.resolveLoad(initial!, { content: "disk\n", revision: "r1" })).toBe(true);
  documents.updateContent(key, "local edit\n");
  const retry = documents.beginLoad(key, "retry");
  expect(retry).not.toBeNull();
  expect(retry?.generation).toBeGreaterThan(initial?.generation ?? 0);
  documents.updateContent(key, "newer local edit\n");

  expect(documents.resolveLoad(retry!, { content: "stale disk\n", revision: "stale" })).toBe(false);
  expect(documents.get(key)?.document?.content).toBe("newer local edit\n");
  expect(documents.get(key)?.loadState).toBe("loaded");
});

test("allows an explicit conflict reload to replace the owned document", () => {
  const documents = new WorkbenchEditorDocuments();
  documents.ensure(key, "README.md");
  const initial = documents.beginLoad(key, "initial");
  documents.resolveLoad(initial!, { content: "disk\n", revision: "r1" });
  documents.updateContent(key, "local edit\n");
  const reload = documents.beginLoad(key, "reload");

  expect(documents.resolveLoad(reload!, { content: "external edit\n", revision: "r2" })).toBe(true);
  expect(documents.get(key)?.document).toMatchObject({ content: "external edit\n", savedContent: "external edit\n", revision: "r2", dirty: false, conflict: null });
});

test("allows an explicit retry after an initial load failure", () => {
  const documents = new WorkbenchEditorDocuments();
  documents.ensure(key, "README.md");
  const initial = documents.beginLoad(key, "initial");
  expect(initial).not.toBeNull();
  expect(documents.rejectLoad(initial!, "temporary read failure")).toBe(true);
  expect(documents.beginLoad(key, "initial")).toBeNull();

  const retry = documents.beginLoad(key, "retry");
  expect(retry).not.toBeNull();
  expect(documents.resolveLoad(retry!, { content: "recovered\n", revision: "r1" })).toBe(true);
  expect(documents.get(key)?.document?.content).toBe("recovered\n");
});

test("releases a document only when the Workbench closes its file tab", () => {
  const documents = new WorkbenchEditorDocuments();
  documents.ensure(key, "README.md");
  const initial = documents.beginLoad(key, "initial");
  documents.resolveLoad(initial!, { content: "disk\n", revision: "r1" });
  documents.updateContent(key, "unsaved\n");

  documents.release(key);
  expect(documents.get(key)).toBeUndefined();
  expect(documents.beginLoad(key, "initial")).toBeNull();
  expect(documents.ensure(key, "README.md").loadState).toBe("idle");
});

test("does not accept a response from a closed tab after the same file is reopened", () => {
  const documents = new WorkbenchEditorDocuments();
  documents.ensure(key, "README.md");
  const firstLoad = documents.beginLoad(key, "initial");
  documents.release(key);

  documents.ensure(key, "README.md");
  const reopenedLoad = documents.beginLoad(key, "initial");
  expect(reopenedLoad?.generation).toBeGreaterThan(firstLoad?.generation ?? 0);
  expect(documents.resolveLoad(firstLoad!, { content: "stale\n", revision: "stale" })).toBe(false);
  expect(documents.resolveLoad(reopenedLoad!, { content: "current\n", revision: "current" })).toBe(true);
  expect(documents.get(key)?.document?.content).toBe("current\n");
});
