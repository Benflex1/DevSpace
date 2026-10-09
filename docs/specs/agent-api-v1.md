# Web to Workspace Agent Contract v1

## Scope and authority

This document is the authoritative wire contract between the DevSpace Web control plane and the
workspace Agent. It defines transport metadata and schemas only. It does not implement an HTTP
client, server, handler, Unix-socket connector, operation journal, terminal relay, runtime action,
or reconciliation loop.

The browser talks only to Web. Web is the sole client of the private Agent socket and the sole
SQLite writer. Web sends identifiers, requested actions, activated configuration identities, and
the small immutable inputs defined below. The Agent derives host paths, runtime namespaces,
container and network names, process identities, ports, and gateway targets. Outside the explicitly
versioned canonical Project Options document, no request accepts a shell command,
arbitrary process arguments, a PID, a Docker identifier, a host path, a bind mount, a host port, a
gateway upstream, or a Caddy configuration fragment. That document cannot bypass independent
Agent validation or the host boundary.

F09 historically declared 30 endpoints. Its 26 non-AI endpoints and all implemented behavior
remain unchanged. Its four never-implemented AI declarations are retained as historical
compatibility evidence but are formally superseded and must not be routed. F10 owns the two
general snapshot/event endpoints. F11 owns the ten first-class AI profile/session operations and
is the sole executable AI authority. The active complete inventory is therefore 38 endpoints:
26 non-AI F09, two F10, and ten F11. Historical F09, F10, and F11 registries remain separately
inspectable.

## Transport

- HTTP/1.1 runs over the fixed Unix domain socket `/run/devspace/agent.sock`.
- The protocol is REST-style and is not JSON-RPC.
- Every route uses the major-version prefix `/v1`.
- Ordinary JSON bodies use `Content-Type: application/json; charset=utf-8` and clients send
  `Accept: application/json`.
- A request that this contract says has no body must have no message body. It must not send an
  empty JSON object or `{ "data": {} }` as a substitute.
- Every request object, response object, error details object, and nested object is closed. Unknown
  properties are rejected. No v1 query parameter is accepted unless the endpoint table names it.
- JSON numbers used as integers must be mathematical integers in the stated range. Strings are not
  coerced to numbers, booleans, IDs, timestamps, or enums. `null` is accepted only where stated.

Unknown `/v1` routes return HTTP `404`. An unsupported major route such as `/v2` returns HTTP `426`
with `PROTOCOL_VERSION_UNSUPPORTED` when the Agent can form a v1 error envelope. There is no
best-effort interpretation of another major version.

The Unix socket is readable and writable only by the Web and Agent service identities. That peer
authorization is the Agent authentication boundary for every route, including terminal streaming.
No browser credential is forwarded to the Agent and the Agent is not exposed as a browser
authentication boundary. Web authenticates the browser and authorizes the requested project,
workspace, and resource before proxying any request or terminal stream over the protected socket.

## Primitive wire representations

The names below are normative reusable scalar schemas.

| Name | Exact representation |
| --- | --- |
| `UuidV7` | JSON string in canonical lowercase UUID textual form whose version nibble is `7` and variant is RFC 4122: `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`. Uppercase and non-v7 UUIDs are invalid. |
| `UtcTimestampMs` | JSON string matching `YYYY-MM-DDTHH:mm:ss.sssZ`, denoting a real RFC 3339 calendar instant in UTC. Exactly three fractional digits and literal uppercase `T` and `Z` are required. Leap seconds are not accepted. |
| `ProjectOptionsRevisionHash` | JSON string matching `^sha256-jcs-v1:[0-9a-f]{64}$`, produced by exactly the Project Options revision algorithm in `project-options-v1.md`. Contracts validate only this identity string and must not import or reimplement the algorithm. |
| `ConfigurationKey` | JSON string of 1 through 64 ASCII characters matching `^[a-z][a-z0-9-]{0,63}$`. |
| `GitObjectId` | JSON string of exactly 40 or 64 lowercase hexadecimal characters. |
| `GitBranchName` | A string accepted by the foundation `git-branch-shorthand` policy: non-empty; no NUL, ASCII control, whitespace, backslash, `~`, `^`, `:`, `?`, `*`, or `[`; no `..`, `@{`, lone `@`, leading `-`, leading/trailing `/`, repeated `//`, or trailing `.`; and no slash-delimited component beginning with `.` or ending with `.lock`. This is exactly the accepted F06 behavior, not a second contracts-owned grammar. |
| `GitPath` | A non-empty workspace-relative path of at most 4,096 UTF-8 bytes; Agent policy rejects absolute paths, backslashes, control characters, empty/dot/dot-dot components, and `.git` components. |
| `GitBaseRef` | Strict union `{ kind: "branch", branchName: GitBranchName } | { kind: "commit", commit: GitObjectId }`. Tags, revision expressions, reflog syntax, and arbitrary Git ref syntax are not accepted in v1. |
| `RemoteRepositoryUrl` | Absolute `https:` or `ssh:` URL of 1 through 2048 UTF-8 bytes, with a non-empty host, no fragment, and no control or whitespace character. HTTPS URLs have no user-info. SSH URLs may have a non-empty username but no password. Other schemes are invalid. Approval remains Agent policy. |
| `CanonicalJsonObjectText` | JSON string whose UTF-8 encoding is 2 through 2,097,152 bytes and is exactly the RFC 8785/JCS serialization of one JSON object. Duplicate keys, non-object roots, and non-canonical spellings are invalid. The upper bound is the same revision-level final canonical UTF-8 representation limit enforced by F08; exactly 2,097,152 bytes is valid and 2,097,153 is invalid. |
| `ErrorMessage` | JSON string of 1 through 512 Unicode scalar values with no C0/C1 control characters. It is safe for an operator but is not a stable programmatic discriminator. |
| `NonNegativeCount` | JSON integer from 0 through 2,147,483,647 inclusive. |
| `ExitCode` | JSON integer from -2,147,483,648 through 2,147,483,647 inclusive. |

All ID fields in this protocol use `UuidV7`, including IDs created by Web for new resources. The
resource type is always carried separately or is known from the field name; IDs have no prefix.

The following strict resource reference is used by errors:

```text
ResourceReference = {
  type: "project" | "workspace" | "task-run" | "process" | "terminal" |
        "preview" | "ai-session",
  id: UuidV7
}
```

`GitBranchName` has one future implementation authority. F09 implementation must extract the
existing pure branch-shorthand grammar and reason codes from `@devspace/security` into the public
API of `@devspace/domain`. `@devspace/contracts` will consume that domain primitive, while
`validateGitBranchName` from `@devspace/security` will delegate to it and preserve its existing
branded return type, error codes, details, and F06 behavior. Contracts must not import security or
copy the grammar. `GitBaseRef` composes that domain-owned branch primitive with the contracts-owned
exact object-ID representation.

## Common request metadata

Every F09 request, including bodyless GETs and the terminal upgrade, has exactly these DevSpace
headers in addition to normal HTTP headers:

```text
X-DevSpace-Protocol-Version: 1
X-DevSpace-Request-Id: <UuidV7>
X-DevSpace-Sent-At: <UtcTimestampMs>
```

`X-DevSpace-Protocol-Version` is the single ASCII digit `1`. A missing or malformed value on a
known v1 route produces HTTP `400` and `PROTOCOL_VERSION_UNSUPPORTED`; a syntactically valid
positive decimal integer other than `1` produces HTTP `426` with the same code. `requestId` is
unique per delivery attempt and has no idempotency meaning. `sentAt` is informational and does not
control authorization or ordering.

No other `X-DevSpace-*` header is accepted except the operation-ID header on mutation routes.
Standard HTTP hop-by-hop, content-negotiation, and WebSocket headers are governed by HTTP/1.1 and
RFC 6455 rather than this object contract.

Contract validation operates on a case-insensitively extracted DevSpace-header projection, not a
closed representation of the complete HTTP header collection. The extraction boundary ignores
ordinary transport, forwarding, tracing, proxy, and WebSocket headers; rejects unknown
`X-DevSpace-*` names; and rejects duplicate or ambiguous known DevSpace values before endpoint
schema validation.

Every POST request body is the strict envelope `{ "data": <EndpointRequestData> }`. `data` is
required and non-null. No endpoint in F09 defines body defaults. Omitted fields remain omitted only
when a field is explicitly called optional; F09 defines no optional request fields.

### Mutation headers and operation ownership

Every endpoint marked `mutation` in the inventory additionally requires exactly this header:

```text
X-DevSpace-Operation-Id: <UuidV7>
```

The operation ID appears only in `X-DevSpace-Operation-Id`; it is never duplicated in the request
body or generated by contract parsing. Before sending the request, Web creates this ID and its
SQLite operation row. The Agent never creates or writes that row. The operation ID is the sole
public idempotency identity.

The first durably accepted mutation for an operation ID binds that ID immutably to the stable
operation name and the complete validated request semantics. F09 stores the complete validated
request data in its private journal. F11 content-bearing operations use the dedicated private
AI-intent-reference policy defined below so content is not copied into that generic record. An
exact replay may return the previously
durable F09 response without repeating side effects. Reuse of the same ID for another operation
name or different validated request data returns `OPERATION_CONFLICT`. The Agent may compare a
private deterministic fingerprint in its durable journal. For F09 `generic-request` records its
format remains a private implementation detail; the F11 private-intent fingerprint is instead the
exact deep Agent-private contract defined below and is not a public Agent API field. F09 exposes no
idempotency key, request hash, expiry, or reuse-after-expiry behavior. Journal compaction must
preserve operation-ID reuse safety.

The Agent must durably record the immutable operation/request identity and acceptance before any
side effect. If the journal is unavailable or corrupt, a mutation fails with HTTP `503` and
`OPERATION_JOURNAL_UNAVAILABLE`. F09 specifies this boundary but implements neither storage nor
side effects. Non-mutating endpoints reject `X-DevSpace-Operation-Id` with `REQUEST_INVALID`; they
do not create operations or journal entries.

## Common response envelopes

Every ordinary success response is a strict object:

```text
SuccessEnvelope<Data> = {
  meta: {
    protocolVersion: 1,
    requestId: UuidV7,
    respondedAt: UtcTimestampMs
  },
  data: Data
}
```

`meta.requestId` exactly echoes the request ID. Ordinary non-mutating endpoints return HTTP `200`.
Every durably accepted mutation returns HTTP `202`, including an exact replay. F09 has no `204` or
synchronous `200` mutation variant.

All mutation success data starts with these fields:

```text
MutationReceipt = {
  operationId: UuidV7
}
```

`operationId` exactly echoes `X-DevSpace-Operation-Id`. The receipt means only that the Agent
durably accepted the immutable operation/request identity. It contains no Web-owned operation
lifecycle, Agent execution state, acceptance timestamp, completion timestamp, or implication that
asynchronous side effects started or completed.

Every ordinary error response is the strict object:

```text
ErrorEnvelope<Code> = {
  meta: {
    protocolVersion: 1,
    requestId: UuidV7,
    respondedAt: UtcTimestampMs
  },
  error: {
    code: Code,
    message: ErrorMessage,
    retryable: <the literal boolean registered for Code>,
    details: <the exact details object registered for Code>
  }
}
```

Success envelopes never contain `error`; error envelopes never contain `data`. An error message
may vary without changing semantics. Stack traces, raw exceptions, secret values, terminal bytes,
host paths, repository URLs, commands, Docker data, PIDs, and gateway configuration are forbidden
in both `message` and `details`.

## Historical F09 endpoint inventory

The exact historical F09 count is **30**: 20 journaled mutations, nine ordinary non-mutating HTTP operations,
and one non-mutating WebSocket upgrade. `none` in the Query column means no query parameters are
accepted. `none` in the Body column means no HTTP request body is permitted. `mutation` means the
operation-ID header is required; `non-mutating` means it is forbidden.

| Stable operation name | Method | Exact path | Query | Body data schema | Class | Success |
| --- | --- | --- | --- | --- | --- | --- |
| `agent.health.get` | GET | `/v1/health` | none | none | non-mutating | `200 HealthData` |
| `agent.capabilities.get` | GET | `/v1/capabilities` | none | none | non-mutating | `200 CapabilitiesData` |
| `agent.runtime-status.get` | GET | `/v1/runtime/status` | none | none | non-mutating | `200 RuntimeStatusData` |
| `configuration-revision.validate` | POST | `/v1/configuration-revisions/validate` | none | `ConfigurationRevisionData` | non-mutating | `200 ConfigurationValidationData` |
| `configuration-revision.register` | POST | `/v1/configuration-revisions/register` | none | `ConfigurationRevisionData` | mutation | `202 MutationReceipt` |
| `configuration-runtime-plan.register` | POST | `/v1/configuration-revisions/register-runtime-plan` | none | `ConfigurationRuntimePlanData` | mutation | `202 MutationReceipt` |
| `project.source.inspect` | POST | `/v1/projects/inspect-source` | none | `InspectSourceData` | non-mutating | `200 SourceInspectionData` |
| `project.managed-store.create` | POST | `/v1/projects/create-managed-store` | none | `CreateManagedStoreData` | mutation | `202 MutationReceipt` |
| `project.fetch` | POST | `/v1/projects/fetch` | none | `ProjectIdentityData` | mutation | `202 MutationReceipt` |
| `project.git.inspect` | POST | `/v1/projects/inspect-git` | none | `InspectGitData` | non-mutating | `200 GitInspectionData` |
| `workspace.create` | POST | `/v1/workspaces/create` | none | `CreateWorkspaceData` | mutation | `202 MutationReceipt` |
| `workspace.inspect` | POST | `/v1/workspaces/inspect` | none | `WorkspaceIdentityData` | non-mutating | `200 WorkspaceInspectionData` |
| `workspace.start` | POST | `/v1/workspaces/start` | none | `WorkspaceIdentityData` | mutation | `202 MutationReceipt` |
| `workspace.stop` | POST | `/v1/workspaces/stop` | none | `WorkspaceIdentityData` | mutation | `202 MutationReceipt` |
| `workspace.rebuild` | POST | `/v1/workspaces/rebuild` | none | `RebuildWorkspaceData` | mutation | `202 MutationReceipt` |
| `workspace.archive` | POST | `/v1/workspaces/archive` | none | `ArchiveWorkspaceData` | mutation | `202 MutationReceipt` |
| `workspace.remove` | POST | `/v1/workspaces/remove` | none | `RemoveWorkspaceData` | mutation | `202 MutationReceipt` |
| `task.start` | POST | `/v1/tasks/start` | none | `StartTaskData` | mutation | `202 MutationReceipt` |
| `process.stop` | POST | `/v1/processes/stop` | none | `ProcessIdentityData` | mutation | `202 MutationReceipt` |
| `process.inspect` | POST | `/v1/processes/inspect` | none | `ProcessIdentityData` | non-mutating | `200 ProcessInspectionData` |
| `terminal.create` | POST | `/v1/terminals/create` | none | `CreateTerminalData` | mutation | `202 MutationReceipt` |
| `terminal.close` | POST | `/v1/terminals/close` | none | `TerminalIdentityData` | mutation | `202 MutationReceipt` |
| `terminal.stream` | GET | `/v1/terminals/{terminalId}/stream` | none | none | non-mutating upgrade | `101 WebSocket` |
| `preview.activate` | POST | `/v1/previews/activate` | none | `ActivatePreviewData` | mutation | `202 MutationReceipt` |
| `preview.deactivate` | POST | `/v1/previews/deactivate` | none | `PreviewIdentityData` | mutation | `202 MutationReceipt` |
| `preview.inspect` | POST | `/v1/previews/inspect` | none | `PreviewIdentityData` | non-mutating | `200 PreviewInspectionData` |
| `ai-session.start` | POST | `/v1/ai-sessions/start` | none | `StartAiSessionData` | mutation | `202 MutationReceipt` |
| `ai-session.interrupt` | POST | `/v1/ai-sessions/interrupt` | none | `AiSessionIdentityData` | mutation | `202 MutationReceipt` |
| `ai-session.stop` | POST | `/v1/ai-sessions/stop` | none | `AiSessionIdentityData` | mutation | `202 MutationReceipt` |
| `ai-session.resume` | POST | `/v1/ai-sessions/resume` | none | `ResumeAiSessionData` | mutation | `202 MutationReceipt` |

The four `ai-session.*` rows above were never implemented. ADR 015 and F11 supersede their shapes,
errors, lifecycle assumptions, and operation applicability. They are excluded from the active
complete-v1 endpoint composition. The remaining 26 rows are unchanged and authoritative.

The only F09 path parameter is `terminalId`. It is one decoded path segment and must be a `UuidV7`;
percent-encoded or non-canonical UUID spellings are rejected.

## Workbench 1B Git Changes + Commit extension

Workbench 1B extends the existing managed-workspace Git inspection with bounded, workspace-scoped
diff and file-level index operations. These routes remain Agent operations against the exact managed
workspace derived from `{ projectId, workspaceId }`; Web never invokes Git and the browser never
submits a repository path, remote, refspec, command, or arbitrary Git arguments.

| Stable operation name | Method | Exact path | Body data schema | Class | Success |
| --- | --- | --- | --- | --- | --- |
| `project.git.diff` | POST | `/v1/projects/git-diff` | `GitDiffDataRequest` | non-mutating | `200 GitDiffData` |
| `project.git.stage` | POST | `/v1/projects/stage` | `GitWorkspaceFileData` | mutation | `202 MutationReceipt` |
| `project.git.unstage` | POST | `/v1/projects/unstage` | `GitWorkspaceFileData` | mutation | `202 MutationReceipt` |
| `project.git.commit` | POST | `/v1/projects/commit` | `GitCommitData` | mutation | `202 MutationReceipt` |

Git status uses bounded porcelain-v2 `-z` parsing. A workspace inspection returns at most 1,000
entries, with workspace-relative paths, optional rename source paths, staged and unstaged states,
untracked state, a file classification, branch, exact HEAD OID, and bounded ahead/behind counts.
The managed store inspection remains clean-state metadata and never exposes `.git` internals.

`project.git.diff` returns either bounded UTF-8 `oldContent`/`newContent` for staged (`HEAD → index`)
or unstaged (`index → worktree`) review, or an explicit unavailable reason for binary, oversized,
unsupported, or missing content. Untracked files use an empty old side. External diff drivers and
textconv are disabled; the Agent reads Git blobs and the managed worktree directly.

File-level stage and unstage accept only one bounded workspace-relative path. Staging uses
no-filter object hashing and direct index updates, preserving ordinary file mode bits and
deletions without invoking repository clean/process filters. Commit accepts only a bounded,
non-whitespace-only message, commits the staged index, returns the resulting exact HEAD OID through
the Web mutation result, and suppresses hooks, signing helpers, and editors. A local Git identity
is read without includes; when unavailable, bounded name/email values are supplied for that commit
only and are never written to Git config. Symlink, submodule, and other special-file cases remain
unsupported for this alpha slice.

## Active GitHub App endpoint extension

The active complete-v1 composition contains the historical Agent endpoints plus the eight GitHub App
operations below (46 endpoint descriptors in the generated contract inventory). The browser never
calls these endpoints directly; Web authenticates the actor, proves connection ownership, and calls
the Agent over its existing contract transport.

| Stable operation name | Method | Exact path | Body data schema | Class | Success |
| --- | --- | --- | --- | --- | --- |
| `github.app.inspect` | GET | `/v1/github/app/inspect` | none | non-mutating | `200 GithubAppInspection` |
| `github.installation.verify` | POST | `/v1/github/installations/verify` | `GithubInstallationVerifyData` | non-mutating | `200 GithubInstallationInspection` |
| `github.installation.inspect` | POST | `/v1/github/installations/inspect` | `GithubConnectionInspectData` | non-mutating | `200 GithubInstallationInspection` |
| `github.installation.refresh` | POST | `/v1/github/installations/refresh` | `GithubInstallationRefreshData` | non-mutating | `200 GithubInstallationInspection` |
| `github.installation.disconnect` | POST | `/v1/github/installations/disconnect` | `GithubInstallationDisconnectData` | lifecycle control | `200 GithubLifecycleInspection` |
| `github.installation.reconnect.prepare` | POST | `/v1/github/installations/reconnect/prepare` | `GithubInstallationReconnectPrepareData` | lifecycle control | `200 GithubLifecycleInspection` |
| `github.repositories.list` | POST | `/v1/github/repositories/list` | `GithubRepositoriesListData` | non-mutating | `200 GithubRepositoryPage` |
| `github.repositories.resolve` | POST | `/v1/github/repositories/resolve` | `GithubRepositoryResolveData` | non-mutating | `200 GithubRepositoryResolution` |

`GithubDecimalId` is a canonical decimal string with no leading zero except `0`, retained as a
string internally even when the upstream JSON representation is numeric. `GithubRepository` is
safe metadata only: `{ repositoryId, ownerLogin, name, fullName, cleanHttpsUrl, defaultBranch,
private, archived, disabled }`. `cleanHttpsUrl` is derived and validated as
`https://github.com/<owner>/<name>.git`; it is never an authority input for a GitHub App source.

`github.installation.refresh` repeats App and exact-installation proof and atomically refreshes the
safe installation permission snapshot. Private repository list, resolve, inspect, clone, and fetch
requests carry the expected lifecycle generation where the caller has a retained connection. The
Agent checks that generation immediately before token mint and again immediately before an
authenticated Git launch. `github.installation.disconnect` advances a durable disabled generation;
the Agent may return `disconnect-pending` while bounded token work settles. Reconnect preparation
accepts only the next generation after conservative token-lease settlement. Neither lifecycle
operation deletes a project or workspace. `github.repositories.resolve` accepts only a connection
ID and immutable repository ID; a browser cannot submit a repository URL, owner, name, or full name
for this source variant.

## Request data schemas

Every object and union variant below is strict. Every displayed field is required and non-null
unless its type explicitly includes `null`. There are no implicit defaults.

### Configuration revision shapes

```text
ConfigurationDocument = {
  format: "devspace.project-options/v1",
  hash: ProjectOptionsRevisionHash,
  canonicalJson: CanonicalJsonObjectText
}

ConfigurationRevisionData = {
  projectId: UuidV7,
  revisionId: UuidV7,
  configuration: ConfigurationDocument
}

RuntimePlanDocument = {
  format: "devspace.runtime-plan/v1",
  hash: ProjectOptionsRevisionHash,
  canonicalJson: CanonicalJsonObjectText
}

ConfigurationRuntimePlanData = {
  projectId: UuidV7,
  revisionId: UuidV7,
  revisionHash: ProjectOptionsRevisionHash,
  runtimePlan: RuntimePlanDocument
}
```

The configuration hash identifies the complete default-materialized Project Options revision. The
contract checks the representation and the Agent checks that it matches `canonicalJson`; neither
action imports Project Options parsing or hashing into `@devspace/contracts`. The runtime-plan
registration is deliberately separate so existing immutable configuration registration journal
entries remain valid. The Agent requires the revision first, then independently parses and compiles
the retained canonical Project Options and requires exact canonical-plan and hash equality.

### Source and project shapes

```text
SourceLocator =
  | {
      kind: "registered-local",
      sourceId: UuidV7
    }
  | {
      kind: "remote",
      url: RemoteRepositoryUrl
    }
  | {
      kind: "github-app",
      connectionId: GithubConnectionId,
      repositoryId: GithubDecimalId
    }

InspectSourceData = {
  source: SourceLocator
}

CreateManagedStoreData = {
  projectId: UuidV7,
  source: SourceLocator
}

ProjectIdentityData = {
  projectId: UuidV7
}

ProjectFetchData = {
  projectId: UuidV7,
  source?: SourceLocator
}

InspectGitData = {
  projectId: UuidV7,
  workspaceId: UuidV7 | null
}
```

A `registered-local` source ID names one administrator-configured source location. Requests never
carry its host path. A remote URL must contain no embedded credential. A `github-app` source is
authorized only by the exact `{ connectionId, repositoryId }` pair; its URL/name fields are
refreshable metadata and are not request authority. `workspaceId: null` asks for the managed project
store; a UUID asks for that project's independent workspace repository.

### Workspace shapes

```text
WorkspaceIdentityData = {
  projectId: UuidV7,
  workspaceId: UuidV7
}

RevisionIdentity = {
  revisionId: UuidV7,
  revisionHash: ProjectOptionsRevisionHash
}

CreateWorkspaceData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  projectSlug: ConfigurationKey,
  workspaceSlug: ConfigurationKey,
  kind: "primary" | "isolated",
  revision: RevisionIdentity,
  branchName: GitBranchName,
  baseRef: GitBaseRef
}

RebuildWorkspaceData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  revision: RevisionIdentity
}

ArchiveWorkspaceData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  dirtyHandling: "reject" | "preserve"
}

RemoveWorkspaceData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  dirtyHandling: "reject" | "discard"
}
```

`projectSlug` and `workspaceSlug` are Web-owned canonical identities. The Agent retains them in
its private workspace ownership record and uses them to validate later preview hostnames; they
are never browser input.

`branchName` is the validated initial branch for the workspace repository. `baseRef` is either one
validated branch name or one exact Git object ID from which it is initialized. The Agent resolves
both within the managed project store. The repository's refs and objects are private to that
workspace, so local branch switches and commits do not mutate another workspace's Git state. The
Agent's authenticated Push uses the currently inspected branch and commit and revalidates them
against the captured request. Archive with `preserve` retains the workspace repository and its
changes. Remove with `discard` explicitly authorizes destruction of uncommitted workspace changes.
`reject` fails if an isolated workspace is dirty. Primary-workspace policy may reject archive or
removal with `RUNTIME_POLICY_VIOLATION`.

### Task and process shapes

```text
StartTaskData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  taskRunId: UuidV7,
  processId: UuidV7,
  taskKey: ConfigurationKey
}

ProcessIdentityData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  processId: UuidV7
}
```

Project Options v1 defines no per-run task-input values. Consequently F09 accepts no `inputs`,
environment overrides, command, argument, working-directory, timeout, or container field. Web
creates `taskRunId` and `processId` before the request so they can be referenced consistently by
the operation row and later observations.

### Terminal shapes

```text
CreateTerminalData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  terminalId: UuidV7
}

TerminalIdentityData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  terminalId: UuidV7
}
```

No request chooses a shell, executable, argument, working directory, environment, user, or
container. Those values come from the registered revision and Agent policy. Web supplies
`terminalId` before creation.

### Preview shapes

```text
ActivatePreviewData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  revisionId: UuidV7,
  previewId: UuidV7,
  previewKey: ConfigurationKey,
  hostname: string,
  projectSlug: ConfigurationKey,
  workspaceSlug: ConfigurationKey
}

`hostname`, `projectSlug`, and `workspaceSlug` are an internal Web-to-Agent activation
boundary. The browser never supplies them. Web reads the exact persisted hostname and
slug identity from SQLite; Agent validates that hostname against the registered revision,
approved preview-base registry, pattern, and exact preview/workspace identity before it
stores or routes it.

PreviewIdentityData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  revisionId: UuidV7,
  previewId: UuidV7
}
```

Only activation carries the configuration key. Subsequent actions use the stable preview ID and
the owning workspace identity. The Agent retains the accepted key/revision association and derives
service, target port, hostname, and route.

### Historical superseded AI-session shapes

```text
StartAiSessionData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  aiSessionId: UuidV7
}

AiSessionIdentityData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  aiSessionId: UuidV7
}

ResumeAiSessionData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  sourceAiSessionId: UuidV7,
  aiSessionId: UuidV7
}
```

These shapes document the dormant F09 declaration only and must not be accepted by a route. No request accepts provider credentials, an executable, arguments, prompt text, environment
overrides, or terminal bytes. Start uses the singular `aiProfile` in the workspace's registered
Project Options revision; it carries no profile key and duplicates none of the profile fields. A
null `aiProfile` fails with `AI_NOT_CONFIGURED`. Resume requires a retained source session in
`stopped`, creates the distinct caller-supplied `aiSessionId` in `creating`, and uses the source
session's retained approved profile/provider resume identity. The source session remains `stopped`.
`sourceAiSessionId` and `aiSessionId` must differ. Failed or lost sessions cannot be resume sources.

## Success data schemas

All schemas below are the `data` member of `SuccessEnvelope`. Arrays are required, contain unique
values, and have the stated order.

```text
HealthData = {
  status: "ok" | "degraded"
}

CapabilitiesData = {
  protocolVersion: 1,
  terminalSubprotocol: "devspace.terminal.v1"
}
```

`/v1/capabilities` returns fixed protocol metadata, not feature negotiation. Every executable F09
endpoint is mandatory for a conforming v1 Agent. Temporary dependency unavailability is reported
by runtime status or route errors and never by omitting endpoint support.

```text
RuntimeStatusData = {
  rootlessRuntime: "available" | "unavailable",
  operationJournal: "available" | "unavailable" | "corrupt",
  checkedAt: UtcTimestampMs
}

ConfigurationValidationData = {
  valid: true,
  revisionId: UuidV7,
  configurationHash: ProjectOptionsRevisionHash
}
```

An invalid configuration is an error response; `valid: false` is not a success variant.

Every F09 mutation uses exactly `MutationReceipt` as its success data. Project, workspace, task-run,
process, terminal, preview, and AI-session IDs are already caller-supplied, so the Agent does not
echo them merely for convenience.

### Inspection response shapes

```text
PublicSourceInspectionData = {
  sourceKind: "registered-local" | "remote",
  isGitRepository: boolean,
  defaultBranch: GitBranchName | null,
  headCommit: GitObjectId | null
}

GithubSourceInspectionData = {
  sourceKind: "github-app",
  isGitRepository: boolean,
  defaultBranch: GitBranchName | null,
  headCommit: GitObjectId | null,
  repository: GithubRepository,
  cleanupDegraded: boolean
}

SourceInspectionData = PublicSourceInspectionData | GithubSourceInspectionData
```

`defaultBranch` and `headCommit` are both null when `isGitRepository` is false. A Git repository
may have an unborn default branch, in which case `defaultBranch` is non-null and `headCommit` is
null. The GitHub variant also returns validated safe metadata and cleanup-degraded status; it uses
the exact scoped read token and bounded askpass path for `git ls-remote --symref … HEAD`.

```text
GitInspectionData = {
  projectId: UuidV7,
  workspaceId: UuidV7 | null,
  branchName: GitBranchName | null,
  headCommit: GitObjectId | null,
  dirty: boolean,
  aheadCount: NonNegativeCount,
  behindCount: NonNegativeCount,
  files: GitStatusEntry[0..1000],
  identity: GitIdentityData
}
```

For the managed store (`workspaceId: null`), `dirty` is always false. `branchName` and `headCommit`
may be null for an unborn repository state. Counts are relative to the configured upstream; both
are zero when no upstream is configured.

```text
GitStatusEntry = {
  path: bounded workspace-relative GitPath,
  oldPath: bounded GitPath | null,
  stagedState: "unchanged" | "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked",
  unstagedState: "unchanged" | "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked",
  untracked: boolean,
  classification: "added" | "modified" | "deleted" | "renamed" | "copied"
}

GitIdentityData = {
  name: bounded non-control string | null,
  email: bounded non-control string | null
}

GitDiffDataRequest = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  path: GitPath,
  kind: "staged" | "unstaged"
}

GitDiffData = {
  available: true,
  projectId: UuidV7,
  workspaceId: UuidV7,
  path: GitPath,
  oldPath: GitPath | null,
  kind: "staged" | "unstaged",
  oldContent: bounded UTF-8 text,
  newContent: bounded UTF-8 text
}
| {
  available: false,
  projectId: UuidV7,
  workspaceId: UuidV7,
  path: GitPath,
  oldPath: GitPath | null,
  kind: "staged" | "unstaged",
  reason: "binary" | "too-large" | "unsupported" | "not-found"
}
```

The lifecycle enum values below exactly reuse the accepted domain values:

```text
WorkspaceDesiredState = "stopped" | "running" | "archived" | "removed"
WorkspaceObservedState = "provisioning" | "stopped" | "starting" | "running" |
  "stopping" | "degraded" | "failed" | "lost" | "archived" | "removed"
RuntimeStackDesiredState = "absent" | "stopped" | "running"
RuntimeStackObservedState = "absent" | "creating" | "stopped" | "starting" |
  "running" | "stopping" | "degraded" | "failed" | "removing" | "lost"
ProcessDesiredState = "running" | "stopped"
ProcessObservedState = "queued" | "starting" | "running" | "stopping" | "exited" |
  "failed" | "killed" | "lost"
PreviewDesiredState = "inactive" | "active"
PreviewObservedState = "inactive" | "starting" | "healthy" | "unhealthy" |
  "stopping" | "failed" | "lost"
```

```text
WorkspaceInspectionData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  kind: "primary" | "isolated",
  revisionId: UuidV7,
  revisionHash: ProjectOptionsRevisionHash,
  desiredState: WorkspaceDesiredState,
  observedState: WorkspaceObservedState,
  dirty: boolean,
  runtimeStack: {
    desiredState: RuntimeStackDesiredState,
    observedState: RuntimeStackObservedState
  }
}

ProcessInspectionData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  processId: UuidV7,
  kind: "task" | "terminal" | "ai-session",
  desiredState: ProcessDesiredState,
  observedState: ProcessObservedState,
  exitCode: ExitCode | null,
  startedAt: UtcTimestampMs | null,
  finishedAt: UtcTimestampMs | null
}
```

The exact timestamp relationships are:

- `queued`: `startedAt` and `finishedAt` are null;
- `starting`: `startedAt` is null or non-null according to whether process creation has completed,
  and `finishedAt` is null;
- `running` or `stopping`: `startedAt` is non-null and `finishedAt` is null;
- `exited`, `failed`, or `killed`: `finishedAt` is non-null and `startedAt` is nullable, allowing a
  queued process to fail or be killed before it starts;
- `lost`: `startedAt` is nullable and `finishedAt` is null because a recovered terminal outcome
  transitions to its terminal state.

`exitCode` is null for every non-terminal state and may be either an `ExitCode` or null for a
terminal state, because a manually terminated or unrecoverable outcome may have no code.

```text
PreviewInspectionData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  previewId: UuidV7,
  previewKey: ConfigurationKey,
  desiredState: PreviewDesiredState,
  observedState: PreviewObservedState,
  routePresent: boolean,
  hostname: string
}
```

`hostname` is always the materialized lowercase ASCII DNS hostname of 1 through 253 characters,
including while the preview is Waiting and no route is present. Labels are 1 through 63 characters,
match `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, and are separated by literal dots. `routePresent` is an
independent readiness signal and must be false when the observed state is `inactive`, `failed`, or
`lost`.

## Stable error registry

The executable registry contains **36 codes**: the historical F09 errors plus the thirteen GitHub App
authority/credential errors below. Retryability is a literal part of each code's
schema. `EmptyDetails` means the exact strict object `{}`. F10 error names retained later in this
document are not members of this registry, F09 runtime schemas, exports, or fixtures.

| Code | Meaning | Status | Retryable | Exact details schema | Scope |
| --- | --- | --- | --- | --- | --- |
| `PROTOCOL_VERSION_UNSUPPORTED` | Protocol metadata or major version is missing, malformed, or unsupported. | `400` or `426` as defined under request metadata | false | `{ supportedProtocolVersion: 1, receivedProtocolVersion: integer from 1 through 2,147,483,647 or null }` | global |
| `REQUEST_INVALID` | Headers, path, query, envelope, or endpoint data violate the strict wire schema. | `400` | false | `{ location: one of ("headers", "path", "query", "body"), field: string or null, reason: one of ("missing", "malformed", "unknown", "inconsistent") }`; non-null `field` is 1..128 ASCII letters, digits, `.`, `[`, `]`, `_`, or `-` | global |
| `OPERATION_CONFLICT` | An operation ID is already bound to another stable operation name or validated request. | `409` | false | `{ operationId: UuidV7, reason: one of ("operation-name-mismatch", "request-mismatch") }` | mutations |
| `OPERATION_JOURNAL_UNAVAILABLE` | The required durable journal is unavailable or corrupt, so no side effect was accepted. | `503` | true | `{ reason: one of ("unavailable", "corrupt") }` | mutations |
| `CONFIGURATION_INVALID` | Project Options content, its canonical form, or its declared revision hash is invalid. | `422` | false | `{ revisionId: UuidV7, reason: one of ("configuration-format", "configuration-hash", "cross-reference") }` | route-specific |
| `CONFIGURATION_NOT_REGISTERED` | The exact revision ID/hash pair required by the request is not registered. | `422` | false | `{ revisionId: UuidV7, revisionHash: ProjectOptionsRevisionHash }` | route-specific |
| `RUNTIME_POLICY_VIOLATION` | Structurally valid intent violates an Agent runtime/host policy. | `422` | false | `{ policy: one of ("source-not-approved", "workspace-action-rejected", "task-action-rejected", "terminal-action-rejected", "preview-action-rejected", "ai-profile-rejected") }` | route-specific |
| `PROJECT_NOT_FOUND` | The referenced permitted project is absent from Agent-owned state. | `404` | false | `{ projectId: UuidV7 }` | route-specific |
| `RESOURCE_NOT_FOUND` | A non-project resource is absent or not owned by the supplied parent identities. | `404` | false | `{ resource: ResourceReference }` | route-specific |
| `SOURCE_NOT_FOUND` | A registered local source ID is unknown. | `404` | false | `{ sourceId: UuidV7 }` | route-specific |
| `SOURCE_INVALID` | The selected source cannot form a managed Git project store. | `422` | false | `{ reason: one of ("not-a-git-repository", "unsupported-repository-format") }` | route-specific |
| `SOURCE_UNAVAILABLE` | An approved source cannot currently be read or fetched. | `503` | true | `EmptyDetails` | route-specific |
| `WORKSPACE_STATE_CONFLICT` | The requested workspace action is illegal from its current desired/observed states. | `409` | false | `{ workspaceId: UuidV7, desiredState: WorkspaceDesiredState, observedState: WorkspaceObservedState, action: one of ("create", "start", "stop", "rebuild", "archive", "remove", "run-task", "create-terminal", "activate-preview", "start-ai-session") }` | route-specific |
| `RESOURCE_STATE_CONFLICT` | A non-workspace resource cannot perform the requested action in its current retained state or its caller-supplied ID is already bound incompatibly. | `409` | false | `{ resource: ResourceReference, action: one of ("create", "start", "stop", "close", "attach", "activate", "deactivate", "interrupt", "resume") }` | route-specific |
| `DIRTY_WORKSPACE_REQUIRES_ACTION` | A dirty isolated workspace requires an allowed explicit handling choice. | `409` | false | `{ workspaceId: UuidV7, requestedAction: one of ("archive", "remove") }` | route-specific |
| `TASK_NOT_DEFINED` | The registered revision does not define the requested task key. | `422` | false | `{ revisionId: UuidV7, taskKey: ConfigurationKey }` | route-specific |
| `PROCESS_IDENTITY_MISMATCH` | Retained process ownership and exact runtime evidence do not match the live process. | `409` | false | `{ processId: UuidV7 }` | route-specific |
| `PREVIEW_NOT_DEFINED` | The registered revision does not define the requested preview key. | `422` | false | `{ revisionId: UuidV7, previewKey: ConfigurationKey }` | route-specific |
| `AI_NOT_CONFIGURED` | The workspace's registered Project Options revision has `aiProfile: null`. | `422` | false | `{ workspaceId: UuidV7, revisionId: UuidV7 }` | route-specific |
| `PREVIEW_DOMAIN_NOT_APPROVED` | The Web-materialized preview hostname is malformed, outside the approved domain registry, or inconsistent with the exact revision pattern and identity. | `422` | false | `{ previewId: UuidV7 }` | route-specific |
| `GATEWAY_UPDATE_FAILED` | The narrow preview gateway adapter could not apply the derived route update. | `503` | true | `{ previewId: UuidV7 }` | route-specific |
| `GITHUB_CONNECTION_NOT_FOUND` | The requested retained GitHub connection is absent from Agent-private state. | `404` | false | `{}` | GitHub routes |
| `GITHUB_CONNECTION_DISABLED` | The retained connection is fenced or disconnected and cannot admit new private work. | `409` | false | `{}` | GitHub/private Git routes |
| `GITHUB_AUTHORITY_GENERATION_STALE` | The request carries an older or otherwise stale lifecycle generation. | `409` | false | `{}` | GitHub/private Git routes |
| `GITHUB_AUTHORITY_INVALID` | App or installation identity/configuration proof failed. | `409`, `422`, or `503` | false | `{ reason: one of ("unconfigured", "invalid", "mismatch", "suspended", "upstream-unavailable", "permission-required") }` | GitHub routes |
| `GITHUB_INSTALLATION_REMOVED` | The exact GitHub installation no longer exists. | `410` | false | `{}` | GitHub/private Git routes |
| `GITHUB_INSTALLATION_SUSPENDED` | GitHub reports the exact installation as suspended. | `403` | false | `{}` | GitHub/private Git routes |
| `GITHUB_REPOSITORY_ACCESS_UNAVAILABLE` | The immutable repository ID is no longer selected or available to the installation. | `403` or `404` | false | `{}` | GitHub/private Git routes |
| `GITHUB_UPSTREAM_TRANSIENT` | GitHub, network, rate-limit, or 5xx transport failed without proving authority loss. | `503` | true | `{}` | GitHub/private Git routes |
| `GITHUB_TOKEN_LEASE_ACTIVE` | A prior or concurrent token transaction remains conservatively blocked. | `503` | true | `{}` | GitHub/private Git routes |
| `GITHUB_CONTENTS_PERMISSION_REQUIRED` | The live installation lacks effective Contents permission for private Git. | `403` or `422` | false | `{}` | GitHub/private Git routes |
| `GITHUB_INSTALLATION_UNAVAILABLE` | The bound installation is missing, suspended, or unavailable. | `503` | true | `{}` | GitHub/private Git routes |
| `GITHUB_REPOSITORY_NOT_AUTHORIZED` | The exact repository ID is missing, unselected, foreign, or not returned by scoped mint validation. | `403` or `404` | false | `{}` | GitHub/private Git routes |
| `GITHUB_GIT_AUTHENTICATION_FAILED` | Git rejected a freshly delivered exact-repository credential. | `502` or `503` | false | `{}` | private Git routes |
| `GIT_NOTHING_TO_COMMIT` | The workspace index contains no staged changes. | `409` | false | `{}` | Workbench Git commit |
| `GIT_COMMIT_MESSAGE_INVALID` | The commit message is empty/whitespace-only or exceeds the bounded size. | `422` | false | `{ reason: "empty" | "too-large" }` | Workbench Git commit |
| `GIT_IDENTITY_REQUIRED` | Neither usable local identity nor bounded per-commit name/email input is available. | `422` | false | `{}` | Workbench Git commit |
| `GIT_OPERATION_FAILED` | A bounded managed-workspace Git operation could not complete safely. | `409` or `503` | false | `{ action: "inspect" | "diff" | "stage" | "unstage" | "commit" }` | Workbench Git routes |
| `GIT_MUTATION_OUTCOME_UNCERTAIN` | The Agent cannot prove whether a local Git mutation completed before interruption; inspect the repository state before explicitly continuing. | `503` | false | `{}` | Workbench Git mutations |
| `ROOTLESS_RUNTIME_UNAVAILABLE` | The dedicated rootless runtime required by the route is unavailable. | `503` | true | `{ component: "docker" }` | route-specific |
| `AGENT_INTERNAL_ERROR` | An unexpected redacted Agent failure occurred. | `500` | true | `{ incidentId: UuidV7 }` | global |

## Route-specific error applicability

The following named sets make the table concise without making it open-ended:

- `G` = `PROTOCOL_VERSION_UNSUPPORTED (400/426)`, `REQUEST_INVALID (400)`,
  `AGENT_INTERNAL_ERROR (500)`.
- `M` = `OPERATION_CONFLICT (409)`, `OPERATION_JOURNAL_UNAVAILABLE (503)`; `M` is added only to
  mutations.
- `H` = `GITHUB_CONNECTION_DISABLED (409)`, `GITHUB_AUTHORITY_GENERATION_STALE (409)`,
  `GITHUB_INSTALLATION_REMOVED (410)`, `GITHUB_INSTALLATION_SUSPENDED (403)`,
  `GITHUB_REPOSITORY_ACCESS_UNAVAILABLE (403/404)`, and `GITHUB_UPSTREAM_TRANSIENT (503)`.
- `W` = `G` before a terminal WebSocket upgrade. After a successful upgrade, WebSocket close
  semantics replace JSON errors.

Each row below is exhaustive: the endpoint accepts exactly the union of its named sets and listed
specific codes. A status in parentheses is the only status for that endpoint/code combination,
except the already-exact `G` protocol-version mapping.

| Operation | Exact applicable errors |
| --- | --- |
| `agent.health.get` | `G` |
| `agent.capabilities.get` | `G` |
| `agent.runtime-status.get` | `G` |
| `configuration-revision.validate` | `G`; `CONFIGURATION_INVALID (422)` |
| `configuration-revision.register` | `G`; `M`; `CONFIGURATION_INVALID (422)` |
| `configuration-runtime-plan.register` | `G`; `M`; `CONFIGURATION_NOT_REGISTERED (422)`; `CONFIGURATION_INVALID (422)`; `RUNTIME_POLICY_VIOLATION (422; policy runtime-plan-mismatch)` |
| `project.source.inspect` | `G`; `SOURCE_NOT_FOUND (404)`; `SOURCE_UNAVAILABLE (503)`; `H`; `GITHUB_AUTHORITY_INVALID (409/422/503)`; `GITHUB_INSTALLATION_UNAVAILABLE (503)`; `GITHUB_REPOSITORY_NOT_AUTHORIZED (403/404)`; `GITHUB_CONTENTS_PERMISSION_REQUIRED (403/422)`; `GITHUB_GIT_AUTHENTICATION_FAILED (502/503)`; `GITHUB_TOKEN_LEASE_ACTIVE (503)`; `RUNTIME_POLICY_VIOLATION (422)` |
| `project.managed-store.create` | `G`; `M`; `RESOURCE_STATE_CONFLICT` (409; type `project`); `SOURCE_NOT_FOUND (404)`; `SOURCE_INVALID (422)`; `SOURCE_UNAVAILABLE (503)`; `H`; `GITHUB_AUTHORITY_INVALID (409/422/503)`; `GITHUB_INSTALLATION_UNAVAILABLE (503)`; `GITHUB_REPOSITORY_NOT_AUTHORIZED (403/404)`; `GITHUB_CONTENTS_PERMISSION_REQUIRED (403/422)`; `GITHUB_GIT_AUTHENTICATION_FAILED (502/503)`; `GITHUB_TOKEN_LEASE_ACTIVE (503)`; `RUNTIME_POLICY_VIOLATION (422)` |
| `project.fetch` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `SOURCE_UNAVAILABLE (503)`; `H`; `GITHUB_AUTHORITY_INVALID (409/422/503)`; `GITHUB_INSTALLATION_UNAVAILABLE (503)`; `GITHUB_REPOSITORY_NOT_AUTHORIZED (403/404)`; `GITHUB_CONTENTS_PERMISSION_REQUIRED (403/422)`; `GITHUB_GIT_AUTHENTICATION_FAILED (502/503)`; `GITHUB_TOKEN_LEASE_ACTIVE (503)` |
| `github.app.inspect` | `G`; `GITHUB_AUTHORITY_INVALID (409/422/503)` |
| `github.installation.verify` | `G`; `GITHUB_CONNECTION_NOT_FOUND (404)`; `GITHUB_AUTHORITY_INVALID (409/422/503)`; `H`; `GITHUB_INSTALLATION_UNAVAILABLE (503)` |
| `github.installation.inspect` | `G`; `GITHUB_CONNECTION_NOT_FOUND (404)`; `GITHUB_AUTHORITY_INVALID (409/422/503)`; `H`; `GITHUB_INSTALLATION_UNAVAILABLE (503)` |
| `github.installation.refresh` | `G`; `GITHUB_CONNECTION_NOT_FOUND (404)`; `GITHUB_AUTHORITY_INVALID (409/422/503)`; `H`; `GITHUB_INSTALLATION_UNAVAILABLE (503)` |
| `github.installation.disconnect` | `G`; `GITHUB_CONNECTION_NOT_FOUND (404)`; `GITHUB_CONNECTION_DISABLED (409)`; `GITHUB_AUTHORITY_GENERATION_STALE (409)`; `GITHUB_TOKEN_LEASE_ACTIVE (503)`; `AGENT_INTERNAL_ERROR (500)` |
| `github.installation.reconnect.prepare` | `G`; `GITHUB_CONNECTION_NOT_FOUND (404)`; `GITHUB_AUTHORITY_GENERATION_STALE (409)`; `GITHUB_TOKEN_LEASE_ACTIVE (503)`; `GITHUB_AUTHORITY_INVALID (409/422/503)`; `AGENT_INTERNAL_ERROR (500)` |
| `github.repositories.list` | `G`; `GITHUB_CONNECTION_NOT_FOUND (404)`; `GITHUB_AUTHORITY_INVALID (409/422/503)`; `H`; `GITHUB_INSTALLATION_UNAVAILABLE (503)`; `GITHUB_TOKEN_LEASE_ACTIVE (503)` |
| `github.repositories.resolve` | `G`; `GITHUB_CONNECTION_NOT_FOUND (404)`; `GITHUB_AUTHORITY_INVALID (409/422/503)`; `H`; `GITHUB_INSTALLATION_UNAVAILABLE (503)`; `GITHUB_REPOSITORY_NOT_AUTHORIZED (403/404)`; `GITHUB_CONTENTS_PERMISSION_REQUIRED (403/422)`; `GITHUB_TOKEN_LEASE_ACTIVE (503)` |
| `project.git.inspect` | `G`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace`); `SOURCE_UNAVAILABLE (503)`; `GIT_OPERATION_FAILED (409/503)` |
| `project.git.diff` | `G`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace`); `WORKSPACE_PATH_INVALID (422)`; `WORKSPACE_FILE_NOT_FOUND (404)`; `GIT_OPERATION_FAILED (409/503)` |
| `project.git.stage` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace`); `WORKSPACE_PATH_INVALID (422)`; `WORKSPACE_FILE_NOT_FOUND (404)`; `WORKSPACE_FILE_UNSUPPORTED (422)`; `GIT_OPERATION_FAILED (409/503)`; `GIT_MUTATION_OUTCOME_UNCERTAIN (503)` |
| `project.git.unstage` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace`); `WORKSPACE_PATH_INVALID (422)`; `WORKSPACE_FILE_NOT_FOUND (404)`; `GIT_OPERATION_FAILED (409/503)`; `GIT_MUTATION_OUTCOME_UNCERTAIN (503)` |
| `project.git.commit` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace`); `GIT_NOTHING_TO_COMMIT (409)`; `GIT_COMMIT_MESSAGE_INVALID (422)`; `GIT_IDENTITY_REQUIRED (422)`; `GIT_OPERATION_FAILED (409/503)`; `GIT_MUTATION_OUTCOME_UNCERTAIN (503)` |
| `workspace.create` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `CONFIGURATION_NOT_REGISTERED (422)`; `WORKSPACE_STATE_CONFLICT (409)`; `RUNTIME_POLICY_VIOLATION (422)`; `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `workspace.inspect` | `G`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace`); `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `workspace.start` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace`); `CONFIGURATION_NOT_REGISTERED (422)`; `WORKSPACE_STATE_CONFLICT (409)`; `RUNTIME_POLICY_VIOLATION (422)`; `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `workspace.stop` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace`); `WORKSPACE_STATE_CONFLICT (409)`; `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `workspace.rebuild` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace`); `CONFIGURATION_NOT_REGISTERED (422)`; `WORKSPACE_STATE_CONFLICT (409)`; `RUNTIME_POLICY_VIOLATION (422)`; `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `workspace.archive` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace`); `WORKSPACE_STATE_CONFLICT (409)`; `DIRTY_WORKSPACE_REQUIRES_ACTION (409)`; `RUNTIME_POLICY_VIOLATION (422)`; `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `workspace.remove` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace`); `WORKSPACE_STATE_CONFLICT (409)`; `DIRTY_WORKSPACE_REQUIRES_ACTION (409)`; `RUNTIME_POLICY_VIOLATION (422)`; `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `task.start` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace`); `CONFIGURATION_NOT_REGISTERED (422)`; `WORKSPACE_STATE_CONFLICT (409)`; `RESOURCE_STATE_CONFLICT` (409; type `task-run` or `process`); `TASK_NOT_DEFINED (422)`; `RUNTIME_POLICY_VIOLATION (422)`; `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `process.stop` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace` or `process`); `RESOURCE_STATE_CONFLICT` (409; type `process`); `PROCESS_IDENTITY_MISMATCH (409)`; `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `process.inspect` | `G`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace` or `process`); `PROCESS_IDENTITY_MISMATCH (409)`; `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `terminal.create` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace`); `CONFIGURATION_NOT_REGISTERED (422)`; `WORKSPACE_STATE_CONFLICT (409)`; `RESOURCE_STATE_CONFLICT` (409; type `terminal`); `RUNTIME_POLICY_VIOLATION (422)`; `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `terminal.close` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace` or `terminal`); `RESOURCE_STATE_CONFLICT` (409; type `terminal`); `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `terminal.stream` | `W`; `RESOURCE_NOT_FOUND` (404; type `terminal`); `RESOURCE_STATE_CONFLICT` (409; type `terminal`, action `attach`); `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `preview.activate` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace`); `CONFIGURATION_NOT_REGISTERED (422)`; `WORKSPACE_STATE_CONFLICT (409)`; `RESOURCE_STATE_CONFLICT` (409; type `preview`); `PREVIEW_NOT_DEFINED (422)`; `RUNTIME_POLICY_VIOLATION (422)`; `PREVIEW_DOMAIN_NOT_APPROVED (422)`; `GATEWAY_UPDATE_FAILED (503)`; `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `preview.deactivate` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace` or `preview`); `RESOURCE_STATE_CONFLICT` (409; type `preview`); `GATEWAY_UPDATE_FAILED (503)`; `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `preview.inspect` | `G`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace` or `preview`); `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `ai-session.start` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace`); `CONFIGURATION_NOT_REGISTERED (422)`; `WORKSPACE_STATE_CONFLICT (409)`; `RESOURCE_STATE_CONFLICT` (409; type `ai-session`); `AI_NOT_CONFIGURED (422)`; `RUNTIME_POLICY_VIOLATION (422)`; `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `ai-session.interrupt` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace` or `ai-session`); `RESOURCE_STATE_CONFLICT` (409; type `ai-session`); `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `ai-session.stop` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace` or `ai-session`); `RESOURCE_STATE_CONFLICT` (409; type `ai-session`); `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |
| `ai-session.resume` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace` or `ai-session`); `CONFIGURATION_NOT_REGISTERED (422)`; `RESOURCE_STATE_CONFLICT` (409; type `ai-session`); `RUNTIME_POLICY_VIOLATION (422)`; `ROOTLESS_RUNTIME_UNAVAILABLE (503)` |

Malformed IDs, timestamps, enums, paths, query keys, body fields, envelopes, and forbidden mutation
headers always use `REQUEST_INVALID`, not a route-specific not-found or policy code. Parent
ownership mismatches use `RESOURCE_NOT_FOUND` so the response does not reveal whether the child ID
exists under another parent.

The route-specific error validators further narrow discriminators as follows:

- Each `RESOURCE_NOT_FOUND` and `RESOURCE_STATE_CONFLICT` uses only the `resource.type` literals
  shown in that route row and echoes the corresponding request ID. When two types are shown, the
  details schema is the discriminated union of exactly those two reference variants.
- `RESOURCE_STATE_CONFLICT.action` is `create` for `project.managed-store.create` and
  `terminal.create`, `start` for `task.start` and `ai-session.start`, `stop` for `process.stop` and
  `ai-session.stop`, `close` for `terminal.close`, `attach` for `terminal.stream`, `activate` or
  `deactivate` for the corresponding preview route, `interrupt` for `ai-session.interrupt`, and
  `resume` for `ai-session.resume`.
- `WORKSPACE_STATE_CONFLICT.action` is the inventory action name, except `task.start` uses
  `run-task`, `terminal.create` uses `create-terminal`, `preview.activate` uses
  `activate-preview`, and `ai-session.start` uses `start-ai-session`.
- `RUNTIME_POLICY_VIOLATION.policy` is `source-not-approved` on source/project creation routes,
  `workspace-action-rejected` on workspace
  routes, `task-action-rejected` on task routes, `terminal-action-rejected` on terminal routes,
  `preview-action-rejected` on preview routes, and `ai-profile-rejected` on AI-session routes.
- `SOURCE_NOT_FOUND` applies only to the `registered-local` request variant and echoes its
  `sourceId`.
- On `ai-session.resume`, an AI-session `RESOURCE_NOT_FOUND` always references
  `sourceAiSessionId`. An AI-session `RESOURCE_STATE_CONFLICT` references `sourceAiSessionId` when
  the source is not resumable and the new `aiSessionId` when that new ID is already bound.

## Terminal attachment and streaming contract

Terminal streaming belongs to F09 because `/v1/terminals/{terminalId}/stream` is an explicit v1
endpoint and the F10 contract explicitly excludes terminal frames. This section defines framing only; it does
not implement WebSocket or PTY behavior.

### Upgrade request and response

The client is DevSpace Web. It sends HTTP GET to the exact path with no query and no body. In
addition to common DevSpace headers, it sends standard RFC 6455 upgrade headers with
`Sec-WebSocket-Version: 13` and `Sec-WebSocket-Protocol: devspace.terminal.v1`. There is no
additional terminal authorization token, browser credential, or terminal-specific authorization
header. Before
opening the Agent stream, Web must authenticate the browser and authorize that user for the exact
project, workspace, and terminal. The Agent trusts the protected Web-to-Agent Unix-socket peer and
is not directly reachable by untrusted browser clients.

Success is exactly HTTP `101 Switching Protocols`, selects the exact
`devspace.terminal.v1` subprotocol, and has no JSON success envelope. All failures before `101` use
the exhaustive `terminal.stream` error registry. Exactly one active stream attachment is permitted
for each terminal resource. A second upgrade while one is active fails with HTTP `409`,
`RESOURCE_STATE_CONFLICT`, resource type `terminal`, and action `attach`. No operation ID is
allowed: attaching and detaching do not change the terminal resource's requested lifecycle.

The Agent atomically reserves the terminal's attachment slot before sending `101`. The slot is
active from that response until the WebSocket is fully closed and is then released. Concurrent
upgrade attempts that cannot acquire the slot receive the `409` response; no two attempts may both
receive `101` for the same terminal.

### Binary message framing

Every WebSocket data message uses opcode `0x2` (binary), is unfragmented, and is at most 65,537
bytes including the one-byte DevSpace discriminator. Text messages, continuation frames, unknown
discriminators, invalid lengths, and invalid numeric values cause WebSocket close code `1002`.
Standard ping, pong, and close control frames remain RFC 6455 control frames and are not wrapped.

Multi-byte integers below use network byte order (big-endian).

| Direction | Discriminator | Name | Exact payload after discriminator |
| --- | --- | --- | --- |
| Web to Agent | `0x01` | input | 1 through 65,536 opaque PTY input bytes |
| Web to Agent | `0x02` | resize | exactly 4 bytes: unsigned 16-bit columns then unsigned 16-bit rows; both 1..65535 |
| Web to Agent | `0x03` | detach | zero bytes |
| Agent to Web | `0x11` | ready | zero bytes; exactly once and before output, after attachment is active |
| Agent to Web | `0x12` | output | 1 through 65,536 opaque merged PTY output bytes |
| Agent to Web | `0x13` | exit | either one byte `0x00` for no recovered exit code, or byte `0x01` followed by one signed 32-bit `ExitCode` |

The Agent sends `ready` before client input or control is valid. Any input, resize, or detach message
received before the Agent has sent `ready` is a protocol violation: it is not buffered or silently
discarded, and the Agent closes with `1002`. Receipt of `detach` after `ready` terminates only this
stream attachment; it does not close the terminal resource or create an operation. The Agent then
closes the socket with `1000`. Normal terminal process exit sends exactly one `exit` message after
all preceding output and then closes with `1000`. Terminal failure or loss closes with `1011`. A
client-initiated normal WebSocket close also detaches without changing terminal lifecycle. Terminal
close remains the explicit `POST /v1/terminals/close` mutation. Terminal state changes are observed
through the later F10 resource/event contract, not by adding state or cursor fields to these frames.

## Reconciliation deferred beyond F09 and F10

`POST /v1/reconciliation/run` is not an executable F09 endpoint and is not assigned to F10.
Reconciliation will be specified only in the milestone that owns runtime desired state,
runtime-plan application, stale-resource repair, and serialization against ordinary mutations. No
F09 schema, registry entry, fixture, or generated artifact may expose this route or a reconciliation
request/response shape.

## F10 snapshot, event, and cursor contract

F10 adds contract infrastructure only. It defines schemas, fixtures, generated artifacts, and
compatibility checks; it does not collect snapshots, produce or retain events, execute replay,
open an HTTP stream, buffer NDJSON, or persist Agent state.

### F10 endpoint inventory

The exact executable F10 endpoint count is **2**. Both are non-mutating HTTP GET operations, forbid
`X-DevSpace-Operation-Id`, and use the common DevSpace request-header shape. They accept no request
body.

| Stable operation name | Method | Exact path/query | Success |
| --- | --- | --- | --- |
| `snapshot.get` | GET | `/v1/snapshot` with no query | HTTP `200` normal `SuccessEnvelope<AgentSnapshotData>` |
| `event.stream` | GET | `/v1/events?cursor=<cursor>` with exactly one required cursor query parameter | HTTP `200` NDJSON stream; no success envelope |

No query parameter is accepted by `snapshot.get`. `event.stream` accepts exactly one decoded query
parameter named `cursor`; an unknown or duplicate query parameter is invalid. The F10 route error
table below is exhaustive. F10 composes with the 26 active non-AI F09 endpoints and F11, not the
four superseded historical AI rows.

### Event sequence and cursor primitives

`EventSequence` is a JSON safe integer from **1** through **9007199254740991** inclusive. It is the
sequence of a real event within one Agent boot. No event has sequence zero. The Agent must not emit
an event whose sequence would exceed 9007199254740991; rollover runtime behavior is outside F10.

`CursorSequence` is an integer from **0** through **9007199254740991** inclusive as represented in
the serialized cursor below. Zero is the position before the first event for one specific boot; it
does not name an event.

`EventCursor` is one ASCII string with exact grammar:

```text
v1.<lowercase UUIDv7 agentBootId>.<sequence>
```

The decimal sequence component matches `0|[1-9][0-9]*`, has no sign, whitespace, leading zeroes
other than the single value `0`, fraction, or exponent, and must be in the `CursorSequence` range.
The `agentBootId` component is exactly `UuidV7`. Cursor parsing does not coerce or normalize input.

An event cursor names the event at its positive sequence. Subscribing from a cursor replays
retained events with greater sequence and then waits for new events. A `.0` cursor requests replay
from the start of that boot's retained event history. Cursors are Agent-observation positions, not
SQLite audit sequences, and never cross boot streams.

### F10 resource references

`AgentResourceReference` is the following strict union. It uses only identities already supplied by
accepted F09 requests or the accepted service configuration key. Runtime stacks and services have
no invented UUID identity. Every displayed field is required and every object is closed.

```text
AgentResourceReference =
  | { type: "project", projectId: UuidV7 }
  | { type: "workspace", projectId: UuidV7, workspaceId: UuidV7 }
  | { type: "runtime-stack", projectId: UuidV7, workspaceId: UuidV7 }
  | { type: "service", projectId: UuidV7, workspaceId: UuidV7,
      serviceKey: ConfigurationKey }
  | { type: "process", projectId: UuidV7, workspaceId: UuidV7, processId: UuidV7 }
  | { type: "terminal", projectId: UuidV7, workspaceId: UuidV7, terminalId: UuidV7 }
  | { type: "preview", projectId: UuidV7, workspaceId: UuidV7, previewId: UuidV7 }
```

This F10 union is distinct from the narrower F09 error `ResourceReference`: F10 adds
`runtime-stack` and `service`, uses type-specific field names, and carries the accepted parent
identities needed to place observations. It does not change the F09 error primitive.

### Project Git inspection scopes

`project.source.inspect` has no accepted project identity. Its `SourceInspectionData` is therefore
not an F10 snapshot observation and never emits `project.inspected`; it remains only the ordinary
F09 request/response operation.

`ProjectGitInspectionScope` is this strict discriminated union:

```text
ProjectGitInspectionScope =
  | { kind: "managed-store" }
  | { kind: "workspace", workspaceId: UuidV7 }

ProjectGitInspectionObservation = {
  scope: ProjectGitInspectionScope,
  inspection: GitInspectionData
}
```

`GitInspectionData` is reused exactly, including all F09 refinements. In every containing project
snapshot/event, `inspection.projectId` must equal the containing `projectId`. A `managed-store`
scope requires `inspection.workspaceId: null`; a `workspace` scope requires
`inspection.workspaceId` to equal `scope.workspaceId`. These equalities are strict runtime-schema
refinements where JSON Schema cannot express them.

### Snapshot success data

`GET /v1/snapshot` returns the normal strict F09 `SuccessEnvelope` convention with this exact data:

```text
AgentSnapshotData = {
  agentBootId: UuidV7,
  throughCursor: EventCursor,
  resources: AgentSnapshotResource[],
  operationObservations: AgentOperationObservation[]
}
```

`throughCursor` must contain the same `agentBootId` as the snapshot. Its cursor sequence may be
zero and identifies the event boundary through which all snapshot observations are
self-consistent. After replacing its Agent-observed view with this snapshot, Web reconnects using
`GET /v1/events?cursor=<throughCursor>`.

The snapshot is a recovery observation of Agent-owned state. It is not a SQLite dump, a Project
Options document/copy, a runtime plan, an event history, or an ownership transfer of Web state.
Desired-state and revision-identity fields appear only where they are members of an exact accepted
F09 Agent inspection shape; they report the Agent's retained observation and do not become
authoritative Web desired state or configuration storage.

#### Snapshot resource union

The following lifecycle names mean the exact authoritative values from `lifecycle-states.md` and
the public domain package:

```text
WorkspaceServiceDesiredState = "absent" | "stopped" | "running"
WorkspaceServiceObservedState = RuntimeStackObservedState
WorkspaceServiceHealthState = "unknown" | "starting" | "healthy" | "unhealthy"
TerminalState = "creating" | "active" | "disconnected" | "closing" |
  "closed" | "failed" | "lost"

WorkspaceServiceObservation = {
  desiredState: WorkspaceServiceDesiredState,
  observedState: WorkspaceServiceObservedState,
  health: WorkspaceServiceHealthState
}
```

`AgentSnapshotResource` is this strict discriminated union. Fields shown in each member are exact;
none is optional and no unknown field is accepted.

```text
AgentSnapshotResource =
  | {
      type: "project",
      projectId: UuidV7,
      gitInspections: ProjectGitInspectionObservation[]
    }
  | {
      type: "workspace",
      observation: WorkspaceInspectionData
    }
  | {
      type: "runtime-stack",
      projectId: UuidV7,
      workspaceId: UuidV7,
      observation: WorkspaceInspectionData["runtimeStack"]
    }
  | {
      type: "service",
      projectId: UuidV7,
      workspaceId: UuidV7,
      serviceKey: ConfigurationKey,
      observation: WorkspaceServiceObservation
    }
  | {
      type: "process",
      observation: F10ProcessInspectionData
    }
  | {
      type: "terminal",
      identity: TerminalIdentityData,
      state: TerminalState
    }
  | {
      type: "preview",
      observation: PreviewInspectionData
    }
```

`WorkspaceInspectionData`, `PreviewInspectionData`, and `TerminalIdentityData` are embedded
exactly as accepted by F09, with all nested strictness and refinements unchanged.
`F10ProcessInspectionData` is structurally the exact F09 `ProcessInspectionData`, including all
state/timestamp/exit-code refinements, except that its `kind` is narrowed to `"task" | "terminal"`.
The historical F09 `"ai-session"` vocabulary remains compatibility evidence only and is rejected
by F10 snapshots and events. `WorkspaceInspectionData["runtimeStack"]` means
the exact strict nested runtime-stack observation already defined by that F09 shape; F10 extracts
and reuses it rather than duplicating its fields. A workspace has at most one runtime stack, so
`workspaceId` is its identity and no stack UUID exists.

F09 has no standalone service inspection response. `WorkspaceServiceObservation` is the exact F10
composition of the accepted domain service desired-state, observed-state, and health vocabularies.
Its health must be `unknown` whenever `observedState` is not `running`; `starting`, `healthy`, or
`unhealthy` health is valid only while the service is observed `running`.

The observation authority for each snapshot category is therefore exact:

| Snapshot category | Exact identity key | Authoritative observation shape |
| --- | --- | --- |
| `project` | `projectId` | `gitInspections`, whose items embed exact F09 `GitInspectionData`; no source inspection |
| `workspace` | `observation.workspaceId` | exact F09 `WorkspaceInspectionData` |
| `runtime-stack` | `workspaceId` | exact extracted `WorkspaceInspectionData["runtimeStack"]` |
| `service` | (`workspaceId`, `serviceKey`) | F10 `WorkspaceServiceObservation` from authoritative domain values |
| `process` | `observation.processId` | F10 `F10ProcessInspectionData` (`task | terminal` only) |
| `terminal` | `identity.terminalId` | exact F09 `TerminalIdentityData` plus domain `TerminalState` |
| `preview` | `observation.previewId` | exact F09 `PreviewInspectionData` |

`resources` may contain zero or more items and is the complete Agent-observed resource set visible
to Web at the boundary. No two items of one type may share that type's exact identity key from the
table. Different resource types do not conflict merely because UUID text happens to match. Array
order has no semantic meaning and no canonical sort is required. Type-specific uniqueness is a
runtime-schema refinement because JSON Schema cannot express it faithfully.

Every workspace snapshot member has exactly one corresponding runtime-stack member with the same
`projectId`/`workspaceId`, and the runtime-stack member's `observation` must equal
`workspace.observation.runtimeStack`. This preserves the exact embedded F09 workspace inspection
while giving runtime-stack events one independently addressable snapshot category; the two
representations cannot diverge.

Within one project resource, `gitInspections` may be empty and has insignificant order. It rejects
duplicate scopes: at most one `managed-store` item and at most one `workspace` item for each
`workspaceId`. A `project.inspected` event replaces or inserts the one array item with the same
scope; all other scopes remain unchanged.

#### Agent operation observations

`AgentExecutionFailure` is a dedicated post-acceptance failure value. It contains only conditions
that can arise after a mutation has already been durably accepted and returned HTTP `202`. It is
not the F09 route-error union and has no response `meta` wrapper.

Every variant is the strict object `{ code, message: ErrorMessage, retryable, details }`.
`code` discriminates the exact 31-member union below. Retryability and details reuse the existing
F09 contracts exactly:

| Allowed code | Retryable | Exact strict details |
| --- | --- | --- |
| `CONFIGURATION_NOT_REGISTERED` | false | `{ revisionId: UuidV7, revisionHash: ProjectOptionsRevisionHash }` |
| `RUNTIME_POLICY_VIOLATION` | false | `{ policy: one of ("source-not-approved", "workspace-action-rejected", "task-action-rejected", "terminal-action-rejected", "preview-action-rejected", "ai-profile-rejected") }` |
| `PROJECT_NOT_FOUND` | false | `{ projectId: UuidV7 }` |
| `RESOURCE_NOT_FOUND` | false | `{ resource: ResourceReference }` |
| `SOURCE_NOT_FOUND` | false | `{ sourceId: UuidV7 }` |
| `SOURCE_INVALID` | false | `{ reason: one of ("not-a-git-repository", "unsupported-repository-format") }` |
| `SOURCE_UNAVAILABLE` | true | `{}` |
| `GITHUB_AUTHORITY_INVALID` | false | `{ reason: authority classification, including "permission-required" }` |
| `GITHUB_CONNECTION_DISABLED` | false | `{}` |
| `GITHUB_AUTHORITY_GENERATION_STALE` | false | `{}` |
| `GITHUB_INSTALLATION_REMOVED` | false | `{}` |
| `GITHUB_INSTALLATION_SUSPENDED` | false | `{}` |
| `GITHUB_REPOSITORY_ACCESS_UNAVAILABLE` | false | `{}` |
| `GITHUB_UPSTREAM_TRANSIENT` | true | `{}` |
| `GITHUB_CONTENTS_PERMISSION_REQUIRED` | false | `{}` |
| `GITHUB_INSTALLATION_UNAVAILABLE` | true | `{}` |
| `GITHUB_REPOSITORY_NOT_AUTHORIZED` | false | `{}` |
| `GITHUB_GIT_AUTHENTICATION_FAILED` | false | `{}` |
| `GITHUB_TOKEN_LEASE_ACTIVE` | true | `{}` |
| `WORKSPACE_STATE_CONFLICT` | false | `{ workspaceId: UuidV7, desiredState: WorkspaceDesiredState, observedState: WorkspaceObservedState, action: one of ("create", "start", "stop", "rebuild", "archive", "remove", "run-task", "create-terminal", "activate-preview", "start-ai-session") }` |
| `RESOURCE_STATE_CONFLICT` | false | `{ resource: ResourceReference, action: one of ("create", "start", "stop", "close", "attach", "activate", "deactivate", "interrupt", "resume") }` |
| `DIRTY_WORKSPACE_REQUIRES_ACTION` | false | `{ workspaceId: UuidV7, requestedAction: one of ("archive", "remove") }` |
| `TASK_NOT_DEFINED` | false | `{ revisionId: UuidV7, taskKey: ConfigurationKey }` |
| `PROCESS_IDENTITY_MISMATCH` | false | `{ processId: UuidV7 }` |
| `PREVIEW_NOT_DEFINED` | false | `{ revisionId: UuidV7, previewKey: ConfigurationKey }` |
| `AI_NOT_CONFIGURED` | false | `{ workspaceId: UuidV7, revisionId: UuidV7 }` |
| `PREVIEW_DOMAIN_NOT_APPROVED` | false | `{ previewId: UuidV7 }` |
| `GATEWAY_UPDATE_FAILED` | true | `{ previewId: UuidV7 }` |
| `GIT_MUTATION_OUTCOME_UNCERTAIN` | false | `{}` |
| `ROOTLESS_RUNTIME_UNAVAILABLE` | true | `{ component: "docker" }` |
| `AGENT_INTERNAL_ERROR` | true | `{ incidentId: UuidV7 }` |

Unknown fields, arbitrary details, F10 cursor errors, and route-only pre-acceptance errors such as
`GITHUB_CONNECTION_NOT_FOUND` are rejected. For an execution failure,
`retryable: true` means a caller may submit a new operation
with a new operation ID after the transient condition changes or is addressed. It never causes
replay of the same operation ID to execute again; same-ID replay remains governed by F09 durable
idempotency and returns the retained outcome without retrying execution.

The classification of all 31 executable codes is exhaustive:

| F09 code | Classification for asynchronous execution | Accepted semantic reason |
| --- | --- | --- |
| `PROTOCOL_VERSION_UNSUPPORTED` | strictly pre-acceptance only | protocol negotiation rejects the request before durable acceptance |
| `REQUEST_INVALID` | strictly pre-acceptance only | malformed request data is rejected before durable acceptance |
| `OPERATION_CONFLICT` | strictly pre-acceptance only | journal identity mismatch prevents acceptance |
| `OPERATION_JOURNAL_UNAVAILABLE` | strictly pre-acceptance only | the Agent cannot durably accept the mutation |
| `CONFIGURATION_INVALID` | strictly pre-acceptance only | configuration validation precedes registration acceptance |
| `CONFIGURATION_NOT_REGISTERED` | potentially post-acceptance | the required registered revision may become unavailable before execution uses it |
| `RUNTIME_POLICY_VIOLATION` | potentially post-acceptance | applicable Agent policy may change or be re-evaluated against changed runtime state |
| `PROJECT_NOT_FOUND` | potentially post-acceptance | a project retained at validation may be absent when execution begins |
| `RESOURCE_NOT_FOUND` | potentially post-acceptance | a referenced resource may be removed or lose its accepted ownership relation |
| `SOURCE_NOT_FOUND` | potentially post-acceptance | a registered-local source may be removed after validation |
| `SOURCE_INVALID` | potentially post-acceptance | managed-store execution may discover that fetched/read source content is not an accepted Git repository |
| `SOURCE_UNAVAILABLE` | potentially post-acceptance | accepted source creation/fetch work may lose access to its source |
| `WORKSPACE_STATE_CONFLICT` | potentially post-acceptance | workspace desired/observed state may change before execution acts |
| `RESOURCE_STATE_CONFLICT` | potentially post-acceptance | resource state or caller-supplied identity binding may race after validation |
| `DIRTY_WORKSPACE_REQUIRES_ACTION` | potentially post-acceptance | an isolated worktree may become dirty before archive/removal executes |
| `TASK_NOT_DEFINED` | potentially post-acceptance | the workspace's effective registered revision may change before task resolution/execution |
| `PROCESS_IDENTITY_MISMATCH` | potentially post-acceptance | the required live ownership check may fail immediately before acting on a retained process |
| `PREVIEW_NOT_DEFINED` | potentially post-acceptance | the workspace's effective revision may no longer define the preview |
| `AI_NOT_CONFIGURED` | potentially post-acceptance | the workspace's effective revision may change to one with no AI profile |
| `PREVIEW_DOMAIN_NOT_APPROVED` | potentially post-acceptance | approved-domain policy may change before gateway application |
| `GATEWAY_UPDATE_FAILED` | potentially post-acceptance | accepted preview execution may fail while applying the gateway update |
| `GIT_MUTATION_OUTCOME_UNCERTAIN` | potentially post-acceptance | an interrupted local Git mutation has no provable completion outcome and requires repository inspection before explicit continuation |
| `ROOTLESS_RUNTIME_UNAVAILABLE` | potentially post-acceptance | the runtime may become unavailable while accepted work executes |
| `AGENT_INTERNAL_ERROR` | potentially post-acceptance | an unexpected redacted Agent failure may occur during accepted execution |

The Agent journal already binds each `operationId` to one stable F09 mutation operation. The
runtime must validate a stored/emitted failure against that binding using this exact table; the
wire failure does not duplicate the operation name.

| F09 mutation operation | Allowed asynchronous `AgentExecutionFailure.code` values |
| --- | --- |
| `configuration-revision.register` | `AGENT_INTERNAL_ERROR` |
| `configuration-runtime-plan.register` | `CONFIGURATION_NOT_REGISTERED`; `RUNTIME_POLICY_VIOLATION`; `AGENT_INTERNAL_ERROR` |
| `project.managed-store.create` | `RESOURCE_STATE_CONFLICT`; `SOURCE_NOT_FOUND`; `SOURCE_INVALID`; `SOURCE_UNAVAILABLE`; `GITHUB_CONTENTS_PERMISSION_REQUIRED`; `GITHUB_INSTALLATION_UNAVAILABLE`; `GITHUB_REPOSITORY_NOT_AUTHORIZED`; `GITHUB_GIT_AUTHENTICATION_FAILED`; `GITHUB_TOKEN_LEASE_ACTIVE`; `RUNTIME_POLICY_VIOLATION`; `AGENT_INTERNAL_ERROR` |
| `project.fetch` | `PROJECT_NOT_FOUND`; `SOURCE_UNAVAILABLE`; `GITHUB_CONTENTS_PERMISSION_REQUIRED`; `GITHUB_INSTALLATION_UNAVAILABLE`; `GITHUB_REPOSITORY_NOT_AUTHORIZED`; `GITHUB_GIT_AUTHENTICATION_FAILED`; `GITHUB_TOKEN_LEASE_ACTIVE`; `AGENT_INTERNAL_ERROR` |
| `project.git.stage` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `WORKSPACE_PATH_INVALID`; `WORKSPACE_FILE_NOT_FOUND`; `WORKSPACE_FILE_UNSUPPORTED`; `GIT_OPERATION_FAILED`; `GIT_MUTATION_OUTCOME_UNCERTAIN`; `AGENT_INTERNAL_ERROR` |
| `project.git.unstage` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `WORKSPACE_PATH_INVALID`; `WORKSPACE_FILE_NOT_FOUND`; `GIT_OPERATION_FAILED`; `GIT_MUTATION_OUTCOME_UNCERTAIN`; `AGENT_INTERNAL_ERROR` |
| `project.git.commit` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `GIT_NOTHING_TO_COMMIT`; `GIT_COMMIT_MESSAGE_INVALID`; `GIT_IDENTITY_REQUIRED`; `GIT_OPERATION_FAILED`; `GIT_MUTATION_OUTCOME_UNCERTAIN`; `AGENT_INTERNAL_ERROR` |
| `workspace.create` | `PROJECT_NOT_FOUND`; `CONFIGURATION_NOT_REGISTERED`; `WORKSPACE_STATE_CONFLICT`; `RUNTIME_POLICY_VIOLATION`; `ROOTLESS_RUNTIME_UNAVAILABLE`; `AGENT_INTERNAL_ERROR` |
| `workspace.start` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `CONFIGURATION_NOT_REGISTERED`; `WORKSPACE_STATE_CONFLICT`; `RUNTIME_POLICY_VIOLATION`; `ROOTLESS_RUNTIME_UNAVAILABLE`; `AGENT_INTERNAL_ERROR` |
| `workspace.stop` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `WORKSPACE_STATE_CONFLICT`; `ROOTLESS_RUNTIME_UNAVAILABLE`; `AGENT_INTERNAL_ERROR` |
| `workspace.rebuild` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `CONFIGURATION_NOT_REGISTERED`; `WORKSPACE_STATE_CONFLICT`; `RUNTIME_POLICY_VIOLATION`; `ROOTLESS_RUNTIME_UNAVAILABLE`; `AGENT_INTERNAL_ERROR` |
| `workspace.archive` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `WORKSPACE_STATE_CONFLICT`; `DIRTY_WORKSPACE_REQUIRES_ACTION`; `RUNTIME_POLICY_VIOLATION`; `ROOTLESS_RUNTIME_UNAVAILABLE`; `AGENT_INTERNAL_ERROR` |
| `workspace.remove` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `WORKSPACE_STATE_CONFLICT`; `DIRTY_WORKSPACE_REQUIRES_ACTION`; `RUNTIME_POLICY_VIOLATION`; `ROOTLESS_RUNTIME_UNAVAILABLE`; `AGENT_INTERNAL_ERROR` |
| `task.start` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `CONFIGURATION_NOT_REGISTERED`; `WORKSPACE_STATE_CONFLICT`; `RESOURCE_STATE_CONFLICT`; `TASK_NOT_DEFINED`; `RUNTIME_POLICY_VIOLATION`; `ROOTLESS_RUNTIME_UNAVAILABLE`; `AGENT_INTERNAL_ERROR` |
| `process.stop` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `RESOURCE_STATE_CONFLICT`; `PROCESS_IDENTITY_MISMATCH`; `ROOTLESS_RUNTIME_UNAVAILABLE`; `AGENT_INTERNAL_ERROR` |
| `terminal.create` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `CONFIGURATION_NOT_REGISTERED`; `WORKSPACE_STATE_CONFLICT`; `RESOURCE_STATE_CONFLICT`; `RUNTIME_POLICY_VIOLATION`; `ROOTLESS_RUNTIME_UNAVAILABLE`; `AGENT_INTERNAL_ERROR` |
| `terminal.close` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `RESOURCE_STATE_CONFLICT`; `ROOTLESS_RUNTIME_UNAVAILABLE`; `AGENT_INTERNAL_ERROR` |
| `preview.activate` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `CONFIGURATION_NOT_REGISTERED`; `WORKSPACE_STATE_CONFLICT`; `RESOURCE_STATE_CONFLICT`; `PREVIEW_NOT_DEFINED`; `RUNTIME_POLICY_VIOLATION`; `PREVIEW_DOMAIN_NOT_APPROVED`; `GATEWAY_UPDATE_FAILED`; `ROOTLESS_RUNTIME_UNAVAILABLE`; `AGENT_INTERNAL_ERROR` |
| `preview.deactivate` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `RESOURCE_STATE_CONFLICT`; `GATEWAY_UPDATE_FAILED`; `ROOTLESS_RUNTIME_UNAVAILABLE`; `AGENT_INTERNAL_ERROR` |
| `ai-session.start` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `CONFIGURATION_NOT_REGISTERED`; `WORKSPACE_STATE_CONFLICT`; `RESOURCE_STATE_CONFLICT`; `AI_NOT_CONFIGURED`; `RUNTIME_POLICY_VIOLATION`; `ROOTLESS_RUNTIME_UNAVAILABLE`; `AGENT_INTERNAL_ERROR` |
| `ai-session.interrupt` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `RESOURCE_STATE_CONFLICT`; `ROOTLESS_RUNTIME_UNAVAILABLE`; `AGENT_INTERNAL_ERROR` |
| `ai-session.stop` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `RESOURCE_STATE_CONFLICT`; `ROOTLESS_RUNTIME_UNAVAILABLE`; `AGENT_INTERNAL_ERROR` |
| `ai-session.resume` | `PROJECT_NOT_FOUND`; `RESOURCE_NOT_FOUND`; `CONFIGURATION_NOT_REGISTERED`; `RESOURCE_STATE_CONFLICT`; `RUNTIME_POLICY_VIOLATION`; `ROOTLESS_RUNTIME_UNAVAILABLE`; `AGENT_INTERNAL_ERROR` |

Each operation row reuses the exact F09 route-specific details narrowing for resource types,
actions, policy values, and echoed request identities. No validation-to-execution reservation,
global mutation serialization, or resource-scoped serialization is assumed. A failure listed in a
row may be emitted when the condition was absent at acceptance but becomes true before or during
execution.

`AgentOperationObservation` is the following strict discriminated union:

```text
AgentOperationObservation =
  | { operationId: UuidV7, state: "accepted" | "running" | "succeeded",
      updatedAt: UtcTimestampMs, failure: null }
  | { operationId: UuidV7, state: "failed", updatedAt: UtcTimestampMs,
      failure: AgentExecutionFailure }
```

These four states are coarse F10 Agent execution observations, not a reuse or replacement of
Web's SQLite operation lifecycle. `accepted` means the Agent durably accepted the operation and no
terminal execution outcome is currently recorded. `running` means durable execution has begun.
Both are nonterminal and active.

The exact application rules are:

- first durable HTTP `202` acceptance creates `{ state: "accepted", failure: null,
  updatedAt: <durable acceptance time> }` when no observation exists; an exact same-ID F09 replay
  leaves an existing recoverable observation unchanged and does not recreate a compacted terminal
  observation; the timestamp is journal metadata rather than a `MutationReceipt` field;
- `operation.progressed` requires an existing recoverable `accepted` or `running` observation,
  sets `state: "running"` and `failure: null`, and sets `updatedAt` to the event `occurredAt`; its
  message remains transient;
- `operation.succeeded` requires an existing `accepted` or `running` observation and replaces it with
  `{ state: "succeeded", failure: null, updatedAt: event.occurredAt }`;
- `operation.failed` requires an existing `accepted` or `running` observation and replaces it with
  `{ state: "failed", failure: event.payload.error, updatedAt: event.occurredAt }`.

Progress against a terminal observation is invalid. No operation event may move a terminal
observation back to a nonterminal state or to another terminal state. Normal cursor processing prevents
duplicate replay application; F10 does not define a separate idempotent snapshot-mutation API.

`operationObservations` is the complete set of currently recoverable Agent execution observations
retained by the Agent. It must contain every durably accepted operation for which no terminal
outcome is recorded. It may contain retained `succeeded` and `failed` observations, may be empty
only when no recoverable observation exists, rejects duplicate `operationId` values, and has no
semantic ordering.

F10 does not strengthen F09 journal compaction. The Agent may compact terminal observation details
under the accepted F09 compaction policy provided operation-ID reuse safety remains preserved.
Current nonterminal `accepted` observations may not be compacted.

Absence has exactly one meaning: no recoverable Agent execution observation for that operation ID
is available in this snapshot. It does not prove that the operation was never accepted, succeeded,
or failed, and Web must not infer a terminal outcome. A nonterminal Web operation row without a
matching Agent observation is an unresolved recovery inconsistency for its later owning lifecycle
policy, not a new F10 wire error. F10 guarantees recovery of current nonterminal Agent execution
observations, not permanent historical operation-outcome storage.

### Event envelope and exact event union

Every event is one strict object with exactly these fields:

```text
AgentEvent = {
  protocolVersion: 1,
  agentBootId: UuidV7,
  sequence: EventSequence,
  cursor: EventCursor,
  occurredAt: UtcTimestampMs,
  operationId: <event-specific UuidV7 or null>,
  resource: <event-specific AgentResourceReference or null>,
  type: <one exact event discriminator>,
  payload: <one exact closed payload>
}
```

For every event, `cursor` must contain the same boot ID as `agentBootId` and the same positive
sequence as `sequence`. Event sequence zero is invalid even though cursor sequence zero is valid
at snapshot/replay boundaries. The cursor equality is a runtime-schema refinement when generated
JSON Schema cannot express it. The stable event identity is exactly the pair
`(agentBootId, sequence)` and its cursor serialization; the envelope has no second event identity.

`AgentProgressMessage` is an F10 semantic primitive with exactly the same wire validation policy as
F09 `ErrorMessage`: 1 through 512 Unicode scalar values and no C0/C1 controls. It is a distinct
public name because ordinary progress text is not an error.

The schema is a discriminated union on `type`; each discriminator selects the resource shape,
operation-ID rule, and payload in the table below. `ProjectRef`, `WorkspaceRef`, and the other
`*Ref` names mean the corresponding exact `AgentResourceReference` member. In this table,
`nullable T` means exactly `T` or JSON `null`; it never means omitted.

| Event `type` | `operationId` | `resource` | Exact `payload` |
| --- | --- | --- | --- |
| `operation.progressed` | required `UuidV7` | any `AgentResourceReference` or `null` | `{ message: AgentProgressMessage }` |
| `operation.succeeded` | required `UuidV7` | any `AgentResourceReference` or `null` | `{}` |
| `operation.failed` | required `UuidV7` | any `AgentResourceReference` or `null` | `{ error: AgentExecutionFailure }` |
| `project.inspected` | exactly `null` | required `ProjectRef` | `ProjectGitInspectionObservation` |
| `workspace.observed-state.changed` | `UuidV7` or `null` | required `WorkspaceRef` | `{ previous: nullable WorkspaceObservedState, current: WorkspaceObservedState }` |
| `runtime-stack.observed-state.changed` | `UuidV7` or `null` | required `RuntimeStackRef` | `{ previous: nullable RuntimeStackObservedState, current: RuntimeStackObservedState }` |
| `service.observed-state.changed` | `UuidV7` or `null` | required `ServiceRef` | `{ previous: nullable WorkspaceServiceObservedState, current: WorkspaceServiceObservedState }` |
| `service.health.changed` | `UuidV7` or `null` | required `ServiceRef` | `{ previous: nullable WorkspaceServiceHealthState, current: WorkspaceServiceHealthState }` |
| `process.observation.changed` | `UuidV7` or `null` | required `ProcessRef` | `{ previous: nullable F10ProcessInspectionData, current: F10ProcessInspectionData }` |
| `terminal.state.changed` | `UuidV7` or `null` | required `TerminalRef` | `{ previous: nullable TerminalState, current: TerminalState }` |
| `preview.state.changed` | `UuidV7` or `null` | required `PreviewRef` | `{ previousState: nullable PreviewObservedState, observation: PreviewInspectionData }` |

There are exactly **11** executable F10 event discriminators. Generic operation-cancellation,
process-output-availability, and special process-start/process-exit events are not executable F10
events. Process observation changes use the one complete observation event above. No
reconciliation event exists.

Every payload and nested failure/details value is closed. Progress has no percentages, stage maps,
metadata, or extension object. `operation.failed.error` cannot override fixed code details or
retryability. Raw process output, output offsets/counts, terminal bytes, and interactive AI bytes
never enter F10 events or snapshots.

For `project.inspected`, `resource.projectId`, `payload.inspection.projectId`, and the containing
project identity must match. The scope/inspection workspace-nullability equality defined above also
applies. Web applies the event by replacing or inserting the matching `gitInspections` scope in its
project snapshot view.

#### Process observation events

`process.observation.changed` carries `F10ProcessInspectionData` as both its nullable prior
observation and required current observation. It preserves all historical F09 process refinements
while permitting only `task | terminal`; `ai-session` is invalid in either non-null position. The
event resource's `projectId`,
`workspaceId`, and `processId` must equal `current`; when `previous` is non-null, its identity and
`kind` must equal `current`. Both values independently satisfy every F09 process
state/timestamp/exit-code refinement, and `previous`/`current` must not be deeply equal.

When `previous.observedState` differs from `current.observedState`, the pair must be one structural
edge in the domain process-observed graph. When `desiredState` differs, it must be one structural
edge in the domain process-desired graph. Across every event:

- a previously non-null `startedAt`, `finishedAt`, or `exitCode` must remain equal;
- `startedAt` may enrich only from null to non-null when the current F09 observation permits it;
- `finishedAt` may become non-null only as part of a transition to an F09 terminal observation;
- `exitCode` may enrich only from null to a signed 32-bit value in an F09 terminal observation.

When observed state is unchanged, every identity/ownership/`kind`/`finishedAt` field remains equal,
and the changed-field set must be a non-empty subset of:

- `desiredState`, provided it follows one structural process-desired edge;
- `startedAt`, only from null to non-null;
- `exitCode`, only from null to a signed 32-bit value while the unchanged state is `exited`,
  `failed`, or `killed`.

This permits the accepted same-`starting` enrichment from `startedAt: null` to a non-null timestamp,
as well as later recovery of a nullable terminal start time/exit code and replay-relevant desired
state changes. It rejects arbitrary same-state mutation. Applying the event replaces the matching
process snapshot `observation` with `current`; no output/log state is introduced.

#### Preview observation events

`preview.state.changed` carries `previousState` plus the complete exact F09
`PreviewInspectionData` current `observation`. The event resource's `projectId`, `workspaceId`, and
`previewId` must equal the observation identities.

`previousState: null` is allowed only when no prior Agent preview observation exists. Otherwise the
Agent validates against its retained prior `PreviewInspectionData`, whose identities and
`previewKey` must equal the current observation and whose `observedState` must equal
`previousState`. If the observed state changes, the pair must be one structural edge in the domain
preview-observed graph.

The accepted F09 preview shape has replay-relevant fields that may change while observed state is
unchanged. A same-state event is valid only when the retained prior/current observations are not
deeply equal, identities and `previewKey` remain equal, and the changed-field set is a non-empty
subset of:

- `desiredState`, provided it follows one structural preview-desired edge;
- the jointly validated `routePresent`/`hostname` observation fields.

Both retained prior and current observations must satisfy the complete F09 preview refinements.
Applying the event replaces the matching preview snapshot `observation` with the payload
observation. Web does not derive or clear hostname/route fields independently.

#### Lifecycle transition validation

For the five generic state-change event types, `previous: null` is allowed only when the Agent has no prior
observation for that exact resource identity, including first discovery after recovery. The
accepted lifecycle specification defines no narrower initial-observation subset, so `current` may
be any valid state in that resource's authoritative state vocabulary.

When `previous` is non-null, `previous -> current` must be one genuine edge in the authoritative
domain lifecycle graph. Equal states, reverse edges, and every absent edge are invalid.

Lifecycle graph ownership remains exclusively in `@devspace/domain`. The F10 implementation may
perform one narrow domain API extraction: expose the smallest pure structural edge predicates
needed by contracts when they are not already public. Exact predicate names are implementation
detail. The edge tables remain defined once in domain, and existing contextual transition
validators continue consuming that same authority without behavior changes. Contracts consume
only the structural predicates; they do not copy edge tables or construct recovery, dirty,
route-presence, owning-stack, runtime-absence, or other fabricated context.

The exact graph mapping is:

| Event | Domain-owned structural edge relation |
| --- | --- |
| `workspace.observed-state.changed` | workspace-observed graph |
| `runtime-stack.observed-state.changed` | runtime-stack-observed graph |
| `service.observed-state.changed` | workspace-service-observed graph |
| `terminal.state.changed` | terminal graph |

The full-observation events consume the same domain authority: process-observed and
process-desired structural predicates for `process.observation.changed`, and preview-observed and
preview-desired structural predicates for `preview.state.changed`.

`service.health.changed` follows the authoritative workspace-service-health graph: `unknown` may
transition to `starting`, `healthy`, or `unhealthy`; `starting` may transition to `healthy`,
`unhealthy`, or `unknown`; `healthy` may transition to `unhealthy` or `unknown`; and `unhealthy`
may transition to `healthy` or `unknown`. `previous: null` permits any valid health state as a first
observation. Equal health states and every absent edge are invalid. F10 consumes a pure
domain-owned structural health-edge predicate. The separate service-state/health invariant still
requires non-`unknown` health only while the service is actually observed `running`.

Other event resource parent fields are mandatory even when `operationId` is null. Absence of an
operation association never relaxes resource identity.

#### Snapshot/event recovery completeness

| Event category | Current state recovered from snapshot |
| --- | --- |
| `operation.progressed` | retained `accepted` observation with updated `updatedAt`; progress text is transient |
| `operation.succeeded` | retained `succeeded` observation when still recoverable |
| `operation.failed` | retained `failed` observation and `AgentExecutionFailure` when still recoverable |
| `project.inspected` | matching project `gitInspections` scope |
| `workspace.observed-state.changed` | `WorkspaceInspectionData.observedState` |
| `runtime-stack.observed-state.changed` | extracted `WorkspaceInspectionData["runtimeStack"].observedState` and matching runtime-stack member |
| `service.observed-state.changed` | `WorkspaceServiceObservation.observedState` |
| `service.health.changed` | `WorkspaceServiceObservation.health` |
| `process.observation.changed` | complete current `F10ProcessInspectionData` |
| `terminal.state.changed` | terminal snapshot member `state` |
| `preview.state.changed` | complete current `PreviewInspectionData`, including hostname and route presence |

When applying a runtime-stack state event, Web updates both the matching runtime-stack member and
the equal nested `WorkspaceInspectionData.runtimeStack.observedState` in its Agent-observed view so
the required snapshot equality remains true. The event carries one observation, not two divergent
states. When a service-state event moves the service away from `running`, Web also sets its
snapshot health to `unknown`.

`operation.progressed` messages are transient informational events and are not reconstructed by a
snapshot. Snapshots guarantee current Agent-observed resource state and every currently
nonterminal `accepted` or `running` operation observation. Retained terminal operation observations provide
best-available recovery only and remain subject to accepted F09 compaction. F10 does not claim
permanent historical operation-outcome recovery. No remaining F10 event changes durable current
Agent-observed resource state that the snapshot cannot represent.

### F10 errors and exhaustive route applicability

F10 adds exactly two error codes. Both use the ordinary strict `ErrorEnvelope` and are separate
from the unchanged 23-code F09 executable registry:

| Code | Status | Retryable | Exact strict details |
| --- | --- | --- | --- |
| `EVENT_CURSOR_INVALID` | `400` | false | `{ reason: one of ("missing", "malformed", "unsupported_version", "invalid_agent_boot_id", "invalid_sequence", "sequence_out_of_range") }` |
| `EVENT_SNAPSHOT_REQUIRED` | `409` | false | `{ reason: one of ("boot_mismatch", "cursor_expired", "history_unavailable"), currentAgentBootId: UuidV7, snapshotPath: "/v1/snapshot" }` |

The useful F09/F10 registry views are: unchanged F09-only (23), F10-only (2), and their combined
non-AI route-error view (25). F11 has a separate closed AI failure registry and reuses selected
F09 common/journal errors; it is not folded into this 25-code view. Existing F09-only public
exports retain their meaning and exclude both F10 and F11 codes. `AgentExecutionFailure` is a
separate 18-code post-acceptance value union and does not change these route-error code counts.

Cursor-invalid reason selection is deterministic and uses this precedence after query-collection
validation:

1. No `cursor` parameter: `missing`.
2. A first component matching `v` followed by one or more ASCII decimal digits, but not exactly
   `v1`: `unsupported_version`.
3. Otherwise, failure to split into exactly `v1`, one boot-ID component, and one sequence
   component, or any forbidden whitespace/additional component: `malformed`.
4. An exact `v1` structure whose boot component is not `UuidV7`: `invalid_agent_boot_id`.
5. A valid boot component whose sequence does not match `0|[1-9][0-9]*`:
   `invalid_sequence`.
6. A grammatically valid decimal sequence greater than 9007199254740991:
   `sequence_out_of_range`.

An empty cursor value is `malformed`. Duplicate `cursor` parameters are request-shape failures,
not cursor-value failures.

For a syntactically valid cursor, `EVENT_SNAPSHOT_REQUIRED.reason` follows this exact decision
model. Let `H` be the current boot's greatest emitted event sequence, or `0` before any event. Let
the earliest replayable cursor boundary `B` be:

- `N - 1` when `N` is the earliest normally retained real event;
- `H` when `H > 0` and normal retention has discarded every real event;
- `0` when `H = 0`.

Thus replay from cursor sequence `B` begins with the earliest retained event when one exists. A
cursor at `B` is not expired merely because no earlier event remains.

| Precedence | Condition | Result |
| --- | --- | --- |
| 1 | `cursor.agentBootId` differs from the current Agent boot ID | `boot_mismatch` |
| 2 | boot matches and `cursor.sequence < B` | `cursor_expired` |
| 3 | boot matches, cursor is not expired, and `cursor.sequence > H` | `history_unavailable` |
| 4 | boot matches, cursor is not expired, but the Agent cannot provide every event in the contiguous range `cursor.sequence + 1` through `H` because required retained history is missing, corrupt, or unreadable | `history_unavailable` |
| 5 | none of the above | replay is valid |

Sequence zero is replayable exactly while `B = 0`. If the earliest retained event is `1`, cursor
zero remains the valid boundary immediately before it. Once normal retention advances `B` above
zero, cursor zero is expired. `history_unavailable` is never used as another name for ordinary
retention expiry.

The following route table is exhaustive:

| Operation | Exact executable errors |
| --- | --- |
| `snapshot.get` | reused F09 `PROTOCOL_VERSION_UNSUPPORTED (400/426)`; reused F09 `REQUEST_INVALID (400)`; reused F09 `AGENT_INTERNAL_ERROR (500)` |
| `event.stream` | reused F09 `PROTOCOL_VERSION_UNSUPPORTED (400/426)`; F10-only `EVENT_CURSOR_INVALID (400)`; reused F09 `REQUEST_INVALID (400)`; F10-only `EVENT_SNAPSHOT_REQUIRED (409)`; reused F09 `AGENT_INTERNAL_ERROR (500)` |

Both routes reuse the common DevSpace protocol-version header behavior and exact existing
`PROTOCOL_VERSION_UNSUPPORTED` retryability/details schema. `REQUEST_INVALID` is limited to other
non-cursor request-shape failures: forbidden DevSpace headers, forbidden body, unknown/duplicate
query parameters, or any query input on `snapshot.get`. Missing or invalid `event.stream` cursor
values always use `EVENT_CURSOR_INVALID`, never `REQUEST_INVALID`. These responsibilities do not
overlap.

When more than one defect is present, validation precedence is: protocol-version metadata first;
then other header/body/query-collection shape; then cursor value syntax/representation; then
runtime replay availability. This selects, respectively, `PROTOCOL_VERSION_UNSUPPORTED`,
`REQUEST_INVALID`, `EVENT_CURSOR_INVALID`, or `EVENT_SNAPSHOT_REQUIRED`.

All errors occur before the successful response begins. After `event.stream` sends HTTP `200`, no
JSON error envelope may be appended; a later failure closes the transport.

### NDJSON event-stream framing

Successful `event.stream` response metadata is exactly:

```text
HTTP status: 200
Content-Type: application/x-ndjson; charset=utf-8
```

Each emitted line is one complete valid ordinary JSON serialization of one strict `AgentEvent`,
encoded as UTF-8 and followed by one LF byte (`0x0A`). Raw CR (`0x0D`) and LF bytes are forbidden
inside the line; logical newlines inside JSON strings use normal JSON escape sequences and do not
break framing. Insignificant single-line JSON whitespace is permitted, while producers should emit
compact JSON. Object property order is semantically insignificant. RFC 8785/JCS and canonical
property ordering are not required, and consumers must not depend on byte-for-byte
canonicalization or property order.

Blank lines are forbidden. CRLF is not an alternative delimiter. Pretty-printed/multiline JSON is
invalid because it contains raw line breaks. Every complete event, including the final complete
event before a normal close, is terminated by LF.

If a connection ends with a final line that lacks its terminating LF, that line is uncommitted and
Web discards it even when its bytes happen to parse as complete JSON. Web advances its cursor only
after a fully processed LF-terminated event and reconnects from the last such cursor. Terminal
bytes, raw process output bytes, and raw interactive AI bytes are never NDJSON event content.

F10 requires the exact content-type constant, event schemas, and framing fixtures. The F10 package
root does not expose an NDJSON codec API. Fixture tests may use a test-local pure one-event line
helper, but fixtures compare parsed semantic event values or an explicitly fixed serializer vector;
they must not imply that every producer uses one property order. The helper is not a versioned
public contract. No stream reader, buffering state machine, backpressure, transport, or writer
implementation belongs to F10.

### Runtime-only ordering, replay, and snapshot semantics

Individual runtime schemas can validate sequence ranges, cursor grammar/range, cursor/event
boot-and-sequence equality for one event, and snapshot boot/through-cursor equality. Snapshot
schemas also enforce their cross-field and uniqueness refinements described above.

The following are runtime history/transport guarantees and must be documented in generated schema
comments rather than falsely claimed as standalone JSON Schema validation:

- on every Agent start, a new `agentBootId` is created and the first real event sequence is `1`;
- within one boot, emitted event sequences increase by exactly one;
- replay returns retained events in sequence order with sequence greater than the supplied cursor;
- a snapshot is self-consistent through its `throughCursor`;
- reconnect after snapshot recovery begins after that cursor;
- retained replay has no intentional gap.

Replay succeeds only while the cursor boot ID is current and every required later event remains
retained. A wrong boot, expired cursor, or unavailable required history produces
`EVENT_SNAPSHOT_REQUIRED`. Web then fetches `/v1/snapshot`, replaces its Agent-observed view, and
resubscribes from `throughCursor`. No F10 schema calculates retention, stores history, performs
replay, or implements snapshot collection.

## F11 AI Session extension

F11 is normative contract infrastructure only. Slice 0 adds descriptors, schemas, fixtures, and
generated JSON Schema; it does not add Agent route handlers, an outbox implementation, provider
execution, or Web/browser transport.

The complete AI domain, data-plane rules, event payload table, provider adapter, sequence/outbox
proof, and replay semantics are authoritative in `ai-sessions-v1.md`. This section fixes their
placement in Agent API v1.

### F11 inventory

There are exactly **10** F11 operations: seven journaled mutations and three non-journaled
inspection/stream/acknowledgement controls.

| Stable operation | Method | Exact path/query | Request data | Success |
| --- | --- | --- | --- | --- |
| `ai-provider.inspect` | POST | `/v1/ai-profiles/inspect` | `InspectAiProviderData` | `200 AiProviderProfileProjection` |
| `ai-session.start` | POST | `/v1/ai-sessions/start` | `StartAiProviderData` | `202 MutationReceipt` |
| `ai-session.resume` | POST | `/v1/ai-sessions/resume` | `ResumeAiProviderData` | `202 MutationReceipt` |
| `ai-session.turn.send` | POST | `/v1/ai-sessions/send-turn` | `SendAiTurnData` | `202 MutationReceipt` |
| `ai-session.turn.interrupt` | POST | `/v1/ai-sessions/interrupt` | `InterruptAiTurnData` | `202 MutationReceipt` |
| `ai-session.approval.respond` | POST | `/v1/ai-sessions/respond-approval` | `RespondAiApprovalData` | `202 MutationReceipt` |
| `ai-session.input.respond` | POST | `/v1/ai-sessions/respond-input` | `RespondAiInputData` | `202 MutationReceipt` |
| `ai-session.stop` | POST | `/v1/ai-sessions/stop` | `StopAiProviderData` | `202 MutationReceipt` |
| `ai-session.events.stream` | GET | `/v1/ai-sessions/{aiSessionId}/events?afterSequence=<decimal>` | none | `200` AI NDJSON |
| `ai-session.events.acknowledge` | POST | `/v1/ai-sessions/acknowledge-events` | `AcknowledgeAiEventsData` | `200` echo |

The seven lifecycle/content mutations use the existing common mutation headers, durable operation
journal acceptance boundary, replay/conflict rules, and `MutationReceipt`, with the explicit
content-bearing private-intent policy below. Inspection, stream, and acknowledgement
forbid the operation-ID header. Event acknowledgement may advance only private outbox retention;
it is idempotent, has no provider/workspace side effect, and is not a Web SQLite operation.

F11 path parameter `aiSessionId` is one canonical UUIDv7 segment. `afterSequence` is one required
canonical unsigned decimal from `0` through `9007199254740991`, with no sign or leading zero.

### F11 request shapes

Every object is strict. `RuntimeBinding` and `ProcessBinding` are:

```text
RuntimeBinding = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  aiSessionId: UuidV7,
  revisionId: UuidV7,
  runtimePlanHash: ProjectOptionsRevisionHash,
  runtimeGeneration: 1..9007199254740991,
  profileId: ConfigurationKey,
  profileRevision: "sha256-ai-profile-v1:<64 lowercase hex>"
}

ProcessBinding = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  aiSessionId: UuidV7,
  profileId: ConfigurationKey,
  profileRevision: "sha256-ai-profile-v1:<64 lowercase hex>",
  processGeneration: 1..9007199254740991
}
```

```text
InspectAiProviderData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  profileId: ConfigurationKey
}

StartAiProviderData = RuntimeBinding
ResumeAiProviderData = RuntimeBinding

SendAiTurnData = ProcessBinding & {
  turnId: UuidV7,
  content: { kind: "text", text: bounded content }
}

InterruptAiTurnData = ProcessBinding & { turnId: UuidV7 }

RespondAiApprovalData = ProcessBinding & {
  turnId: UuidV7,
  requestId: UuidV7,
  decision: "approve-once" | "approve-for-session" | "deny" | "cancel"
}

RespondAiInputData = ProcessBinding & {
  turnId: UuidV7,
  requestId: UuidV7,
  answers: bounded structured answers
}

StopAiProviderData = ProcessBinding

AcknowledgeAiEventsData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  aiSessionId: UuidV7,
  throughSequence: 1..9007199254740991,
  throughEventId: UuidV7
}
```

Browser selection still carries only `profileId`. Web inspects the safe projection and sends both
`profileId` and the resulting `profileRevision` in start/resume. Agent independently resolves and
hashes the deployed authority document and requires an exact match before durable acceptance or
execution. Every later command carries the same revision. No request contains native provider
identity, Docker/process identity, executable, argument, environment, cwd, credential, sandbox,
or permission value.

The profile revision uses the exact versioned domain-separated JCS algorithm in
`ai-sessions-v1.md`. It binds every executable-authority field but exposes only the safe digest.

### F11 operation journal policies

Every F11 mutation descriptor has an executable `operationJournalPolicy`:

| Policy | Operations | Private durable representation |
| --- | --- | --- |
| `generic-request` | start, resume, interrupt, approval response, stop | existing complete bounded validated request |
| `ai-private-intent-reference` | send turn, structured-input response; mandatory for future content-bearing mutations | generic journal identity/name plus keyed fingerprint and reference; complete request only in dedicated private AI intent |

For private intents, the Agent must durably and atomically establish the strict referenced record
before accepting the generic journal entry or performing side effects. The intent binds operation,
resource, profile revision, and process generation identities. Both the generic journal reference
and private record retain the same strict fingerprint identity:

```text
{
  algorithm: "hmac-sha256-ai-private-intent-v1",
  keyVersion: ConfigurationKey,
  digest: 64 lowercase hexadecimal characters
}
```

The HMAC input, key lifecycle, replay rules, and domain-separated canonical document are normative
in `ai-sessions-v1.md`. Replay uses the recorded key version only; it never substitutes the active
key. Missing, unknown, corrupt, or prematurely retired key material or intent state is
journal/private-state unavailability and fails closed. The record has restrictive permissions and
bounded retention, and neither its content, reference, fingerprint identity, nor key version
enters public operation observations, logs, diagnostics, audits, generic errors, or browser data.
Slice 0 defines but does not implement this storage.

### Profile response and capability advertisement

`ai-provider.inspect` returns only:

```text
{
  profileId,
  profileRevision,
  provider,
  displayName,
  capabilities: {
    inspect: true,
    start: true,
    resume: boolean,
    sendTurn: true,
    interrupt: boolean,
    approvals: boolean,
    structuredInput: boolean,
    stop: true,
    streamEvents: true
  },
  availability
}
```

This is the F11 capability advertisement. The existing implemented F09 `/v1/capabilities` response
is unchanged in Slice 0. Provider-specific browser branching is forbidden.

### F11 errors

F11 routes reuse `PROTOCOL_VERSION_UNSUPPORTED`, `REQUEST_INVALID`, and `AGENT_INTERNAL_ERROR`.
Journaled mutations additionally reuse `OPERATION_CONFLICT` and
`OPERATION_JOURNAL_UNAVAILABLE`. F11 adds this separate closed registry:

| Code | HTTP | Retryable | Category | Incident |
| --- | ---: | --- | --- | --- |
| `AI_PROFILE_NOT_FOUND` | 404 | false | user-error | no |
| `AI_PROFILE_UNAVAILABLE` | 503 | true | dependency-unavailable | no |
| `AI_PROFILE_REVISION_CONFLICT` | 409 | false | state-conflict | no |
| `AI_CAPABILITY_UNSUPPORTED` | 422 | false | user-error | no |
| `AI_SESSION_STATE_CONFLICT` | 409 | false | state-conflict | no |
| `AI_TURN_STATE_CONFLICT` | 409 | false | state-conflict | no |
| `AI_INTERACTION_STATE_CONFLICT` | 409 | false | state-conflict | no |
| `AI_IDENTITY_MISMATCH` | 409 | false | internal-failure | yes |
| `AI_EVENT_SEQUENCE_CONFLICT` | 409 | false | protocol-failure | yes |
| `AI_EVENT_GAP` | 409 | false | protocol-failure | yes |
| `AI_OUTBOX_UNAVAILABLE` | 503 | true | dependency-unavailable | yes |
| `AI_PROVIDER_TRANSPORT_FAILURE` | 502 | true | transport-failure | yes |
| `AI_PROVIDER_PROTOCOL_FAILURE` | 502 | false | protocol-failure | yes |
| `AI_INTERNAL_FAILURE` | 500 | true | internal-failure | yes |

The executable F11 envelope contains common response metadata and:

```text
error: {
  code,
  message: ErrorMessage,
  retryable: literal policy value,
  failure: { code, category, incidentId }
}
```

The nested code must equal the envelope code. Incident presence must match the table. The message
is a bounded safe projection and never includes content/private-plane values. Expected profile
unavailability and lifecycle conflicts have no incident.

Route applicability is closed:

- inspect: profile-not-found or internal;
- start: profile/identity/session/outbox;
- resume: start set plus capability unsupported;
- send: profile/identity/session/turn/outbox;
- interrupt: send set plus capability unsupported;
- approval/input response: send set plus capability and interaction conflict;
- stop: profile/identity/session/outbox;
- stream: identity, sequence conflict, gap, or outbox unavailable;
- acknowledge: identity, sequence conflict, or outbox unavailable.

### Event stream, acknowledgement, and recovery

F11 NDJSON carries strict `CanonicalAiEvent` lines followed at replay/live handoff by the strict
`stream.synchronized` control frame. It is separate from F10's boot-scoped Agent event stream and
the terminal WebSocket. AI sequence is per DevSpace session, persistent across Agent boots and
process generations, and assigned before delivery by the Agent-private durable acknowledged
outbox.

Web commits in sequence before browser publication, acknowledges exact
`(sessionId, sequence, eventId)`, accepts only exact duplicate replay, and treats conflict/gap as
incident-bearing protocol failures. The general F10 snapshot contains no AI-session member and
accepts process kinds `task | terminal` only; F10 has no first-class AI provider-process member or
`ai-session.state.changed` event. Later Web recovery obtains current AI state from its SQLite read
model and reconnects F11 from the greatest committed session sequence.

No browser route or stream is implemented here. Its later contract must reuse application
authentication, Origin checks, and exact project/workspace/session authorization and may emit only
Web-committed events.

## Implementation-readiness invariants

An F09 implementation and its invariant tests must establish all of the following from this
document without another protocol decision:

1. The historical F09 endpoint registry contains exactly 30 unique stable operation names and 30
   unique method/path pairs; its four AI entries are excluded from active complete composition,
   and the terminal upgrade's transport method is HTTP GET.
2. Every F09 path begins with `/v1`; only terminal stream has a path parameter; no F09 endpoint has
   query parameters.
3. Exactly the 20 mutation rows require only the caller-supplied operation-ID header. No parser
   generates an operation ID, and no public idempotency-key or request-hash field exists.
4. Every POST body is the strict `{ data }` envelope and every GET/upgrade has no body.
5. Every ordinary endpoint has one exact success status and closed success data schema.
6. Every route's errors are the exact union of the global/mutation sets and its listed codes; every
   error code selects one literal retryability value and one closed details schema.
7. All object and union boundaries recursively reject unknown keys and all discriminators are
   closed.
8. IDs, timestamps, Project Options revision hashes, Git values, URLs, canonical JSON text, and numeric bounds reject
   malformed or non-canonical spellings without coercion.
9. Lifecycle values and the extracted branch-shorthand primitive are imported from the
   authoritative domain public API rather than duplicated as second implementation authorities;
   the security public branch validator delegates without F06 behavior changes.
10. The contracts package depends on `@devspace/domain` only among production workspace packages;
    it does not import Project Options, database, Agent, or Web implementation.
11. No F09 schema accepts executable commands, arbitrary arguments, host paths, Docker identifiers,
    PIDs, mounts, host ports, gateway targets, Caddy fragments, secret values, or open metadata.
12. F09 exports no event, cursor, sequence, snapshot, replay, NDJSON success, F10 error, runtime
    plan, or reconciliation schema.

### F10 implementation-readiness invariants

An F10 implementation and its independent fixtures must establish all of the following without a
new protocol decision:

1. The F10 inventory contains exactly the two named GET routes; active complete v1 is 26 non-AI
   F09 routes plus two F10 routes plus ten F11 routes, exactly 38 without reconciliation.
2. `EventSequence` accepts exactly safe integers 1..9007199254740991; zero is rejected.
3. `EventCursor` accepts exactly the specified ASCII grammar and range, including `.0`.
4. Snapshot `agentBootId` equals the boot component of `throughCursor`.
5. Snapshot data contains exactly the four named fields and both arrays may be empty.
6. The snapshot resource union contains exactly seven members, uses the exact type-specific
   identity keys, supports all project Git scopes, and contains no source inspection.
7. Snapshot resources, project Git scopes, and operation observations enforce their exact
   uniqueness rules without imposing array order.
8. Agent operation observations use exactly `accepted`, `running`, `succeeded`, and `failed`, expose
   both nonterminal phases, enforce exact event application, retain every nonterminal operation,
   and leave terminal retention subject to F09 compaction.
9. `AgentExecutionFailure` contains exactly the 18 enumerated post-acceptance-capable codes, all 23
   F09 codes have one explicit classification, all 20 mutations have exact applicability, and
   retryability never re-executes the same operation ID.
10. The event union contains exactly the 11 table discriminators, each with one exact resource,
    operation-ID, and payload contract; no second UUID event identity, cancellation event,
    process-output event, or special process start/exit event exists.
11. An event cursor equals that event's boot ID and sequence; a cursor ending in `.0` cannot appear
    in an event envelope.
12. Nested objects, empty payloads, failure values, and every union member reject unknown fields.
13. Project Git scope/inspection identities and every embedded F09 observation refinement are
    enforced.
14. Structural edge predicates remain domain-owned, contracts fabricate no contextual evidence,
    non-null generic state pairs are genuine edges, and full process/preview observations follow
    their exact structural and same-state change rules.
15. `boot_mismatch`, `cursor_expired`, and `history_unavailable` follow the exact replay-boundary
    decision table, including sequence zero.
16. The F10-only error registry contains exactly two codes, the F09 view remains exactly 23, and
    the complete view is exactly 25.
17. Both F10 routes reuse `PROTOCOL_VERSION_UNSUPPORTED`; cursor-value and other request-shape
    errors follow the non-overlapping route table.
18. NDJSON fixtures prove ordinary non-JCS JSON semantics, one LF-terminated event per line, no
    blanks, no CRLF, property-order independence, and rejection of an incomplete final line for
    cursor advancement.
19. The recovery matrix accounts for every current-state effect of the 11 events, treats progress
    messages as transient, guarantees all current nonterminal observations, and marks
    terminal operation recovery as best-available.
20. Generated schema comments distinguish object-level refinements from stream/history guarantees.
21. No F10 fixture, export, schema, or inventory entry introduces source-inspection ownership,
    reconciliation, a public streaming codec, terminal/output bytes, output retention, persistence,
    replay execution, or F11 behavior.
22. F10 process snapshots and both non-null event observations accept only `task | terminal`;
    historical F09 `ai-session` process vocabulary never becomes a second first-class AI
    observation path.

### F11 implementation-readiness invariants

1. F11 contains exactly ten unique operations: seven journaled mutations and three non-journaled
   controls; active complete v1 contains no superseded F09 AI descriptor.
2. Every start/resume request carries safe runtime identity plus exact `profileId` and
   `profileRevision`; Agent re-hashes the deployed profile before acceptance, and every subsequent
   mutation fences the same revision and provider-process generation.
3. The command union contains exactly the nine provider-neutral capabilities and no executable,
   argument, environment, cwd, container, native-provider, or credential authority.
4. Required capability flags are literals `true`; the four optional flags are closed booleans and
   unsupported behavior is `AI_CAPABILITY_UNSUPPORTED`.
5. Content and presentation fields enforce exact UTF-8 bounds; paths are safe workspace-relative
   presentations and command text grants no authority.
6. The canonical event union contains exactly 22 discriminators, recursively rejects unknown
   fields, requires null/non-null turn identity by family, and contains no raw JSON-RPC/native ID.
7. Append classification receives both the sequence lookup and global event-ID lookup, accepts
   only the next sequence or an exact semantic duplicate, rejects event-ID reuse at another
   sequence, and distinguishes conflicts from gaps without timestamps.
8. Agent sequence/outbox continuity crosses boots and process generations; Web commit precedes
   browser delivery and exact Web acknowledgement precedes Agent retention removal.
9. Replay emits persisted events then one synchronization frame under a gap-free replay/live
   handoff; slow consumers and exhausted durable bounds fail closed.
10. F11 failures have exact category/incident policy and never project raw provider errors or
    content-plane values.
11. The Codex adapter tests read, byte-hash, parse, and inspect actual CLI 0.145.0 generated
    stable-default component fixtures plus the separately generated optional experimental
    structured-input component, without network access.
12. Content-bearing F11 mutations declare private-intent-reference journaling and never place
    prompts or answers in generic journal records or public operation observations.
13. Historical Slice 0 added no route handlers, provider runtime, supervisor, persistence,
    credentials, browser stream, or UI. Beta Slice B now supplies the F11 handlers, Agent runtime,
    Web-owned persistence and routes, exact browser stream, Agent-private credential staging, and
    Workbench AI tab; approvals and structured questions remain Checkpoint 2.
