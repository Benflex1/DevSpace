# AI-session supervisor capability proof

## Result

**CONDITIONAL PASS.** On 2026-07-26 the proof completed every scenario A–M against the dedicated
DevSpace rootless Docker daemon. This is capability evidence only. No production AI-session
runtime, F11 handler, provider adapter, credential source, persistence, Web route, SQLite schema,
or UI is implemented.

The condition is enforceable image/profile preparation: every AI-capable workspace image must
contain the fixed reviewed supervisor and helper plus Node.js 24, Linux `/proc`, Unix-domain
sockets, and the demonstrated POSIX process-group/session behavior. Agent must reject a profile
before launch when any prerequisite probe fails.

## Tested environment

- repository: `/workspace/DevSpace`
- execution identity: UID/GID `1000:1000`
- Engine: Docker 29.6.2, API 1.55, rootless Linux amd64
- dedicated container socket: `/run/devspace-docker/docker.sock`
- corresponding deployment class: the dedicated rootless daemon; never `/var/run/docker.sock`
- disposable image: the already-local `node:24-bookworm`
- container policy: no network, no ports, no privilege, no added capabilities, no devices, no
  mounts, `no-new-privileges`, private IPC/cgroup namespace, bounded PIDs

The runner uploads the committed fixture archive through the Engine archive API before container
start. It does not pull an image or expose the repository as a container mount.

## Prototype architecture

```text
proof runner
  -> dedicated rootless Docker Unix socket
  -> exact disposable container ID
  -> exact non-TTY Docker exec ID
  -> fixed Node supervisor
  -> detached provider process group/session
  -> fixture provider
     -> child
        -> grandchild

new host process
  -> reload mode-0600 private record
  -> new fixed helper Docker exec
  -> authenticated private Unix socket
  -> existing supervisor
```

Container PID 1 is an unrelated sentinel outside the provider process group. Graceful and forced
Stop leave that sentinel and the container running.

## Bootstrap, authentication, and binding

The runner generates 32 random bytes per process generation and encodes them as 64 lowercase hex
characters. The credential and strict bootstrap document are written as one bounded line to the
exact supervisor exec stdin. Helper requests receive the credential the same way. The value never
appears in command arguments, environment values, Docker labels, or the control-socket pathname.

Every connection uses constant-time padded comparison and an exact strict binding containing:

- proof schema version;
- project, workspace, configuration revision, AI session, operation, and profile IDs;
- runtime-plan hash, runtime generation, profile revision, and process generation;
- exact container ID and exact Docker exec ID.

Unknown, missing, foreign, stale, and mutated fields are rejected. The Agent-private-style record
lives outside the repository in a mode-`0700` temporary directory and is mode `0600`. Recovery
strictly parses it before any Docker helper or signal path.

## Process and exec identity

The supervisor reads `/proc/<pid>/stat`, `/proc/<pid>/status`, and `/proc/<pid>/ns/pid`. Its stable
identity is:

```text
inner PID + PPID + PGID + SID + start-time ticks + PID namespace inode + NSpid sequence
```

The provider must be the direct child of that supervisor. It must be session and process-group
leader (`PID == PGID == SID`). At least one provider child and one grandchild must have the same
PGID, SID, and PID namespace. A complete `/proc` scan must also show that every member of the
target process group is the provider or one of those descendants; a foreign group member rejects
Stop.

The Engine reports an outer exec PID that code-server cannot read through host `/proc`. This
deployment's host `ps` also lacks Docker top's optional `NSPID` formatter. Cross-namespace numeric
PID equality is therefore not used as authority. Instead, the exact exec-to-supervisor link is:

1. reserve the full binding including exact container and exec IDs;
2. create the fixed supervisor exec with no TTY, arguments containing no secret, and empty exec
   environment overrides;
3. inspect that exact exec as running in the exact container and retain its outer PID;
4. deliver the one-generation credential and binding only through that exact exec stdin;
5. destroy the original attachment;
6. accept only an authenticated handshake reporting the stable inner supervisor identity;
7. on recovery, re-inspect the same exec ID/container ID/running state/outer PID and require the
   same authenticated binding and inner start identity.

PID reuse alone cannot satisfy this chain. A later process lacks the exact running exec record,
credential, generation binding, and original `/proc` start identity. Process names are never
consulted.

## Protocol and termination

Provider stdin/stdout/stderr are owned exclusively by the supervisor. Public fixture output is
single-line JSON. Provider stderr is consumed into private categorical diagnostics. Malformed
stdout becomes a protocol-error event and never silently enters the JSONL stream.

Interrupt is a JSONL provider command and leaves the provider alive. Stop first re-proves the
supervisor, provider, direct-child relationship, and complete descendant boundary. It sends
`SIGTERM` only to the negative proven PGID, waits 300 ms, re-proves identity if still live, and
then sends `SIGKILL` to that same PGID. It never signals one unproved PID and never kills the
container.

## Hands-on scenario matrix

| Scenario | Result | Sanitized evidence |
| --- | --- | --- |
| A Normal launch | PASS | Exact container/exec and authenticated bootstrap established; stable supervisor/provider identity, direct child, child/grandchild boundary, and JSONL round trip proved. |
| B Reconnect | PASS | Original attachment was destroyed; a separate host process loaded the record, created a new helper exec, re-proved identity, and continued JSONL. |
| C Wrong credential | PASS | Rejected before provider forwarding or signalling. |
| D Wrong session/generation | PASS | Both mutations rejected with no fallback. |
| E Mutated binding | PASS | Container, workspace, profile revision, runtime generation, and exec mutations independently rejected. |
| F Cooperative interrupt | PASS | Fixture acknowledged interrupt; provider stayed running and reconnectable. |
| G Graceful Stop | PASS | Proven provider group and descendants exited on SIGTERM; sentinel survived. |
| H Forced escalation | PASS | Ignore-TERM fixture exceeded grace bound, then the same proven group was killed; sentinel survived. |
| I Already exited | PASS | Stop returned without a signal; a mutated start-time claim was rejected. |
| J Replaced container | PASS | Retained A ID returned missing; distinct B was neither contacted for recovery nor signalled. |
| K Missing/corrupt record | PASS | Strict record load failed before any helper, PID search, or signal path. |
| L Leak inspection | PASS | Secret absent from host/container cmdline and environment, Docker configuration/labels/exec arguments, normal output, categorical diagnostics, and repository files. |
| M Cleanup | PASS | Dedicated-daemon label query returned no proof containers; temporary private root and records were absent. |

Unit tests are separate evidence. They cover strict bootstrap/control/record parsing, full binding
comparison, constant-time credential behavior, proc-stat parsing, start-identity comparison,
descendant topology, escalation decisions, redaction, and cleanup planning.

## Security analysis and limitations

- Socket mode `0600` and directory mode `0700` are defense in depth; authentication and complete
  generation binding remain mandatory.
- The proof assumes trusted owner-controlled code inside one workspace, consistent with the
  project threat model. Same-user hostile-process resistance is not claimed.
- The supervisor/helper are proof scripts uploaded at run time. Production must install pinned,
  reviewed artifacts in every enabled image and verify their byte/executable identity.
- Production must durably reserve and update ownership phases before Docker side effects, not use
  this temporary proof record implementation.
- Grace timings are deliberately short fixture bounds, not production policy.
- The proof does not implement real Codex authentication or test provider credential projection.
- Docker exec stdio is not reattached. Recovery works only through the authenticated helper path.

## Slice 1 prerequisites

Before production provider launch, Agent must enforce:

1. the exact dedicated rootless daemon and owned container identity;
2. installed, pinned supervisor/helper artifacts and Node.js 24;
3. readable Linux `/proc` with stat start time, status/NSpid, and PID namespace links;
4. Unix-domain socket creation and restrictive permissions;
5. detached process groups/sessions with negative-PGID signalling;
6. a durable phased private ownership record and cleanup/reconciliation policy;
7. fixed bootstrap/control schemas, credential generation, redaction, and bounded timeouts;
8. profile availability probes that fail closed when any prerequisite is absent.
