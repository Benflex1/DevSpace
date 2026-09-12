import { expect, test } from "vitest";
import { monacoModelPaths } from "./monaco-model-paths.js";

test("creates stable distinct editable and diff model URIs per workspace and file", () => {
  const first = monacoModelPaths("workspace-one", "src/App.tsx", "unstaged");
  const repeat = monacoModelPaths("workspace-one", "src/App.tsx", "unstaged");
  const otherFile = monacoModelPaths("workspace-one", "src/Other.tsx", "unstaged");
  const otherWorkspace = monacoModelPaths("workspace-two", "src/App.tsx", "unstaged");

  expect(first).toEqual(repeat);
  expect(new Set([first.editable, first.diffOriginal, first.diffModified]).size).toBe(3);
  expect(first.editable).not.toBe(otherFile.editable);
  expect(first.editable).not.toBe(otherWorkspace.editable);
  expect(first.diffOriginal).not.toBe(first.diffModified);
});

test("separates staged and unstaged diff model identities", () => {
  const staged = monacoModelPaths("workspace-one", "src/App.tsx", "staged");
  const unstaged = monacoModelPaths("workspace-one", "src/App.tsx", "unstaged");

  expect(staged.diffOriginal).not.toBe(unstaged.diffOriginal);
  expect(staged.diffModified).not.toBe(unstaged.diffModified);
});
