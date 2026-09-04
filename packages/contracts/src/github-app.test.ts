import { describe, expect, it } from "vitest";
import {
  githubConnectionIdSchema,
  githubDecimalIdSchema,
  githubInstallationVerifyDataSchema,
  githubRepositoriesListDataSchema,
  githubRepositoryPageSchema
} from "./github-app.js";

describe("GitHub App contracts", () => {
  it("accepts bounded decimal identifiers and rejects unsafe or ambiguous forms", () => {
    expect(githubDecimalIdSchema.parse("9007199254740993")).toBe("9007199254740993");
    for (const value of ["", "01", "-1", "1.0", "1e3", "9".repeat(40)]) {
      expect(githubDecimalIdSchema.safeParse(value).success).toBe(false);
    }
  });

  it("strictly binds verification to connection and installation identifiers", () => {
    const connectionId = "018f0d84-7b39-7cc3-9d4a-0675d9162a11";
    expect(githubConnectionIdSchema.parse(connectionId)).toBe(connectionId);
    expect(githubInstallationVerifyDataSchema.parse({ connectionId, installationId: "42" })).toEqual({ connectionId, installationId: "42" });
    expect(githubInstallationVerifyDataSchema.safeParse({ connectionId, installationId: "42", login: "attacker" }).success).toBe(false);
  });

  it("bounds pagination and exposes only clean repository metadata", () => {
    expect(githubRepositoriesListDataSchema.parse({ connectionId: "018f0d84-7b39-7cc3-9d4a-0675d9162a11", pageSize: 100 })).toBeTruthy();
    expect(githubRepositoriesListDataSchema.safeParse({ connectionId: "018f0d84-7b39-7cc3-9d4a-0675d9162a11", pageSize: 101 }).success).toBe(false);
    const page = githubRepositoryPageSchema.parse({
      repositories: [{ repositoryId: "9007199254740993", ownerLogin: "Benflex1", name: "DevSpace", fullName: "Benflex1/DevSpace", cleanHttpsUrl: "https://github.com/Benflex1/DevSpace.git", defaultBranch: "main", private: true, archived: false, disabled: false }],
      continuation: null,
      cleanupDegraded: false
    });
    expect(page.repositories[0]?.cleanHttpsUrl).toBe("https://github.com/Benflex1/DevSpace.git");
    expect(githubRepositoryPageSchema.safeParse({ ...page, repositories: [{ ...page.repositories[0], token: "secret" }] }).success).toBe(false);
    expect(githubRepositoryPageSchema.safeParse({ ...page, repositories: [{ ...page.repositories[0], cleanHttpsUrl: "https://token@github.com/a/b.git" }] }).success).toBe(false);
  });
});
