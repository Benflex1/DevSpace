# DevSpace Private GitHub Access — CP3A connection lifecycle

**Date:** 2026-09-06
**Status:** accepted for implementation on `feat/private-github-access-cp3a-lifecycle`
**Scope:** connection lifecycle, authority generations, disconnect cleanup, reconnect and authority-loss reporting

## Goal

Give every retained GitHub App connection a durable admission fence. A connection keeps its
stable DevSpace `connectionId` and its project source identity remains
`connectionId + repositoryId`, while each authority re-establishment receives a strictly
monotonic lifecycle generation. A disconnected or unresolved generation cannot authorize a new
private operation, even if a Web request, callback, refresh result, queued request, or Agent
process was created under an older generation.

CP3A keeps the owner-only beta boundaries already accepted in CP2. The Web application remains
the SQLite writer and policy owner. The Agent remains the only component that reads GitHub App
private state, calls GitHub, mints and revokes installation tokens, and launches authenticated
Git. A connection-wide lifecycle transition is represented by its own database state and Agent
state; it is not fabricated as a project operation.

## Durable Web model

`github_connections` gains these fields:

- `lifecycle_generation`, an integer starting at `1` for migrated CP2 rows and increasing on
  every disconnect or reconnect preparation;
- `lifecycle_state`, with `enabled`, `disconnect-pending`, `disconnected`,
  `reconnect-pending`, `installation-removed`, `installation-suspended`,
  `permission-required`, `repository-access-unavailable`, and `transient-error`;
- `cleanup_state`, with `settled`, `pending`, or `degraded`;
- bounded safe `last_authority_failure_code` and `last_authority_checked_at` metadata.

The existing original `github_connection_attempts` row remains the actor-owned ownership anchor
for a logical connection. CP3A adds a separate reauthorization-attempt table tied to the retained
connection. It records a state hash, target generation, actor, claimed installation, expiry, and
row version. This means a pending reinstall attempt cannot hide a retained connection and a new
GitHub installation ID can replace the old one only through a generation compare-and-swap.

CP2 rows receive generation `1`, lifecycle state `enabled`, cleanup state `settled`, and null
failure metadata. No project source, project, workspace, managed repository, worktree, dirty
file, commit, container, or ownership row is deleted or rewritten by this migration.

The Web connection view returns the retained connection, its original attempt anchor, and an
optional pending reauthorization attempt separately. Selection prefers a retained actor-owned
connection over the newest unconnected setup attempt. This fixes the CP2 setup-selection debt
without introducing multiple identities or accounts.

## Admission and generation protocol

Private Agent request data carries an expected authority generation separately from the source
locator. The source locator continues to contain only the immutable pair
`connectionId + repositoryId`; the generation is authorization context and is never persisted as
repository identity.

The Web obtains the current generation and enabled state from the actor-owned database row before
calling the Agent. The Agent performs a short per-connection lifecycle check before live proof,
before token mint, and at the authenticated Git launch boundary. The check requires:

1. the connection lifecycle record to be enabled;
2. the expected generation to equal the durable generation;
3. the existing CP2 App identity, installation identity, account, permission, and exact
   repository proof to succeed.

The lifecycle check is never held across a GitHub network call or Git execution. A small
per-connection synchronization point serializes the final check with a disconnect fence: if the
fence wins before launch, the launch is refused; if launch wins, the already bounded Git action
may settle. Token revocation and lease settlement remain admissible after the fence.

Live proof commits its binding only with the generation it started with. A stale refresh or
callback can therefore return a safe stale-generation error, but cannot set the connection back to
enabled or overwrite a newer installation binding.

## Disconnect protocol

The browser sends only the retained `connectionId` in a CSRF-protected authenticated request after
an explicit confirmation. The Web transaction verifies actor ownership, increments the generation,
sets `disconnect-pending`, and records `cleanup_state=pending` before contacting the Agent. That
database fence immediately blocks new private Web operations and prevents a lost Agent response
from being presented as a successful disconnect.

The Agent then writes a durable disabled lifecycle record for the exact connection. It refuses new
minting and authenticated Git, while allowing an already-running bounded action and token cleanup
to finish. Once active token work is settled, it unlinks only the exact connection binding and
only after validating the configured root, canonical filename, file identity, embedded
`connectionId`, and no-follow private-file invariants. The token lease remains until revocation or
conservative expiry settlement. A nonsecret lifecycle tombstone remains for restart recovery.

Agent restart scans lifecycle records and token leases and idempotently resumes eligible exact
cleanup. It never recursively deletes the GitHub state root, the administrator App config, the
private key, or another connection's files. If Agent contact fails, the Web state remains fenced
and reports disconnect pending/degraded; it does not claim the Agent fence or cleanup completed.

Disconnect never deletes local project or workspace state and never changes a private source into
public or URL-authorized access. Local workspace/runtime functionality continues through its normal
boundaries; private list, resolve, inspect, clone, and fetch operations fail safely while the
connection is disabled.

## Reconnect and reinstall

The reconnect action creates a reauthorization attempt against the same `connectionId`, advances
the generation, and puts the Web and Agent into `reconnect-pending`. An existing installation is
re-proved with the App identity and configured account proof. A valid proof commits the new
generation as enabled without fetching, cloning, or mutating Git. If the installation is gone or
requires GitHub-side repair, the browser receives a safely derived GitHub App installation URL and
the callback is tied to the same connection and target generation.

The callback must prove App identity, numeric account ID/type, active installation identity, and
the target generation before the Web CAS updates the retained connection. Old callbacks cannot
reactivate an obsolete generation. A new GitHub installation ID may replace the retained one only
after all of those checks succeed. An unresolved token lease conservatively blocks reconnect until
revocation or expiry settlement is durable.

## Authority-loss classifications

The Agent separates authoritative evidence from transport uncertainty:

| Evidence | Safe classification | Effect |
| --- | --- | --- |
| installation endpoint returns authoritative missing-installation evidence | `installation-removed` | private authority fenced; reconnect/reinstall required |
| active installation reports suspension | `installation-suspended` | private authority fenced; GitHub guidance shown |
| required `contents:read` or metadata permission is absent | `permission-required` | private authority fenced; no token/Git launch |
| exact repository is absent from the installation selection/token response | `repository-access-unavailable` | that private source is refused by repository ID |
| malformed, mismatched, or wrong-account authority data | `invalid` | fail closed and retain local state |
| network, rate-limit, 5xx, timeout, or otherwise non-authoritative upstream failure | `transient-error` | retryable safe error; never treated as removal |

These classifications are represented by bounded Agent/Web error codes and lifecycle metadata.
Messages contain no token, private key, upstream response body, local path, or secret URL data.

## Agent-private state

The existing global `config.json` and `private-key.pem` remain administrator state. CP3A adds
`github-app/lifecycle/<connection-id>.json` with only the connection ID, generation, lifecycle
state, cleanup state, installation ID when safe, and timestamps. Existing bindings and token lease
files remain exact per-connection files. Exact unlink is performed only after the durable disabled
fence and safe lease settlement, with directory fsync through the existing private-state writer
conventions.

## HTTP and UI surface

The Agent receives dedicated connection lifecycle requests for disconnect and reconnect preparation
and keeps them outside the project operation journal. Existing GitHub list, resolve, inspect,
refresh, verify, and managed Git paths carry the generation context. No project ID is invented for
connection-wide transitions.

The Web adds minimal Disconnect and Reconnect/re-authorize actions with CSRF protection and a
confirmation dialog. The card preserves a retained connection while a setup attempt is pending and
shows connected, pending, disconnected, installation removed, suspended, repository access
unavailable, permission required, and transient GitHub problem states with safe guidance.

## Verification boundary

Focused tests cover migration defaults, monotonic CAS, ownership, CSRF, admission races, exact
cross-connection cleanup, restart recovery, unresolved lease blocking, stale refresh/callback
results, local-state retention, all authority-loss classifications, same-ID reconnect/reinstall,
and retained-connection selection. The repository gate and the pinned Semgrep CE check are run
before the branch is committed.

CP3B push remains deferred. This design does not add write-scoped tokens, push intents, effect
records, push confirmation, uncertain-effect states, force push, tags, branch management, or push
reconciliation.
