import { expect, test } from "vitest";
import {
  listWorkspaceFilesDataSchema,
  readWorkspaceFileDataSchema,
  saveWorkspaceFileDataSchema,
  workspaceFileReadResultSchema,
  workspaceFileSaveResultSchema,
  workspaceFilesListResultSchema
} from "@devspace/contracts";

const projectId = "018f0f00-0000-7000-8000-000000000101";
const workspaceId = "018f0f00-0000-7000-8000-000000000102";

test("accepts bounded list and read requests and validates file results", () => {
  expect(listWorkspaceFilesDataSchema.parse({ projectId, workspaceId, path: "src" })).toEqual({ projectId, workspaceId, path: "src" });
  expect(readWorkspaceFileDataSchema.parse({ projectId, workspaceId, path: "src/index.ts" })).toEqual({ projectId, workspaceId, path: "src/index.ts" });
  expect(workspaceFilesListResultSchema.parse({ path: "src", entries: [
    { path: "src/index.ts", name: "index.ts", kind: "file", size: 12 }
  ] })).toMatchObject({ path: "src" });
  expect(workspaceFileReadResultSchema.parse({ path: "README.md", content: "hello\n", revision: "a".repeat(64), size: 6 })).toMatchObject({
    content: "hello\n", revision: "a".repeat(64)
  });
});

test("requires an expected revision and bounds save content", () => {
  expect(saveWorkspaceFileDataSchema.parse({ projectId, workspaceId, path: "README.md", content: "updated", expectedRevision: "a".repeat(64) })).toMatchObject({
    path: "README.md", expectedRevision: "a".repeat(64)
  });
  expect(saveWorkspaceFileDataSchema.safeParse({ projectId, workspaceId, path: "README.md", content: "updated" }).success).toBe(false);
  expect(workspaceFileSaveResultSchema.safeParse({ path: "README.md", revision: "not-a-revision" }).success).toBe(false);
});

test("keeps .github representable for the Agent's exact-component policy", () => {
  expect(listWorkspaceFilesDataSchema.safeParse({ projectId, workspaceId, path: ".github" }).success).toBe(true);
});
