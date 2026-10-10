# AI Sessions v1

## Status, scope, and authority

This is the versioned contract for first-class structured DevSpace AI sessions. ADR 015 owns the
architecture decision. `@devspace/domain` owns executable lifecycle edges.
`@devspace/contracts` owns executable public schemas and the Agent API F11 extension. The pinned
Codex adapter boundary is internal to Agent and is not a public provider protocol.

Historical Foundation Slice 0 defined architecture and contracts only; that slice itself added no
provider process, supervisor, route handler, Web API, SQLite migration, credential delivery, browser
stream, or Workbench UI. The current Beta Slice B implementation now includes the F11 handlers,
Agent-owned Codex runtime, Web routes, Web-owned SQLite session/turn/event storage, exact
acknowledgement, credential staging, browser event streaming, and the Workbench AI tab. Approvals and
structured questions remain Checkpoint 2.

The authority path is:

```text
authenticated browser
  │ safe intent/profile ID/content
  ▼
Web ── sole SQLite writer; authorization; committed public history
  │ strict F11 over private Unix socket
  ▼
Agent ── profile/process/native-protocol authority; durable private outbox
  │ exact rootless-Docker runtime and exact owned container
  ▼
in-container supervisor ── exact process-generation/control proof
  │ non-TTY stdin/stdout JSONL; private stderr
  ▼
approved Codex app-server process
```

Browser requests never contain executable paths, launch arguments, environment values, working
directories, host paths, container/Docker exec/PID identities, provider-native IDs, credential
values, sandbox policies, or permission policies.

## Data planes

### Content plane

The content plane is authorized session content: prompts, assistant text, code, activity and command
presentations, workspace-relative path presentations, approval descriptions, questions, and
answers. Content:

- is persisted only in dedicated AI-session storage;
- may be shown only to the authenticated owner authorized for the exact project/workspace/session;
- is strictly typed, valid Unicode, NUL-free, and UTF-8 byte-bounded;
- is never placed in structured diagnostics, incident details, audit summaries, generic safe
  errors, metrics labels, or URLs; and
- grants no executable authority, even when text resembles a shell command or path.

Executable bounds are:

| Value | Maximum |
| --- | ---: |
| one user text turn or text answer | 262,144 UTF-8 bytes |
| one streamed output delta | 65,536 UTF-8 bytes |
| one completed output item | 1,048,576 UTF-8 bytes |
| command/activity presentation text | 32,768 UTF-8 bytes |
| workspace-relative presented path | 4,096 UTF-8 bytes |
| paths in one presentation | 256 |
| questions in one request | 16 |
| options in one question | 32 |

A presented path is `.` or a canonical slash-separated path relative to `/workspace`. Absolute
paths, backslashes, empty components, `.` components, and `..` components are invalid.

### Control plane

The control plane contains only allowlisted opaque IDs and bounded orchestration observations:
project/workspace/configuration/session/turn/request/event/operation IDs, runtime-plan hash,
runtime and provider-process generation, profile ID/revision/provider, capabilities, lifecycle
state, event sequence, stable failure code, and canonical UTC-millisecond observation timestamps.

Structured diagnostics require a separate explicit field allowlist. Merely being in this plane does
not make a field loggable in every context.

### Private plane

Credentials/tokens, environment values, host paths, raw/private container paths, raw provider
requests/notifications/errors, provider-native thread/turn/item/request IDs, JSON-RPC request IDs,
complete commands/launch arguments, Docker exec/PID/supervisor identities, control credentials,
and Agent ownership records are private. They never cross Agent/Web, enter SQLite/browser
projections, appear in URLs, or enter logs. Private provider errors are mapped to stable failures.

## Domain resources and authority

### Approved provider profile

The Codex profile is Agent-discovered from the configured entrypoint after the Agent recognizes,
stages, and probes its exact execution-artifact closure. Browser-visible projection:

```text
{
  profileId: ConfigurationKey,
  profileRevision: "sha256-ai-profile-v1:<64 lowercase hex>",
  provider: "codex",
  displayName: bounded content,
  capabilities: {
    inspect: true,
    start: true,
    resume: boolean,
    sendTurn: true,
    interrupt: boolean,
    approvals: true,
    structuredInput: boolean,
    stop: true,
    streamEvents: true
  },
  availability:
    | { state: "available" }
    | { state: "unavailable", code: AvailabilityCode }
}
```

Codex `0.145.0` is the minimum supported protocol baseline, not the only authorized executable;
there is no upper release bound. The Agent-private authority is derived from actual inspected
protocol/capability evidence and contains bounded identity fields: the reported version,
entrypoint and recognized closure digests/layout, stable and experimental schema fingerprints,
effective capabilities, fixed app-server launch policy, approval policy/reviewer, probe-runtime
identity, credential-source handle, and the existing workspace/runtime authority.

#### Profile revision algorithm

`profileRevision` is the Agent-calculated identity of one strict
`devspace.ai-provider-profile-authority/v1` document. The effective fields are:

```text
{
  format: "devspace.ai-provider-profile-authority/v1",
  providerKind: "codex",
  reportedVersion,
  entrypointSha256,
  executionArtifactClosureDigest,
  executionArtifactLayout,
  protocolFamily,
  stableSchemaFingerprint,
  experimentalSchemaFingerprint,
  probeRuntimeIdentity,
  semanticAdapterVersion,
  compatibilityPolicyVersion,
  effectiveCapabilities,
  experimentalApi,
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  credentialSourceIdentity,
  runtimeIdentity
}
```

All digest fields are lowercase SHA-256 values over bounded Agent-verified bytes or canonical
discovery evidence. `reportedVersion` is parsed as a semantic version and must be at least
`0.145.0`; no maximum is applied. `executionArtifactLayout`, `protocolFamily`, semantic/policy
versions, and capability names are closed bounded values. `probeRuntimeIdentity` includes the exact
managed image identity, architecture/ABI target, container user, and containment policy version.
`effectiveCapabilities` is the result of deterministic structural evaluation plus semantic adapter
checks, not a browser declaration. `runtimeIdentity` retains the exact project/workspace/runtime
generation authority already required by AI sessions.

The normalized document is serialized using RFC 8785/JCS. Agent calculates:

```text
digest = SHA-256(
  UTF8("devspace.ai-provider-profile-revision/v1")
  || 0x00
  || UTF8(JCS(normalizedAuthorityDocument))
)
profileRevision = "sha256-ai-profile-v1:" || lowercaseHex(digest)
```

This is a separate semantic namespace from Project Options revision hashing. Object insertion
order cannot affect it. Changing executable bytes at an unchanged path, recognized closure
contents, compatible schema evidence, capabilities, experimental opt-in, approval policy/reviewer,
or runtime authority changes the digest and fences the profile. Harmless display metadata and
transient availability observations do not change it.

`displayName` is intentionally excluded because it is cosmetic and is forbidden from affecting
launch or inspection. Credential/secret values, host paths, executable paths, raw environment
values, provider-native IDs, and generated schema contents are prohibited from public projection;
only bounded opaque identities and safe capability evidence cross that boundary. The public
projection exposes only the profile digest, safe availability information, and effective
capabilities, never this private authority document. Agent owns calculation and verification.

Required enabled-v1 capabilities are `inspect`, `start`, `sendTurn`, `stop`, `streamEvents`, and
compatible command/file `approvals` for the writable managed profile. `resume`, `structuredInput`,
and `interrupt` are optional and may be disabled only when the discovered protocol cannot safely
support them. If required approval semantics are absent or incompatible, the profile is unavailable;
it must never silently switch to `approvalPolicy: "never"` or continue a writable workflow without
approvals. Unsupported optional work returns `AI_CAPABILITY_UNSUPPORTED` with the capability name.
No browser branch depends on the provider key.

Browser selection contains only `profileId`. Web obtains the safe inspection projection and sends
its `profileId` plus `profileRevision` on Web-to-Agent start/resume. Before durable operation
acceptance or execution, Agent independently resolves and hashes the current deployment profile
and requires exact equality. `AI_PROFILE_REVISION_CONFLICT` is an expected non-incident
state-conflict when the ID now resolves to another revision. The operation journal fingerprint
includes the requested revision, so replay never resolves a newer replacement silently.
Subsequent commands continue to bind the same exact revision.

Agent also checks the exact workspace runtime independently. Availability codes are closed:

```text
PROFILE_DISABLED
CODEX_EXECUTABLE_MISSING
CODEX_EXECUTABLE_INTEGRITY_CHANGED
CODEX_UNRECOGNIZED_EXECUTION_FORM
CODEX_VERSION_BELOW_MINIMUM
CODEX_PROTOCOL_INCOMPATIBLE
CODEX_APPROVAL_PROTOCOL_UNAVAILABLE
CODEX_INITIALIZE_NEGOTIATION_FAILED
CODEX_PROBE_RUNTIME_UNAVAILABLE
RUNTIME_IDENTITY_UNAVAILABLE
CREDENTIAL_SOURCE_UNAVAILABLE
WORKSPACE_REQUIREMENT_UNMET
```

An unavailable profile is an expected observation and does not itself receive an incident ID.

Project Options v1 `aiProfile` remains dormant. `providerKey`, `executableProfileKey`,
`fixedArgs`, `credentialSecretIds`, `instructionsFilePath`, and
`networkDisclosureAcknowledged` from that shape do not select or authorize an AI Session v1
runtime profile. The v1 wire shape and revision hashes do not change in this slice.

### Credential policy

The deployment profile names an Agent-owned credential-source handle, never a value or host path.
For the approved Codex beta profile, that handle is one persistent authority rooted at
`<stateRoot>/codex-auth/codex/` and containing only the validated `auth.json` plus Agent-private
control files. It is not seeded from or backed by another Codex client's home. The user's normal
Codex home, `~/.codex`, and any other host credential path are never read by the production runtime
or mounted into a workspace container.

The Codex profile revision binds the credential-source identity, persistent-authority policy version,
exclusive-lease policy version, and staged-writeback policy version, alongside the existing provider,
sandbox, approval, and capability authority. It never binds the authority path, token content or
digest, account identity, file metadata, lease holder, or authentication generation.

The beta acquires one atomic filesystem lease under that authority before reading or staging, and
holds it for the complete provider lifetime. It delivers the complete validated authority into a
new exact-container ephemeral `CODEX_HOME`, mode-restricted and removed on exit. Codex may update
that staged file. Finalization performs bounded shutdown, two bounded stable Docker reads, complete
pinned validation, fsync-backed same-directory atomic replacement of the durable file, exact
container cleanup, and lease release. Each staged read uses one Agent-controlled fixed helper
process that opens the private pathname with `O_RDONLY | O_NOFOLLOW`, obtains before metadata with
`fstat`, performs a bounded descriptor read, and obtains after metadata with `fstat`. The proof
requires a regular file, mode `0600`, the exact helper execution UID, `nlink === 1`, stable device,
inode, size, mode, UID, and link count, and `0 < size <= CODEX_AUTH_MAX_BYTES`; two complete reads
must also have equal bytes and equal descriptor identity. The private length-framed response is
bounded and carries metadata and bytes without delimiter ambiguity. Every credential-related Docker
exec requires both bounded stream closure and a successful post-closure exec inspection. Provider
exit, staging removal, and lease release are independent proofs; lease release is retryable after a
partial rename/removal and succeeds only after both `.lease` and the owned release path are proven
absent. Missing proof leaves the lease held and suppresses the public stopped event until a later
bounded retry succeeds. Values never appear in Project Options, SQLite, operation fingerprints,
Docker labels, command arguments, logs, diagnostics, safe failures, or browser payloads. A stale
lease fails closed and is not automatically broken. During provider lifetime, trusted managed-container
root can read the staged credential; hostile descendant containment is deferred. If the authority is
missing, invalid, marked for reauthentication, or leased, the profile is `unavailable`.

### AI session

Web owns one durable session identity and its committed history. A session is bound to one project,
workspace, safe profile identity, and configuration/runtime identity. It can acquire successive
provider-process generations. Provider-native resume identity is not the DevSpace session ID.

Every session-scoped Web read or mutation resolves the caller-supplied `(projectId, workspaceId,
aiSessionId)` as one exact tuple. A turn-scoped operation additionally requires the supplied
`turnId` to belong to that exact session. Web rejects missing, foreign, stale, and nonexistent
identities through one bounded public conflict shape and passes only the verified tuple to F11;
it never substitutes the latest workspace session, the only active session, or a cached session.
Workspace-level creation and bounded session listing remain workspace-scoped. Exact binding applies
to session snapshots/history, replay and polling, turn submission, interruption, Stop, changed-file
and status projections, and turn lookups.

A stopped session can be started again only through the strict Web action
`{ action: "restart", workspaceId, sessionId }`. Web resolves that exact stopped session, re-inspects
the profile, verifies the unchanged configuration revision, runtime-plan hash, workspace runtime
generation, profile ID, and profile revision, and compare-and-sets the row from `stopped` to
`creating`. Existing turns, events, interactions, title, durable session ID, history bounds, and
event sequence remain in place. A failure before Agent acceptance restores only the exact claimed
row and only if its state, event sequence, stored generation, and claim timestamp have not advanced.
Initial workspace-level creation remains independently idempotent and never substitutes for this
restart action.

Agent remains process-generation authority; the public F11 start command does not carry a process
generation. An in-memory restart requires a completely finalized current generation and an exact
durable terminal `session.stopped`. A cold Agent requires a contiguous retained outbox ending in that
same terminal event and derives the next safe generation from it. Each successful restart emits one
new-generation `session.started` and `session.ready` on the existing outbox sequence. Web atomically
advances SQLite generation only when it commits that exact `session.started`; later events must match
the stored generation. This starts a new provider process for the same DevSpace session and committed
history. It is not provider-native thread resume.

The Web/SQLite projection is explicitly bounded. The current limits are:

| Projection | Maximum | Retention/meaning |
| --- | ---: | --- |
| retained turns per session | 64 turns | newest turns; older turns and their event rows are retired |
| one turn's assembled assistant output | 2 MiB UTF-8 | deterministic UTF-8 prefix; `outputTruncated` is true when compacted |
| all retained turn output per session | 8 MiB UTF-8 | newest turns receive the remaining budget; older output is truncated |
| retained canonical event rows per session | 2,048 rows / 16 MiB UTF-8 | one contiguous newest sequence suffix |
| interaction rows per session | 256 rows / 4 MiB JSON bytes | newest rows first, deterministic `(createdAt,id)` order |
| one interaction request or response JSON value | 128 KiB UTF-8 | oversized values are omitted from the bounded projection |
| complete Web AI session-history GET response envelope | 8 MiB UTF-8 JSON | `profile: null`, bounded session summaries, selected session state, retained terminal turn state, truncation metadata, then newest history |

The Legacy session-history GET returns persisted summaries and selected history without Codex
provider discovery. Its `profile` is `null`; the browser loads availability separately from the
authenticated, no-store `GET /api/projects/{projectId}/ai/status?workspaceId=...`. Mutations that
require a provider profile continue to inspect it and enforce availability and capability checks
before accepting the operation.

SQLite applies output, turn, interaction, and canonical-event pruning in the same transaction as
the event insert and aggregate update. A failed compaction rolls back the event and leaves the
Agent-private outbox acknowledgement unchanged, so replay remains available. Event retention is
always a contiguous suffix; `historyStartSequence` identifies its first sequence and
`historyTruncated` records a dropped prefix or byte/count compaction. Replay before that boundary
returns the bounded gap/truncation outcome rather than a partial stream. Each public selected-session
projection normalizes `historyStartSequence` to its first retained event, or to `lastSequence + 1`
when no events remain; this response-only normalization never rewrites SQLite's persisted boundary.
Response truncation is deterministic and never claims complete output: `outputTruncated`,
`historyTruncated`, the retained start sequence, and the complete/truncated interaction projection
are explicit.

Legacy oversized SQLite text and JSON rows are length-checked before being loaded. JSON is parsed
only when within its bound and re-serialized as a valid bounded projection; UTF-8 text is decoded
through a character-safe prefix, never by cutting serialized JSON bytes. Legacy rows remain
readable through the bounded projection and are normalized on the next transactional persistence
boundary. The Agent-private durable canonical-event outbox remains the source for replay and
acknowledgement; SQLite is the Web-owned committed public projection.

```text
creating -> ready | stopping | unavailable | lost
ready -> running | stopping | unavailable | lost
running -> ready | waiting-for-approval | waiting-for-input |
           interrupting | stopping | lost
waiting-for-approval -> running | interrupting | stopping | lost
waiting-for-input -> running | interrupting | stopping | lost
interrupting -> ready | stopping | lost
stopping -> stopped | lost
stopped -> creating
unavailable -> creating | stopping | lost
lost -> terminal
```

Only one nonterminal turn may exist. `waiting-for-approval`, `waiting-for-input`, and
`interrupting` are session projections of that exact active turn; Web does not independently
accept arbitrary session-state writes.

### Provider process

Agent owns each generation. Generation is a positive monotonically increasing safe integer scoped
to the DevSpace session.

```text
creating -> exec-created | failed | lost
exec-created -> identity-confirming | failed | lost
identity-confirming -> running | failed | lost
running -> stopping | exited | failed | lost
stopping -> exited | failed | lost
exited | failed | lost -> terminal
```

The Agent-private ownership record binds:

```text
project ID
workspace ID
configuration revision ID
runtime-plan hash
runtime generation
exact container ID
AI session ID
profile ID and profile revision
provider-process generation
operation ID
Docker exec ID
supervisor/control-channel identity
provider process-start identity
```

Before the first Docker side effect, Agent durably reserves the complete requested identity with
phase `creating`. After Docker creates the exec it records the exact exec ID as `exec-created`
before starting it. The supervisor handshake advances to `identity-confirming`; only an
authenticated proof matching the exact record advances to `running`. A retry with the same
operation and request resumes the exact phase. A reused operation, foreign exec, replaced
container, or ambiguous record fails closed.

Docker exec ID alone is insufficient for Stop. A fixed profile-required supervisor executable owns
Codex's stdin/stdout/stderr pipes and its dedicated process group/cgroup. Provider JSONL remains on
the child pipes, while supervisor control uses an authenticated Unix socket at an Agent-derived
private in-container path. A later Agent boot may launch a fixed control helper by a new Docker exec
in the exact same container; the helper receives the private credential through stdin, not
arguments/environment, and returns the bound generation plus non-reusable process-start identity.
The design does not assume a dedicated provider user, so filesystem mode alone is insufficient.

Interrupt first uses the provider-native turn method when supported. Stop requests graceful
supervisor termination, waits a bounded interval, then escalates only against the re-proven
supervisor group/cgroup. It never signals an unproved numeric PID. Already-exited is idempotent
success after exact proof. The existing Docker-exec stdio attachment cannot be reattached after
Agent restart; only the helper/control proof can recover the process. Replaced-container,
Agent-restart-without-reauthentication, reused/foreign PID, ambiguous descendants, and missing
proof become `lost` or an identity failure, never guessed success.

### Turn

```text
accepted -> starting | failed | lost
starting -> running | failed | lost
running -> waiting-for-approval | waiting-for-input | interrupting |
           provider-completed | failed | lost
waiting-for-approval -> running | interrupting | failed | lost
waiting-for-input -> running | interrupting | failed | lost
interrupting -> provider-completed | interrupted | failed | lost
provider-completed -> quiesced | failed | lost
quiesced -> completed | interrupted | failed
completed | interrupted | failed | lost -> terminal
```

`provider-completed` records the adapter's terminal provider notification but is not a final public
outcome. Web must have committed all earlier canonical events, resolved/cancelled every interaction,
and verified sequence continuity before it can commit `turn.quiesced`. In the same Web transaction,
the read model passes through `quiesced` to `completed`, `interrupted`, or `failed`.
`turn.quiesced` is the last event for the turn and carries that outcome; it is the deterministic
final receipt. A provider-completed turn with missing prior events never quiesces.

### Approval and structured-input requests

Approval and structured-input resources are distinct, but share this state graph:

```text
pending -> responded | cancelled | expired | lost
responded | cancelled | expired | lost -> terminal
```

Exactly one response binds all of:

```text
project ID
workspace ID
session ID
turn ID
request ID
profile ID and revision
provider-process generation
```

Mismatch fails closed. A response to a non-pending request is a state conflict. Secret structured
input is not a v1 browser capability. Approval decisions are provider-neutral:
`approve-once`, `approve-for-session`, `deny`, or `cancel`. The adapter may advertise fewer
decisions; unsupported decisions are rejected before native response.

### Private provider resume metadata

Agent may retain a versioned private record containing provider-native thread identity, pinned
adapter/CLI version, profile ID/revision, session and last process generation, workspace/runtime
binding, and integrity/version metadata. It contains no browser authority and is never in canonical
events. Resume requires the capability, exact profile revision, compatible adapter version, exact
workspace/runtime authorization, and a new provider-process generation. Failure to prove these
conditions leaves history readable and reports resume unavailable; it never attaches a foreign
thread.

## Provider-neutral interface

The executable command discriminator is closed:

```text
inspect
start
resume
sendTurn
interrupt
respondToApproval
respondToStructuredInput
stop
streamEvents
```

Start and resume bind the exact inspected safe profile revision. All commands after start bind
that same revision and the exact provider-process generation.
`sendTurn` additionally carries one bounded `{ kind: "text", text }` content value. That content is
the sole intentional exception to identifier-only lifecycle commands. It cannot select executable,
arguments, environment, cwd, runtime identity, container, sandbox/permission policy, or
provider-native identifiers.

## Canonical events

### Envelope

Every event is one strict discriminated object:

```text
{
  schemaVersion: "devspace.ai-event/v1",
  eventId: UuidV7,
  sessionId: UuidV7,
  turnId: UuidV7 | null,
  sequence: 1..9007199254740991,
  eventType: closed discriminator,
  observedAt: UtcTimestampMs,
  profile: {
    profileId: ConfigurationKey,
    profileRevision: "sha256-ai-profile-v1:<64 lowercase hex>",
    provider: ConfigurationKey
  },
  processGeneration: 1..9007199254740991,
  payload: event-specific strict payload
}
```

`observedAt` is a safe Agent observation timestamp and is not an ordering key. Provider timestamps
and native correlation remain private. Session events require `turnId: null`; turn events require
the exact turn ID.

### Closed event set

| Event | Essential safe payload |
| --- | --- |
| `session.started` | process generation |
| `session.ready` | empty |
| `session.stopping` | stable reason |
| `session.stopped` | stable reason |
| `session.unavailable` | stable availability code |
| `session.lost` | stable loss code |
| `turn.accepted` | bounded user content |
| `turn.started` | empty |
| `turn.output.delta` | bounded assistant delta |
| `turn.output.completed` | bounded completed assistant item |
| `turn.activity.started` | activity ID and safe typed presentation |
| `turn.activity.completed` | activity ID and outcome |
| `turn.approval.requested` | request ID and redacted typed presentation |
| `turn.approval.responded` | request ID and provider-neutral decision |
| `turn.input.requested` | request ID and bounded questions/options |
| `turn.input.responded` | request ID and bounded answers |
| `turn.interrupt.requested` | empty |
| `turn.interrupted` | stable reason |
| `turn.provider-completed` | provider outcome |
| `turn.quiesced` | deterministic final outcome |
| `turn.failed` | closed failure observation |
| `turn.lost` | stable loss code |

Unknown event types, fields, payload variants, native IDs, raw protocol content, secret questions,
and unsafe paths are invalid.

### Sequence and acknowledged outbox

Agent owns sequence assignment. For each DevSpace session it durably stores:

- the greatest assigned sequence;
- each unacknowledged strict canonical event;
- the exact event ID at each sequence; and
- the greatest exact Web acknowledgement in an Agent-private manifest.

The manifest is a strict `devspace.ai-outbox-state/v1` object containing only
`projectId`, `workspaceId`, `aiSessionId`, `acknowledgedThrough`, and
`acknowledgedEventId`. The acknowledgement pair is exact: sequence zero has a null event ID,
and every positive acknowledgement names the retained canonical event UUID. The manifest and
JSONL outbox are owner-only regular files with no-follow reads, bounded UTF-8/JSON, and atomic
same-directory replacement where replacement is followed by file and directory synchronization.

The sequence starts at 1 and is continuous for the lifetime of the DevSpace session. Agent boots
and provider-process generations do not reset it. Sequence allocation, capacity checks, append,
acknowledgement, manifest persistence, compaction, replay boundary, and live-listener attachment
run through one recoverable per-session serialization chain. An append opens the exact outbox
with no-follow append semantics, validates its descriptor, writes one complete JSONL record, fsyncs
the file, closes successfully, then updates memory and delivers listeners. A failed append does
not allocate its sequence or deliver it.

Web maintains unique constraints on `(session_id, sequence)` and `event_id` in the later SQLite
schema. Before classifying an incoming event, Web reads both the event at its
`(sessionId, sequence)` and the event, if any, with its global `eventId`. It accepts:

- `sequence = committedThrough + 1`: validate and commit;
- `sequence <= committedThrough` with an exact semantic event match: duplicate replay, acknowledge;
- the same sequence/event ID with different content, or one event ID at another sequence:
  `AI_EVENT_SEQUENCE_CONFLICT`;
- `sequence > committedThrough + 1`: `AI_EVENT_GAP`.

The executable classifier receives both lookups. An event ID already bound to another canonical
event—including another session at the same numeric sequence—or to any other sequence is always a
sequence conflict, including when the incoming sequence would otherwise be next or a gap. Semantic
duplicate equality is RFC 8785/JCS equality after strict canonical schema parsing, not input
object-key order or timestamps.

Web delivers only committed events to the browser. After commit it acknowledges exact
`(projectId, workspaceId, sessionId, throughSequence, throughEventId)`. A Web restart before commit causes replay from the
last commit. A restart after commit but before acknowledgement causes an exact duplicate. Agent
restart reloads and proves the private manifest/outbox pair: strict event schemas, exact session
identity, unique IDs, continuous retained sequences, the exact acknowledged pair, and all
unacknowledged history must be present. A corrupt, foreign, missing, or impossible retained
boundary fails closed; Agent never reconstructs missing events. Retention is bounded at 2,048
retained events and keeps the newest 512 acknowledged entries plus every unacknowledged event.
Acknowledgement persistence is atomic and durable before JSONL compaction; compaction is an atomic
same-directory replacement, so a crash may leave extra acknowledged records but cannot remove an
unacknowledged one. Capacity exhaustion makes start/send unavailable until safe acknowledgement/
retention advances; it does not silently drop or reorder.

Before a turn is accepted, Agent reserves room for `turn.accepted`, `turn.started`, the mandatory
terminal path (`turn.provider-completed` or `turn.failed`, `turn.files.changed` when applicable,
`turn.quiesced` when applicable, `session.stopping`, and `session.stopped`). Ordinary output and
activity events cannot consume that fixed reserve. If the terminal path itself cannot be durably
written, Agent reports outbox unavailability and never fabricates terminal success.

The alternatives rejected by ADR 015 are Web-assigned sequence plus delivery IDs, an undurable
Agent sequence, and Web-leased ranges.

## Transport and replay

### Agent to Web

F11 defines:

```text
GET /v1/ai-sessions/{aiSessionId}/events?afterSequence=<canonical decimal>
Content-Type: application/x-ndjson; charset=utf-8
```

After authorization/identity validation, Agent emits every retained event with sequence greater
than `afterSequence`, then one:

```text
{
  schemaVersion: "devspace.ai-stream/v1",
  frameType: "stream.synchronized",
  sessionId,
  throughSequence
}
```

It then emits live events. Agent establishes the replay boundary and attaches live delivery under
the same per-session serialization chain: an event is in replay or live, never omitted. A request
older than a compacted acknowledged prefix returns `AI_EVENT_GAP`; a request at the retained
boundary returns every retained event after that sequence. Exact duplicates may occur only across
reconnect and are handled above. The stream uses ordinary single-line UTF-8 JSON plus LF, with no
blank lines or unterminated committed final line. Replay validation completes before the stream
can send HTTP 200.

Web acknowledges committed progress using the non-journaled idempotent F11 acknowledgement
operation. Acknowledgement affects only private outbox retention and cannot trigger provider or
workspace side effects.

Slow Web consumption is bounded by the durable outbox and transport high-water marks. Agent pauses
reading/delivery where safe; if bounds are exhausted it stops accepting new turns and terminates
the stream with a transport failure. It never drops a canonical event.

### Web to browser

Web exposes a dedicated authenticated AI stream, not the terminal WebSocket protocol and not
raw Agent NDJSON. It requires the existing application session, strict Origin validation, and
authorization for the exact project/workspace/session. Web completes exact identity and replay-gap
preflight before returning HTTP 200, so foreign/nonexistent sessions and compacted-prefix requests
receive the bounded conflict response without opening the Agent stream.

The browser supplies `afterSequence`. Web replays SQLite-committed events, establishes replay/live
handoff under one Web session publication lock, sends `stream.synchronized` with the committed
boundary, then sends live committed events. Each browser response is capped at 512 frames and
8 MiB; a clean cap-induced EOF for a nonterminal session reconnects from the last successfully
applied canonical sequence. Only a repeated sequence with the exact previously applied event ID is
ignored; an unknown or conflicting same-sequence identity, lower sequence, or gap fails closed.
Zero-progress EOFs use bounded backoff, and `session.stopped`/`session.lost` end continuation. Abort,
unmount, or session replacement cancels the reader and pending retry; stale snapshot requests are
aborted independently and cannot mutate the replacement selection. A stale response cannot update
the new selection. A browser refresh reconnects from the same last applied sequence. Slow subscribers
have bounded queues and are disconnected with a safe reconnect instruction; they do not apply
backpressure to SQLite commit or Agent acknowledgement.

The browser projection enforces the same 2 MiB per-turn and 8 MiB newest-turn-first output bounds
as SQLite, preserves sticky `outputTruncated`, and shows concise output/history notices. Refresh and
replay retain the bounded projection rather than rebuilding an apparently complete turn from deltas.
When complete-response envelope compaction removes every selected-session event, public
`historyStartSequence` is `lastSequence + 1` and `historyTruncated` is true; when events remain it is
the first retained contiguous suffix sequence. The newest retained aggregate turn and terminal state
remain available, while interaction/history collection truncation is explicit.

Web restart reconstructs replay entirely from SQLite. Agent disconnect does not remove committed
history; session connection state becomes unavailable or lost according to identity evidence.

## F11 Agent API reconciliation

F09's four AI rows were never implemented. They are historical compatibility declarations and are
formally superseded. They must not be routed:

```text
ai-session.start
ai-session.interrupt
ai-session.stop
ai-session.resume
```

F11 is the only executable AI authority. It reuses start/resume/interrupt/stop operation names and
paths with replacement bounded shapes and adds:

| Operation | Method/path | Class |
| --- | --- | --- |
| `ai-provider.inspect` | `POST /v1/ai-profiles/inspect` | non-journaled inspection |
| `ai-session.start` | `POST /v1/ai-sessions/start` | journaled mutation |
| `ai-session.resume` | `POST /v1/ai-sessions/resume` | journaled mutation |
| `ai-session.turn.send` | `POST /v1/ai-sessions/send-turn` | journaled mutation |
| `ai-session.turn.interrupt` | `POST /v1/ai-sessions/interrupt` | journaled mutation |
| `ai-session.approval.respond` | `POST /v1/ai-sessions/respond-approval` | journaled mutation |
| `ai-session.input.respond` | `POST /v1/ai-sessions/respond-input` | journaled mutation |
| `ai-session.stop` | `POST /v1/ai-sessions/stop` | journaled mutation |
| `ai-session.events.stream` | `GET /v1/ai-sessions/{aiSessionId}/events?afterSequence=` | NDJSON |
| `ai-session.events.acknowledge` | `POST /v1/ai-sessions/acknowledge-events` | idempotent non-journaled control |

Mutation success is the existing `202 MutationReceipt`; it means durable operation acceptance only.
Profile inspection returns the safe projection. Acknowledgement echoes the exact acknowledged
identity. All F11 objects are strict. The Agent event stream and acknowledgement route validate
replay/storage failures before success begins.

F11 endpoint descriptors declare one of two operation-journal policies:

- `generic-request` applies to bounded non-content mutations and may retain the complete validated
  request under the existing private generic journal rules.
- `ai-private-intent-reference` is mandatory for `ai-session.turn.send` and
  `ai-session.input.respond`, and for any future content-bearing mutation.

For the second policy, the generic journal retains only operation ID, operation name, the following
strict fingerprint identity, and an opaque reference to one dedicated Agent-private AI intent
record:

```text
PrivateIntentFingerprintIdentityV1 = {
  algorithm: "hmac-sha256-ai-private-intent-v1",
  keyVersion: ConfigurationKey,
  digest: 64 lowercase hexadecimal characters
}
```

The referenced private intent retains the identical `algorithm`, `keyVersion`, and `digest`.
`keyVersion` is a bounded deployment-owned identifier, not key material. The HMAC is SHA-256 with
the selected key version over UTF-8:

```text
"devspace.ai-private-intent-fingerprint/v1" || 0x00 ||
JCS(PrivateIntentFingerprintInputV1)
```

JCS is RFC 8785 canonicalization after strict schema parsing. The input document is:

```text
PrivateIntentFingerprintInputV1 = {
  format: "devspace.ai-private-intent-fingerprint-input/v1",
  intentRecordSchemaVersion: "devspace.ai-private-intent/v1",
  intentRecordId: UuidV7,
  operationId: UuidV7,
  operationName: "ai-session.turn.send" | "ai-session.input.respond",
  keyVersion: ConfigurationKey,
  projectId: UuidV7,
  workspaceId: UuidV7,
  aiSessionId: UuidV7,
  turnId: UuidV7,
  interactionRequestId: UuidV7 | null,
  profileId: ConfigurationKey,
  profileRevision: AiProfileRevision,
  processGeneration: positive safe integer,
  request: the complete strict content-bearing F11 command
}
```

For send-turn, `interactionRequestId` is null. For structured-input response it equals the exact
request ID. Every repeated identity in `request` must equal the outer binding. No defaulted or
omitted field exists, object-key order has no effect, and changing any bound identity, generation,
authority revision, content, answer, or intent schema version changes the digest. Raw unkeyed
content digests are prohibited because low-entropy answers could be guessed.

Exactly one installed key version is active for new intent writes. Rotation installs a new active
version and demotes older installed versions to verification-only; existing references and intents
are not rewritten. Replay resolves exactly the recorded key version. It never falls back to the
active version and never recomputes with another key. A verification-only key remains installed
while any non-retired journal reference or intent depends on it. Removal is prohibited until an
atomic retirement step proves that every dependent operation replay window and associated
session/turn/request retention has retired. A missing, unknown, replaced, or corrupt required key
version causes fail-closed journal/private-state unavailability. Key values never enter SQLite,
browser contracts, public observations, repository fixtures, logs, diagnostics, audits, or generic
errors. The non-secret key-version identifier is retained only in Agent-private journal/intent
records; v1 does not allow it in structured diagnostics.

Intent writes use restrictive private-state permissions, strict schemas and existing byte bounds,
temporary-file write plus file sync, atomic rename, and parent-directory sync. The generic journal
reference is persisted only after the intent is durable; acceptance is not returned and side
effects do not begin until both are durable. A crash before the journal reference may leave an
unreferenced intent eligible for bounded cleanup, never an accepted operation.

Exact replay loads the referenced intent, validates every binding and schema, and recomputes the
fingerprint before returning the retained receipt or continuing. A missing, replaced, corrupt, or
mismatched record fails closed as journal/private-state unavailability and receives no side
effect. Intent retention is bounded, but a referenced record cannot be removed until both the
operation replay window and associated AI session/turn/request retention are retired atomically.
No content or intent reference appears in public operation observations, logs, diagnostics, audit
summaries, generic errors, or browser payloads. Process creation additionally follows the phased
private ownership record above.

F10 process snapshots and events accept only `task | terminal`; they exclude first-class AI
provider processes. F10 also no longer carries the dormant `ai-session.state.changed` event or an
AI snapshot member. AI session recovery uses F11's dedicated stream plus the later Web-owned
session snapshot/read model. No competing AI observation contract remains.

## Failure contract

| Code | Category | Incident |
| --- | --- | --- |
| `AI_PROFILE_NOT_FOUND` | `user-error` | no |
| `AI_PROFILE_UNAVAILABLE` | `dependency-unavailable` | no |
| `AI_PROFILE_REVISION_CONFLICT` | `state-conflict` | no |
| `AI_CAPABILITY_UNSUPPORTED` | `user-error` | no |
| `AI_SESSION_STATE_CONFLICT` | `state-conflict` | no |
| `AI_TURN_STATE_CONFLICT` | `state-conflict` | no |
| `AI_INTERACTION_STATE_CONFLICT` | `state-conflict` | no |
| `AI_IDENTITY_MISMATCH` | `internal-failure` | yes |
| `AI_EVENT_SEQUENCE_CONFLICT` | `protocol-failure` | yes |
| `AI_EVENT_GAP` | `protocol-failure` | yes |
| `AI_OUTBOX_UNAVAILABLE` | `dependency-unavailable` | yes |
| `AI_PROVIDER_TRANSPORT_FAILURE` | `transport-failure` | yes |
| `AI_PROVIDER_PROTOCOL_FAILURE` | `protocol-failure` | yes |
| `AI_INTERNAL_FAILURE` | `internal-failure` | yes |

Expected `unavailable`, `stopped`, `interrupted`, and capability-unsupported outcomes do not
receive incidents unless an independent unexpected failure occurs. Malformed native messages,
sequence conflict/gap, unexpected stdio failure, ownership invariant failure, and internal
exceptions receive an incident at the existing user-facing boundary. Browser-safe messages are
Web-owned fixed projections. Raw provider errors and all content-plane data remain private from
generic errors and diagnostics.

## Codex app-server protocol-family adapter

The stable DevSpace semantic adapter supports Codex `0.145.0` and newer compatible releases. The
`0.145.0` schemas below are the minimum regression baseline, not a production executable or binary
authorization pin. A compatible newer release is admitted without a DevSpace release or a
version-specific adapter; the upper supported version is unbounded. The Agent first verifies the
recognized execution-artifact closure, then probes that exact staged artifact in an isolated
runtime and evaluates its structural/capability evidence.

Baseline stable-default component evidence was generated with:

```text
codex app-server generate-json-schema --out <directory>
```

The separately classified structured-input component was generated with:

```text
codex app-server generate-json-schema --experimental --out <directory>
```

The repository checks the actual generated bytes:

| Scope | Fixture | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| stable default | `stable/ClientRequest.json` | 172,676 | `44615d6348466a48c05228d99eb555d1d655aaffc1474fb0abdd7f4945502e35` |
| stable default | `stable/ClientNotification.json` | 431 | `a30b3041578845b11add3d07d5a63cd3a12d5d126e87b8c591862b4aeb68d97c` |
| stable default | `stable/ServerRequest.json` | 49,058 | `177f8b7de9dd8ce2055c56a5fd22dbc6ec24e2a4d706d08fef9f5ad4effe71f6` |
| stable default | `stable/ServerNotification.json` | 173,163 | `0c7b42c4e2cffc419bf753ea5a34a56b2965219c2087304993bce97cf978f915` |
| experimental | `experimental/ToolRequestUserInputParams.json` | 1,977 | `21e569e32c05d51c1ee5e587730c182b911ede97a4df267f6e4ef24e1717f34e` |

Offline tests read, hash, parse, and derive the required method inventory from these fixtures.
The repository also retains a captured `0.153.4` schema fixture from the isolated probe path and
synthetic additive/breaking/missing-capability fixtures. `UPSTREAM-NOTICE.md` records OpenAI Codex
provenance and Apache-2.0 licensing. The adapter mapping is:

| Codex native method | DevSpace behavior |
| --- | --- |
| `initialize` / `initialized` | private process handshake and capability inspection |
| `thread/start` | start a new private provider thread for a DevSpace session |
| `thread/resume` | optional resume using Agent-private metadata |
| `turn/start` | `sendTurn`; adapter supplies exact fixed cwd/policy |
| `turn/interrupt` | optional `interrupt` |
| `thread/started` | retain native thread identity privately |
| `turn/started` | `turn.started` |
| `item/agentMessage/delta` | bounded `turn.output.delta` |
| `item/started` / `item/completed` | safe activity/output events |
| `item/commandExecution/requestApproval` | safe command approval presentation |
| `item/fileChange/requestApproval` | safe workspace-relative file presentation |
| `item/tool/requestUserInput` | optional experimental structured-input capability |
| `turn/completed` | `turn.provider-completed`, then Web quiescence |

For a profile whose structural evidence supports structured input, the adapter sends `initialize`
with the bounded `capabilities.experimentalApi: true` opt-in, then responds with `initialized`.
The owner/browser is the explicit `approvalsReviewer: "user"` at `thread/start`; neither setting
is ambient host Codex configuration. Both values are part of the Agent profile-revision authority,
so changing either fences existing sessions. Optional structured input and interrupt are disabled
truthfully when their required surface is absent. Unknown blocking server requests fail closed,
fence and terminate the exact provider generation, retire pending interactions, and expose only a
bounded compatibility diagnostic; they are never left waiting for a guessed response. Other
experimental methods/fields are ignored only under the explicit notification policy.

The adapter fixes the exact managed `/workspace` cwd and approved sandbox/approval policy from the
deployment profile and runtime authorization. It does not forward browser-supplied Codex model,
cwd, environment, permissions, sandbox, executable, arguments, or native IDs. Raw JSON-RPC stays
inside Agent.

## Implemented persistence shape

Beta Slice B uses a hybrid model:

- append-only canonical events as the durable ordered content/activity record;
- normalized sessions, turns, and interaction-request read models for invariants and queries; and
- a reserved private resume-metadata table whose values are never public; provider-native resume is
  not enabled by the current Codex profile.

The implemented tables are `ai_sessions`, `ai_turns`, `ai_events`, `ai_interaction_requests`, and
`ai_provider_resume_metadata`. Web remains the sole writer. Required uniqueness includes one
session sequence, global event ID, one nonterminal turn per session, and one response per request.
The historical Slice 0 decision deliberately did not change the dormant `ai_sessions` table; the
subsequent Beta migrations now provide this storage. Existing non-AI tables and lifecycles are not
event sourced.

## Explicit exclusions

Historical AI Sessions v1 Slice 0 did not implement multiple providers, arbitrary executable
configuration, host AI execution, terminal-backed first-class sessions, database changes,
credentials, provider runtime, Agent/Web handlers, browser UI, file editor, Git staging/publish,
checkpoints, autonomous orchestration, persistent generic terminals, multiple workspaces,
authentication replacement, automatic merge, production deployment, or broad event sourcing.
Current Beta Slice B implements the Codex-only runtime, storage, handlers, stream, credentials,
approvals, structured questions, and Workbench path described above. It still excludes multiple
providers, provider-native resume, hostile-descendant containment, automatic merge, and production
deployment. Existing sessions remain pinned to their profile revision: a Codex update creates a new
profile authority, does not replace a live old generation in place, and does not silently resume an
old-profile session with new bytes. Old sessions remain inspectable history; a new compatible
profile session is required after the old generation stops or is lost.
