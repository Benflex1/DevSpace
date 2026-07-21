export const securityValidationErrorCodes = Object.freeze([
  "RELATIVE_PATH_EMPTY",
  "RELATIVE_PATH_NUL",
  "RELATIVE_PATH_POSIX_ABSOLUTE",
  "RELATIVE_PATH_WINDOWS_DRIVE",
  "RELATIVE_PATH_WINDOWS_ROOTED",
  "RELATIVE_PATH_UNC",
  "RELATIVE_PATH_DEVICE",
  "RELATIVE_PATH_BACKSLASH",
  "RELATIVE_PATH_TRAVERSAL_SEGMENT",
  "RELATIVE_PATH_CURRENT_SEGMENT",
  "RELATIVE_PATH_EMPTY_SEGMENT",
  "RELATIVE_PATH_TRAILING_SEPARATOR",
  "RELATIVE_PATH_FILE_REQUIRED",
  "CANONICAL_PATH_EMPTY",
  "CANONICAL_PATH_NUL",
  "CANONICAL_PATH_NOT_ABSOLUTE_POSIX",
  "CANONICAL_PATH_WINDOWS_FORM",
  "CANONICAL_PATH_BACKSLASH",
  "CANONICAL_PATH_DOT_SEGMENT",
  "CANONICAL_PATH_EMPTY_SEGMENT",
  "CANONICAL_PATH_TRAILING_SEPARATOR",
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
  "GIT_BRANCH_LOCK_COMPONENT",
  "DNS_LABEL_EMPTY",
  "DNS_LABEL_TOO_LONG",
  "DNS_LABEL_INVALID_CHARACTER",
  "DNS_LABEL_HYPHEN_BOUNDARY",
  "APPROVED_BASE_ID_EMPTY",
  "APPROVED_BASE_EMPTY",
  "APPROVED_BASE_TOO_LONG",
  "APPROVED_BASE_EMPTY_LABEL",
  "APPROVED_BASE_INVALID_LABEL",
  "APPROVED_BASE_LABEL_SUFFIX_MISSING",
  "APPROVED_BASE_LABEL_SUFFIX_EMPTY",
  "APPROVED_BASE_LABEL_SUFFIX_INVALID",
  "APPROVED_BASE_REGISTRY_UNKNOWN_FIELD",
  "APPROVED_BASE_REGISTRY_INVALID_SOURCE",
  "APPROVED_BASE_REGISTRY_INVALID_BASE",
  "APPROVED_BASE_DUPLICATE_ID",
  "APPROVED_BASE_DUPLICATE_DOMAIN",
  "PREVIEW_PATTERN_EMPTY",
  "PREVIEW_PATTERN_MULTIPLE_LABELS",
  "PREVIEW_PATTERN_INVALID_CHARACTER",
  "PREVIEW_PATTERN_MALFORMED_PLACEHOLDER",
  "PREVIEW_PATTERN_UNKNOWN_PLACEHOLDER",
  "PREVIEW_PATTERN_REPEATED_PLACEHOLDER",
  "PREVIEW_PATTERN_PLACEHOLDER_REQUIRED",
  "PREVIEW_PATTERN_CANNOT_FORM_LABEL",
  "PREVIEW_BASE_REGISTRY_INVALID",
  "PREVIEW_BASE_UNKNOWN",
  "PREVIEW_BASE_DOMAIN_INVALID",
  "PREVIEW_PLACEHOLDER_MISSING",
  "PREVIEW_PLACEHOLDER_UNDECLARED",
  "PREVIEW_GENERATED_LABEL_INVALID",
  "PREVIEW_GENERATED_STEM_EMPTY",
  "PREVIEW_COMPOSED_LABEL_TOO_LONG",
  "PREVIEW_HOSTNAME_TOO_LONG"
] as const);

export type SecurityValidationErrorCode = (typeof securityValidationErrorCodes)[number];

export type RelativePathValidationErrorCode = Extract<
  SecurityValidationErrorCode,
  `RELATIVE_PATH_${string}`
>;
export type CanonicalPathValidationErrorCode = Extract<
  SecurityValidationErrorCode,
  `CANONICAL_PATH_${string}`
>;
export type GitBranchValidationErrorCode = Extract<
  SecurityValidationErrorCode,
  `GIT_BRANCH_${string}`
>;
export type DnsLabelValidationErrorCode = Extract<
  SecurityValidationErrorCode,
  `DNS_LABEL_${string}`
>;
export type ApprovedPreviewBaseValidationErrorCode = Extract<
  SecurityValidationErrorCode,
  `APPROVED_BASE_${string}`
>;
export type PreviewPatternValidationErrorCode = Extract<
  SecurityValidationErrorCode,
  `PREVIEW_PATTERN_${string}`
>;
export type PreviewCompositionValidationErrorCode = Extract<
  SecurityValidationErrorCode,
  | `PREVIEW_BASE_${string}`
  | `PREVIEW_PLACEHOLDER_${string}`
  | `PREVIEW_GENERATED_LABEL_${string}`
  | `PREVIEW_GENERATED_STEM_${string}`
  | `PREVIEW_COMPOSED_LABEL_${string}`
  | `PREVIEW_HOSTNAME_${string}`
>;

export type SecurityValidationCategory =
  | "relative-path"
  | "canonical-path"
  | "git-branch"
  | "dns-label"
  | "approved-preview-base"
  | "preview-pattern"
  | "preview-composition";

export type SecurityValidationDetail = string | number | boolean | readonly string[];

interface ValidationErrorCodeByCategory {
  readonly "relative-path": RelativePathValidationErrorCode;
  readonly "canonical-path": CanonicalPathValidationErrorCode;
  readonly "git-branch": GitBranchValidationErrorCode;
  readonly "dns-label": DnsLabelValidationErrorCode;
  readonly "approved-preview-base": ApprovedPreviewBaseValidationErrorCode;
  readonly "preview-pattern": PreviewPatternValidationErrorCode;
  readonly "preview-composition": PreviewCompositionValidationErrorCode;
}

interface SecurityValidationErrorFields<
  Category extends SecurityValidationCategory,
  Code extends SecurityValidationErrorCode
> {
  readonly category: Category;
  readonly code: Code;
  readonly input: string;
  readonly field: string;
  readonly policy: string;
  readonly details: Readonly<Record<string, SecurityValidationDetail>>;
}

export type SecurityValidationError = {
  [Category in SecurityValidationCategory]: SecurityValidationErrorFields<
    Category,
    ValidationErrorCodeByCategory[Category]
  >;
}[SecurityValidationCategory];

export type ValidationResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: SecurityValidationError };

export function validationSuccess<Value>(value: Value): ValidationResult<Value> {
  return Object.freeze({ ok: true, value });
}

export function validationFailure<Category extends SecurityValidationCategory>(
  category: Category,
  code: ValidationErrorCodeByCategory[Category],
  input: string,
  field: string,
  policy: string,
  details: Readonly<Record<string, SecurityValidationDetail>> = {}
): ValidationResult<never> {
  const frozenDetails = Object.freeze({ ...details });
  const error = Object.freeze({
    category,
    code,
    input,
    field,
    policy,
    details: frozenDetails
  }) as SecurityValidationError;
  return Object.freeze({ ok: false, error });
}
