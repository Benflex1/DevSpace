import { expect, test } from "vitest";
import {
  emptyEditorFileLoadState,
  editorFileKey,
  requestExplicitEditorFileLoad,
  requestInitialEditorFileLoad
} from "./editor-file-lifecycle.js";

const key = editorFileKey("project-one", "src/App.tsx");

test("requests an initial workspace read once and does not repeat it for presentation toggles", () => {
  const first = requestInitialEditorFileLoad(emptyEditorFileLoadState, key);
  const afterEditChangesEdit = requestInitialEditorFileLoad(first.state, key);

  expect(first.shouldLoad).toBe(true);
  expect(afterEditChangesEdit.shouldLoad).toBe(false);
});

test("allows explicit retry and conflict reload reads while preserving initial-read deduplication", () => {
  const retry = requestExplicitEditorFileLoad(key);
  const reload = requestExplicitEditorFileLoad(key);
  const otherFile = requestInitialEditorFileLoad(reload.state, editorFileKey("project-one", "README.md"));

  expect(retry.shouldLoad).toBe(true);
  expect(reload.shouldLoad).toBe(true);
  expect(otherFile.shouldLoad).toBe(true);
});
