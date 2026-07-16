import {
  validationFailure,
  validationSuccess,
  type CanonicalPathValidationErrorCode,
  type ValidationResult
} from "./validation-result.js";

declare const canonicalAbsolutePosixPathBrand: unique symbol;
export type CanonicalAbsolutePosixPath = string & {
  readonly [canonicalAbsolutePosixPathBrand]: true;
};

export type CanonicalPathRelation = "equal" | "descendant" | "outside";

export function validateClaimedCanonicalAbsolutePosixPath(
  input: string,
  field = "path"
): ValidationResult<CanonicalAbsolutePosixPath> {
  const fail = (
    code: CanonicalPathValidationErrorCode,
    details: Readonly<Record<string, string | number>> = {}
  ): ValidationResult<never> => validationFailure(
    "canonical-path",
    code,
    input,
    field,
    "already-canonical-absolute-posix-path",
    details
  );

  if (input.length === 0) {
    return fail("CANONICAL_PATH_EMPTY");
  }
  if (input.includes("\0")) {
    return fail("CANONICAL_PATH_NUL");
  }
  if (/^[A-Za-z]:/.test(input) || input.startsWith("\\\\")) {
    return fail("CANONICAL_PATH_WINDOWS_FORM");
  }
  if (input.includes("\\")) {
    return fail("CANONICAL_PATH_BACKSLASH");
  }
  if (!input.startsWith("/")) {
    return fail("CANONICAL_PATH_NOT_ABSOLUTE_POSIX");
  }
  if (input.length > 1 && input.endsWith("/")) {
    return fail("CANONICAL_PATH_TRAILING_SEPARATOR");
  }

  const segments = input === "/" ? [] : input.slice(1).split("/");
  for (const [segmentIndex, segment] of segments.entries()) {
    if (segment.length === 0) {
      return fail("CANONICAL_PATH_EMPTY_SEGMENT", { segmentIndex });
    }
    if (segment === "." || segment === "..") {
      return fail("CANONICAL_PATH_DOT_SEGMENT", { segment, segmentIndex });
    }
  }

  return validationSuccess(input as CanonicalAbsolutePosixPath);
}

export function compareCanonicalPathContainment(
  root: CanonicalAbsolutePosixPath,
  candidate: CanonicalAbsolutePosixPath
): CanonicalPathRelation {
  if (candidate === root) {
    return "equal";
  }
  if (root === "/") {
    return "descendant";
  }
  return candidate.startsWith(`${root}/`) ? "descendant" : "outside";
}
