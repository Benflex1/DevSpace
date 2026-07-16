import { describe, expect, test } from "vitest";
import { gitBranchValidationErrorCodes, validateGitBranchShorthand } from "./index.js";

describe("authoritative Git branch shorthand", () => {
  test.each(["main", "feature/agent-api-v1", "release/1.0", "@main", "ümlaut"])(
    "accepts %j without rewriting it",
    (input) => expect(validateGitBranchShorthand(input)).toEqual({ ok: true, value: input })
  );

  test.each([
    ["", "GIT_BRANCH_EMPTY", {}],
    ["nul\0branch", "GIT_BRANCH_NUL_OR_CONTROL", {}],
    ["line\nbranch", "GIT_BRANCH_NUL_OR_CONTROL", {}],
    ["feature branch", "GIT_BRANCH_WHITESPACE", {}],
    ["feature\\branch", "GIT_BRANCH_BACKSLASH", {}],
    ["feature~one", "GIT_BRANCH_FORBIDDEN_CHARACTER", {}],
    ["feature^one", "GIT_BRANCH_FORBIDDEN_CHARACTER", {}],
    ["feature:one", "GIT_BRANCH_FORBIDDEN_CHARACTER", {}],
    ["feature?one", "GIT_BRANCH_FORBIDDEN_CHARACTER", {}],
    ["feature*one", "GIT_BRANCH_FORBIDDEN_CHARACTER", {}],
    ["feature[one", "GIT_BRANCH_FORBIDDEN_CHARACTER", {}],
    ["feature..one", "GIT_BRANCH_DOT_DOT", {}],
    ["feature@{one", "GIT_BRANCH_REFLOG_SYNTAX", {}],
    ["@", "GIT_BRANCH_LONE_AT", {}],
    ["-main", "GIT_BRANCH_LEADING_HYPHEN", {}],
    ["/main", "GIT_BRANCH_SLASH_BOUNDARY", {}],
    ["main/", "GIT_BRANCH_SLASH_BOUNDARY", {}],
    ["feature//one", "GIT_BRANCH_REPEATED_SLASH", {}],
    ["main.", "GIT_BRANCH_TRAILING_DOT", {}],
    ["feature/.hidden", "GIT_BRANCH_DOT_COMPONENT", { component: ".hidden", componentIndex: 1 }],
    ["feature/main.lock", "GIT_BRANCH_LOCK_COMPONENT", { component: "main.lock", componentIndex: 1 }]
  ])("rejects %j with %s and stable details", (input, code, details) => {
    expect(validateGitBranchShorthand(input)).toEqual({ ok: false, error: { code, details } });
  });

  test("publishes the complete closed reason registry", () => {
    expect(gitBranchValidationErrorCodes).toHaveLength(14);
    expect(new Set(gitBranchValidationErrorCodes).size).toBe(14);
  });
});
