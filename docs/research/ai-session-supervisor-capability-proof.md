# AI-session supervisor capability proof

## Result

**BLOCKED — authenticated supervisor recovery is feasible, but production-safe descendant
termination remains unproven.**

The corrected proof ran on 2026-07-28 in `/workspace/DevSpace` as UID/GID `1000:1000`, using Docker
29.6.2/API 1.55 through only the dedicated rootless socket
`/run/devspace-docker/docker.sock`. It used the already-local `node:24-bookworm` image with no
network, mounts, privilege, added capabilities, image pull, real provider, credentials, SQLite, or
production resource.

This is proof tooling, not production AI-session runtime.

## Stronger-boundary investigation

Inside a standard disposable container the probe observed:

- cgroup v2 and a private cgroup namespace;
- current namespace path `0::/`;
- `cpu memory pids` controllers available, with no subtree controllers enabled;
- a read-only cgroup filesystem, so an unprivileged child cgroup could not be created;
- `cgroup.kill` present but not writable;
- Docker's narrow `writable-cgroups=true` option accepted at create time but rejected at start
  because writable cgroups conflict with user namespaces/rootless mode.

No privileged container, host cgroup mount, extra capability, rootful socket, or host configuration
change was attempted. The actual deployment class therefore supplies no delegated cgroup or
equivalent atomic descendant-tree boundary.

The executable harness derives its result from this evidence rather than attaching a static
verdict. The reviewed unsupported tuple produces `BLOCKED`. Any observed stronger capability
(including a writable delegated child, writable `cgroup.kill`, or successful rootless
writable-cgroup startup) produces `ENVIRONMENT_CHANGED_REVIEW_REQUIRED` and suppresses the static
scenario matrix pending a new proof and review. Malformed, incomplete, contradictory, or
unclassified probe evidence produces `PROBE_FAILED`.

Pidfds could strengthen a single-process identity, but cannot contain a dynamic descendant tree.
A POSIX process group worked for the cooperative fixture, but its numeric ID is reusable and
membership can escape or churn between `/proc` validation and `kill(-pgid, ...)`. `/proc` scans are
not atomic snapshots. The harness uses two bounded observations and rejects mutation, foreign group
members, descendants outside the group, and unstable topology; this detects fixture escape/churn,
but cannot make scan-to-signal atomic. PGID signaling remains a fixture experiment only.

## Architecture and identity

```text
host proof runner
  -> dedicated rootless Docker HTTP API
  -> exact disposable container ID
  -> exact non-TTY supervisor exec ID
  -> authenticated supervisor Unix socket
  -> fixture provider -> child -> grandchild

separate host process
  -> strict private ownership record
  -> exact container and supervisor-exec inspection
  -> new fixed helper exec
  -> existing authenticated supervisor
```

The original Docker attachment is destroyed after one exact
`{"type":"supervisor-ready"}` JSONL frame. Raw exec stdio is never reattached. Recovery verifies
the exact container before creating a helper, then verifies the exact running supervisor exec and
outer PID before socket access.

The binding includes schema version, realistic UUIDv7 project/workspace/configuration/session
identities, profile key/revision, runtime-plan hash/generation, process generation, operation ID,
64-hex container ID, and 64-hex exec ID. Stable inner identities bind PID, PPID, PGID, SID,
`/proc/<pid>/stat` start-time ticks, PID namespace inode, and the exact bounded `NSpid` array.
Transient process run/sleep state is observed but is not identity. The provider must be the direct
child of the authenticated supervisor.

Proof records have an exact v2 shape, reject unknown/missing/unsafe fields, and enforce
container/binding and exec/binding cross-field equality. The socket path is derived exactly from
the immutable AI-session ID and process generation. Parsing also requires the provider to be the
supervisor's direct child and process-group/session leader, validates every descendant parent,
namespace, PGID, SID, start identity, and `NSpid`, and requires exact group/tree membership closure
with no foreign, escaped, missing, or duplicate identity. The proof-local schema demonstrates
binding behavior; it is not production request authority.

## Authentication, protocol, and control

Each run creates 32 random bytes. The lowercase-hex credential reaches the supervisor and every
helper only through stdin, and comparisons are constant-time shaped. It is absent from args,
environment overrides, labels, socket names, and normal output.

The supervisor owns provider stdin/stdout/stderr. Provider JSONL is correlated by a unique request
ID and monotonic event sequence after a per-request baseline. State-changing operations are
serialized. Exact duplicates return one idempotent result; conflicting request-ID reuse is rejected.
Completed request IDs are never evicted. Once the bounded 256-entry ledger is full, new mutations
fail closed while exact duplicates still return the original result. Interrupt remains
protocol-level and distinct from `fixture-stop`.

Docker multiplex parsing is incremental and rejects unknown stream kinds, nonzero reserved bytes,
truncated headers/payloads, partial trailing bytes, and excessive frames/streams. Helper exec
lifetime, Docker response size, helper/control bytes, socket connect/idle time, response size, and
active clients are bounded. Readiness is accepted only as one exact stdout JSONL object at a
complete frame boundary; trailing partial or complete frames fail. Public errors are categorical
and do not copy request bodies, Docker bodies, credentials, or private diagnostics.

## Corrected executable scenario matrix

| Scenario | Result | Action and evidence | Limitation |
| --- | --- | --- | --- |
| A Normal launch | PASS | Exact container/exec, authenticated supervisor/provider identity, stable direct child/tree, and correlated JSONL round trip. | Bounded coherent `/proc` observations are not atomic. |
| B Reconnect | PASS | Launch attachment destroyed; separate host process loaded the record; exact container/exec re-inspected before a new helper; proof continued. | Uses proof-local record persistence. |
| C Wrong credential | PASS | Real helper connection rejected; event sequence unchanged. | — |
| D Wrong session/generation | PASS | Both real socket mutations rejected without fallback or provider effect. | — |
| E Mutated binding | PASS | Container, workspace, profile revision, runtime generation, and exec mutations rejected; event sequence unchanged. | — |
| F Cooperative interrupt | PASS | Post-baseline request ID matched; duplicate was idempotent immediately and after filling the 256-entry ledger; conflicting/new IDs failed without a second effect; provider remained live. | Fixture protocol only. |
| G Graceful Stop | PARTIAL | Cooperative fixture group received SIGTERM and exited while PID 1 sentinel/container survived. | Numeric PGID is not production authority. |
| H Forced escalation | BLOCKED | Ignore-TERM fixture demonstrated bounded PGID escalation; cgroup probe and setsid/double-fork/churn fixtures invalidated the proposed boundary. | No atomic descendant-tree primitive. |
| I Already exited | PASS | Exited provider caused no later signal; mutated start time rejected. | Deterministic PID reuse was not forced. |
| J Replaced container | PASS | A was removed, B reused A's name, real recovery and signal-capable entry used A's record, and rejected on exact A ID before helper creation; B's helper counter and sentinel were unchanged. | Instrumentation is proof-runner-local plus Docker state. |
| K Missing/corrupt record | PASS | Real recovery and signal-capable entries rejected 23 cases, including escaped/missing/foreign topology, crossed session/generation sockets, all container/exec cross-fields, and a genuinely separate session record, before helper creation; exact exec count was unchanged. | Production needs its own durable authenticated record schema. |
| L Leak inspection | PARTIAL | Live runner, separate reconnect host process, relevant in-container args/environments, Docker container/supervisor/helper configs, labels, outputs, bounded repository source roots, and 0700/0600 state permissions were checked. | Coverage remains the enumerated success and sanitized-error surfaces; no universal absence claim is made. |
| M Cleanup | PASS | An open/closing/closed coordinator registers immediately after create, absorbs late creation, and serializes idempotent cleanup. Actual-stage failure injection and SIGINT/SIGTERM child-runner tests covered create, upload, bootstrap, and reconnect; daemon label/name, process, socket, record, and `/tmp` audits were empty. | Exact run-owned resources only. |

Unit tests separately cover realistic strict identifiers, record cross-fields, exact `NSpid`,
proc-stat numeric rejection, escaped/foreign/churning topology, multiplex framing/readiness,
request tombstone/capacity behavior beyond the former eviction boundary, cgroup-result
classification, cleanup lifecycle races, spawn configuration secret checks, event-boundary helpers,
nested redaction, and cleanup planning.

## Security disposition and next prerequisite

Useful evidence remains: the supervisor survives attachment loss, authenticated reconnection works,
container/exec/process-start identity can be re-proven, negative-PGID signaling affects only the
cooperative fixture group, stale identities fail closed, and cleanup is reproducible.

Slice 1 provider launch remains blocked. The next production slice requires an enforceable
race-safe descendant boundary available without privilege or host mounts—such as a genuinely
delegated writable cgroup whose identity and membership are verified and whose forced termination
uses writable `cgroup.kill`—plus an image/runtime preflight that rejects launch when delegation,
placement, population events, and atomic kill are unavailable. It also still requires pinned
supervisor/helper artifacts, durable authenticated Agent-private ownership state, production
contract validators, and production timeout/reconciliation policy.
