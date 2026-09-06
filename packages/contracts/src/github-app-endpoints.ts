import { e, endpoint } from "./endpoints.js";
import { githubAppInspectionSchema, githubConnectionInspectDataSchema, githubInstallationInspectionSchema,
  githubInstallationRefreshDataSchema, githubInstallationVerifyDataSchema, githubRepositoriesListDataSchema,
  githubRepositoryPageSchema, githubRepositoryResolutionSchema, githubRepositoryResolveDataSchema } from "./github-app.js";

export const githubAgentApiV1Endpoints = Object.freeze([
  endpoint({ operation: "github.app.inspect", method: "GET", path: "/v1/github/app/inspect", classification: "non-mutating", successStatus: 200, successDataSchema: githubAppInspectionSchema, specificErrors: [e("GITHUB_AUTHORITY_INVALID")] }),
  endpoint({ operation: "github.installation.verify", method: "POST", path: "/v1/github/installations/verify", classification: "non-mutating", requestDataSchema: githubInstallationVerifyDataSchema, successStatus: 200, successDataSchema: githubInstallationInspectionSchema, specificErrors: [e("GITHUB_CONNECTION_NOT_FOUND"), e("GITHUB_AUTHORITY_INVALID"), e("GITHUB_INSTALLATION_UNAVAILABLE")] }),
  endpoint({ operation: "github.installation.inspect", method: "POST", path: "/v1/github/installations/inspect", classification: "non-mutating", requestDataSchema: githubConnectionInspectDataSchema, successStatus: 200, successDataSchema: githubInstallationInspectionSchema, specificErrors: [e("GITHUB_CONNECTION_NOT_FOUND"), e("GITHUB_AUTHORITY_INVALID"), e("GITHUB_INSTALLATION_UNAVAILABLE")] }),
  endpoint({ operation: "github.installation.refresh", method: "POST", path: "/v1/github/installations/refresh", classification: "non-mutating", requestDataSchema: githubInstallationRefreshDataSchema, successStatus: 200, successDataSchema: githubInstallationInspectionSchema, specificErrors: [e("GITHUB_CONNECTION_NOT_FOUND"), e("GITHUB_AUTHORITY_INVALID"), e("GITHUB_INSTALLATION_UNAVAILABLE")] }),
  endpoint({ operation: "github.repositories.list", method: "POST", path: "/v1/github/repositories/list", classification: "non-mutating", requestDataSchema: githubRepositoriesListDataSchema, successStatus: 200, successDataSchema: githubRepositoryPageSchema, specificErrors: [e("GITHUB_CONNECTION_NOT_FOUND"), e("GITHUB_AUTHORITY_INVALID"), e("GITHUB_INSTALLATION_UNAVAILABLE"), e("GITHUB_TOKEN_LEASE_ACTIVE")] }),
  endpoint({ operation: "github.repositories.resolve", method: "POST", path: "/v1/github/repositories/resolve", classification: "non-mutating", requestDataSchema: githubRepositoryResolveDataSchema, successStatus: 200, successDataSchema: githubRepositoryResolutionSchema, specificErrors: [e("GITHUB_CONNECTION_NOT_FOUND"), e("GITHUB_AUTHORITY_INVALID"), e("GITHUB_INSTALLATION_UNAVAILABLE"), e("GITHUB_REPOSITORY_NOT_AUTHORIZED"), e("GITHUB_CONTENTS_PERMISSION_REQUIRED"), e("GITHUB_TOKEN_LEASE_ACTIVE")] })
] as const);
export const githubAgentApiV1EndpointByOperation = Object.freeze(Object.fromEntries(
  githubAgentApiV1Endpoints.map((descriptor) => [descriptor.operation, descriptor])
) as { readonly [Endpoint in (typeof githubAgentApiV1Endpoints)[number] as Endpoint["operation"]]: Endpoint });
export type GithubAgentApiV1Operation = (typeof githubAgentApiV1Endpoints)[number]["operation"];
