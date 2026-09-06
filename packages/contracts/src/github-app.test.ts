import { describe, expect, it } from "vitest";
import {
  githubConnectionIdSchema,
  githubDecimalIdSchema,
  githubInstallationRefreshDataSchema,
  githubInstallationVerifyDataSchema,
  githubRepositoryResolveDataSchema,
  githubRepositoriesListDataSchema,
  githubRepositoryPageSchema
} from "./github-app.js";
import { sourceInspectionDataSchema, sourceLocatorSchema } from "./shapes.js";

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

  it("authorizes a private source only by immutable connection and repository IDs", () => {
    const connectionId = "018f0d84-7b39-7cc3-9d4a-0675d9162a11";
    const repositoryId = "9007199254740993";
    expect(sourceLocatorSchema.parse({ kind: "github-app", connectionId, repositoryId })).toEqual({
      kind: "github-app", connectionId, repositoryId
    });
    expect(sourceLocatorSchema.safeParse({ kind: "github-app", connectionId, repositoryId, url: "https://github.com/attacker/repo.git" }).success).toBe(false);
    expect(sourceLocatorSchema.safeParse({ kind: "github-app", connectionId, repositoryId, ownerLogin: "attacker" }).success).toBe(false);
    expect(githubInstallationRefreshDataSchema.parse({ connectionId })).toEqual({ connectionId });
    expect(githubRepositoryResolveDataSchema.parse({ connectionId, repositoryId })).toEqual({ connectionId, repositoryId });
    expect(githubRepositoryResolveDataSchema.safeParse({ kind: "github-app", connectionId, repositoryId }).success).toBe(false);
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

  it("returns a discriminated safe GitHub inspection without credential fields", () => {
    const result = sourceInspectionDataSchema.parse({
      sourceKind: "github-app", isGitRepository: true, defaultBranch: "main", headCommit: null,
      repository: {
        repositoryId: "9007199254740993", ownerLogin: "Benflex1", name: "DevSpace",
        fullName: "Benflex1/DevSpace", cleanHttpsUrl: "https://github.com/Benflex1/DevSpace.git",
        defaultBranch: "main", private: true, archived: false, disabled: false
      }, cleanupDegraded: false
    });
    expect(result.sourceKind).toBe("github-app");
    expect(sourceInspectionDataSchema.safeParse({ ...result, token: "canary" }).success).toBe(false);
  });
});
