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

F09 owns the 29 endpoints in the F09 inventory and their ordinary request, response, error, and
terminal-stream wire contracts. F10 owns snapshot and event contracts. The F10 material retained
at the end of this document is normative design input for F10 but is not part of F09's endpoint
count or implementation surface.

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
| `GitBaseRef` | Strict union `{ kind: "branch", branchName: GitBranchName } | { kind: "commit", commit: GitObjectId }`. Tags, revision expressions, reflog syntax, and arbitrary Git ref syntax are not accepted in v1. |
| `RemoteRepositoryUrl` | Absolute `https:` or `ssh:` URL of 1 through 2048 UTF-8 bytes, with a non-empty host, no fragment, and no control or whitespace character. HTTPS URLs have no user-info. SSH URLs may have a non-empty username but no password. Other schemes are invalid. Approval remains Agent policy. |
| `CanonicalJsonObjectText` | JSON string whose UTF-8 encoding is 2 through 2,097,152 bytes and is exactly the RFC 8785/JCS serialization of one JSON object. Duplicate keys, non-object roots, and non-canonical spellings are invalid. |
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
operation name and the complete validated request data. An exact replay may return the previously
durable F09 response without repeating side effects. Reuse of the same ID for another operation
name or different validated request data returns `OPERATION_CONFLICT`. The Agent may compare a
private deterministic fingerprint in its durable journal; its format, canonicalization, and hash
algorithm are private implementation details and are not Agent API fields or
`@devspace/contracts` responsibilities. F09 exposes no idempotency key, request hash, expiry, or
reuse-after-expiry behavior. Journal compaction must preserve operation-ID reuse safety.

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

## F09 endpoint inventory

The exact F09 count is **29**: 19 journaled mutations, nine ordinary non-mutating HTTP operations,
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

The only F09 path parameter is `terminalId`. It is one decoded path segment and must be a `UuidV7`;
percent-encoded or non-canonical UUID spellings are rejected.

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
```

The configuration hash identifies the complete default-materialized Project Options revision. The
contract checks the representation and the Agent checks that it matches `canonicalJson`; neither
action imports Project Options parsing or hashing into `@devspace/contracts`. F09 defines no
runtime-plan schema, canonical representation, compiler contract, format string, or hash. Milestone
1 may extend or version the configuration/runtime-plan relationship only after those runtime-plan
contracts are accepted.

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

InspectGitData = {
  projectId: UuidV7,
  workspaceId: UuidV7 | null
}
```

A `registered-local` source ID names one administrator-configured source location. Requests never
carry its host path. A remote URL must contain no embedded credential. `workspaceId: null` asks for
the managed project store; a UUID asks for that project's workspace worktree.

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

`branchName` is the validated branch shorthand to create or attach. `baseRef` is either one
validated branch name or one exact Git object ID from which a new worktree is based. The Agent
resolves both within the managed project store. Archive
with `preserve` retains the worktree and its changes. Remove with `discard` explicitly authorizes
destruction of uncommitted workspace changes. `reject` fails if an isolated workspace is dirty.
Primary-workspace policy may reject archive or removal with `RUNTIME_POLICY_VIOLATION`.

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
  previewId: UuidV7,
  previewKey: ConfigurationKey
}

PreviewIdentityData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  previewId: UuidV7
}
```

Only activation carries the configuration key. Subsequent actions use the stable preview ID and
the owning workspace identity. The Agent retains the accepted key/revision association and derives
service, target port, hostname, and route.

### AI-session shapes

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

No request accepts provider credentials, an executable, arguments, prompt text, environment
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
SourceInspectionData = {
  sourceKind: "registered-local" | "remote",
  isGitRepository: boolean,
  defaultBranch: GitBranchName | null,
  headCommit: GitObjectId | null
}
```

`defaultBranch` and `headCommit` are both null when `isGitRepository` is false. A Git repository
may have an unborn default branch, in which case `defaultBranch` is non-null and `headCommit` is
null.

```text
GitInspectionData = {
  projectId: UuidV7,
  workspaceId: UuidV7 | null,
  branchName: GitBranchName | null,
  headCommit: GitObjectId | null,
  dirty: boolean,
  aheadCount: NonNegativeCount,
  behindCount: NonNegativeCount
}
```

For the managed store (`workspaceId: null`), `dirty` is always false. `branchName` and `headCommit`
may be null for an unborn repository state. Counts are relative to the configured upstream; both
are zero when no upstream is configured.

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
terminal state, because a signalled or unrecoverable outcome may have no code.

```text
PreviewInspectionData = {
  projectId: UuidV7,
  workspaceId: UuidV7,
  previewId: UuidV7,
  previewKey: ConfigurationKey,
  desiredState: PreviewDesiredState,
  observedState: PreviewObservedState,
  routePresent: boolean,
  hostname: string | null
}
```

When non-null, `hostname` is a lowercase ASCII DNS hostname of 1 through 253 characters: labels are
1 through 63 characters, match `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, and are separated by literal
dots. `hostname` is non-null exactly when `routePresent` is true. `routePresent` must be false when
the observed state is `inactive`, `failed`, or `lost`.

## Stable error registry

The executable F09 registry contains **23 codes**. Retryability is a literal part of each code's
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
| `PROCESS_IDENTITY_MISMATCH` | Retained process ownership/token evidence does not match the live runtime process. | `409` | false | `{ processId: UuidV7 }` | route-specific |
| `PREVIEW_NOT_DEFINED` | The registered revision does not define the requested preview key. | `422` | false | `{ revisionId: UuidV7, previewKey: ConfigurationKey }` | route-specific |
| `AI_NOT_CONFIGURED` | The workspace's registered Project Options revision has `aiProfile: null`. | `422` | false | `{ workspaceId: UuidV7, revisionId: UuidV7 }` | route-specific |
| `PREVIEW_DOMAIN_NOT_APPROVED` | The derived preview hostname is outside the approved domain registry. | `422` | false | `{ previewId: UuidV7 }` | route-specific |
| `GATEWAY_UPDATE_FAILED` | The narrow preview gateway adapter could not apply the derived route update. | `503` | true | `{ previewId: UuidV7 }` | route-specific |
| `ROOTLESS_RUNTIME_UNAVAILABLE` | The dedicated rootless runtime required by the route is unavailable. | `503` | true | `{ component: "docker" }` | route-specific |
| `AGENT_INTERNAL_ERROR` | An unexpected redacted Agent failure occurred. | `500` | true | `{ incidentId: UuidV7 }` | global |

## Route-specific error applicability

The following named sets make the table concise without making it open-ended:

- `G` = `PROTOCOL_VERSION_UNSUPPORTED (400/426)`, `REQUEST_INVALID (400)`,
  `AGENT_INTERNAL_ERROR (500)`.
- `M` = `OPERATION_CONFLICT (409)`, `OPERATION_JOURNAL_UNAVAILABLE (503)`; `M` is added only to
  mutations.
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
| `project.source.inspect` | `G`; `SOURCE_NOT_FOUND (404)`; `SOURCE_UNAVAILABLE (503)`; `RUNTIME_POLICY_VIOLATION (422)` |
| `project.managed-store.create` | `G`; `M`; `RESOURCE_STATE_CONFLICT` (409; type `project`); `SOURCE_NOT_FOUND (404)`; `SOURCE_INVALID (422)`; `SOURCE_UNAVAILABLE (503)`; `RUNTIME_POLICY_VIOLATION (422)` |
| `project.fetch` | `G`; `M`; `PROJECT_NOT_FOUND (404)`; `SOURCE_UNAVAILABLE (503)` |
| `project.git.inspect` | `G`; `PROJECT_NOT_FOUND (404)`; `RESOURCE_NOT_FOUND` (404; type `workspace`); `SOURCE_UNAVAILABLE (503)` |
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
endpoint and M0-F10 explicitly excludes terminal frames. This section defines framing only; it does
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

## F10-deferred inventory and retained design

The exact F10-deferred endpoint count is **2**:

| Stable operation name | Method | Exact path/query | F10 responsibility |
| --- | --- | --- | --- |
| `snapshot.get` | GET | `/v1/snapshot` with no query | Exact snapshot resource union, boot identity, and through-cursor schema |
| `event.stream` | GET | `/v1/events?cursor=<cursor>` with exactly one required cursor query parameter | Event union, event sequence, cursor validation, replay, retention conflict, and NDJSON streaming |

F09 does not define or implement their request/success schemas, event envelopes, cursor allocation,
replay, snapshot recovery, stream transport, or errors. F10 will apply the common request metadata
and ordinary pre-stream error envelope. Its future error inputs are
`EVENT_SNAPSHOT_REQUIRED (409, retryable false)` with strict details
`{ reason: "boot_mismatch" | "cursor_expired" | "history_unavailable", currentAgentBootId:
UuidV7, snapshotPath: "/v1/snapshot" }`, and `EVENT_CURSOR_INVALID (400, retryable false)` with
strict empty details. Neither code is an executable F09 error or export.

The following accepted F10 design is retained as normative input for that task.

On every Agent start, the Agent creates a new `UuidV7` `agentBootId`; emitted event sequences begin
at `1`, are positive unsigned decimal integers without leading zeroes, and increase by exactly one.
No event has sequence zero. A cursor has exact ASCII grammar:

```text
v1.<lowercase UUIDv7 agentBootId>.<sequence>
```

The cursor sequence component has grammar `0|[1-9][0-9]*`. Zero is a cursor boundary only. A
snapshot before the first event may return a through-cursor ending in `.0`. An event cursor names
that event; subscribing from a cursor replays retained events with greater sequence and then waits
for new events.

Replay succeeds only when the cursor boot ID is current and all later sequences remain retained.
A boot mismatch, expired cursor, or unavailable required history returns
`EVENT_SNAPSHOT_REQUIRED`. Web then obtains `/v1/snapshot`, replaces its Agent-observed view, and
subscribes from the snapshot's `throughCursor`. Cursors are Agent-observation cursors, not SQLite
audit sequences, and never cross boot streams.

F10 will define `GET /v1/events` success as HTTP `200` with
`Content-Type: application/x-ndjson; charset=utf-8`; each complete line is one strict event. Errors
before streaming use the ordinary JSON error envelope. Failure after streaming begins closes the
connection, and Web reconnects with its last fully processed cursor.

The accepted event-envelope design to be completed in F10 is:

```text
{
  protocolVersion: 1,
  eventId: UuidV7,
  agentBootId: UuidV7,
  sequence: positive integer,
  cursor: same-boot cursor naming this event,
  occurredAt: UtcTimestampMs,
  operationId: UuidV7 | null,
  resource: <F10-defined resource reference or null>,
  type: F10 event-type discriminator,
  payload: F10 event-specific closed payload
}
```

F10 must constrain `resource.type`, nullability, and payload together for every event discriminator.
`operationId` is nullable because observation, health, and process-output-availability events can
occur outside an operation. `resource` is nullable only for event types
that F10 explicitly classifies as Agent-wide. Absence of an operation never weakens resource
authorization or event ordering.

F10 must define strict payloads for these event types:

- `operation.progressed`
- `operation.succeeded`
- `operation.failed`
- `operation.cancelled`
- `project.inspected`
- `workspace.observed-state.changed`
- `runtime-stack.observed-state.changed`
- `service.observed-state.changed`
- `service.health.changed`
- `process.started`
- `process.output.available`
- `process.exited`
- `terminal.state.changed`
- `preview.state.changed`
- `ai-session.state.changed`

Terminal and interactive AI bytes remain exclusively in terminal binary streams. F10 JSON events
may announce state or output availability but never carry terminal bytes.

## Implementation-readiness invariants

An F09 implementation and its invariant tests must establish all of the following from this
document without another protocol decision:

1. The endpoint registry contains exactly 29 unique stable operation names and 29 unique
   method/path pairs; the terminal upgrade's transport method is HTTP GET.
2. Every F09 path begins with `/v1`; only terminal stream has a path parameter; no F09 endpoint has
   query parameters.
3. Exactly the 19 mutation rows require only the caller-supplied operation-ID header. No parser
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
11. No schema accepts executable commands, arbitrary arguments, host paths, Docker identifiers,
    PIDs, mounts, host ports, gateway targets, Caddy fragments, secret values, or open metadata.
12. F09 exports no event, cursor, sequence, snapshot, replay, NDJSON success, F10 error, runtime
    plan, or reconciliation schema.
