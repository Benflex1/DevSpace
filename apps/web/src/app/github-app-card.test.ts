import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("GitHub App card", () => {
  it("offers only the bounded connection flow and no credential or project onboarding controls", async () => {
    const source = await readFile(new URL("./github-app-card.tsx", import.meta.url), "utf8");
    expect(source).toContain("Private GitHub repositories");
    expect(source).toContain("Retry GitHub connection");
    expect(source).not.toContain("<input");
    expect(source).not.toContain("Clone");
    expect(source).not.toContain("Create project");
    expect(source).not.toContain("Disconnect");
  });
});
