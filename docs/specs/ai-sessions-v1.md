# AI Sessions v1

## Status, scope, and authority

This is the versioned contract for first-class structured DevSpace AI sessions. ADR 015 owns the
architecture decision. `@devspace/domain` owns executable lifecycle edges.
`@devspace/contracts` owns executable public schemas and the Agent API F11 extension. The pinned
Codex adapter boundary is internal to Agent and is not a public provider protocol.

Slice 0 defines architecture and contracts only. It adds no provider process, supervisor, route
handler, Web API, SQLite migration, credential delivery, browser stream, or Workbench UI.

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

- may be persisted later only in dedicated AI-session storage;
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

The initial registry is deployment-owned and immutable. Browser-visible projection:

```text
{
  profileId: ConfigurationKey,
  profileRevision: "sha256-ai-profile-v1:<64 lowercase hex>",
  provider: ConfigurationKey,
  displayName: bounded content,
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
  availability:
    | { state: "available" }
    | { state: "unavailable", code: AvailabilityCode }
}
```

The Agent-private definition may contain only administrator-deployed values: fixed executable
identity, fixed `app-server --stdio` launch mode/arguments, adapter and CLI version, required
container identity/capabilities, credential-source handle, and availability inspection policy.

#### Profile revision algorithm

`profileRevision` is the Agent-calculated identity of one strict
`devspace.ai-provider-profile-authority/v1` document. Every field is required, unknown fields are
invalid, and v1 has no implicit defaults:

```text
{
  format: "devspace.ai-provider-profile-authority/v1",
  profileId,
  provider,
  providerVersion,
  adapterVersion,
  executableIdentity,
  launchMode,
  fixedArguments,
  runtimeIdentity,
  requiredRuntimeCapabilities,
  credentialSourceHandle,
  capabilities,
  availabilityInspectionPolicy: {
    executableProbe,
    expectedVersionOutput,
    credentialProbe,
    runtimeProbe: "required-before-acceptance"
  }
}
```

`profileId`, `provider`, `adapterVersion`, `executableIdentity`, `launchMode`,
`credentialSourceHandle`, each runtime-capability entry, and
`availabilityInspectionPolicy.executableProbe` are `ConfigurationKey` values.
`providerVersion`, each fixed argument, an exact container-user name, and expected version output
are non-empty, NUL-free strings of at most 4,096 code units. `fixedArguments` has at most 64
ordered entries. `runtimeIdentity` is exactly either
`{ kind: "workspace-default-user" }` or
`{ kind: "exact-container-user", user: <bounded string> }`.
`requiredRuntimeCapabilities` has at most 64 unique entries.
`availabilityInspectionPolicy.credentialProbe` is exactly `required | not-required`, and
`runtimeProbe` is the literal `required-before-acceptance`. `capabilities` is the complete strict
public capability declaration; no capability is omitted.

`fixedArguments` is ordered and order affects authority.
`requiredRuntimeCapabilities` is a unique semantic set and is sorted by Unicode code point before
hashing. All other arrays retain their order. The normalized document is serialized using RFC
8785/JCS. Agent calculates:

```text
digest = SHA-256(
  UTF8("devspace.ai-provider-profile-revision/v1")
  || 0x00
  || UTF8(JCS(normalizedAuthorityDocument))
)
profileRevision = "sha256-ai-profile-v1:" || lowercaseHex(digest)
```

This is a separate semantic namespace from Project Options revision hashing. Object insertion
order cannot affect it. Changing any execution-authority field changes the digest. A replacement
under one `profileId` therefore has a new revision.

`displayName` is intentionally excluded because it is cosmetic and is forbidden from affecting
launch or inspection. Transient availability observations are excluded, while the policy that
produces them is bound. Credential/secret values, host paths, executable paths, and raw environment
values are prohibited; fixed non-host argument strings remain private authority and are bound.
Only opaque deployed identities such as `executableIdentity` and `credentialSourceHandle` cross
those boundaries. The public projection exposes only the digest, never this private authority
document. Agent owns calculation and verification.

Required enabled-v1 capabilities are `inspect`, `start`, `sendTurn`, `stop`, and `streamEvents`.
`resume`, `interrupt`, `approvals`, and `structuredInput` are optional. Unsupported optional work
returns `AI_CAPABILITY_UNSUPPORTED` with the capability name. No browser branch depends on the
provider key.

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
EXECUTABLE_MISSING
VERSION_MISMATCH
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
An existing administrator Codex login may back that source only if Agent can read it without
revealing its location and can project the minimum required values into the exact provider exec.
Mounting the host's `~/.codex`, a credential directory, or any other host credential path into the
general workspace container is not acceptable.

The runtime slice must choose process-scoped delivery supported by the pinned Codex version:
either a minimal Docker-exec environment value or supervisor-created ephemeral in-container
credential material delivered over the private channel, mode-restricted, bound to this process
generation, and removed on exit. Values never appear in Project Options, SQLite, operation
fingerprints, Docker labels, command arguments, logs, diagnostics, safe failures, or browser
payloads. Because v1 does not assume a dedicated provider user, other same-user processes in the
same trusted-owner workspace may remain a residual process-inspection risk; cross-workspace
credential sharing is still prohibited. If Codex 0.145.0 cannot authenticate without a broad
ambient mount in the target image, the profile is `unavailable` and credential delivery blocks
the runtime slice.

### AI session

Web owns one durable session identity and its committed history. A session is bound to one project,
workspace, safe profile identity, and configuration/runtime identity. It can acquire successive
provider-process generations. Provider-native resume identity is not the DevSpace session ID.

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
lost -> creating | stopping
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
- the greatest exact Web acknowledgement.

The sequence starts at 1 and is continuous for the lifetime of the DevSpace session. Agent boots
and provider-process generations do not reset it. Assignment and outbox append complete before
delivery. Provider event order is serialized by the one adapter reader for that process and
canonical events are appended in that order.

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
`(sessionId, throughSequence, throughEventId)`. A Web restart before commit causes replay from the
last commit. A restart after commit but before acknowledgement causes an exact duplicate. An Agent
restart reloads the private outbox/counter; corrupt or missing non-acknowledged history fails
closed. Outbox retention may remove only acknowledged entries older than its bounded policy.
Capacity exhaustion makes start/send unavailable until safe acknowledgement/retention advances; it
does not silently drop or reorder.

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
one session lock: an event is in replay or live, never omitted. Exact duplicates may occur only
across reconnect and are handled above. The stream uses ordinary single-line UTF-8 JSON plus LF,
with no blank lines or unterminated committed final line.

Web acknowledges committed progress using the non-journaled idempotent F11 acknowledgement
operation. Acknowledgement affects only private outbox retention and cannot trigger provider or
workspace side effects.

Slow Web consumption is bounded by the durable outbox and transport high-water marks. Agent pauses
reading/delivery where safe; if bounds are exhausted it stops accepting new turns and terminates
the stream with a transport failure. It never drops a canonical event.

### Web to browser

Web later exposes a dedicated authenticated AI stream, not the terminal WebSocket protocol and not
raw Agent NDJSON. It requires the existing application session, strict Origin validation, and
authorization for the exact project/workspace/session.

The browser supplies `afterSequence`. Web replays SQLite-committed events, establishes replay/live
handoff under one Web session publication lock, sends `stream.synchronized` with the committed
boundary, then sends live committed events. A browser refresh reconnects from its last applied
sequence. Duplicate exact events are ignored; conflict or gap closes the stream and requires a
fresh session snapshot. Slow subscribers have bounded queues and are disconnected with a safe
reconnect instruction; they do not apply backpressure to SQLite commit or Agent acknowledgement.

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
identity. All F11 objects are strict. Route handlers are absent in Slice 0.

F11 endpoint descriptors declare one of two operation-journal policies:

- `generic-request` applies to bounded non-content mutations and may retain the complete validated
  request under the existing private generic journal rules.
- `ai-private-intent-reference` is mandatory for `ai-session.turn.send` and
  `ai-session.input.respond`, and for any future content-bearing mutation.

For the second policy, the generic journal retains only operation ID, operation name, a versioned
keyed HMAC-SHA-256 request fingerprint, and an opaque reference to one dedicated Agent-private AI
intent record. The full strict content-bearing request is stored only in that intent area, bound
to operation ID, operation name, project/workspace/session, turn/request when applicable, profile
ID/revision, and process generation. The durable Agent-private HMAC key and its non-secret key
version are deployment state; raw unkeyed content digests are prohibited because low-entropy
answers could be guessed.

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

F10 no longer carries the dormant `ai-session.state.changed` event or AI snapshot member. AI
session recovery uses F11's dedicated stream plus the later Web-owned session snapshot/read model.
No competing AI event contract remains.

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

## Codex app-server adapter v0.145.0

The exact pin is `codex-cli 0.145.0`; the captured CLI binary SHA-256 is
`a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14`.
Stable-default component evidence was generated with:

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
`UPSTREAM-NOTICE.md` records OpenAI Codex provenance and Apache-2.0 licensing. The adapter mapping
is:

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

The adapter sends `initialize` first, responds with `initialized`, and does not set
`experimentalApi: true` for the foundation profile. Stable APIs are required by default. The
structured-input method is explicitly experimental in this pin and therefore optional; its
absence cannot disable the required profile. Other experimental methods/fields are ignored unless
a later profile revision and contract explicitly adopt them.

The adapter fixes the exact managed `/workspace` cwd and approved sandbox/approval policy from the
deployment profile and runtime authorization. It does not forward browser-supplied Codex model,
cwd, environment, permissions, sandbox, executable, arguments, or native IDs. Raw JSON-RPC stays
inside Agent.

## Later persistence shape (not implemented here)

The persistence slice should use a hybrid model:

- append-only canonical events as the durable ordered content/activity record;
- normalized sessions, turns, and interaction-request read models for invariants and queries; and
- a private encrypted/opaque resume-metadata record whose values are never public.

Minimum later tables are `ai_sessions`, `ai_turns`, `ai_events`, `ai_interaction_requests`, and
`ai_provider_resume_metadata`. Web remains the sole writer. Required uniqueness includes one
session sequence, global event ID, one nonterminal turn per session, and one response per request.
The existing dormant `ai_sessions` table requires a forward migration; Slice 0 deliberately does
not change it. Existing non-AI tables and lifecycles are not event sourced.

## Explicit exclusions

AI Sessions v1 Slice 0 does not implement multiple providers, arbitrary executable configuration,
host AI execution, terminal-backed first-class sessions, database changes, credentials, provider
runtime, Agent/Web handlers, browser UI, file editor, Git staging/publish, checkpoints, autonomous
orchestration, persistent generic terminals, multiple workspaces, authentication replacement,
automatic merge, production deployment, or broad event sourcing.
