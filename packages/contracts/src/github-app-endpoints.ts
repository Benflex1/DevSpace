import { e, endpoint } from "./endpoints.js";
import { githubAppInspectionSchema, githubConnectionInspectDataSchema, githubInstallationInspectionSchema,
  githubInstallationDisconnectDataSchema, githubInstallationReconnectPrepareDataSchema, githubInstallationRefreshDataSchema,
  githubInstallationVerifyDataSchema, githubLifecycleInspectionSchema, githubRepositoriesListDataSchema,
  githubRepositoryPageSchema, githubRepositoryResolutionSchema, githubRepositoryResolveDataSchema } from "./github-app.js";

const lifecycleErrors = [
  e("GITHUB_CONNECTION_NOT_FOUND"), e("GITHUB_CONNECTION_DISABLED"), e("GITHUB_AUTHORITY_GENERATION_STALE"),
  e("GITHUB_AUTHORITY_INVALID"), e("GITHUB_INSTALLATION_REMOVED"), e("GITHUB_INSTALLATION_SUSPENDED"),
  e("GITHUB_UPSTREAM_TRANSIENT"), e("GITHUB_TOKEN_LEASE_ACTIVE")
] as const;
const authorityErrors = [...lifecycleErrors, e("GITHUB_INSTALLATION_UNAVAILABLE")];

export const githubAgentApiV1Endpoints = Object.freeze([
  endpoint({ operation: "github.app.inspect", method: "GET", path: "/v1/github/app/inspect", classification: "non-mutating", successStatus: 200, successDataSchema: githubAppInspectionSchema, specificErrors: [e("GITHUB_AUTHORITY_INVALID")] }),
  endpoint({ operation: "github.installation.verify", method: "POST", path: "/v1/github/installations/verify", classification: "non-mutating", requestDataSchema: githubInstallationVerifyDataSchema, successStatus: 200, successDataSchema: githubInstallationInspectionSchema, specificErrors: authorityErrors }),
  endpoint({ operation: "github.installation.inspect", method: "POST", path: "/v1/github/installations/inspect", classification: "non-mutating", requestDataSchema: githubConnectionInspectDataSchema, successStatus: 200, successDataSchema: githubInstallationInspectionSchema, specificErrors: lifecycleErrors }),
  endpoint({ operation: "github.installation.refresh", method: "POST", path: "/v1/github/installations/refresh", classification: "non-mutating", requestDataSchema: githubInstallationRefreshDataSchema, successStatus: 200, successDataSchema: githubInstallationInspectionSchema, specificErrors: authorityErrors }),
  endpoint({ operation: "github.installation.disconnect", method: "POST", path: "/v1/github/installations/disconnect", classification: "non-mutating", requestDataSchema: githubInstallationDisconnectDataSchema, successStatus: 200, successDataSchema: githubLifecycleInspectionSchema, specificErrors: lifecycleErrors }),
  endpoint({ operation: "github.installation.reconnect.prepare", method: "POST", path: "/v1/github/installations/reconnect/prepare", classification: "non-mutating", requestDataSchema: githubInstallationReconnectPrepareDataSchema, successStatus: 200, successDataSchema: githubLifecycleInspectionSchema, specificErrors: lifecycleErrors }),
  endpoint({ operation: "github.repositories.list", method: "POST", path: "/v1/github/repositories/list", classification: "non-mutating", requestDataSchema: githubRepositoriesListDataSchema, successStatus: 200, successDataSchema: githubRepositoryPageSchema, specificErrors: authorityErrors }),
  endpoint({ operation: "github.repositories.resolve", method: "POST", path: "/v1/github/repositories/resolve", classification: "non-mutating", requestDataSchema: githubRepositoryResolveDataSchema, successStatus: 200, successDataSchema: githubRepositoryResolutionSchema, specificErrors: [...authorityErrors, e("GITHUB_REPOSITORY_NOT_AUTHORIZED"), e("GITHUB_REPOSITORY_ACCESS_UNAVAILABLE"), e("GITHUB_CONTENTS_PERMISSION_REQUIRED")] })
] as const);
export const githubAgentApiV1EndpointByOperation = Object.freeze(Object.fromEntries(
  githubAgentApiV1Endpoints.map((descriptor) => [descriptor.operation, descriptor])
) as { readonly [Endpoint in (typeof githubAgentApiV1Endpoints)[number] as Endpoint["operation"]]: Endpoint });
export type GithubAgentApiV1Operation = (typeof githubAgentApiV1Endpoints)[number]["operation"];
