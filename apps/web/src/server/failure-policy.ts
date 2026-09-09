import {
  completeAgentApiV1ErrorCodes,
  type CompleteAgentApiV1ErrorCode
} from "@devspace/contracts";

/**
 * Browser-safe Agent messages are owned by Web code, never by Agent response text.
 * This exhaustive record intentionally fails typechecking when the Agent inventory grows.
 */
export const agentFailureUserMessageByCode = Object.freeze({
  PROTOCOL_VERSION_UNSUPPORTED: "The DevSpace Agent protocol is incompatible.",
  REQUEST_INVALID: "The DevSpace Agent rejected the request.",
  OPERATION_CONFLICT: "The requested Agent operation conflicts with an existing operation.",
  OPERATION_JOURNAL_UNAVAILABLE: "The Agent operation journal is unavailable.",
  CONFIGURATION_INVALID: "The project configuration is invalid.",
  CONFIGURATION_NOT_REGISTERED: "The active project configuration is not registered with the Agent.",
  RUNTIME_POLICY_VIOLATION: "The requested action is not allowed by the runtime policy.",
  PROJECT_NOT_FOUND: "The Agent could not find the project.",
  RESOURCE_NOT_FOUND: "The Agent no longer has the requested resource.",
  WORKSPACE_PATH_INVALID: "The requested workspace path is invalid or not allowed.",
  WORKSPACE_FILE_NOT_FOUND: "The requested workspace file could not be found.",
  WORKSPACE_FILE_TOO_LARGE: "The workspace file is too large to edit.",
  WORKSPACE_DIRECTORY_TOO_LARGE: "This workspace directory has too many entries to display.",
  WORKSPACE_FILE_UNSUPPORTED: "The workspace file is binary or otherwise unsupported for text editing.",
  WORKSPACE_FILE_CHANGED: "The workspace file changed since it was opened. Reload it before saving again.",
  SOURCE_NOT_FOUND: "The repository source could not be found.",
  SOURCE_INVALID: "The repository source is not supported.",
  SOURCE_UNAVAILABLE: "The repository source is temporarily unavailable.",
  WORKSPACE_STATE_CONFLICT: "The workspace is not in a state that allows this action.",
  RESOURCE_STATE_CONFLICT: "The resource is not in a state that allows this action.",
  DIRTY_WORKSPACE_REQUIRES_ACTION: "The workspace has changes that require an explicit action.",
  TASK_NOT_DEFINED: "The requested task is not defined in the active configuration.",
  PROCESS_IDENTITY_MISMATCH: "The process identity changed before the action completed.",
  PREVIEW_NOT_DEFINED: "The requested preview is not defined in the active configuration.",
  AI_NOT_CONFIGURED: "AI is not configured for this workspace.",
  PREVIEW_DOMAIN_NOT_APPROVED: "The preview domain is not approved.",
  GATEWAY_UPDATE_FAILED: "The preview route could not be updated.",
  GITHUB_CONNECTION_NOT_FOUND: "The GitHub connection could not be found.",
  GITHUB_CONNECTION_DISABLED: "The GitHub connection is disconnected.",
  GITHUB_AUTHORITY_GENERATION_STALE: "The GitHub connection changed while the operation was starting.",
  GITHUB_AUTHORITY_INVALID: "GitHub App authority could not be verified safely.",
  GITHUB_INSTALLATION_REMOVED: "The GitHub App installation is no longer available.",
  GITHUB_INSTALLATION_SUSPENDED: "The GitHub App installation is suspended.",
  GITHUB_REPOSITORY_ACCESS_UNAVAILABLE: "The selected GitHub repository is no longer available to this connection.",
  GITHUB_UPSTREAM_TRANSIENT: "GitHub is temporarily unavailable. Try again.",
  GITHUB_CONTENTS_PERMISSION_REQUIRED: "GitHub Contents read permission is required for private Git operations.",
  GITHUB_CONTENTS_WRITE_PERMISSION_REQUIRED: "GitHub Contents write permission is required. Reauthorize the GitHub App connection.",
  GITHUB_INSTALLATION_UNAVAILABLE: "The GitHub App installation is unavailable.",
  GITHUB_REPOSITORY_NOT_AUTHORIZED: "The selected GitHub repository is no longer authorized.",
  GITHUB_GIT_AUTHENTICATION_FAILED: "GitHub rejected the private repository credential safely.",
  GITHUB_PUSH_INTENT_STALE: "The workspace branch or commit changed. Prepare the push again.",
  GITHUB_PUSH_NON_FAST_FORWARD: "Push was rejected because the remote branch moved. Fetch first, integrate the remote changes using Git or the terminal, then explicitly Push again.",
  GITHUB_PUSH_OUTCOME_UNCERTAIN: "The push outcome is uncertain. Inspect the remote branch before explicitly retrying.",
  GITHUB_TOKEN_LEASE_ACTIVE: "GitHub authority cleanup is still in progress.",
  GIT_NOTHING_TO_COMMIT: "There are no staged changes to commit.",
  GIT_COMMIT_MESSAGE_INVALID: "Enter a non-empty commit message within the allowed size.",
  GIT_IDENTITY_REQUIRED: "Enter a Git author name and email before committing.",
  GIT_OPERATION_FAILED: "The managed Git operation could not be completed safely.",
  ROOTLESS_RUNTIME_UNAVAILABLE: "The dedicated rootless runtime is unavailable.",
  AGENT_INTERNAL_ERROR: "The DevSpace Agent encountered an unexpected error.",
  EVENT_CURSOR_INVALID: "The Agent event cursor is invalid.",
  EVENT_SNAPSHOT_REQUIRED: "A fresh Agent snapshot is required."
} satisfies Readonly<Record<CompleteAgentApiV1ErrorCode, string>>);

export const webAgentFailureUserMessageByCode = Object.freeze({
  AGENT_UNAVAILABLE: "The DevSpace Agent is unavailable.",
  AGENT_REQUEST_TIMEOUT: "The DevSpace Agent request timed out.",
  AGENT_RESPONSE_TOO_LARGE: "The DevSpace Agent returned an invalid response.",
  AGENT_TRANSPORT_FAILURE: "The DevSpace Agent request could not be completed.",
  REQUEST_SERIALIZATION_FAILED: "The DevSpace Agent request could not be prepared safely.",
  MALFORMED_RESPONSE: "The DevSpace Agent returned an invalid response.",
  INVALID_RESPONSE_CONTRACT: "The DevSpace Agent returned an invalid response."
} as const);

export const webAgentFailureCodes = Object.freeze(
  Object.keys(webAgentFailureUserMessageByCode) as Array<keyof typeof webAgentFailureUserMessageByCode>
);

const agentFailureCodes = new Set<string>(completeAgentApiV1ErrorCodes);

export function isKnownAgentFailureCode(code: string): code is CompleteAgentApiV1ErrorCode {
  return agentFailureCodes.has(code);
}

export function codeOwnedFailureMessage(code: string): string | undefined {
  if (isKnownAgentFailureCode(code)) return agentFailureUserMessageByCode[code];
  return webAgentFailureUserMessageByCode[code as keyof typeof webAgentFailureUserMessageByCode];
}

export function persistedFailureMessage(code: string): string {
  return codeOwnedFailureMessage(code) ?? "The operation failed safely.";
}
