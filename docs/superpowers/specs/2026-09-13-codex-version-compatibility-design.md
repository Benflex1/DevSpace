# Codex App-Server Version Compatibility Design

## Status and decision summary

**Status:** design proposal for review; no production implementation is included in this
commit.

**Scope:** the Codex provider compatibility and executable-identity layer surrounding AI
Session Beta Checkpoint 2 (PR #50). The existing Checkpoint 2 interaction, persistence,
Workbench, and browser authority work remains the foundation.

This design makes Codex `0.145.0` the minimum supported compatibility baseline, not the
only executable that DevSpace may run. There is no supported upper version bound. A Codex
release is accepted when its reported version is at least `0.145.0` and its inspected
app-server protocol satisfies the required structural and semantic invariants. A newer
release is not rejected merely because DevSpace has not tested that exact release before.

The recommended architecture is:

```text
configured executable
  -> canonicalize and stage the exact bytes
  -> SHA-256 and bounded `codex --version`
  -> private schema discovery and initialize negotiation
  -> structural compatibility evaluation
  -> semantic capability projection
  -> profile revision/fingerprint
  -> launch the same staged bytes
```

The runtime uses one stable DevSpace semantic adapter for the Codex app-server protocol
family. Runtime-discovered schemas and the initialize handshake supply structural facts and
capability evidence; they do not replace the adapter's security-sensitive semantics.

The design is intentionally separate from the implementation plan. Implementation may begin
only after this design is reviewed and approved.

## 1. Problem statement

The current Checkpoint 2 provider path is production-named and authorized as Codex
`0.145.0`: it checks one CLI version string and one executable SHA-256, launches a
`v0-145` adapter, and treats the resulting capability set as the provider contract. That
was a useful safety boundary for the first real-provider slice, but it makes ordinary Codex
updates look like a DevSpace release event. It also makes the exact 0.145 executable hash an
authorization rule rather than a baseline test fixture.

The accepted Checkpoint 2 work already solves the harder browser workflow problems:

- durable workspace-scoped sessions and turns;
- Agent-private native interaction identity mapped to DevSpace-owned request IDs;
- redacted approval and structured-input presentations;
- exact Web project/workspace/session/turn/request binding;
- atomic canonical event and interaction projection;
- one-shot response and canonical reconciliation rules;
- `serverRequest/resolved` retirement;
- profile-pinned sessions and one-live-Codex lease behavior; and
- changed-file routing through the existing Workbench.

The compatibility change must wrap that foundation without moving provider-private state into
the browser or weakening the existing Web/Agent, workspace, credential, Docker, filesystem,
Git, or process authority boundaries.

## 2. Goals and non-goals

### Goals

This design must enable DevSpace to:

1. accept Codex `0.145.0` and newer without a hard upper bound;
2. reject versions older than `0.145.0` with a useful, bounded diagnostic;
3. tolerate routine additive protocol releases automatically;
4. disable only the affected optional capability when a safe feature is absent;
5. fail closed when a required message shape or blocking request is unsafe to interpret;
6. derive profile authority from the exact executable bytes and effective protocol/capability
   surface;
7. prevent a path replacement from changing the bytes inspected into different bytes launched;
8. cache private compatibility discovery by executable SHA-256 without making the cache browser
   authority or adding runtime internet access;
9. preserve the existing Checkpoint 2 interaction, session, and Workbench guarantees; and
10. make the currently installed newer Codex usable as a later, explicit dogfood target after
    the architecture is implemented.

### Non-goals

This design does not add multiple AI providers, a model marketplace, automatic executable
downloads or updates, package management, project creation, Git identity settings, branch
management, checkpoints, rollback, multi-agent orchestration, a new editor/diff implementation,
generic plugin infrastructure, or a redesign of AI-session persistence.

It does not make generated JSON Schema a dynamic security policy, does not accept arbitrary
provider commands from the browser, and does not turn a newer Codex into an implicit reason to
change the provider-neutral public contracts.

## 3. Compatibility policy

Compatibility is a conjunction, not a version lookup:

```text
accepted =
  minimumVersionSatisfied
  && executableIdentityStable
  && requiredTransportWorks
  && requiredStructuralShapesPresent
  && semanticAdapterChecksPass
```

The policy is:

| Observation | Result |
| --- | --- |
| Reported version below `0.145.0` | Provider unavailable: `CODEX_VERSION_BELOW_MINIMUM`. |
| Reported version at or above `0.145.0`, compatible required protocol | Provider available. |
| New optional object fields | Ignore after bounded validation. |
| New non-blocking notifications | Ignore only under the explicit notification policy. |
| Required feature absent | Disable the corresponding DevSpace capability. |
| Required shape for an optional feature incompatible | Disable that feature, unless the provider can be waiting on an unsafe request; then fail the provider/session closed. |
| Basic app-server transport or turn semantics incompatible | Provider unavailable. |
| Unknown server request that may require a response | Fail closed with a safe incompatibility diagnostic; never leave Codex waiting silently. |

The exact Codex version is useful diagnostic and profile input, but it is never a substitute
for protocol evaluation. There is deliberately no rule such as `>=0.145 && <=0.153` and no
list of approved release numbers. `0.145.0` is the lower compatibility boundary and the
minimum fixture we promise not to regress below.

An inspect result is Agent-private until Web receives its bounded safe projection. The
projection may contain availability, stable failure code, profile ID/revision, and effective
capability booleans. It never contains generated schemas, raw provider messages, executable
bytes, native request IDs, or provider-private diagnostics.

## 4. Minimum-version policy

The minimum is the semantic version `0.145.0`, read from the exact executable being inspected
by its bounded `codex --version` output. The 0.145 baseline source and fixtures are pinned to
the OpenAI Codex `rust-v0.145.0` tag; the tag's CLI source defines the app-server schema
generation commands used below.

The parser accepts the repository's supported Codex CLI version output format and extracts a
strict semantic version. It rejects missing, malformed, or contradictory output. Numeric
comparison is against `0.145.0`; there is no maximum. A prerelease is not accepted merely
because its numeric prefix looks new: it must pass the same version parser and all structural
and semantic checks, and a prerelease below the released `0.145.0` baseline remains below the
minimum under normal semantic-version ordering.

The exact 0.145 executable hash remains valuable in the baseline fixture and real-provider
acceptance corpus. It must not remain a production allowlist. An administrator-configured
executable with a different SHA-256 is expected and must be evaluated normally.

## 5. Executable discovery

The Agent owns discovery. The browser can select a safe provider profile ID but never supplies
an executable path, launch arguments, environment, or hash.

For one discovery operation the Agent:

1. resolves the administrator-configured executable path according to the existing Agent path
   policy and canonicalizes it;
2. opens and validates the source as a bounded regular executable without following a final
   replacement symlink;
3. copies the exact inspected bytes into an Agent-private staging area and verifies the staged
   copy's digest;
4. runs all probes against the staged copy, not the mutable configured path;
5. computes SHA-256 and runs the staged copy with bounded `--version` output;
6. checks the minimum version;
7. loads a valid private discovery-cache entry keyed by the exact digest, or generates stable
   and experimental schemas from the staged copy;
8. evaluates the structural and semantic compatibility rules;
9. derives effective capabilities and the profile revision; and
10. uses those same staged bytes for the managed provider launch after the runtime/workspace
    authority checks succeed.

The pinned 0.145 CLI source and repository fixture define these discovery commands:

```text
<staged-codex> --version
<staged-codex> app-server generate-json-schema --out <private-temp-dir>
<staged-codex> app-server generate-json-schema --experimental --out <private-temp-dir>
```

The managed runtime launch remains the existing bounded stdio app-server entrypoint for the
compatibility family. A future executable that changes the transport or launch contract is not
made safe by a version number; it receives a fundamental transport-incompatibility diagnostic
unless a deliberately supported family change is designed.

Every subprocess probe has bounded wall time, stdout/stderr bytes, output file count/size, and
exit handling. Probe stderr is Agent-private. Discovery does not read the user's ambient Codex
home or mutate host Codex configuration.

## 6. Executable identity and TOCTOU safety

The security boundary is the exact byte set, not the configured pathname. A path can be replaced
between `stat`, hashing, version probing, upload, and launch; the implementation must not have
separate unchecked reads at those boundaries.

The proposed identity flow is:

```text
configured path
  -> canonical path policy + no-follow open
  -> descriptor validation and bounded complete read
  -> SHA-256(bytes)
  -> private staged file written atomically and fsynced
  -> reopen/readback/hash staged file
  -> version/schema probes on staged file
  -> container upload from staged bytes
  -> bounded container readback digest proof
  -> launch only the verified staged/uploaded bytes
```

The source check retains the existing security requirements for regular files, ownership,
permissions, link count, size, and stable descriptor metadata where they apply. The staging
file is Agent-private, mode-restricted, written in a private directory, atomically renamed,
and re-opened for an identity check. The source path may change after staging without changing
the bytes used by the rest of the operation. If the source changes before staging or any digest
proof differs, discovery fails with `CODEX_EXECUTABLE_INTEGRITY_CHANGED` and does not launch.

The Agent records the staged digest with the private provider ownership record. The existing
container upload/readback proof is extended to compare that digest before the app-server process
is considered running. Process generation, exact container identity, workspace/runtime identity,
profile revision, and staged executable digest remain one authority tuple.

`canonicalPath` is retained for private diagnostics and configured-source resolution. The
profile hash is primarily bound to the executable SHA-256, not to a cosmetic pathname, so moving
the same verified bytes does not unnecessarily invalidate sessions. If deployment policy makes
the path itself authoritative in a future environment, that policy version is an explicit
profile input rather than an accidental hash field.

## 7. Protocol and schema discovery

### Pinned 0.145 evidence

The exact `rust-v0.145.0` source and the repository's retained fixtures show:

- `codex app-server generate-json-schema` requires `--out <directory>`;
- `--experimental` adds experimental methods and fields;
- `initialize` accepts `capabilities.experimentalApi`;
- the normal handshake is `initialize`, a response, then `initialized` before thread/turn use;
- stable request/notification envelopes and the experimental user-input request are separately
  representable; and
- `serverRequest/resolved` is a notification with native `threadId` and `requestId`.

The source tag and pinned fixtures, not current/latest Codex documentation, are authoritative
for the baseline. Newer behavior is evidence only after the configured newer executable is
discovered and tested through this design.

### Discovery output

Discovery produces an Agent-private value with these conceptual parts:

```text
ExecutableIdentity
  sha256
  reportedVersion
  canonicalSourcePath (private, not profile identity by itself)

ProtocolEvidence
  transportFamily
  stableSchemaFingerprint
  experimentalSchemaFingerprint
  observed/requested method inventory
  required-shape checks
  initialize capability result

CompatibilityResult
  protocolFamily
  semanticAdapterVersion
  effectiveCapabilities
  unavailable/failure code, if any
```

Schema fingerprints are hashes of canonicalized bounded schema bundles. Raw schemas, schema
paths, and native method inventories are not browser authority. A schema can establish that a
field has a string-shaped slot; only the stable semantic adapter decides whether the field is
safe, bounded, workspace-relative, provider-private, or sufficient for a DevSpace capability.

The initialize handshake remains a runtime proof even when discovery is cached. The Agent sends
only the bounded capability request selected by the compatibility result. For the 0.145
structured-input surface, that includes `capabilities: { experimentalApi: true }`. If discovery
proves only the stable surface, the process is initialized without claiming structured input and
the public capability is false. An initialize rejection is not hidden: the Agent either starts a
fresh stable-only process when the failure is isolated to the optional experimental surface, or
marks the provider unavailable when the required base handshake cannot be established. No active
session changes capability mode in place.

## 8. Discovery caching

Discovery is lazy at the first provider inspection/AI use and single-flighted per Agent
executable identity. The Agent still reopens, stages, and hashes the configured executable on
each profile resolution; a cache hit skips schema regeneration but never skips byte identity
verification.

The private cache is keyed primarily by executable SHA-256. To prevent stale policy reuse, the
key/value also binds:

- host/runtime target needed by the probe;
- schema command mode (`stable` and `experimental`);
- discovery cache format version;
- semantic adapter version;
- compatibility policy version; and
- the bounded schema-generator command contract.

The cache stores only bounded private evidence and the resulting safe evaluation. It is written
atomically, rejected if malformed/oversized, and invalidated by digest or policy/evaluator
changes. It has no browser/API read path and is not a substitute for the per-launch initialize
handshake. No internet access is needed at runtime and CI does not fetch a Codex executable.

The cache must not include a raw provider request, response, secret, credential, arbitrary
diagnostic, or unbounded schema text. If retaining raw schemas helps local diagnostics, they
remain Agent-private, bounded, and disposable; the normal cache stores fingerprints and the
validated facts needed for the next evaluation.

## 9. Structural compatibility model

The adapter has three layers:

1. **Envelope/transport layer.** Validate bounded JSONL JSON-RPC envelopes, request/notification
   distinction, IDs, message size, and required stdio handshake behavior.
2. **Runtime structural layer.** Use discovered schemas to verify the presence and broad types of
   required methods, params, responses, and notifications. Extra fields are allowed.
3. **Stable semantic layer.** Decode only the supported method families into bounded internal
   values and enforce DevSpace-owned lifecycle, redaction, path, capability, and authority rules.

The runtime does not compile or execute an arbitrary generated client. A generic production
boundary replaces names such as `codex-interactions-v0-145.ts`; the 0.145 schemas and fixtures
remain a baseline corpus. A future additive release should therefore reuse the same semantic
adapter, while a genuinely incompatible family fails through a diagnostic or a deliberately
reviewed adapter change.

The minimum required structural surface is:

| DevSpace behavior | Required baseline surface |
| --- | --- |
| Initialization | `initialize`, `initialized`, bounded response/error semantics, and capability negotiation. |
| Session/thread | `thread/start`, thread identity in subsequent events, and the configured workspace cwd contract. |
| Turns | `turn/start`, turn identity, `turn/completed`, and bounded error/terminal semantics. |
| Assistant output | `item/agentMessage/delta` plus the item/turn identity needed to project it. |
| Activity | Validated supported item-start/completion notifications; unknown non-blocking activity may be ignored by policy. |
| Interrupt | `turn/interrupt` and a response/terminal observation that can be reconciled. |
| Command approval | Exact request/response shape, native request ID, thread/turn binding, safe command presentation fields, and one-shot response behavior. |
| File approval | Exact request/response shape plus correlated file-change item metadata; `grantRoot` is not a path list. |
| Structured input | Experimental opt-in, request questions/options semantics, response encoding, and `serverRequest/resolved`. |

Stop/restart/reconnect are primarily DevSpace Agent/process lifecycle capabilities. They still
require the same exact process-generation proof and canonical event reconciliation even when the
provider's protocol has no special stop primitive beyond process shutdown.

## 10. Semantic invariants

Schemas cannot decide these rules. The adapter must keep them stable across compatible Codex
versions.

### Session and turn invariants

- The Agent owns the provider process, native thread/turn/item/request IDs, and the private
  response binding.
- Browser/Web use only DevSpace-owned IDs and the exact persisted route/session binding.
- A thread/turn event must carry the native identities required to match the Agent's private
  session and process generation; missing or mismatched identity fails closed.
- Assistant deltas and activities remain bounded, sequenced, and redacted/projected through the
  existing canonical event path.
- A provider process cannot be rebound to a different project, workspace, session, or profile
  revision.

### Approval invariants

- Command and file approvals are only enabled when the current discovered profile advertises the
  capability and the exact request shape passes validation.
- Approval policy is `on-request` and the reviewer is explicitly `user` in the managed
  `thread/start` authority; neither is taken from the browser or ambient host configuration.
- Public command/reason/path/summary presentations pass the existing redaction and bounds policy
  before canonical events or SQLite projection.
- File-change intent comes from the exact correlated provider `fileChange` item state identified
  by native `threadId`, `turnId`, and `itemId`. `grantRoot` is provider-private permission-root
  context, never a substitute for proposed changed paths.
- If exact safe paths cannot be proven, the request is not actionable and the provider/session
  fails through existing safe semantics.

### Structured-input invariants

The provider-neutral contract may support both `single-select` and a future `text` kind, but the
Codex 0.145 adapter must model the real pinned shape:

- each supported Codex question has a non-empty bounded option list;
- each question is projected as `responseKind: "single-select"` with `allowOther: true` when
  the pinned `isOther: true` semantics are present;
- secret input (`isSecret: true`) remains unsupported and fails closed;
- `autoResolutionMs` is parsed as bounded integer-or-null, retained only as Agent-private
  lifecycle input, and is not browser authority;
- the browser sends only DevSpace question IDs and option IDs, or an explicit `kind: "other"`
  with bounded text; it never sends a native label;
- a listed option resolves through an Agent-private option map to the exact original provider
  label; and
- an Other answer is encoded privately as `user_note: <text>` for the pinned Codex response.

The public option label is independently redacted/bounded. A transformed public label never
becomes the native response value. The entire bounded answer set is validated and sent once for
the exact request.

### Resolution invariants

Native `serverRequest/resolved` notifications are correlated by private native `threadId` and
native request ID. Normal user response followed by `resolved` is idempotent cleanup; it does
not emit a second public response. Provider-side resolution before a browser answer retires the
DevSpace interaction as `expired`, `cancelled`, or `lost` according to the proven lifecycle
cause, without inventing a user response. A stale browser action then fails with interaction
state conflict and cannot write another provider response.

The canonical responded event remains authoritative for a user decision. An ambiguous transport
outcome never makes the request retryable solely because the response event is temporarily
absent. Re-actionability requires canonical synchronization and positive same-generation proof
that the Agent still owns the exact pending native binding; otherwise the durable interaction is
non-actionable/reconciliation-required or lost.

## 11. Capability negotiation

Effective capabilities are computed from the actual structural evidence, initialize behavior,
semantic checks, and managed runtime authority. They are not globally declared because a recent
Codex normally has a feature.

| Capability | Required evidence | Safe degradation |
| --- | --- | --- |
| `sendTurn` / basic session | Initialize, initialized, thread/start, turn/start, bounded assistant/terminal events, and compatible transport. | If absent or incompatible, provider unavailable. |
| `streamEvents` | Required event envelope and assistant/activity/terminal projections. | Provider unavailable if normal output cannot be represented; optional activity messages may be ignored. |
| `interrupt` | `turn/interrupt` plus a reconciliable terminal/response outcome. | `interrupt: false`; the UI does not offer an impossible action. |
| `approvals` | Both required approval request families, safe response shapes, command presentation validation, exact file-change item correlation, and resolution handling. | `approvals: false` if the provider can run ordinary turns without exposing an unsafe request. An unsafe blocking request fails the provider/session closed instead of hanging. |
| `structuredInput` | Experimental schema contains the supported request/response surface, `experimentalApi` can be enabled, options/Other semantics are valid, and resolution handling is present. | `structuredInput: false`; basic turns remain usable if no structured request can be emitted. |
| `stop` | Existing Agent process lifecycle and cleanup proof. | Required for this DevSpace session profile; inability to prove cleanup makes the provider unavailable. |
| `resume` | Existing DevSpace profile/session rules and the exact provider/process authority needed by that operation. | Historical inspection remains available; restart is rejected when profile identity differs. |

If a provider starts a turn and then sends a known request whose semantics fail validation,
the adapter does not pretend the relevant capability was absent. It fails the affected provider
session closed, retires pending interactions, and exposes only a bounded incompatibility code.

## 12. Tolerant parsing policy

The protocol parser is tolerant where tolerance cannot change authority:

- unknown extra object fields are ignored after object size and known-field validation;
- absent optional fields use only explicit semantic defaults from the supported protocol contract;
- known enum values are mapped explicitly;
- unknown enum values are never coerced to a nearby known value;
- an unknown enum in a non-blocking optional activity disables/omits that activity projection;
- an unknown enum in an approval/input request, terminal state, or response fails the affected
  capability/request closed;
- malformed, oversized, invalid-UTF-8, NUL-containing, or out-of-bound provider content follows
  the existing bounded/fail-closed policy; and
- parsing never exposes the raw rejected value in a browser response, SQLite row, generic log,
  or safe error.

This policy is intentionally narrower for security-sensitive request families than for passive
activity notifications.

## 13. Unknown notification and request policy

The Agent maintains an explicit notification policy with three categories:

1. **Project and retain:** known notifications needed by the canonical event projection.
2. **Validate and handle privately:** known lifecycle/resolution notifications such as
   `serverRequest/resolved`, provider item correlation, and cleanup observations.
3. **Validate and ignore:** unknown or newly additive notifications that have no JSON-RPC request
   ID, are within envelope/message bounds, do not carry a supported blocking semantic, and are
   explicitly classified as safe non-blocking observations by the compatibility policy.

An unknown message with a JSON-RPC request ID is a server request, not a harmless notification.
It fails closed with `CODEX_UNKNOWN_BLOCKING_REQUEST`; the Agent does not send a guessed response
and does not leave the provider waiting. A known method with missing required semantic fields is
handled the same way for that request family. A notification with an invalid envelope or unsafe
size also fails the provider rather than being silently discarded.

This rule permits additive telemetry/activity notifications while preventing a new Codex
permission, approval, elicitation, or tool request from being silently stranded.

## 14. Interaction compatibility

The existing Checkpoint 2 interaction model is retained. The compatibility layer only changes
how the Agent obtains and validates native facts.

```text
native provider request
  -> Agent validates native thread/turn/item/request binding
  -> Agent creates DevSpace UUID request ID
  -> Agent stores native binding and private option/path/item state
  -> safe public presentation enters canonical requested event
  -> Web atomically projects ai_interaction_requests
  -> browser responds with DevSpace UUID + bounded decision/answers
  -> Web validates exact durable project/workspace/session/turn/request state
  -> Agent resolves private binding and sends one native response
  -> canonical responded or retirement event becomes authoritative
```

Provider-native IDs never become durable public identities. They are not profile fields, event
fields, SQLite request identities, browser keys, logs, or error details.

The interaction adapter must preserve:

- all four bounded approval decisions and their valid provider mapping;
- command presentation redaction and bounds;
- file-change item correlation, path canonicalization beneath the workspace root, duplicate
  removal, bounded path count, and original private truncation fact;
- structured multi-question validation, public option IDs, private native-label mapping,
  `allowOther`, and `user_note:` encoding;
- `autoResolutionMs` parsing and provider-side retirement;
- atomic requested/responded/retired canonical projection;
- duplicate-event idempotence and deterministic request-before-response replay; and
- no blind retry after an ambiguous provider response.

The browser never receives the discovery cache, raw native params, raw diffs, native request IDs,
native labels, provider executable details, or process generation.

## 15. Profile revision authority

The effective profile revision is the identity of the authority that would actually execute a
new managed Codex process. The normalized authority document must include at least:

```text
providerKind: "codex"
reportedCodexVersion
executableSha256
protocolFamily
stableSchemaFingerprint
experimentalSchemaFingerprint (or an explicit absent marker)
semanticAdapterVersion
compatibilityPolicyVersion
effectiveCapabilities
experimentalApiEnabled
approvalPolicy: "on-request"
approvalsReviewer: "user"
relevant DevSpace provider policy
launch/transport authority
runtime/workspace identity fields already required by AI sessions
credential-source and lease policy identities
```

The exact names may follow the existing `devspace.ai-provider-profile-authority/v1` contract,
but the meanings are mandatory. The executable SHA-256 is the byte identity; changing bytes at
the same path changes the revision. A changed schema/capability result or compatibility policy
changes the revision. A change to the experimental opt-in or browser reviewer changes the
revision. A semantic adapter release changes the revision because it can change interpretation.

The normalized authority is serialized with the existing JCS/revision hashing rules and a
versioned domain separator. Effective false capabilities are included so a structured-input
regression cannot silently share a session authority with a profile that supports it.

The hash excludes cosmetic display names, timestamps, cache locations, raw schemas, raw errors,
credential values, and provider content. The canonical source path is retained privately but is
not included merely because its spelling changed when the same executable bytes and policies
remain effective.

The browser sees only the safe profile projection and revision. It cannot set or override any
of these inputs.

## 16. Session behavior across Codex upgrades

Every persisted session remains pinned to the profile revision recorded at creation. A Codex
update creates a new effective profile revision; it does not rewrite existing sessions.

### Create and lease behavior

The current database behavior that returns an existing Codex session must become profile-aware:

- an idempotent Create request reuses the existing current-revision nonterminal session when one
  exists;
- repeated or ambiguous Create requests cannot create a second live session;
- stopped/lost historical sessions, including old-profile sessions, do not block creation of a
  new current-revision session;
- a different old-profile session that is still nonterminal and holds the one-live-Codex lease
  remains the lease owner; Create does not bypass it or start a second provider; and
- the navigator may select all persisted sessions for history, but it truthfully disables or
  explains actions that the current profile/lease cannot perform.

The idempotency lookup therefore distinguishes current nonterminal, old-profile live, and
terminal historical rows instead of returning the first Codex row unconditionally. Database
uniqueness and operation reconciliation remain the final duplicate barrier.

### Existing sessions after a profile change

- A stopped/lost session with an old revision remains selectable for inspection.
- It cannot be restarted under a new executable/profile. The user creates a new session under
  the current profile instead.
- A live process is never relaunched from a changed configured path under the old session ID.
- When an Agent restart discovers that a live session's stored profile cannot be securely
  re-established, the session is marked lost/history-only through the existing lifecycle. Its
  pending interactions are retired and its history remains readable.
- If a configured profile changes while an old process is still live, the Agent does not switch
  that process to the new bytes. The existing generation is fenced from new turns and browser
  responses once the change is observed; only exact old-generation cleanup/stop reconciliation
  may finish. This explicit loss/history outcome is preferred to pretending the session resumed
  under a different provider identity.

No old session is silently migrated. A new current-profile session is admitted only after the
one-live-provider lease, runtime generation, and current profile inspection all succeed.

## 17. Compatibility diagnostics

Diagnostics are stable codes plus bounded safe details, never raw provider output. The initial
closed set should include:

| Code | Meaning |
| --- | --- |
| `CODEX_EXECUTABLE_MISSING` | Configured executable cannot be securely opened. |
| `CODEX_EXECUTABLE_INTEGRITY_CHANGED` | Source/staged/uploaded bytes did not remain identical. |
| `CODEX_VERSION_UNREADABLE` | `--version` output was missing or malformed. |
| `CODEX_VERSION_BELOW_MINIMUM` | Reported version is below `0.145.0`. |
| `CODEX_SCHEMA_DISCOVERY_FAILED` | Bounded schema generation or parsing failed. |
| `CODEX_PROTOCOL_INCOMPATIBLE` | Required transport or semantic baseline is absent. |
| `CODEX_REQUIRED_CAPABILITY_UNAVAILABLE` | A required DevSpace capability cannot be represented. |
| `CODEX_INITIALIZE_NEGOTIATION_FAILED` | Managed initialize/initialized handshake failed. |
| `CODEX_UNKNOWN_BLOCKING_REQUEST` | Provider sent an unknown request that may be waiting for a response. |
| `CODEX_PROFILE_CHANGED` | Existing session authority no longer matches the configured profile. |
| `CODEX_DISCOVERY_CACHE_INVALID` | Private cache entry failed bounds, digest, or policy validation. |

Safe details may include the parsed version, affected capability, protocol family, or whether
stable versus experimental discovery failed. They must not include raw stdout/stderr, command
text, questions, labels, paths, diffs, native IDs, credentials, or provider exceptions.

## 18. Test and fixture matrix

The repository remains deterministic and must not require internet access for normal CI.

| Fixture | Purpose |
| --- | --- |
| Exact Codex 0.145.0 baseline | Preserve the minimum-version promise, stable/experimental schema commands, initialize opt-in, approval/input shapes, resolution notification, and all existing CP2 regressions. |
| Newer real Codex, ideally installed 0.153.x | Acceptance probe for a newer executable; not a hard-coded production allowlist and not required for offline CI. |
| Synthetic additive fixture | Adds optional fields, non-blocking notifications, and harmless enum/object additions; compatibility remains available and the new fields do not reach public state. |
| Synthetic breaking fixture | Removes/changes a required method or semantic field; provider or only the affected capability fails closed as defined. |
| Missing-capability fixture | Retains basic turns but removes experimental structured input or interrupt; effective capability becomes false without claiming support. |
| Executable identity fixtures | Same path replaced with different bytes, same bytes at a different path, corrupt cache, changed digest, and failed container readback. |

Focused automated tests must prove:

- lower versions reject and newer compatible versions do not fail an upper-bound check;
- discovery uses the exact staged bytes and cache hits do not skip hashing;
- 0.145 stable and experimental schemas produce the expected feature set;
- additive fields/notifications are tolerated only under the explicit policy;
- unknown server requests fail closed and unknown unsafe enum values are not coerced;
- missing structured input disables only that capability;
- profile revision changes for bytes, reported version, schema/feature set, experimental opt-in,
  approval policy/reviewer, or policy version, but not display name/cache path;
- old-profile sessions remain history-only and current-profile Create is idempotent across
  repeated/ambiguous requests;
- native interaction IDs stay private through requested/responded/resolved replay;
- approvals, file item correlation, redaction, `grantRoot` separation, option mapping,
  `user_note:` encoding, provider retirement, and one-shot ambiguity reconciliation remain
  green; and
- existing stream sequence, output/history bounds, interrupt, stop/restart, cleanup, changed
  files, and Workbench routing tests remain green.

The deterministic Playwright fixture should later select a capability matrix fixture rather than
asserting that every Codex profile has every optional feature. A real 0.153.x browser dogfood is
an acceptance path after implementation, not a replacement for the pinned regression suite.

## 19. Migration from 0.145-specific production code

The migration is a boundary refactor, not a second AI-session foundation:

1. Rename production concepts from `v0-145` to protocol-family concepts such as
   `codex-app-server/protocol`, `interactions`, `notifications`, `compatibility`, `discovery`,
   and `runtime`.
2. Move the existing semantic interaction code into the generic adapter with its current
   redaction, file-item correlation, option mapping, resolution, and one-shot rules intact.
3. Replace the exact `CODEX_APP_SERVER_CLI_VERSION` equality check with the minimum-version gate
   plus protocol evaluation. Keep the 0.145 version string as a baseline fixture expectation.
4. Remove the exact 0.145 executable hash from the production authorization decision. Retain it
   in the baseline manifest/acceptance corpus and use the inspected digest in the runtime
   profile instead.
5. Replace the exact-version notification registry with a generic explicit policy registry whose
   baseline entries are populated from 0.145 evidence and whose unknown-message behavior follows
   this design.
6. Add the private discovery-cache and exact staged-byte identity path around the existing
   provider launch; do not duplicate provider transport architecture.
7. Project discovered capabilities into the existing safe profile response and use them to gate
   Checkpoint 2 UI/actions. Do not duplicate capability state in SQLite.
8. Keep exact 0.145 generated schemas and fixtures under a baseline-corpus path. Add newer and
   synthetic fixtures without creating a production adapter per release.
9. Update the versioned AI-session/Agent API wording that currently calls 0.145 an exact approved
   executable during implementation, once the runtime contract actually changes. This design
   commit does not pretend that production code has already migrated.

The accepted Checkpoint 2 tests are the first compatibility-regression suite. Their provider
fixtures should be generalized, not deleted.

## 20. PR #50 integration strategy

Recommendation: keep the compatibility/identity change on PR #50 before merge if it can be
landed as a bounded provider-boundary series. The current hard 0.145 authority blocks the real
newer-Codex dogfood that this architecture is meant to enable, while the durable interactions,
browser UI, session navigator, and Workbench integration in PR #50 are directly reusable.

The implementation should remain staged:

1. generic provider contracts, discovery result, profile inputs, and baseline fixture matrix;
2. exact staged-byte inspection/cache and runtime launch binding;
3. structural compatibility/capability projection;
4. migration of the existing semantic interaction adapter; and
5. deterministic matrix tests followed by separate real newer-Codex dogfood.

Do not rewrite the CP2 persistence or browser architecture. If the compatibility layer cannot be
kept within that provider boundary without an uncontrolled rewrite, the safe fallback is to merge
the already accepted CP2 work first and land this design's implementation immediately afterward
as a follow-up. That fallback must still remove the old hard upper/exact-executable policy before
claiming newer-Codex support. This design task itself does not merge PR #50.

## 21. Orca-primary / T3-secondary reference policy

[`stablyai/orca`](https://github.com/stablyai/orca) is the primary product and UX reference for
future DevSpace Workbench work:

- overall Workbench structure and agent-centric workflow;
- files/editor/terminal/browser integration;
- activity presentation, approvals/questions, and changed-file/review flow; and
- how an AI session belongs inside a development workspace.

[`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) at revision
`d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3` is a secondary technical reference for isolated
mechanics when Orca does not cover a detail, such as session orchestration or a small interaction
pattern. It is not the primary product reference.

Neither project overrides DevSpace's Web/Agent authority, SQLite ownership, managed-workspace,
Git, Docker, filesystem, process, credential, preview, or provider boundaries. Checkpoint 2 used
conceptual T3 patterns only; no T3 source code was copied or substantially adapted. The existing
T3 note is therefore a neutral reference record, not a claim that copied MIT source is present.

## 22. Security and authority analysis

The main new risks and controls are:

| Risk | Control |
| --- | --- |
| Executable path replacement between inspection and use | One Agent-private staged byte set, digest/readback proof, and launch from that staged set. |
| A newer provider sends a private/secret field | Provider-native values stay Agent-private; public presentations pass the existing typed redaction policy and fail closed when unsafe. |
| Generated schema is treated as permission to execute a new operation | Schema is structural evidence only; the semantic adapter has explicit method/capability allowlists. |
| Unknown request leaves Codex waiting | Any unknown request with an ID fails closed with a stable diagnostic; no guessed response. |
| A new approval/input shape crosses the browser boundary | Required semantic fields and capability checks fail before public projection; raw input is never logged/projected. |
| Same option label is transformed publicly and sent back incorrectly | Public option IDs map to an Agent-private exact native-label table; the transformed label is never the response value. |
| Cache poisoning or stale policy | Digest-keyed bounded cache, atomic writes, policy/evaluator fingerprints, private access, and per-use executable hashing. |
| Existing session silently runs a new binary | Stored profile revision and process generation fencing; old sessions are historical/lost rather than migrated. |
| Browser overrides process/profile authority | Web derives the persisted binding; Agent revalidates the current profile and exact private process ownership. |
| Ambient host Codex behavior changes unrelated sessions | Managed launch arguments, isolated credential authority, and no host configuration mutation. |

This design does not introduce a second provider or a browser-visible compatibility oracle. The
Agent remains the sole authority for executable identity, protocol negotiation, provider-native
IDs, response binding, and process generation.

## 23. Rollout and dogfood plan

After design approval, implementation proceeds in small bounded increments:

1. Add generic compatibility/discovery contracts and baseline tests without changing the browser.
2. Implement exact byte staging, cache, and profile fingerprint inputs; retain the old path only
   behind focused migration tests until the new proof is complete.
3. Migrate the runtime and semantic adapter names from 0.145-specific production identity.
4. Run the 0.145 baseline matrix and full existing Checkpoint 2 suites.
5. Run synthetic additive, breaking, and missing-capability fixtures.
6. Inspect the actually configured newer Codex through the normal Agent authority path. Do not
   substitute it for the pinned baseline fixture, bypass executable/hash/runtime authority, or
   change the pinned fixture hash to make a dogfood run pass.
7. If inspection succeeds, run newer-version browser acceptance for sessions, approvals,
   structured input, reconnect, changed-file Workbench routing, and profile/session upgrade
   behavior. Report any unsupported capability honestly.

Real newer-Codex dogfood is intentionally not part of this design-only task. The installed
0.153.x executable is not evidence of implementation success until the compatibility layer exists.

## 24. Alternatives considered

### 1. One adapter per known Codex release

Rejected as the normal architecture. It creates version/adapter/hash/release churn, creates an
artificial upper bound, duplicates security-sensitive interaction logic, and still does not
prove that an unlisted binary has the required semantics. Exact versioned fixtures remain useful
for regression, but release identity is not the production adapter boundary.

### 2. Protocol-family structural compatibility plus stable semantics

Recommended. It admits additive releases, supports truthful per-capability degradation, keeps
security-sensitive semantics in reviewed DevSpace code, and allows exact baseline fixtures to
remain authoritative for the minimum supported surface.

### 3. Fully schema-generated dynamic runtime client

Rejected. JSON Schema describes shape, not approval ownership, provider request lifecycle,
redaction, file item correlation, path authority, one-shot response semantics, or safe unknown
request handling. A generated client could accidentally turn a new provider request into an
actionable browser flow or echo a private field. Generated schemas are valuable evidence and
fixtures, not the complete runtime policy.

### 4. Version-independent static manifest with no runtime probing

Rejected. A hand-maintained capability manifest would move the whitelist instead of discovering
the installed executable's actual protocol. It would also miss path-replaced bytes and could
advertise structured input or approvals that the executable cannot initialize or honor.

## 25. Explicit acceptance criteria

The architecture is ready for implementation approval when the implementation plan can commit
to all of the following:

- `0.145.0` is the minimum supported version and no upper version bound exists in production
  code, contracts, or profile policy;
- an administrator-configured newer executable is inspected by actual bytes, version, schemas,
  and initialize negotiation before launch;
- the same inspected/staged bytes are launched, with digest/readback proof across the container
  boundary;
- discovery is private, bounded, deterministic, cached by executable SHA-256, and does not need
  runtime internet access;
- stable DevSpace semantic code, not arbitrary generated schemas, owns lifecycle, redaction,
  approval/input, resolution, path, and one-shot semantics;
- optional capabilities degrade truthfully, while required incompatibility and unknown blocking
  requests fail closed with safe diagnostics;
- profile revision includes executable bytes, reported version, protocol/schema evidence,
  effective features, experimental opt-in, approval policy/reviewer, and existing runtime/
  workspace authority, while excluding cosmetic/raw/private values;
- profile changes never silently migrate existing sessions or bypass the one-live-Codex lease;
- provider-native IDs and values remain Agent-private, including discovery and option mappings;
- all Checkpoint 2 interaction, reconciliation, session navigation, Workbench, and recovery
  guarantees remain intact;
- 0.145, newer, additive, breaking, missing-capability, and identity/TOCTOU fixtures are
  deterministic and covered; and
- Orca is documented as the primary UX reference and T3 Code as secondary technical/conceptual
  reference, with no false copied-code attribution.

## Investigated pinned references

The design was grounded in repository state and the exact OpenAI Codex `rust-v0.145.0` source,
not current/latest protocol documentation. The relevant baseline evidence is:

- `packages/contracts/fixtures/codex-app-server/0.145.0/protocol-manifest.json`;
- the pinned stable/experimental schema fixtures and upstream notice;
- `codex-rs/cli/src/main.rs` at the `rust-v0.145.0` tag for schema-generation commands;
- `codex-rs/app-server-protocol/src/export.rs` for stable versus experimental schema output;
- `codex-rs/app-server-protocol/src/protocol/v1.rs` for `initialize` capability shape;
- `codex-rs/app-server/src/request_processors/initialize_processor.rs` for per-connection
  `experimental_api` handling; and
- the pinned `ServerRequest`, `ToolRequestUserInputParams`, approval, item, and
  `ServerRequestResolvedNotification` schemas.

The product/UX reference hierarchy is documented separately in the Checkpoint 2 design,
roadmap, and T3 reference note: Orca first, T3 Code second, with DevSpace authority always
authoritative.
