import { validateGitBranchShorthand } from "@devspace/domain";
import { expect, test } from "vitest";
import { validateGitBranchName } from "./index.js";

test.each(["main", "feature/agent-api", "feature/.hidden", "main.lock", "@", "-branch", "a..b"])(
  "security preserves the domain decision and F06 public envelope for %j",
  (input) => {
    const authority = validateGitBranchShorthand(input);
    const security = validateGitBranchName(input);
    expect(security.ok).toBe(authority.ok);
    if (!authority.ok && !security.ok) {
      expect(security.error).toEqual({
        category: "git-branch",
        code: authority.error.code,
        input,
        field: "defaultBranch",
        policy: "git-branch-shorthand",
        details: authority.error.details
      });
    }
  }
);
