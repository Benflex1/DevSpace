import * as z from "zod";
import { utcTimestampMsSchema, uuidV7Schema } from "./primitives.js";

export const githubConnectionIdSchema = uuidV7Schema;
export const githubDecimalIdSchema = z.string().min(1).max(32).regex(/^(?:0|[1-9][0-9]*)$/u);
export const githubAccountTypeSchema = z.enum(["User", "Organization"]);
export const githubConnectionStatusSchema = z.enum(["unconfigured", "disconnected", "pending", "connected", "degraded", "failed"]);
export const githubRepositorySelectionSchema = z.enum(["all", "selected"]);
export const githubPermissionLevelSchema = z.enum(["read", "write"]);
export const githubPermissionsSchema = z.record(z.string().min(1).max(64).regex(/^[a-z_]+$/u), githubPermissionLevelSchema)
  .refine((value) => Object.keys(value).length <= 64, "Too many permissions");

export const githubInstallationVerifyDataSchema = z.strictObject({
  connectionId: githubConnectionIdSchema,
  installationId: githubDecimalIdSchema
});
export type GithubInstallationVerifyData = z.infer<typeof githubInstallationVerifyDataSchema>;

export const githubInstallationRefreshDataSchema = z.strictObject({ connectionId: githubConnectionIdSchema });
export type GithubInstallationRefreshData = z.infer<typeof githubInstallationRefreshDataSchema>;

export const githubRepositoryResolveDataSchema = z.strictObject({
  connectionId: githubConnectionIdSchema,
  repositoryId: githubDecimalIdSchema
});
export type GithubRepositoryResolveData = z.infer<typeof githubRepositoryResolveDataSchema>;

export const githubConnectionInspectDataSchema = z.strictObject({ connectionId: githubConnectionIdSchema });
export const githubAppInspectionSchema = z.strictObject({
  configured: z.boolean(),
  appId: githubDecimalIdSchema.nullable(),
  expectedAccountId: githubDecimalIdSchema.nullable(),
  expectedAccountType: githubAccountTypeSchema.nullable(),
  installationUrl: z.string().url().max(2_048).nullable()
});
export type GithubAppInspection = z.infer<typeof githubAppInspectionSchema>;

export const githubInstallationInspectionSchema = z.strictObject({
  connectionId: githubConnectionIdSchema,
  installationId: githubDecimalIdSchema,
  accountId: githubDecimalIdSchema,
  accountType: githubAccountTypeSchema,
  accountLogin: z.string().min(1).max(255),
  repositorySelection: githubRepositorySelectionSchema,
  permissions: githubPermissionsSchema,
  status: z.enum(["connected", "degraded"]),
  verifiedAt: utcTimestampMsSchema,
  cleanupDegraded: z.boolean()
});
export type GithubInstallationInspection = z.infer<typeof githubInstallationInspectionSchema>;

export const githubContinuationSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/u);
export const githubRepositoriesListDataSchema = z.strictObject({
  connectionId: githubConnectionIdSchema,
  pageSize: z.number().int().min(1).max(100),
  continuation: githubContinuationSchema.optional()
});
export type GithubRepositoriesListData = z.infer<typeof githubRepositoriesListDataSchema>;

const githubOwnerLoginSchema = z.string().min(1).max(39).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u);
const githubRepositoryNameSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u);

const cleanGithubUrlSchema = z.string().min(1).max(2_048).superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username !== "" || url.password !== ""
      || url.port !== "" || url.search !== "" || url.hash !== "" || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u.test(url.pathname)) {
      context.addIssue({ code: "custom", message: "Repository URL is not canonical" });
    }
  } catch { context.addIssue({ code: "custom", message: "Repository URL is invalid" }); }
});

export const githubRepositorySchema = z.strictObject({
  repositoryId: githubDecimalIdSchema,
  ownerLogin: githubOwnerLoginSchema,
  name: githubRepositoryNameSchema,
  fullName: z.string().min(3).max(140),
  cleanHttpsUrl: cleanGithubUrlSchema,
  defaultBranch: z.string().min(1).max(255),
  private: z.boolean(), archived: z.boolean(), disabled: z.boolean()
}).superRefine((value, context) => {
  if (value.fullName !== `${value.ownerLogin}/${value.name}`) {
    context.addIssue({ code: "custom", path: ["fullName"], message: "Full name must match owner and repository name." });
  }
  if (value.cleanHttpsUrl !== `https://github.com/${value.fullName}.git`) {
    context.addIssue({ code: "custom", path: ["cleanHttpsUrl"], message: "Clean URL must match owner and repository name." });
  }
});
export type GithubRepository = z.infer<typeof githubRepositorySchema>;
export const githubRepositoryResolutionSchema = z.strictObject({
  repository: githubRepositorySchema,
  cleanupDegraded: z.boolean()
});
export const githubRepositoryPageSchema = z.strictObject({
  repositories: z.array(githubRepositorySchema).max(100),
  continuation: githubContinuationSchema.nullable(),
  cleanupDegraded: z.boolean()
});
export type GithubRepositoryPage = z.infer<typeof githubRepositoryPageSchema>;
export type GithubRepositoryResolution = z.infer<typeof githubRepositoryResolutionSchema>;
