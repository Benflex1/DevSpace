import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("unified project source form", () => {
  it("keeps GitHub selection inside Add Project without browser credential or URL authority", async () => {
    const source = await readFile(new URL("./project-form.tsx", import.meta.url), "utf8");
    expect(source).toContain("Connected GitHub repository");
    expect(source).toContain("Refresh GitHub access");
    expect(source).toContain("repositoryId: selectedRepositoryId");
    expect(source).not.toContain('type="password"');
    expect(source).not.toContain("repositoryUrl: selected");
    expect(source).not.toContain("token");
    expect(source).not.toContain("Disconnect");
  });
});
