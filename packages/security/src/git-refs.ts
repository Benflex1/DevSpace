import {
  validationFailure,
  validationSuccess,
  type GitBranchValidationErrorCode,
  type ValidationResult
} from "./validation-result.js";

declare const gitBranchNameBrand: unique symbol;
export type GitBranchName = string & { readonly [gitBranchNameBrand]: true };

export function validateGitBranchName(input: string): ValidationResult<GitBranchName> {
  const fail = (
    code: GitBranchValidationErrorCode,
    details: Readonly<Record<string, string | number>> = {}
  ): ValidationResult<never> => validationFailure(
    "git-branch",
    code,
    input,
    "defaultBranch",
    "git-branch-shorthand",
    details
  );

  if (input.length === 0) {
    return fail("GIT_BRANCH_EMPTY");
  }
  if ([...input].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  })) {
    return fail("GIT_BRANCH_NUL_OR_CONTROL");
  }
  if (/\s/u.test(input)) {
    return fail("GIT_BRANCH_WHITESPACE");
  }
  if (input.includes("\\")) {
    return fail("GIT_BRANCH_BACKSLASH");
  }
  if ([...input].some((character) => "~^:?*[".includes(character))) {
    return fail("GIT_BRANCH_FORBIDDEN_CHARACTER");
  }
  if (input.includes("..")) {
    return fail("GIT_BRANCH_DOT_DOT");
  }
  if (input.includes("@{")) {
    return fail("GIT_BRANCH_REFLOG_SYNTAX");
  }
  if (input === "@") {
    return fail("GIT_BRANCH_LONE_AT");
  }
  if (input.startsWith("-")) {
    return fail("GIT_BRANCH_LEADING_HYPHEN");
  }
  if (input.startsWith("/") || input.endsWith("/")) {
    return fail("GIT_BRANCH_SLASH_BOUNDARY");
  }
  if (input.includes("//")) {
    return fail("GIT_BRANCH_REPEATED_SLASH");
  }
  if (input.endsWith(".")) {
    return fail("GIT_BRANCH_TRAILING_DOT");
  }

  const components = input.split("/");
  for (const [componentIndex, component] of components.entries()) {
    if (component.startsWith(".")) {
      return fail("GIT_BRANCH_DOT_COMPONENT", { component, componentIndex });
    }
    if (component.endsWith(".lock")) {
      return fail("GIT_BRANCH_LOCK_COMPONENT", { component, componentIndex });
    }
  }

  return validationSuccess(input as GitBranchName);
}
