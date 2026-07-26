# ADR 015: First-class structured AI sessions

- Status: Accepted
- Refines: ADR 009
- Contract: `docs/specs/ai-sessions-v1.md`

## Context

ADR 009 deliberately used PTY-backed terminals for the first useful AI CLI workflow and left
native structured integration to a later milestone. A first-class AI session now needs ordered
assistant output, durable turn history, approvals, structured input, interruption, truthful loss,
and provider-supported resume. Generic terminal bytes and terminal lifecycle state cannot express
those guarantees. The current Docker-exec PTY attachment also cannot prove process survival or safe
individual termination across an Agent restart.

Codex CLI 0.145.0 provides app-server's JSONL protocol on standard input/output. Its generated
stable-default protocol contains initialization, thread start/resume, turn start/interrupt, item
and turn notifications, and command/file-change approval requests. Structured user input is
explicitly experimental in this pinned version.

## Decision

DevSpace adds a first-class structured AI-session resource while preserving this authority path:

```text
Browser
→ DevSpace Web
→ private Web/Agent Unix socket
→ DevSpace Agent
→ exact authorized managed workspace container
→ approved provider process
```

The browser talks only to Web. Web remains the sole SQLite writer. Agent owns provider processes,
provider-native interaction, container effects, and private ownership records. The provider runs
only inside the exact managed workspace container bound to the accepted project, workspace,
configuration revision, runtime plan, runtime generation, and container identity.

For the initial Codex profile, Agent launches:

```text
Docker exec in the exact development container
→ TTY disabled
→ stdin/stdout JSONL
→ stderr private diagnostics
→ Codex app-server 0.145.0
```

The app-server experimental WebSocket transport is not used. A terminal emulator or PTY is not
inserted into this path. ADR 009 remains valid for ordinary user-operated AI CLI terminals, but
those terminals are not DevSpace AI sessions and cannot be promoted into them.

### Separate resource and authority models

An AI session is not a terminal session. It has separate session, provider-process, turn,
approval, structured-input, canonical-event, and private resume-metadata models.

- Web is authoritative for durable public AI-session history, the selected safe profile identity,
  canonical events after commit, session/turn/request read models, and the one-nonterminal-turn
  invariant.
- Agent is authoritative for approved profile resolution, live provider-process ownership,
  provider capabilities and availability observations, raw protocol handling, native correlation,
  and the Agent-private durable event outbox.
- The browser receives only Web-authorized projections and Web-committed events. A browser state is
  never an independent lifecycle authority.

Session waiting states are projections of the one active turn and its one pending interaction.
They do not create a second independently writable waiting-state authority.

### Data classification

AI data uses three explicit planes.

**Content plane** includes user prompts, assistant output, code, command presentations,
workspace-relative path presentations, approval descriptions, questions, and answers. It may be
stored later in dedicated AI tables and shown to the authenticated authorized owner. Every field
is typed and byte-bounded. Content is never copied into structured diagnostic logs, incident
details, audit summaries, or generic safe error messages. Command-like content is presentation,
not executable authority.

**Control plane** includes allowlisted opaque resource IDs, profile ID/revision/provider,
configuration and runtime identity, process generation, event ID/sequence, capability flags,
lifecycle state, stable failure code, and bounded timestamps. Only fields explicitly allowlisted
by the diagnostics contract may be logged.

**Private plane** includes credentials, environment values, host paths, unprojected container
paths, complete launch commands and arguments, raw provider messages/errors, provider-native
session and correlation IDs, Docker exec/PID/supervisor details, and Agent ownership records.
Private-plane values never enter browser payloads, URLs, SQLite AI content, safe errors, or
structured logs.

Approval UX is therefore possible without publishing raw provider requests. The adapter converts
them to a typed, bounded, redacted presentation. Container paths are either proven to be below the
exact workspace root and converted to canonical workspace-relative presentations, or omitted.

### Provider profiles

AI Session v1 uses a deployment-owned immutable approved-provider registry. The safe projection is
limited to profile ID, profile revision, provider key, display name, capabilities, and availability.
The Agent-private definition may contain the fixed executable identity, fixed app-server launch
mode/arguments, adapter version, required runtime identity/capabilities, credential-source handle,
and availability inspection policy.

Agent derives `profileRevision` with the domain-separated, RFC 8785/JCS-based
`sha256-ai-profile-v1` algorithm defined by AI Sessions v1. The complete strict authority document
binds profile/provider identity, provider and adapter versions, executable identity, launch mode
and ordered arguments, runtime identity/capabilities, credential-source handle identity,
capability declaration, and executable availability-inspection policy. Credential values, host
paths, and display name are excluded; display name is cosmetic and cannot affect execution.

Ambient host credential mounts are rejected. An existing host Codex login may be a deployment
credential source only when Agent projects minimum process-scoped values into the exact exec
without publishing the host path. Credentials never enter Project Options, SQLite, arguments,
labels, logs, safe failures, or browser data. If the pin cannot authenticate without a broad mount,
the profile is unavailable and runtime implementation is blocked.

The browser supplies only `profileId`. Web inspects and may retain the safe projection, then sends
both `profileId` and the inspected `profileRevision` on Agent start/resume. Agent independently
resolves and hashes the deployed definition and rejects a mismatch before durable acceptance or
execution. The operation fingerprint binds that revision, so replay cannot select a replacement
under the same ID. The existing Project Options v1 `aiProfile` shape remains dormant and
non-executable. In particular, its `fixedArgs` and `credentialSecretIds` are not runtime authority
for this milestone. No dedicated provider user is assumed to exist in every image. Missing
executable/version/runtime identity/credential source is a truthful `unavailable` observation.

### Safe process stop prerequisite

A Docker exec ID does not prove the current in-container PID, descendant set, or ownership after
PID reuse. The runtime slice must use a fixed, profile-required Agent-controlled in-container
supervisor/wrapper. The supervisor owns the Codex child pipes and forwards only provider JSONL;
provider bytes do not share a PTY. Its control endpoint is an in-container Unix socket at an
Agent-derived private path. A fixed helper launched by a new exact-container Docker exec may
connect after Agent restart and receives its credential through stdin, not arguments or
environment. The workspace may use the image's ordinary user; a dedicated provider user is not
assumed, so socket permissions are defense in depth and credential/generation proof is mandatory.
The design requires:

1. a cryptographically random private control credential delivered outside browser-visible data;
2. an authenticated private control channel bound to the exact session and process generation;
3. a durable Agent creation record reserved before Docker side effects;
4. exact binding to project, workspace, revision, runtime-plan hash, runtime generation, container
   ID, session, profile ID/revision, process generation, operation ID, and Docker exec ID;
5. a supervisor identity and process-start identity proven to be the child of that exact exec;
6. a dedicated process group/cgroup or equivalent descendant boundary owned by the supervisor;
7. cooperative turn interrupt distinct from provider-process termination;
8. bounded graceful termination followed by bounded escalation against the proven supervisor-owned
   group only; and
9. fail-closed handling for an already-exited process, reused/foreign/ambiguous PID, replaced
   container, missing control proof, Agent restart, and unprovable descendants.

Agent restart does not imply process survival. The existing Docker-exec stdio attachment cannot be
reattached. Only the fixed helper plus authenticated supervisor proof may recover the process;
until that succeeds and every identity is re-proved, the process and active turn become `lost`. If
the current rootless Docker/container capabilities cannot support this proof, safe Stop is a
blocking prerequisite for Slice 1; the invariant must not be weakened.

### Ordered delivery and persistence boundary

Agent assigns each canonical event a permanent per-session sequence before delivery and durably
appends it to an Agent-private acknowledged outbox. The counter starts at 1 and never resets across
Agent boots or provider-process generations for that DevSpace session. Agent emits no event until
the event and next counter are durable.

Web validates and commits events strictly in sequence before any browser delivery. Web acknowledges
the exact committed `(sessionId, sequence, eventId)` to Agent. Agent may discard acknowledged
outbox entries only under the bounded retention policy. A Web crash after commit and before
acknowledgement causes exact replay; Web accepts a byte-semantic exact duplicate and rejects a
conflicting duplicate. Gaps and event-ID reuse are protocol failures. Exhausted durable capacity
stops accepting new turns and fails closed; it never drops acknowledged session history or
continues with an unrecorded event.

This is a bounded event stream for AI sessions only. Existing project, workspace, runtime, task,
terminal, preview, operation, and audit persistence remains state-based and is not migrated to
event sourcing.

### Content-bearing operation fencing

F11 content-bearing mutations do not place prompts or structured-input answers in the generic
operation journal. The future Agent implementation first durably writes the strict full request
to a dedicated private AI-intent record, then records only operation identity/name, a keyed
content-safe fingerprint, and the private record reference in the generic journal. Durable
acceptance occurs only after both records and their directory metadata are durable. Replay loads
the exact referenced intent and revalidates its identity, schema, and fingerprint. Missing,
replaced, corrupt, or mismatched intent fails closed. Private intent retention is bounded but lasts
at least until the operation and associated session/turn/request can be retired consistently.
Content never enters public operation observations, logs, diagnostics, audits, or generic errors.
Non-content F11 mutations may retain their complete bounded validated request under the existing
generic policy.

## Alternatives considered

### Web-assigned committed sequence plus Agent delivery IDs

Rejected. It keeps the public sequence close to SQLite, but Web cannot assign it until receipt.
Agent would still need a durable ordered delivery journal to preserve provider order across Web
and Agent restarts. Two identities would then govern one canonical history, and concurrent
delivery/retry would require another ordering protocol. It does not remove the outbox requirement
and makes Agent canonical events incomplete before crossing the trust boundary.

### Agent-assigned sequence without a durable acknowledged outbox

Rejected. Web restart could lose an event acknowledged only in memory, while Agent restart could
reuse or skip a sequence. Browser-visible output could no longer be proven durable.

### Web-leased sequence ranges

Rejected. Leases introduce permanent gaps after Agent/process failure or require gap-filling
synthetic events. They add coordination without improving the single-session ordered stream.

### Reuse terminal sessions or a PTY

Rejected for first-class sessions. Terminal byte framing, escape sequences, replay limits, and
attachment lifecycle cannot provide typed interactions, canonical event validation, durable
history, or safe process ownership. User-operated AI terminals remain supported separately.

### Host-level provider process or experimental app-server WebSocket

Rejected. Host execution violates workspace authority and mount isolation. The experimental
WebSocket adds an unnecessary transport and authorization boundary; stable-default stdio JSONL is
available inside the exact container.

## Consequences

- Slice 0 adds durable documentation, domain graphs, strict contracts, generated schema, and pinned
  adapter component fixtures with offline byte-hash verification only.
- Provider execution, supervisor implementation, SQLite migrations, credentials, Web/Agent route
  handlers, browser streaming, and UI remain later slices.
- The first implementation supports one approved Codex profile. Provider-neutral capability
  results prevent browser logic from switching on `provider === "codex"`.
- Experimental structured input stays optional for Codex 0.145.0 and cannot be required to enable
  the profile.
- Raw JSON-RPC never crosses the Agent/Web boundary.
- Existing authentication, no-auto-merge, no-auto-deploy, dedicated rootless Docker, and
  host/Coolify Docker-socket prohibitions are unchanged.
