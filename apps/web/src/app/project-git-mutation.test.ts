import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("Workbench Git mutation reconciliation", () => {
  test("uses authoritative success status without a second refresh, while retaining failure and in-progress reconciliation", async () => {
    const workbench = await readFile(new URL("./project-workbench.tsx", import.meta.url), "utf8");
    const start = workbench.indexOf("const mutateGit =");
    const end = workbench.indexOf("const createTerminal =", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const mutation = workbench.slice(start, end);
    expect(mutation).toContain("if (!response.ok)");
    expect(mutation).toContain("await refreshGitStatus();");
    expect(mutation).toContain('response.status === 202 || result.state === "in-progress"');
    expect(mutation).toContain("window.setTimeout");
    expect(mutation).toContain("if (result.status !== undefined) setGitStatus(result.status);");

    const successBranchStart = mutation.indexOf("} else {");
    const successBranch = mutation.slice(successBranchStart, mutation.indexOf("return true;", successBranchStart));
    expect(successBranch).not.toContain("refreshGitStatus");
  });
});
