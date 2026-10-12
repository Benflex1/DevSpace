# Project Options safe adoption for existing primary workspaces

Status: approved with required corrections
Base: `f3276d0352d902cf422ad385271ca5e278ab0e0a6` (merged PR #68)

## Goal and boundary

Apply one validated immutable Project Options revision to an existing ready primary
workspace without changing its worktree or Git data. Apply may retire a stopped runtime;
the existing Start action creates the replacement from the newly registered runtime plan.
Only the primary workspace and the current executable Project Options v1 runtime-plan
subset are in scope. No general workspace migration framework, eager image pull, or
workspace deletion/recreation is introduced.

## Existing ownership

- Web SQLite owns `projects.activeConfigRevisionId`, `workspaces.configRevisionId`,
  immutable `project_config_revisions` (configuration and runtime-plan hashes/state),
  operations/audit rows, and preview rows. `getRuntimeContext()` requires the project
  active revision and workspace pin to agree.
- The Agent separately stores immutable revision/plan registrations and a workspace
  ownership record containing the pinned revision plus the stable worktree path and Git
  administration identity. Runtime ownership and runtime-creation records bind Docker
  IDs, labels, ports, and hashes to that exact revision. The worktree and harness state
  paths are independent of the development container.
- The Agent operation journal stores request identity and operation state, resumes
  accepted/running operations after restart, and serializes mutations per project.
- `workspace.rebuild` is declared in the contracts, but there is no matching Web/Agent
  handler in this baseline. It is not existing lifecycle machinery this slice can call.
- Preview rows, Agent preview state, leases, and gateway routes are revision/preview-ID
  scoped. Existing preview materialization currently reuses a key across revisions; it
  must instead create IDs scoped to the new revision and keep old rows inert for history.
- Initial setup uses `getOrCreateOperation()` with project/name-wide identity. Revision
  registration uses a narrow lookup scoped by project, operation name, and
  `(resourceType, resourceId = revisionId)`; Apply itself remains the durable lock for its
  candidate and activation. Setup and unrelated operation identity stay unchanged.

## Apply sequence

1. **Save draft.** Web strictly parses and canonicalizes the full v1 document, compiles
   and hashes its runtime plan, checks the approved preview-base registry and policy,
   then inserts an immutable `draft` revision. The request includes the expected active
   revision ID; SQLite compares it in an immediate transaction. Stale input is rejected.
2. **Reserve Apply.** A Web transaction rechecks the expected active revision and workspace
   pin, confirms no other Apply is pending, and creates a durable `configuration.apply`
   operation. This operation fences runtime, task, session, and preview mutations. Before
   asking the Agent to adopt, Web rejects any other accepted/running workspace operation,
   an AI session with an accepted/starting/running execution or retained live private-home
   lease, or a nonterminal process/task. Historical stopped or lost sessions with no live
   execution or lease remain resumable and do not block configuration changes. Web also
   requires an available Agent journal/runtime and an exact Agent inspection of the old
   revision with workspace stopped and runtime absent or stopped. Agent repeats the
   revision and stopped checks at the mutation boundary.
3. **Register and adopt.** Web registers the candidate revision and plan through the
   existing idempotent Agent operations. A new narrow `workspace.revision.adopt` Agent
   operation receives old and candidate revision identities, plus each old workspace
   preview's revision-scoped ID, key, and approved hostname. Agent checks these against the
   registered old options and its own approved registry. It inspects and removes routes by
   exact project/workspace/preview/revision/generation identity, then confirms absence; a
   missing preview state file does not hide an orphan route. A different managed or foreign
   route using the same hostname blocks adoption and is never deleted by hostname alone.
   Recovery becomes required immediately
   before a route, lease, resource, or ownership mutation. If the exact old runtime exists, Agent
   verifies its ownership labels and stopped state, removes its development container,
   removes the now-unattached owned network, confirms both are absent, then clears the
   matching runtime-creation/ownership records. If both runtime records are absent, Agent
   verifies canonical resource names are unoccupied and never deletes by name alone. It never changes the workspace directory,
   Git metadata, or harness-state directory. Finally it atomically updates the existing
   workspace ownership record's revision fields, retaining every other field.
4. **Activate in Web.** Only after the Agent operation reports success and a fresh
   inspection reports the candidate revision with runtime absent does Web atomically
   compare-and-swap the old active revision and workspace pin, mark the old revision
   superseded and the candidate active, create revision-specific preview rows, mark old
   preview rows inactive, update both Web revision pointers, and write an audit event.
   The operation remains a durable lock until this transaction completes.

The Agent owner pointer changes immediately before the Web activation transaction. If
the process stops in that small cross-store gap, the Web operation remains pending and
blocks workspace mutations; neither side silently treats the Apply as complete. The old
revision remains the Web-authoritative active revision until Agent adoption succeeds and
the Web activation transaction commits. During the gap, the pending Apply controls whether
any runtime action is allowed; no operation may use either revision to start. The Apply
retry/status path must load the operation, draft, and workspace by their stored IDs rather
than `getRuntimeContext()`, which intentionally rejects a revision mismatch. It reconciles
the Agent journal and exact owner inspection, then completes the same CAS. If the active
revision has unexpectedly moved to a third value, it stays locked for explicit recovery
rather than guessing which side to roll back. The activation transaction also marks the
Apply operation succeeded and writes its audit event atomically with both Web revision
pointers, so a crash after SQLite commit cannot strand a successful activation under an
apparently pending Web lock.

## Container recreation on Start

For the state covered by current contracts, `WorkspaceRuntimeManager`
already creates a container from the registered image and mounts the Agent-owned worktree
path at `/workspace` when no runtime ownership/creation record exists. Therefore Apply
retires only the exact stopped container and its exact workspace network; the next normal
Start uses the candidate revision and image. Apply does not claim the new image is running:
it reports that the new configuration is active and the stopped runtime will be recreated
on Start. If image retrieval or container creation then fails, the new revision stays
active and the existing Start retry/reconciliation path applies.

Retirement is required for every revision change, including task-only edits: the retained
runtime ownership and Docker labels include revision identity, so merely changing Web or
Agent revision pointers would make the old runtime conflict with the new one. Retiring the
container leaves the worktree bind mount source, commits, dirty files, and Agent-owned
harness-state directory intact. No supported named volumes or services are currently
emitted by runtime plan v1; unsupported options continue to fail compilation before
adoption. The current runtime does not export or preserve arbitrary changes in the
container writable layer (for example, files written under a home directory outside the
mounted harness home). Those bytes are not part of the documented workspace persistence
contract, and the current executable plan cannot declare named volumes. If “persistent
state” in the acceptance means those arbitrary container-local writes must also survive an
image change, this retirement path is blocked: preserving/merging that layer onto a new
image needs a separate data migration/volume design. PR1 must not claim that broader
preservation guarantee. The narrow alpha contract is `/workspace` including Git, plus
Agent-owned persistent harness state.

## Failure and recovery

- Before the first externally visible side effect (removing a preview route, releasing a
  lease, retiring a runtime resource, or changing Agent ownership), a known rejection may
  terminalize Apply and leave the draft retryable. After
  that boundary, only confirmed completion or idempotent retry may terminalize it; an
  uncertain result must stay resumable. A narrow Agent recovery-required exception tells
  the executor to retain the journal entry as `running`. The executor treats calls resumed
  from a `running` journal entry as recovery attempts, so later preflight or I/O uncertainty
  cannot terminalize a partially applied adoption. A recovery attempt may continue from a
  lost runtime observation only after exact ownership records are rechecked; a running or
  transitioning runtime remains blocked. The signal is used for uncertain route teardown,
  container/network removal, or owner-record write; replay re-inspects exact IDs/labels and
  continues in order. Before the boundary, restart replay is ordinary
  accepted-operation replay. After it, the same operation ID and request fingerprint are
  mandatory and old runtime records remain until exact absence is confirmed.
- Validation, registry, policy, stale-revision, active-session, running/transitioning
  runtime, or candidate registration failures happen before retirement. The active and
  workspace revisions stay old; the draft remains inert and retryable.
- A preview-route removal failure prevents container retirement and activation. If
  absence cannot be established, leave Apply pending and mutations fenced until retry
  confirms cleanup; do not terminally fail after a partial route teardown.
- Once route cleanup or resource retirement starts, an uncertain Docker/filesystem failure must keep the
  Agent operation `running`, not terminally fail it. The existing Agent journal replays
  it after restart. Retain the old runtime records until its exact container and network
  are absent; ordered/idempotent cleanup lets a retry determine what remains. Add only a
  narrow recovery-required signal to the existing executor, not a general migration
  journal. If the workspace ownership write completed before interruption, replay sees
  the candidate owner and completes idempotently.
- If Agent adoption succeeds but Web activation has not committed, the durable Web Apply
  operation stays pending and fences new runtime/session/preview mutations. A retry or
  status read consults the Agent operation journal and exact workspace inspection, then
  repeats the Web CAS. SQLite activates the revision, pin, and preview rows in one
  transaction. A stale CAS before Agent mutation is a conflict; an unexpected CAS failure
  after Agent adoption remains locked for explicit recovery and is never reported as
  applied or rolled back optimistically. This requires a narrow configuration-Apply
  reconciliation path; generic Web-operation replay does not currently exist.
- Agent restart recovery replays the same operation ID and request fingerprint. The
  adoption operation re-inspects retained runtime records and exact preview identities,
  then continues idempotently. Web retry accepts only the same expected and candidate
  revisions, reconciles Agent ownership, and completes the same SQLite activation.
- Once SQLite activation commits, the same immediate transaction terminalizes the Web Apply
  operation and records its audit event. If the response is lost, retry/status reads see a
  succeeded operation and do not repeat adoption. The Agent journal retains its succeeded
  observation.
- A delivery timeout is treated as unknown, not failure: Web resubmits the same operation
  ID/request or reconciles its snapshot. Agent request fingerprints prevent changing the
  intent under that ID.

Preview teardown precedes runtime retirement. New preview IDs/rows are materialized for
the candidate revision only at activation; old rows remain historical but are excluded
from active preview lists. On the next Start, existing preview lease reservation and
route reconciliation use the new port, hostname, and revision.

## Tests and acceptance

Focused tests cover draft canonicalization/validation, expected-revision conflicts,
single-Apply locking, active/pending session and operation rejection, exact stopped-state
checks, revision-scoped registration IDs, revision activation, Agent/Web ownership agreement, preview IDs and
route failures, every retirement interruption point, Agent restart/retry, and Start using
the candidate image/port. A preservation case records Git HEAD, dirty status, worktree
file bytes, and Agent-owned harness-state identity/content before Apply and after Start
and requires them to match. Document explicitly that disposable runtime writable-layer
changes are not preserved by this supported path; do not describe them as persistent
workspace data.

Disposable real-rootless-Docker acceptance creates an existing project, dirties a tracked
file and leaves an uncommitted change, stops its runtime, applies a changed image and
preview port, verifies runtime absent plus new revision ownership, starts it, verifies
the actual container image and preview binding/route, and compares Git/worktree and
harness-persistence state. No live DevSpace service or code-server state is used.

## Session and status semantics

Sessions that fence Apply are sessions whose process/exec is accepted, starting, running,
resuming, or still owns a live Agent execution or private-home lease; nonterminal task and
terminal processes also fence Apply. Stopped sessions and `lost` sessions with no live exec
and no retained dirty-slot lease are historical, even when their native conversation is
resumable. Those records and resume capability remain intact across adoption; Resume is
available after Apply completes and runs under the newly active configuration/image. A
lost session whose Agent ownership cannot prove its exec and lease quiescent blocks Apply.

Workbench/runtime status reads the pending Apply and workspace/revision rows through a
recovery-safe query that does not call `getRuntimeContext()`. It continues to report this
state even while Web and Agent revision ownership temporarily differs. During a Web/Agent revision
mismatch it reports `applying` with expected and candidate revision identities and disables
runtime actions until reconciliation establishes consistent active ownership. Mutating
endpoints reserve through the same SQLite immediate-transaction fence: a mutation racing
with Apply either reserves first and makes Apply preflight reject, or loses to Apply and is
rejected.

## Scope estimate and infrastructure

Expected scope: one contract operation, a narrow Agent retirement/recovery path, Web draft
and activation transactions plus mutation fencing and Apply reconciliation, revision-scoped
preview materialization, and focused Agent/Web/rootless integration tests (roughly 8–12
production files). No new SQLite table is expected; existing immutable revisions,
operations, audit events, Agent operation journal, and runtime ownership records suffice.
The Docker adapter currently has no network-removal operation, so a narrow exact-owned
network removal call is required.

The unavoidable infrastructure is a single revision-adoption operation and its
recoverable teardown behavior across Agent and Web stores. If exact resource removal or
route absence cannot be proven, Apply stays blocked; this design does not authorize a
broader cleanup or a best-effort activation. Preserving arbitrary container writable-layer
state is a separate, substantial dependency and must be split out if that state is within
the product's required persistence guarantee.
