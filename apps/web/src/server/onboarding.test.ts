import { expect, test, vi } from "vitest";
import { sourceInspectionDataSchema } from "@devspace/contracts";
import { AgentUnavailableError, type AgentClient } from "./agent-client.js";
import type { ProjectDatabase } from "./database.js";
import { OnboardingValidationError, onboardProject, parseOnboardingInput } from "./onboarding.js";

const input = { sourceKind: "remote" as const, repositoryUrl: "https://example.com/repo.git", name: "Repo", slug: "repo" };
const database = { createProject: (value: Parameters<ProjectDatabase["createProject"]>[0]) => ({
  id: "018f0f00-0000-7000-8000-000000000001", name: value.name, slug: value.slug, repositoryUrl: value.repositoryUrl,
  defaultBranch: value.defaultBranch, state: "registering" as const, createdAt: "2026-07-17T00:00:00.000Z"
}) } as ProjectDatabase;

test("validates remote onboarding input and rejects local paths", () => {
  expect(parseOnboardingInput(input)).toEqual(input);
  expect(() => parseOnboardingInput({ ...input, repositoryUrl: "/tmp/repo" })).toThrow(OnboardingValidationError);
  expect(() => parseOnboardingInput({ ...input, slug: "Bad Slug" })).toThrow(OnboardingValidationError);
});

test("accepts HTTPS without a query and safely rejects query-bearing and SSH onboarding URLs", () => {
  expect(parseOnboardingInput(input).repositoryUrl).toBe("https://example.com/repo.git");
  const secretUrl = "https://example.com/repo.git?access_token=review-secret";
  expect(() => parseOnboardingInput({ ...input, repositoryUrl: secretUrl })).toThrow(/query parameters/u);
  try { parseOnboardingInput({ ...input, repositoryUrl: secretUrl }); } catch (error) {
    expect((error as Error).message).not.toContain(secretUrl);
    expect((error as Error).message).not.toContain("review-secret");
  }
  expect(() => parseOnboardingInput({ ...input, repositoryUrl: "ssh://git@example.com/repo.git" })).toThrow(/currently supports HTTPS/u);
});

test("uses inspected default branch, accepts an explicit override, and leaves the project registering", async () => {
  const agent: AgentClient = {
    health: () => Promise.resolve({ status: "ok" as const }),
    inspectSource: () => Promise.resolve(sourceInspectionDataSchema.parse({ sourceKind: "remote", isGitRepository: true, defaultBranch: "trunk", headCommit: null }))
  };
  await expect(onboardProject(input, "actor", { agent, database })).resolves.toMatchObject({ defaultBranch: "trunk", state: "registering" });
  await expect(onboardProject({ ...input, defaultBranch: "main" }, "actor", { agent, database })).resolves.toMatchObject({ defaultBranch: "main" });
});

test("rejects malformed sources, missing branches, and unavailable Agent health", async () => {
  const invalidAgent: AgentClient = {
    health: () => Promise.resolve({ status: "ok" }),
    inspectSource: () => Promise.resolve(sourceInspectionDataSchema.parse({ sourceKind: "remote", isGitRepository: false, defaultBranch: null, headCommit: null }))
  };
  await expect(onboardProject(input, "actor", { database, agent: invalidAgent })).rejects.toBeInstanceOf(OnboardingValidationError);
  const branchlessAgent: AgentClient = {
    health: () => Promise.resolve({ status: "ok" }),
    inspectSource: () => Promise.resolve(sourceInspectionDataSchema.parse({ sourceKind: "remote", isGitRepository: true, defaultBranch: null, headCommit: null }))
  };
  await expect(onboardProject(input, "actor", { database, agent: branchlessAgent })).rejects.toThrow(/default branch/u);
  const unavailableAgent: AgentClient = {
    health: () => Promise.reject(new AgentUnavailableError()),
    inspectSource: () => Promise.reject(new Error("must not inspect"))
  };
  await expect(onboardProject(input, "actor", { database, agent: unavailableAgent })).rejects.toBeInstanceOf(AgentUnavailableError);
});

test("registers a GitHub repository by connection and immutable repository ID without accepting a URL", async () => {
  const connectionId = "018f0f00-0000-7000-8000-000000000099";
  const repository = {
    repositoryId: "9007199254740993", ownerLogin: "owner-org", name: "private-repo", fullName: "owner-org/private-repo",
    cleanHttpsUrl: "https://github.com/owner-org/private-repo.git", defaultBranch: "main", private: true, archived: false, disabled: false
  } as const;
  expect(parseOnboardingInput({ sourceKind: "github-app", connectionId, repositoryId: repository.repositoryId, name: "Private", slug: "private" }))
    .toEqual({ sourceKind: "github-app", connectionId, repositoryId: repository.repositoryId, name: "Private", slug: "private" });
  expect(() => parseOnboardingInput({ sourceKind: "github-app", connectionId, repositoryId: repository.repositoryId,
    repositoryUrl: repository.cleanHttpsUrl, name: "Private", slug: "private" })).toThrow(OnboardingValidationError);
  const owned = vi.fn<(actor: string, connectionId: string) => void>();
  const createProject = vi.fn<ProjectDatabase["createProject"]>((value) => ({
    id: "018f0f00-0000-7000-8000-000000000001", name: value.name, slug: value.slug, repositoryUrl: value.repositoryUrl,
    defaultBranch: value.defaultBranch, state: "registering" as const, createdAt: "2026-07-17T00:00:00.000Z"
  }));
  const githubDatabase = { assertGithubConnectionOwned: owned,
    getGithubAuthorityContext: () => ({ connectionId, lifecycleGeneration: 1, lifecycleState: "enabled" as const,
      cleanupState: "settled" as const, admitted: true }), createProject } as unknown as ProjectDatabase;
  const agent: AgentClient = {
    health: () => Promise.resolve({ status: "ok" as const }),
    inspectSource: () => Promise.reject(new Error("must not inspect a GitHub source")),
    resolveGithubRepository: vi.fn(() => Promise.resolve({ repository, cleanupDegraded: false }))
  };
  const result = await onboardProject({ sourceKind: "github-app", connectionId, repositoryId: repository.repositoryId,
    name: "Private", slug: "private" }, "actor", { agent, database: githubDatabase });
  expect(result.repositoryUrl).toBe(repository.cleanHttpsUrl);
  expect(owned).toHaveBeenCalledWith("actor", connectionId);
  expect(agent.resolveGithubRepository).toHaveBeenCalledWith(connectionId, repository.repositoryId, 1);
  const createdInput = createProject.mock.calls[0]?.[0];
  expect(createdInput?.repositoryUrl).toBe(repository.cleanHttpsUrl);
  expect(createdInput?.githubSource?.connectionId).toBe(connectionId);
  expect(createdInput?.githubSource?.repository).toEqual(repository);
});
