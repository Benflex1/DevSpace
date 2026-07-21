import { expect, expectTypeOf, test } from "vitest";
import * as packageEntry from "./index.js";
import {
  composePreviewHostname,
  createApprovedPreviewBaseRegistry,
  securityValidationErrorCodes,
  type ApprovedPreviewBase,
  type ApprovedPreviewBaseRegistry,
  type CanonicalAbsolutePosixPath,
  type DnsLabel,
  type DockerBuildContextPath,
  type DockerfilePath,
  type GitBranchName,
  type InstructionsFilePath,
  type PreviewHostname,
  type PreviewHostnamePattern,
  type ValidationResult,
  type WorktreeWorkingDirectoryPath
} from "./index.js";

const expectedSecurityValidationErrorCodes = [
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
] as const;

function _acceptInstructionsFile(_value: InstructionsFilePath): void {}
function _acceptDockerfile(_value: DockerfilePath): void {}

function _assertBrandSeparation(
  context: DockerBuildContextPath,
  dockerfile: DockerfilePath,
  workingDirectory: WorktreeWorkingDirectoryPath,
  instructions: InstructionsFilePath,
  canonicalPath: CanonicalAbsolutePosixPath,
  branch: GitBranchName,
  label: DnsLabel,
  pattern: PreviewHostnamePattern,
  hostname: PreviewHostname,
  base: ApprovedPreviewBase,
  registry: ApprovedPreviewBaseRegistry
): void {
  _acceptInstructionsFile(instructions);
  _acceptDockerfile(dockerfile);
  expectTypeOf(context).toExtend<string>();
  expectTypeOf(base.domain).toExtend<string>();
  // @ts-expect-error build contexts are not instructions-file paths
  _acceptInstructionsFile(context);
  // @ts-expect-error working directories are not Dockerfile paths
  _acceptDockerfile(workingDirectory);
  // @ts-expect-error canonical absolute paths are not DNS labels
  const _wrongLabel: DnsLabel = canonicalPath;
  // @ts-expect-error Git branches are not preview patterns
  const _wrongPattern: PreviewHostnamePattern = branch;
  // @ts-expect-error generated hostnames are not concrete DNS labels
  const _wrongHostnameLabel: DnsLabel = hostname;
  // @ts-expect-error raw strings cannot bypass preview-pattern validation
  composePreviewHostname("{project}", { project: label }, base.id, registry);
  const structuralBase = { id: base.id, domain: base.domain };
  // @ts-expect-error independently assembled ID/domain objects are not approved bases
  createApprovedPreviewBaseRegistry([structuralBase]);
  const structuralRegistry = {};
  // @ts-expect-error structural objects are not approved-base registries
  composePreviewHostname(pattern, { project: label }, base.id, structuralRegistry);
  expect(pattern).toBeDefined();
}

test("all public brands remain serializable string types and incompatible", () => {
  expectTypeOf<DockerfilePath>().toExtend<string>();
  expectTypeOf<DockerBuildContextPath>().toExtend<string>();
  expectTypeOf<WorktreeWorkingDirectoryPath>().toExtend<string>();
  expectTypeOf<InstructionsFilePath>().toExtend<string>();
  expectTypeOf<CanonicalAbsolutePosixPath>().toExtend<string>();
  expectTypeOf<GitBranchName>().toExtend<string>();
  expectTypeOf<DnsLabel>().toExtend<string>();
  expectTypeOf<PreviewHostnamePattern>().toExtend<string>();
  expectTypeOf<PreviewHostname>().toExtend<string>();
});

test("the package root exposes only intentional runtime APIs", () => {
  expect(Object.keys(packageEntry).sort()).toEqual([
    "compareCanonicalPathContainment",
    "composePreviewHostname",
    "createApprovedPreviewBase",
    "createApprovedPreviewBaseRegistry",
    "getApprovedPreviewBases",
    "isApprovedPreviewHostname",
    "isHostnameInApprovedPreviewRegistry",
    "parseApprovedPreviewBaseRegistry",
    "parseApprovedPreviewBaseRegistryJson",
    "securityValidationErrorCodes",
    "validateClaimedCanonicalAbsolutePosixPath",
    "validateDnsLabel",
    "validateDockerBuildContextPath",
    "validateDockerfilePath",
    "validateGitBranchName",
    "validateInstructionsFilePath",
    "validatePreviewHostnamePattern",
    "validateWorktreeWorkingDirectoryPath"
  ]);
});

test("the complete 62-code inventory is exact, frozen, and duplicate-free", () => {
  expect(securityValidationErrorCodes).toEqual(expectedSecurityValidationErrorCodes);
  expect(securityValidationErrorCodes).toHaveLength(69);
  expect(Object.isFrozen(securityValidationErrorCodes)).toBe(true);
  expect(new Set(securityValidationErrorCodes).size).toBe(securityValidationErrorCodes.length);
});

test("validation results narrow on the ok discriminator", () => {
  const result: ValidationResult<DnsLabel> = packageEntry.validateDnsLabel("valid");
  if (result.ok) {
    expectTypeOf(result.value).toEqualTypeOf<DnsLabel>();
  } else {
    expectTypeOf(result.error.code).toExtend<string>();
  }
});
