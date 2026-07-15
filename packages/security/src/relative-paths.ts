import {
  validationFailure,
  validationSuccess,
  type RelativePathValidationErrorCode,
  type ValidationResult
} from "./validation-result.js";

declare const dockerfilePathBrand: unique symbol;
declare const dockerBuildContextPathBrand: unique symbol;
declare const worktreeWorkingDirectoryPathBrand: unique symbol;
declare const instructionsFilePathBrand: unique symbol;

export type DockerfilePath = string & { readonly [dockerfilePathBrand]: true };
export type DockerBuildContextPath = string & { readonly [dockerBuildContextPathBrand]: true };
export type WorktreeWorkingDirectoryPath = string & {
  readonly [worktreeWorkingDirectoryPathBrand]: true;
};
export type InstructionsFilePath = string & { readonly [instructionsFilePathBrand]: true };

type RelativePathPolicy = Readonly<{
  field: string;
  policy: string;
  allowRepositoryRoot: boolean;
}>;

const dockerfilePolicy: RelativePathPolicy = Object.freeze({
  field: "dockerfilePath",
  policy: "dockerfile-path",
  allowRepositoryRoot: false
});
const dockerBuildContextPolicy: RelativePathPolicy = Object.freeze({
  field: "contextPath",
  policy: "docker-build-context-path",
  allowRepositoryRoot: true
});
const workingDirectoryPolicy: RelativePathPolicy = Object.freeze({
  field: "workingDirectory",
  policy: "command-worktree-working-directory",
  allowRepositoryRoot: true
});
const instructionsFilePolicy: RelativePathPolicy = Object.freeze({
  field: "instructionsFilePath",
  policy: "ai-instructions-file-path",
  allowRepositoryRoot: false
});

function relativePathFailure(
  input: string,
  policy: RelativePathPolicy,
  code: RelativePathValidationErrorCode,
  details: Readonly<Record<string, string | number>> = {}
): ValidationResult<never> {
  return validationFailure("relative-path", code, input, policy.field, policy.policy, details);
}

function parseRelativePath(input: string, policy: RelativePathPolicy): ValidationResult<string> {
  if (input.length === 0) {
    return relativePathFailure(input, policy, "RELATIVE_PATH_EMPTY");
  }
  if (input.includes("\0")) {
    return relativePathFailure(input, policy, "RELATIVE_PATH_NUL");
  }
  if (/^\\\\[?.]\\/.test(input)) {
    return relativePathFailure(input, policy, "RELATIVE_PATH_DEVICE");
  }
  if (input.startsWith("\\\\") || input.startsWith("//")) {
    return relativePathFailure(input, policy, "RELATIVE_PATH_UNC");
  }
  if (/^[A-Za-z]:/.test(input)) {
    return relativePathFailure(input, policy, "RELATIVE_PATH_WINDOWS_DRIVE");
  }
  if (input.startsWith("\\")) {
    return relativePathFailure(input, policy, "RELATIVE_PATH_WINDOWS_ROOTED");
  }
  if (input.startsWith("/")) {
    return relativePathFailure(input, policy, "RELATIVE_PATH_POSIX_ABSOLUTE");
  }
  if (input.includes("\\")) {
    return relativePathFailure(input, policy, "RELATIVE_PATH_BACKSLASH");
  }
  if (input.endsWith("/")) {
    return relativePathFailure(input, policy, "RELATIVE_PATH_TRAILING_SEPARATOR");
  }

  const segments = input.split("/");
  for (const [segmentIndex, segment] of segments.entries()) {
    if (segment.length === 0) {
      return relativePathFailure(input, policy, "RELATIVE_PATH_EMPTY_SEGMENT", { segmentIndex });
    }
    if (segment === "..") {
      return relativePathFailure(input, policy, "RELATIVE_PATH_TRAVERSAL_SEGMENT", {
        segment,
        segmentIndex
      });
    }
    if (segment === "." && !(input === "." && policy.allowRepositoryRoot)) {
      const code = input === "."
        ? "RELATIVE_PATH_FILE_REQUIRED"
        : "RELATIVE_PATH_CURRENT_SEGMENT";
      return relativePathFailure(input, policy, code, { segment, segmentIndex });
    }
  }

  return validationSuccess(input);
}

export function validateDockerfilePath(input: string): ValidationResult<DockerfilePath> {
  return parseRelativePath(input, dockerfilePolicy) as ValidationResult<DockerfilePath>;
}

export function validateDockerBuildContextPath(
  input: string
): ValidationResult<DockerBuildContextPath> {
  return parseRelativePath(input, dockerBuildContextPolicy) as ValidationResult<DockerBuildContextPath>;
}

export function validateWorktreeWorkingDirectoryPath(
  input: string
): ValidationResult<WorktreeWorkingDirectoryPath> {
  return parseRelativePath(input, workingDirectoryPolicy) as ValidationResult<WorktreeWorkingDirectoryPath>;
}

export function validateInstructionsFilePath(
  input: string
): ValidationResult<InstructionsFilePath> {
  return parseRelativePath(input, instructionsFilePolicy) as ValidationResult<InstructionsFilePath>;
}
