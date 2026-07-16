import { expect, test } from "vitest";
import {
  compareCanonicalPathContainment,
  validateClaimedCanonicalAbsolutePosixPath,
  type CanonicalAbsolutePosixPath
} from "./index.js";

function canonical(input: string): CanonicalAbsolutePosixPath {
  const result = validateClaimedCanonicalAbsolutePosixPath(input);
  if (!result.ok) {
    throw new Error(`fixture is not canonical: ${input}`);
  }
  return result.value;
}

test.each([
  "/",
  "/srv/devspace/workspaces/a",
  "/srv/devspace/workspaces/a/source",
  "/a b/unicode-ß"
])("accepts an already-canonical absolute POSIX spelling: %j", (input) => {
  expect(validateClaimedCanonicalAbsolutePosixPath(input)).toEqual({ ok: true, value: input });
});

test.each([
  ["", "CANONICAL_PATH_EMPTY"],
  ["srv/root", "CANONICAL_PATH_NOT_ABSOLUTE_POSIX"],
  ["./srv/root", "CANONICAL_PATH_NOT_ABSOLUTE_POSIX"],
  ["/srv/root/./source", "CANONICAL_PATH_DOT_SEGMENT"],
  ["/srv/root/../secret", "CANONICAL_PATH_DOT_SEGMENT"],
  ["/srv//root", "CANONICAL_PATH_EMPTY_SEGMENT"],
  ["/srv/root/", "CANONICAL_PATH_TRAILING_SEPARATOR"],
  ["/srv/root\0secret", "CANONICAL_PATH_NUL"],
  ["/srv\\root", "CANONICAL_PATH_BACKSLASH"],
  ["C:\\srv\\root", "CANONICAL_PATH_WINDOWS_FORM"],
  ["\\\\server\\share", "CANONICAL_PATH_WINDOWS_FORM"],
  ["\\\\?\\C:\\secret", "CANONICAL_PATH_WINDOWS_FORM"]
])("rejects noncanonical input %j with %s", (input, code) => {
  const result = validateClaimedCanonicalAbsolutePosixPath(input, "candidatePath");
  expect(result).toMatchObject({
    ok: false,
    error: { category: "canonical-path", code, input, field: "candidatePath" }
  });
});

test.each([
  ["/srv/devspace/workspaces/a", "equal"],
  ["/srv/devspace/workspaces/a/source", "descendant"],
  ["/srv/devspace/workspaces/ab", "outside"],
  ["/srv/devspace/workspaces/a-escape", "outside"],
  ["/srv/devspace/workspaces", "outside"]
])("compares segment-aware containment for %j as %s", (candidate, relation) => {
  const root = canonical("/srv/devspace/workspaces/a");
  expect(compareCanonicalPathContainment(root, canonical(candidate))).toBe(relation);
});

test("treats every non-root canonical absolute path as a descendant of root", () => {
  expect(compareCanonicalPathContainment(canonical("/"), canonical("/srv/root"))).toBe("descendant");
});
