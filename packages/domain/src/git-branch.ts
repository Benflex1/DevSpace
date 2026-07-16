export const gitBranchValidationErrorCodes = Object.freeze([
  "GIT_BRANCH_EMPTY",
  "GIT_BRANCH_NUL_OR_CONTROL",
  "GIT_BRANCH_WHITESPACE",
  "GIT_BRANCH_BACKSLASH",
  "GIT_BRANCH_FORBIDDEN_CHARACTER",
  "GIT_BRANCH_DOT_DOT",
  "GIT_BRANCH_REFLOG_SYNTAX",
  "GIT_BRANCH_LONE_AT",
  "GIT_BRANCH_LEADING_HYPHEN",
  "GIT_BRANCH_SLASH_BOUNDARY",
  "GIT_BRANCH_REPEATED_SLASH",
  "GIT_BRANCH_TRAILING_DOT",
  "GIT_BRANCH_DOT_COMPONENT",
  "GIT_BRANCH_LOCK_COMPONENT"
] as const);

export type GitBranchValidationErrorCode = (typeof gitBranchValidationErrorCodes)[number];
export type GitBranchValidationDetails = Readonly<Record<string, string | number>>;

declare const gitBranchNameBrand: unique symbol;
export type GitBranchName = string & { readonly [gitBranchNameBrand]: true };

export type GitBranchValidationResult =
  | { readonly ok: true; readonly value: GitBranchName }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: GitBranchValidationErrorCode;
        readonly details: GitBranchValidationDetails;
      };
    };

function failure(
  code: GitBranchValidationErrorCode,
  details: GitBranchValidationDetails = {}
): GitBranchValidationResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, details: Object.freeze({ ...details }) })
  });
}

export function validateGitBranchShorthand(input: string): GitBranchValidationResult {
  if (input.length === 0) return failure("GIT_BRANCH_EMPTY");
  if ([...input].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  })) return failure("GIT_BRANCH_NUL_OR_CONTROL");
  if (/\s/u.test(input)) return failure("GIT_BRANCH_WHITESPACE");
  if (input.includes("\\")) return failure("GIT_BRANCH_BACKSLASH");
  if ([...input].some((character) => "~^:?*[".includes(character))) {
    return failure("GIT_BRANCH_FORBIDDEN_CHARACTER");
  }
  if (input.includes("..")) return failure("GIT_BRANCH_DOT_DOT");
  if (input.includes("@{")) return failure("GIT_BRANCH_REFLOG_SYNTAX");
  if (input === "@") return failure("GIT_BRANCH_LONE_AT");
  if (input.startsWith("-")) return failure("GIT_BRANCH_LEADING_HYPHEN");
  if (input.startsWith("/") || input.endsWith("/")) return failure("GIT_BRANCH_SLASH_BOUNDARY");
  if (input.includes("//")) return failure("GIT_BRANCH_REPEATED_SLASH");
  if (input.endsWith(".")) return failure("GIT_BRANCH_TRAILING_DOT");

  for (const [componentIndex, component] of input.split("/").entries()) {
    if (component.startsWith(".")) {
      return failure("GIT_BRANCH_DOT_COMPONENT", { component, componentIndex });
    }
    if (component.endsWith(".lock")) {
      return failure("GIT_BRANCH_LOCK_COMPONENT", { component, componentIndex });
    }
  }

  return Object.freeze({ ok: true, value: input as GitBranchName });
}
