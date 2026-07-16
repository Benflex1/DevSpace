import { expect, test } from "vitest";
import { validateGitBranchName } from "./index.js";

test.each([
  "main",
  "develop",
  "feature/security-validation",
  "fix/path-check",
  "release/1.0"
])("accepts branch shorthand %j without normalization", (input) => {
  expect(validateGitBranchName(input)).toEqual({ ok: true, value: input });
});

test.each([
  ["", "GIT_BRANCH_EMPTY"],
  ["nul\0branch", "GIT_BRANCH_NUL_OR_CONTROL"],
  ["line\nbranch", "GIT_BRANCH_NUL_OR_CONTROL"],
  ["feature branch", "GIT_BRANCH_WHITESPACE"],
  [" feature", "GIT_BRANCH_WHITESPACE"],
  ["feature ", "GIT_BRANCH_WHITESPACE"],
  ["feature\\branch", "GIT_BRANCH_BACKSLASH"],
  ["feature~one", "GIT_BRANCH_FORBIDDEN_CHARACTER"],
  ["feature^one", "GIT_BRANCH_FORBIDDEN_CHARACTER"],
  ["feature:one", "GIT_BRANCH_FORBIDDEN_CHARACTER"],
  ["feature?one", "GIT_BRANCH_FORBIDDEN_CHARACTER"],
  ["feature*one", "GIT_BRANCH_FORBIDDEN_CHARACTER"],
  ["feature[one", "GIT_BRANCH_FORBIDDEN_CHARACTER"],
  ["feature..one", "GIT_BRANCH_DOT_DOT"],
  ["feature@{one", "GIT_BRANCH_REFLOG_SYNTAX"],
  ["@", "GIT_BRANCH_LONE_AT"],
  ["-main", "GIT_BRANCH_LEADING_HYPHEN"],
  ["/main", "GIT_BRANCH_SLASH_BOUNDARY"],
  ["main/", "GIT_BRANCH_SLASH_BOUNDARY"],
  ["feature//one", "GIT_BRANCH_REPEATED_SLASH"],
  ["main.", "GIT_BRANCH_TRAILING_DOT"],
  ["feature/.hidden", "GIT_BRANCH_DOT_COMPONENT"],
  ["feature/main.lock", "GIT_BRANCH_LOCK_COMPONENT"]
])("rejects invalid Git branch shorthand %j with stable code %s", (input, code) => {
  const result = validateGitBranchName(input);
  expect(result).toMatchObject({
    ok: false,
    error: {
      category: "git-branch",
      code,
      input,
      field: "defaultBranch",
      policy: "git-branch-shorthand"
    }
  });
});
