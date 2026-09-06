import {
  githubConnectionIdSchema, githubDecimalIdSchema, gitBranchNameSchema, remoteRepositoryUrlSchema
} from "@devspace/contracts";
import type { AgentClient } from "./agent-client.js";
import type { ProjectDatabase, ProjectView } from "./database.js";

export class OnboardingValidationError extends Error {
  constructor(message: string) { super(message); this.name = "OnboardingValidationError"; }
}

interface CommonOnboardingInput {
  readonly name: string;
  readonly slug: string;
  readonly defaultBranch?: string;
}

export type OnboardingInput = (CommonOnboardingInput & {
  readonly sourceKind?: "remote";
  readonly repositoryUrl: string;
}) | (CommonOnboardingInput & {
  readonly sourceKind: "github-app";
  readonly connectionId: string;
  readonly repositoryId: string;
  readonly repositoryUrl?: never;
});

export function parseOnboardingInput(value: unknown): OnboardingInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new OnboardingValidationError("Enter project details.");
  const record = value as Record<string, unknown>;
  const sourceKind = record.sourceKind === undefined ? "remote" : record.sourceKind;
  if (sourceKind !== "remote" && sourceKind !== "github-app") throw new OnboardingValidationError("Choose a supported repository source.");
  const allowed = sourceKind === "remote"
    ? ["sourceKind", "repositoryUrl", "name", "slug", "defaultBranch"]
    : ["sourceKind", "connectionId", "repositoryId", "name", "slug", "defaultBranch"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new OnboardingValidationError("The request contains unknown fields.");
  let repositoryUrl: string | undefined;
  if (sourceKind === "remote") {
    const repository = remoteRepositoryUrlSchema.safeParse(record.repositoryUrl);
    if (!repository.success) throw new OnboardingValidationError("Enter a valid remote Git repository URL without credentials.");
    const parsedUrl = new URL(repository.data);
    if (parsedUrl.protocol !== "https:") throw new OnboardingValidationError("Project onboarding currently supports HTTPS Git repository URLs only.");
    if (parsedUrl.search !== "") throw new OnboardingValidationError("Repository URLs containing query parameters are not supported. Remove the query parameters and try again.");
    repositoryUrl = repository.data;
  }
  const connectionId = sourceKind === "github-app" ? githubConnectionIdSchema.safeParse(record.connectionId) : undefined;
  const repositoryId = sourceKind === "github-app" ? githubDecimalIdSchema.safeParse(record.repositoryId) : undefined;
  if (sourceKind === "github-app" && (connectionId === undefined || !connectionId.success || repositoryId === undefined || !repositoryId.success)) {
    throw new OnboardingValidationError("Select an authorized GitHub repository.");
  }
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (name.length < 1 || name.length > 100) throw new OnboardingValidationError("Project name must contain 1 through 100 characters.");
  const slug = typeof record.slug === "string" ? record.slug.trim() : "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) || slug.length > 64) {
    throw new OnboardingValidationError("Slug must use lowercase letters, numbers, and single hyphens.");
  }
  const branchText = typeof record.defaultBranch === "string" ? record.defaultBranch.trim() : "";
  if (branchText !== "" && !gitBranchNameSchema.safeParse(branchText).success) {
    throw new OnboardingValidationError("Default branch is not a valid Git branch name.");
  }
  const common = { name, slug, ...(branchText === "" ? {} : { defaultBranch: branchText }) } as const;
  if (sourceKind === "remote") return { ...common, sourceKind: "remote", repositoryUrl: repositoryUrl! };
  return {
    ...common, sourceKind: "github-app",
    connectionId: githubConnectionIdSchema.parse(record.connectionId),
    repositoryId: githubDecimalIdSchema.parse(record.repositoryId)
  };
}

export async function onboardProject(input: OnboardingInput, actor: string, dependencies: {
  readonly agent: AgentClient;
  readonly database: ProjectDatabase;
}): Promise<ProjectView> {
  if (input.sourceKind === "github-app") {
    dependencies.database.assertGithubConnectionOwned(actor, input.connectionId);
    if (dependencies.agent.resolveGithubRepository === undefined) throw new OnboardingValidationError("GitHub repository resolution is unavailable.");
    const resolved = await dependencies.agent.resolveGithubRepository(input.connectionId, input.repositoryId);
    if (resolved.repository.archived || resolved.repository.disabled) {
      throw new OnboardingValidationError("Archived or disabled GitHub repositories cannot be added as new projects.");
    }
    const branch = input.defaultBranch ?? resolved.repository.defaultBranch;
    if (!gitBranchNameSchema.safeParse(branch).success) {
      throw new OnboardingValidationError("No valid default branch was found. Enter a default branch explicitly.");
    }
    const timestamp = new Date().toISOString();
    return dependencies.database.createProject({
      name: input.name, slug: input.slug, repositoryUrl: resolved.repository.cleanHttpsUrl, defaultBranch: branch, actor,
      githubSource: {
        connectionId: input.connectionId, repository: resolved.repository,
        verifiedAt: timestamp, metadataUpdatedAt: timestamp
      }
    });
  }
  await dependencies.agent.health();
  const inspection = await dependencies.agent.inspectSource(input.repositoryUrl);
  if (!inspection.isGitRepository) throw new OnboardingValidationError("The source is not a Git repository accessible to DevSpace.");
  const branch = input.defaultBranch ?? inspection.defaultBranch;
  if (branch === null || !gitBranchNameSchema.safeParse(branch).success) {
    throw new OnboardingValidationError("No valid default branch was found. Enter a default branch explicitly.");
  }
  return dependencies.database.createProject({
    name: input.name, slug: input.slug, repositoryUrl: input.repositoryUrl, defaultBranch: branch, actor
  });
}
