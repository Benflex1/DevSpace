import { describe, expect, test } from "vitest";
import {
  validateDockerBuildContextPath,
  validateDockerfilePath,
  validateInstructionsFilePath,
  validateWorktreeWorkingDirectoryPath,
  type ValidationResult
} from "./index.js";

type Validator = (input: string) => ValidationResult<string>;

const policies = [
  {
    name: "Dockerfile path",
    validator: validateDockerfilePath as Validator,
    valid: ["Dockerfile", "docker/Dockerfile", "src", "src/app"],
    invalid: [
      [".", "RELATIVE_PATH_FILE_REQUIRED"],
      ["", "RELATIVE_PATH_EMPTY"]
    ]
  },
  {
    name: "Docker build-context path",
    validator: validateDockerBuildContextPath as Validator,
    valid: [".", "src", "src/app", "docker"],
    invalid: [["", "RELATIVE_PATH_EMPTY"]]
  },
  {
    name: "command worktree-relative working directory",
    validator: validateWorktreeWorkingDirectoryPath as Validator,
    valid: [".", "src", "src/app", "packages/security"],
    invalid: [["", "RELATIVE_PATH_EMPTY"]]
  },
  {
    name: "AI instructions-file path",
    validator: validateInstructionsFilePath as Validator,
    valid: ["AGENTS.md", "docs/instructions.md", "src", "src/app"],
    invalid: [
      [".", "RELATIVE_PATH_FILE_REQUIRED"],
      ["", "RELATIVE_PATH_EMPTY"]
    ]
  }
] as const;

const hostileFixtures = [
  ["../secret", "RELATIVE_PATH_TRAVERSAL_SEGMENT"],
  ["a/../secret", "RELATIVE_PATH_TRAVERSAL_SEGMENT"],
  ["a/./b", "RELATIVE_PATH_CURRENT_SEGMENT"],
  ["/absolute", "RELATIVE_PATH_POSIX_ABSOLUTE"],
  ["//server/share", "RELATIVE_PATH_UNC"],
  ["\\\\server\\share", "RELATIVE_PATH_UNC"],
  ["\\\\?\\C:\\secret", "RELATIVE_PATH_DEVICE"],
  ["\\\\.\\pipe\\name", "RELATIVE_PATH_DEVICE"],
  ["C:\\secret", "RELATIVE_PATH_WINDOWS_DRIVE"],
  ["C:/secret", "RELATIVE_PATH_WINDOWS_DRIVE"],
  ["C:secret", "RELATIVE_PATH_WINDOWS_DRIVE"],
  ["\\rooted", "RELATIVE_PATH_WINDOWS_ROOTED"],
  ["a\\b", "RELATIVE_PATH_BACKSLASH"],
  ["a//b", "RELATIVE_PATH_EMPTY_SEGMENT"],
  ["a/", "RELATIVE_PATH_TRAILING_SEPARATOR"],
  ["./a", "RELATIVE_PATH_CURRENT_SEGMENT"],
  ["a/../../b", "RELATIVE_PATH_TRAVERSAL_SEGMENT"],
  ["nul\0byte", "RELATIVE_PATH_NUL"]
] as const;

describe.each(policies)("$name", ({ validator, valid, invalid }) => {
  test.each(valid)("accepts %j without rewriting it", (input) => {
    expect(validator(input)).toEqual({ ok: true, value: input });
  });

  test.each(invalid)("rejects policy-specific input %j", (input, code) => {
    const result = validator(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(code);
    }
  });

  test.each(hostileFixtures)("rejects hostile cross-platform input %j", (input, code) => {
    const result = validator(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        category: "relative-path",
        code,
        input
      });
    }
  });
});

test("the fixed container working directory is not a repository-relative path", () => {
  const result = validateWorktreeWorkingDirectoryPath("/workspace");
  expect(result).toMatchObject({
    ok: false,
    error: { code: "RELATIVE_PATH_POSIX_ABSOLUTE", field: "workingDirectory" }
  });
});

test("structured segment details are immutable and suitable for field-level reporting", () => {
  const result = validateDockerfilePath("docker/../secret");
  expect(result).toEqual({
    ok: false,
    error: {
      category: "relative-path",
      code: "RELATIVE_PATH_TRAVERSAL_SEGMENT",
      input: "docker/../secret",
      field: "dockerfilePath",
      policy: "dockerfile-path",
      details: { segment: "..", segmentIndex: 1 }
    }
  });
  if (!result.ok) {
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.error)).toBe(true);
    expect(Object.isFrozen(result.error.details)).toBe(true);
  }
});
