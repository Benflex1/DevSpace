import { expect, test } from "vitest";
import { editorLanguageForPath, markEditorConflict, markEditorSaved, updateEditorContent, type EditorDocument } from "./editor-state.js";

const document: EditorDocument = {
  path: "src/index.ts", content: "const value = 1;\n", savedContent: "const value = 1;\n", revision: "a".repeat(64), dirty: false, conflict: null
};

test("selects ordinary Monaco language IDs from filenames", () => {
  expect(editorLanguageForPath("src/index.ts")).toBe("typescript");
  expect(editorLanguageForPath("component.tsx")).toBe("typescript");
  expect(editorLanguageForPath("package.json")).toBe("json");
  expect(editorLanguageForPath("README.md")).toBe("markdown");
  expect(editorLanguageForPath("unknown.custom")).toBe("plaintext");
});

test("marks an editor dirty only when its buffer differs from the saved content", () => {
  expect(updateEditorContent(document, "const value = 2;\n")).toMatchObject({ content: "const value = 2;\n", dirty: true });
  expect(updateEditorContent({ ...document, content: "changed", dirty: true }, document.savedContent)).toMatchObject({ dirty: false });
});

test("clears dirty and conflict state after save while retaining a conflict buffer", () => {
  const dirty = updateEditorContent(document, "changed\n");
  expect(markEditorSaved(dirty, "b".repeat(64))).toMatchObject({ content: "changed\n", savedContent: "changed\n", revision: "b".repeat(64), dirty: false, conflict: null });
  expect(markEditorConflict(dirty, "The file changed externally.")).toMatchObject({ content: "changed\n", dirty: true, conflict: "The file changed externally." });
});
