import { gitBranchNameSchema, remoteRepositoryUrlSchema } from "@devspace/contracts";
import type { AgentClient } from "./agent-client.js";
import type { ProjectDatabase, ProjectView } from "./database.js";

export class OnboardingValidationError extends Error {
  constructor(message: string) { super(message); this.name = "OnboardingValidationError"; }
}

export interface OnboardingInput {
  readonly repositoryUrl: string;
  readonly name: string;
  readonly slug: string;
  readonly defaultBranch?: string;
}

export function parseOnboardingInput(value: unknown): OnboardingInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new OnboardingValidationError("Enter project details.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["repositoryUrl", "name", "slug", "defaultBranch"].includes(key))) {
    throw new OnboardingValidationError("The request contains unknown fields.");
  }
  const repository = remoteRepositoryUrlSchema.safeParse(record.repositoryUrl);
  if (!repository.success) throw new OnboardingValidationError("Enter a valid remote Git repository URL without credentials.");
  const repositoryUrl = new URL(repository.data);
  if (repositoryUrl.protocol !== "https:") {
    throw new OnboardingValidationError("Project onboarding currently supports HTTPS Git repository URLs only.");
  }
  if (repositoryUrl.search !== "") {
    throw new OnboardingValidationError("Repository URLs containing query parameters are not supported. Remove the query parameters and try again.");
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
  return { repositoryUrl: repository.data, name, slug, ...(branchText === "" ? {} : { defaultBranch: branchText }) };
}

export async function onboardProject(input: OnboardingInput, actor: string, dependencies: {
  readonly agent: AgentClient;
  readonly database: ProjectDatabase;
}): Promise<ProjectView> {
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
