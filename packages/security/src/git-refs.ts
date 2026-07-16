import { validateGitBranchShorthand } from "@devspace/domain";
import { validationFailure, validationSuccess, type ValidationResult } from "./validation-result.js";

declare const gitBranchNameBrand: unique symbol;
export type GitBranchName = string & { readonly [gitBranchNameBrand]: true };

export function validateGitBranchName(input: string): ValidationResult<GitBranchName> {
  const result = validateGitBranchShorthand(input);
  if (result.ok) return validationSuccess(input as GitBranchName);
  return validationFailure(
    "git-branch",
    result.error.code,
    input,
    "defaultBranch",
    "git-branch-shorthand",
    result.error.details
  );
}
